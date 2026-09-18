import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'coto-package-smoke-'));
const packageDirectory = join(temporaryRoot, 'package');
const consumerDirectory = join(temporaryRoot, 'consumer');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function run(command, args, cwd) {
  try {
    const result = await exec(command, args, {
      cwd,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}

try {
  await mkdir(packageDirectory);
  await mkdir(consumerDirectory);
  await run(npm, ['pack', '--pack-destination', packageDirectory], repository);

  const archives = (await readdir(packageDirectory)).filter((file) => file.endsWith('.tgz'));
  assert.equal(archives.length, 1, 'npm pack must create exactly one tarball');
  const archive = join(packageDirectory, archives[0]);

  await writeFile(
    join(consumerDirectory, 'package.json'),
    JSON.stringify({ name: 'coto-package-smoke', private: true, type: 'module' }, null, 2),
  );
  await run(
    npm,
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive],
    consumerDirectory,
  );

  await writeFile(
    join(consumerDirectory, 'consumer.mjs'),
    `import assert from 'node:assert/strict';
import { createAgent, MemorySessionStore } from '@coto/agent';
import { echoProvider } from '@coto/agent/testing';

const provider = echoProvider(0);
const agent = createAgent({
  workspace: process.cwd(),
  provider,
  store: new MemorySessionStore(),
  projectInstructions: false,
});

try {
  const session = await agent.sessions.create();
  const result = await session.run('package smoke');
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Echo: package smoke');
  assert.equal(provider.requests.length, 1);
  assert(session.history().some((event) => event.type === 'text.delta'));
  assert(session.history().some((event) => event.type === 'turn.completed'));
} finally {
  await agent.close();
}
`,
  );
  await run(process.execPath, ['consumer.mjs'], consumerDirectory);
  console.log('tarball consumer smoke passed');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
