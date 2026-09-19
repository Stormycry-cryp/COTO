# 后端与多技术栈接入

日期：2026-09-19。状态：按 COTO `0.1.0` 当前实现校正。机器可读契约见 [`../protocol/openapi.yaml`](../protocol/openapi.yaml) 和 [`../protocol`](../protocol)。

## 1. 接入边界

COTO 的 TypeScript 核心负责 Runtime、Context、Tool/Skill、Session、输入调度和结构化事件。`createAgentServer()` 将同一核心暴露为 HTTP 命令和 SSE 事件流，因此 Python、Java、Go、.NET 等项目可以复用执行语义，不需要各自重写 Agent 循环。

当前服务实例绑定一个 `Agent`，也就是一个 workspace 和一组 Provider、Tool、Skill、Policy 配置。HTTP 调用方只能选择服务已暴露的 `default` workspace/profile，不能在请求中注入本地路径、模型 endpoint、密钥或 executable。

项目可以先运行 `coto init`，再用 `coto serve` 启动同一份 `coto.config.json`。嵌入式后端从 `@coto/agent/config` 调用 `loadProjectConfig()`，复用返回的 `agentOptions` 和 `serverOptions`；业务 Tool、认证和共享 Store 仍由宿主注册。初始化默认 `allow-all`，应用服务应明确选择自己的 Tool 集合和权限。配置字段见 [项目配置](project-configuration.md)。

| 宿主 | 推荐方式 |
| --- | --- |
| Node.js / TypeScript / Electron 主进程 | 直接 import 核心；需要进程隔离时调用 HTTP/SSE |
| Python / FastAPI / Django | HTTP/SSE；Python 业务能力注册为 Remote Tool |
| Java / Spring Boot | HTTP Client/WebClient + SSE parser；业务能力注册为 Remote Tool |
| Go / .NET | 标准 HTTP client + SSE parser |
| 浏览器 | 通过带认证的宿主后端或 fetch SSE client 访问 |

## 2. 请求和流生命周期

HTTP 命令与 SSE 订阅相互独立：

1. `POST /v1/sessions` 创建 Session。
2. `GET /v1/sessions/{id}/events` 建立 SSE，也可以先提交输入再从 `after=0` 回放。
3. `POST /v1/sessions/{id}/inputs` 在输入写入 Session 日志后返回 `202` 和回执。
4. Runtime 继续发送文本、工具、审批、压缩、usage 和轮次终态事件。
5. 当前流仍在进行时，可从另一个 HTTP 请求提交 `steer`、`follow_up`、`interrupt`、取消或审批。
6. SSE 断线后，用最后完整处理的 `seq` 或 `eventId` 重连。

`202` 只表示命令被接受。`turn.completed`、`turn.failed` 或 `turn.interrupted` 才是轮次终态。断开观察连接不会取消 Runtime；取消需要显式命令。

## 3. 当前 HTTP API

| 方法与路径 | 当前行为 |
| --- | --- |
| `GET /healthz` | 进程存活，不发模型请求 |
| `GET /readyz` | 服务是否仍接收请求；draining 时返回 503 |
| `POST /v1/sessions` | 创建 Session；workspace/profile 当前只接受 `default` |
| `GET /v1/sessions?offset=N` | 返回当前身份可见的 Session，每页最多 100 条 |
| `GET /v1/sessions/{id}` | 返回 Session 当前投影 |
| `POST /v1/sessions/{id}/inputs` | 提交中途输入或普通下一轮输入 |
| `DELETE /v1/sessions/{id}/inputs/{inputId}` | 撤回仍处于 pending 的输入 |
| `GET /v1/sessions/{id}/events` | SSE 实时订阅和历史回放 |
| `POST /v1/sessions/{id}/turns/{turnId}/cancel` | 请求取消指定活动轮次 |
| `POST /v1/sessions/{id}/approvals` | `{approvalId, allowed}` 处理审批 |
| `POST /v1/sessions/{id}/reconcile` | `{invocationId, outcome}` 登记已核实的未知 Tool 结果 |
| `POST /v1/sessions/{id}/resume` | 继续中断且已核对的 Session |
| `POST /v1/sessions/{id}/fork` | 从非活动且没有 unresolved Tool 的父 Session 复制消息历史 |
| `POST /v1/sessions/{id}/archive` | 归档空闲 Session |
| `GET /v1/sessions/{id}/artifacts/{artifactId}` | 读取超长 Tool 输出的完整文本 |

错误响应统一为：

```json
{
  "requestId": "request-id",
  "error": {
    "code": "turn_conflict",
    "message": "Target turn is no longer active",
    "retryable": false
  }
}
```

