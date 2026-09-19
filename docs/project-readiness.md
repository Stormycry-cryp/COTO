# 项目接入可用性核对

目标：新项目安装 COTO 后，通过初始化、一次凭据配置和标准运行命令即可处理项目任务；同一配置可用于嵌入式 Agent 和 HTTP/SSE 服务。用户授权持续修复验收中发现的问题，使用指定 DeepSeek 模型进行少量真实调用。

用户已选择新项目初始化的默认 policy 为 `allow-all`，直接执行已注册工具；生成的配置显式记录该值，允许项目改为 `ask` 或 `read-only`。

## 交付步骤

- [x] 项目入口：`coto init` 生成可修改的声明式配置、凭据模板和最小嵌入示例；`coto doctor` 离线检查配置/凭据可用性；`coto run` 执行任务并支持明确的 policy、Session 续接、流式与 JSON 事件输出。
- [x] 单一配置：CLI、serve 和项目示例使用同一个配置加载器，支持自定义 endpoint/header/env。初始化必须保护已有文件、避免持久化密钥；默认输出基础工具与 Skill 配置，模型流直接访问目标 Provider。
- [x] 生命周期：回归检查 Session 创建/关闭、Provider 切换、恢复与活动工具处理，修复可复现的死锁、跨会话影响和状态错误。自定义扩展仍必须遵守取消契约。
- [x] 消费者验收：干净临时项目安装 tarball，执行 init/doctor/run、重启后续接、HTTP/SSE 服务和自定义 Tool/Skill。自动化使用本地协议 fixture，不把凭据加入 CI。
- [x] 真实项目验收：独立临时项目使用 DeepSeek 完成读取文件、实际编辑和结果核对；命令设置调用/时间上限，凭据仅在进程中注入。
- [x] 交付：更新 README、后端文档、实施证据和 PR；GitHub Node 22/24 CI 通过，提供固定 commit 和安装方式。

## 验证标准

初始化可重复执行且不覆盖用户文件；缺少配置/凭据有可执行的错误提示；未知选项失败；非交互执行不会永久等待审批；实际包在不含仓库源码的项目里可用。类型检查、关键行为测试和安装 smoke 必须使用声明支持的 Node 版本。

遇到问题先固定复现，再做范围内修复和回归。这里的可用性指以上可证明的项目流程，不承诺所有模型和宿主环境绝无错误。Java/Go/.NET 使用协议接入，生产多实例、OS 沙箱、企业账号和 npm registry 发布继续保留为宿主接入边界。

## 执行记录

- DeepSeek 首轮真实端点验收已完成；取消后 SDK 缓冲事件问题已修复，63 项测试及 GitHub Node 22.19.0 / 24.x CI 通过，提交 d93c695。
- 首版 PR #1 已合并到 `main`，merge commit `aa15221`，合并后 GitHub CI 通过。
- 新增配置加载器与 `init/doctor/run/sessions/serve`，Node 22/24 的独立 tarball 项目验收通过；配置与 CLI 的定点测试覆盖缺少凭据、文件保护、非交互审批、续接及取消。
- 修复关闭中的 Session 创建/打开竞态、重复 close 提前返回、缓存关闭会话重开、撤回输入后流挂起、符号链接工作区身份，以及进程单次超时和 UTF-8 分块。生命周期 17 项、Tool/Skill 10 项定点回归通过。
- DeepSeek 真实项目：独立目录安装 tarball，默认 allow-all；模型先 read_file，再 edit_file，最后 exec_command 执行 `node --test calculator.test.mjs`，结果通过。父进程核对测试文件未改、源码已改，再独立执行测试通过；会话日志没有测试密钥。四次请求用量见实施记录。
- 最终本地检查：Node 22.23.2 类型检查、89/89 测试、构建通过；项目 tarball smoke 包含 `npm exec -- coto doctor`，验证实际 npm bin 入口；Python HTTP/SSE smoke 通过。
- [PR #2](https://github.com/Stormycry-cryp/COTO/pull/2) 的功能提交为 `0eb789a430599ebdd262420771b6f8a1687dd1af`；[GitHub CI](https://github.com/Stormycry-cryp/COTO/actions/runs/35415061399) 的 Node 22.19.0 和 24.x 均通过。PR 页面记录最终合并状态。
- 固定版本接入：`npm install 'git+https://github.com/Stormycry-cryp/COTO.git#0eb789a430599ebdd262420771b6f8a1687dd1af'`，然后执行 `npx coto init`；凭据配置后运行 `npx coto doctor`、`npx coto run '项目任务'`。
