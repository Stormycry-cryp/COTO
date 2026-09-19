# COTO Agent

COTO 是一个可嵌入项目的 TypeScript Agent 基底。它提供模型执行循环、上下文预算与压缩、Tool/Skill、持久 Session、中途消息、HTTP/SSE 服务和跨语言协议。Provider 直接请求配置的远端 endpoint，不要求安装或启动本地协议转换代理。

当前版本为 `0.1.0`，需要 Node.js `>= 22.19.0`。包名为 `@coto/agent`；当前仓库尚未声明已发布到 npm registry。

## 已实现能力

- Runtime：模型流式输出、工具调用闭环、参数校验、重试、审批、取消和执行上限。
- Context：按 Provider 上下文窗口计算预算，保留近期消息，超限时生成摘要并持久化压缩结果。
- Session：内存或 JSONL 文件存储、单写者锁、崩溃尾记录修复、恢复、fork、归档和 Provider 切换。
- 中途消息：`steer`、`follow_up`、`interrupt`，包含输入去重和轮次冲突检查。
- Tool：工作区文件读写、文本搜索、统一 diff、进程、受限 HTTP 请求及远程 Tool。
- Skill：发现带 YAML frontmatter 的 `SKILL.md`，向模型提供目录并按需读取资源。
- Provider：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Google Gemini，以及兼容这些协议的自定义 endpoint。
- 服务：HTTP 命令、SSE 实时事件、持久事件回放、心跳、慢消费者保护、认证与授权钩子。

## 安装

从源码构建：

```bash
git clone https://github.com/Stormycry-cryp/COTO.git
cd COTO
npm ci
npm run build
```

在另一个本地项目中安装当前构建：

```bash
cd /path/to/COTO
npm pack
cd /path/to/your-project
npm install /path/to/COTO/coto-agent-0.1.0.tgz
```

也可以在项目中固定 GitHub 的 tag 或 commit 安装；`prepare` 会自动构建包。将下面的占位值替换为要使用的版本：

```bash
npm install 'git+https://github.com/Stormycry-cryp/COTO.git#<tag-or-commit>'
```

仓库自带的无密钥演示使用测试 Provider：

```bash
npm run build
npm run demo
```

## 最小库示例

```ts
import { createAgent } from '@coto/agent';

const agent = createAgent({
  workspace: process.cwd(),
  provider: {
    protocol: 'openai-responses',
    model: 'gpt-5-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  tools: 'local-basic',
  policy: 'read-only',
  context: {
    system: '你是当前项目的开发 Agent。先检查事实，再执行任务。',
  },
});

try {
  const session = await agent.sessions.create({ workspaceId: 'demo' });

  for await (const event of session.runStream('查看项目入口并说明如何启动')) {
    if (event.type === 'text.delta') process.stdout.write(String(event.data.text));
    if (event.type === 'turn.completed') process.stdout.write('\n');
  }
} finally {
  await agent.close();
}
```

默认 Store 位于 `<workspace>/.coto/sessions`。测试或短生命周期任务可传入 `new MemorySessionStore()`。同一持久 Session 同时只允许一个进程持有写锁。

## Provider

`createProvider()` 和 `createAgent()` 的 Provider 配置支持四种协议：

| `protocol` | 默认 endpoint | 默认密钥环境变量 |
| --- | --- | --- |
| `openai-chat` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `openai-responses` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `anthropic` | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_API_KEY` |

最小配置：

```ts
import { createProvider } from '@coto/agent/providers';

const openAIChat = createProvider({
  protocol: 'openai-chat',
  model: '<openai-chat-model>',
});

const openAIResponses = createProvider({
  protocol: 'openai-responses',
  model: '<openai-responses-model>',
});

const anthropic = createProvider({
  protocol: 'anthropic',
  model: '<anthropic-model>',
});

