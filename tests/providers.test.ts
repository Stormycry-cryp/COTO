import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createProvider, type ProviderConfig } from '../src/providers/index.js';
import { AgentError } from '../src/core/errors.js';
import type { Message, ModelEvent, ModelRequest } from '../src/core/types.js';

type Protocol = ProviderConfig['protocol'];
type CapturedRequest = { path: string; headers: IncomingMessage['headers']; body: any };

const protocols: Protocol[] = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'];
const tool = {
  name: 'lookup',
  description: 'Look up a forecast',
  parameters: {
    type: 'object',
    properties: { q: { type: 'string' } },
    required: ['q'],
    additionalProperties: false,
  },
};
const user = (text: string): Message => ({
  id: crypto.randomUUID(),
  role: 'user',
  content: [{ type: 'text', text }],
});
const request = (messages: Message[] = [user('weather')]): ModelRequest => ({
  system: 'Be concise.',
  messages,
  tools: [tool],
  maxOutputTokens: 64,
});

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : undefined;
}

async function mockServer(
  handler: (req: IncomingMessage, res: ServerResponse, index: number) => Promise<void> | void,
) {
  let index = 0;
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res, index++)).catch((error) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      if (!res.writableEnded)
        res.end(
          JSON.stringify({
            error: { message: error instanceof Error ? error.message : String(error) },
          }),
        );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock server did not bind to TCP');
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function openSse(res: ServerResponse) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

function dataEvents(res: ServerResponse, events: unknown[], done = true) {
  openSse(res);
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  if (done) res.write('data: [DONE]\n\n');
  res.end();
}

function anthropicEvents(
  res: ServerResponse,
  events: Array<{ type: string; [key: string]: unknown }>,
) {
  openSse(res);
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

function openAIChatTool(res: ServerResponse) {
  dataEvents(res, [
    {
      id: 'chat-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chat-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '"weather"}' } }] },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chat-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    },
  ]);
}

function openAIChatText(res: ServerResponse, text = 'clear') {
  dataEvents(res, [
    {
      id: 'chat-2',
      object: 'chat.completion.chunk',
      created: 2,
      model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    },
    {
      id: 'chat-2',
      object: 'chat.completion.chunk',
      created: 2,
      model: 'test-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    },
  ]);
}

function responseEnvelope(
  id: string,
  output: unknown[],
  usage: { input_tokens: number; output_tokens: number; total_tokens: number },
) {
  return {
    id,
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: 'test-model',
    output,
    parallel_tool_calls: true,
    usage: {
      ...usage,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

function openAIResponsesTool(res: ServerResponse) {
  const item = {
    id: 'fc_1',
    type: 'function_call',
    call_id: 'call_1',
    name: 'lookup',
    arguments: '{"q":"weather"}',
    status: 'completed',
  };
  dataEvents(res, [
    { type: 'response.created', response: { id: 'resp-1', status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, arguments: '', status: 'in_progress' },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      item_id: 'fc_1',
      delta: '{"q":"weather"}',
    },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: responseEnvelope('resp-1', [item], {
        input_tokens: 5,
        output_tokens: 2,
        total_tokens: 7,
      }),
    },
  ]);
}

function openAIResponsesText(res: ServerResponse, text = 'clear') {
  const item = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
  };
  dataEvents(res, [
    { type: 'response.created', response: { id: 'resp-2', status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      item_id: 'msg_1',
      content_index: 0,
      delta: text,
      logprobs: [],
    },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: responseEnvelope('resp-2', [item], {
        input_tokens: 8,
        output_tokens: 3,
        total_tokens: 11,
      }),
    },
  ]);
}

function anthropicTool(res: ServerResponse) {
  anthropicEvents(res, [
    {
      type: 'message_start',
      message: {
        id: 'msg-1',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"q":"weather"}' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: 'message_stop' },
  ]);
}

function anthropicText(res: ServerResponse, text = 'clear') {
  anthropicEvents(res, [
    {
      type: 'message_start',
      message: {
        id: 'msg-2',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 8, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 3 },
    },
    { type: 'message_stop' },
  ]);
}

function geminiTool(res: ServerResponse) {
  dataEvents(
    res,
    [
      {
        responseId: 'gemini-1',
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { id: 'call_1', name: 'lookup', args: { q: 'weather' } } }],
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
      },
    ],
    false,
  );
}

function geminiText(res: ServerResponse, text = 'clear') {
  dataEvents(
    res,
    [
      {
        responseId: 'gemini-2',
        candidates: [
          { content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 },
        ],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 11 },
      },
    ],
    false,
  );
}

function writeSuccess(protocol: Protocol, res: ServerResponse, index: number, text = 'clear') {
  if (protocol === 'openai-chat')
    return index === 0 ? openAIChatTool(res) : openAIChatText(res, text);
  if (protocol === 'openai-responses')
    return index === 0 ? openAIResponsesTool(res) : openAIResponsesText(res, text);
  if (protocol === 'anthropic') return index === 0 ? anthropicTool(res) : anthropicText(res, text);
  return index === 0 ? geminiTool(res) : geminiText(res, text);
}

function expectedPath(protocol: Protocol) {
  if (protocol === 'openai-chat') return '/v1/chat/completions';
  if (protocol === 'openai-responses') return '/v1/responses';
  if (protocol === 'anthropic') return '/v1/messages?beta=true';
  return '/v1beta/models/test-model:streamGenerateContent?alt=sse';
}

function baseURL(protocol: Protocol, url: string) {
  if (protocol.startsWith('openai-')) return `${url}/v1`;
  if (protocol === 'gemini') return `${url}/v1beta`;
  return url;
}

async function collect(
  provider: ReturnType<typeof createProvider>,
  modelRequest: ModelRequest,
  signal = new AbortController().signal,
) {
  const events: ModelEvent[] = [];
  for await (const event of provider.stream(modelRequest, { signal })) events.push(event);
  return events;
}

function done(events: ModelEvent[]) {
  const event = events.find(
    (candidate): candidate is Extract<ModelEvent, { type: 'done' }> => candidate.type === 'done',
  );
  assert(event, 'provider did not emit done');
  return event;
}

function assertToolResult(protocol: Protocol, body: any, callId: string) {
  if (protocol === 'openai-chat') {
    const result = body.messages.find((message: any) => message.role === 'tool');
    assert.deepEqual(
      { id: result.tool_call_id, content: result.content },
      { id: callId, content: 'sunny' },
    );
  } else if (protocol === 'openai-responses') {
    const result = body.input.find((item: any) => item.type === 'function_call_output');
    assert.deepEqual(
      { id: result.call_id, output: result.output },
      { id: 'call_1', output: 'sunny' },
    );
  } else if (protocol === 'anthropic') {
    const result = body.messages
      .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
      .find((part: any) => part.type === 'tool_result');
    assert.equal(result.tool_use_id, callId);
    assert.equal(result.content, 'sunny');
  } else {
    const result = body.contents
      .flatMap((content: any) => content.parts)
      .find((part: any) => part.functionResponse)?.functionResponse;
    assert.equal(result.name, 'lookup');
    assert.equal(result.response.output, 'sunny');
  }
}

for (const protocol of protocols) {
  test(`${protocol}: real wire stream handles tools, replay, text, usage and keyless headers`, async () => {
    const captured: CapturedRequest[] = [];
    const envName = `COTO_TEST_HEADER_${protocol.replaceAll('-', '_').toUpperCase()}`;
    process.env[envName] = 'from-env';
    const server = await mockServer(async (req, res, index) => {
      captured.push({ path: req.url ?? '', headers: req.headers, body: await readJson(req) });
      writeSuccess(protocol, res, index);
    });
    try {
      const provider = createProvider({
        protocol,
        model: 'test-model',
        baseURL: baseURL(protocol, server.url),
        auth: 'none',
        headers: { 'x-static': 'static-value' },
        headerEnv: { 'x-from-env': envName },
      });
      const firstEvents = await collect(provider, request());
      const first = done(firstEvents);
      assert.equal(first.stopReason, 'tools');
      assert.deepEqual(first.usage, { input: 5, output: 2 });
      assert.deepEqual(first.message.toolCalls?.[0]?.arguments, { q: 'weather' });
      assert(firstEvents.some((event) => event.type === 'tool_delta'));

      const call = first.message.toolCalls![0];
      const result: Message = {
        id: 'result-1',
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: 'sunny' }],
      };
      const secondEvents = await collect(
        provider,
        request([user('weather'), first.message, result]),
      );
      const second = done(secondEvents);
      assert.equal(second.stopReason, 'stop');
      assert.equal(
        second.message.content[0]?.type === 'text' ? second.message.content[0].text : '',
        'clear',
      );
      assert.deepEqual(second.usage, { input: 8, output: 3 });
      assert.equal(
        secondEvents
          .filter((event) => event.type === 'text_delta')
          .map((event) => (event.type === 'text_delta' ? event.text : ''))
          .join(''),
        'clear',
      );

      assert.equal(captured.length, 2);
      assert.equal(captured[0].path, expectedPath(protocol));
      assert.equal(captured[0].headers['x-static'], 'static-value');
      assert.equal(captured[0].headers['x-from-env'], 'from-env');
      if (protocol.startsWith('openai-'))
        assert.equal(captured[0].headers.authorization, undefined);
      if (protocol === 'anthropic') assert.equal(captured[0].headers['x-api-key'], undefined);
      if (protocol === 'gemini') assert.equal(captured[0].headers['x-goog-api-key'], '');
      assertToolResult(protocol, captured[1].body, call.id);
    } finally {
      delete process.env[envName];
      await server.close();
    }
  });
}

