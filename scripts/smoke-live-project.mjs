import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Explicitly opt-in: this installs a consumer package and makes paid provider requests.
const credentialName = process.env.COTO_API_KEY_ENV ?? 'COTO_TEST_API_KEY';
const credential = process.env[credentialName];
assert(credential, `Set ${credentialName} before running the live project probe`);
const execute = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(join(tmpdir(), 'coto-live-project-'));
const project = join(root, 'consumer');
const archives = join(root, 'archives');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const environment = { ...process.env };
delete environment[credentialName];
const redact = (value) => String(value).split(credential).join('[REDACTED]');

async function run(command, args, cwd, env = environment, timeout = 120_000) {
  try {
    return await execute(command, args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    throw new Error(
      redact(`${command} failed: ${error.message}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`),
    );
  }
}

try {
  await mkdir(project);
  await mkdir(archives);
  await run(npm, ['pack', '--pack-destination', archives], repository);
  const tarballs = (await readdir(archives)).filter((name) => name.endsWith('.tgz'));
  assert.equal(tarballs.length, 1);
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify({ name: 'coto-live-consumer', private: true, type: 'module' }),
  );
  await run(
    npm,
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(archives, tarballs[0])],
    project,
  );
  const cli = join(project, 'node_modules/@coto/agent/dist/cli.js');
  await run(process.execPath, [cli, 'init'], project);
  const configPath = join(project, 'coto.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.agent.policy, 'allow-all');
  config.provider = {
    protocol: process.env.COTO_PROTOCOL ?? 'openai-chat',
    baseURL: process.env.COTO_BASE_URL ?? 'https://api.deepseek.com',
    model: process.env.COTO_MODEL ?? 'deepseek-flash',
    apiKeyEnv: credentialName,
    timeoutMs: 60_000,
    maxOutputTokens: 1024,
  };
  Object.assign(config.agent, {
    maxSteps: 10,
    maxRetries: 0,
    maxTurnMs: 180_000,
    toolTimeoutMs: 15_000,
  });
  await writeFile(configPath, JSON.stringify(config, null, 2));
  const original = 'export function add(a, b) { return a - b; }\n';
  const verification = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add } from './calculator.mjs';
test('addition', () => {
  for (const [a, b, sum] of [[2, 3, 5], [-4, 7, 3], [0, 0, 0], [0.5, 0.25, 0.75]])
    assert.equal(add(a, b), sum);
});
`;
  await writeFile(join(project, 'calculator.mjs'), original);
  await writeFile(join(project, 'calculator.test.mjs'), verification);
  await assert.rejects(run(process.execPath, ['--test', 'calculator.test.mjs'], project));
  const { stdout } = await run(
    process.execPath,
    [
      cli,
      'run',
      'Read calculator.mjs and calculator.test.mjs. Fix the addition bug in calculator.mjs without changing tests or configuration. Use the file tools to inspect and edit the source, then exec_command to run node --test calculator.test.mjs. Report the actual test result briefly.',
      '--json',
    ],
    project,
    { ...environment, [credentialName]: credential },
    200_000,
  );
  const events = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const terminal = events.findLast((event) =>
    ['turn.completed', 'turn.failed', 'turn.interrupted'].includes(event.type),
  );
  assert.equal(terminal?.type, 'turn.completed', redact(JSON.stringify(terminal?.data)));
  assert.notEqual(await readFile(join(project, 'calculator.mjs'), 'utf8'), original);
  assert.equal(
    await readFile(join(project, 'calculator.test.mjs'), 'utf8'),
    verification,
    'test file must remain intact',
  );
  const names = events
    .filter((event) => event.type === 'tool.started')
    .map((event) => event.data.call.name);
  assert(names.includes('read_file'));
  assert(names.some((name) => ['edit_file', 'write_file', 'apply_patch'].includes(name)));
  assert(names.includes('exec_command'));
  const commandResults = events
    .filter(
      (event) => event.type === 'tool.completed' && event.data.message?.toolName === 'exec_command',
    )
    .flatMap((event) =>
      event.data.message.content
        .filter((part) => part.type === 'text')
        .map((part) => JSON.parse(part.text)),
    );
  assert(
    commandResults.some((result) => result.exited && result.exitCode === 0),
    'the model must observe a successful command result',
  );
  await run(process.execPath, ['--test', 'calculator.test.mjs'], project);
  const sessionId = terminal.sessionId;
  const journal = await readFile(
    join(project, '.coto/sessions', sessionId, 'events.jsonl'),
    'utf8',
  );
  assert(!journal.includes(credential), 'credential must not be persisted');
  console.log(
    JSON.stringify({
      check: 'installed_live_project_edit_and_test',
      status: 'passed',
      protocol: config.provider.protocol,
      endpoint: config.provider.baseURL,
      model: config.provider.model,
      tools: names,
      usage: events.filter((event) => event.type === 'usage.updated').map((event) => event.data),
      externalTest: 'passed',
      defaultPolicy: config.agent.policy,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
