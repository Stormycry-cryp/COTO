import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  open,
  rename,
  rm,
  stat,
  truncate,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import type { AgentEvent, SessionMeta, SessionStore } from '../core/types.js';
import { AgentError } from '../core/errors.js';

export function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw new AgentError('invalid_id', 'Invalid identifier', 422);
  return id;
}

export class MemorySessionStore implements SessionStore {
  private records = new Map<string, { meta: SessionMeta; events: AgentEvent[] }>();
  private locks = new Set<string>();
  private artifacts = new Map<string, string>();
  async create(meta: SessionMeta) {
    if (this.records.has(meta.id)) throw new AgentError('conflict', 'Session already exists', 409);
    this.records.set(meta.id, { meta: structuredClone(meta), events: [] });
  }
  async list() {
    return [...this.records.values()].map((r) => structuredClone(r.meta));
  }
  async read(id: string) {
    const record = this.records.get(id);
    if (!record) throw new AgentError('not_found', 'Session not found', 404);
    return structuredClone(record);
  }
  async acquire(id: string) {
    if (this.locks.has(id))
      throw new AgentError('session_busy', 'Session has an active writer', 409);
    this.locks.add(id);
    return async () => {
      this.locks.delete(id);
    };
  }
  async append(id: string, event: AgentEvent) {
    const record = this.records.get(id);
    if (!record || !this.locks.has(id))
      throw new AgentError('store_error', 'Writer ownership required', 500);
    if (event.seq !== record.events.length + 1)
      throw new AgentError('store_error', 'Event sequence mismatch', 500);
    record.events.push(structuredClone(event));
  }
  async putArtifact(id: string, content: string) {
    const key = randomUUID();
    this.artifacts.set(`${id}/${key}`, content);
    return key;
  }
  async getArtifact(id: string, key: string) {
    const content = this.artifacts.get(`${id}/${key}`);
    if (content === undefined) throw new AgentError('not_found', 'Artifact not found', 404);
    return content;
  }
}

/** Local filesystem store. Network filesystems and distributed writers need a different store. */
export class FileSessionStore implements SessionStore {
  readonly directory: string;
  private ownership = new Map<string, { compromised?: Error }>();
  constructor(
    directory: string,
    readonly maxSessionBytes = 64 * 1024 * 1024,
  ) {
    this.directory = resolve(directory);
  }
  private dir(id: string) {
    return join(this.directory, safeId(id));
  }
  async create(meta: SessionMeta) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const dir = this.dir(meta.id);
    const temporary = await mkdtemp(join(this.directory, `.${safeId(meta.id)}-`));
    try {
      await chmod(temporary, 0o700);
      await writeFile(join(temporary, 'meta.json'), JSON.stringify(meta), {
        flag: 'wx',
        mode: 0o600,
      });
      await writeFile(join(temporary, 'events.jsonl'), '', { flag: 'wx', mode: 0o600 });
      try {
        await rename(temporary, dir);
      } catch (error) {
        if (['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw new AgentError('conflict', 'Session already exists', 409);
        throw error;
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  async list() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const records: SessionMeta[] = [];
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[\w-]+$/.test(entry.name)) continue;
      try {
        records.push(JSON.parse(await readFile(join(this.dir(entry.name), 'meta.json'), 'utf8')));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async read(id: string) {
    const dir = this.dir(id);
    let meta: SessionMeta;
    try {
      meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new AgentError('not_found', 'Session not found', 404);
      throw error;
    }
    if (meta.schemaVersion !== 1 || meta.id !== id)
      throw new AgentError('store_version', 'Unsupported session metadata', 500);
    const path = join(dir, 'events.jsonl');
    if ((await stat(path)).size > this.maxSessionBytes)
      throw new AgentError('storage_limit', 'Session log exceeds configured limit', 507);
    const raw = await readFile(path, 'utf8');
    const end = raw.lastIndexOf('\n') + 1;
    const events: AgentEvent[] = raw
      .slice(0, end)
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event.schemaVersion !== 1 || event.sessionId !== id || event.seq !== i + 1)
        throw new AgentError('store_corrupt', 'Invalid event history', 500);
    }
    // Only the owning writer may repair an incomplete final record after a crash.
    const owner = this.ownership.get(id);
    if (end !== raw.length && owner && !owner.compromised)
      await truncate(path, Buffer.byteLength(raw.slice(0, end)));
    return { meta, events };
  }
  async acquire(id: string) {
    const state: { compromised?: Error } = {};
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(this.dir(id), {
        realpath: true,
        stale: 30_000,
        update: 10_000,
        retries: 0,
        onCompromised: (e) => {
          state.compromised = e;
        },
      });
    } catch {
      throw new AgentError('session_busy', 'Session has an active writer or cannot be locked', 409);
    }
    this.ownership.set(id, state);
    return async () => {
      this.ownership.delete(id);
      await release();
    };
  }
  async append(id: string, event: AgentEvent) {
    const state = this.ownership.get(id);
    if (!state || state.compromised)
      throw new AgentError('writer_lost', 'Session writer ownership lost', 500);
    const path = join(this.dir(id), 'events.jsonl');
    const line = JSON.stringify(event) + '\n';
    if ((await stat(path)).size + Buffer.byteLength(line) > this.maxSessionBytes)
      throw new AgentError('storage_limit', 'Session storage limit reached', 507);
    const handle = await open(path, 'a', 0o600);
    try {
      await handle.writeFile(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async putArtifact(id: string, content: string) {
    const dir = join(this.dir(id), 'artifacts');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const entries = await readdir(dir);
    let bytes = Buffer.byteLength(content);
    for (const entry of entries) bytes += (await stat(join(dir, entry))).size;
    if (bytes > this.maxSessionBytes)
      throw new AgentError('storage_limit', 'Artifact storage limit reached', 507);
    const key = randomUUID();
    await writeFile(join(dir, key), content, { flag: 'wx', mode: 0o600 });
    return key;
  }
  async getArtifact(id: string, key: string) {
    try {
      return await readFile(join(this.dir(id), 'artifacts', safeId(key)), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new AgentError('not_found', 'Artifact not found', 404);
      throw error;
    }
  }
}
