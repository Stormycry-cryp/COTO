import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import type { Tool } from '../core/types.js';
import { AgentError } from '../core/errors.js';
import { objectSchema, textResult } from './files.js';

const reservedAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  reservedAddresses.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  reservedAddresses.addSubnet(network, prefix, 'ipv6');

function publicAddress(address: string) {
  if (isIPv4(address)) return !reservedAddresses.check(address, 'ipv4');
  if (!isIPv6(address)) return false;
  const first = Number.parseInt(address.split(':', 1)[0], 16);
  return first >= 0x2000 && first <= 0x3fff && !reservedAddresses.check(address, 'ipv6');
}
export async function boundedHttp(
  urlValue: string,
  options: {
    signal: AbortSignal;
    allowPrivate?: boolean;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    maxBytes?: number;
  },
) {
  const url = new URL(urlValue);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new AgentError('invalid_url', 'Only HTTP(S) URLs without credentials are supported', 422);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true });
  if (
    !addresses.length ||
    (!options.allowPrivate && addresses.some((a) => !publicAddress(a.address)))
  )
    throw new AgentError('network_denied', 'Private or reserved network target denied', 403);
  const address = addresses[0];
  return new Promise<{ status: number; text: string; contentType: string }>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
        signal: options.signal,
        // Pin the checked address so a second DNS lookup cannot change the destination.
        lookup: (_host, _opts, callback) => {
          callback(null, address.address, address.family);
        },
      },
      (response) => {
        if ((response.statusCode ?? 500) >= 300 && (response.statusCode ?? 500) < 400) {
          response.destroy();
          reject(
            new AgentError(
              'redirect_denied',
              'Redirects require an explicitly configured final URL',
              422,
            ),
          );
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > (options.maxBytes ?? 1_048_576))
            response.destroy(new AgentError('response_limit', 'HTTP response is too large', 422));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 500,
            text: Buffer.concat(chunks).toString('utf8'),
            contentType: String(response.headers['content-type'] ?? ''),
          }),
        );
      },
    );
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}
export function httpTool(options: { allowPrivate?: boolean } = {}): Tool {
  return {
    name: 'http_fetch',
    description: 'Fetch a public HTTP(S) resource, with a bounded response and no redirects.',
    effect: 'network',
    cancellable: true,
    parameters: objectSchema({ url: { type: 'string', maxLength: 8192 } }, ['url']),
    async execute(args, ctx) {
      return textResult(
        await boundedHttp(String(args.url), {
          signal: ctx.signal,
          allowPrivate: options.allowPrivate,
        }),
      );
    },
  };
}
export function remoteTool(
  config: Omit<Tool, 'execute'> & {
    endpoint: string;
    headerEnv?: Record<string, string>;
    allowPrivate?: boolean;
  },
): Tool {
  const { endpoint, headerEnv, allowPrivate, ...spec } = config;
  return {
    ...spec,
    cancellable: false,
    async execute(args, ctx) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'idempotency-key': ctx.invocationId,
      };
      for (const [header, key] of Object.entries(headerEnv ?? {})) {
        if (!process.env[key])
          throw new AgentError('missing_credential', `Missing environment variable: ${key}`, 422);
        headers[header] = process.env[key]!;
      }
      try {
        const response = await boundedHttp(endpoint, {
          signal: ctx.signal,
          allowPrivate,
          method: 'POST',
          headers,
          body: JSON.stringify({
            invocationId: ctx.invocationId,
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            arguments: args,
          }),
        });
        if (response.status === 202)
          throw new AgentError(
            'outcome_unknown',
            'Remote tool returned pending; verify its outcome before resuming',
            409,
          );
        if (response.status < 200 || response.status >= 300)
          throw new AgentError('remote_error', `Remote tool returned HTTP ${response.status}`, 502);
        const result = JSON.parse(response.text);
        if (
          !result ||
          !Array.isArray(result.content) ||
          result.content.some(
            (p: unknown) =>
              !p ||
              typeof p !== 'object' ||
              !('type' in p) ||
              p.type !== 'text' ||
              !('text' in p) ||
              typeof p.text !== 'string',
          )
        )
          throw new AgentError(
            'invalid_tool_result',
            'Remote tool must return text content parts',
            502,
          );
        return result;
      } catch (error) {
        if (
          spec.effect === 'read' ||
          (error instanceof AgentError && ['invalid_url', 'network_denied'].includes(error.code))
        )
          throw error;
        throw new AgentError(
          'outcome_unknown',
          'Remote tool outcome is unknown; verify the invocation at the business service before resuming',
          409,
        );
      }
    },
  };
}
