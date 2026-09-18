import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent, FileSessionStore, MemorySessionStore } from '../src/index.js';
import { echoProvider } from '../src/testing/index.js';
import { createAgentServer } from '../src/server/index.js';
import { CotoClient } from '../src/client/index.js';

test('HTTP/SSE live stream and reconnect with cursor do not rerun the model', async () => {
  const provider = echoProvider(1);
  const agent = createAgent({
    workspace: process.cwd(),
    provider,
    store: new MemorySessionStore(),
  });
  const service = createAgentServer(agent);
  const address = await service.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const client = new CotoClient(url);
  try {
    const created = await client.createSession();
    const id = (created.meta as any).id;
    const input = {
      inputId: 'hello',
      mode: 'follow_up' as const,
      content: [{ type: 'text' as const, text: 'hello world' }],
    };
    const receipt = await client.submitInput(id, input);
    assert(receipt.acceptedSeq > 0);
    const events = [];
    for await (const event of client.events(id)) {
      events.push(event);
      if (event.type === 'turn.completed') break;
    }
    assert(events.some((e) => e.type === 'text.delta'));
    assert.equal(provider.requests.length, 1);
    const replay = [];
    for await (const event of client.events(id, events.at(-2)!.seq)) {
      replay.push(event);
      if (event.type === 'turn.completed') break;
    }
    assert.equal(replay.length, 1);
    await client.submitInput(id, input);
    assert.equal(provider.requests.length, 1);
    assert.equal(
      (
        await fetch(`${url}/v1/sessions/${id}/events`, {
          headers: { 'Last-Event-ID': `other:${events.at(-2)!.seq}` },
        })
      ).status,
      422,
    );
    const response = await fetch(`${url}/v1/sessions/${id}/events`, {
      headers: { 'Last-Event-ID': `${id}:${events.at(-2)!.seq}` },
    });
    assert.equal(response.status, 200);
    await response.body?.cancel();
  } finally {
    await service.close();
    await agent.close();
  }
});

test('authentication rejects missing credentials; another owner cannot access session or fork', async () => {
  const agent = createAgent({
    workspace: process.cwd(),
    provider: echoProvider(0),
    store: new MemorySessionStore(),
  });
  const service = createAgentServer(agent, {
    authenticate: async (request) =>
      request.headers.authorization ? { id: request.headers.authorization } : null,
  });
  const { port } = await service.listen();
  const url = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${url}/v1/sessions`, { method: 'POST', body: '{}' })).status, 401);
    const owner = new CotoClient(url, fetch, { authorization: 'A' });
    const created = await owner.createSession();
    const id = (created.meta as any).id;
    assert.equal(
      (await fetch(`${url}/v1/sessions/${id}`, { headers: { authorization: 'B' } })).status,
      403,
    );
    const child: any = await owner.fork(id);
    assert.equal(child.meta.ownerId, 'A');
    const ownerSessions = await owner.listSessions();
    assert.deepEqual(
      ownerSessions.sessions.map((record: any) => record.id).sort(),
      [child.meta.id, id].sort(),
    );
    const other = new CotoClient(url, fetch, { authorization: 'B' });
    assert.deepEqual((await other.listSessions()).sessions, []);
    await owner.archive(child.meta.id);
    assert.equal(((await owner.snapshot(child.meta.id)) as any).status, 'archived');
  } finally {
    await service.close();
    await agent.close();
  }
});

test('JSON bodies and session routes are validated before dispatch', async () => {
  const agent = createAgent({
    workspace: process.cwd(),
    provider: echoProvider(0),
    store: new MemorySessionStore(),
  });
  const service = createAgentServer(agent);
  const { port } = await service.listen();
  const url = `http://127.0.0.1:${port}`;
  try {
    for (const invalid of ['{', 'null', '[]']) {
      const response = await fetch(`${url}/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: invalid,
      });
      assert.equal(response.status, 422);
      assert.equal(((await response.json()) as any).error.code, 'invalid_json');
    }
    assert.equal((await fetch(`${url}/v1/sessions?offset=nope`)).status, 422);
    const created: any = await new CotoClient(url).createSession();
    const id = created.meta.id;
    const strictRoutes: Array<[string, string]> = [
      ['POST', `${url}/v1/sessions/${id}/archive/extra`],
      ['DELETE', `${url}/v1/sessions/${id}/inputs/missing/extra`],
      ['POST', `${url}/v1/sessions/${id}/other/approvals`],
      ['GET', `${url}/v1/sessions/${id}/artifacts/missing/extra`],
    ];
    for (const [method, endpoint] of strictRoutes)
      assert.equal(
        (await fetch(endpoint, { method, body: method === 'GET' ? undefined : '{}' })).status,
        404,
      );
    assert.equal(((await new CotoClient(url).snapshot(id)) as any).status, 'idle');
  } finally {
    await service.close();
    await agent.close();
  }
});

test('session creation is idempotent under concurrency and rejects owner collisions', async () => {
  const agent = createAgent({
    workspace: process.cwd(),
    provider: echoProvider(0),
    store: new MemorySessionStore(),
  });
  const service = createAgentServer(agent, {
    authenticate: async (request) =>
      request.headers.authorization ? { id: request.headers.authorization } : null,
  });
  const { port } = await service.listen();
  const url = `http://127.0.0.1:${port}`;
  try {
    const headers = {
      authorization: 'A',
      'content-type': 'application/json',
      'idempotency-key': 'same-create',
    };
    const responses = await Promise.all([
      fetch(`${url}/v1/sessions`, { method: 'POST', headers, body: '{}' }),
      fetch(`${url}/v1/sessions`, { method: 'POST', headers, body: '{}' }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
    const snapshots = await Promise.all(
      responses.map((response) => response.json() as Promise<any>),
    );
    assert.equal(snapshots[0].meta.id, snapshots[1].meta.id);
    const replay = await fetch(`${url}/v1/sessions`, { method: 'POST', headers, body: '{}' });
    assert.equal(replay.status, 200);
    assert.equal(((await replay.json()) as any).meta.id, snapshots[0].meta.id);

    const collisionKey = 'owner-collision';
    const collisionId = createHash('sha256')
      .update(JSON.stringify(['A', collisionKey]))
      .digest('hex');
    await agent.sessions.create(
      { ownerId: 'B', workspaceId: 'default', profileId: 'default' },
      collisionId,
    );
    const collision = await fetch(`${url}/v1/sessions`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': collisionKey },
      body: '{}',
    });
    assert.equal(collision.status, 409);
    assert.equal(((await collision.json()) as any).error.code, 'idempotency_conflict');
  } finally {
    await service.close();
    await agent.close();
  }
});

test('filesystem-backed HTTP session creation is idempotent under concurrency', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'coto-server-create-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = createAgent({
    workspace: root,
    provider: echoProvider(0),
    store: new FileSessionStore(join(root, 'sessions')),
  });
  const service = createAgentServer(agent, {
    authenticate: async (request) =>
      request.headers.authorization ? { id: request.headers.authorization } : null,
  });
  const { port } = await service.listen();
  const url = `http://127.0.0.1:${port}`;
  try {
    const headers = {
      authorization: 'A',
      'content-type': 'application/json',
      'idempotency-key': 'same-file-create',
    };
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(`${url}/v1/sessions`, { method: 'POST', headers, body: '{}' }),
      ),
    );
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 200, 200, 200, 200, 200, 200, 201],
    );
    const snapshots = await Promise.all(
      responses.map((response) => response.json() as Promise<any>),
    );
    assert.equal(new Set(snapshots.map((snapshot) => snapshot.meta.id)).size, 1);
    assert.equal((await agent.sessions.list()).length, 1);
  } finally {
    await service.close();
    await agent.close();
  }
});

