import { createHash } from 'node:crypto';
import {
  createModels,
  createProvider as piProvider,
  type Model,
  type Api,
  type Message as PiMessage,
  type AssistantMessage,
  type TSchema,
  type OpenAICompletionsCompat,
  type OpenAIResponsesCompat,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import type { Message, ModelProvider, ModelRequest, ModelEvent } from '../core/types.js';
import { AgentError } from '../core/errors.js';

export interface ProviderConfig {
  id?: string;
  protocol: 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini';
  model: string;
  baseURL?: string;
  apiKey?: string;
  apiKeyResolver?: (context: {
    signal: AbortSignal;
  }) => string | undefined | Promise<string | undefined>;
  apiKeyEnv?: string;
  auth?: 'api-key' | 'none';
  headers?: Record<string, string>;
  headerEnv?: Record<string, string>;
  contextWindow?: number;
  maxOutputTokens?: number;
  images?: boolean;
  reasoning?: boolean;
  compat?: OpenAICompletionsCompat | OpenAIResponsesCompat;
  timeoutMs?: number;
  temperature?: number;
}
const protocols = {
  'openai-chat': {
    api: 'openai-completions',
    url: 'https://api.openai.com/v1',
    key: 'OPENAI_API_KEY',
    streams: openAICompletionsApi,
  },
  'openai-responses': {
    api: 'openai-responses',
    url: 'https://api.openai.com/v1',
    key: 'OPENAI_API_KEY',
    streams: openAIResponsesApi,
  },
  anthropic: {
    api: 'anthropic-messages',
    url: 'https://api.anthropic.com',
    key: 'ANTHROPIC_API_KEY',
    streams: anthropicMessagesApi,
  },
  gemini: {
    api: 'google-generative-ai',
    url: 'https://generativelanguage.googleapis.com/v1beta',
    key: 'GEMINI_API_KEY',
    streams: googleGenerativeAIApi,
  },
} as const;
const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const providerDataKey = '__cotoProvider';
type StoredAssistantMessage = AssistantMessage & { [providerDataKey]?: { fingerprint: string } };

export function createProvider(config: ProviderConfig): ModelProvider {
  const protocol = protocols[config.protocol];
  if (!protocol || !config.model?.trim())
    throw new AgentError('invalid_provider', 'A supported protocol and model are required', 422);
  const baseURL = config.baseURL ?? protocol.url;
  const url = new URL(baseURL);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new AgentError(
      'invalid_provider',
      'baseURL must be an HTTP(S) endpoint without credentials, query or fragment',
      422,
    );
  const id = config.id ?? `${config.protocol}:${url.host}`;
  const fingerprint = createHash('sha256').update(`${config.protocol}\0${url.href}`).digest('hex');
  const contextWindow = config.contextWindow ?? 32_768;
  const maxOutputTokens = config.maxOutputTokens ?? 4096;
  if (
    !Number.isSafeInteger(contextWindow) ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    contextWindow <= maxOutputTokens + 512
  )
    throw new AgentError('invalid_provider', 'Invalid model token limits', 422);
  const model: Model<Api> = {
    id: config.model,
    name: config.model,
    api: protocol.api,
    provider: id,
    baseUrl: baseURL,
    reasoning: config.reasoning ?? false,
    input: config.images ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: maxOutputTokens,
    compat: config.compat,
  };
  const models = createModels();
  models.setProvider(
    piProvider({
      id,
      models: [model],
      auth: { apiKey: { name: id, resolve: async () => ({ auth: {} }) } },
      api: protocol.streams(),
    }),
  );
  const toPi = (message: Message): PiMessage => {
    if (message.role === 'user') return { role: 'user', content: message.content, timestamp: 0 };
    if (message.role === 'tool')
      return {
        role: 'toolResult',
        content: message.content,
        toolName: message.toolName!,
        toolCallId: message.toolCallId!,
        isError: !!message.isError,
        timestamp: 0,
      };
    const stored = message.providerData?.value as StoredAssistantMessage | undefined;
    if (
      message.providerData?.providerId === id &&
      message.providerData.model === model.id &&
      stored?.[providerDataKey]?.fingerprint === fingerprint
    ) {
      const restored = structuredClone(stored);
      delete restored[providerDataKey];
      return restored;
    }
    return {
      role: 'assistant',
      content: [
        ...message.content.filter((p) => p.type === 'text'),
        ...(message.toolCalls ?? []).map((call) => ({ type: 'toolCall' as const, ...call })),
      ],
      api: model.api,
      provider: id,
      model: model.id,
      usage: zeroUsage,
      stopReason: message.toolCalls?.length ? 'toolUse' : 'stop',
      timestamp: 0,
    };
  };
  return {
    id,
    model: model.id,
    capabilities: { contextWindow, maxOutputTokens, tools: true, images: !!config.images },
    async *stream(request: ModelRequest, { signal }): AsyncGenerator<ModelEvent> {
      if (!config.images && request.messages.some((m) => m.content.some((p) => p.type === 'image')))
        throw new AgentError('unsupported_image', 'Configure images support for this model', 422);
      const envKey = config.apiKeyEnv ?? protocol.key;
      let key: string | undefined;
      if (config.auth !== 'none') {
        try {
          signal.throwIfAborted();
          key = config.apiKey ?? (await config.apiKeyResolver?.({ signal })) ?? process.env[envKey];
          signal.throwIfAborted();
        } catch (error) {
          if (signal.aborted) throw new AgentError('aborted', 'Operation aborted', 409);
          throw new AgentError('provider_auth_error', 'API key resolver failed', 422, false);
        }
      }
      if (config.auth !== 'none' && !key)
        throw new AgentError('missing_api_key', `Missing environment variable: ${envKey}`, 422);
      const headers: Record<string, string | null> = { ...config.headers };
      for (const [name, variable] of Object.entries(config.headerEnv ?? {})) {
        const value = process.env[variable];
        if (!value)
          throw new AgentError('missing_header', `Missing environment variable: ${variable}`, 422);
        headers[name] = value;
      }
      const secrets = [key, ...Object.values(headers)].filter(
        (value): value is string => !!value && value.length > 3,
      );
      const clean = (message: string) =>
        secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), message);
      const combined = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs ?? 120_000)]);
      const stream = models.stream(
        model,
        {
          systemPrompt: request.system,
          messages: request.messages.map(toPi),
          tools: request.tools.map((tool) => ({ ...tool, parameters: tool.parameters as TSchema })),
        },
        {
          apiKey: key ?? 'coto-keyless',
          headers,
          maxTokens: request.maxOutputTokens,
          signal: combined,
          temperature: config.temperature,
          timeoutMs: config.timeoutMs ?? 120_000,
          maxRetries: 0,
          transport: 'sse',
          cacheRetention: 'none',
          transformHeaders: (h) => {
            if (config.auth !== 'none') return h;
            const stripped = { ...h };
            const hasHeader = (name: string) =>
              Object.keys(stripped).some((candidate) => candidate.toLowerCase() === name);
            // OpenAI and Anthropic SDKs use null to suppress their generated auth header. The
            // Google SDK requires a non-empty API key, so an empty explicit header suppresses
            // its internal placeholder without sending that placeholder to the endpoint.
            if (config.protocol === 'anthropic' && !hasHeader('x-api-key'))
              stripped['x-api-key'] = null;
            else if (config.protocol === 'gemini' && !hasHeader('x-goog-api-key'))
              stripped['x-goog-api-key'] = '';
            else if (config.protocol.startsWith('openai-') && !hasHeader('authorization'))
              stripped.authorization = null;
            return stripped;
          },
        },
      );
      try {
        for await (const event of stream) {
          if (event.type === 'text_delta') yield { type: 'text_delta', text: event.delta };
          if (event.type === 'toolcall_delta') {
            const call = event.partial.content[event.contentIndex];
            if (call?.type === 'toolCall')
              yield { type: 'tool_delta', id: call.id, text: event.delta };
          }
          if (event.type === 'error')
            throw new AgentError(
              combined.aborted ? 'aborted' : 'provider_error',
              clean(event.error.errorMessage ?? 'Provider request failed'),
              502,
              !combined.aborted &&
                /429|50[0234]|timeout|ECONNRESET|fetch failed/i.test(
                  event.error.errorMessage ?? '',
                ),
            );
          if (event.type === 'done') {
            const output = event.message;
            const stored = structuredClone(output) as StoredAssistantMessage;
            stored[providerDataKey] = { fingerprint };
            yield {
              type: 'done',
              message: {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: output.content
                  .filter((p) => p.type === 'text')
                  .map((p) => ({ type: 'text', text: p.text })),
                toolCalls: output.content
                  .filter((p) => p.type === 'toolCall')
                  .map(({ id: callId, name, arguments: args }) => ({
                    id: callId,
                    name,
                    arguments: args,
                  })),
                providerData: { providerId: id, model: model.id, value: stored },
              },
              usage:
                output.usage.totalTokens > 0
                  ? {
                      input: output.usage.input + output.usage.cacheRead + output.usage.cacheWrite,
                      output: output.usage.output,
                    }
                  : undefined,
              stopReason:
                event.reason === 'toolUse'
                  ? 'tools'
                  : event.reason === 'length'
                    ? 'length'
                    : 'stop',
            };
          }
        }
      } catch (error) {
        if (error instanceof AgentError) throw error;
        throw new AgentError(
          'provider_error',
          clean(error instanceof Error ? error.message : String(error)),
          502,
        );
      }
    },
  };
}

/** Named profiles separate endpoint/authentication from per-model selection. */
export function providerFromCatalog(
  catalog: Record<
    string,
    Omit<ProviderConfig, 'model'> & { models: Record<string, Partial<ProviderConfig>> }
  >,
  providerId: string,
  modelId: string,
) {
  const provider = catalog[providerId];
  if (!provider || !Object.hasOwn(provider.models, modelId))
    throw new AgentError('unknown_model', 'Provider/model is not in the configured catalog', 422);
  const { models, ...defaults } = provider;
  return createProvider({ ...defaults, ...models[modelId], id: providerId, model: modelId });
}
