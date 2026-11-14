---
name: vramfit
description: 判断 GGUF 模型能不能在本机显存跑起来、能开多大上下文、能否当 coding agent 用。当用户问某个 .gguf 或 HF 模型跑不跑得动、选哪个量化、要不要下载、或要批量体检模型目录时使用。只读文件头，不下载模型。
---

# vramfit — GGUF 显存体检

只读 GGUF 文件头 + 本机显存 → 显存预算、可用上下文、agent 可用性、速度量级。用于下载/加载前排除跑不动的选项，不是跑分。

## 触发

- 「这个 Q4 跑得动吗」「8G 能开 64K 吗」
- 给了 HF 仓库或 `.gguf` 路径，要判断能否下载/启动
- 多量化档取舍、递归扫模型目录、要 `--json` 进脚本或报告

不适用：非 GGUF、实测性能、多卡切分与张量并行。

## CLI 定位

不带脚本副本。按序找到 `check.mjs`，下文记作 `CLI`（执行时替换成实际命令，勿原样输入）：

1. **绝对路径优先** —— 用户级技能会在任意工作区触发，相对路径那时不存在：`node /abs/path/RoRoToCode/tools/vramfit/check.mjs`
2. 工作区有 `tools/vramfit/check.mjs` → `node tools/vramfit/check.mjs`
3. 便携版：exe 同级 `resources/vramfit/check.mjs`；安装包不带 `node.exe`，需自备 Node 18+ 或 `ELECTRON_RUN_AS_NODE=1`
4. 都没有 → `npx vramfit`（需联网，版本可能与工作区不同）

`core/`、`net/`、`cli/` 须与 `check.mjs` 同目录树，勿单拷文件。先 `node --version` 与 `CLI --version` 验环境。

## 命令

```bash
CLI --json path/to/model.gguf
CLI --json path/to/models
CLI unsloth/Qwen3-8B-GGUF
CLI --json --gpu 1 --vram 8 path/to/model.gguf
CLI --about
```

参数：`--json` 机器可读 ｜ `--gpu N` 第 N 块卡（双卡必指定）｜ `--vram GB` 手动给显存、跳过探测 ｜ `--repo owner/name` 列出全部量化并逐个远程体检 ｜ `--kv f16|q8_0|q4_0`（默认 f16，q8_0 约省一半）｜ `--mirror URL`（默认已是 hf-mirror.com，直连官方写 `--mirror https://huggingface.co`）｜ `--lang zh|en` ｜ `--about` / `--help`

目录递归最深 6 层、只收 `.gguf`。`--json` 是数组；单项含 `error` 只影响该文件，有 error 项退出码 1，否则 0。非 GGUF 报「不是 GGUF 文件（magic 不匹配）」。

## 结果字段（稳定契约）

| 字段 | 含义 |
| --- | --- |
| `verdict` | `agent-ready` / `runs-only` / `not-recommended` / `unknown`（元数据不全，≠ 跑不动） |
| `recommendedCtx` | 装得下且 ≤ 原生上下文的最大档；`null` = 一档都不行。配 `tiers[]`（`ctx`/`needBytes`/`fits`）看边界 |
| `budget.limitBytes` / `basis` | 显存上限及算法来源（Windows WDDM / Linux / macOS 规则不同） |
| `gpu` / `cpuOnly` | 探到的显卡 / 是否退化为 CPU 推理 |
| `tools` | `strong/partial/weak/none`，模板字符串特征，非实测能力 |
| `genTokPerSec` / `genTokPerSecAtCtx` | 零上下文理论峰值 / 按建议上下文折减；均非实测，不含首字延迟与工具执行 |
| `nativeContext` `params` `quant` `layers` `shard` `moe` | 模型侧信息；有 `moe` 时速度常被低估 |
| `disclaimer` | 原文口径，汇报时一并带上 |

## 汇报

顺序：装不装得下 → 建议上下文 → agent 可用性 → 速度量级。突出「原生 128K、本机只能 32K」这类数字。

- 必须附：静态推算、非实测，实际加载运行一次才算数。
- 禁止：`agent-ready` ≠ 稳定调用工具；`unknown` ≠ 跑不动。

## 边界

- 只看第一块卡；`nvidia-smi` / `rocm-smi` / `sysctl` 都取不到 → CPU 口径，用 `--vram` 纠正。
- HF 拉取失败：试 `--mirror https://huggingface.co`，或让用户下到本地传路径。
- 被问数字来源 → `CLI --about`（常量在 `core/assumptions.mjs`），别凭记忆编。
- 只读文件头几十 KB，不下载、不写盘、不改配置。
- RoRoToCode 已内置（本地模型体检卡 + `fitForLaunch()` 自动收缩上下文）；本技能用于对话里按需、批量或跨仓库调用。`run_shell` 会触发审批，一次写全参数；装过同名技能时保留一条即可。
- MIT，二次分发保留 `LICENSE` 并注明「基于 vramfit」。