for (const protocol of protocols) {
  test(`${protocol}: runtime API key uses the protocol's native auth header`, async () => {
    let captured: IncomingMessage['headers'] | undefined;
    const server = await mockServer((req, res) => {
      captured = req.headers;
      writeSuccess(protocol, res, 1, 'authenticated');
    });
    try {
      const key = `${protocol}-runtime-key`;
      const provider = createProvider({
        protocol,
        model: 'test-model',
        baseURL: baseURL(protocol, server.url),
        apiKey: key,
      });
      assert.equal(done(await collect(provider, request())).stopReason, 'stop');
      if (protocol.startsWith('openai-')) assert.equal(captured?.authorization, `Bearer ${key}`);
      else if (protocol === 'anthropic') assert.equal(captured?.['x-api-key'], key);
      else assert.equal(captured?.['x-goog-api-key'], key);
    } finally {
      await server.close();
    }
  });
}

function writeIncomplete(protocol: Protocol, res: ServerResponse) {
  if (protocol === 'openai-chat')
    return dataEvents(res, [
      {
        id: 'chat-bad',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test-model',
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
      },
    ]);
  if (protocol === 'openai-responses')
    return dataEvents(res, [
      { type: 'response.created', response: { id: 'resp-bad', status: 'in_progress', output: [] } },
    ]);
  if (protocol === 'anthropic')
    return anthropicEvents(res, [
      {
        type: 'message_start',
        message: {
          id: 'msg-bad',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      { type: 'message_stop' },
    ]);
  return dataEvents(
    res,
    [{ candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] }, index: 0 }] }],
    false,
  );
}

