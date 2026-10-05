import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { McpClient, mcpToolResult, stdioMcpTransport, type McpMessage } from '../src/mcp/index.js';
import { AgentError } from '../src/core/errors.js';
import { ContextManager, estimateTokens } from '../src/core/context.js';
import type { Message, Tool, ToolContext } from '../src/core/types.js';
import { createAgent, MemorySessionStore } from '../src/index.js';
import { scriptedProvider, assistant } from '../src/testing/index.js';

const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
const ctx = (signal = new AbortController().signal): ToolContext => ({
  workspace: process.cwd(), sessionId: 's', turnId: 't', invocationId: 'inv-1', signal, progress: async () => {},
});
const code = (expected: string) => (error: unknown) => error instanceof AgentError && error.code === expected;
const named = (tools: Tool[], name: string) => { const tool = tools.find((tool) => tool.name === name); assert(tool); return tool; };
const policies = {
  probe: { effect: 'read' as const, parallel: true }, image: { effect: 'read' as const },
  slow_read: { effect: 'read' as const }, slow_write: { effect: 'write' as const },
  disconnect_write: { effect: 'write' as const }, protocol_error: { effect: 'read' as const },
  change_tools: { effect: 'read' as const }, removed: { effect: 'read' as const },
  strict_schema: { effect: 'read' as const }, invalid_output: { effect: 'read' as const },
  known_error: { effect: 'write' as const },
};
function client(extra: Partial<ConstructorParameters<typeof McpClient>[0]> = {}, mode?: string) {
  const transport = stdioMcpTransport({ command: process.execPath, args: [fixture, ...(mode ? [mode] : [])] });
  return new McpClient({ transport, tools: policies, requestTimeoutMs: 3000, ...extra });
}

test('real stdio handshake, pagination, trusted effects, invocation mapping and multimodal results', async (t) => {
  const connection = client({ tools: {
    ...policies, slow_write: { effect: 'write', arguments: (args, context) => ({ ...args, invocationId: context.invocationId }) },
    probe: { effect: 'read', arguments: (args, context) => ({ ...args, invocationId: context.invocationId }) },
  } });
  t.after(() => connection.close());
  const tools = await connection.connect();
  assert.equal(connection.protocolVersion, '2025-11-25');
  assert.equal(tools.length, 11); assert(!tools.some((tool) => tool.name === 'hidden'));
  assert.equal(named(tools, 'slow_write').effect, 'write');
  assert.equal(named(tools, 'slow_write').parallel, false);
  const progress: unknown[] = [];
  const result = await named(tools, 'probe').execute({ revision: 2 }, { ...ctx(), progress: async (value) => { progress.push(value); } });
  assert.deepEqual(progress, [{ progress: 1, total: 2, message: 'fixture progress' }]);
  assert.deepEqual(result.metadata?.structuredContent, { initialized: true, cancelled: [], calls: 1, arguments: { revision: 2, invocationId: 'inv-1' } });
  assert.match((result.content[0] as { text: string }).text, /inv-1/);
  const preview = await named(tools, 'image').execute({}, ctx());
  assert.equal(preview.content[1].type, 'image');
  assert.equal(preview.metadata?.structuredContent && (preview.metadata.structuredContent as any).jobId, 'job-1');
  assert(!preview.content.filter((part) => part.type === 'text').some((part) => part.text.includes('AwMD')));
});

test('JSON Schema 2020-12 validates direct and runtime calls; invalid structured output is rejected', async (t) => {
  const connection = client(); t.after(() => connection.close());
  const tools = await connection.connect();
  const strict = named(tools, 'strict_schema');
  await assert.rejects(strict.execute({ items: [1] }, ctx()), code('invalid_arguments'));
  await assert.rejects(strict.execute({ items: ['one', 'two'] }, ctx()), code('invalid_arguments'));
  await strict.execute({ items: ['one'] }, ctx());
  await assert.rejects(named(tools, 'invalid_output').execute({}, ctx()), code('invalid_mcp_result'));
  const known = await named(tools, 'known_error').execute({}, ctx());
  assert.equal(known.isError, true);
  assert.deepEqual(known.content, [{ type: 'text', text: 'Revision conflict' }]);
  let calls = 0;
  const provider = scriptedProvider(async function* (_request, index) {
    calls++;
    yield !index ? { type: 'done', stopReason: 'tools', message: assistant('', [{ id: 'schema', name: 'strict_schema', arguments: { items: ['one'] } }]) }
      : { type: 'done', stopReason: 'stop', message: assistant('valid') };
  });
  const agent = createAgent({ workspace: process.cwd(), provider, store: new MemorySessionStore(), projectInstructions: false, tools: [strict] });
  t.after(() => agent.close());
  assert.equal((await (await agent.sessions.create()).run('schema')).status, 'completed');
  assert.equal(calls, 2);
});

