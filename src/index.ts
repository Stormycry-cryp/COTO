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
  let workspace = resolve(options.workspace);
  const store = options.store ?? new FileSessionStore(resolve(workspace, '.coto/sessions'));
  const tools = options.tools === 'local-basic' ? localTools() : (options.tools ?? []);
  const registry = options.skills
    ? new SkillRegistry(options.skills.roots.map((p) => resolve(workspace, p)))
    : undefined;
  const provider =
    'stream' in options.provider ? options.provider : createProvider(options.provider);
  const loaded = new Map<string, Session>();
  const opening = new Map<string, Promise<Session>>();
  const operations = new Set<Promise<unknown>>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let ready: Promise<void> | undefined;
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
  function unavailable() {
    return new AgentError('agent_closed', 'Agent is closed', 409);
  }
  function ensureReady(): Promise<void> {
    if (!ready)
      ready = Promise.all([realpath(workspace), registry?.discover()]).then(([canonical]) => {
        workspace = canonical;
      });
    return ready;
  }
  function track<T>(task: Promise<T>): Promise<T> {
    operations.add(task);
    void task.then(
      () => operations.delete(task),
      () => operations.delete(task),
    );
    return task;
  }
  async function matchesWorkspace(candidate: string) {
    const path = resolve(candidate);
    if (path === workspace) return true;
    try {
      return (await realpath(path)) === workspace;
    } catch {
      return false;
    }
  }
  function load(id: string, admitted = false): Promise<Session> {
    if (closed && !admitted) return Promise.reject(unavailable());
    return track(
      (async () => {
        await ensureReady();
        if (closed && !admitted) throw unavailable();
        const cached = loaded.get(id);
        if (cached) {
          if (!cached.isClosed) return cached;
          await cached.close();
          if (loaded.get(id) === cached) loaded.delete(id);
          if (closed && !admitted) throw unavailable();
        }
        if (opening.has(id)) return opening.get(id)!;
        const task = (async () => {
          const { meta } = await store.read(id);
          if (!(await matchesWorkspace(meta.workspace)))
            throw new AgentError(
              'workspace_mismatch',
              'Session belongs to a different workspace',
              409,
            );
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
      })(),
    );
  }
  const sessions = {
    create(
      metadata: Partial<
        Pick<SessionMeta, 'ownerId' | 'workspaceId' | 'profileId' | 'parentId'>
      > = {},
      id: string = crypto.randomUUID(),
    ): Promise<Session> {
      if (closed) return Promise.reject(unavailable());
      return track(
        (async () => {
          await ensureReady();
          if (closed) throw unavailable();
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
          return load(meta.id, true);
        })(),
      );
    },
    get(id: string) {
      return load(id);
    },
    resume(id: string) {
      return load(id);
    },
    async list() {
      await ensureReady();
      const records = await store.list();
      const matches = await Promise.all(
        records.map((record) => matchesWorkspace(record.workspace)),
      );
      return records.filter((_, index) => matches[index]);
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
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        await Promise.all([...operations].map((p) => p.catch(() => undefined)));
        await Promise.all([...opening.values()].map((p) => p.catch(() => undefined)));
        await Promise.all([...loaded.values()].map((s) => s.close()));
        for (const tool of tools) await tool.close?.();
      })();
      return closePromise;
    },
  };
}
export type Agent = ReturnType<typeof createAgent>;
