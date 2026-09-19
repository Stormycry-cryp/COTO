import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAgent, MemorySessionStore } from '../dist/index.js';
import { createProvider } from '../dist/providers/index.js';
import { createAgentServer } from '../dist/server/index.js';
import { CotoClient } from '../dist/client/index.js';

// Opt-in production probe. Credentials are resolved from the named environment variable.
const provider = createProvider({
  protocol: process.env.COTO_PROTOCOL ?? 'openai-chat',
  baseURL: process.env.COTO_BASE_URL,
  model: process.env.COTO_MODEL,
  apiKeyEnv: process.env.COTO_API_KEY_ENV ?? 'COTO_TEST_API_KEY',
  maxOutputTokens: 256,
  timeoutMs: 45_000,
});
const marker = `COTO-${randomUUID()}`;
let toolExecutions = 0;
const agent = createAgent({
  workspace: process.cwd(),
  provider,
  store: new MemorySessionStore(),
  projectInstructions: false,
  maxRetries: 0,
  maxSteps: 3,
  maxTurnMs: 90_000,
  context: {
    system:
      'Follow the user instructions exactly. Use the provided verification tool when asked. Keep replies brief.',
  },
  tools: [
    {
      name: 'verification_token',
      description: 'Return the fresh verification token. It cannot be guessed.',
      effect: 'read',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        toolExecutions++;
        return { content: [{ type: 'text', text: marker }] };
      },
    },
  ],
});
const service = createAgentServer(agent);
try {
  if (process.env.COTO_PROBE_ONLY !== 'cancellation') {
    const { port } = await service.listen();
    const client = new CotoClient(`http://127.0.0.1:${port}`);
    const created = await client.createSession();
    const session = await agent.sessions.get(created.meta.id);
    await client.submitInput(session.id, {
      inputId: randomUUID(),
      mode: 'follow_up',
      content: [
        {
          type: 'text',
          text: 'Call verification_token once, then reply with only the exact token returned by the tool.',
        },
      ],
    });
    let deltas = 0;
    let terminal;
    for await (const event of client.events(session.id, 0, AbortSignal.timeout(95_000))) {
      if (event.type === 'text.delta') deltas++;
      if (['turn.completed', 'turn.failed', 'turn.interrupted'].includes(event.type)) {
        terminal = event;
        break;
      }
    }
    assert.equal(terminal?.type, 'turn.completed', JSON.stringify(terminal?.data));
    assert.equal(toolExecutions, 1);
    assert(
      terminal.data.result.text.includes(marker),
      'Model must reproduce the actual tool result',
    );
    assert(deltas > 0, 'Expected real text deltas through HTTP/SSE');
    console.log(
      JSON.stringify({ check: 'provider_tool_http_sse', status: 'passed', deltas, toolExecutions }),
    );

    const followUp = await session.run(
      'Repeat only the exact verification token from our previous exchange. Do not call any tool.',
    );
    assert.equal(followUp.status, 'completed', followUp.reason);
    assert(followUp.text.includes(marker), 'Session continuation must preserve the tool result');
    assert.equal(toolExecutions, 1);
    const usage = session
      .history()
      .filter((e) => e.type === 'usage.updated')
      .map((e) => e.data);
    console.log(JSON.stringify({ check: 'session_continuation', status: 'passed', usage }));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  let receivedDelta = false;
  let completed = false;
  let cancelled = false;
  try {
    for await (const event of provider.stream(
      {
        system: 'Follow the instruction.',
        messages: [
          {
            id: randomUUID(),
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Reply with exactly this text and nothing else: COTO streaming cancellation verification is running now.',
              },
            ],
          },
        ],
        tools: [],
        maxOutputTokens: 256,
      },
      { signal: controller.signal },
    )) {
      if (event.type === 'text_delta' && !receivedDelta) {
        receivedDelta = true;
        controller.abort();
      }
      if (event.type === 'done') completed = true;
    }
  } catch (error) {
    if (!controller.signal.aborted || !receivedDelta || error.code !== 'aborted') throw error;
    cancelled = true;
  } finally {
    clearTimeout(timer);
  }
  assert(
    receivedDelta && cancelled && !completed,
    `The active provider stream must stop on cancellation: ${JSON.stringify({ receivedDelta, cancelled, completed })}`,
  );
  console.log(JSON.stringify({ check: 'stream_cancellation', status: 'passed' }));
} finally {
  await service.close();
  await agent.close();
}
