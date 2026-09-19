#!/usr/bin/env node
import { appendFile, lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { createAgent, type AgentOptions } from './index.js';
import {
  loadProjectConfig,
  type LoadProjectConfigOptions,
  type ResolvedProjectConfig,
} from './config/index.js';
import type { AgentEvent, Session } from './core/index.js';
import type { ProviderConfig } from './providers/index.js';
import { createAgentServer, type ServerOptions } from './server/index.js';
import { localTools } from './tools/index.js';

type ParsedArguments = { options: Record<string, string | boolean>; positionals: string[] };
type PolicyName = 'read-only' | 'ask' | 'allow-all';

const help = `COTO Agent

Usage:
  coto init [--provider deepseek|openai|anthropic|gemini|custom] [--model MODEL]
            [--base-url URL] [--protocol PROTOCOL] [--workspace PATH]
  coto doctor [--workspace PATH] [--config PATH] [--json]
  coto run PROMPT [--session ID] [--policy read-only|ask|allow-all]
           [--workspace PATH] [--config PATH] [--json]
  coto sessions [--workspace PATH] [--config PATH] [--json]
  coto serve [--workspace PATH] [--config PATH]
`;

const providerDefaults: Record<
  string,
  { protocol: ProviderConfig['protocol']; model: string; baseURL: string; apiKeyEnv: string }
> = {
  deepseek: {
    protocol: 'openai-chat',
    model: 'deepseek-flash',
    baseURL: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
  openai: {
    protocol: 'openai-responses',
    model: 'gpt-4o-mini',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  anthropic: {
    protocol: 'anthropic',
    model: 'claude-sonnet-4-5',
    baseURL: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
  gemini: {
    protocol: 'gemini',
    model: 'gemini-2.5-flash',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: 'GEMINI_API_KEY',
  },
};
const supportedProviders = [...Object.keys(providerDefaults), 'custom'];
const supportedProtocols: ProviderConfig['protocol'][] = [
  'openai-chat',
  'openai-responses',
  'anthropic',
  'gemini',
];

function parseArguments(
  input: string[],
  schema: Record<string, 'string' | 'boolean'>,
): ParsedArguments {
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let positionalOnly = false;
  for (let index = 0; index < input.length; index++) {
    const argument = input[index];
    if (argument === '--') {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && argument.startsWith('--')) {
      const equal = argument.indexOf('=');
      const name = argument.slice(2, equal < 0 ? undefined : equal);
      const kind = schema[name];
      if (!kind) throw new Error(`Unknown option: --${name}`);
      if (Object.hasOwn(options, name))
        throw new Error(`Option may only be specified once: --${name}`);
      if (kind === 'boolean') {
        if (equal >= 0) throw new Error(`Option does not take a value: --${name}`);
        options[name] = true;
      } else {
        const value = equal >= 0 ? argument.slice(equal + 1) : input[++index];
        if (value === undefined || !value || value.startsWith('--'))
          throw new Error(`Option requires a value: --${name}`);
        options[name] = value;
      }
      continue;
    }
    positionals.push(argument);
  }
  return { options, positionals };
}

function stringOption(options: ParsedArguments['options'], name: string) {
  const value = options[name];
  return typeof value === 'string' ? value : undefined;
}

async function pathKind(path: string) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing to write through symbolic link: ${path}`);
    return info.isFile() ? 'file' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function createFile(path: string, content: string) {
  const kind = await pathKind(path);
  if (kind === 'file') return 'kept';
  if (kind !== 'missing') throw new Error(`Refusing to replace non-file path: ${path}`);
  const handle = await open(path, 'wx', 0o644);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return 'created';
}

async function mergeGitignore(path: string, entries: string[]) {
  const kind = await pathKind(path);
  if (kind === 'other') throw new Error(`Refusing to replace non-file path: ${path}`);
  if (kind === 'missing') {
    await createFile(path, entries.join('\n') + '\n');
    return 'created';
  }
  const content = await readFile(path, 'utf8');
  const lines = new Set(content.split(/\r?\n/).map((line) => line.trim()));
  const missing = entries.filter((entry) => !lines.has(entry));
  if (!missing.length) return 'kept';
  const prefix = content.length && !content.endsWith('\n') ? '\n' : '';
  await appendFile(path, `${prefix}${missing.join('\n')}\n`, 'utf8');
  return 'updated';
}

function initProvider(options: ParsedArguments['options']) {
  const name = stringOption(options, 'provider') ?? 'deepseek';
  if (!supportedProviders.includes(name))
    throw new Error(`--provider must be one of: ${supportedProviders.join(', ')}`);
  const requestedProtocol = stringOption(options, 'protocol');
  if (
    requestedProtocol &&
    !supportedProtocols.includes(requestedProtocol as ProviderConfig['protocol'])
  )
    throw new Error(`--protocol must be one of: ${supportedProtocols.join(', ')}`);
  const defaults = name === 'custom' ? undefined : providerDefaults[name];
  const protocol = (requestedProtocol ?? defaults?.protocol) as
    | ProviderConfig['protocol']
    | undefined;
  const model = stringOption(options, 'model') ?? defaults?.model;
  const baseURL = stringOption(options, 'base-url') ?? defaults?.baseURL;
  if (!protocol) throw new Error('--protocol is required for --provider custom');
  if (!model) throw new Error('--model is required for --provider custom');
  if (!baseURL) throw new Error('--base-url is required for --provider custom');
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error('--base-url must be a valid URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('--base-url must be an HTTP(S) URL without credentials, query or fragment');
  return {
    name,
    protocol,
    model,
    baseURL,
    apiKeyEnv: defaults?.apiKeyEnv ?? 'COTO_API_KEY',
  };
}

async function initCommand(args: string[]) {
  const parsed = parseArguments(args, {
    provider: 'string',
    model: 'string',
    'base-url': 'string',
    protocol: 'string',
    workspace: 'string',
  });
  if (parsed.positionals.length) throw new Error(`Unexpected argument: ${parsed.positionals[0]}`);
  const workspace = resolve(stringOption(parsed.options, 'workspace') ?? process.cwd());
  await mkdir(workspace, { recursive: true });
  const provider = initProvider(parsed.options);
  const config = `${JSON.stringify(
    {
      provider,
      agent: {
        tools: 'local-basic',
        skills: { roots: ['.agents/skills', '.codex/skills'] },
        policy: 'allow-all',
        projectInstructions: true,
      },
      server: { host: '127.0.0.1', port: 8787 },
    },
    null,
    2,
  )}\n`;
  const envExample = `# Copy this file to .env.coto and provide your key.\n${provider.apiKeyEnv}=\n`;
  const agentModule = `import { createAgent } from '@coto/agent';
import { loadProjectConfig } from '@coto/agent/config';

export async function createProjectAgent(options = {}) {
  const config = await loadProjectConfig(options);
  return createAgent(config.agentOptions);
}
`;
  const results = await Promise.all([
    createFile(resolve(workspace, 'coto.config.json'), config),
    createFile(resolve(workspace, '.env.coto.example'), envExample),
    createFile(resolve(workspace, 'coto.agent.mjs'), agentModule),
    mergeGitignore(resolve(workspace, '.gitignore'), ['.coto/', '.env.coto']),
  ]);
  const names = ['coto.config.json', '.env.coto.example', 'coto.agent.mjs', '.gitignore'];
  for (let index = 0; index < names.length; index++)
    console.log(`${results[index].padEnd(7)} ${names[index]}`);
  console.log(`COTO project ready in ${workspace}`);
}

function loadOptions(parsed: ParsedArguments): LoadProjectConfigOptions {
  return {
    workspace: stringOption(parsed.options, 'workspace'),
    configPath: stringOption(parsed.options, 'config'),
  };
}

async function doctorCommand(args: string[]) {
  const parsed = parseArguments(args, { workspace: 'string', config: 'string', json: 'boolean' });
  if (parsed.positionals.length) throw new Error(`Unexpected argument: ${parsed.positionals[0]}`);
  let config: ResolvedProjectConfig;
  try {
    config = await loadProjectConfig(loadOptions(parsed));
  } catch (error) {
    const result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    if (parsed.options.json) console.log(JSON.stringify(result));
    else console.log(`FAIL config: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  if (parsed.options.json) {
    console.log(JSON.stringify(config.diagnostics));
  } else {
    const diagnostics = config.diagnostics;
    console.log(`OK   config: ${diagnostics.config.path}`);
    console.log(
      `${diagnostics.workspace.exists && diagnostics.workspace.readable ? 'OK  ' : 'FAIL'} workspace: ${diagnostics.workspace.path}`,
    );
    for (const credential of diagnostics.credentials)
      console.log(
        `${credential.present ? 'OK  ' : 'FAIL'} ${credential.kind}: ${credential.environmentVariable} (${credential.source})`,
      );
    for (const warning of diagnostics.warnings) console.log(`WARN ${warning}`);
    for (const error of diagnostics.errors) console.log(`FAIL ${error}`);
  }
  if (!config.diagnostics.ok) process.exitCode = 1;
}

function eventOutput(event: AgentEvent, json: boolean) {
  if (json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  if (event.type === 'text.delta') process.stdout.write(String(event.data.text ?? ''));
  if (event.type === 'tool.started') {
    const call = event.data.call as { name?: unknown } | undefined;
    process.stderr.write(`[tool] ${String(call?.name ?? event.data.invocationId ?? 'started')}\n`);
  }
  if (event.type === 'tool.progress') process.stderr.write('[tool] progress\n');
  if (event.type === 'tool.completed') process.stderr.write('[tool] completed\n');
  if (event.type === 'tool.failed') process.stderr.write('[tool] failed\n');
}

type ApprovalIO = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  interactive?: boolean;
};

export async function askApproval(
  event: AgentEvent,
  session: Pick<Session, 'approve' | 'cancel' | 'subscribe'>,
  io: ApprovalIO = { input: process.stdin, output: process.stderr },
) {
  const approvalId = String(event.data.approvalId);
  const tool = String(event.data.tool ?? 'tool');
  const interactive =
    io.interactive ??
    !!((io.input as NodeJS.ReadStream).isTTY && (io.output as NodeJS.WriteStream).isTTY);
  if (!interactive) {
    io.output.write(`[approval] denied ${tool}: stdin is not interactive\n`);
    await session.approve(approvalId, false);
    return;
  }
  const readline = createInterface({ input: io.input, output: io.output, terminal: true });
  const controller = new AbortController();
  const off = session.subscribe((next) => {
    if (
      next.type === 'session.closed' ||
      (next.turnId === event.turnId &&
        ['turn.completed', 'turn.failed', 'turn.interrupted'].includes(next.type))
    )
      controller.abort();
  });
  const cancelTurn = () => {
    if (event.turnId) void session.cancel(event.turnId).catch(() => {});
  };
  readline.once('SIGINT', cancelTurn);
  try {
    let answer: string;
    try {
      answer = await readline.question(
        `Allow ${tool} with ${JSON.stringify(event.data.arguments)}? [y/N] `,
        { signal: controller.signal },
      );
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError'))
        return;
      throw error;
    }
    if (controller.signal.aborted) return;
    await session.approve(approvalId, /^(y|yes)$/i.test(answer.trim()));
  } finally {
    off();
    readline.off('SIGINT', cancelTurn);
    readline.close();
  }
}

async function runCommand(args: string[]) {
  const parsed = parseArguments(args, {
    session: 'string',
    policy: 'string',
    json: 'boolean',
    workspace: 'string',
    config: 'string',
  });
  if (parsed.positionals.length !== 1 || !parsed.positionals[0])
    throw new Error('coto run requires exactly one prompt argument');
  const policy = stringOption(parsed.options, 'policy');
  if (policy && !['read-only', 'ask', 'allow-all'].includes(policy))
    throw new Error('--policy must be one of: read-only, ask, allow-all');
  const config = await loadProjectConfig(loadOptions(parsed));
  const agent = createAgent({
    ...config.agentOptions,
    ...(policy ? { policy: policy as PolicyName } : {}),
  });
  let session: Session | undefined;
  let activeTurnId: string | undefined;
  let interrupted = false;
  let signalRunning = false;
  const onSigint = () => {
    if (signalRunning) {
      process.exitCode = 130;
      return;
    }
    signalRunning = true;
    interrupted = true;
    process.exitCode = 130;
    void (activeTurnId && session ? session.cancel(activeTurnId) : agent.close()).catch(() => {});
  };
  process.on('SIGINT', onSigint);
  try {
    const sessionId = stringOption(parsed.options, 'session');
    session = sessionId ? await agent.sessions.resume(sessionId) : await agent.sessions.create();
    process.stderr.write(`session: ${session.id}\n`);
    const snapshot = session.snapshot();
    if (snapshot.unresolved.length)
      throw new Error(
        'Session requires reconciliation of unknown tool outcomes before continuing. Use the host reconcile() API, then retry.',
      );
    let resumeNeeded = snapshot.status === 'interrupted';
    let wroteText = false;
    let terminalStatus: string | undefined;
    let terminalReason: string | undefined;
    for await (const event of session.runStream(parsed.positionals[0])) {
      if (resumeNeeded && event.type === 'input.accepted') {
        resumeNeeded = false;
        await session.resume();
      }
      if (event.type === 'turn.started') activeTurnId = event.turnId;
      eventOutput(event, !!parsed.options.json);
      if (event.type === 'text.delta') wroteText = true;
      if (event.type === 'approval.required') await askApproval(event, session);
      if (['turn.completed', 'turn.failed', 'turn.interrupted'].includes(event.type)) {
        const result = event.data.result as { status?: string; reason?: string } | undefined;
        terminalStatus = result?.status;
        terminalReason = result?.reason;
      }
    }
    if (!parsed.options.json && wroteText) process.stdout.write('\n');
    if (interrupted || terminalStatus === 'interrupted') process.exitCode = 130;
    else if (terminalStatus !== 'completed') {
      process.stderr.write(`run failed${terminalReason ? `: ${terminalReason}` : ''}\n`);
      process.exitCode = 1;
    }
  } finally {
    process.off('SIGINT', onSigint);
    await agent.close();
  }
}

async function sessionsCommand(args: string[]) {
  const parsed = parseArguments(args, { workspace: 'string', config: 'string', json: 'boolean' });
  if (parsed.positionals.length) throw new Error(`Unexpected argument: ${parsed.positionals[0]}`);
  const config = await loadProjectConfig(loadOptions(parsed));
  const agent = createAgent(config.agentOptions);
  try {
    const sessions = await agent.sessions.list();
    if (parsed.options.json) {
      for (const session of sessions) console.log(JSON.stringify(session));
    } else if (!sessions.length) {
      console.log('No sessions.');
    } else {
      for (const session of sessions)
        console.log(`${session.id}\t${session.createdAt}\t${session.providerId}\t${session.model}`);
    }
  } finally {
    await agent.close();
  }
}

function legacyServeOptions(workspace: string): {
  agentOptions: AgentOptions;
  serverOptions: ServerOptions;
} {
  return {
    agentOptions: {
      workspace,
      provider: {
        protocol:
          (process.env.COTO_PROTOCOL as ProviderConfig['protocol'] | undefined) ?? 'openai-chat',
        model: process.env.COTO_MODEL ?? 'gpt-4o-mini',
        baseURL: process.env.COTO_BASE_URL,
        apiKeyEnv: process.env.COTO_API_KEY_ENV,
        auth: process.env.COTO_AUTH === 'none' ? 'none' : 'api-key',
      },
      tools: process.env.COTO_TOOLS === 'none' ? [] : localTools(),
      policy:
        process.env.COTO_POLICY === 'allow-all'
          ? 'allow-all'
          : process.env.COTO_POLICY === 'ask'
            ? 'ask'
            : 'read-only',
    },
    serverOptions: {
      host: process.env.COTO_HOST ?? '127.0.0.1',
      port: Number(process.env.COTO_PORT ?? 8787),
    },
  };
}

function applyServeEnvironment(
  loaded: { agentOptions: AgentOptions; serverOptions: ServerOptions },
  workspace: string,
) {
  const original = loaded.agentOptions.provider as ProviderConfig;
  const overrideKeyRoute = !!(process.env.COTO_API_KEY_ENV || process.env.COTO_PROTOCOL);
  const provider: ProviderConfig = {
    ...original,
    protocol:
      (process.env.COTO_PROTOCOL as ProviderConfig['protocol'] | undefined) ?? original.protocol,
    model: process.env.COTO_MODEL ?? original.model,
    baseURL: process.env.COTO_BASE_URL ?? original.baseURL,
    apiKeyEnv:
      process.env.COTO_API_KEY_ENV ?? (process.env.COTO_PROTOCOL ? undefined : original.apiKeyEnv),
    apiKeyResolver: overrideKeyRoute ? undefined : original.apiKeyResolver,
    auth: process.env.COTO_AUTH
      ? process.env.COTO_AUTH === 'none'
        ? 'none'
        : 'api-key'
      : original.auth,
  };
  return {
    agentOptions: {
      ...loaded.agentOptions,
      workspace,
      provider,
      ...(process.env.COTO_TOOLS
        ? { tools: process.env.COTO_TOOLS === 'none' ? [] : ('local-basic' as const) }
        : {}),
      ...(process.env.COTO_POLICY
        ? {
            policy:
              process.env.COTO_POLICY === 'allow-all'
                ? ('allow-all' as const)
                : process.env.COTO_POLICY === 'ask'
                  ? ('ask' as const)
                  : ('read-only' as const),
          }
        : {}),
    },
    serverOptions: {
      ...loaded.serverOptions,
      host: process.env.COTO_HOST ?? loaded.serverOptions.host,
      port: process.env.COTO_PORT ? Number(process.env.COTO_PORT) : loaded.serverOptions.port,
    },
  };
}

async function serveCommand(args: string[]) {
  const parsed = parseArguments(args, { workspace: 'string', config: 'string' });
  if (parsed.positionals.length) throw new Error(`Unexpected argument: ${parsed.positionals[0]}`);
  const workspaceOverride = stringOption(parsed.options, 'workspace') ?? process.env.COTO_WORKSPACE;
  const workspace = resolve(workspaceOverride ?? process.cwd());
  const configPath = stringOption(parsed.options, 'config');
  let options: { agentOptions: AgentOptions; serverOptions: ServerOptions };
  try {
    const loaded = await loadProjectConfig({
      workspace: workspaceOverride ? workspace : undefined,
      configPath,
    });
    options = applyServeEnvironment(loaded, loaded.workspace);
  } catch (error) {
    if (configPath) throw error;
    const missingDefault = resolve(workspace, 'coto.config.json');
    if (!String(error).includes(`COTO config not found: ${missingDefault}`)) throw error;
    options = legacyServeOptions(workspace);
  }
  const agent = createAgent(options.agentOptions);
  const service = createAgentServer(agent, options.serverOptions);
  const address = await service.listen();
  console.log(`COTO listening on http://${address.host}:${address.port}`);
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void service
      .close()
      .catch(() => {})
      .then(() => agent.close());
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0] ?? 'help';
  if (command === 'init') return initCommand(args.slice(1));
  if (command === 'doctor') return doctorCommand(args.slice(1));
  if (command === 'run') return runCommand(args.slice(1));
  if (command === 'sessions') return sessionsCommand(args.slice(1));
  if (command === 'serve') return serveCommand(args.slice(1));
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(help);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

async function invokedAsMain() {
  if (!process.argv[1]) return false;
  const invokedPath = resolve(process.argv[1]);
  const modulePath = fileURLToPath(import.meta.url);
  try {
    const [invoked, module] = await Promise.all([realpath(invokedPath), realpath(modulePath)]);
    return invoked === module;
  } catch {
    return invokedPath === resolve(modulePath);
  }
}

if (await invokedAsMain()) {
  await main().catch((error) => {
    process.stderr.write(`coto: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
