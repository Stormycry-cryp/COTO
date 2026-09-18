# 实施记录

日期：2026-09-19。本文只记录当前仓库中已有的产物与实际执行证据。设计目标见 `agent-base-design.md`；使用方式见根目录 `README.md`。

## 交付约束

- COTO 自身代码与文档使用 MIT License。
- OpenAI Codex 固定在 `7498521d288b9b3b96ffba4eedf089d8d6e06a84`，用于源码机制研究与追溯，不是运行时依赖。
- `@earendil-works/pi-ai` `0.85.1` 是 MIT 运行时依赖，用于 Provider 协议适配。
- Provider 直接请求配置的 HTTP(S) endpoint，不启动本地协议转换代理，也不改本机其他 Agent 的 Provider 配置。
- 通过功能分支和中文 PR 交付到 `Stormycry-cryp/COTO`；不直接推送或本地合并 `main`。

## 实施步骤

### 1. 研究和设计

- [x] 下载 OpenAI Codex 源码并记录仓库、commit、时间和许可证。
- [x] 提取 Runtime、Context、Tool/Skill、Session 和中途消息的行为边界。
- [x] 研究 Pi AI 的 Provider/API 分层，以及 CC Switch 风格的 Provider catalog、endpoint 和认证字段配置。
- [x] 编写 Agent 基底和后端/多技术栈设计文档。

### 2. 核心包

- [x] 建立 `@coto/agent` ESM TypeScript 包和子路径 exports。
- [x] 实现模型流、工具调用闭环、重试、输出上限和轮次终态。
- [x] 实现上下文预算、Context contributor、近期消息保留和模型摘要压缩。
- [x] 实现 Tool JSON Schema 校验、effect、Policy、审批、进度、超时和取消。
- [x] 实现 `steer`、`follow_up`、`interrupt`、输入去重、撤回和轮次冲突检查。

### 3. Session 和恢复

- [x] 实现 Memory Store 与 JSONL File Store。
- [x] 实现单写者锁、append fsync、单 Session/Artifact 上限和崩溃尾记录修复。
- [x] 实现 Session 恢复、未知 Tool 结果核对、resume、fork、archive 和 Provider 切换。
- [x] 实现事件订阅、历史回放和 Session 快照。

### 4. Provider、Tool 和 Skill

- [x] 实现 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Gemini Provider 配置。
- [x] 实现 `providerFromCatalog()`，支持直接 endpoint、静态/动态/环境变量密钥、固定 header 和环境变量 header。
- [x] 实现文件、文本搜索、原子写入、统一 diff、进程、HTTP 和 Remote Tool。
- [x] 实现 workspace 边界、私网/保留地址限制、DNS 地址固定、重定向拒绝和凭据错误脱敏。
- [x] 实现 Skill 发现、YAML frontmatter、catalog、按需资源读取和根目录 `AGENTS.md` contributor。

### 5. 服务和文档

- [x] 实现 HTTP 命令、SSE 流、事件游标、断线回放、心跳和慢消费者上限。
- [x] 实现认证/授权钩子、身份隔离、回环地址默认绑定和优雅关闭入口。
- [x] 实现 TypeScript fetch/SSE client 和 `coto serve` CLI。
- [x] 编写 README、第三方声明、Provider 配置、Remote Tool、安全和跨技术栈接入说明。
- [x] 增加 OpenAPI 3.1、Session/Input/Event/Error JSON Schema。
- [x] 增加无密钥 TypeScript demo 和 Python 标准库客户端示例。
- [x] 增加 Node 22.19.0 / 24.x 的 GitHub Actions，以及可重复运行的 tarball 消费者和 Python HTTP/SSE smoke 脚本。

### 6. 交付前边界核对

- [x] 回归并修复撤回输入后仍应用、连续上下文重建期间 steer 晚一轮生效、SSE 取消期间等待新事件的问题。
- [x] 输入去重改为字段值比较，跨技术栈 JSON key 顺序不同也能复用回执；非法 Policy 返回值禁止执行工具。
- [x] 持久化创建完整发布，验证 8 路同 key 并发只产生一个 Session；默认 owner 检查在打开 Session 和恢复日志之前执行。
- [x] 验证真实文件读写、diff、symlink 边界、进程输出/取消、HTTP/Remote Tool、Skill frontmatter 与资源隔离。
- [x] 修复 macOS 规范化 workspace 后 patch 返回路径错误，补全 HTTP 私网/保留地址拒绝。
- [x] 根据 npm 官方审计升级同主版本的 AJV、diff、picomatch、YAML；锁定 npm 官方 tarball 地址。

## 验证记录

以下验证由主任务和指定 Sol 子代理执行，原始结果在当前任务中核对。已确认过的行为测试范围包括：

