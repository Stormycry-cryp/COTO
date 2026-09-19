import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'coto-project-smoke-'));
const packageDirectory = join(temporaryRoot, 'package');
const consumerDirectory = join(temporaryRoot, 'consumer');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const fixtureKey = 'local-project-smoke-key';
const fixtureRequests = [];
let continuationHistoryObserved = false;

function outputOf(error, name) {
  const stdout = typeof error.stdout === 'string' ? error.stdout : '';
  const stderr = typeof error.stderr === 'string' ? error.stderr : '';
  return `${name} failed with exit ${String(error.code)}\n${stdout}${stderr}`;
}

async function run(command, args, cwd, options = {}) {
  try {
    const result = await execute(command, args, {
      cwd,
      env: options.env ?? process.env,
      timeout: options.timeout ?? 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (options.allowFailure && typeof error.code === 'number') {
      return { status: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
    throw new Error(outputOf(error, `${command} ${args.join(' ')}`), { cause: error });
  }
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendChatEvents(response, events) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end('data: [DONE]\n\n');
}

function sendToolCall(response, id, name, args) {
  sendChatEvents(response, [
    {
      id: `chat-${id}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'coto-smoke-model',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: `chat-${id}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'coto-smoke-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    },
  ]);
}

function sendText(response, text) {
  sendChatEvents(response, [
    {
      id: 'chat-text',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'coto-smoke-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    },
    {
      id: 'chat-text',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'coto-smoke-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    },
  ]);
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('');
}

function toolMessagesAfter(messages, index) {
  return messages.slice(index + 1).filter((message) => message.role === 'tool');
}

async function startProviderFixture() {
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`);
      const body = await readJsonBody(request);
      fixtureRequests.push(body);
      const messages = body.messages ?? [];
      const userIndex = messages.findLastIndex((message) => message.role === 'user');
      const prompt = messageText(messages[userIndex]);
      const toolMessages = toolMessagesAfter(messages, userIndex);
      const toolNames = new Set((body.tools ?? []).map((tool) => tool.function?.name));

      if (prompt.includes('Create smoke-output.txt')) {
        assert(toolNames.has('write_file') && toolNames.has('read_file'));
        if (toolMessages.length === 0)
          return sendToolCall(response, 'write-smoke', 'write_file', {
            path: 'smoke-output.txt',
            content: 'COTO project smoke',
          });
        if (toolMessages.length === 1) {
          assert.equal(toolMessages[0].tool_call_id, 'write-smoke');
          return sendToolCall(response, 'read-smoke', 'read_file', { path: 'smoke-output.txt' });
        }
        assert.equal(toolMessages.at(-1).tool_call_id, 'read-smoke');
        assert.match(messageText(toolMessages.at(-1)), /COTO project smoke/);
        return sendText(response, 'file tool chain complete');
      }

      if (prompt.includes('Continue the existing smoke session')) {
        continuationHistoryObserved = messages.some(
          (message) => message.role === 'tool' && message.tool_call_id === 'read-smoke',
        );
        assert(continuationHistoryObserved, 'continued run must send prior tool history');
        return sendText(response, 'session history continued');
      }

      if (prompt.includes('Use smoke_marker and read smoke-skill')) {
        assert(toolNames.has('smoke_marker'));
        assert(toolNames.has('skills_read'));
        if (toolMessages.length === 0)
          return sendToolCall(response, 'custom-smoke', 'smoke_marker', {});
        if (toolMessages.length === 1) {
          assert.equal(toolMessages[0].tool_call_id, 'custom-smoke');
          assert.match(messageText(toolMessages[0]), /CUSTOM_TOOL_MARKER/);
          return sendToolCall(response, 'skill-smoke', 'skills_read', { id: 'r0/smoke-skill' });
        }
        assert.equal(toolMessages.at(-1).tool_call_id, 'skill-smoke');
        assert.match(messageText(toolMessages.at(-1)), /CUSTOM_SKILL_MARKER/);
        return sendText(response, 'custom tool and skill complete');
      }

      if (prompt.includes('HTTP SSE project smoke'))
        return sendText(response, 'HTTP SSE smoke complete');

      throw new Error(`Unexpected fixture prompt: ${prompt}`);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      ),
  };
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const { port } = address;
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

function waitForOutput(child, expression, timeout = 10_000) {
  return new Promise((resolveOutput, reject) => {
    let output = '';
    const timer = setTimeout(
      () => finish(new Error(`Timed out waiting for ${expression}: ${output}`)),
      timeout,
    );
    const onData = (chunk) => {
      output += chunk.toString();
      if (expression.test(output)) finish(undefined, output);
    };
    const onExit = (code) =>
      finish(new Error(`Process exited ${code} before ${expression}: ${output}`));
    const finish = (error, value) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolveOutput(value);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolveExit) => child.once('exit', resolveExit));
  }
}

async function readUntilCompleted(response) {
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = '';
  try {
    while (!content.includes('event: turn.completed')) {
      const { done, value } = await reader.read();
      if (done) break;
      content += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  assert.match(content, /event: text\.delta/);
  assert.match(content, /HTTP SSE smoke complete/);
  assert.match(content, /event: turn\.completed/);
}

const providerFixture = await startProviderFixture();
let serveProcess;

try {
  await mkdir(packageDirectory);
  await mkdir(consumerDirectory);
  await run(npm, ['pack', '--pack-destination', packageDirectory], repository, {
    timeout: 120_000,
  });
  const archives = (await readdir(packageDirectory)).filter((file) => file.endsWith('.tgz'));
  assert.equal(archives.length, 1, 'npm pack must create exactly one tarball');

  await writeFile(
    join(consumerDirectory, 'package.json'),
    JSON.stringify({ name: 'coto-project-smoke', private: true, type: 'module' }, null, 2),
  );
  await run(
    npm,
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(packageDirectory, archives[0])],
    consumerDirectory,
    { timeout: 120_000 },
  );
  const cli =
    process.platform === 'win32'
      ? join(consumerDirectory, 'node_modules', '@coto', 'agent', 'dist', 'cli.js')
      : join(consumerDirectory, 'node_modules', '.bin', 'coto');
  await access(cli);
  const cliEnvironment = { ...process.env, COTO_API_KEY: fixtureKey };

  const initialized = await run(
    process.execPath,
    [
      cli,
      'init',
      '--provider',
      'custom',
      '--protocol',
      'openai-chat',
      '--model',
      'coto-smoke-model',
      '--base-url',
      providerFixture.baseURL,
    ],
    consumerDirectory,
  );
  assert.match(
    initialized.stdout,
    /created coto\.config\.json/,
    `init produced unexpected output: ${JSON.stringify(initialized)}`,
  );
  const generatedFiles = ['coto.config.json', '.env.coto.example', 'coto.agent.mjs', '.gitignore'];
  const initialContents = Object.fromEntries(
    await Promise.all(
      generatedFiles.map(async (file) => [
        file,
        await readFile(join(consumerDirectory, file), 'utf8'),
      ]),
    ),
  );
  const config = JSON.parse(initialContents['coto.config.json']);
  assert.equal(config.agent.policy, 'allow-all');
  assert.equal(config.provider.apiKeyEnv, 'COTO_API_KEY');

  const repeated = await run(process.execPath, [cli, 'init'], consumerDirectory);
  assert.match(repeated.stdout, /kept\s+coto\.config\.json/);
  for (const file of generatedFiles)
    assert.equal(
      await readFile(join(consumerDirectory, file), 'utf8'),
      initialContents[file],
      `${file} was overwritten`,
    );

  const missingKeyEnvironment = { ...process.env };
  delete missingKeyEnvironment.COTO_API_KEY;
  const missingDoctor = await run(process.execPath, [cli, 'doctor', '--json'], consumerDirectory, {
    env: missingKeyEnvironment,
    allowFailure: true,
  });
  assert.notEqual(missingDoctor.status, 0);
  const missingDiagnostics = JSON.parse(missingDoctor.stdout.trim());
  assert.equal(missingDiagnostics.ok, false);
  assert.equal(missingDiagnostics.credentials[0].present, false);
  const passingDoctor = await run(
    npm,
    ['exec', '--', 'coto', 'doctor', '--json'],
    consumerDirectory,
    {
      env: cliEnvironment,
    },
  );
  assert.equal(JSON.parse(passingDoctor.stdout.trim()).ok, true);

  const firstRun = await run(
    process.execPath,
    [cli, 'run', 'Create smoke-output.txt with the required content, then read it back.', '--json'],
    consumerDirectory,
    { env: cliEnvironment },
  );
  assert.equal(
    await readFile(join(consumerDirectory, 'smoke-output.txt'), 'utf8'),
    'COTO project smoke',
  );
  assert.match(firstRun.stdout, /"type":"tool\.completed"/);
  assert.match(firstRun.stdout, /file tool chain complete/);
  const sessionId = firstRun.stderr.match(/^session: (\S+)$/m)?.[1];
  assert(sessionId, `run did not report a session id: ${firstRun.stderr}`);

  const continued = await run(
    process.execPath,
    [
      cli,
      'run',
      'Continue the existing smoke session and confirm its history.',
      '--session',
      sessionId,
      '--json',
    ],
    consumerDirectory,
    { env: cliEnvironment },
  );
  assert.match(continued.stdout, /session history continued/);
  assert(continuationHistoryObserved);
  const listed = await run(process.execPath, [cli, 'sessions', '--json'], consumerDirectory, {
    env: cliEnvironment,
  });
  assert(
    listed.stdout
      .trim()
      .split('\n')
      .some((line) => JSON.parse(line).id === sessionId),
  );

  await mkdir(join(consumerDirectory, '.agents', 'skills', 'smoke-skill'), { recursive: true });
  await writeFile(
    join(consumerDirectory, '.agents', 'skills', 'smoke-skill', 'SKILL.md'),
    '---\nname: smoke-skill\ndescription: Local project smoke guidance.\n---\nCUSTOM_SKILL_MARKER\n',
  );
  await writeFile(
    join(consumerDirectory, 'coto.agent.mjs'),
    `import { createAgent, defineTool } from '@coto/agent';
import { loadProjectConfig } from '@coto/agent/config';
import { localTools } from '@coto/agent/tools';

const smokeMarker = defineTool({
  name: 'smoke_marker',
  description: 'Return the custom project marker.',
  effect: 'read',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute() {
    return { content: [{ type: 'text', text: 'CUSTOM_TOOL_MARKER' }] };
  },
});

export async function createProjectAgent(options = {}) {
  const config = await loadProjectConfig(options);
  return createAgent({ ...config.agentOptions, tools: [...localTools(), smokeMarker] });
}
`,
  );
  await writeFile(
    join(consumerDirectory, 'embedding-smoke.mjs'),
    `import assert from 'node:assert/strict';
import { createProjectAgent } from './coto.agent.mjs';

const agent = await createProjectAgent({ workspace: process.cwd() });
try {
  const session = await agent.sessions.create();
  const result = await session.run('Use smoke_marker and read smoke-skill, then confirm both results.');
  assert.equal(result.status, 'completed');
  assert.match(result.text, /custom tool and skill complete/);
} finally {
  await agent.close();
}
`,
  );
  await run(process.execPath, ['embedding-smoke.mjs'], consumerDirectory, { env: cliEnvironment });

  const servicePort = await unusedPort();
  serveProcess = spawn(process.execPath, [cli, 'serve'], {
    cwd: consumerDirectory,
    env: { ...cliEnvironment, COTO_PORT: String(servicePort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForOutput(serveProcess, /COTO listening on http:\/\/127\.0\.0\.1:\d+/);
  const serviceURL = `http://127.0.0.1:${servicePort}`;
  assert.deepEqual(await (await fetch(`${serviceURL}/healthz`)).json(), { ok: true });
  const created = await fetch(`${serviceURL}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(created.status, 201);
  const serviceSessionId = (await created.json()).meta.id;
  const submitted = await fetch(`${serviceURL}/v1/sessions/${serviceSessionId}/inputs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      inputId: 'project-smoke-input',
      mode: 'follow_up',
      content: [{ type: 'text', text: 'HTTP SSE project smoke' }],
    }),
  });
  assert.equal(submitted.status, 202);
  await readUntilCompleted(
    await fetch(`${serviceURL}/v1/sessions/${serviceSessionId}/events`, {
      signal: AbortSignal.timeout(10_000),
    }),
  );

  assert(
    fixtureRequests.length >= 8,
    `expected full provider exercise, got ${fixtureRequests.length} requests`,
  );
  console.log('installed project CLI, embedding, session restart and HTTP/SSE smoke passed');
} finally {
  if (serveProcess) await stopChild(serveProcess);
  await providerFixture.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}
