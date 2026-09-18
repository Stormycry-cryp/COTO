import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { AgentError, errorMessage } from '../core/errors.js';
import type { InputRequest } from '../core/types.js';
import type { Agent, Session } from '../index.js';

export interface ServerOptions {
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  heartbeatMs?: number;
  /** Reject or accept a request before route handling. Return an owner identity. */
  authenticate?: (request: IncomingMessage) => Promise<{ id: string } | null>;
  /** Enforce object access. Default compares the session owner when present. */
  authorize?: (owner: { id: string }, sessionId: string, action: string) => Promise<boolean>;
}
type CotoServer = {
  server: Server;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
};
type JsonObject = Record<string, unknown>;
const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, jsonHeaders);
  response.end(JSON.stringify(value));
}
function sendError(response: ServerResponse, error: unknown, requestId: string) {
  const e =
    error instanceof AgentError
      ? error
      : new AgentError('internal_error', errorMessage(error), 500);
  send(response, e.status, {
    requestId,
    error: { code: e.code, message: e.message, retryable: e.retryable },
  });
}
async function body(request: IncomingMessage, max: number): Promise<JsonObject> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > max) throw new AgentError('body_limit', 'Request body is too large', 413);
    chunks.push(Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AgentError('invalid_json', 'Request body must be JSON', 422);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentError('invalid_json', 'Request body must be a JSON object', 422);
  return value as JsonObject;
}
function pathSegments(pathname: string) {
  try {
    return pathname.split('/').slice(1).map(decodeURIComponent);
  } catch {
    throw new AgentError('invalid_path', 'Request path is malformed', 400);
  }
}
function stringField(input: JsonObject, name: string) {
  const value = input[name];
  if (typeof value !== 'string' || !value)
    throw new AgentError('invalid_input', `${name} must be a non-empty string`, 422);
  return value;
}