- 模型到 Tool、Tool result 再到模型的闭环，以及 Tool 参数校验。
- `steer` 在下一次模型请求前应用，`follow_up` 排队，`interrupt` 取消旧轮次并启动新轮次。
- 重复 `inputId` 的持久去重与冲突拒绝。
- 审批拒绝不会执行写 Tool，过期审批不能解锁后续轮次。
- JSONL 持久化、崩溃尾记录修复、第二 writer 拒绝和 Session fork 隔离。
- HTTP/SSE 流式输出、游标回放不重跑模型、认证拒绝和 Session owner 隔离。
- OpenAI Chat Completions 的本地 HTTP mock 请求与 SSE 解析。
- 四种 Provider 的真实本地 HTTP/SSE wire mock，包括文本、Tool、usage、错误、取消、原生认证头、动态 key 和跨 endpoint 历史保护。
- Server adapter 的请求校验、创建并发幂等、精确路由、owner 隔离、SSE cursor/慢消费者、客户端取消和关闭行为。

本次最终验证使用 Node.js 22.23.2（满足项目要求 `>=22.19.0`）：

```bash
npm run typecheck
npm test
npm run build
npm run demo
npm pack
node scripts/smoke-package.mjs
node scripts/smoke-python-client.mjs
npm audit --omit=dev --registry=https://registry.npmjs.org
```

`npm pack` 后在干净临时目录安装 tarball，并用 Node 22 从包名加载根入口和子路径 exports；包安装时若宿主 Node 低于 `22.19.0` 会得到 npm `EBADENGINE` 提示，消费者验证使用 Node 22.23.2。

本次文档与协议产物已完成以下定点检查：

- Node.js `v22.23.2` 下 `npm run build` 通过。
- Node.js `v22.23.2` 下 `npm run demo` 通过，执行自定义 Tool 并输出 `Tool result: 42`。
- `examples/demo.ts` 独立 strict TypeScript 检查通过。
- 四份 JSON Schema 可解析并由 AJV 2020 编译；OpenAPI YAML 可解析，包含 14 个 path。
- README、docs 和 protocol 文档的本地链接检查通过。
- `examples/python_client.py` 已由 smoke 脚本连接真实本地 COTO HTTP/SSE 服务，验证创建、输入、Echo 流式内容和完成终态；Provider 使用 echoProvider。
- `npm pack --dry-run --json` 通过，清单包含 README、LICENSE、第三方声明、docs、examples、protocol 和 dist，共 70 个文件。
- `npm pack` tarball 安装到干净临时消费者目录后，Node.js `v22.23.2` 成功加载 `@coto/agent`、`@coto/agent/providers` 和 `@coto/agent/client`。
- Provider 专项测试 24/24 通过；全仓测试 59/59 通过；Node 22 全仓 TypeScript 检查通过。
- Node 22 / 24 的 tarball 消费者及 Python HTTP/SSE smoke 通过；Node 24 的 8 项 Tool/Skill 专项测试通过。
- AJV 8.20.0、diff 8.0.4、picomatch 4.0.7、YAML 2.9.1 更新后，Node 22 类型检查、构建和 59 项测试再次通过；npm 官方运行时依赖审计报告 0 项漏洞。审计是当次公告快照，不代表永久无风险。

## 待验证与限制

- [x] OpenAI Chat、OpenAI Responses、Anthropic、Gemini 完成协议级 HTTP/SSE mock：文本分片、Tool 调用、usage、错误、认证和取消。
- [ ] 使用用户明确提供的凭据与低成本模型验证四种 Provider 的真实 endpoint。当前没有真实端点完成证据。
- [x] 在干净临时目录安装 `npm pack` 产物并运行包消费者示例。
- [x] 实际运行 Python HTTP/SSE 客户端，对本地真实 COTO 服务完成回执、流式内容和终态验收。
- [ ] 实际运行 Java、Go、.NET 最小消费者；README 目前只提供接入片段。
- [ ] 通过真实反向代理验证 SSE 缓冲、心跳和重连行为。
- [ ] 创建中文 PR 并检查 GitHub CI；功能分支推送和 PR 创建是本次交付最后一步，当前分支尚未合入 `main`。

当前基础服务是单实例、单 workspace/default profile。多实例共享 Store、分布式租约、在线事件裁剪、WebSocket、多 Agent 调度和业务账号系统不在 `0.1.0` 实现范围内。Gemini 的底层 SDK 要求非空内部 key，因此 `auth: 'none'` 会发送空的 `x-goog-api-key` 来阻止 SDK 注入占位 key；不会发送 COTO 占位密钥，完全移除空 header 需要自建 Gemini 适配器。
