# Third-Party Notices

COTO 自身代码使用 MIT License，见仓库根目录的 `LICENSE`。

## OpenAI Codex

- 项目：OpenAI Codex
- 仓库：https://github.com/openai/codex
- 固定研究版本：`7498521d288b9b3b96ffba4eedf089d8d6e06a84`
- 许可证：Apache License 2.0

仓库中的 `upstream/codex` 是用于架构研究和可追溯核对的上游源码快照，不是 COTO 的运行时依赖，也不随 `@coto/agent` npm 包分发。固定版本、获取方式及上游 LICENSE/NOTICE 路径记录在 `upstream.lock.json`。

COTO 的 Runtime、Context、Tool/Skill 和 Session 由本项目以 TypeScript 实现。项目名称和文档不表示 OpenAI 对 COTO 的背书，也不表示 COTO 是官方 Codex 发行版。

## Pi AI

- npm 包：`@earendil-works/pi-ai` `0.85.1`
- 仓库：https://github.com/earendil-works/pi
- 目录：`packages/ai`
- 许可证：MIT

COTO 使用 Pi AI 作为运行时依赖，负责 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Google Gemini 协议的流式请求适配。Pi AI 的版权和许可证仍归其原作者所有。

## 其他依赖

完整运行时和开发依赖及固定版本见 `package-lock.json`。重新分发 COTO 时，应同时遵守各依赖自身的许可证和声明。