const gemini = createProvider({
  protocol: 'gemini',
  model: '<gemini-model>',
});
```

`baseURL` 会被直接交给对应协议适配器。它必须是无用户名、密码、query 和 fragment 的 HTTP(S) URL。密钥按 `apiKey`、`apiKeyResolver({signal})`、`apiKeyEnv`、协议默认环境变量的顺序解析。长期服务优先使用环境变量或动态 resolver，避免把明文密钥写入配置文件。额外请求头可用 `headers` 或 `headerEnv` 配置：

```ts
const provider = createProvider({
  id: 'company-gateway',
  protocol: 'openai-chat',
  model: 'company-model-v1',
  baseURL: 'https://llm.example.com/v1',
  apiKeyEnv: 'COMPANY_LLM_API_KEY',
  headerEnv: { 'x-tenant-token': 'COMPANY_TENANT_TOKEN' },
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  images: true,
  timeoutMs: 120_000,
});
```

临时令牌可以在每次请求时解析，并响应取消：

```ts
const provider = createProvider({
  protocol: 'openai-responses',
  model: 'company-model-v1',
  baseURL: 'https://llm.example.com/v1',
  apiKeyResolver: async ({ signal }) => tokenService.issue({ signal }),
});
```

不需要 Provider API key 的受信任 endpoint 可设置 `auth: 'none'`。OpenAI 和 Anthropic 适配器会抑制 SDK 自动生成的认证值；Gemini SDK 强制要求 key，因此该模式仍会发送值为空的 `x-goog-api-key` header。拒绝空 header 的 Gemini 兼容网关需要使用真实 key 或显式 header。宿主显式配置的自定义 header 会被保留；不要把 `auth: 'none'` 当成服务端访问控制。

### DeepSeek

DeepSeek 的 `deepseek-flash` 已完成真实端点的文本流、工具回填、会话续接和取消测试，可使用：

```ts
const provider = createProvider({
  protocol: 'openai-chat',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
});
```

真实端点探针 `scripts/smoke-provider.mjs` 需要主动运行，会产生模型 API 用量。先通过宿主环境注入 `DEEPSEEK_API_KEY`，再执行：

```bash
npm run build
COTO_PROTOCOL=openai-chat COTO_BASE_URL=https://api.deepseek.com COTO_MODEL=deepseek-flash COTO_API_KEY_ENV=DEEPSEEK_API_KEY node scripts/smoke-provider.mjs
```

探针使用内存会话、临时 HTTP/SSE 监听和只读校验工具，验证后关闭服务。该探针不加入默认测试或 CI；其他 Provider 的生产验证状态见实施记录。

### Provider catalog

`providerFromCatalog()` 把 endpoint、认证方式和模型选择分开，适合由项目配置文件或管理后台维护白名单：

```ts
import { providerFromCatalog } from '@coto/agent/providers';

const catalog = {
  direct: {
    protocol: 'openai-chat' as const,
    baseURL: 'https://llm.example.com/v1',
    apiKeyEnv: 'COMPANY_LLM_API_KEY',
    auth: 'api-key' as const,
    models: {
      fast: { contextWindow: 64_000, maxOutputTokens: 4_096 },
      precise: { contextWindow: 128_000, maxOutputTokens: 8_192 },
    },
  },
};

const provider = providerFromCatalog(catalog, 'direct', 'precise');
```

Catalog 中不存在的 Provider 或模型会返回 `unknown_model`。切换已有 Session 的 Provider 需要 Session 空闲且没有未核对的工具副作用：

```ts
await session.switchProvider(provider);
```

新增其他协议时，实现 `ModelProvider` 的 `stream(request, { signal })` 即可接入 Runtime；公共类型由 `@coto/agent/core` 导出。

## Tool 与 Policy

自定义 Tool 使用 JSON Schema 描述参数：

```ts
import { createAgent, defineTool } from '@coto/agent';

const getOrder = defineTool({
  name: 'get_order',
  description: '按订单号读取订单',
  effect: 'read' as const,
  parallel: true,
  parameters: {
    type: 'object',
    properties: { orderId: { type: 'string', minLength: 1 } },
    required: ['orderId'],
    additionalProperties: false,
  },
  async execute(args) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ id: args.orderId }) }] };
  },
});

const agent = createAgent({
  workspace: process.cwd(),
  provider: { protocol: 'openai-chat', model: '<model>' },
  tools: [getOrder],
  policy: 'read-only',
});
```

内置策略：

| 策略 | 行为 |
| --- | --- |
| `read-only` | 自动允许 `read`，拒绝 `write`、`execute`、`network` |
| `ask` | 自动允许 `read`，其他 effect 产生 `approval.required` |
| `allow-all` | 允许全部已注册 Tool |
| 自定义函数 | 按 Tool、参数和会话上下文返回 `allow`、`deny` 或 `ask` |

`localTools()` 从 `@coto/agent/tools` 导出，包含：

- `read_file`、`list_files`、`search_files`
- `write_file`、`edit_file`、`apply_patch`
- `exec_command`、`process_read`、`process_cancel`
- `http_fetch`

文件 Tool 受 workspace 边界约束，并拒绝访问 `.git`、`.coto` 及越界 symlink。进程 Tool 是受策略控制的宿主命令执行器，不构成 OS 沙箱；其默认环境仅包含 `PATH`。`http_fetch` 默认拒绝私网/保留地址和重定向。

跨技术栈业务能力可注册为远程 Tool：

```ts
import { remoteTool } from '@coto/agent/tools';

