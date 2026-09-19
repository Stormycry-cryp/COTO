import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentError,
  createAgent,
  MemorySessionStore,
  type AgentEvent,
  type InputRequest,
  type Tool,
} from '../src/index.js';
import { assistant, echoProvider, scriptedProvider } from '../src/testing/index.js';
import { deferred } from '../src/core/async.js';

test('withdrawing an input before application prevents its model request', async (t) => {
  const provider = echoProvider(0);
  const agent = createAgent({
    workspace: process.cwd(),
    provider,
    store: new MemorySessionStore(),
  });
  t.after(() => agent.close());
  const session = await agent.sessions.create();
  let inputId = '';
  let withdrawal: Promise<void> | undefined;
  session.subscribe((event) => {
    if (event.type === 'input.accepted') inputId = (event.data.request as InputRequest).inputId;
    if (event.type === 'turn.started') withdrawal = session.withdraw(inputId);
  });
  await assert.rejects(session.run('withdraw this input'), /cancelled/i);
  await withdrawal;
  await agent.close();
  assert.equal(provider.requests.length, 0);
  assert.equal(
    session.history().some((e) => e.type === 'input.applied'),
    false,
  );
});

test('steering accepted during successive context rebuilds reaches the next model request', async (t) => {
  const entered = [deferred<void>(), deferred<void>()];
  const gates = [deferred<void>(), deferred<void>()];
  let preparations = 0;
  const provider = scriptedProvider(async function* () {
    yield { type: 'done', stopReason: 'stop', message: assistant('done') };
  });
  const agent = createAgent({
    workspace: process.cwd(),
    provider,
    store: new MemorySessionStore(),
    context: {
      contributors: [
        async () => {
          const index = preparations++;
          if (index < gates.length) {
            entered[index].resolve();
            await gates[index].promise;
          }
          return '';
        },
      ],
    },
  });
  t.after(() => agent.close());
  const session = await agent.sessions.create();
  const running = session.run('initial');
  for (let i = 0; i < gates.length; i++) {
    await entered[i].promise;
    await session.submitInput({
      inputId: `steer-${i}`,
      mode: 'steer',
      expectedTurnId: session.snapshot().activeTurnId,
      content: [{ type: 'text', text: `constraint ${i}` }],
    });
    gates[i].resolve();
  }
  assert.equal((await running).status, 'completed');
  assert.equal(provider.requests.length, 1);
  assert(provider.requests[0].messages.some((m) => m.id === 'steer-0'));
  assert(provider.requests[0].messages.some((m) => m.id === 'steer-1'));
});

test('aborting a subscription while it is yielding closes without waiting for another event', async (t) => {
  const agent = createAgent({
    workspace: process.cwd(),
    provider: echoProvider(0),
    store: new MemorySessionStore(),
  });
  t.after(() => agent.close());
  const session = await agent.sessions.create();
  const abort = new AbortController();
  const stream = session.streamEvents(0, abort.signal);
  const first = stream.next();
  await session.seedFork([]);
  assert.equal((await first).value?.type, 'session.forked');
  abort.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const next = await Promise.race([
      stream.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Subscription remained open')), 1000);
      }),
    ]);
    assert.equal(next.done, true);
  } finally {
    clearTimeout(timer);
  }
});

test('input idempotency is independent of JSON object key order', async (t) => {
  const agent = createAgent({
    workspace: process.cwd(),
    provider: echoProvider(0),
    store: new MemorySessionStore(),
  });
  t.after(() => agent.close());
  const session = await agent.sessions.create();
  const receipt = await session.submitInput({
    inputId: 'ordered',
    mode: 'follow_up',
    content: [{ type: 'text', text: 'hello' }],
  });
  const replay = await session.submitInput({
    content: [{ text: 'hello', type: 'text' }],
    mode: 'follow_up',
    inputId: 'ordered',
  });
  assert.equal(replay.acceptedSeq, receipt.acceptedSeq);
  assert.equal(session.history().filter((e) => e.type === 'input.accepted').length, 1);
});

test('invalid custom policy decisions fail closed', async (t) => {
  let executed = false;
  const tool: Tool = {
    name: 'write',
    description: 'Write',
    effect: 'write',
    parameters: { type: 'object' },
    async execute() {
      executed = true;
      return { content: [{ type: 'text', text: 'written' }] };
    },
  };
  const provider = scriptedProvider(async function* (_request, index) {
    yield {
      type: 'done',
      stopReason: index === 0 ? 'tools' : 'stop',
      message:
        index === 0
          ? assistant('', [{ id: 'write1', name: 'write', arguments: {} }])
          : assistant('done'),
    };
  });
  const agent = createAgent({
    workspace: process.cwd(),
    provider,
    store: new MemorySessionStore(),
    tools: [tool],
    policy: (() => undefined) as never,
  });
  t.after(() => agent.close());
  const session = await agent.sessions.create();
  await session.run('write');
  assert.equal(executed, false);
  assert(session.history().some((e) => e.type === 'tool.failed'));
});

test('a storage failure ends a waiting subscription with an explicit error', async (t) => {
  class FailingStore extends MemorySessionStore {
    override async append(_id: string, _event: AgentEvent): Promise<void> {
      throw new Error('fixture disk failure');
    }
  }
  const agent = createAgent({
    workspace: process.cwd(),
    provider: echoProvider(0),
    store: new FailingStore(),
  });
  t.after(() => agent.close());
  const session = await agent.sessions.create();
  const stream = session.streamEvents();
  const failedStream = assert.rejects(
    stream.next(),
    (error: unknown) => error instanceof AgentError && error.code === 'storage_error',
  );
  await assert.rejects(session.run('cannot persist'), /fixture disk failure/);
  await failedStream;
  assert.equal(session.history().length, 0);
});

test('retry discards partial output and reuses a completed tool result without reexecution', async (t) => {
  let executed = 0;
  const tool: Tool = {
    name: 'lookup',
    description: 'Lookup',
    effect: 'read',
    parameters: { type: 'object' },
    async execute() {
      executed++;
      return { content: [{ type: 'text', text: 'verified fact' }] };
    },
  };
  const provider = scriptedProvider(async function* (request, index) {
    if (index === 0) {
      yield {
        type: 'done',
        stopReason: 'tools',
        message: assistant('', [{ id: 'lookup1', name: 'lookup', arguments: {} }]),
      };
      return;
    }
    assert(request.messages.some((m) => m.toolCallId === 'lookup1'));
    if (index === 1) {
      yield { type: 'text_delta', text: 'discard this partial answer' };
      throw new AgentError('provider_error', 'temporary fixture error', 503, true);
    }
    yield { type: 'text_delta', text: 'final answer' };
    yield { type: 'done', stopReason: 'stop', message: assistant('final answer') };
  });
  const agent = createAgent({
    workspace: process.cwd(),
    provider,
    store: new MemorySessionStore(),
    tools: [tool],
    maxRetries: 1,
  });
  t.after(() => agent.close());
  const session = await agent.sessions.create();
  assert.equal((await session.run('lookup')).text, 'final answer');
  assert.equal(executed, 1);
  const discarded = session.history().find((e) => e.type === 'model.attempt_discarded');
  const firstDelta = session.history().find((e) => e.type === 'text.delta');
  assert.equal(discarded?.attemptId, firstDelta?.attemptId);
  assert.equal(
    session
      .snapshot()
      .messages.some((m) =>
        m.content.some((p) => p.type === 'text' && p.text.includes('discard this')),
      ),
    false,
  );
});
