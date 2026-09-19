import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentError,
  createAgent,
  MemorySessionStore,
  type AgentEvent,
  type InputRequest,
  type Tool,
} from '../src/index.js';
import { assistant, echoProvider, scriptedProvider } from '../src/testing/index.js';
import { abortable, deferred } from '../src/core/async.js';

function nextTick() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

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

test('concurrent session close calls share and await the same completion', async () => {
  const releasing = deferred<void>();
  const releaseGate = deferred<void>();
  class SlowReleaseStore extends MemorySessionStore {
    override async acquire(id: string) {
      const release = await super.acquire(id);
      return async () => {
        releasing.resolve();
        await releaseGate.promise;
        await release();
      };
    }
  }
  const agent = createAgent({
    workspace: process.cwd(),
    provider: echoProvider(0),
    store: new SlowReleaseStore(),
  });
  const session = await agent.sessions.create();
  const first = session.close();
  await releasing.promise;
  const second = session.close();
  assert.equal(second, first);
  let settled = false;
  void second.then(() => {
    settled = true;
  });
  await nextTick();
  assert.equal(settled, false);
  releaseGate.resolve();
  await first;
  assert.equal(settled, true);
  await agent.close();
});

test('session mutators reject after close', async () => {
  const provider = echoProvider(0);
  const agent = createAgent({
    workspace: process.cwd(),
    provider,
    store: new MemorySessionStore(),
  });
  const session = await agent.sessions.create();
  await session.close();
  const unavailable = (error: unknown) =>
    error instanceof AgentError && error.code === 'session_unavailable';
  for (const operation of [
    () => session.run('late input'),
    () => session.approve('missing', true),
    () => session.cancel('missing'),
    () => session.withdraw('missing'),
    () => session.reconcile('missing', 'outcome'),
    () => session.resume(),
    () => session.switchProvider(provider),
    () => session.archive(),
    () => session.seedFork([]),
  ]) {
    await assert.rejects(operation(), unavailable);
  }
  await agent.close();
});

test('runStream ends when its queued input is withdrawn', async (t) => {
  const entered = deferred<void>();
  const gate = deferred<void>();
  const provider = scriptedProvider(async function* (_request, index, signal) {
    if (index === 0) {
      entered.resolve();
      await abortable(gate.promise, signal);
    }
    yield { type: 'done', stopReason: 'stop', message: assistant(`response ${index}`) };
  });
  const agent = createAgent({
    workspace: process.cwd(),
    provider,
    store: new MemorySessionStore(),
  });
  t.after(async () => {
    gate.resolve();
    await agent.close();
  });
  const session = await agent.sessions.create();
  const first = session.run('active');
  await entered.promise;
  const queued = deferred<string>();
  session.subscribe((event) => {
    if (
      event.type === 'input.accepted' &&
      (event.data.request as InputRequest).content.some(
        (part) => part.type === 'text' && part.text === 'queued',
      )
    )
      queued.resolve((event.data.request as InputRequest).inputId);
  });
  const seen: string[] = [];
  const streaming = (async () => {
    for await (const event of session.runStream('queued')) seen.push(event.type);
  })();
  await session.withdraw(await queued.promise);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      streaming,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('runStream remained open')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  assert(seen.includes('input.withdrawn'));
  assert.equal(provider.requests.length, 1);
  gate.resolve();
  await first;
});

test('getting a manually closed cached session reopens it', async (t) => {
  const agent = createAgent({
    workspace: process.cwd(),
    provider: echoProvider(0),
    store: new MemorySessionStore(),
  });
  t.after(() => agent.close());
  const original = await agent.sessions.create();
  await original.close();
  const reopened = await agent.sessions.get(original.id);
  assert.notEqual(reopened, original);
  assert.equal(reopened.isClosed, false);
  assert.equal((await reopened.run('reopened')).status, 'completed');
});

