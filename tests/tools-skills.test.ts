import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../src/core/types.js';
import { AgentError } from '../src/core/errors.js';
import { fileTools } from '../src/tools/files.js';
import { boundedHttp, httpTool, remoteTool } from '../src/tools/network.js';
import { processTools } from '../src/tools/process.js';
import { projectInstructions, SkillRegistry } from '../src/skills/index.js';

function context(workspace: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspace,
    sessionId: 'session-1',
    turnId: 'turn-1',
    invocationId: 'invocation-1',
    signal: new AbortController().signal,
    async progress() {},
    ...overrides,
  };
}

function named(tools: Tool[], name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert(tool, `missing tool ${name}`);
  return tool;
}

function jsonResult(result: ToolResult): any {
  const part = result.content[0];
  assert(part && part.type === 'text');
  return JSON.parse(part.text);
}

function agentError(code: string) {
  return (error: unknown) => error instanceof AgentError && error.code === code;
}

async function within<T>(promise: Promise<T>, milliseconds: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function temporary(t: { after(fn: () => Promise<void>): void }, prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('file tools create, conflict-check, edit and apply a multi-file unified diff', async (t) => {
  const root = await temporary(t, 'coto-files-');
  const tools = fileTools();
  const ctx = context(root);
  const write = named(tools, 'write_file');
  const edit = named(tools, 'edit_file');
  const patch = named(tools, 'apply_patch');

  await write.execute({ path: 'notes.txt', content: 'alpha\nbeta\n' }, ctx);
  await assert.rejects(
    write.execute({ path: 'notes.txt', content: 'stale\n' }, ctx),
    agentError('file_conflict'),
  );
  await write.execute(
    { path: 'notes.txt', content: 'alpha\nbeta\nbeta\n', expectedContent: 'alpha\nbeta\n' },
    ctx,
  );
  await assert.rejects(
    edit.execute({ path: 'notes.txt', oldText: 'beta', newText: 'gamma' }, ctx),
    agentError('edit_conflict'),
  );
  await edit.execute({ path: 'notes.txt', oldText: 'alpha', newText: 'first' }, ctx);
  await writeFile(join(root, 'remove.txt'), 'bye\n');

  const unified = [
    '--- a/notes.txt',
    '+++ b/notes.txt',
    '@@ -1,3 +1,3 @@',
    ' first',
    '-beta',
    '+second',
    ' beta',
    '--- /dev/null',
    '+++ b/created.txt',
    '@@ -0,0 +1 @@',
    '+created',
    '--- a/remove.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    '',
  ].join('\n');
  const result = jsonResult(await patch.execute({ patch: unified }, ctx));
  assert.deepEqual(result.applied.sort(), ['created.txt', 'notes.txt', 'remove.txt']);
  assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'first\nsecond\nbeta\n');
  assert.equal(await readFile(join(root, 'created.txt'), 'utf8'), 'created\n');
  await assert.rejects(readFile(join(root, 'remove.txt')), { code: 'ENOENT' });
});

test('file read and write boundaries deny state paths and escaping symlinks', async (t) => {
  const root = await temporary(t, 'coto-boundary-');
  const outside = await temporary(t, 'coto-outside-');
  await mkdir(join(root, '.git'));
  await mkdir(join(root, '.coto'));
  await writeFile(join(root, '.git', 'config'), 'secret');
  await writeFile(join(root, '.coto', 'state'), 'secret');
  await writeFile(join(outside, 'secret.txt'), 'outside');
  await symlink(outside, join(root, 'escape'));
  const tools = fileTools();
  const ctx = context(root);
  const read = named(tools, 'read_file');
  const write = named(tools, 'write_file');
  const list = named(tools, 'list_files');

  await assert.rejects(read.execute({ path: '.git/config' }, ctx), agentError('path_denied'));
  await assert.rejects(read.execute({ path: '.coto/state' }, ctx), agentError('path_denied'));
  await assert.rejects(read.execute({ path: 'escape/secret.txt' }, ctx), agentError('path_denied'));
  await assert.rejects(
    write.execute({ path: 'escape/new.txt', content: 'blocked' }, ctx),
    agentError('path_denied'),
  );
  const listed = jsonResult(await list.execute({}, ctx));
  assert.deepEqual(listed.files, []);
});

test('process tools expose bounded output to the owner and cancel the process group', async (t) => {
  const root = await temporary(t, 'coto-process-');
  const tools = processTools();
  t.after(() => named(tools, 'exec_command').close!());
  const owner = context(root);
  const started = jsonResult(
    await named(tools, 'exec_command').execute(
      { command: 'printf "ready\\n"; sleep 30', yieldMs: 100 },
      owner,
    ),
  );
  assert.equal(started.exited, false);
  assert.match(started.output, /ready/);
  const read = jsonResult(
    await named(tools, 'process_read').execute({ processId: started.processId }, owner),
  );
  assert.match(read.output, /ready/);
  await assert.rejects(
    named(tools, 'process_read').execute(
      { processId: started.processId },
      context(root, { sessionId: 'other' }),
    ),
    agentError('process_not_found'),
  );
  const cancelled = jsonResult(
    await named(tools, 'process_cancel').execute({ processId: started.processId }, owner),
  );
  assert.equal(cancelled.exited, true);
});

test('turn cancellation terminates an active command before its yield deadline', async (t) => {
  const root = await temporary(t, 'coto-process-abort-');
  const tools = processTools();
  t.after(() => named(tools, 'exec_command').close!());
  const controller = new AbortController();
  const running = named(tools, 'exec_command').execute(
    { command: 'printf "started\\n"; sleep 30', yieldMs: 5000 },
    context(root, { turnSignal: controller.signal }),
  );
  setTimeout(() => controller.abort(), 100);
  const result = jsonResult(await within(running, 2000, 'process cancellation timed out'));
  assert.equal(result.exited, true);
  assert.match(result.output, /started/);
});

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

test('HTTP and Remote Tool use an opted-in private fixture and preserve invocation data', async (t) => {
  let remoteRequest: { headers: IncomingMessage['headers']; body: any } | undefined;
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.url === '/remote') {
      remoteRequest = { headers: request.headers, body: JSON.parse(await readBody(request)) };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          content: [{ type: 'text', text: 'remote ok' }],
          metadata: { fixture: true },
        }),
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('fixture ok');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const ctx = context(process.cwd());

  await assert.rejects(boundedHttp(base, { signal: ctx.signal }), agentError('network_denied'));
  const fetched = jsonResult(
    await httpTool({ allowPrivate: true }).execute({ url: `${base}/fixture` }, ctx),
  );
  assert.deepEqual(fetched, { status: 200, text: 'fixture ok', contentType: 'text/plain' });
  const remote = remoteTool({
    name: 'fixture_remote',
    description: 'Local fixture',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: { value: { type: 'integer' } },
      required: ['value'],
      additionalProperties: false,
    },
    endpoint: `${base}/remote`,
    allowPrivate: true,
  });
  const remoteResult = await remote.execute({ value: 7 }, ctx);
  assert.equal(
    remoteResult.content[0]?.type === 'text' ? remoteResult.content[0].text : '',
    'remote ok',
  );
  assert.equal(remoteRequest?.headers['idempotency-key'], 'invocation-1');
  assert.deepEqual(remoteRequest?.body, {
    invocationId: 'invocation-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    arguments: { value: 7 },
  });
});