for (const protocol of protocols) {
  test(`${protocol}: incomplete protocol stream is rejected`, async () => {
    const server = await mockServer((_req, res) => writeIncomplete(protocol, res));
    try {
      const provider = createProvider({
        protocol,
        model: 'test-model',
        baseURL: baseURL(protocol, server.url),
        auth: 'none',
      });
      await assert.rejects(
        collect(provider, request()),
        (error: unknown) => error instanceof AgentError && error.code === 'provider_error',
      );
    } finally {
      await server.close();
    }
  });

  test(`${protocol}: HTTP errors are normalized and configured secrets are redacted`, async () => {
    const server = await mockServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      if (protocol === 'anthropic')
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'bad secret-token' },
          }),
        );
      else
        res.end(
          JSON.stringify({
            error: {
              code: 400,
              status: 'INVALID_ARGUMENT',
              type: 'invalid_request_error',
              message: 'bad secret-token',
            },
          }),
        );
    });
    try {
      const provider = createProvider({
        protocol,
        model: 'test-model',
        baseURL: baseURL(protocol, server.url),
        auth: 'none',
        headers: { 'x-secret': 'secret-token' },
      });
      await assert.rejects(
        collect(provider, request()),
        (error: unknown) =>
          error instanceof AgentError &&
          error.code === 'provider_error' &&
          !error.message.includes('secret-token') &&
          error.message.includes('[REDACTED]'),
      );
    } finally {
      await server.close();
    }
  });

  test(`${protocol}: AbortSignal cancels an active streaming request`, async () => {
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const server = await mockServer((_req, res) => {
      openSse(res);
      res.write(': waiting\n\n');
      markEntered();
    });
    try {
      const provider = createProvider({
        protocol,
        model: 'test-model',
        baseURL: baseURL(protocol, server.url),
        auth: 'none',
        timeoutMs: 5_000,
      });
      const controller = new AbortController();
      const active = collect(provider, request(), controller.signal);
      await entered;
      controller.abort();
      await assert.rejects(
        Promise.race([
          active,
          new Promise((_, reject) => setTimeout(() => reject(new Error('abort timeout')), 2_000)),
        ]),
        (error: unknown) => error instanceof AgentError && error.code === 'aborted',
      );
    } finally {
      await server.close();
    }
  });
}

