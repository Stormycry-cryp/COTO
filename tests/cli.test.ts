import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgent, AgentError } from '../src/index.js';
import { assistant, scriptedProvider } from '../src/testing/index.js';
import { PassThrough } from 'node:stream';
import { askApproval } from '../src/cli.js';
import { CotoClient } from '../src/client/index.js';
import type { AgentEvent } from '../src/core/types.js';

const cli = resolve('src/cli.ts');
const tsx = resolve('node_modules/tsx/dist/cli.mjs');

async function runCli(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [tsx, cli, ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
  return { code, signal, stdout, stderr };
}

async function workspace(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'coto-cli-'));
  t.after(() => rm(root, { recursive: true }));
  return root;
}

async function fixtureServer() {
  let requests = 0;
  const authorizations: Array<string | undefined> = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    requests++;
    authorizations.push(request.headers.authorization);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const prompt = body.messages?.at(-1)?.content ?? 'unknown';
    if (JSON.stringify(prompt).includes('fail once')) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'fixture failure' } }));
      return;
    }
    const text = `fixture:${typeof prompt === 'string' ? prompt : JSON.stringify(prompt)}`;
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(
      `data: ${JSON.stringify({
        id: `chat-${requests}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        id: `chat-${requests}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      })}\n\n`,
    );
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not listen');
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requestCount: () => requests,
    authorizations: () => [...authorizations],
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    },
  };
}

test('init is repeatable, fills partial projects and does not overwrite user files', async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, 'coto.agent.mjs'), 'user-owned\n');
  await writeFile(join(root, '.gitignore'), 'dist/');
  const first = await runCli(['init', '--workspace', root]);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /created coto\.config\.json/);
  assert.match(first.stdout, /kept\s+coto\.agent\.mjs/);
  assert.equal(await readFile(join(root, 'coto.agent.mjs'), 'utf8'), 'user-owned\n');
  const configBefore = await readFile(join(root, 'coto.config.json'), 'utf8');
  const parsed = JSON.parse(configBefore);
  assert.equal(parsed.provider.model, 'deepseek-flash');
  assert.equal(parsed.agent.policy, 'allow-all');
  assert(!configBefore.includes('apiKey"'));
  const ignore = await readFile(join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^dist\/\n\.coto\/\n\.env\.coto\n$/);

  const second = await runCli(['init', '--workspace', root, '--provider', 'openai']);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(await readFile(join(root, 'coto.config.json'), 'utf8'), configBefore);
  assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), ignore);
  assert.match(second.stdout, /kept\s+coto\.config\.json/);
});

test('doctor reports a missing key without printing secret material', async (t) => {
  const root = await workspace(t);
  assert.equal((await runCli(['init', '--workspace', root])).code, 0);
  const secret = 'must-not-appear-in-output';
  const cleanEnv = { ...process.env, DEEPSEEK_API_KEY: undefined };
  const missing = await runCli(['doctor', '--workspace', root], { env: cleanEnv });
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /FAIL api-key: DEEPSEEK_API_KEY \(missing\)/);
  assert(!`${missing.stdout}${missing.stderr}`.includes(secret));
  const present = await runCli(['doctor', '--workspace', root, '--json'], {
    env: { ...cleanEnv, DEEPSEEK_API_KEY: secret },
  });
  assert.equal(present.code, 0, present.stderr);
  assert.equal(JSON.parse(present.stdout).ok, true);
  assert(!`${present.stdout}${present.stderr}`.includes(secret));
});

test('run streams NDJSON against a local provider and persists a resumable session', async (t) => {
  const root = await workspace(t);
  const fixture = await fixtureServer();
  t.after(() => fixture.close());
  await writeFile(
    join(root, 'coto.config.json'),
    JSON.stringify({
      provider: {
        protocol: 'openai-chat',
        model: 'fixture-model',
        baseURL: fixture.url,
        auth: 'none',
      },
      agent: { tools: 'none', policy: 'allow-all', projectInstructions: false, maxRetries: 0 },
      server: { port: 0 },
    }),
  );
  const first = await runCli(['run', 'hello', '--json', '--workspace', root]);
  assert.equal(first.code, 0, first.stderr);
  const events = first.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(events.some((event) => event.type === 'text.delta'));
  assert.equal(events.at(-1).type, 'turn.completed');
  const match = first.stderr.match(/^session: ([\w-]+)$/m);
  assert(match);
  const sessionId = match[1];
  const list = await runCli(['sessions', '--json', '--workspace', root]);
  assert.equal(list.code, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).id, sessionId);

  const resumed = await runCli(['run', 'again', '--session', sessionId, '--workspace', root]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.match(resumed.stdout, /fixture:/);
  assert.match(resumed.stderr, new RegExp(`session: ${sessionId}`));
  assert.equal(fixture.requestCount(), 2);
});