test('allowPrivate false rejects private, documentation and reserved address literals', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '[::1]',
    '[2001:db8::1]',
  ]) {
    await assert.rejects(
      boundedHttp(`http://${address}/`, { signal: AbortSignal.timeout(1000) }),
      agentError('network_denied'),
      address,
    );
  }
});

test('Skill registry validates frontmatter, resolves stable IDs and confines resources', async (t) => {
  const rootA = await temporary(t, 'coto-skills-a-');
  const rootB = await temporary(t, 'coto-skills-b-');
  const outside = await temporary(t, 'coto-skills-outside-');
  await mkdir(join(rootA, 'first', 'references'), { recursive: true });
  await mkdir(join(rootB, 'second'), { recursive: true });
  await writeFile(
    join(rootA, 'first', 'SKILL.md'),
    '---\nname: Example\ndescription: First skill\n---\nUse the reference.\n',
  );
  await writeFile(join(rootA, 'first', 'references', 'guide.txt'), 'bounded resource');
  await writeFile(
    join(rootB, 'second', 'SKILL.md'),
    '---\nname: Example\ndescription: Second skill\n---\nOther body.\n',
  );
  await writeFile(join(outside, 'secret.txt'), 'outside');
  await symlink(join(outside, 'secret.txt'), join(rootA, 'first', 'escape.txt'));

  const registry = new SkillRegistry([rootA, rootB]);
  const catalog = await registry.discover();
  assert.deepEqual(
    catalog.map((skill) => skill.id),
    ['r0/first', 'r1/second'],
  );
  assert.equal(catalog[0].hash.length, 64);
  await assert.rejects(registry.read('Example'), agentError('skill_not_found'));
  assert.equal(
    (await registry.read('r0/first', 'references/guide.txt')).content,
    'bounded resource',
  );
  await assert.rejects(registry.read('r0/first', 'escape.txt'), agentError('path_denied'));
  await assert.rejects(
    registry.read('r0/first', join(outside, 'secret.txt')),
    agentError('path_denied'),
  );
  const listed = jsonResult(
    await named(registry.tools(), 'skills_list').execute({}, context(rootA)),
  );
  assert.equal(listed[0].root, undefined);
  assert.equal(listed.length, 2);
});

test('Skill discovery rejects malformed frontmatter and project instructions deny escaping symlinks', async (t) => {
  const skillsRoot = await temporary(t, 'coto-skills-invalid-');
  const workspace = await temporary(t, 'coto-instructions-');
  const outside = await temporary(t, 'coto-instructions-outside-');
  await mkdir(join(skillsRoot, 'invalid'));
  await writeFile(
    join(skillsRoot, 'invalid', 'SKILL.md'),
    'name: Missing delimiter\ndescription: Invalid\n',
  );
  await assert.rejects(new SkillRegistry([skillsRoot]).discover(), agentError('invalid_skill'));
  await writeFile(join(outside, 'AGENTS.md'), 'outside instructions');
  await symlink(join(outside, 'AGENTS.md'), join(workspace, 'AGENTS.md'));
  await assert.rejects(
    projectInstructions()({ workspace, messages: [], signal: new AbortController().signal }),
    agentError('path_denied'),
  );
});