const inventory = remoteTool({
  name: 'inventory_lookup',
  description: '查询库存',
  effect: 'read',
  parameters: {
    type: 'object',
    properties: { sku: { type: 'string' } },
    required: ['sku'],
    additionalProperties: false,
  },
  endpoint: 'https://inventory.example.com/agent-tools/lookup',
  headerEnv: { authorization: 'INVENTORY_AUTHORIZATION' },
});
```

远程请求包含 `invocationId`、`sessionId`、`turnId` 和 `arguments`，并使用 `invocationId` 作为 `Idempotency-Key`。业务服务必须自己落实去重。HTTP `202` 对所有 effect 都是 `outcome_unknown`；其他非 2xx、网络失败或无效响应对 `read` Tool 是明确错误，对可能产生副作用的 Tool 是 `outcome_unknown`，Session 会保留 unresolved invocation，等待 `reconcile()`。URL/网络策略在请求前拒绝属于明确错误。适配器不会自动轮询或重发。访问本机或私网 endpoint 需要宿主明确设置 `allowPrivate: true`。

## Skill

Skill 根目录中的每个子目录可包含一个 `SKILL.md`：

```md
---
name: release-check
description: 发布前检查构建、迁移和回滚条件
---

# 发布检查

先运行项目测试，再检查待发布差异。
```

注册方式：

```ts
const agent = createAgent({
  workspace: process.cwd(),
  provider,
  skills: { roots: ['.agents/skills', '.codex/skills'] },
});
```

Runtime 向模型提供 Skill 目录以及 `skills_list`、`skills_read`。发现 Skill 不会自动执行脚本。默认还会读取 workspace 根目录的 `AGENTS.md` 作为项目指令；可用 `projectInstructions: false` 关闭。

## Session 与中途消息

普通调用：

```ts
const session = await agent.sessions.create();
const result = await session.run('分析当前项目');
console.log(result.status, result.text);

const snapshot = session.snapshot();
const eventsAfter100 = session.history(100);
const fork = await agent.sessions.fork(session.id);
```

三种输入模式：

| 模式 | 应用时机 | `expectedTurnId` |
| --- | --- | --- |
| `follow_up` | 当前轮结束后启动下一轮；空闲时立即启动 | 不需要 |
| `steer` | 当前轮下一次模型请求前加入上下文，不取消正在运行的 Tool | 必须是当前活动轮次 |
| `interrupt` | 请求取消当前轮，然后优先以新输入启动一轮 | 必须是当前活动轮次 |

监听 `turn.started` 取得当前 `turnId`，再提交中途输入：

```ts
const receipt = await session.submitInput({
  inputId: crypto.randomUUID(),
  mode: 'steer',
  expectedTurnId: currentTurnId,
  content: [{ type: 'text', text: '补充：只检查 src 目录，使用中文回答。' }],
});
```

相同 `inputId`、mode、目标轮次和内容会返回原回执，JSON 对象字段顺序不影响去重；相同 ID 配不同内容返回 `idempotency_conflict`。`interrupt` 只表示已请求取消，最终状态以 `turn.interrupted` 为准。写入、执行或网络 Tool 在超时/取消后可能产生 `tool.outcome_unknown` 和 `recovery.required`，此时先通过 `reconcile()` 登记已核实结果，再 `resume()`。

## HTTP/SSE 服务

### CLI

CLI 适合本机回环地址开发：

```bash
export OPENAI_API_KEY='<key>'
export COTO_PROTOCOL='openai-responses'
export COTO_MODEL='<model-id>'
export COTO_WORKSPACE='/absolute/path/to/project'
npx coto serve
```

常用变量：

| 变量 | 默认值 |
| --- | --- |
| `COTO_PROTOCOL` | `openai-chat` |
| `COTO_MODEL` | `gpt-4o-mini` |
| `COTO_BASE_URL` | 协议默认 endpoint |
| `COTO_API_KEY_ENV` | 协议默认密钥变量名 |
| `COTO_AUTH` | `api-key`；设为 `none` 可关闭 Provider 认证 |
| `COTO_TOOLS` | 内置 Tool；设为 `none` 可关闭 |
| `COTO_POLICY` | `read-only`；支持 `ask`、`allow-all` |
| `COTO_HOST` / `COTO_PORT` | `127.0.0.1` / `8787` |

CLI 没有账号系统。非回环监听必须在宿主代码中配置认证，服务会拒绝未配置认证的外部绑定。

### 程序化服务

```ts
import { createAgent } from '@coto/agent';
import { createAgentServer } from '@coto/agent/server';