test('run --session resumes after a failed turn instead of waiting indefinitely', async (t) => {
  const root = await workspace(t);
  const fixture = await fixtureServer();
  t.after(() => fixture.close());
  await writeFile(
    join(root, 'coto.config.json'),
    JSON.stringify({
      provider: {
        protocol: 'openai-chat',
        model: 'fixture-model',
        baseURL: fixture.url,
        auth: 'none',
      },
      agent: { tools: 'none', projectInstructions: false, maxRetries: 0 },
    }),
  );
  const failed = await runCli(['run', 'fail once', '--workspace', root]);
  assert.equal(failed.code, 1, failed.stderr);
  const sessionId = failed.stderr.match(/^session: ([\w-]+)$/m)?.[1];
  assert(sessionId);
  const resumed = await runCli([
    'run',
    'recover',
    '--session',
    sessionId,
    '--workspace',
    root,
    '--json',
  ]);
  assert.equal(resumed.code, 0, resumed.stderr);
  const events = resumed.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.type === 'turn.started').length, 1);
  assert.equal(events.at(-1).type, 'turn.completed');
  assert.match(resumed.stdout, /recover/);
});

test('run --session explains unresolved tool outcomes without scheduling new work', async (t) => {
  const root = await workspace(t);
  const provider = scriptedProvider(async function* () {
    yield {
      type: 'done',
      message: assistant('', [{ id: 'uncertain', name: 'uncertain_write', arguments: {} }]),
      stopReason: 'tools',
    };
  });
  const agent = createAgent({
    workspace: root,
    provider,
    projectInstructions: false,
    policy: 'allow-all',
    tools: [
      {
        name: 'uncertain_write',
        description: 'Fixture with unknown side effects',
        effect: 'write',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute() {
          throw new AgentError('outcome_unknown', 'Verify external result', 409);
        },
      },
    ],
  });
  const session = await agent.sessions.create();
  try {
    assert.equal((await session.run('start')).status, 'failed');
    assert.equal(session.snapshot().unresolved.length, 1);
  } finally {
    await agent.close();
  }
  await writeFile(
    join(root, 'coto.config.json'),
    JSON.stringify({
      provider: {
        id: provider.id,
        protocol: 'openai-chat',
        model: provider.model,
        baseURL: 'http://127.0.0.1:9',
        auth: 'none',
      },
      agent: { tools: 'none', maxRetries: 0 },
    }),
  );
  const result = await runCli([
    'run',
    'continue',
    '--session',
    session.id,
    '--workspace',
    root,
    '--json',
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /requires reconciliation/);
  assert.equal(result.stdout, '');
});

test('ask policy denies write tools without a TTY and does not hang', async (t) => {
  const root = await workspace(t);
  let requestIndex = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the body before responding.
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requestIndex++ === 0) {
      response.write(
        `data: ${JSON.stringify({
          id: 'tool-turn',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture-model',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'write-1',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"denied.txt","content":"no"}',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: 'tool-turn',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })}\n\n`,
      );
    } else {
      response.write(
        `data: ${JSON.stringify({
          id: 'after-denial',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture-model',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'denied safely' },
              finish_reason: 'stop',
            },
          ],
        })}\n\n`,
      );
    }
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not listen');
  await writeFile(
    join(root, 'coto.config.json'),
    JSON.stringify({
      provider: {
        protocol: 'openai-chat',
        model: 'fixture-model',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        auth: 'none',
      },
      agent: { tools: 'local-basic', policy: 'ask', projectInstructions: false, maxRetries: 0 },
    }),
  );
  const result = await runCli(['run', 'write', '--workspace', root]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /\[approval\] denied write_file: stdin is not interactive/);
  assert.match(result.stdout, /denied safely/);
  await assert.rejects(readFile(join(root, 'denied.txt')), { code: 'ENOENT' });
});

test('interactive approval closes when its turn ends while readline is waiting', async () => {
  const input = new PassThrough();
  const output = new PassThrough() as PassThrough & { columns?: number };
  output.columns = 80;
  let listener: ((event: AgentEvent) => void) | undefined;
  let approvals = 0;
  const session = {
    async approve() {
      approvals++;
    },
    async cancel() {},
    subscribe(next: (event: AgentEvent) => void) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  const event: AgentEvent = {
    schemaVersion: 1,
    sessionId: 'session',
    eventId: 'session:1',
    seq: 1,
    timestamp: new Date(0).toISOString(),
    type: 'approval.required',
    turnId: 'turn',
    data: { approvalId: 'approval', tool: 'write_file', arguments: { path: 'x' } },
  };
  const waiting = askApproval(event, session, { input, output, interactive: true });
  await once(output, 'data');
  listener?.({ ...event, eventId: 'session:2', seq: 2, type: 'turn.interrupted', data: {} });
  await Promise.race([
    waiting,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('approval prompt did not close with its turn')), 1_000),
    ),
  ]);
  assert.equal(approvals, 0);
  input.destroy();
  output.destroy();
});

