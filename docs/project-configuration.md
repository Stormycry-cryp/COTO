# 项目配置与扩展

`coto init` 在项目根目录创建声明式配置。`coto run`、`coto doctor`、`coto sessions`、`coto serve` 和 `loadProjectConfig()` 共用加载器。配置为 JSON，未知字段会报错；CLI 不自动执行项目中的 JavaScript。

## 基础配置

```json
{
  "provider": {
    "protocol": "openai-chat",
    "model": "deepseek-flash",
    "baseURL": "https://api.deepseek.com",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "timeoutMs": 60000,
    "contextWindow": 32768,
    "maxOutputTokens": 4096
  },
  "agent": {
    "tools": "local-basic",
    "policy": "allow-all",
    "skills": { "roots": [".agents/skills", ".codex/skills"] },
    "projectInstructions": true,
    "maxSteps": 32,
    "maxTurnMs": 600000,
    "toolTimeoutMs": 60000,
    "maxRetries": 2,
    "context": { "system": "根据项目事实执行任务，验证结果后报告。" }
  },
  "server": { "host": "127.0.0.1", "port": 8787 }
}
```

配置支持 `--workspace /path/to/project` 和 `--config path/to/config.json`。技能目录相对于 workspace 解析。默认 Store 位于 workspace 的 `.coto/sessions`。

`.env.coto` 使用 Node 的 dotenv 解析器；已有进程环境变量优先，加载不会修改全局 `process.env`。文件只保存本机凭据，不提交 Git。`doctor --json` 输出凭据变量名、来源和是否存在，不输出值。未配置 `apiKeyEnv` 时采用协议默认变量。

基础文件工具拒绝读取或修改 `.env.coto`，搜索也会跳过它。允许执行任意宿主命令仍意味着该进程拥有宿主文件权限；需要隔离时由项目提供容器或独立系统用户。

## Provider 切换

`protocol` 支持 `openai-chat`、`openai-responses`、`anthropic`、`gemini`。`baseURL` 直接连接对应协议 endpoint；不需要额外本地代理。更换 Provider 时同时确认模型 ID、endpoint 的版本路径和密钥变量。

其他字段包括 `id`、`auth`（`api-key` / `none`）、`images`、`reasoning`、`temperature`、`headers`、`headerEnv` 和 OpenAI 协议的 `compat`。普通标识 header 可以写在 `headers`；认证 header 使用环境变量引用：

```json
{
  "headers": { "x-client-name": "my-project" },
  "headerEnv": { "x-tenant-token": "TENANT_TOKEN" },
  "compat": { "supportsStore": false, "maxTokensField": "max_tokens" }
}
```

已有 Session 记录原来的 Provider 身份；修改配置后默认新建 Session。需要保留旧历史时，在宿主中对空闲且已核对副作用的 Session 显式调用 `switchProvider()`，再继续执行，避免无提示地把旧任务发送给新的模型服务。

## 限额与权限

- `agent.tools`：`local-basic` 或 `none`。
- `agent.policy`：`allow-all`、`ask`、`read-only`。初始化显式生成 `allow-all`；未写该字段时采用 `read-only`。
- `maxSteps`、`maxTurnMs`、`toolTimeoutMs`：限制模型请求步数、整轮时长和单次工具等待。
- `maxRetries`：重试上限，允许设为 `0`。
- `maxQueue`、`maxConcurrentTools`、`maxOutputChars`：输入队列、工具并发和输出保留上限。
- `context.system`、`context.safetyTokens`、`context.keepRecentMessages`：系统指令、上下文余量和摘要后保留的近期消息数量。
- `server.maxBodyBytes`、`server.heartbeatMs`：HTTP 请求体和 SSE 心跳配置。

进程工具在受信任宿主执行，默认只继承 `PATH`；需要其他环境变量时由宿主显式传给 `processTools({ ... })`。不要把 Provider 密钥透传给工具进程。自定义 Provider、ContextContributor 和 Tool 应响应 `AbortSignal`，关闭和超时依赖协作式取消。

## 添加项目工具

初始化生成的 `coto.agent.mjs` 是宿主嵌入入口，可以直接改为：

```js
import { createAgent, defineTool } from '@coto/agent';
import { loadProjectConfig } from '@coto/agent/config';

const projectStatus = defineTool({
  name: 'project_status',
  description: '读取项目业务状态',
  effect: 'read',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute() {
    return { content: [{ type: 'text', text: JSON.stringify({ ready: true }) }] };
  },
});

export async function createProjectAgent(options = {}) {
  const { agentOptions } = await loadProjectConfig(options);
  return createAgent({ ...agentOptions, tools: [projectStatus] });
}
```

宿主调用 `await createProjectAgent()` 后即可创建 Session。需要同时使用内置工具时，从 `@coto/agent/tools` 导入 `localTools()` 并与业务工具组成数组。不要给不可信外部用户开放宿主文件和命令工具。

CLI 仅使用声明式配置中的基础工具；自定义 Tool、Policy、Store、动态凭据和认证钩子由上述宿主入口注册。程序化 HTTP 服务同样可以复用配置：

```js
import { loadProjectConfig } from '@coto/agent/config';
import { createAgentServer } from '@coto/agent/server';
import { createProjectAgent } from './coto.agent.mjs';

const config = await loadProjectConfig();
const agent = await createProjectAgent();
const service = createAgentServer(agent, config.serverOptions);
await service.listen();
// 宿主退出时依次 await service.close(); await agent.close();
```

对外监听时在 `createAgentServer` 中接入项目的 `authenticate` 和 `authorize`。Python、Java、Go、.NET 可以按 [后端接入文档](backend-integration.md) 调用 HTTP/SSE，并将业务能力注册成 Remote Tool。

## 常见失败

| 现象 | 处理 |
| --- | --- |
| `COTO config not found` | 在项目根目录运行 `coto init`，或指定 `--workspace` / `--config` |
| `Required credentials are missing` | 检查配置引用的变量以及 `.env.coto`；先运行 `doctor` |
| Provider 401/404 | 核对密钥、协议路径和模型 ID；`doctor` 不验证远端账号权限 |
| 非交互工具被拒绝 | 显式选择合适的 Policy；`ask` 在无 TTY 时拒绝写操作 |
| 上轮失败或取消 | 使用 `coto run '继续任务' --session ID`；CLI 会恢复没有未核对副作用的会话 |
| `provider_mismatch` | 新建会话，或由宿主显式切换原会话 Provider |
| `recovery_required` | 核对未确定的工具副作用，调用 `reconcile()` 后 `resume()` |
| 第二个进程无法打开会话 | 关闭持有该 Session 写锁的进程；不要同时写同一个 Session |

未初始化配置时 `coto serve` 仍支持原有 `COTO_*` 环境变量入口；有项目配置时显式 `COTO_*` 服务选项可以覆盖对应项。详细可用变量见 README。

库调用方在失败或取消后，应先检查 `snapshot().unresolved`；核对完成后使用 `session.resume()` 恢复已排队的任务。直接 `submitInput(...follow_up)` 只负责排队，不自动解除暂停。`sessions.list()` 返回创建时的基础元数据；需要 Provider 切换后的当前状态时读取 Session snapshot。
