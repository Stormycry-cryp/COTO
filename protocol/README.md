# COTO Protocol v1

本目录描述 COTO `0.1.0` 已实现的 HTTP/SSE 公共契约：

- `openapi.yaml`：路由、请求和响应。
- `session.schema.json`：Session 元数据、消息、轮次结果和快照。
- `input.schema.json`：`steer`、`follow_up`、`interrupt` 请求与回执。
- `event.schema.json`：持久 Agent 事件 envelope 和当前事件类型。
- `errors.schema.json`：HTTP 错误 envelope。

事件 `schemaVersion` 当前为 `1`。持久事件的 `eventId` 是 `<sessionId>:<seq>`，`seq` 在单个 Session 内从 1 单调递增。SSE 的 `stream.error` 是连接级通知，不进入 Session 日志，也不符合持久 `AgentEvent` schema。

JSON Schema 使用 Draft 2020-12；OpenAPI 使用 3.1。外部客户端应忽略未知事件类型或在协议版本升级时显式拒绝，不能把连接断开当成轮次完成。
