import type { Message, ModelEvent, ModelProvider, ModelRequest } from '../core/types.js';
import { delay } from '../core/async.js';
export type Script = (
  request: ModelRequest,
  index: number,
  signal: AbortSignal,
) => AsyncIterable<ModelEvent>;
export function scriptedProvider(
  script: Script,
  limits = { contextWindow: 100_000, maxOutputTokens: 4096 },
): ModelProvider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    id: 'scripted',
    model: 'test',
    capabilities: { ...limits, tools: true, images: true },
    requests,
    stream(request, { signal }) {
      requests.push(structuredClone(request));
      return script(request, requests.length - 1, signal);
    },
  };
}
export function assistant(text: string, toolCalls?: Message['toolCalls']): Message {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    toolCalls,
  };
}
export function echoProvider(delayMs = 10) {
  return scriptedProvider(async function* (request, _index, signal) {
    const latest = request.messages.filter((m) => m.role === 'user').at(-1);
    const text = `Echo: ${
      latest?.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('') ?? ''
    }`;
    for (const word of text.match(/.{1,8}/gs) ?? []) {
      await delay(delayMs, signal);
      yield { type: 'text_delta', text: word };
    }
    yield { type: 'done', message: assistant(text), stopReason: 'stop' };
  });
}
