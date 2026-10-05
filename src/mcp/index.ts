import { AgentError } from '../core/errors.js';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ContentPart, JsonSchema, Tool, ToolEffect, ToolResult } from '../core/types.js';
import type { McpMessage, McpTransport } from './transport.js';
export { stdioMcpTransport, type McpTransport, type McpMessage } from './transport.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new AgentError('invalid_mcp_result', 'Invalid or unsupported MCP result', 502);
const protocolVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpToolPolicy {
  effect: ToolEffect;
  parallel?: boolean;
  /** Optional application contract for invocation/revision/job data. Host code, never server annotations. */
  arguments?: (args: ObjectValue, context: Parameters<Tool['execute']>[1]) => ObjectValue;
}
export interface McpMediaLimits {
  maxTextChars?: number;
  maxImages?: number;
  maxImageBytes?: number;
  maxTotalImageBytes?: number;
  /** Resource links are handles only; this adapter never fetches their URI. */
  allowResource?: (uri: string) => boolean;
}
export interface McpClientOptions {
  transport: McpTransport;
  clientInfo?: { name: string; version: string };
  protocolVersions?: string[];
  /** Required trusted-host allowlist. Omitted tools are never registered. */
  tools: Record<string, McpToolPolicy>;
  media?: McpMediaLimits;
  requestTimeoutMs?: number;
  maxTools?: number;
  maxListPages?: number;
  onToolsChanged?: (tools: Tool[]) => void;
}

/** Bounded conversion. Structured content is visible to the model, images remain image parts. */
export function mcpToolResult(value: unknown, limits: McpMediaLimits = {}): ToolResult {
  for (const limit of [limits.maxTextChars ?? 32_000, limits.maxImages ?? 4, limits.maxImageBytes ?? 1_048_576, limits.maxTotalImageBytes ?? 4_194_304])
    if (!Number.isSafeInteger(limit) || limit < 1) throw new AgentError('invalid_mcp_config', 'Invalid MCP media limits', 422);
  if (!object(value) || !Array.isArray(value.content) || value.content.length > 64 ||
      (value.isError !== undefined && typeof value.isError !== 'boolean')) throw invalid();
  const content: ContentPart[] = [];
  const resources: ObjectValue[] = [];
  let textChars = 0, imageBytes = 0, images = 0;
  const text = (text: string) => {
    textChars += text.length;
    if (textChars > (limits.maxTextChars ?? 32_000))
      throw new AgentError('mcp_text_limit', 'MCP text result exceeded limit; request a smaller result', 422);
    content.push({ type: 'text', text });
  };
  const image = (data: unknown, mimeType: unknown) => {
    if (typeof data !== 'string' || typeof mimeType !== 'string' ||
        !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) || !data.length) throw invalid();
    const bytes = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    images++; imageBytes += bytes;
    if (images > (limits.maxImages ?? 4) || bytes > (limits.maxImageBytes ?? 1_048_576) ||
        imageBytes > (limits.maxTotalImageBytes ?? 4_194_304))
      throw new AgentError('mcp_media_limit', 'MCP image result exceeded limit; request a thumbnail or fewer images', 422);
    content.push({ type: 'image', data, mimeType });
  };
  const resource = (part: ObjectValue) => {
    if (typeof part.uri !== 'string' || part.uri.length > 8192 || !limits.allowResource?.(part.uri))
      throw new AgentError('mcp_resource_denied', 'MCP resource is outside the host allowlist', 403);
    const handle = { uri: part.uri, ...(typeof part.mimeType === 'string' ? { mimeType: part.mimeType } : {}) };
    resources.push(handle);
    return handle;
  };
  for (const part of value.content) {
    if (!object(part)) throw invalid();
    if (part.type === 'text' && typeof part.text === 'string') text(part.text);
    else if (part.type === 'image') image(part.data, part.mimeType);
    else if (part.type === 'resource_link') text(JSON.stringify({ resource: resource(part) }));
    else if (part.type === 'resource' && object(part.resource)) {
      resource(part.resource);
      if (typeof part.resource.text === 'string') text(part.resource.text);
      else if (typeof part.resource.mimeType === 'string' && part.resource.mimeType.startsWith('image/'))
        image(part.resource.blob, part.resource.mimeType);
      else throw invalid();
    } else throw invalid();
  }
  if (value.structuredContent !== undefined) {
    if (!object(value.structuredContent)) throw invalid();
    text(JSON.stringify(value.structuredContent));
  }
  return {
    content, isError: value.isError as boolean | undefined,
    metadata: {
      ...(value.structuredContent !== undefined ? { structuredContent: value.structuredContent } : {}),
      ...(resources.length ? { resources } : {}),
    },
  };
}

