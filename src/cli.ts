#!/usr/bin/env node
import { createAgent, createProvider } from './index.js';
import { createAgentServer } from './server/index.js';
import { localTools } from './tools/index.js';
const args = process.argv.slice(2);
const command = args[0] ?? 'help';
if (command === 'serve') {
  const workspace = process.env.COTO_WORKSPACE ?? process.cwd();
  const agent = createAgent({
    workspace,
    provider: createProvider({
      protocol:
        (process.env.COTO_PROTOCOL as
          | 'openai-chat'
          | 'openai-responses'
          | 'anthropic'
          | 'gemini') ?? 'openai-chat',
      model: process.env.COTO_MODEL ?? 'gpt-4o-mini',
      baseURL: process.env.COTO_BASE_URL,
      apiKeyEnv: process.env.COTO_API_KEY_ENV,
      auth: process.env.COTO_AUTH === 'none' ? 'none' : 'api-key',
    }),
    tools: process.env.COTO_TOOLS === 'none' ? [] : localTools(),
    policy:
      process.env.COTO_POLICY === 'allow-all'
        ? 'allow-all'
        : process.env.COTO_POLICY === 'ask'
          ? 'ask'
          : 'read-only',
  });
  const service = createAgentServer(agent, {
    host: process.env.COTO_HOST ?? '127.0.0.1',
    port: Number(process.env.COTO_PORT ?? 8787),
  });
  const address = await service.listen();
  console.log(`COTO listening on http://${address.host}:${address.port}`);
  const close = async () => {
    await service.close().catch(() => {});
    await agent.close();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} else {
  console.log(
    'COTO Agent\n\n  coto serve   Start the HTTP/SSE service\n\nConfigure COTO_BASE_URL, COTO_MODEL, COTO_PROTOCOL and the provider-specific API key environment variable.',
  );
}
