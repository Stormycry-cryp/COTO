# Standard MCP tools

`@coto/agent/mcp` is an independent entrypoint. It uses existing Node/Ajv dependencies and does not import local filesystem/process tools or require an MCP SDK installation. It implements the bounded tools slice of standard MCP over an injected transport, including a built-in stdio transport.

```ts
import { McpClient, stdioMcpTransport } from '@coto/agent/mcp';

const client = new McpClient({
  transport: stdioMcpTransport({ command: 'node', args: ['/absolute/path/to/server.mjs'] }),
  tools: {
    inspect: { effect: 'read', parallel: true },
    edit: {
      effect: 'write',
      arguments: (args, context) => ({ ...args, invocationId: context.invocationId }),
    },
  },
  media: { maxImages: 2, maxImageBytes: 1_048_576 },
});
try {
  const tools = await client.connect();
  // Pass tools to createAgent/Session. Use projectInstructions:false when the host
  // must not interpret imported project files as trusted instructions.
} finally {
  await client.close();
}
```

The command, working directory, environment, tool allowlist, effects and argument mapping come from trusted host configuration. No tool is exposed unless its exact name is allowlisted. `readOnlyHint` and server instructions do not grant permission. Parallel execution is restricted to host-approved reads. The host remains responsible for business authorization, instance binding and revision/job contracts. Arguments are checked both before and after host mapping; invalid host additions fail before dispatch. Legitimate operation IDs must be fields accepted by the advertised schema. Mapping cannot substitute for server-side validation.

Initialization negotiates one of `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` and requires the tools capability. Tool discovery supports bounded pagination; schemas without `$schema` use JSON Schema 2020-12. Draft-07 schemas are also accepted. Input arguments and advertised structured output schemas are validated; `isError:true` results may omit the successful structured payload. Protocol-level sampling/elicitation requests are rejected, and server instructions are never injected into model context.

`notifications/tools/list_changed` refreshes discovery and invalidates previously returned tool handles. `onToolsChanged` receives the new array; the host must update its registration (for the current immutable Session tool registry, create a new session/runtime). A discovery failure leaves handles invalid; explicitly refresh again before use. A list change during discovery fails closed rather than exposing a mixed list.

`notifications/progress` is correlated by request token and forwarded to `ToolContext.progress`. Request cancellation sends `notifications/cancelled` and ignores late responses. Initialization is never cancelled via notification. Cancellation is a request to stop, not evidence that a business operation was undone. Write/execute/network failure after dispatch returns `AgentError('outcome_unknown')`; reconcile the invocation/job at the business service before continuing. The client never reconnects, retries or replays a call automatically. Create a new client to reconnect. Tool-level `isError` is a known response; JSON-RPC errors are distinct protocol errors. Stdout must contain only JSONL protocol frames; stderr is drained without being retained in model/session logs.

Text and `structuredContent` become model-visible text; structured content is also retained in result metadata. Images remain typed base64 image parts. Default result limits are 32,000 text characters, four images, 1 MiB per image and 4 MiB combined. PNG/JPEG/WebP/GIF are accepted; audio and unsupported binary parts fail explicitly. Resource links and embedded resources require a host `allowResource(uri)` predicate; links remain handles and are never fetched. Embedded text/images use the same budgets. These limits must be supplemented by the host's input/session media limits.

Default context estimation counts each image as 4,096 tokens independently of base64 length, adjustable with `context.imageTokens`. This nonzero allowance must be configured/calibrated for the selected provider; it is not a universal upper bound or billing evidence. A custom `context.estimate` owns its own media accounting. History summaries omit image bytes; tool text truncation preserves image parts and stores only text in the truncation artifact. Session events still contain inline images: hosts needing long-lived media should wrap their store with bounded artifact persistence/hydration. Provider mapping already preserves user/tool image parts; real provider vision acceptance remains a separate check.

Validation: `tests/mcp.test.ts` starts the actual Node JSONL server in `tests/fixtures/mcp-server.mjs` for handshake, pagination, tool invocation, progress, cancellation, timeout, disconnect, list change and schema tests. It also exercises the COTO runtime's next model request, text truncation and summary input. This verifies the protocol slice and deterministic provider fixture; it does not establish interoperability with any particular product or a live visual model. Official SDK transport injection is available through the transport contract but is not SDK-package integration-tested in this dependency-free slice.

Official references: [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation), [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