/** Standard MCP client for tools; no sampling, elicitation, prompts or server instructions are trusted. */
export class McpClient {
  private state: 'new' | 'connecting' | 'ready' | 'closed' = 'new';
  private sequence = 0;
  private generation = 0;
  private dirty = false;
  private discovered: Tool[] = [];
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private progress = new Map<number, (value: ObjectValue) => Promise<void>>();
  private refresh?: Promise<Tool[]>;
  private closePromise?: Promise<void>;
  serverInfo?: ObjectValue;
  protocolVersion?: string;
  private listChanged = false;
  constructor(readonly options: McpClientOptions) {
    if (options.protocolVersions && (!options.protocolVersions.length || options.protocolVersions.some((version) => !version)))
      throw new AgentError('invalid_mcp_config', 'At least one supported protocol version is required', 422);
    for (const n of [options.requestTimeoutMs ?? 60_000, options.maxTools ?? 256, options.maxListPages ?? 32])
      if (!Number.isSafeInteger(n) || n < 1) throw new AgentError('invalid_mcp_config', 'Invalid MCP limits', 422);
    for (const policy of Object.values(options.tools))
      if (!['read', 'write', 'execute', 'network'].includes(policy.effect) || (policy.parallel && policy.effect !== 'read'))
        throw new AgentError('invalid_mcp_config', 'Only host-approved reads may run in parallel', 422);
    options.transport.onmessage = (message) => this.receive(message);
    options.transport.onclose = () => this.disconnect(new AgentError('mcp_disconnected', 'MCP connection closed', 409));
    options.transport.onerror = () => this.disconnect(new AgentError('mcp_disconnected', 'MCP transport failed', 409));
  }
  async connect(signal?: AbortSignal): Promise<Tool[]> {
    if (this.state !== 'new') throw new AgentError('mcp_state', 'MCP client is single-use', 409);
    this.state = 'connecting';
    try {
      signal?.throwIfAborted();
      await this.options.transport.start();
      const versions = this.options.protocolVersions ?? protocolVersions;
      const result = await this.request('initialize', {
        protocolVersion: versions[0], capabilities: {},
        clientInfo: this.options.clientInfo ?? { name: 'coto', version: '0.1.0' },
      }, signal);
      if (!object(result) || typeof result.protocolVersion !== 'string' ||
          !versions.includes(result.protocolVersion) || !object(result.capabilities) ||
          !object(result.capabilities.tools) || !object(result.serverInfo) ||
          typeof result.serverInfo.name !== 'string' || typeof result.serverInfo.version !== 'string')
        throw new AgentError('mcp_incompatible', 'MCP protocol version or tools capability is incompatible', 409);
      this.protocolVersion = result.protocolVersion;
      this.serverInfo = result.serverInfo;
      this.listChanged = result.capabilities.tools.listChanged === true;
      this.options.transport.setProtocolVersion?.(result.protocolVersion);
      await this.options.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      if (this.isClosed()) throw new AgentError('mcp_disconnected', 'MCP connection closed during initialization', 409);
      this.state = 'ready';
      return await this.refreshTools(signal);
    } catch (error) { await this.close(); throw error; }
  }
  tools(): Tool[] {
    if (this.state !== 'ready' || this.dirty) throw new AgentError('mcp_tools_stale', 'Refresh MCP tools before use', 409);
    return [...this.discovered];
  }
  refreshTools(signal?: AbortSignal): Promise<Tool[]> {
    if (this.state !== 'ready') return Promise.reject(new AgentError('mcp_disconnected', 'MCP client is not connected', 409));
    if (this.refresh) return this.refresh;
    this.dirty = true;
    const generation = ++this.generation;
    this.refresh = (async () => {
      const tools: Tool[] = [], seen = new Set<string>(), cursors = new Set<string>();
      const draft7 = new Ajv({ strict: false, allErrors: true });
      const draft2020 = new Ajv2020({ strict: false, allErrors: true });
      let cursor: string | undefined;
      for (let page = 0; page < (this.options.maxListPages ?? 32); page++) {
        const result = await this.request('tools/list', cursor ? { cursor } : {}, signal);
        if (!object(result) || !Array.isArray(result.tools)) throw invalid();
        for (const spec of result.tools) {
          if (!object(spec) || typeof spec.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(spec.name) ||
              seen.has(spec.name) || !object(spec.inputSchema) || spec.inputSchema.type !== 'object' ||
              (spec.description !== undefined && typeof spec.description !== 'string')) throw invalid();
          seen.add(spec.name);
          if (seen.size > (this.options.maxTools ?? 256)) throw new AgentError('mcp_tools_limit', 'MCP tool list exceeded limit', 422);
          if (!Object.hasOwn(this.options.tools, spec.name)) continue;
          const name = spec.name, policy = { ...this.options.tools[name] };
          const schema = structuredClone(spec.inputSchema) as JsonSchema;
          const validator = (schema.$schema === 'http://json-schema.org/draft-07/schema#' ? draft7 : draft2020).compile(schema);
          if (spec.outputSchema !== undefined && !object(spec.outputSchema)) throw invalid();
          const outputSchema = spec.outputSchema as JsonSchema | undefined;
          const outputValidator = outputSchema && (outputSchema.$schema === 'http://json-schema.org/draft-07/schema#' ? draft7 : draft2020).compile(outputSchema);
          tools.push({
            name, description: spec.description as string ?? name,
            // MCP schemas without $schema default to 2020-12; preserve that dialect for COTO validation.
            parameters: { $schema: 'https://json-schema.org/draft/2020-12/schema', ...schema },
            effect: policy.effect, parallel: policy.effect === 'read' && !!policy.parallel, cancellable: policy.effect === 'read',
            execute: async (args, context) => {
              if (this.state !== 'ready') throw new AgentError('mcp_disconnected', 'MCP client is not connected', 409);
              if (generation !== this.generation || this.dirty) throw new AgentError('mcp_tools_stale', 'MCP tool list changed; refresh session tools', 409);
              context.signal.throwIfAborted();
              if (!validator(args)) throw new AgentError('invalid_arguments', 'MCP tool arguments do not match the advertised schema', 422);
              const params = { name, arguments: policy.arguments ? policy.arguments(args, context) : args };
              if (!validator(params.arguments))
                throw new AgentError('invalid_mcp_arguments', 'Host argument mapping does not match the advertised MCP schema', 422);
              try {
                const result = await this.request('tools/call', params, context.signal, context.progress);
                if (outputValidator && (!object(result) || (result.isError !== true && !outputValidator(result.structuredContent)))) throw invalid();
                return mcpToolResult(result, this.options.media);
              } catch (error) {
                if (policy.effect !== 'read')
                  throw new AgentError('outcome_unknown', `MCP invocation ${context.invocationId} requires business reconciliation before retry`, 409);
                throw error;
              }
            },
          });
        }
        if (result.nextCursor === undefined) {
          if (generation !== this.generation) throw new AgentError('mcp_tools_stale', 'Tool list changed during discovery; refresh again', 409);
          this.discovered = tools; this.dirty = false; return [...tools];
        }
        if (typeof result.nextCursor !== 'string' || !result.nextCursor || cursors.has(result.nextCursor)) throw invalid();
        cursor = result.nextCursor; cursors.add(cursor);
      }
      throw new AgentError('mcp_tools_limit', 'MCP pagination exceeded limit', 422);
    })().finally(() => { this.refresh = undefined; });
    return this.refresh;
  }
  close(): Promise<void> {
    if (!this.closePromise) {
      this.disconnect(new AgentError('mcp_disconnected', 'MCP client closed', 409));
      this.closePromise = this.options.transport.close();
    }
    return this.closePromise;
  }
  private disconnect(error: Error) {
    this.state = 'closed'; this.dirty = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  private isClosed() { return this.state === 'closed'; }
  private receive(message: McpMessage) {
    if ('method' in message) {
      if ('id' in message) {
        // Only ping is supported; unsupported server requests never become model calls.
        void this.options.transport.send(message.method === 'ping'
          ? { jsonrpc: '2.0', id: message.id, result: {} }
          : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported' } }).catch(() => undefined);
      } else if (message.method === 'notifications/progress' && object(message.params)) {
        const params = message.params;
        const progress = typeof params.progressToken === 'number' ? this.progress.get(params.progressToken) : undefined;
        if (progress && typeof params.progress === 'number' && Number.isFinite(params.progress) && params.progress >= 0)
          void progress({ progress: params.progress,
            ...(typeof params.total === 'number' && Number.isFinite(params.total) && params.total >= 0 ? { total: params.total } : {}),
            ...(typeof params.message === 'string' ? { message: params.message.slice(0, 4096) } : {}),
          }).catch(() => undefined);
      } else if (message.method === 'notifications/tools/list_changed' && this.state === 'ready' && this.listChanged) {
        this.dirty = true; this.generation++;
        void this.refreshTools().then((tools) => this.options.onToolsChanged?.(tools)).catch(() => { this.dirty = true; });
      }
      return;
    }
    const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (!pending) return; // Includes responses arriving after cancellation.
    if ('error' in message) pending.reject(new AgentError('mcp_protocol_error', `MCP request failed (${message.error.code})`, 502));
    else if ('result' in message) pending.resolve(message.result);
    else pending.reject(invalid());
  }
  private request(method: string, params: ObjectValue, signal?: AbortSignal, progress?: (value: ObjectValue) => Promise<void>): Promise<unknown> {
    if (this.state === 'closed') return Promise.reject(new AgentError('mcp_disconnected', 'MCP client is disconnected', 409));
    if (signal?.aborted) return Promise.reject(new AgentError('aborted', 'MCP request aborted before dispatch', 409));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      let sent = false;
      const finish = (error?: Error, value?: unknown) => {
        if (!this.pending.delete(id)) return;
        this.progress.delete(id);
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const cancel = (code: string) => {
        if (sent && method !== 'initialize')
          void this.options.transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: code } }).catch(() => undefined);
        finish(new AgentError(code, 'MCP request stopped; cancellation does not confirm business rollback', 409));
      };
      const abort = () => cancel('aborted');
      const timer = setTimeout(() => cancel('mcp_timeout'), this.options.requestTimeoutMs ?? 60_000);
      this.pending.set(id, { resolve: (value) => finish(undefined, value), reject: (error) => finish(error) });
      if (progress) { this.progress.set(id, progress); params = { ...params, _meta: { progressToken: id } }; }
      signal?.addEventListener('abort', abort, { once: true });
      // Mark dispatch before send: a transport can enqueue the request before its promise settles.
      sent = true;
      void this.options.transport.send({ jsonrpc: '2.0', id, method, params }).catch(() => finish(new AgentError('mcp_disconnected', 'MCP request could not be delivered', 409)));
    });
  }
}
