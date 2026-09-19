import { access, lstat, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { AgentOptions } from '../index.js';
import type { ProviderConfig } from '../providers/index.js';
import type { ServerOptions } from '../server/index.js';

const protocols = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const;
const policies = ['read-only', 'ask', 'allow-all'] as const;
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

type JsonObject = Record<string, unknown>;

export interface ProjectConfigDiagnostics {
  ok: boolean;
  config: { path: string; exists: boolean };
  workspace: { path: string; exists: boolean; readable: boolean; writable: boolean };
  credentials: Array<{
    environmentVariable: string;
    kind: 'api-key' | 'header';
    header?: string;
    present: boolean;
    source: 'environment' | '.env.coto' | 'missing';
  }>;
  errors: string[];
  warnings: string[];
}

export interface ResolvedProjectConfig {
  workspace: string;
  configPath: string;
  envPath: string;
  agentOptions: AgentOptions;
  serverOptions: ServerOptions;
  diagnostics: ProjectConfigDiagnostics;
}

export interface LoadProjectConfigOptions {
  workspace?: string;
  configPath?: string;
  env?: Record<string, string | undefined>;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be a JSON object`);
  return value as JsonObject;
}

function ownKeys(value: JsonObject, allowed: readonly string[], label: string) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`${label} contains unknown field: ${key}`);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error(`${label} must be a non-negative integer`);
  return Number(value);
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const input = object(value, label);
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(input)) {
    if (typeof item !== 'string') throw new Error(`${label}.${key} must be a string`);
    output[key] = item;
  }
  return output;
}

function environmentName(value: unknown, label: string): string | undefined {
  const name = optionalString(value, label);
  if (name && !envName.test(name))
    throw new Error(`${label} is not a valid environment variable name`);
  return name;
}

function resolveFrom(base: string, value: string) {
  return resolve(isAbsolute(value) ? value : resolve(base, value));
}

async function regularFile(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`${path} must be a regular file`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function parseProvider(value: unknown, environment: Record<string, string | undefined>) {
  const provider = object(value, 'provider');
  ownKeys(
    provider,
    [
      'name',
      'id',
      'protocol',
      'model',
      'baseURL',
      'apiKeyEnv',
      'auth',
      'headers',
      'headerEnv',
      'compat',
      'contextWindow',
      'maxOutputTokens',
      'images',
      'reasoning',
      'timeoutMs',
      'temperature',
    ],
    'provider',
  );
  optionalString(provider.name, 'provider.name');
  const protocol = optionalString(provider.protocol, 'provider.protocol');
  if (!protocols.includes(protocol as (typeof protocols)[number]))
    throw new Error(`provider.protocol must be one of: ${protocols.join(', ')}`);
  const model = optionalString(provider.model, 'provider.model');
  if (!model) throw new Error('provider.model must be a non-empty string');
  const baseURL = optionalString(provider.baseURL, 'provider.baseURL');
  if (baseURL) {
    let url: URL;
    try {
      url = new URL(baseURL);
    } catch {
      throw new Error('provider.baseURL must be a valid URL');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        'provider.baseURL must be an HTTP(S) URL without credentials, query or fragment',
      );
  }
  const auth = provider.auth === undefined ? 'api-key' : provider.auth;
  if (auth !== 'api-key' && auth !== 'none')
    throw new Error('provider.auth must be api-key or none');
  const apiKeyEnv =
    environmentName(provider.apiKeyEnv, 'provider.apiKeyEnv') ??
    defaultApiKeyEnvironment(protocol as ProviderConfig['protocol']);
  const configuredHeaders =
    provider.headers === undefined ? {} : stringRecord(provider.headers, 'provider.headers');
  for (const name of Object.keys(configuredHeaders)) {
    if (!headerName.test(name))
      throw new Error(`provider.headers contains invalid header name: ${name}`);
    if (
      ['authorization', 'proxy-authorization', 'x-api-key', 'x-goog-api-key'].includes(
        name.toLowerCase(),
      )
    )
      throw new Error(`provider.headers.${name} must use provider.headerEnv instead`);
  }
  const headerEnvInput =
    provider.headerEnv === undefined ? {} : object(provider.headerEnv, 'provider.headerEnv');
  const headerEnv: Record<string, string> = {};
  const headers: Record<string, string> = { ...configuredHeaders };
  for (const [header, rawVariable] of Object.entries(headerEnvInput)) {
    if (!headerName.test(header))
      throw new Error(`provider.headerEnv contains invalid header name: ${header}`);
    const variable = environmentName(rawVariable, `provider.headerEnv.${header}`)!;
    headerEnv[header] = variable;
    if (environment[variable]) headers[header] = environment[variable]!;
  }
  const temperature = provider.temperature;
  if (
    temperature !== undefined &&
    (typeof temperature !== 'number' || !Number.isFinite(temperature))
  )
    throw new Error('provider.temperature must be a finite number');

  let compat: ProviderConfig['compat'];
  if (provider.compat !== undefined) {
    if (protocol !== 'openai-chat' && protocol !== 'openai-responses')
      throw new Error('provider.compat is only supported for openai-chat and openai-responses');
    const value = object(provider.compat, 'provider.compat');
    const completionFields = [
      'supportsStore',
      'supportsDeveloperRole',
      'supportsReasoningEffort',
      'supportsUsageInStreaming',
      'supportsFinishReason',
      'supportsStrictMode',
      'supportsOpenAIGrammarTools',
      'sendSessionAffinityHeaders',
      'sessionAffinityFormat',
      'maxTokensField',
      'requiresToolResultName',
      'requiresAssistantAfterToolResult',
      'requiresThinkingAsText',
      'requiresReasoningContentOnAssistantMessages',
      'thinkingFormat',
      'chatTemplateKwargs',
      'chatTemplateArgs',
      'thinkingTokenBudgetField',
      'supportsThinkingTokenBudget',
      'cacheControlFormat',
      'openRouterRouting',
      'vercelGatewayRouting',
      'zaiToolStream',
      'deferredToolsMode',
      'supportsLongCacheRetention',
      'vllmPriority',
    ];
    const responseFields = [
      'supportsDeveloperRole',
      'sessionAffinityFormat',
      'supportsLongCacheRetention',
      'supportsStrictMode',
      'supportsOpenAIGrammarTools',
      'supportsAdditionalTools',
      'supportsToolSearch',
      'supportsExplicitPromptCacheMode',
      'supportsMaxOutputTokens',
    ];
    ownKeys(
      value,
      protocol === 'openai-chat' ? completionFields : responseFields,
      'provider.compat',
    );
    const booleans = new Set([
      'supportsStore',
      'supportsDeveloperRole',
      'supportsReasoningEffort',
      'supportsUsageInStreaming',
      'supportsFinishReason',
      'supportsStrictMode',
      'supportsOpenAIGrammarTools',
      'sendSessionAffinityHeaders',
      'requiresToolResultName',
      'requiresAssistantAfterToolResult',
      'requiresThinkingAsText',
      'requiresReasoningContentOnAssistantMessages',
      'supportsThinkingTokenBudget',
      'supportsLongCacheRetention',
      'zaiToolStream',
      'supportsAdditionalTools',
      'supportsToolSearch',
      'supportsExplicitPromptCacheMode',
      'supportsMaxOutputTokens',
    ]);
    const enums: Record<string, readonly string[]> = {
      sessionAffinityFormat: ['openai', 'openai-nosession', 'openrouter'],
      maxTokensField: ['max_completion_tokens', 'max_tokens'],
      thinkingFormat: [
        'openai',
        'openrouter',
        'deepseek',
        'together',
        'baseten',
        'zai',
        'qwen',
        'chat-template',
        'qwen-chat-template',
        'string-thinking',
        'ant-ling',
      ],
      thinkingTokenBudgetField: [
        'thinking_token_budget',
        'thinking_budget',
        'thinking_budget_tokens',
      ],
      cacheControlFormat: ['anthropic'],
      deferredToolsMode: ['kimi'],
    };
    for (const [key, item] of Object.entries(value)) {
      if (booleans.has(key) && typeof item !== 'boolean')
        throw new Error(`provider.compat.${key} must be a boolean`);
      if (enums[key] && (typeof item !== 'string' || !enums[key].includes(item)))
        throw new Error(`provider.compat.${key} has an unsupported value`);
      if (
        [
          'chatTemplateKwargs',
          'chatTemplateArgs',
          'openRouterRouting',
          'vercelGatewayRouting',
        ].includes(key) &&
        (!item || typeof item !== 'object' || Array.isArray(item))
      )
        throw new Error(`provider.compat.${key} must be a JSON object`);
      if (key === 'vllmPriority' && (typeof item !== 'number' || !Number.isFinite(item)))
        throw new Error('provider.compat.vllmPriority must be a finite number');
    }
    compat = structuredClone(value) as ProviderConfig['compat'];
  }

  const resolved: ProviderConfig = {
    id: optionalString(provider.id, 'provider.id'),
    protocol: protocol as ProviderConfig['protocol'],
    model,
    baseURL,
    apiKeyEnv,
    auth,
    contextWindow: optionalPositiveInteger(provider.contextWindow, 'provider.contextWindow'),
    maxOutputTokens: optionalPositiveInteger(provider.maxOutputTokens, 'provider.maxOutputTokens'),
    images: optionalBoolean(provider.images, 'provider.images'),
    reasoning: optionalBoolean(provider.reasoning, 'provider.reasoning'),
    timeoutMs: optionalPositiveInteger(provider.timeoutMs, 'provider.timeoutMs'),
    temperature: temperature as number | undefined,
    compat,
    ...(Object.keys(headers).length ? { headers } : {}),
    apiKeyResolver: () => environment[apiKeyEnv],
  };
  const contextWindow = resolved.contextWindow ?? 32_768;
  const maxOutputTokens = resolved.maxOutputTokens ?? 4096;
  if (contextWindow <= maxOutputTokens + 512)
    throw new Error('provider.contextWindow must exceed provider.maxOutputTokens by more than 512');
  return { resolved, apiKeyEnv, headerEnv };
}

async function workspaceStatus(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) return { exists: true, readable: false, writable: false };
    const [readable, writable] = await Promise.all([
      access(path, constants.R_OK).then(
        () => true,
        () => false,
      ),
      access(path, constants.W_OK).then(
        () => true,
        () => false,
      ),
    ]);
    return { exists: true, readable, writable };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { exists: false, readable: false, writable: false };
    throw error;
  }
}

export async function loadProjectConfig(
  options: LoadProjectConfigOptions = {},
): Promise<ResolvedProjectConfig> {
  const explicitWorkspace = options.workspace ? resolve(options.workspace) : undefined;
  const configPath = options.configPath
    ? resolveFrom(explicitWorkspace ?? process.cwd(), options.configPath)
    : resolve(explicitWorkspace ?? process.cwd(), 'coto.config.json');
  const configExists = await regularFile(configPath);
  if (!configExists)
    throw new Error(`COTO config not found: ${configPath}. Run "coto init" first.`);
  const workspace = explicitWorkspace ?? dirname(configPath);
  const envPath = resolve(workspace, '.env.coto');
  const baseEnvironment = options.env ?? process.env;
  const environment: Record<string, string | undefined> = { ...baseEnvironment };
  const envSources = new Set<string>();
  if (await regularFile(envPath)) {
    let local: Record<string, string>;
    try {
      local = Object.fromEntries(
        Object.entries(parseEnv(await readFile(envPath, 'utf8'))).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
    } catch (error) {
      throw new Error(
        `Could not parse ${envPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const [name, value] of Object.entries(local)) {
      if (environment[name] === undefined) {
        environment[name] = value;
        envSources.add(name);
      }
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Could not parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const config = object(raw, 'config');
  ownKeys(config, ['provider', 'agent', 'server'], 'config');
  const { resolved: provider, apiKeyEnv, headerEnv } = parseProvider(config.provider, environment);

  const agent = config.agent === undefined ? {} : object(config.agent, 'agent');
  ownKeys(
    agent,
    [
      'tools',
      'policy',
      'skills',
      'projectInstructions',
      'context',
      'maxSteps',
      'maxTurnMs',
      'toolTimeoutMs',
      'maxOutputChars',
      'maxQueue',
      'maxRetries',
      'maxConcurrentTools',
    ],
    'agent',
  );
  const tools = agent.tools === undefined ? 'local-basic' : agent.tools;
  if (tools !== 'local-basic' && tools !== 'none')
    throw new Error('agent.tools must be local-basic or none');
  const policy = agent.policy === undefined ? 'read-only' : agent.policy;
  if (!policies.includes(policy as (typeof policies)[number]))
    throw new Error(`agent.policy must be one of: ${policies.join(', ')}`);
  let skills: AgentOptions['skills'];
  if (agent.skills !== undefined) {
    const value = object(agent.skills, 'agent.skills');
    ownKeys(value, ['roots'], 'agent.skills');
    if (
      !Array.isArray(value.roots) ||
      value.roots.some((root) => typeof root !== 'string' || !root)
    )
      throw new Error('agent.skills.roots must be an array of non-empty strings');
    skills = { roots: [...value.roots] as string[] };
  }
  let context: AgentOptions['context'];
  if (agent.context !== undefined) {
    const value = object(agent.context, 'agent.context');
    ownKeys(value, ['system', 'safetyTokens', 'keepRecentMessages'], 'agent.context');
    context = {
      system: optionalString(value.system, 'agent.context.system'),
      safetyTokens: optionalNonNegativeInteger(value.safetyTokens, 'agent.context.safetyTokens'),
      keepRecentMessages: optionalNonNegativeInteger(
        value.keepRecentMessages,
        'agent.context.keepRecentMessages',
      ),
    };
  }
  const agentOptions: AgentOptions = {
    workspace,
    provider,
    tools: tools === 'none' ? [] : 'local-basic',
    policy: policy as (typeof policies)[number],
    skills,
    context,
    projectInstructions: optionalBoolean(agent.projectInstructions, 'agent.projectInstructions'),
    maxSteps: optionalPositiveInteger(agent.maxSteps, 'agent.maxSteps'),
    maxTurnMs: optionalPositiveInteger(agent.maxTurnMs, 'agent.maxTurnMs'),
    toolTimeoutMs: optionalPositiveInteger(agent.toolTimeoutMs, 'agent.toolTimeoutMs'),
    maxOutputChars: optionalPositiveInteger(agent.maxOutputChars, 'agent.maxOutputChars'),
    maxQueue: optionalPositiveInteger(agent.maxQueue, 'agent.maxQueue'),
    maxRetries: optionalNonNegativeInteger(agent.maxRetries, 'agent.maxRetries'),
    maxConcurrentTools: optionalPositiveInteger(
      agent.maxConcurrentTools,
      'agent.maxConcurrentTools',
    ),
  };

  const server = config.server === undefined ? {} : object(config.server, 'server');
  ownKeys(server, ['host', 'port', 'maxBodyBytes', 'heartbeatMs'], 'server');
  const serverOptions: ServerOptions = {
    host: optionalString(server.host, 'server.host') ?? '127.0.0.1',
    port: server.port === undefined ? 8787 : optionalNonNegativeInteger(server.port, 'server.port'),
    maxBodyBytes: optionalPositiveInteger(server.maxBodyBytes, 'server.maxBodyBytes'),
    heartbeatMs: optionalPositiveInteger(server.heartbeatMs, 'server.heartbeatMs'),
  };
  if (serverOptions.port! > 65_535) throw new Error('server.port must be between 0 and 65535');

  const credentials: ProjectConfigDiagnostics['credentials'] = [];
  if (provider.auth !== 'none') {
    const variable = apiKeyEnv ?? defaultApiKeyEnvironment(provider.protocol);
    credentials.push({
      environmentVariable: variable,
      kind: 'api-key',
      present: !!environment[variable],
      source: environment[variable]
        ? envSources.has(variable)
          ? '.env.coto'
          : 'environment'
        : 'missing',
    });
  }
  for (const [header, variable] of Object.entries(headerEnv))
    credentials.push({
      environmentVariable: variable,
      kind: 'header',
      header,
      present: !!environment[variable],
      source: environment[variable]
        ? envSources.has(variable)
          ? '.env.coto'
          : 'environment'
        : 'missing',
    });
  const status = await workspaceStatus(workspace);
  const errors = [
    ...(!status.exists ? ['Workspace does not exist'] : []),
    ...(status.exists && !status.readable ? ['Workspace is not readable'] : []),
    ...(credentials.some((item) => !item.present) ? ['Required credentials are missing'] : []),
  ];
  const warnings = status.exists && !status.writable ? ['Workspace is not writable'] : [];
  return {
    workspace,
    configPath,
    envPath,
    agentOptions,
    serverOptions,
    diagnostics: {
      ok: errors.length === 0,
      config: { path: configPath, exists: true },
      workspace: { path: workspace, ...status },
      credentials,
      errors,
      warnings,
    },
  };
}

function defaultApiKeyEnvironment(protocol: ProviderConfig['protocol']) {
  if (protocol === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (protocol === 'gemini') return 'GEMINI_API_KEY';
  return 'OPENAI_API_KEY';
}
