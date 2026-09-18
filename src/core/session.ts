import { Ajv } from 'ajv';
import { Serial, abortable, deferred, delay } from './async.js';
import { AgentError, errorMessage } from './errors.js';
import { ContextManager, type ContextOptions } from './context.js';
import type {
  AgentEvent,
  ContentPart,
  InputReceipt,
  InputRequest,
  Message,
  ModelProvider,
  Policy,
  SessionMeta,
  SessionStore,
  Tool,
  ToolCall,
  ToolContext,
  ToolResult,
  TurnResult,
} from './types.js';

export interface RuntimeOptions {
  provider: ModelProvider;
  tools?: Tool[];
  policy?: Policy | 'read-only' | 'ask' | 'allow-all';
  context?: ContextOptions;
  maxSteps?: number;
  maxTurnMs?: number;
  toolTimeoutMs?: number;
  maxOutputChars?: number;
  maxQueue?: number;
  maxRetries?: number;
  maxConcurrentTools?: number;
}
type Pending = { request: InputRequest; receipt: InputReceipt };
type Active = {
  id: string;
  inputId: string;
  controller: AbortController;
  promise?: Promise<void>;
  result: ReturnType<typeof deferred<TurnResult>>;
};

function sameInput(a: InputRequest, b: InputRequest) {
  return (
    a.mode === b.mode &&
    a.expectedTurnId === b.expectedTurnId &&
    a.content.length === b.content.length &&
    a.content.every((part, index) => {
      const other = b.content[index];
      return part.type === 'text'
        ? other.type === 'text' && part.text === other.text
        : other.type === 'image' && part.data === other.data && part.mimeType === other.mimeType;
    })
  );
}

export class Session {
  readonly id: string;
  private events: AgentEvent[];
  private messages: Message[] = [];
  private pending: Pending[] = [];
  private inputs = new Map<string, Pending>();
  private results = new Map<string, TurnResult>();
  private approvals = new Map<
    string,
    { turnId: string; gate: ReturnType<typeof deferred<boolean>> }
  >();
  private unresolved = new Map<string, { call: ToolCall; turnId: string }>();
  private detachedTools = new Map<string, Promise<ToolResult>>();
  private listeners = new Set<(event: AgentEvent) => void>();
  private control = new Serial();
  private writer = new Serial();
  private active?: Active;
  private paused = false;
  private archived = false;
  private closed = false;
  private fatal?: unknown;
  private validators = new Map<string, ReturnType<Ajv['compile']>>();
  private tools = new Map<string, Tool>();
  private context: ContextManager;