test('default owner authorization does not open or repair another owner session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'coto-server-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'sessions');
  const provider = echoProvider(0);
  const seed = createAgent({ workspace: root, provider, store: new FileSessionStore(directory) });
  const created = await seed.sessions.create({ ownerId: 'A' });
  const id = created.id;
  await seed.close();
  const eventsPath = join(directory, id, 'events.jsonl');
  await appendFile(eventsPath, '{"partial":');

  class ObservedFileStore extends FileSessionStore {
    acquireCount = 0;
    override async acquire(sessionId: string) {
      this.acquireCount++;
      return super.acquire(sessionId);
    }
  }
  const store = new ObservedFileStore(directory);
  const agent = createAgent({ workspace: root, provider, store });
  const service = createAgentServer(agent, {
    authenticate: async (request) =>
      request.headers.authorization ? { id: request.headers.authorization } : null,
  });
  const { port } = await service.listen();
  const url = `http://127.0.0.1:${port}`;
  try {
    assert.equal(
      (await fetch(`${url}/v1/sessions/${id}`, { headers: { authorization: 'B' } })).status,
      403,
    );
    assert.equal(store.acquireCount, 0);
    assert.equal(await readFile(eventsPath, 'utf8'), '{"partial":');
    assert.equal(
      (await fetch(`${url}/v1/sessions/${id}`, { headers: { authorization: 'A' } })).status,
      200,
    );
    assert.equal(store.acquireCount, 1);
    assert.equal(await readFile(eventsPath, 'utf8'), '');
  } finally {
    await service.close();
    await agent.close();
  }
});

test('server close releases open SSE streams', async () => {
  const agent = createAgent({
    workspace: process.cwd(),
    provider: echoProvider(0),
    store: new MemorySessionStore(),
  });
  const service = createAgentServer(agent);
  const { port } = await service.listen();
  const url = `http://127.0.0.1:${port}`;
  const client = new CotoClient(url);
  try {
    const created: any = await client.createSession();
    const id = created.meta.id;
    const response = await fetch(`${url}/v1/sessions/${id}/events`);
    assert.equal(response.status, 200);
    const read = response.body!.getReader().read();
    await service.close();
    assert.equal((await read).done, true);
    await service.close();
  } finally {
    await service.close();
    await agent.close();
  }
});

test('SSE client delivers parsed events before reporting a slow consumer error', async () => {
  const event = {
    schemaVersion: 1,
    sessionId: 'session',
    eventId: 'session:1',
    seq: 1,
    timestamp: new Date(0).toISOString(),
    type: 'turn.started',
    data: {},
  };
  const bytes = new TextEncoder().encode(
    `id: session:1\nevent: turn.started\ndata: ${JSON.stringify(event)}\n\nevent: stream.error\ndata: {"code":"slow_consumer"}\n\n`,
  );
  const fetchImpl = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  const iterator = new CotoClient('http://localhost', fetchImpl as typeof fetch).events('session');
  assert.deepEqual(await iterator.next(), { done: false, value: event });
  await assert.rejects(iterator.next(), /slow_consumer/);

  const abort = new AbortController();
  const abortingFetch = async (_input: URL | RequestInfo, init?: RequestInit) =>
    new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
            once: true,
          });
        },
      }),
      { status: 200 },
    );
  const cancelled = new CotoClient('http://localhost', abortingFetch as typeof fetch)
    .events('session', 0, abort.signal)
    .next();
  abort.abort();
  assert.equal((await cancelled).done, true);
});