test('runtime API key and resolver authentication use the configured endpoint directly', async () => {
  const auth: Array<string | undefined> = [];
  const server = await mockServer((req, res, index) => {
    auth.push(req.headers.authorization);
    openAIChatText(res, index ? 'resolver' : 'direct');
  });
  try {
    const direct = createProvider({
      protocol: 'openai-chat',
      model: 'test-model',
      baseURL: `${server.url}/v1`,
      apiKey: 'direct-key',
    });
    const directDone = done(await collect(direct, request()));
    assert.equal(
      directDone.message.content[0]?.type === 'text' ? directDone.message.content[0].text : '',
      'direct',
    );
    const resolved = createProvider({
      protocol: 'openai-chat',
      model: 'test-model',
      baseURL: `${server.url}/v1`,
      apiKeyResolver: async () => 'resolved-key',
    });
    const resolvedDone = done(await collect(resolved, request()));
    assert.equal(
      resolvedDone.message.content[0]?.type === 'text' ? resolvedDone.message.content[0].text : '',
      'resolver',
    );
    assert.deepEqual(auth, ['Bearer direct-key', 'Bearer resolved-key']);
  } finally {
    await server.close();
  }
});

test('providerData from another endpoint is reconstructed without opaque replay metadata', async () => {
  const firstServer = await mockServer((_req, res) =>
    openAIResponsesText(res, 'from first endpoint'),
  );
  const secondBodies: any[] = [];
  const secondServer = await mockServer(async (req, res) => {
    secondBodies.push(await readJson(req));
    openAIResponsesText(res, 'from second endpoint');
  });
  try {
    const firstProvider = createProvider({
      id: 'shared',
      protocol: 'openai-responses',
      model: 'test-model',
      baseURL: `${firstServer.url}/v1`,
      auth: 'none',
    });
    const oldMessage = done(await collect(firstProvider, request())).message;
    (oldMessage.providerData!.value as any).content = null;
    const secondProvider = createProvider({
      id: 'shared',
      protocol: 'openai-responses',
      model: 'test-model',
      baseURL: `${secondServer.url}/v1`,
      auth: 'none',
    });
    const result = done(await collect(secondProvider, request([oldMessage, user('continue')])));
    assert.equal(
      result.message.content[0]?.type === 'text' ? result.message.content[0].text : '',
      'from second endpoint',
    );
    const replayed = secondBodies[0].input.find(
      (item: any) => item.type === 'message' && item.role === 'assistant',
    );
    assert.equal(replayed.content[0].text, 'from first endpoint');
  } finally {
    await firstServer.close();
    await secondServer.close();
  }
});

test('providerData from another protocol is reconstructed at the same endpoint', async () => {
  const bodies: any[] = [];
  const server = await mockServer(async (req, res) => {
    bodies.push(await readJson(req));
    if (req.url === '/v1/responses') openAIResponsesText(res, 'responses text');
    else openAIChatText(res, 'chat text');
  });
  try {
    const responses = createProvider({
      id: 'shared',
      protocol: 'openai-responses',
      model: 'test-model',
      baseURL: `${server.url}/v1`,
      auth: 'none',
    });
    const oldMessage = done(await collect(responses, request())).message;
    (oldMessage.providerData!.value as any).content = null;
    const chat = createProvider({
      id: 'shared',
      protocol: 'openai-chat',
      model: 'test-model',
      baseURL: `${server.url}/v1`,
      auth: 'none',
    });
    const result = done(await collect(chat, request([oldMessage, user('continue')])));
    assert.equal(
      result.message.content[0]?.type === 'text' ? result.message.content[0].text : '',
      'chat text',
    );
    assert.equal(
      bodies[1].messages.find((message: any) => message.role === 'assistant').content,
      'responses text',
    );
  } finally {
    await server.close();
  }
});

test('Gemini default endpoint includes the API version path', async () => {
  const originalFetch = globalThis.fetch;
  let requested = '';
  globalThis.fetch = async (input, init) => {
    requested = String(input instanceof Request ? input.url : input);
    return new Response(
      `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } })}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };
  try {
    const provider = createProvider({ protocol: 'gemini', model: 'test-model', auth: 'none' });
    assert.equal(done(await collect(provider, request())).stopReason, 'stop');
    assert.match(
      requested,
      /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/test-model:streamGenerateContent\?alt=sse$/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
