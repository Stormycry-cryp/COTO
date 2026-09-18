import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentError, FileSessionStore, type SessionMeta } from '../src/index.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'coto-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'sessions');
  const meta: SessionMeta = {
    id: 'same-session',
    createdAt: new Date(0).toISOString(),
    workspace: root,
    ownerId: 'owner',
    providerId: 'test',
    model: 'test',
    schemaVersion: 1,
  };
  return { root, directory, meta };
}

test('FileSessionStore publishes one complete session for concurrent same-id creates', async (t) => {
  const { directory, meta } = await fixture(t);
  const first = new FileSessionStore(directory);
  const second = new FileSessionStore(directory);
  const results = await Promise.allSettled([first.create(meta), second.create(meta)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejection = results.find((result) => result.status === 'rejected');
  assert(rejection && rejection.status === 'rejected');
  assert(rejection.reason instanceof AgentError);
  assert.equal(rejection.reason.code, 'conflict');
  assert.equal(rejection.reason.status, 409);
  assert.deepEqual(await first.read(meta.id), { meta, events: [] });
});

test('FileSessionStore enforces same-instance and cross-instance writer locks', async (t) => {
  const { directory, meta } = await fixture(t);
  const first = new FileSessionStore(directory);
  const second = new FileSessionStore(directory);
  await first.create(meta);
  const releaseFirst = await first.acquire(meta.id);
  await assert.rejects(
    first.acquire(meta.id),
    (error: unknown) => error instanceof AgentError && error.code === 'session_busy',
  );
  await assert.rejects(
    second.acquire(meta.id),
    (error: unknown) => error instanceof AgentError && error.code === 'session_busy',
  );
  await releaseFirst();
  const releaseSecond = await second.acquire(meta.id);
  await releaseSecond();
});

test('FileSessionStore repairs an incomplete tail only while holding its writer lock', async (t) => {
  const { directory, meta } = await fixture(t);
  const reader = new FileSessionStore(directory);
  const owner = new FileSessionStore(directory);
  await reader.create(meta);
  const eventsPath = join(directory, meta.id, 'events.jsonl');
  await appendFile(eventsPath, '{"partial":');
  assert.deepEqual(await reader.read(meta.id), { meta, events: [] });
  assert.equal(await readFile(eventsPath, 'utf8'), '{"partial":');
  const release = await owner.acquire(meta.id);
  try {
    assert.deepEqual(await owner.read(meta.id), { meta, events: [] });
  } finally {
    await release();
  }
  assert.equal(await readFile(eventsPath, 'utf8'), '');
});
