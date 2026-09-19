import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Tool } from '../core/types.js';
import { AgentError } from '../core/errors.js';
import { objectSchema, textResult, workspacePath } from './files.js';
type ProcessRecord = {
  child: ChildProcess;
  owner: string;
  output: string;
  dropped: number;
  exitCode: number | null;
  exited: boolean;
  done: Promise<void>;
};
export function processTools(
  env: Record<string, string> = { PATH: process.env.PATH ?? '' },
): Tool[] {
  const processes = new Map<string, ProcessRecord>();
  const kill = (record: ProcessRecord) => {
    if (record.exited) return;
    if (process.platform === 'win32')
      spawn('taskkill', ['/pid', String(record.child.pid), '/T', '/F'], { stdio: 'ignore' });
    else {
      try {
        process.kill(-record.child.pid!, 'SIGKILL');
      } catch {
        record.child.kill('SIGKILL');
      }
    }
  };
  const get = (id: string, owner: string) => {
    const item = processes.get(id);
    if (!item || item.owner !== owner)
      throw new AgentError('process_not_found', 'Process handle unavailable in this session', 404);
    return item;
  };
  const result = (id: string, item: ProcessRecord) =>
    textResult({
      processId: id,
      output: item.output,
      droppedChars: item.dropped,
      exited: item.exited,
      exitCode: item.exitCode,
    });
  return [
    {
      name: 'exec_command',
      description:
        'Run a shell command on the trusted host. Returns a process handle for long tasks. This is not an OS sandbox.',
      effect: 'execute',
      cancellable: true,
      parameters: objectSchema(
        {
          command: { type: 'string', minLength: 1, maxLength: 32_000 },
          cwd: { type: 'string' },
          yieldMs: { type: 'integer', minimum: 0, maximum: 5000 },
          timeoutMs: { type: 'integer', minimum: 1, maximum: 600_000 },
        },
        ['command'],
      ),
      async execute(args, ctx) {
        for (const [id, record] of processes)
          if (record.exited && processes.size >= 100) processes.delete(id);
        if (processes.size >= 100)
          throw new AgentError('process_limit', 'Process limit reached', 429);
        const cwd = await workspacePath(ctx.workspace, String(args.cwd ?? '.'));
        const child = spawn(String(args.command), {
          shell: true,
          cwd,
          env,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let resolve!: () => void;
        const record: ProcessRecord = {
          child,
          owner: ctx.sessionId,
          output: '',
          dropped: 0,
          exitCode: null,
          exited: false,
          done: new Promise<void>((r) => {
            resolve = r;
          }),
        };
        const id = randomUUID();
        processes.set(id, record);
        const collect = (data: Buffer) => {
          record.output += data.toString('utf8');
          if (record.output.length > 64_000) {
            record.dropped += record.output.length - 64_000;
            record.output = record.output.slice(-64_000);
          }
        };
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);
        const timer = setTimeout(() => kill(record), Number(args.timeoutMs ?? 120_000));
        const stop = () => kill(record);
        const signal = ctx.turnSignal ?? ctx.signal;
        signal.addEventListener('abort', stop, { once: true });
        const finish = (code: number | null) => {
          record.exitCode = code;
          record.exited = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', stop);
          resolve();
        };
        child.once('error', (e) => {
          collect(Buffer.from(e.message));
          finish(-1);
        });
        child.once('close', finish);
        if (signal.aborted) stop();
        let yieldTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          record.done,
          new Promise<void>((r) => {
            yieldTimer = setTimeout(r, Number(args.yieldMs ?? 1000));
          }),
        ]);
        clearTimeout(yieldTimer);
        return result(id, record);
      },
      async close() {
        for (const record of processes.values()) kill(record);
        await Promise.all([...processes.values()].map((p) => p.done));
      },
    },
    {
      name: 'process_read',
      description: 'Read the bounded current output and state of a process handle.',
      effect: 'read',
      parameters: objectSchema({ processId: { type: 'string' } }, ['processId']),
      async execute(args, ctx) {
        return result(String(args.processId), get(String(args.processId), ctx.sessionId));
      },
    },
    {
      name: 'process_cancel',
      description: 'Terminate a process and its process group.',
      effect: 'execute',
      parameters: objectSchema({ processId: { type: 'string' } }, ['processId']),
      async execute(args, ctx) {
        const item = get(String(args.processId), ctx.sessionId);
        kill(item);
        await item.done;
        return result(String(args.processId), item);
      },
    },
  ];
}
