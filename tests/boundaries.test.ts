import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgent,
  ContextManager,
  MemorySessionStore,
  type AgentEvent,
  type ModelProvider,
  type Tool,
} from '../src/index.js';
import { assistant, scriptedProvider } from '../src/testing/index.js';
import { deferred } from '../src/core/async.js';

async function waitFor(
  session: {
    history(): AgentEvent[];
    subscribe(listener: (event: AgentEvent) => void): () => void;
  },
  type: string,
) {
  const existing = session.history().find((event) => event.type === type);
  if (existing) return existing;
  return new Promise<AgentEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Missing ${type}`));
    }, 5000);
    const off = session.subscribe((event) => {
      if (event.type === type) {
        clearTimeout(timer);
        off();
        resolve(event);
      }
    });
  });
}

test('context compaction preserves assistant tool groups and recent messages', async () => {
  let summaryCalls = 0;
  const provider: ModelProvider = scriptedProvider(
    async function* (request) {
      if (request.system.startsWith('Summarize')) {
        summaryCalls++;
        yield { type: 'done', stopReason: 'stop', message: assistant('verified summary') };
        return;
      }
      yield { type: 'done', stopReason: 'stop', message: assistant('answer') };
    },
    { contextWindow: 2500, maxOutputTokens: 100 },
  );
  const manager = new ContextManager({ safetyTokens: 50, keepRecentMessages: 2 });
  const long = 'x'.repeat(350);
  const messages = [
    { id: 'u1', role: 'user' as const, content: [{ type: 'text' as const, text: long }] },
    {
      id: 'a1',
      role: 'assistant' as const,
      content: [],
      toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { query: long } }],
    },
    {
      id: 't1',
      role: 'tool' as const,
      toolCallId: 'call-1',
      toolName: 'lookup',
      content: [{ type: 'text' as const, text: long }],
    },
    { id: 'u2', role: 'user' as const, content: [{ type: 'text' as const, text: long }] },
    { id: 'a2', role: 'assistant' as const, content: [{ type: 'text' as const, text: long }] },
    { id: 'u3', role: 'user' as const, content: [{ type: 'text' as const, text: long }] },
  ];
  const prepared = await manager.prepare(
    provider,
    messages,
    [{ name: 'lookup', description: 'lookup', parameters: { type: 'object' } }],
    process.cwd(),
    new AbortController().signal,
  );
  assert(summaryCalls >= 1);
  assert(prepared.compacted);
  assert.equal(prepared.compacted[0].content[0].type, 'text');
  assert.match(
    (prepared.compacted[0].content[0] as { type: 'text'; text: string }).text,
    /verified summary/,
  );
  assert.equal(prepared.compacted.at(-1)?.id, 'u3');
  assert.equal(
    prepared.compacted.some((message) => message.id === 'a1'),
    false,
  );
});

test('unknown write outcome pauses the session until reconciliation', async () => {
  const pending = deferred<{ content: [{ type: 'text'; text: string }] }>();
  const write: Tool = {
    name: 'external_write',
    description: 'A write whose remote outcome cannot be cancelled',
    effect: 'write',
    parameters: { type: 'object', additionalProperties: false },
    async execute() {
      return pending.promise;
    },
  };
  const provider = scriptedProvider(async function* (_request, index) {
    if (index === 0)
      yield {
        type: 'done',
        stopReason: 'tools',
        message: assistant('', [{ id: 'call-write', name: 'external_write', arguments: {} }]),
      };
    else yield { type: 'done', stopReason: 'stop', message: assistant('resumed') };
  });
  const agent = createAgent({
    workspace: process.cwd(),
    provider,
    store: new MemorySessionStore(),
    tools: [write],
    policy: 'allow-all',
    toolTimeoutMs: 10,
  });
  const session = await agent.sessions.create();
  const running = session.run('perform write');
  const started = await waitFor(session, 'tool.started');
  const turnId = started.turnId!;
  await session.cancel(turnId);
  const interrupted = await running;
  assert.equal(interrupted.status, 'interrupted');
  const unknown = await waitFor(session, 'tool.outcome_unknown');
  const invocationId = String(unknown.data.invocationId);
  assert.equal(session.snapshot().unresolved.length, 1);
  await assert.rejects(session.resume(), /unreconciled/);
  await assert.rejects(session.reconcile(invocationId, 'too early'), /still running/);
  pending.resolve({ content: [{ type: 'text', text: 'remote write confirmed' }] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await session.reconcile(invocationId, 'remote write confirmed');
  await session.resume();
  const completed = await waitFor(session, 'turn.completed');
  assert.equal((completed.data.result as { text: string }).text, 'resumed');
  await agent.close();
});
