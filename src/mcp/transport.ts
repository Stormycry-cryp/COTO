import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AgentError } from '../core/errors.js';

export type McpMessage =
  | { jsonrpc: '2.0'; id: number | string; method: string; params?: Record<string, unknown> }
  | { jsonrpc: '2.0'; method: string; params?: Record<string, unknown> }
  | { jsonrpc: '2.0'; id: number | string | null; result: unknown }
  | { jsonrpc: '2.0'; id: number | string | null; error: { code: number; message: string; data?: unknown } };

/** Transport ownership belongs to one client; install callbacks before start(). */
export interface McpTransport {
  start(): Promise<void>;
  send(message: McpMessage): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: McpMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  setProtocolVersion?: (version: string) => void;
}

/** Host-supplied command only. No shell, downloads, discovery or automatic restart. */
export function stdioMcpTransport(options: {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  maxMessageBytes?: number;
  shutdownMs?: number;
}): McpTransport {
  const maxBytes = options.maxMessageBytes ?? 8_388_608;
  const shutdownMs = options.shutdownMs ?? 1000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(shutdownMs) || shutdownMs < 1)
    throw new AgentError('invalid_mcp_config', 'Invalid stdio transport limits', 422);
  let child: ChildProcessWithoutNullStreams | undefined;
  let buffer = Buffer.alloc(0);
  let ended = false;
  let closePromise: Promise<void> | undefined;
  const finish = () => {
    if (ended) return;
    ended = true;
    transport.onclose?.();
  };
  const fail = (error: Error) => {
    transport.onerror?.(error);
    // Protocol/pipe errors own the same bounded teardown as explicit close().
    // Do not leave a server alive merely because it ignores SIGTERM.
    void transport.close().catch(() => undefined);
  };
  const transport: McpTransport = {
    async start() {
      if (child || ended) throw new AgentError('mcp_transport_started', 'Transport is single-use', 409);
      child = spawn(options.command, options.args ?? [], {
        cwd: options.cwd, env: options.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Drain stderr without storing it in session/model logs (it may contain secrets).
      child.stderr.resume();
      child.on('error', fail);
      child.on('close', finish);
      child.stdin.on('error', fail);
      child.stdout.on('error', fail);
      child.stdout.on('data', (chunk: Buffer) => {
        if (ended) return;
        buffer = Buffer.concat([buffer, chunk]);
        let newline: number;
        while ((newline = buffer.indexOf(10)) >= 0) {
          if (newline > maxBytes) return fail(new AgentError('mcp_message_limit', 'MCP message exceeded limit', 502));
          const line = buffer.subarray(0, newline).toString('utf8');
          buffer = buffer.subarray(newline + 1);
          try {
            const message: unknown = JSON.parse(line);
            if (!message || typeof message !== 'object' || !('jsonrpc' in message) || message.jsonrpc !== '2.0')
              throw new Error('Invalid JSON-RPC message');
            transport.onmessage?.(message as McpMessage);
          } catch {
            return fail(new AgentError('mcp_protocol_error', 'Invalid MCP stdio frame', 502));
          }
        }
        if (buffer.length > maxBytes) fail(new AgentError('mcp_message_limit', 'MCP message exceeded limit', 502));
      });
      await new Promise<void>((resolve, reject) => {
        child!.once('spawn', resolve);
        child!.once('error', reject);
      });
    },
    send(message) {
      if (!child || ended || !child.stdin.writable)
        return Promise.reject(new AgentError('mcp_disconnected', 'MCP transport is disconnected', 409));
      const line = JSON.stringify(message) + '\n';
      if (Buffer.byteLength(line) > maxBytes)
        return Promise.reject(new AgentError('mcp_message_limit', 'MCP request exceeded limit', 422));
      return new Promise<void>((resolve, reject) => child!.stdin.write(line, (error) => error ? reject(error) : resolve()));
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = new Promise<void>((resolve) => {
        finish();
        if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
        const terminate = setTimeout(() => child?.kill('SIGTERM'), shutdownMs);
        const kill = setTimeout(() => child?.kill('SIGKILL'), shutdownMs * 2);
        child.once('close', () => { clearTimeout(terminate); clearTimeout(kill); resolve(); });
        child.stdin.end();
      });
      return closePromise;
    },
  };
  return transport;
}