test('SIGINT cancels an active run, closes the agent and exits 130', async (t) => {
  const root = await workspace(t);
  let requestStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => (requestStarted = resolveStarted));
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the body before holding the stream open.
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': waiting\n\n');
    requestStarted();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not listen');
  await writeFile(
    join(root, 'coto.config.json'),
    JSON.stringify({
      provider: {
        protocol: 'openai-chat',
        model: 'fixture-model',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        auth: 'none',
      },
      agent: { tools: 'none', policy: 'allow-all', projectInstructions: false, maxRetries: 0 },
    }),
  );
  const child = spawn(process.execPath, [tsx, cli, 'run', 'wait', '--json', '--workspace', root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  await Promise.race([
    started,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('provider request did not start')), 5_000),
    ),
  ]);
  child.kill('SIGINT');
  const [code, signal] = (await Promise.race([
    once(child, 'exit'),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('CLI did not exit after SIGINT')), 5_000),
    ),
  ])) as [number | null, NodeJS.Signals | null];
  assert.equal(signal, null);
  assert.equal(code, 130, stderr);
  assert.match(stderr, /^session: [\w-]+$/m);
});

test('serve derives workspace from --config and COTO_API_KEY_ENV replaces the config resolver', async (t) => {
  const root = await workspace(t);
  const other = await workspace(t);
  const fixture = await fixtureServer();
  t.after(() => fixture.close());
  await writeFile(
    join(root, 'coto.config.json'),
    JSON.stringify({
      provider: {
        protocol: 'openai-chat',
        model: 'fixture-model',
        baseURL: fixture.url,
        apiKeyEnv: 'OLD_API_KEY',
      },
      agent: { tools: 'none', projectInstructions: false },
      server: { host: '127.0.0.1', port: 0 },
    }),
  );
  await writeFile(join(root, '.env.coto'), 'OLD_API_KEY=old-secret\n');
  const child = spawn(
    process.execPath,
    [tsx, cli, 'serve', '--config', join(root, 'coto.config.json')],
    {
      cwd: other,
      env: {
        ...process.env,
        COTO_WORKSPACE: undefined,
        COTO_PORT: '0',
        COTO_API_KEY_ENV: 'NEW_API_KEY',
        NEW_API_KEY: 'override-secret',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  const listening = new Promise<string>((resolveListening, reject) => {
    const inspect = () => {
      const match = stdout.match(/COTO listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) resolveListening(match[1]);
    };
    child.stdout.on('data', inspect);
    child.once('exit', () => reject(new Error(`serve exited before listening: ${stderr}`)));
    inspect();
  });
  const url = await Promise.race([
    listening,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('serve did not listen')), 5_000),
    ),
  ]);
  const client = new CotoClient(url);
  const created = (await client.createSession()) as { meta: { id: string; workspace: string } };
  assert.equal(created.meta.workspace, await realpath(root));
  await client.submitInput(created.meta.id, {
    inputId: 'serve-input',
    mode: 'follow_up',
    content: [{ type: 'text', text: 'serve' }],
  });
  for await (const event of client.events(created.meta.id)) {
    if (event.type === 'turn.completed') break;
  }
  assert.deepEqual(fixture.authorizations(), ['Bearer override-secret']);
  child.kill('SIGTERM');
  const [code, signal] = (await Promise.race([
    once(child, 'exit'),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('serve did not stop')), 5_000),
    ),
  ])) as [number | null, NodeJS.Signals | null];
  assert.equal(signal, null);
  assert.equal(code, 0, stderr);
});

test('invalid command input and missing model fail with non-zero exit codes', async (t) => {
  const root = await workspace(t);
  const unknown = await runCli(['init', '--wat', '--workspace', root]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown option: --wat/);
  await writeFile(
    join(root, 'coto.config.json'),
    JSON.stringify({ provider: { protocol: 'openai-chat', model: '', auth: 'none' } }),
  );
  const noModel = await runCli(['run', 'hello', '--workspace', root]);
  assert.equal(noModel.code, 1);
  assert.match(noModel.stderr, /provider\.model must be a non-empty string/);
});
