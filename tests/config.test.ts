import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectConfig } from '../src/config/index.js';
import type { ProviderConfig } from '../src/providers/index.js';

async function project(t: Parameters<typeof test>[1] extends (t: infer T) => unknown ? T : never) {
  const root = await mkdtemp(join(tmpdir(), 'coto-config-'));
  (t as { after(callback: () => Promise<void>): void }).after(() => rm(root, { recursive: true }));
  return root;
}

test('loads declarative config and .env.coto without mutating process.env', async (t) => {
  const root = await project(t);
  const variable = 'COTO_CONFIG_TEST_KEY_UNIQUE';
  delete process.env[variable];
  await writeFile(
    join(root, 'coto.config.json'),
    JSON.stringify({
      provider: {
        protocol: 'openai-chat',
        model: 'fixture-model',
        baseURL: 'http://127.0.0.1:4567/v1',
        apiKeyEnv: variable,
        headers: { 'x-client': 'coto-test' },
        headerEnv: { 'x-tenant': 'COTO_TENANT' },
        compat: {
          supportsStore: false,
          supportsFinishReason: false,
          supportsLongCacheRetention: true,
          zaiToolStream: false,
          deferredToolsMode: 'kimi',
          vllmPriority: 4,
          maxTokensField: 'max_tokens',
        },
      },
      agent: {
        tools: 'none',
        policy: 'ask',
        context: { system: 'Fixture system', safetyTokens: 0, keepRecentMessages: 0 },
        maxRetries: 0,
      },
      server: { host: '127.0.0.1', port: 0 },
    }),
  );
  await writeFile(join(root, '.env.coto'), `${variable}=local-secret\nCOTO_TENANT=tenant-secret\n`);

  const loaded = await loadProjectConfig({ workspace: root, env: {} });
  const provider = loaded.agentOptions.provider as ProviderConfig;
  assert.equal(loaded.workspace, root);
  assert.equal(loaded.agentOptions.policy, 'ask');
  assert.deepEqual(loaded.agentOptions.tools, []);
  assert.deepEqual(loaded.agentOptions.context, {
    system: 'Fixture system',
    safetyTokens: 0,
    keepRecentMessages: 0,
  });
  assert.equal(loaded.agentOptions.maxRetries, 0);
  assert.equal(loaded.serverOptions.port, 0);
  assert.equal(
    await provider.apiKeyResolver?.({ signal: new AbortController().signal }),
    'local-secret',
  );
  assert.deepEqual(provider.headers, { 'x-client': 'coto-test', 'x-tenant': 'tenant-secret' });
  assert.equal(loaded.diagnostics.ok, true);
  assert(loaded.diagnostics.credentials.every((credential) => credential.source === '.env.coto'));
  assert.equal(process.env[variable], undefined);
});

test('explicit environment wins and default protocol key is resolved from it', async (t) => {
  const root = await project(t);
  await writeFile(
    join(root, 'coto.config.json'),
    JSON.stringify({
      provider: { protocol: 'openai-responses', model: 'fixture-model', auth: 'api-key' },
      agent: { tools: 'none' },
    }),
  );
  await writeFile(join(root, '.env.coto'), 'OPENAI_API_KEY=local-value\n');
  const loaded = await loadProjectConfig({
    workspace: root,
    env: { OPENAI_API_KEY: 'explicit-value' },
  });
  const provider = loaded.agentOptions.provider as ProviderConfig;
  assert.equal(
    await provider.apiKeyResolver?.({ signal: new AbortController().signal }),
    'explicit-value',
  );
  assert.equal(loaded.diagnostics.credentials[0].environmentVariable, 'OPENAI_API_KEY');
  assert.equal(loaded.diagnostics.credentials[0].source, 'environment');
});

test('accepts current responses compat switches and rejects invalid token limits', async (t) => {
  const root = await project(t);
  const path = join(root, 'coto.config.json');
  await writeFile(
    path,
    JSON.stringify({
      provider: {
        protocol: 'openai-responses',
        model: 'fixture-model',
        auth: 'none',
        compat: {
          supportsAdditionalTools: true,
          supportsToolSearch: false,
          supportsExplicitPromptCacheMode: true,
          supportsMaxOutputTokens: false,
        },
      },
    }),
  );
  const loaded = await loadProjectConfig({ workspace: root, env: {} });
  assert.deepEqual((loaded.agentOptions.provider as ProviderConfig).compat, {
    supportsAdditionalTools: true,
    supportsToolSearch: false,
    supportsExplicitPromptCacheMode: true,
    supportsMaxOutputTokens: false,
  });

  await writeFile(
    path,
    JSON.stringify({
      provider: {
        protocol: 'openai-chat',
        model: 'fixture-model',
        auth: 'none',
        contextWindow: 4608,
        maxOutputTokens: 4096,
      },
    }),
  );
  await assert.rejects(loadProjectConfig({ workspace: root, env: {} }), /must exceed.*512/);
});

test('rejects executable, secret-bearing and unknown config fields', async (t) => {
  const root = await project(t);
  const path = join(root, 'coto.config.json');
  for (const provider of [
    { protocol: 'openai-chat', model: '', auth: 'none' },
    { protocol: 'custom', model: 'x', auth: 'none' },
    { protocol: 'openai-chat', model: 'x', apiKey: 'secret' },
    { protocol: 'openai-chat', model: 'x', headers: { Authorization: 'secret' } },
    { protocol: 'anthropic', model: 'x', compat: { supportsStore: false } },
    { protocol: 'openai-chat', model: 'x', compat: { supportsFinishReason: 'yes' } },
    { protocol: 'openai-responses', model: 'x', compat: { supportsMaxOutputTokens: 1 } },
  ]) {
    await writeFile(path, JSON.stringify({ provider }));
    await assert.rejects(loadProjectConfig({ workspace: root, env: {} }));
  }
});