test('host argument mapping validates final dispatch parameters without sending malformed writes', async (t) => {
  const connection = client({ tools: {
    probe: { effect: 'read' },
    strict_schema: { effect: 'write', arguments: (args) => ({ ...args, undeclared: true }) },
  } }); t.after(() => connection.close());
  const tools = await connection.connect();
  await assert.rejects(named(tools, 'strict_schema').execute({ items: ['one'] }, ctx()), code('invalid_mcp_arguments'));
  const result = await named(tools, 'probe').execute({}, ctx());
  assert.equal((result.metadata!.structuredContent as any).calls, 1);
});

test('malformed stdio frame automatically kills a child that ignores TERM without manual close', async (t) => {
  const transport = stdioMcpTransport({ command: process.execPath, args: [fixture, 'bad-frame-ignore-term'], shutdownMs: 30 });
  const connection = client({ transport }); t.after(() => connection.close());
  const tools = await connection.connect();
  const probe = await named(tools, 'probe').execute({}, ctx());
  const pid = (probe.metadata!.structuredContent as any).pid;
  const alive = () => { try { process.kill(pid, 0); return true; } catch (error: any) { if (error.code === 'ESRCH') return false; throw error; } };
  assert(alive());
  await assert.rejects(named(tools, 'protocol_error').execute({}, ctx()), code('mcp_disconnected'));
  const deadline = Date.now() + 1500;
  while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert(!alive(), 'server must exit through automatic bounded teardown');
});

test('unsupported versions close the subprocess; host config denies parallel writes', async () => {
  const connection = client({}, 'incompatible');
  await assert.rejects(connection.connect(), code('mcp_incompatible'));
  assert.throws(() => connection.tools(), code('mcp_tools_stale'));
  assert.throws(() => client({ tools: { unsafe: { effect: 'write', parallel: true } } }), code('invalid_mcp_config'));
});

test('real cancellation emits notifications/cancelled; writes remain outcome_unknown', async (t) => {
  const connection = client(); t.after(() => connection.close());
  const tools = await connection.connect();
  for (const name of ['slow_read', 'slow_write']) {
    const controller = new AbortController();
    const running = named(tools, name).execute({}, ctx(controller.signal));
    controller.abort();
    await assert.rejects(running, code(name === 'slow_read' ? 'aborted' : 'outcome_unknown'));
  }
  const result = await named(tools, 'probe').execute({}, ctx());
  assert.equal((result.metadata!.structuredContent as any).cancelled.length, 2);
  assert.equal((result.metadata!.structuredContent as any).calls, 3);
});

test('real disconnect after write dispatch never replays the command', async (t) => {
  const connection = client(); t.after(() => connection.close());
  const sent: McpMessage[] = [];
  const send = connection.options.transport.send.bind(connection.options.transport);
  connection.options.transport.send = async (message) => { sent.push(message); await send(message); };
  const tool = named(await connection.connect(), 'disconnect_write');
  await assert.rejects(tool.execute({}, ctx()), code('outcome_unknown'));
  await assert.rejects(tool.execute({}, ctx()), code('mcp_disconnected'));
  assert.equal(sent.filter((m) => 'method' in m && m.method === 'tools/call').length, 1);
});

test('timeout sends cancellation once; protocol errors omit arbitrary server details', async (t) => {
  const connection = client({ requestTimeoutMs: 300 }); t.after(() => connection.close());
  const tools = await connection.connect();
  await assert.rejects(named(tools, 'slow_read').execute({}, ctx()), code('mcp_timeout'));
  await assert.rejects(named(tools, 'protocol_error').execute({}, ctx()), (error: unknown) => code('mcp_protocol_error')(error) && !(error as Error).message.includes('secret'));
  const probe = await named(tools, 'probe').execute({}, ctx());
  assert.equal((probe.metadata!.structuredContent as any).cancelled.length, 1);
});

