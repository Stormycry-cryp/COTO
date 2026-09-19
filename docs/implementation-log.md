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
- 从本地 Git commit 安装到独立临时项目，`prepare` 自动构建并通过包名运行 Agent，返回 `Echo: git install smoke`。该检查覆盖 Git 依赖构建，不代表 GitHub 网络始终可达。

## 待验证与限制

- [x] OpenAI Chat、OpenAI Responses、Anthropic、Gemini 完成协议级 HTTP/SSE mock：文本分片、Tool 调用、usage、错误、认证和取消。
- [x] 使用用户提供的凭据直连 DeepSeek `https://api.deepseek.com` / `deepseek-flash`，完成 OpenAI Chat 兼容协议的真实端点测试，详细记录见下文。
- [ ] OpenAI Responses、Anthropic、Gemini 的生产 endpoint 仍未带凭据验证；DeepSeek 测试不代表其他协议或其他兼容网关已验收。
- [x] 在干净临时目录安装 `npm pack` 产物并运行包消费者示例。
- [x] 实际运行 Python HTTP/SSE 客户端，对本地真实 COTO 服务完成回执、流式内容和终态验收。
- [ ] 实际运行 Java、Go、.NET 最小消费者；README 目前只提供接入片段。
- [ ] 通过真实反向代理验证 SSE 缓冲、心跳和重连行为。
- [x] 上传 `feat/agent-foundation` 并创建中文 [PR #1](https://github.com/Stormycry-cryp/COTO/pull/1)，Node 22.19.0 / 24.x CI 通过，已合入 `main`，merge commit 为 `aa15221ba93196e7083325028459d6966e21bb5a`。[合并后 CI](https://github.com/Stormycry-cryp/COTO/actions/runs/35413879578) 同样通过。

首次代码提交为 `819db5bf7ebec197a691c9270edf7b95380d181e`。本机 Git HTTPS 连接超时后，通过 GitHub Git Data API 发布功能分支，并校验远端源码树和提交 SHA 与本地完全一致。仓库提供源码和可构建 npm 包，尚未发布到 npm registry。

当前基础服务是单实例、单 workspace/default profile。多实例共享 Store、分布式租约、在线事件裁剪、WebSocket、多 Agent 调度和业务账号系统不在 `0.1.0` 实现范围内。Gemini 的底层 SDK 要求非空内部 key，因此 `auth: 'none'` 会发送空的 `x-goog-api-key` 来阻止 SDK 注入占位 key；不会发送 COTO 占位密钥，完全移除空 header 需要自建 Gemini 适配器。

## DeepSeek 真实端点验收（2026-09-19）

配置为 `protocol: openai-chat`、`baseURL: https://api.deepseek.com`、`model: deepseek-flash`，直接通过 Provider 适配器访问，无本地协议转换代理。测试用密钥经关闭回显的 stdin 注入进程环境，没有写入仓库、Session 文件或测试输出；会话使用 MemorySessionStore，工具只返回随机校验值。

- HTTP/SSE 全链路：通过 CotoClient 提交输入，真实模型调用只读工具 1 次，按实际工具结果输出随机 token；收到 26 段文本事件和 turn.completed。
- 上下文续接：后续请求准确复述前一轮随机 token，没有再次调用工具。修复后复测三次完整模型请求的 usage 分别为输入/输出 318/41、396/27、444/40；这些是该次响应的计量，取消请求的完整计费未知。
- 流式取消：固定短句提示收到首段文本后触发 AbortSignal，Provider 返回 aborted，没有交付后续完成结果。早先使用长计数任务的探针没有通过断言，因此改用确保检查文本阶段的短提示并单独复测。
- 本次发现并修复适配器取消后仍可能交付 SDK 缓冲完成事件的问题。四协议本地回归在修复前均失败、修复后均通过；全仓 63/63 测试、类型检查与构建通过。

`scripts/smoke-provider.mjs` 保存无密钥的可重跑脚本：每次输出最多 256 token，Runtime 最多 3 步、无自动重试；`COTO_PROBE_ONLY=cancellation` 可单独检查取消。默认 CI 不运行生产探针。这里只验收短文本、工具和上述会话路径，未验证长上下文、图片、DeepSeek 其他模型或服务端取消后的计费停止。

## 项目初始化与真实修改验收（2026-09-19）

首版合并后继续完成用户要求的开箱即用路径，核对清单见 [project-readiness.md](project-readiness.md)。

- 新增 `coto init/doctor/run/sessions`，`serve` 共用声明式配置；生成配置按用户选择默认 `allow-all`，注册基础 Tool 和 Skill 根目录。
- `@coto/agent/config` 导出 `loadProjectConfig()`，支持直接 Provider endpoint、协议、环境密钥、自定义 header、兼容选项、上下文和运行限额；`.env.coto` 只在配置闭包中解析。
- 初始化保护已有文件；`doctor` 不调用模型且不输出凭据值。基础文件工具禁止读取 `.env.coto`，进程工具仍是受信任宿主命令执行器。
- 修复真实安装中 npm bin 软链接及 macOS `/var` 路径导致 CLI 静默不执行的问题；修复进程忽略单次工具超时和 UTF-8 分块损坏问题。
- Session 和 Agent 的并发关闭等待完整释放；关闭期间创建/打开的会话会被纳入关闭；关闭后的写操作拒绝；重新 get 已关闭缓存时重开；撤回的 `runStream` 输入能够结束。
- CLI 在失败或取消后使用 `--session` 会显式恢复暂停的会话；有未核对工具副作用时在排队前报错。回归测试在修复前复现了 unsettled top-level await / 退出码 13，修复后用新提示完成一轮并退出 0。
- TTY 审批在回合超时或取消后结束读取；Provider compat 校验对齐当前 SDK；离线配置检查拒绝不合理的上下文 token 限额；服务密钥环境变量覆盖通过真实 HTTP fixture 验证。
- Node 22.23.2 / 24.21.0 独立 tarball 项目 smoke 已通过，覆盖 init 文件保护、doctor、真实文件工具、进程重启后 Session 续接、自定义 Tool/Skill、serve HTTP/SSE。CI 已加入此项。

真实模型项目探针使用 `scripts/smoke-live-project.mjs`，在独立临时目录安装 tarball。测试初始 addition 源码错误，先确认测试失败，再让 DeepSeek 读取源码和测试、修复源码、执行测试。实际 Tool 顺序为 `read_file`、`read_file`、`edit_file`、`read_file`、`exec_command`，模型观察到测试成功；父进程再次验证源码已修改、测试未修改并独立运行测试通过。模型回复本身不作为文件修复证据。

此次四个完整请求的输入/输出 usage 分别为 `1347/78`、`1582/154`、`1758/74`、`2007/122`。配置直连 `https://api.deepseek.com`，模型 `deepseek-flash`，`maxSteps=10`、`maxRetries=0`、`maxTurnMs=180000`、每次输出最多 1024 token。凭据经关闭回显的 stdin 注入，不保存到临时配置或仓库；会话日志检查未出现凭据，临时项目验证后清理。该探针不加入默认 CI，也不代表其他模型或复杂项目任务已验收。

最终本地验证使用 Node 22.23.2：类型检查、89/89 测试、构建、独立 tarball 项目 smoke 和 Python HTTP/SSE smoke 全部通过。tarball 项目检查额外通过 `npm exec -- coto doctor` 验证 npm bin 入口。后续 PR 检查结果以 GitHub Actions 对应提交为准。