export function createAgentServer(agent: Agent, options: ServerOptions = {}): CotoServer {
  const sessions = new Map<string, Session>();
  const creating = new Map<string, Promise<{ session: Session; created: boolean }>>();
  const streams = new Map<ServerResponse, { abort: AbortController; close: () => void }>();
  let draining = false;
  let closePromise: Promise<void> | undefined;

  const identity = async (request: IncomingMessage) => {
    if (!options.authenticate) return { id: 'anonymous' };
    const owner = await options.authenticate(request);
    if (!owner) throw new AgentError('unauthorized', 'Authentication required', 401);
    return owner;
  };
  const getSession = async (id: string) => {
    const cached = sessions.get(id);
    if (cached) return cached;
    const session = await agent.sessions.get(id);
    sessions.set(id, session);
    return session;
  };
  const getSessionMeta = async (id: string) => {
    const cached = sessions.get(id);
    if (cached) return cached.snapshot().meta;
    return (await agent.sessions.list()).find((meta) => meta.id === id);
  };
  const authorize = async (request: IncomingMessage, sessionId: string, action: string) => {
    const owner = await identity(request);
    if (options.authorize && !(await options.authorize(owner, sessionId, action)))
      throw new AgentError('forbidden', 'Session access denied', 403);
    const meta = await getSessionMeta(sessionId);
    if (!meta) throw new AgentError('not_found', 'Session not found', 404);
    if (!options.authorize && meta.ownerId && meta.ownerId !== owner.id)
      throw new AgentError('forbidden', 'Session access denied', 403);
    const session = await getSession(sessionId);
    return { owner, session };
  };
  const existingIdempotentSession = async (id: string, ownerId: string) => {
    const meta = await getSessionMeta(id);
    if (!meta) return undefined;
    if (meta.ownerId !== ownerId || meta.workspaceId !== 'default' || meta.profileId !== 'default')
      throw new AgentError(
        'idempotency_conflict',
        'Idempotency key conflicts with an existing session',
        409,
      );
    return getSession(id);
  };

  const server = createHttpServer(async (request, response) => {
    const requestId = crypto.randomUUID();
    response.setHeader('x-request-id', requestId);
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const segments = pathSegments(url.pathname);
      if (request.method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
        send(response, 200, { ok: true });
        return;
      }
      if (request.method === 'GET' && segments.length === 1 && segments[0] === 'readyz') {
        send(response, draining ? 503 : 200, { ok: !draining });
        return;
      }
      if (draining) throw new AgentError('draining', 'Server is draining', 503);

      const collection =
        segments.length === 2 && segments[0] === 'v1' && segments[1] === 'sessions';
      if (request.method === 'POST' && collection) {
        const owner = await identity(request);
        const input = await body(request, options.maxBodyBytes ?? 1_000_000);
        if (
          (input.workspaceId !== undefined && input.workspaceId !== 'default') ||
          (input.agentProfileId !== undefined && input.agentProfileId !== 'default')
        )
          throw new AgentError(
            'unknown_profile',
            'This service exposes the default workspace/profile only',
            422,
          );
        if (input.ownerId !== undefined && input.ownerId !== owner.id)
          throw new AgentError('forbidden', 'ownerId is controlled by authentication', 403);
        const key = request.headers['idempotency-key'];
        if (
          Array.isArray(key) ||
          (typeof key === 'string' && (key.length === 0 || key.length > 200))
        )
          throw new AgentError(
            'invalid_idempotency_key',
            'Idempotency-Key must contain 1 to 200 characters',
            422,
          );
        const requestedId =
          typeof key === 'string'
            ? createHash('sha256')
                .update(JSON.stringify([owner.id, key]))
                .digest('hex')
            : undefined;
        if (requestedId) {
          let task = creating.get(requestedId);
          const started = !task;
          if (!task) {
            task = (async () => {
              const existing = await existingIdempotentSession(requestedId, owner.id);
              if (existing) return { session: existing, created: false };
              const session = await agent.sessions.create(
                { ownerId: owner.id, workspaceId: 'default', profileId: 'default' },
                requestedId,
              );
              sessions.set(session.id, session);
              return { session, created: true };
            })();
            creating.set(requestedId, task);
          }
          try {
            const result = await task;
            send(response, started && result.created ? 201 : 200, result.session.snapshot());
          } finally {
            if (creating.get(requestedId) === task) creating.delete(requestedId);
          }
          return;
        }
        const session = await agent.sessions.create({
          ownerId: owner.id,
          workspaceId: 'default',
          profileId: 'default',
        });
        sessions.set(session.id, session);
        send(response, 201, session.snapshot());
        return;
      }
      if (request.method === 'GET' && collection) {
        const owner = await identity(request);
        const rawOffset = url.searchParams.get('offset') ?? '0';
        const offset = Number(rawOffset);
        if (!/^\d+$/.test(rawOffset) || !Number.isSafeInteger(offset))
          throw new AgentError(
            'invalid_pagination',
            'offset must be a non-negative safe integer',
            422,
          );
        const records = await agent.sessions.list();
        const visible = [];
        for (const meta of records)
          if (
            options.authorize
              ? await options.authorize(owner, meta.id, 'read')
              : !meta.ownerId || meta.ownerId === owner.id
          )
            visible.push(meta);
        send(response, 200, {
          sessions: visible.slice(offset, offset + 100),
          nextOffset: offset + 100 < visible.length ? offset + 100 : null,
        });
        return;
      }

      if (segments.length < 3 || segments[0] !== 'v1' || segments[1] !== 'sessions' || !segments[2])
        throw new AgentError('not_found', 'Route not found', 404);
      const sessionId = segments[2];
      if (request.method === 'GET' && segments.length === 3) {
        const { session } = await authorize(request, sessionId, 'read');
        send(response, 200, session.snapshot());
        return;
      }
      if (request.method === 'GET' && segments.length === 4 && segments[3] === 'events') {
        const { session } = await authorize(request, sessionId, 'events');
        const cursor = String(
          request.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0',
        );
        if (cursor.includes(':') && !cursor.startsWith(`${sessionId}:`))
          throw new AgentError('invalid_cursor', 'Cursor belongs to another session', 422);
        const last = Number(cursor.split(':').at(-1));
        if (!Number.isSafeInteger(last) || last < 0 || last > session.snapshot().seq)
          throw new AgentError('invalid_cursor', 'Invalid event cursor', 422);
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        response.flushHeaders?.();
        const abort = new AbortController();
        let ended = false;
        const closeStream = () => {
          if (ended) return;
          ended = true;
          abort.abort();
          const socket = response.socket;
          response.end(() => socket?.end());
        };
        streams.set(response, { abort, close: closeStream });
        response.once('close', () => abort.abort());
        const heartbeat = setInterval(() => {
          if (!response.writableNeedDrain) response.write(': heartbeat\n\n');
        }, options.heartbeatMs ?? 15_000);
        try {
          for await (const event of session.streamEvents(last, abort.signal)) {
            if (
              response.write(
                `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              )
            )
              continue;
            try {
              await once(response, 'drain', {
                signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
              });
            } catch {
              if (abort.signal.aborted) break;
              throw new AgentError('slow_consumer', 'Reconnect using the last event ID', 429);
            }
          }
        } catch (error) {
          if (!abort.signal.aborted)
            response.write(
              `event: stream.error\ndata: ${JSON.stringify({ code: error instanceof AgentError ? error.code : 'stream_error' })}\n\n`,
            );
        } finally {
          clearInterval(heartbeat);
          streams.delete(response);
          closeStream();
        }
        return;
      }

      const route = segments.slice(3);
      const routeExists =
        (request.method === 'POST' &&
          route.length === 1 &&
          ['inputs', 'resume', 'approvals', 'reconcile', 'archive', 'fork'].includes(route[0])) ||
        (request.method === 'DELETE' &&
          route.length === 2 &&
          route[0] === 'inputs' &&
          !!route[1]) ||
        (request.method === 'POST' &&
          route.length === 3 &&
          route[0] === 'turns' &&
          !!route[1] &&
          route[2] === 'cancel') ||
        (request.method === 'GET' && route.length === 2 && route[0] === 'artifacts' && !!route[1]);
      if (!routeExists) throw new AgentError('not_found', 'Route not found', 404);
      const action = request.method === 'GET' ? 'read' : route[0] === 'fork' ? 'fork' : 'write';
      const { session } = await authorize(request, sessionId, action);
      if (request.method === 'POST' && route.length === 1 && route[0] === 'inputs') {
        const input = (await body(
          request,
          options.maxBodyBytes ?? 1_000_000,
        )) as unknown as InputRequest;
        const idempotencyKey = request.headers['idempotency-key'];
        if (
          Array.isArray(idempotencyKey) ||
          (idempotencyKey !== undefined && idempotencyKey !== input.inputId)
        )
          throw new AgentError(
            'invalid_idempotency_key',
            'For input submission Idempotency-Key must equal inputId',
            422,
          );
        const receipt = await session.submitInput(input);
        send(response, 202, { ...receipt, requestId });
        return;
      }
      if (request.method === 'DELETE' && route.length === 2 && route[0] === 'inputs' && route[1]) {
        await session.withdraw(route[1]);
        send(response, 200, { ok: true });
        return;
      }
      if (request.method === 'POST' && route.length === 1 && route[0] === 'resume') {
        await session.resume();
        send(response, 202, { accepted: true });
        return;
      }
      if (
        request.method === 'POST' &&
        route.length === 3 &&
        route[0] === 'turns' &&
        route[1] &&
        route[2] === 'cancel'
      ) {
        await session.cancel(route[1]);
        send(response, 202, { accepted: true, turnId: route[1] });
        return;
      }
      if (request.method === 'POST' && route.length === 1 && route[0] === 'approvals') {
        const input = await body(request, options.maxBodyBytes ?? 1_000_000);
        if (typeof input.allowed !== 'boolean')
          throw new AgentError('invalid_input', 'allowed must be a boolean', 422);
        await session.approve(stringField(input, 'approvalId'), input.allowed);
        send(response, 200, { ok: true });
        return;
      }
      if (request.method === 'POST' && route.length === 1 && route[0] === 'reconcile') {
        const input = await body(request, options.maxBodyBytes ?? 1_000_000);
        await session.reconcile(stringField(input, 'invocationId'), stringField(input, 'outcome'));
        send(response, 200, { ok: true });
        return;
      }
      if (request.method === 'POST' && route.length === 1 && route[0] === 'archive') {
        await session.archive();
        send(response, 200, { ok: true });
        return;
      }
      if (request.method === 'POST' && route.length === 1 && route[0] === 'fork') {
        const meta = session.snapshot().meta;
        const child = await agent.sessions.fork(sessionId, {
          ownerId: meta.ownerId,
          workspaceId: meta.workspaceId,
          profileId: meta.profileId,
        });
        sessions.set(child.id, child);
        send(response, 201, child.snapshot());
        return;
      }
      if (request.method === 'GET' && route.length === 2 && route[0] === 'artifacts' && route[1]) {
        const content = await agent.store.getArtifact(sessionId, route[1]);
        response.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'x-content-type-options': 'nosniff',
        });
        response.end(content);
        return;
      }
      throw new AgentError('not_found', 'Route not found', 404);
    } catch (error) {
      if (!response.headersSent) sendError(response, error, requestId);
      else response.destroy();
    }
  });

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        const host = options.host ?? '127.0.0.1';
        if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !options.authenticate)
          return reject(new Error('Authentication required for non-loopback binding'));
        server.once('error', reject);
        server.listen(options.port ?? 0, host, () => {
          const address = server.address();
          if (!address || typeof address === 'string')
            return reject(new Error('Server address unavailable'));
          resolve({ host, port: address.port });
        });
      }),
    close: async () => {
      draining = true;
      for (const stream of streams.values()) stream.close();
      if (!closePromise) {
        closePromise = new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections();
        });
      }
      await closePromise;
    },
  };
}
export type { CotoServer };