test('agent close waits for an admitted session create and closes its result', async () => {
  const entered = deferred<void>();
  const gate = deferred<void>();
  class SlowCreateStore extends MemorySessionStore {
    override async create(meta: Parameters<MemorySessionStore['create']>[0]) {
      entered.resolve();
      await gate.promise;
      await super.create(meta);
    }
  }
  const agent = createAgent({
    workspace: process.cwd(),
    provider: echoProvider(0),
    store: new SlowCreateStore(),
  });
  const creating = agent.sessions.create({}, 'racing-create');
  await entered.promise;
  const closing = agent.close();
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  await nextTick();
  assert.equal(settled, false);
  gate.resolve();
  const session = await creating;
  await closing;
  assert.equal(session.isClosed, true);
  await assert.rejects(agent.sessions.get(session.id), /Agent is closed/);
});

test('agent close waits for an admitted session open and closes its result', async () => {
  const entered = deferred<void>();
  const gate = deferred<void>();
  class SlowReadStore extends MemorySessionStore {
    pause = false;
    override async read(id: string) {
      if (this.pause) {
        entered.resolve();
        await gate.promise;
      }
      return super.read(id);
    }
  }
  const store = new SlowReadStore();
  const first = createAgent({ workspace: process.cwd(), provider: echoProvider(0), store });
  const id = (await first.sessions.create()).id;
  await first.close();
  store.pause = true;
  const second = createAgent({ workspace: process.cwd(), provider: echoProvider(0), store });
  const opening = second.sessions.get(id);
  await entered.promise;
  const closing = second.close();
  gate.resolve();
  const session = await opening;
  await closing;
  assert.equal(session.isClosed, true);
});

test('workspace identity uses real paths across symlink aliases', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'coto-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const alias = join(root, 'workspace-alias');
  await mkdir(workspace);
  await symlink(workspace, alias);
  const store = new MemorySessionStore();
  const first = createAgent({ workspace: alias, provider: echoProvider(0), store });
  const created = await first.sessions.create();
  assert.equal(created.meta.workspace, await realpath(workspace));
  await first.close();
  const second = createAgent({ workspace, provider: echoProvider(0), store });
  t.after(() => second.close());
  const reopened = await second.sessions.get(created.id);
  assert.equal(reopened.id, created.id);
});

test('an unused agent does not start readiness for an invalid workspace', async () => {
  const missing = join(tmpdir(), `coto-missing-${crypto.randomUUID()}`);
  const agent = createAgent({
    workspace: missing,
    provider: echoProvider(0),
    store: new MemorySessionStore(),
  });
  await nextTick();
  await agent.close();
});

test('public session access cannot bypass a closed agent with extra arguments', async () => {
  const agent = createAgent({
    workspace: process.cwd(),
    provider: echoProvider(0),
    store: new MemorySessionStore(),
  });
  await agent.close();
  const get = agent.sessions.get as unknown as (id: string, admitted: boolean) => Promise<unknown>;
  const resume = agent.sessions.resume as unknown as (
    id: string,
    admitted: boolean,
  ) => Promise<unknown>;
  const closed = (error: unknown) => error instanceof AgentError && error.code === 'agent_closed';
  await assert.rejects(get('missing', true), closed);
  await assert.rejects(resume('missing', true), closed);
});

test('session close drains admitted control work before releasing its writer', async () => {
  const entered = deferred<void>();
  const gate = deferred<void>();
  let controlComplete = false;
  let completeWhenReleased = false;
  class OrderedReleaseStore extends MemorySessionStore {
    override async acquire(id: string) {
      const release = await super.acquire(id);
      return async () => {
        completeWhenReleased = controlComplete;
        await release();
      };
    }
  }
  const agent = createAgent({
    workspace: process.cwd(),
    provider: echoProvider(0),
    store: new OrderedReleaseStore(),
  });
  const session = await agent.sessions.create();
  const control = (
    session as unknown as {
      control: { run<T>(fn: () => Promise<T>): Promise<T> };
    }
  ).control;
  const admitted = control.run(async () => {
    entered.resolve();
    await gate.promise;
    controlComplete = true;
  });
  await entered.promise;
  const closing = session.close();
  await nextTick();
  assert.equal(completeWhenReleased, false);
  gate.resolve();
  await admitted;
  await closing;
  assert.equal(completeWhenReleased, true);
  await agent.close();
});
