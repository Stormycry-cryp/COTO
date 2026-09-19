import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { Session, type RuntimeOptions } from './core/session.js';
import type { SessionMeta, SessionStore, ModelProvider, Tool } from './core/types.js';
import { AgentError } from './core/errors.js';
import { FileSessionStore } from './session/index.js';
import { createProvider, type ProviderConfig } from './providers/index.js';
import { localTools } from './tools/index.js';
import { SkillRegistry, projectInstructions } from './skills/index.js';
export * from './core/index.js';
export { createProvider, type ProviderConfig } from './providers/index.js';
export { FileSessionStore, MemorySessionStore } from './session/index.js';

export interface AgentOptions extends Omit<RuntimeOptions, 'provider' | 'tools'> {
  workspace: string;
  provider: ModelProvider | ProviderConfig;
  tools?: Tool[] | 'local-basic';
  store?: SessionStore;
  skills?: { roots: string[] };
  projectInstructions?: boolean;
}
export function createAgent(options: AgentOptions) {
  const workspace = resolve(options.workspace);
  const store = options.store ?? new FileSessionStore(resolve(workspace, '.coto/sessions'));
  const tools = options.tools === 'local-basic' ? localTools() : (options.tools ?? []);
  const registry = options.skills
    ? new SkillRegistry(options.skills.roots.map((p) => resolve(workspace, p)))
    : undefined;
  const provider =
    'stream' in options.provider ? options.provider : createProvider(options.provider);
  const loaded = new Map<string, Session>();
  const opening = new Map<string, Promise<Session>>();
  let closed = false;
  const ready = Promise.all([realpath(workspace), registry?.discover()]);
  const runtime: RuntimeOptions = {
    ...options,
    provider,
    tools: [...tools, ...(registry?.tools() ?? [])],
    context: {
      ...options.context,
      contributors: [
        ...(options.context?.contributors ?? []),
        ...(options.projectInstructions === false ? [] : [projectInstructions()]),
        ...(registry ? [registry.contributor()] : []),
      ],
    },
  };
  async function load(id: string) {
    if (closed) throw new AgentError('agent_closed', 'Agent is closed', 409);
    await ready;
    if (closed) throw new AgentError('agent_closed', 'Agent is closed', 409);
    if (loaded.has(id)) return loaded.get(id)!;
    if (opening.has(id)) return opening.get(id)!;
    const task = (async () => {
      const { meta } = await store.read(id);
      if (resolve(meta.workspace) !== workspace)
        throw new AgentError('workspace_mismatch', 'Session belongs to a different workspace', 409);
      const session = await Session.open(meta, store, runtime);
      loaded.set(id, session);
      return session;
    })();
    opening.set(id, task);
    try {
      return await task;
    } finally {
      opening.delete(id);
    }
  }
  const sessions = {
    async create(
      metadata: Partial<
        Pick<SessionMeta, 'ownerId' | 'workspaceId' | 'profileId' | 'parentId'>
      > = {},
      id: string = crypto.randomUUID(),
    ) {
      await ready;
      if (closed) throw new AgentError('agent_closed', 'Agent is closed', 409);
      const meta: SessionMeta = {
        id,
        workspace,
        createdAt: new Date().toISOString(),
        schemaVersion: 1,
        providerId: provider.id,
        model: provider.model,
        ...metadata,
      };
      await store.create(meta);
      return load(meta.id);
    },
    get: load,
    resume: load,
    async list() {
      return (await store.list()).filter((m) => resolve(m.workspace) === workspace);
    },
    async fork(
      id: string,
      metadata: Partial<Pick<SessionMeta, 'ownerId' | 'workspaceId' | 'profileId'>> = {},
    ) {
      const parent = await load(id);
      const snapshot = parent.snapshot();
      if (snapshot.status === 'active' || snapshot.unresolved.length)
        throw new AgentError('session_busy', 'Fork requires an idle reconciled session', 409);
      const session = await sessions.create({ ...metadata, parentId: id });
      await session.seedFork(snapshot.messages);
      return session;
    },
  };
  return {
    sessions,
    store,
    provider,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...opening.values()].map((p) => p.catch(() => undefined)));
      await Promise.all([...loaded.values()].map((s) => s.close()));
      for (const tool of tools) await tool.close?.();
    },
  };
}
export type Agent = ReturnType<typeof createAgent>;