test('list_changed refreshes discovery and invalidates old tool handles', async (t) => {
  let updated!: (tools: Tool[]) => void;
  const update = new Promise<Tool[]>((resolve) => updated = resolve);
  const connection = client({ onToolsChanged: updated }); t.after(() => connection.close());
  const tools = await connection.connect();
  await named(tools, 'change_tools').execute({}, ctx());
  const fresh = await update;
  assert(!fresh.some((tool) => tool.name === 'removed'));
  await assert.rejects(named(tools, 'removed').execute({}, ctx()), code('mcp_tools_stale'));
  await named(fresh, 'probe').execute({}, ctx());
});

test('media/text limits and resource allowlist reject before model injection', () => {
  const image = { type: 'image', data: Buffer.from('image').toString('base64'), mimeType: 'image/png' };
  assert.throws(() => mcpToolResult({ content: [image] }, { maxImageBytes: 4 }), code('mcp_media_limit'));
  assert.throws(() => mcpToolResult({ content: [image, image] }, { maxImages: 1 }), code('mcp_media_limit'));
  assert.throws(() => mcpToolResult({ content: [{ type: 'text', text: '12345' }] }, { maxTextChars: 4 }), code('mcp_text_limit'));
  assert.throws(() => mcpToolResult({ content: [{ ...image, data: 'invalid' }] }), code('invalid_mcp_result'));
  const link = { type: 'resource_link', uri: 'file:///private', name: 'private' };
  assert.throws(() => mcpToolResult({ content: [link] }), code('mcp_resource_denied'));
  const result = mcpToolResult({ content: [link] }, { allowResource: (uri) => uri === link.uri });
  assert.deepEqual(result.metadata?.resources, [{ uri: link.uri }]);
  assert.throws(() => mcpToolResult({ content: [{ type: 'audio', data: 'AAAA', mimeType: 'audio/wav' }] }), code('invalid_mcp_result'));
});

test('image token estimate ignores base64 length and reserves nonzero media allowance', () => {
  const small = [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }];
  const large = [{ type: 'image', data: 'A'.repeat(100_000), mimeType: 'image/png' }];
  assert.equal(estimateTokens(small), estimateTokens(large));
  assert(estimateTokens(small) >= 4096);
  assert.equal(estimateTokens(small, 8000) - estimateTokens(small), 3904);
});

test('history compaction never copies image bytes into summary prompt', async () => {
  const marker = 'SECRET_IMAGE_DATA';
  const messages: Message[] = [
    { id: 'old', role: 'user', content: [{ type: 'image', data: marker, mimeType: 'image/png' }] },
    { id: 'new', role: 'user', content: [{ type: 'text', text: 'continue' }] },
  ];
  let summarized = false;
  const provider = scriptedProvider(async function* (request) {
    summarized = true;
    assert(!JSON.stringify(request).includes(marker));
    yield { type: 'done', stopReason: 'stop', message: assistant('An earlier image was provided.') };
  }, { contextWindow: 2500, maxOutputTokens: 100 });
  const prepared = await new ContextManager({ safetyTokens: 0, keepRecentMessages: 1 }).prepare(provider, messages, [], process.cwd(), new AbortController().signal);
  assert(summarized); assert(prepared.compacted);
});

test('tool image survives runtime text truncation and reaches the next model request', async (t) => {
  const connection = client(); const tools = await connection.connect();
  let sawImage = false;
  const provider = scriptedProvider(async function* (request, index) {
    if (!index) yield { type: 'done', stopReason: 'tools', message: assistant('', [{ id: 'preview', name: 'image', arguments: {} }]) };
    else {
      const result = request.messages.find((message) => message.toolCallId === 'preview'); assert(result);
      sawImage = result.content.some((part) => part.type === 'image');
      assert(!result.content.some((part) => part.type === 'text' && part.text.includes('AwMD')));
      yield { type: 'done', stopReason: 'stop', message: assistant('preview received') };
    }
  }, { contextWindow: 100_000, maxOutputTokens: 100 });
  const agent = createAgent({ workspace: process.cwd(), store: new MemorySessionStore(), provider, tools, projectInstructions: false, maxOutputChars: 20 });
  t.after(async () => { await agent.close(); await connection.close(); });
  const session = await agent.sessions.create();
  await session.run('preview'); assert(sawImage);
});
