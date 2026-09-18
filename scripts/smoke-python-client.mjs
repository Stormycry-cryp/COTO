import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createAgent, MemorySessionStore } from '../dist/index.js';
import { createAgentServer } from '../dist/server/index.js';
import { echoProvider } from '../dist/testing/index.js';

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const provider = echoProvider(0);
const agent = createAgent({
  workspace: repository,
  provider,
  store: new MemorySessionStore(),
  projectInstructions: false,
});
const service = createAgentServer(agent);

try {
  const { port } = await service.listen();
  const environment = {
    ...process.env,
    COTO_URL: `http://127.0.0.1:${port}`,
    COTO_PROMPT: 'cross-language smoke',
  };
  delete environment.COTO_TOKEN;

  const python = process.env.PYTHON ?? 'python3';
  const { stdout, stderr } = await exec(
    python,
    [resolve(repository, 'examples/python_client.py')],
    { cwd: repository, env: environment, timeout: 30_000, maxBuffer: 1024 * 1024 },
  );

  assert.match(stderr, /^session=\S+ acceptedSeq=\d+/m);
  assert.equal(stdout.trim(), 'Echo: cross-language smoke');
  assert.equal(provider.requests.length, 1);
  console.log('Python HTTP/SSE smoke passed');
} finally {
  await service.close();
  await agent.close();
}
