import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgent,
  MemorySessionStore,
  FileSessionStore,
  type AgentEvent,
  type Session,
  type Tool,
} from '../src/index.js';
import { scriptedProvider, assistant, echoProvider } from '../src/testing/index.js';
import { deferred, delay } from '../src/core/async.js';

async function event(
  session: Session,
  type: string,
  predicate: (event: AgentEvent) => boolean = () => true,
) {
  const existing = session.history().find((e) => e.type === type && predicate(e));
  if (existing) return existing;
  return new Promise<AgentEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Missing ${type}`));
    }, 4000);
    const off = session.subscribe((e) => {
      if (e.type === type && predicate(e)) {
        clearTimeout(timer);
        off();
        resolve(e);
      }
    });
  });
}
const tool: Tool = {
  name: 'double',
  description: 'Double an integer',
  effect: 'read',
  parameters: {
    type: 'object',
    properties: { n: { type: 'integer' } },
    required: ['n'],
    additionalProperties: false,
  },
  async execute(args) {
    return { content: [{ type: 'text', text: String(Number(args.n) * 2) }] };
  },
};

test('model -> validated tool -> result -> model; session can continue', async () => {
  const provider = scriptedProvider(async function* (request, index) {
    if (index === 0)
      yield {
        type: 'done',
        stopReason: 'tools',
        message: assistant('', [{ id: 'call-1', name: 'double', arguments: { n: 3 } }]),
      };
    else {
      assert.equal(
        request.messages.find((m) => m.toolCallId === 'call-1')?.content[0]?.type,
        'text',
      );
      yield { type: 'done', stopReason: 'stop', message: assistant('6') };
    }
  });
  const agent = createAgent({
    workspace: process.cwd(),
    provider,
    store: new MemorySessionStore(),
    tools: [tool],
  });
  const session = await agent.sessions.create();
  assert.equal((await session.run('double 3')).text, '6');
  assert.equal((await session.run('continue')).status, 'completed');
  assert.equal(session.history().filter((e) => e.type === 'tool.completed').length, 1);
  await agent.close();
});

test('steer at response boundary is applied before completion; follow_up stays ordered', async () => {
  const gate = deferred<void>();
  const entered = deferred<void>();
  const provider = scriptedProvider(async function* (_request, index) {
    if (index === 0) {
      entered.resolve();
      await gate.promise;
    }
    yield { type: 'done', stopReason: 'stop', message: assistant(`response ${index}`) };
  });
  const agent = createAgent({
    workspace: process.cwd(),
    provider,
    store: new MemorySessionStore(),
  });
  const session = await agent.sessions.create();
  const first = session.run('first');
  const started = await event(session, 'turn.started');
  await entered.promise;
  await session.submitInput({
    inputId: 'steer1',
    mode: 'steer',
    expectedTurnId: started.turnId,
    content: [{ type: 'text', text: 'use Chinese' }],
  });
  const second = session.run('second');
  gate.resolve();
  assert.equal((await first).text, 'response 1');
  assert.equal((await second).text, 'response 2');
  assert(provider.requests[1].messages.some((m) => m.id === 'steer1'));
  assert(
    !provider.requests[1].messages.some((m) =>
      m.content.some((p) => p.type === 'text' && p.text === 'second'),
    ),
  );
  await agent.close();
});

test('interrupt aborts model and starts new turn; duplicate input is durable', async () => {
  const entered = deferred<void>();
  const provider = scriptedProvider(async function* (_request, index, signal) {
    if (index === 0) {
      entered.resolve();
      await delay(60_000, signal);
    }
    yield { type: 'done', stopReason: 'stop', message: assistant('new task') };
  });
  const agent = createAgent({
    workspace: process.cwd(),
    provider,
    store: new MemorySessionStore(),
  });
  const session = await agent.sessions.create();
  const first = session.run('old');
  const started = await event(session, 'turn.started');
  await entered.promise;
  const request = {
    inputId: 'new',
    mode: 'interrupt' as const,
    expectedTurnId: started.turnId,
    content: [{ type: 'text' as const, text: 'new' }],
  };
  await session.submitInput(request);
  await session.submitInput(request);
  assert.equal((await first).status, 'interrupted');
  await event(session, 'turn.completed');
  assert.equal(
    session
      .history()
      .filter((e) => e.type === 'input.accepted' && (e.data.request as any).inputId === 'new')
      .length,
    1,
  );
  await assert.rejects(
    session.submitInput({ ...request, content: [{ type: 'text', text: 'different' }] }),
    /different content/,
  );
  await agent.close();
});

test('approval denial never executes a write, approval cannot outlive cancelled turn', async () => {
  let executed = 0;
  const write = {
    ...tool,
    effect: 'write' as const,
    async execute() {
      executed++;
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    },
  };
  const provider = scriptedProvider(async function* (_request, index) {
    yield {
      type: 'done',
      stopReason: index === 0 ? 'tools' : 'stop',
      message:
        index === 0
          ? assistant('', [{ id: 'write1', name: 'double', arguments: { n: 1 } }])
          : assistant('denied'),
    };
  });
  const agent = createAgent({
    workspace: process.cwd(),
    provider,
    store: new MemorySessionStore(),
    tools: [write],
    policy: 'ask',
  });
  const session = await agent.sessions.create();
  const running = session.run('write');
  const approval = await event(session, 'approval.required');
  await session.approve(String(approval.data.approvalId), false);
  assert.equal((await running).status, 'completed');
  assert.equal(executed, 0);
  await assert.rejects(
    session.approve(String(approval.data.approvalId), true),
    /no longer applies/,
  );
  await agent.close();
});

test('filesystem persistence, incomplete tail repair and input deduplication across reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coto-store-'));
  const directory = join(root, 'sessions');
  const provider = echoProvider(0);
  const agent = createAgent({ workspace: root, provider, store: new FileSessionStore(directory) });
  const session = await agent.sessions.create();
  const request = {
    inputId: 'persisted',
    mode: 'follow_up' as const,
    content: [{ type: 'text' as const, text: 'hello' }],
  };
  await session.submitInput(request);
  await event(session, 'turn.completed');
  const count = session.history().length;
  await agent.close();
  await appendFile(join(directory, session.id, 'events.jsonl'), '{"incomplete":');
  const second = createAgent({ workspace: root, provider, store: new FileSessionStore(directory) });
  const restored = await second.sessions.resume(session.id);
  assert.equal((await restored.submitInput(request)).status, 'applied');
  assert.equal(restored.history().length, count);
  assert((await readFile(join(directory, session.id, 'events.jsonl'), 'utf8')).endsWith('\n'));
  assert.equal((await restored.run('next')).status, 'completed');
  await second.close();
  await rm(root, { recursive: true });
});

test('a second writer is rejected; fork is independent', async () => {
  const store = new MemorySessionStore();
  const agent = createAgent({ workspace: process.cwd(), provider: echoProvider(0), store });
  const session = await agent.sessions.create();
  await session.run('parent');
  const other = createAgent({ workspace: process.cwd(), provider: echoProvider(0), store });
  await assert.rejects(other.sessions.get(session.id), /active writer/);
  const fork = await agent.sessions.fork(session.id);
  await fork.run('child');
  assert(
    !session
      .snapshot()
      .messages.some((m) => m.content.some((p) => p.type === 'text' && p.text === 'child')),
  );
  await other.close();
  await agent.close();
});

test('invalid tool arguments become error results without executing', async () => {
  const provider = scriptedProvider(async function* (request, index) {
    if (!index)
      yield {
        type: 'done',
        stopReason: 'tools',
        message: assistant('', [{ id: 'invalid', name: 'double', arguments: { n: 'wrong' } }]),
      };
    else {
      assert.equal(request.messages.at(-1)?.isError, true);
      yield { type: 'done', stopReason: 'stop', message: assistant('fixed') };
    }
  });
  const agent = createAgent({
    workspace: process.cwd(),
    provider,
    store: new MemorySessionStore(),
    tools: [tool],
  });
  assert.equal((await (await agent.sessions.create()).run('try')).status, 'completed');
  await agent.close();
});