  private constructor(
    readonly meta: SessionMeta,
    private store: SessionStore,
    private options: RuntimeOptions,
    events: AgentEvent[],
    private release: () => Promise<void>,
  ) {
    this.id = meta.id;
    this.events = events;
    this.context = new ContextManager(options.context);
    const ajv = new Ajv({ allErrors: true, strict: false });
    for (const tool of options.tools ?? []) {
      if (this.tools.has(tool.name))
        throw new AgentError('duplicate_tool', `Duplicate tool: ${tool.name}`, 422);
      this.tools.set(tool.name, tool);
      this.validators.set(tool.name, ajv.compile(tool.parameters));
    }
    for (const event of events) this.reduce(event);
  }
  static async open(meta: SessionMeta, store: SessionStore, options: RuntimeOptions) {
    const release = await store.acquire(meta.id);
    try {
      const record = await store.read(meta.id);
      const session = new Session(record.meta, store, options, record.events, release);
      const started = record.events.filter((e) => e.type === 'turn.started').at(-1);
      if (started?.turnId && !session.results.has(started.turnId)) {
        for (const item of [...session.pending])
          if (item.request.mode === 'steer') {
            await session.emit(
              'input.rejected',
              { inputId: item.request.inputId, reason: 'process_restart' },
              { turnId: started.turnId },
            );
          }
        await session.cancelUnstartedTools(started.turnId);
        await session.emit(
          'turn.interrupted',
          {
            result: {
              turnId: started.turnId,
              status: 'interrupted',
              text: '',
              reason: 'process_restart',
            },
          },
          { turnId: started.turnId },
        );
      }
      if (session.unresolved.size)
        await session.emit('recovery.required', { invocations: [...session.unresolved.keys()] });
      return session;
    } catch (error) {
      await release();
      throw error;
    }
  }
  private reduce(event: AgentEvent) {
    const data = event.data;
    if (event.type === 'input.accepted') {
      const request = data.request as unknown as InputRequest;
      const item: Pending = {
        request,
        receipt: { inputId: request.inputId, acceptedSeq: event.seq, status: 'pending' },
      };
      this.inputs.set(request.inputId, item);
      request.mode === 'interrupt' ? this.pending.unshift(item) : this.pending.push(item);
    }
    if (['input.applied', 'input.rejected', 'input.withdrawn'].includes(event.type)) {
      const item = this.inputs.get(data.inputId as string);
      if (item) {
        item.receipt.status = event.type.split('.')[1] as InputReceipt['status'];
        item.receipt.turnId = event.turnId;
        this.pending = this.pending.filter((p) => p !== item);
      }
    }
    if (
      data.message &&
      [
        'message.committed',
        'input.applied',
        'tool.completed',
        'tool.failed',
        'tool.cancelled',
        'tool.reconciled',
      ].includes(event.type)
    ) {
      const message = data.message as unknown as Message;
      if (!this.messages.some((m) => m.id === message.id)) this.messages.push(message);
    }
    if (event.type === 'context.compacted' || event.type === 'session.forked')
      this.messages = data.messages as unknown as Message[];
    if (event.type === 'tool.started')
      this.unresolved.set(data.invocationId as string, {
        call: data.call as ToolCall,
        turnId: event.turnId!,
      });
    if (['tool.completed', 'tool.failed', 'tool.cancelled', 'tool.reconciled'].includes(event.type))
      this.unresolved.delete(data.invocationId as string);
    if (event.type === 'tool.outcome_unknown') this.paused = true;
    if (data.result && ['turn.completed', 'turn.failed', 'turn.interrupted'].includes(event.type)) {
      this.results.set(event.turnId!, data.result as unknown as TurnResult);
      this.paused = event.type !== 'turn.completed';
    }
    if (event.type === 'session.archived') this.archived = true;
    if (event.type === 'provider.changed') {
      this.meta.providerId = data.providerId as string;
      this.meta.model = data.model as string;
    }
  }
  private emit(
    type: string,
    data: Record<string, unknown>,
    scope: Partial<Pick<AgentEvent, 'turnId' | 'stepId' | 'attemptId' | 'messageId'>> = {},
  ) {
    return this.writer.run(async () => {
      if (this.fatal) throw this.fatal;
      const seq = this.events.length + 1;
      const event: AgentEvent = {
        schemaVersion: 1,
        sessionId: this.id,
        eventId: `${this.id}:${seq}`,
        seq,
        timestamp: new Date().toISOString(),
        type,
        data,
        ...scope,
      };
      try {
        await this.store.append(this.id, event);
      } catch (error) {
        this.fatal = error;
        this.active?.controller.abort();
        for (const listener of this.listeners) {
          try {
            listener({
              ...event,
              type: 'session.error',
              seq: this.events.length,
              eventId: '',
              data: { code: 'storage_error' },
            });
          } catch {}
        }
        throw error;
      }
      this.events.push(event);
      this.reduce(event);
      for (const listener of this.listeners) {
        try {
          listener(structuredClone(event));
        } catch {
          /* Observers cannot alter execution. */
        }
      }
      return event;
    });
  }
  snapshot() {
    return structuredClone({
      meta: this.meta,
      seq: this.events.length,
      status: this.closed
        ? 'closed'
        : this.archived
          ? 'archived'
          : this.active
            ? 'active'
            : this.paused
              ? 'interrupted'
              : 'idle',
      activeTurnId: this.active?.id,
      messages: this.messages,
      pendingInputs: this.pending.map((p) => ({
        ...p.receipt,
        mode: p.request.mode,
        content: p.request.content,
      })),
      approvals: [...this.approvals].map(([id, a]) => ({ id, turnId: a.turnId })),
      unresolved: [...this.unresolved].map(([invocationId, value]) => ({ invocationId, ...value })),
      results: [...this.results.values()],
    });
  }
  history(after = 0) {
    return structuredClone(this.events.filter((e) => e.seq > after));
  }
  subscribe(listener: (event: AgentEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async *streamEvents(after = 0, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    let wake = deferred<void>();
    const queue: AgentEvent[] = [];
    let overflow = false;
    let storageError = !!this.fatal;
    const off = this.subscribe((event) => {
      if (event.type === 'session.error') storageError = true;
      else if (queue.length >= 256) overflow = true;
      else queue.push(event);
      wake.resolve();
    });
    let cursor = after;
    const wakeOnAbort = () => wake.resolve();
    signal?.addEventListener('abort', wakeOnAbort);
    try {
      for (const event of this.history(after)) {
        if (signal?.aborted) return;
        cursor = event.seq;
        yield event;
      }
      while (!signal?.aborted && !this.closed) {
        if (overflow)
          throw new AgentError('slow_consumer', 'Reconnect using the last event ID', 429);
        while (queue.length) {
          if (signal?.aborted || this.closed) return;
          const event = queue.shift()!;
          if (event.seq > cursor) {
            cursor = event.seq;
            yield event;
          }
        }
        if (signal?.aborted || this.closed) return;
        if (storageError)
          throw new AgentError('storage_error', 'Session event storage failed', 500);
        wake = deferred<void>();
        await wake.promise;
      }
    } finally {
      off();
      signal?.removeEventListener('abort', wakeOnAbort);
    }
  }
  async submitInput(request: InputRequest): Promise<InputReceipt> {
    return this.control.run(async () => {
      if (this.closed || this.archived || this.fatal)
        throw new AgentError('session_unavailable', 'Session is not accepting input', 409);
      if (
        !request ||
        typeof request !== 'object' ||
        typeof request.inputId !== 'string' ||
        !/^[\w-]{1,100}$/.test(request.inputId) ||
        !['steer', 'follow_up', 'interrupt'].includes(request.mode) ||
        !Array.isArray(request.content) ||
        !request.content.length ||
        JSON.stringify(request).length > 128_000 ||
        request.content.some(
          (p) =>
            !p ||
            (p.type !== 'text' && p.type !== 'image') ||
            (p.type === 'text'
              ? typeof p.text !== 'string'
              : typeof p.data !== 'string' || typeof p.mimeType !== 'string'),
        )
      )
        throw new AgentError('invalid_input', 'Invalid or oversized input', 422);
      const prior = this.inputs.get(request.inputId);
      if (prior) {
        if (!sameInput(prior.request, request))
          throw new AgentError(
            'idempotency_conflict',
            'Input ID reused with different content',
            409,
          );
        return structuredClone(prior.receipt);
      }
      if (this.pending.length >= (this.options.maxQueue ?? 32))
        throw new AgentError('queue_full', 'Input queue is full', 429);
      if (
        request.mode !== 'follow_up' &&
        (!this.active ||
          this.active.id !== request.expectedTurnId ||
          this.active.controller.signal.aborted)
      )
        throw new AgentError('turn_conflict', 'Target turn is no longer active', 409);
      await this.emit('input.accepted', { request: structuredClone(request) });
      if (request.mode === 'interrupt') {
        await this.emit('turn.interrupting', {}, { turnId: this.active!.id });
        this.active!.controller.abort();
      }
      if (!this.active && !this.paused) this.schedule();
      return structuredClone(this.inputs.get(request.inputId)!.receipt);
    });
  }
  private schedule() {
    if (this.active || this.closed || this.archived || this.unresolved.size || this.fatal) return;
    const next = this.pending.find((p) => p.request.mode !== 'steer');
    if (!next || (this.paused && next.request.mode !== 'interrupt')) return;
    const active: Active = {
      id: crypto.randomUUID(),
      inputId: next.request.inputId,
      controller: new AbortController(),
      result: deferred<TurnResult>(),
    };
    this.active = active;
    this.paused = false;
    active.promise = this.execute(active, next)
      .catch((error) => {
        active.result.resolve({
          turnId: active.id,
          status: 'failed',
          text: '',
          reason: errorMessage(error),
        });
      })
      .finally(() =>
        this.control.run(async () => {
          if (this.active === active) this.active = undefined;
          this.schedule();
        }),
      );
  }
  private async applyInput(item: Pending, turnId: string) {
    if (item.receipt.status !== 'pending')
      throw new AgentError('input_cancelled', 'Input cancelled before application', 409);
    const message: Message = {
      id: item.request.inputId,
      role: 'user',
      content: item.request.content,
    };
    await this.emit('input.applied', { inputId: item.request.inputId, message }, { turnId });
  }
  private async execute(active: Active, initial: Pending) {
    const timer = setTimeout(() => active.controller.abort(), this.options.maxTurnMs ?? 600_000);
    const signal = active.controller.signal;
    let text = '';
    let result: TurnResult;
    try {
      await this.emit('turn.started', {}, { turnId: active.id });
      await this.control.run(() => this.applyInput(initial, active.id));
      const provider = this.options.provider;
      if (provider.id !== this.meta.providerId || provider.model !== this.meta.model)
        throw new AgentError(
          'provider_mismatch',
          'Explicitly switch provider before resuming this session',
          409,
        );
      for (let step = 0; ; step++) {
        signal.throwIfAborted();
        if (step >= (this.options.maxSteps ?? 32))
          throw new AgentError('step_limit', 'Maximum model steps reached', 422);
        await this.control.run(async () => {
          for (const item of [...this.pending])
            if (item.request.mode === 'steer') await this.applyInput(item, active.id);
        });
        const stepId = crypto.randomUUID();
        const specs = [...this.tools.values()].map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        }));
        let prepared: Awaited<ReturnType<ContextManager['prepare']>>;
        // Rebuild until every steer accepted during context preparation is included.
        while (true) {
          signal.throwIfAborted();
          prepared = await this.context.prepare(
            provider,
            this.messages,
            specs,
            this.meta.workspace,
            signal,
          );
          if (prepared.compacted)
            await this.emit(
              'context.compacted',
              { messages: prepared.compacted },
              { turnId: active.id, stepId },
            );
          const added = await this.control.run(async () => {
            const items = this.pending.filter((p) => p.request.mode === 'steer');
            for (const item of items) await this.applyInput(item, active.id);
            return items.length > 0;
          });
          if (!added) break;
        }
        const message = await this.sample(active.id, stepId, prepared.request, signal);
        await this.emit(
          'message.committed',
          { message },
          { turnId: active.id, stepId, messageId: message.id },
        );
        await this.emit(
          'message.completed',
          {
            messageId: message.id,
            text: message.content
              .filter((p) => p.type === 'text')
              .map((p) => p.text)
              .join(''),
          },
          { turnId: active.id, stepId, messageId: message.id },
        );
        text = message.content
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('');
        const calls = message.toolCalls ?? [];
        // Run read-only calls in bounded groups; mutations remain serial.
        for (let i = 0; i < calls.length; ) {
          signal.throwIfAborted();
          const group: ToolCall[] = [calls[i++]];
          const parallel = (call: ToolCall) =>
            this.tools.get(call.name)?.effect === 'read' && this.tools.get(call.name)?.parallel;
          if (parallel(group[0]))
            while (
              i < calls.length &&
              parallel(calls[i]) &&
              group.length < (this.options.maxConcurrentTools ?? 4)
            )
              group.push(calls[i++]);
          const settled = await Promise.allSettled(
            group.map((call) => this.executeTool(call, active, stepId)),
          );
          const failure = settled.find((r) => r.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
        }
        if (!calls.length) {
          const completed = await this.control.run(async () => {
            signal.throwIfAborted();
            if (this.pending.some((p) => p.request.mode === 'steer')) return false;
            result = { turnId: active.id, status: 'completed', text };
            await this.emit('turn.completed', { result }, { turnId: active.id });
            // Prevent a steer accepted after completion but before the finally handler.
            this.active = undefined;
            return true;
          });
          if (completed) {
            active.result.resolve(result!);
            return;
          }
        }
      }
    } catch (error) {
      result = {
        turnId: active.id,
        status: signal.aborted ? 'interrupted' : 'failed',
        text,
        reason: signal.aborted ? 'cancelled' : errorMessage(error),
      };
      await this.control.run(async () => {
        for (const item of [...this.pending])
          if (item.request.mode === 'steer')
            await this.emit(
              'input.rejected',
              { inputId: item.request.inputId, reason: 'target_turn_ended' },
              { turnId: active.id },
            );
        await this.cancelUnstartedTools(active.id);
        await this.emit(`turn.${result.status}`, { result }, { turnId: active.id });
      });
      active.result.resolve(result);
    } finally {
      clearTimeout(timer);
      for (const [id, approval] of this.approvals)
        if (approval.turnId === active.id) {
          approval.gate.resolve(false);
          this.approvals.delete(id);
        }
    }
  }
  private async sample(
    turnId: string,
    stepId: string,
    request: Parameters<ModelProvider['stream']>[0],
    signal: AbortSignal,
  ) {
    for (let attempt = 0; ; attempt++) {
      const attemptId = crypto.randomUUID();
      let done:
        | Extract<
            Awaited<ReturnType<ModelProvider['stream']>> extends AsyncIterable<infer E> ? E : never,
            { type: 'done' }
          >
        | undefined;
      try {
        for await (const event of this.options.provider.stream(request, { signal })) {
          signal.throwIfAborted();
          if (event.type === 'text_delta')
            await this.emit('text.delta', { text: event.text }, { turnId, stepId, attemptId });
          if (event.type === 'tool_delta')
            await this.emit(
              'tool.arguments.delta',
              { toolCallId: event.id, text: event.text },
              { turnId, stepId, attemptId },
            );
          if (event.type === 'done') done = event;
        }
        if (!done)
          throw new AgentError(
            'incomplete_stream',
            'Provider stream ended without a completed response',
            502,
            true,
          );
        if (done.stopReason === 'length')
          throw new AgentError('output_limit', 'Model output limit reached', 422);
        if (done.usage) await this.emit('usage.updated', done.usage, { turnId, stepId, attemptId });
        return done.message;
      } catch (error) {
        await this.emit('model.attempt_discarded', {}, { turnId, stepId, attemptId });
        if (
          signal.aborted ||
          !(error instanceof AgentError && error.retryable) ||
          attempt >= (this.options.maxRetries ?? 2)
        )
          throw error;
        await this.emit('model.retrying', { attempt: attempt + 1 }, { turnId, stepId });
        await delay(Math.min(500 * 2 ** attempt, 4000), signal);
      }
    }
  }
  private toolMessage(call: ToolCall, result: ToolResult): Message {
    return {
      id: crypto.randomUUID(),
      role: 'tool',
      content: result.content,
      toolCallId: call.id,
      toolName: call.name,
      isError: result.isError,
    };
  }
  private async cancelUnstartedTools(turnId: string) {
    for (const message of [...this.messages])
      for (const call of message.toolCalls ?? []) {
        if (
          !this.messages.some((m) => m.toolCallId === call.id) &&
          ![...this.unresolved.values()].some((v) => v.call.id === call.id)
        )
          await this.emit(
            'message.committed',
            {
              message: this.toolMessage(call, {
                content: [{ type: 'text', text: 'Cancelled before execution' }],
                isError: true,
              }),
            },
            { turnId },
          );
      }
  }
  private async executeTool(call: ToolCall, active: Active, stepId: string) {
    const tool = this.tools.get(call.name);
    const validate = this.validators.get(call.name);
    const invocationId = `${active.id}_${call.id.replace(/[^\w-]/g, '_')}`;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    active.controller.signal.addEventListener('abort', onAbort, { once: true });
    const scope = { turnId: active.id, stepId };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = false;
    const context: ToolContext = {
      workspace: this.meta.workspace,
      sessionId: this.id,
      turnId: active.id,
      invocationId,
      signal: controller.signal,
      turnSignal: active.controller.signal,
      progress: async (data) => {
        if (!controller.signal.aborted)
          await this.emit('tool.progress', { invocationId, progress: data }, scope);
      },
    };
    try {
      active.controller.signal.throwIfAborted();
      if (!tool || !validate)
        throw new AgentError('unknown_tool', `Unknown tool: ${call.name}`, 422);
      if (!validate(call.arguments))
        throw new AgentError(
          'invalid_arguments',
          `Invalid tool arguments: ${JSON.stringify(validate.errors)}`,
          422,
        );
      const policy = this.options.policy ?? 'read-only';
      const decision =
        typeof policy === 'function'
          ? await policy(tool, call.arguments, context)
          : policy === 'allow-all'
            ? 'allow'
            : tool.effect === 'read'
              ? 'allow'
              : policy === 'ask'
                ? 'ask'
                : 'deny';
      if (!['allow', 'deny', 'ask'].includes(decision))
        throw new AgentError(
          'invalid_policy',
          'Policy must explicitly return allow, deny or ask',
          422,
        );
      if (decision === 'deny') throw new AgentError('tool_denied', 'Tool denied by policy', 403);
      if (decision === 'ask') {
        const approvalId = crypto.randomUUID();
        const gate = deferred<boolean>();
        this.approvals.set(approvalId, { turnId: active.id, gate });
        try {
          await this.emit(
            'approval.required',
            { approvalId, tool: call.name, arguments: call.arguments },
            scope,
          );
          if (!(await abortable(gate.promise, active.controller.signal)))
            throw new AgentError('tool_denied', 'Approval denied', 403);
        } finally {
          this.approvals.delete(approvalId);
        }
      }
      active.controller.signal.throwIfAborted();
      await this.emit('tool.started', { invocationId, call }, scope);
      started = true;
      timer = setTimeout(() => controller.abort(), this.options.toolTimeoutMs ?? 60_000);
      const task = Promise.resolve().then(() => tool.execute(call.arguments, context));
      let result: ToolResult;
      try {
        result = await abortable(task, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const settled = await Promise.race([
          task.then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason) => ({ status: 'rejected' as const, reason }),
          ),
          new Promise<{ status: 'pending' }>((resolve) => {
            graceTimer = setTimeout(() => resolve({ status: 'pending' }), 1500);
          }),
        ]);
        clearTimeout(graceTimer);
        if (settled.status === 'fulfilled') result = settled.value;
        else {
          if (settled.status === 'pending') {
            this.detachedTools.set(invocationId, task);
            void task.then(
              () => this.detachedTools.delete(invocationId),
              () => this.detachedTools.delete(invocationId),
            );
          }
          if (settled.status === 'pending' || tool.effect !== 'read')
            throw new AgentError(
              'outcome_unknown',
              'Tool outcome requires reconciliation before continuing',
              409,
            );
          throw error;
        }
      }
      const serialized = JSON.stringify(result.content);
      if (serialized.length > (this.options.maxOutputChars ?? 12_000)) {
        const artifactId = await this.store.putArtifact(this.id, serialized);
        result = {
          ...result,
          content: [
            {
              type: 'text',
              text:
                serialized.slice(0, this.options.maxOutputChars ?? 12_000) +
                `\n[Output truncated. Artifact: ${artifactId}]`,
            },
          ],
          metadata: { ...result.metadata, artifactId },
        };
      }
      await this.emit(
        result.isError ? 'tool.failed' : 'tool.completed',
        { invocationId, message: this.toolMessage(call, result), metadata: result.metadata },
        scope,
      );
    } catch (error) {
      if (error instanceof AgentError && error.code === 'outcome_unknown') {
        await this.emit('tool.outcome_unknown', { invocationId, tool: call.name }, scope);
        throw error;
      }
      const result = {
        content: [{ type: 'text' as const, text: errorMessage(error) }],
        isError: true,
      };
      await this.emit(
        controller.signal.aborted ? 'tool.cancelled' : 'tool.failed',
        { invocationId, message: this.toolMessage(call, result), executed: started },
        scope,
      );
      if (active.controller.signal.aborted) throw error;
    } finally {
      clearTimeout(timer);
      active.controller.signal.removeEventListener('abort', onAbort);
    }
  }
  async approve(id: string, allowed: boolean) {
    return this.control.run(async () => {
      const approval = this.approvals.get(id);
      if (!approval || this.active?.id !== approval.turnId || this.active.controller.signal.aborted)
        throw new AgentError('approval_expired', 'Approval no longer applies', 409);
      await this.emit(
        'approval.resolved',
        { approvalId: id, allowed },
        { turnId: approval.turnId },
      );
      approval.gate.resolve(allowed);
      this.approvals.delete(id);
    });
  }
  async cancel(turnId: string) {
    return this.control.run(async () => {
      if (this.active?.id !== turnId) {
        if (this.results.has(turnId)) return;
        throw new AgentError('turn_conflict', 'Turn not active', 409);
      }
      await this.emit('turn.interrupting', {}, { turnId });
      this.active.controller.abort();
    });
  }
  async withdraw(inputId: string) {
    return this.control.run(async () => {
      if (this.inputs.get(inputId)?.receipt.status !== 'pending')
        throw new AgentError('input_conflict', 'Input already applied or not found', 409);
      await this.emit('input.withdrawn', { inputId });
      if (this.active?.inputId === inputId) this.active.controller.abort();
    });
  }
  async reconcile(invocationId: string, outcome: string) {
    return this.control.run(async () => {
      if (this.active)
        throw new AgentError('session_busy', 'Wait for the active turn to stop', 409);
      if (this.detachedTools.has(invocationId))
        throw new AgentError(
          'tool_still_running',
          'The local tool is still running; wait for it to stop before reconciling',
          409,
        );
      const unresolved = this.unresolved.get(invocationId);
      if (!unresolved || !outcome || outcome.length > 12_000)
        throw new AgentError(
          'invalid_reconciliation',
          'Provide a bounded verified outcome for an unresolved tool',
          422,
        );
      await this.emit(
        'tool.reconciled',
        {
          invocationId,
          message: this.toolMessage(unresolved.call, {
            content: [{ type: 'text', text: outcome }],
          }),
        },
        { turnId: unresolved.turnId },
      );
    });
  }
  async resume() {
    return this.control.run(async () => {
      if (this.active || this.archived || this.closed || this.unresolved.size)
        throw new AgentError(
          'recovery_required',
          'Session cannot resume while active, archived or unreconciled',
          409,
        );
      this.paused = false;
      if (!this.pending.length) {
        const request: InputRequest = {
          inputId: crypto.randomUUID(),
          mode: 'follow_up',
          content: [
            {
              type: 'text',
              text: 'Continue the interrupted task using recorded results. Do not repeat completed actions.',
            },
          ],
        };
        await this.emit('input.accepted', { request });
      }
      this.schedule();
    });
  }
  async switchProvider(provider: ModelProvider) {
    return this.control.run(async () => {
      if (this.active || this.unresolved.size)
        throw new AgentError('session_busy', 'Switch provider only while idle and reconciled', 409);
      await this.emit('provider.changed', { providerId: provider.id, model: provider.model });
      this.options = { ...this.options, provider };
    });
  }
  async archive() {
    await this.control.run(async () => {
      if (this.active) throw new AgentError('session_busy', 'Session is active', 409);
      await this.emit('session.archived', {});
    });
  }
  async seedFork(messages: Message[]) {
    await this.emit('session.forked', { messages: structuredClone(messages) });
  }
  async run(input: string | ContentPart[]): Promise<TurnResult> {
    const receipt = await this.submitInput({
      inputId: crypto.randomUUID(),
      mode: 'follow_up',
      content: typeof input === 'string' ? [{ type: 'text', text: input }] : input,
    });
    return this.waitForInput(receipt.inputId);
  }
  private async waitForInput(inputId: string) {
    const check = () => {
      const receipt = this.inputs.get(inputId)?.receipt;
      if (receipt && ['rejected', 'withdrawn'].includes(receipt.status))
        throw new AgentError('input_cancelled', 'Input cancelled', 409);
      const result = receipt?.turnId ? this.results.get(receipt.turnId) : undefined;
      if (result) return result;
      if (this.closed || this.fatal)
        throw new AgentError('session_unavailable', 'Session stopped before input completed', 409);
    };
    const existing = check();
    if (existing) return existing;
    const done = deferred<TurnResult>();
    const off = this.subscribe(() => {
      try {
        const result = check();
        if (result) done.resolve(result);
      } catch (error) {
        done.reject(error);
      }
    });
    try {
      const result = check();
      if (result) return result;
      return await done.promise;
    } finally {
      off();
    }
  }
  async *runStream(input: string): AsyncGenerator<AgentEvent> {
    const after = this.events.length;
    const receipt = await this.submitInput({
      inputId: crypto.randomUUID(),
      mode: 'follow_up',
      content: [{ type: 'text', text: input }],
    });
    for await (const event of this.streamEvents(after)) {
      yield event;
      const turnId = this.inputs.get(receipt.inputId)?.receipt.turnId;
      if (
        event.turnId === turnId &&
        ['turn.completed', 'turn.failed', 'turn.interrupted'].includes(event.type)
      )
        return;
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.active?.controller.abort();
    await this.active?.promise;
    for (const listener of this.listeners) {
      try {
        listener({
          schemaVersion: 1,
          sessionId: this.id,
          eventId: '',
          seq: this.events.length,
          timestamp: new Date().toISOString(),
          type: 'session.closed',
          data: {},
        });
      } catch {}
    }
    await this.writer.run(async () => {});
    await this.release();
  }
}