服务区分 400、401、403、404、409、413、422、429、500/502/503 和 507。SSE 已建立后的连接级错误使用 `stream.error` 发送，然后关闭连接。

### 幂等

输入以 `inputId` 持久判重。相同 ID 和相同内容返回已有回执；相同 ID 配不同内容返回 409。HTTP `Idempotency-Key` 若存在，必须等于 `inputId`。

创建 Session 可传 1 到 200 字符的 `Idempotency-Key`。服务按 `ownerId:key` 计算稳定 Session ID，并串行合并并发创建；重复请求返回已有 Session。既有 Session 的 owner、workspace 或 profile 不符合当前默认配置时返回 409。调用方仍应为每次独立创建意图使用不同 key。

## 4. SSE、游标和背压

持久事件 envelope：

```text
id: sess_example:42
event: text.delta
data: {"schemaVersion":1,"eventId":"sess_example:42","sessionId":"sess_example","seq":42,"timestamp":"2026-09-19T00:00:00.000Z","type":"text.delta","turnId":"turn_example","stepId":"step_example","attemptId":"attempt_example","data":{"text":"正在检查入口"}}

```

每个 Session 的持久事件从 `seq=1` 单调递增，`eventId` 为 `<sessionId>:<seq>`。重连可发送：

- `Last-Event-ID: <sessionId>:<seq>`
- 查询参数 `?after=<seq>`

Header 优先于查询参数。另一个 Session 的 event ID、负数、非整数或超过当前 seq 的游标会返回 `invalid_cursor`。

当前 File Store 保留完整 JSONL 事件历史，单 Session 日志默认上限为 64 MiB；当前版本没有在线 replay 窗口裁剪和 `cursor_expired`。订阅先回放游标后的历史，再交付实时事件。重复事件由客户端按 seq 去重。

服务默认每 15 秒发送一条无 seq 的 SSE comment 心跳。单个订阅者的内存队列上限为 256 条；溢出时发送连接级 `stream.error`，客户端从最后成功处理的 seq 重连。socket 写入超过 10 秒仍无法 drain 时连接会结束。

反向代理需保留流式响应，关闭响应缓冲和转换。服务已发送：