const agent = createAgent({ workspace: process.cwd(), provider, tools: 'local-basic' });
const token = process.env.COTO_SERVER_TOKEN;

const service = createAgentServer(agent, {
  host: '0.0.0.0',
  port: 8787,
  authenticate: async request =>
    token && request.headers.authorization === `Bearer ${token}` ? { id: 'service-user' } : null,
  authorize: async (owner, _sessionId, _action) => owner.id === 'service-user',
});

await service.listen();
```

已实现路由：

| 方法与路径 | 作用 |
| --- | --- |
| `GET /healthz`、`GET /readyz` | 存活与就绪检查 |
| `POST /v1/sessions` | 创建 Session；当前服务只暴露 `default` workspace/profile |
| `GET /v1/sessions` | 列出当前身份可见的 Session |
| `GET /v1/sessions/{id}` | 获取快照 |
| `POST /v1/sessions/{id}/inputs` | 提交三种输入 |
| `DELETE /v1/sessions/{id}/inputs/{inputId}` | 撤回未应用输入 |
| `GET /v1/sessions/{id}/events` | SSE 订阅和回放 |
| `POST /v1/sessions/{id}/turns/{turnId}/cancel` | 取消指定活动轮次 |
| `POST /v1/sessions/{id}/approvals` | 处理 Tool 审批 |
| `POST /v1/sessions/{id}/reconcile` | 核对结果未知的 Tool |
| `POST /v1/sessions/{id}/resume` | 继续已中断 Session |
| `POST /v1/sessions/{id}/fork` | 从非活动且没有 unresolved Tool 的 Session 分叉 |
| `POST /v1/sessions/{id}/archive` | 归档空闲 Session |
| `GET /v1/sessions/{id}/artifacts/{artifactId}` | 读取截断后的完整 Tool 输出 |

完整字段定义见 [`protocol/openapi.yaml`](protocol/openapi.yaml) 和 [`protocol/*.schema.json`](protocol/)。

### SSE 与重连

事件响应使用 `text/event-stream`：

```text
id: session-id:42
event: text.delta
data: {"schemaVersion":1,"sessionId":"session-id","eventId":"session-id:42","seq":42,"timestamp":"...","type":"text.delta","data":{"text":"..."}}
```

每个持久事件在 Session 内拥有单调递增 `seq`。重连时传 `Last-Event-ID: <sessionId>:<seq>` 或 `?after=<seq>`；服务从 JSONL 历史回放，不会重新运行模型或 Tool。SSE 心跳默认为 15 秒。单订阅者待发送队列超过 256 条时收到 `stream.error` 并断开，客户端应从最后成功处理的 seq 重连。

TypeScript 客户端：

```ts
import { CotoClient } from '@coto/agent/client';

const client = new CotoClient('http://127.0.0.1:8787', fetch, {
  authorization: `Bearer ${process.env.COTO_SERVER_TOKEN}`,
});
const created = await client.createSession();
const sessionId = String((created.meta as { id: string }).id);

await client.submitInput(sessionId, {
  inputId: crypto.randomUUID(),
  mode: 'follow_up',
  content: [{ type: 'text', text: '检查项目入口' }],
});

for await (const event of client.events(sessionId)) {
  if (event.type === 'text.delta') process.stdout.write(String(event.data.text));
  if (event.type === 'turn.completed') break;
}
```

## Python、Java、Go 和 .NET

其他技术栈不需要重写 Agent Runtime。它们通过 JSON 命令和标准 SSE 使用 COTO，业务能力则通过 Remote Tool 回调各自服务。

Python 标准库示例位于 [`examples/python_client.py`](examples/python_client.py)。运行服务后：

```bash
COTO_URL=http://127.0.0.1:8787 python3 examples/python_client.py
```

Java 11+ 可使用 `HttpClient` 提交命令；SSE 响应使用 `BodyHandlers.ofLines()` 或成熟 SSE 客户端，并按空行分隔事件：

```java
var request = HttpRequest.newBuilder(URI.create(base + "/v1/sessions"))
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString("{}"))
    .build();
var response = client.send(request, HttpResponse.BodyHandlers.ofString());
```

Go 使用 `net/http` 提交 JSON，订阅时读取 `response.Body`，按 SSE 规范聚合 `id:`、`event:` 和多行 `data:`；重连时发送最后完成事件的 `Last-Event-ID`：

```go
req, _ := http.NewRequest("GET", base+"/v1/sessions/"+id+"/events", nil)
req.Header.Set("Accept", "text/event-stream")
req.Header.Set("Last-Event-ID", lastEventID)
resp, err := http.DefaultClient.Do(req)
```

.NET 使用 `HttpClient` 和 `ResponseHeadersRead` 保持流式读取：

```csharp
using var request = new HttpRequestMessage(HttpMethod.Get, $"{baseUrl}/v1/sessions/{id}/events");
request.Headers.Accept.ParseAdd("text/event-stream");
using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
await using var stream = await response.Content.ReadAsStreamAsync();
```

TCP chunk 不等于一条 SSE 事件。生产客户端应使用合规 SSE parser，处理 UTF-8 分块、CRLF、多行 `data`、心跳、重复事件和断线重连。自动化测试覆盖 TypeScript 客户端，以及 Python 客户端对本地 COTO 服务的创建、输入和流式终态；Python smoke 使用 `echoProvider`。Java/Go/.NET 片段尚未作为真实消费者运行验收。

## 安全边界

- Provider 凭据留在服务进程配置、环境变量或动态 resolver 中，不写入 Session、输入或 URL；避免在可提交的 catalog 中使用明文 `apiKey`。
- 外部绑定配置 `authenticate`，并按 Session 和 action 配置 `authorize`。
- 普通调用方不能通过 HTTP 请求注入 Provider endpoint、密钥、Tool executable 或 workspace 路径。
- 浏览器原生 `EventSource` 不能设置任意 Authorization header；使用 fetch SSE 客户端或带 CSRF 防护的同源 BFF。
- 本地 Tool 受工作区和 Policy 约束，但不是容器或 OS 沙箱。运行不可信任务时由宿主提供独立用户、容器或虚拟机。
- `allowPrivate` 只应对明确登记的内部 Tool endpoint 开启。
- Session fork 复制会话消息，不复制 Git worktree，也不隔离多个 Session 对同一工作区的文件修改。

## 开发与验证

```bash
npm run typecheck
npm test
npm run build
npm pack
node scripts/smoke-package.mjs
node scripts/smoke-python-client.mjs
```

项目要求 Node.js `>= 22.19.0`。核心行为测试覆盖模型/Tool 往返、中途消息、输入去重、审批、JSONL 恢复、写锁、fork、HTTP/SSE 回放和身份隔离。各 Provider 的协议 mock 与真实端点验证状态以 [`docs/implementation-log.md`](docs/implementation-log.md) 为准；没有凭据时不会把 mock 测试写成真实端点已验收。

GitHub Actions 在 Linux 上检查 Node.js `22.19.0` 和 `24.x`，执行构建、行为测试、独立 tarball 消费者与 Python HTTP/SSE smoke。单实例服务和自定义扩展的边界见设计文档末尾的 `0.1.0` 实现映射。

## 设计与协议

- [`docs/agent-base-design.md`](docs/agent-base-design.md)：架构、边界和设计依据。
- [`docs/backend-integration.md`](docs/backend-integration.md)：后端生命周期、SSE 和多技术栈接入。
- [`docs/implementation-log.md`](docs/implementation-log.md)：实施步骤、验证证据和待办。
- [`upstream.lock.json`](upstream.lock.json)：研究用 Codex 源码版本。

## License

COTO 以 [MIT License](LICENSE) 发布。第三方依赖和上游研究来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。COTO 不是 OpenAI Codex 的官方发行版。
