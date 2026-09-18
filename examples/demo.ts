import { createAgent, defineTool, MemorySessionStore } from '@coto/agent';
import { assistant, scriptedProvider } from '@coto/agent/testing';

const double = defineTool({
  name: 'double',
  description: 'Double an integer.',
  effect: 'read' as const,
  parameters: {
    type: 'object',
    properties: { value: { type: 'integer' } },
    required: ['value'],
    additionalProperties: false,
  },
  async execute(args) {
    return {
      content: [{ type: 'text' as const, text: String(Number(args.value) * 2) }],
    };
  },
});

const provider = scriptedProvider(async function* (request, index) {
  if (index === 0) {
    yield {
      type: 'done',
      stopReason: 'tools',
      message: assistant('', [{ id: 'demo-call', name: 'double', arguments: { value: 21 } }]),
    };
    return;
  }

  const toolResult = request.messages.find((message) => message.toolCallId === 'demo-call');
  const value = toolResult?.content.find((part) => part.type === 'text')?.text ?? 'unknown';
  const text = `Tool result: ${value}`;
  yield { type: 'text_delta', text };
  yield { type: 'done', stopReason: 'stop', message: assistant(text) };
});

const agent = createAgent({
  workspace: process.cwd(),
  provider,
  store: new MemorySessionStore(),
  tools: [double],
  policy: 'read-only',
  projectInstructions: false,
});

try {
  const session = await agent.sessions.create();
  console.log(`session: ${session.id}`);

  for await (const event of session.runStream('Double 21.')) {
    if (event.type === 'tool.started') {
      console.log(`tool: ${String(event.data.invocationId)}`);
    }
    if (event.type === 'text.delta') {
      process.stdout.write(String(event.data.text));
    }
    if (event.type === 'turn.completed') {
      process.stdout.write('\n');
    }
  }

  console.log(`events: ${session.snapshot().seq}`);
} finally {
  await agent.close();
}
