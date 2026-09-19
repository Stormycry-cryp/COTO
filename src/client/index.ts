import { createParser } from 'eventsource-parser';
import type { AgentEvent, InputReceipt, InputRequest } from '../core/types.js';

export class CotoClient {
  constructor(
    readonly baseURL: string,
    readonly fetchImpl: typeof fetch = fetch,
    readonly headers: Record<string, string> = {},
  ) {}

  private async request<T>(path: string, init: RequestInit = {}) {
    const response = await this.fetchImpl(new URL(path, this.baseURL), {
      ...init,
      headers: {
        ...this.headers,
        ...(init.headers as Record<string, string> | undefined),
        'content-type': 'application/json',
      },
    });
    const data = (await response.json()) as T & { error?: { message?: string; code?: string } };
    if (!response.ok)
      throw new Error(
        `${data.error?.code ?? response.status}: ${data.error?.message ?? response.statusText}`,
      );
    return data;
  }
  async createSession(
    input: { workspaceId?: string; agentProfileId?: string } = {},
    idempotencyKey?: string,
  ) {
    return this.request<Record<string, unknown>>('/v1/sessions', {
      method: 'POST',
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
      body: JSON.stringify(input),
    });
  }
  async listSessions(offset = 0) {
    return this.request<{ sessions: Record<string, unknown>[]; nextOffset: number | null }>(
      `/v1/sessions?offset=${offset}`,
    );
  }
  async snapshot(id: string) {
    return this.request<Record<string, unknown>>(`/v1/sessions/${encodeURIComponent(id)}`);
  }
  async submitInput(id: string, input: InputRequest, idempotencyKey = input.inputId) {
    return this.request<InputReceipt>(`/v1/sessions/${encodeURIComponent(id)}/inputs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    });
  }
  async withdraw(id: string, inputId: string) {
    return this.request<{ ok: true }>(
      `/v1/sessions/${encodeURIComponent(id)}/inputs/${encodeURIComponent(inputId)}`,
      { method: 'DELETE' },
    );
  }
  async resume(id: string) {
    return this.request<{ accepted: true }>(`/v1/sessions/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
    });
  }
  async fork(id: string) {
    return this.request<Record<string, unknown>>(`/v1/sessions/${encodeURIComponent(id)}/fork`, {
      method: 'POST',
    });
  }
  async archive(id: string) {
    return this.request<{ ok: true }>(`/v1/sessions/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
    });
  }
  async reconcile(id: string, invocationId: string, outcome: string) {
    return this.request<{ ok: true }>(`/v1/sessions/${encodeURIComponent(id)}/reconcile`, {
      method: 'POST',
      body: JSON.stringify({ invocationId, outcome }),
    });
  }
  async cancel(id: string, turnId: string) {
    return this.request(
      `/v1/sessions/${encodeURIComponent(id)}/turns/${encodeURIComponent(turnId)}/cancel`,
      { method: 'POST' },
    );
  }
  async approve(id: string, approvalId: string, allowed: boolean) {
    return this.request(`/v1/sessions/${encodeURIComponent(id)}/approvals`, {
      method: 'POST',
      body: JSON.stringify({ approvalId, allowed }),
    });
  }
  async *events(id: string, after = 0, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        new URL(`/v1/sessions/${encodeURIComponent(id)}/events?after=${after}`, this.baseURL),
        { headers: { ...this.headers, accept: 'text/event-stream' }, signal },
      );
    } catch (error) {
      if (signal?.aborted) return;
      throw error;
    }
    if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`);
    const queue: AgentEvent[] = [];
    let streamError: Error | undefined;
    const parser = createParser({
      onEvent: (event) => {
        const parsed = JSON.parse(event.data);
        if (event.event === 'stream.error') streamError = new Error(parsed.code);
        else queue.push(parsed);
      },
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let cursor = after;
    try {
      while (!signal?.aborted) {
        while (queue.length) {
          const event = queue.shift()!;
          if (event.seq > cursor) {
            cursor = event.seq;
            yield event;
          }
        }
        if (streamError) throw streamError;
        const chunk = await reader.read();
        if (chunk.done) break;
        parser.feed(decoder.decode(chunk.value, { stream: true }));
      }
    } catch (error) {
      if (!signal?.aborted) throw error;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}