```text
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

客户端必须按 SSE 规范解析 UTF-8 分块、CRLF、空行、comment 和多行 `data`。一个 TCP chunk 可能包含半条或多条事件。

## 5. 中途消息

请求结构：

```json
{
  "inputId": "client-generated-stable-id",
  "mode": "steer",
  "expectedTurnId": "current-turn-id",
  "content": [
    {"type": "text", "text": "补充：只修改登录模块，使用中文回答。"}
  ]
}
```

- `follow_up` 排入下一轮；Session 空闲时会立即启动。它不需要 `expectedTurnId`。
- `steer` 在当前轮下一次模型请求前写入上下文。它不会中断正在运行的模型请求或 Tool，必须指向当前活动轮次。
- `interrupt` 记录取消意图、请求终止当前轮，并将新输入放到队首。它必须指向当前活动轮次。

Runtime 在 Session 内串行处理轮次边界与输入，因此旧 `expectedTurnId` 会明确返回 409，不会静默投递到新轮次。等待审批时取消会使旧审批失效。

取消采用协作式 `AbortSignal`。对于写入、执行和网络 Tool，信号发出后无法证明外部副作用已经停止时，Runtime 记录 `tool.outcome_unknown` 并暂停 Session。宿主核实外部结果后调用 `reconcile`，再调用 `resume`。

## 6. Remote Tool 协议

`remoteTool()` 向已登记 endpoint 发送：

```json
{
  "invocationId": "turn-id_tool-call-id",
  "sessionId": "session-id",
  "turnId": "turn-id",
  "arguments": {"sku": "SKU-1"}
}
```

请求头包含：

```text
Content-Type: application/json
Idempotency-Key: <invocationId>
```

业务服务成功响应：

```json
{
  "content": [
    {"type": "text", "text": "{\"available\":12}"}
  ],
  "metadata": {"source": "inventory"}
}
```

当前 Remote Tool 只接受文本 content part。HTTP `202` 对所有 effect 都产生 `outcome_unknown`。其他非 2xx、网络失败或无效响应对 `read` Tool 是明确 Tool error；对 `write`、`execute`、`network` Tool 会转成 `outcome_unknown` 并保留 unresolved invocation，除非请求在 URL/网络策略预检阶段已被明确拒绝。适配器不自动轮询、不自动重发副作用，也没有远程取消 endpoint。业务系统使用 `invocationId` 查询和去重，核实结果后调用 `reconcile`。

endpoint 和认证 header 在服务端注册。默认拒绝私网、保留地址、URL 内凭据和重定向，并固定首次 DNS 检查得到的地址，降低 SSRF 和 DNS rebinding 风险。内部业务服务需要显式 `allowPrivate: true`。模型参数中的 userId/tenantId 不能作为业务身份，业务服务应从宿主发放的凭据确定调用主体。

## 7. 认证和部署

`createAgentServer()` 接受两个钩子：

- `authenticate(request)` 返回 `{id}` 或 `null`。
- `authorize(owner, sessionId, action)` 判断 read、write、events 等访问。

没有 `authenticate` 时身份为 `anonymous`，服务只允许监听 `127.0.0.1`、`localhost` 或 `::1`。配置认证后可以监听外部地址。没有自定义 `authorize` 时，服务比较 Session 的 `ownerId`。

CLI 当前没有注入认证钩子的配置入口，适合本机开发。公网、内网共享或容器入口使用程序化服务，并接入项目自己的令牌验证与授权逻辑。Provider 和 Remote Tool 密钥只从服务端环境变量读取。

浏览器原生 `EventSource` 不能设置任意 Authorization header。可使用仓库的 fetch SSE client，或由同源 BFF 用受 CSRF 保护的 cookie 代理。不要把 access token 放进 URL。

服务退出顺序：先 `service.close()` 停止接收请求并关闭 SSE，再 `agent.close()` 取消活动轮次、关闭 Tool、刷完 Session writer 并释放锁。CLI 的 SIGINT/SIGTERM 处理执行这两个步骤。

并发调用 `agent.close()` 或 `session.close()` 会等待同一次完整关闭。Agent 会等待已经开始的 Session 创建和打开完成后关闭结果；关闭后的 Session 拒绝写操作。在仍开放的 Agent 中再次调用 `sessions.get(id)`，会重新打开已关闭的缓存 Session。自定义 Provider、ContextContributor 和 Tool 需要遵守 `AbortSignal` 契约，宿主仍负责不响应取消的扩展进程。

## 8. 持久化和恢复

File Store 每个 Session 使用：

```text
.coto/sessions/<sessionId>/meta.json
.coto/sessions/<sessionId>/events.jsonl
.coto/sessions/<sessionId>/artifacts/<artifactId>
```

事件 append 后执行 fsync。重新打开 Session 时，持锁 writer 会截断崩溃留下的不完整末行；中途退出的活动轮次记录为 `turn.interrupted`，未出现终态的 Tool 调用产生 `recovery.required`。同一 Session 的第二个 writer 会收到 409。

默认 Store 适合单机文件系统。多实例部署需要实现共享 `SessionStore`、分布式租约和会话路由，当前版本不能仅靠增加副本数获得一致的多写者执行。

Session fork 复制消息投影并记录父 Session ID。它不会复制或隔离 workspace 文件，也不会创建 Git worktree。

## 9. 跨语言客户端

TypeScript 客户端 `CotoClient` 实现 Session 创建/列表/快照、输入/撤回、取消、审批、核对、恢复、fork、归档和 SSE 解析。调用方持有最后成功处理的 seq，并在连接失败后再次调用 `events(sessionId, seq)`。

Python 标准库示例见 [`../examples/python_client.py`](../examples/python_client.py)。Java 使用 `HttpClient`/WebClient，Go 使用 `net/http`，.NET 使用 `HttpClient` 的 `ResponseHeadersRead`。四种语言都遵循同一 `openapi.yaml` 与 JSON Schema。

当前自动化验证覆盖 TypeScript HTTP/SSE client，以及 Python 标准库客户端连接本地真实 COTO 服务的创建、输入与流式终态；Python smoke 使用 echoProvider。Java、Go、.NET 尚未作为真实消费者运行。真实反向代理、容器、多实例和各家真实模型 endpoint 的验收必须单独记录，不能由本地 fixture 代替。

## 10. 当前限制

- 单个 Agent server 只暴露一个 workspace 和一个默认 profile。
- 没有 WebSocket、多 Agent 调度、分布式 Session owner 或在线事件裁剪。
- HTTP 认证和业务账号体系由宿主实现。
- Runtime 的 Policy 和 workspace 路径检查不等于 OS 沙箱。
- 外部副作用没有通用 exactly-once；幂等需要业务 Tool 配合实现。
- Context 摘要可能丢失细节，关键状态应存入项目文件或结构化业务系统。
- 模型能力、网关兼容性和工具调用质量依赖具体 Provider；应分别做协议 mock 和真实端点验收。
