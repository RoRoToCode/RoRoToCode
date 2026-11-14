# 贡献指南

感谢你愿意为 RoRoTo Code 贡献代码。这个项目是 Windows 上的本地 coding agent，核心是把 llama.cpp / GGUF 从「能跑起来」做到「能当 agent 稳定用」。

## 本地跑起来

要求 Node.js 22+，只支持 Windows。

```bash
git clone https://github.com/RoRoToCode/RoRoToCode.git
cd RoRoToCode
npm install
npm run dev        # 起 Vite + Electron 开发环境
```

常用脚本：

- `npm test` —— 跑全部单测（约 440 项）
- `npm run typecheck` —— 主进程 + 渲染进程类型检查
- `npm run lint` —— ESLint
- `npm run build` —— 完整构建
- `npm run dist` —— 打便携包（产物在 `release/`）

## 提交前自检

这三道门必须全绿，CI 也会在 PR 上跑同样的检查：

```bash
npm test
npm run typecheck
npm run lint
```

## 代码风格

- 语言：TypeScript，主进程在 `src/main/`，渲染进程在 `src/renderer/`，共享类型在 `src/shared/`
- 单测：`tests/*.cjs`，用 Node 内置 `node:test`，不引入额外测试框架
- 提交信息：英文，一行说清楚改了什么；涉及行为变更时说明动机

## 提 PR 的流程

1. 从 `main` 拉新分支，一个 PR 只做一件事
2. 加/改功能时，同时补对应的测试
3. 跑通上面三道自检
4. 提交 PR，按 PR 模板填写自检清单
5. 等 CI 变绿，回应 review 意见

## 关注方向

改动最容易踩坑、也最需要谨慎的是这几块：

- `src/main/llama.ts` —— llama.cpp 实例生命周期与后端选择
- `tools/vramfit/` —— GGUF 文件头体检，改动会直接影响「该选什么模型」的判断
- 小模型护栏（坏 JSON 修复、防复读熔断、思考预算）——这些是本地模型稳定性的关键

涉及上面任何一块，尽量在 PR 里说明你验证过的场景（什么模型、多大上下文、什么显卡后端）。
