# vramfit

**下载模型之前，花两秒看看它在你电脑上跑不跑得动。**

<sub>by [RoRoToCode](https://www.roroto.com) · MIT · 命令行与网页共用同一份推算代码</sub>

[![CI](https://github.com/RoRoToCode/vramfit/actions/workflows/ci.yml/badge.svg)](https://github.com/RoRoToCode/vramfit/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/vramfit.svg)](https://www.npmjs.com/package/vramfit) [![npm downloads](https://img.shields.io/npm/dm/vramfit.svg)](https://www.npmjs.com/package/vramfit) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) ![Node](https://img.shields.io/badge/node-18%2B-brightgreen)

> **在线体验：<https://www.roroto.com/tools/vramfit/>**
> 不用装东西，贴个 HF 链接或拖进 `.gguf` 就有结果，模型文件不出浏览器。
> 想批量查、扫本地目录、读实测显存，再用下面的命令行。

English: [README.en.md](README.en.md)

只读 GGUF 文件头那几十 KB 元数据，结合本机显卡算出三件事：**装不装得下、能开多大上下文、大概每秒几个 token**，顺带判断能不能当 coding agent 用。

不下载模型、不写硬盘、不动你的配置。15 GB 的文件，只读前面几十 KB。

## 在线体验

<https://www.roroto.com/tools/vramfit/>

- 贴 HF 链接或拖入本地 `.gguf` 直接出报告，文件不出浏览器，不上传
- 贴模型主页，全部量化一张表比完
- 显卡按型号查表，已占显存可手填（默认 0.8 GB）
- 结论能生成一条链接分享出去

网页端干不了三件事：递归扫目录、读实测显存、`--json` 进 CI。那三件交给命令行。

`vram` 在这里泛指能分给模型的内存——独显显存、Apple Silicon 统一内存、核显共享内存，算的是同一件事。Mac 上照样能用，报告里写「可用作显存 21.33 GB」，不硬叫 VRAM。

## 使用方法

需要 Node 18+，纯 JS、零依赖。没有的话 Windows 一条命令：`winget install OpenJS.NodeJS.LTS`，或去 <https://nodejs.org/> 装 LTS。不想装就用网页版。

```bash
node --version                  # 要 v18.0.0+
npm i -g vramfit                # 装完直接 vramfit ...
# 不想装：npx vramfit model.gguf
```

下面都写 `node check.mjs`，换成 `vramfit` 或 `npx vramfit` 参数完全一样；clone 仓库直接跑也行。

### 方式一：交互模式（最省事）

Windows 双击 `check.cmd`，或直接 `node check.mjs`，粘链接回车就出报告：

```
  检查 > https://hf-mirror.com/unsloth/Qwen3-8B-GGUF
  检查 > D:\models\qwen3-8b-q4_k_m.gguf
  检查 > unsloth/Qwen3-8B-GGUF
  检查 > q
```

`Ctrl+V` 或右键粘贴，一次可以粘多条（空格或换行隔开）。从浏览器、微信、飞书复制来的零宽字符、中文引号、句末句号会自动清掉。旧版控制台或安全软件导致粘不进去，敲 `paste` 直接从剪贴板读。

其他命令：`help` 看参数、`cls` 清屏、`lang en` 切英文、`q` 退出。

### 方式二：拖拽

把 `.gguf`（可多选）或它所在的目录拖到 `check.cmd` 图标上。

**带 `&` 的网址别这么拖**：`cmd.exe` 把 `&` 当命令分隔符，会从中间截断。双击粘进窗口，或者加引号：

```cmd
check.cmd "https://host/x.gguf?download=true&rev=1"
```

### 方式三：一行命令

```bash
node check.mjs model.gguf                       # 单文件
node check.mjs models/                          # 递归扫目录（最深 6 层，只收 .gguf）
node check.mjs models/*.gguf                    # 批量
node check.mjs --json models/                   # 机器可读，能直接进 CI
node check.mjs --repo unsloth/Qwen3-8B-GGUF    # 列出仓库全部量化并逐个远程体检
```

**不用下载也能查**，贴链接只读文件头部（约 10–25 MB），不拉整个模型：

```bash
node check.mjs https://hf-mirror.com/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf
node check.mjs https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf
```

| 粘什么 | 会发生什么 |
|---|---|
| `.gguf` 直链 / 本地路径 / 目录 | 体检该文件 / 递归扫目录 |
| 模型主页、`owner/repo`、`tree/main` | 转成量化对比，列出全部变体 |
| `blob` 页面 | 自动换成 `resolve` 直链 |
| `huggingface.co` 链接 | 自动改走国内镜像，镜像不通再退回官方 |
| `hf-mirror.com` 链接 | 直接用，不用改 |

目录递归认 LM Studio 的 `models/<publisher>/<repo>/x.gguf` 布局，传上层目录就全扫了。

### 参数

| 选项 | 作用 |
|---|---|
| `--json` | 机器可读数组；某项含 `error` 只影响那个文件 |
| `--repo owner/name` | 列出 HF 仓库全部量化并逐个远程体检 |
| `-i, --interactive` | 兼容保留，不带参数本来就直接进交互模式 |
| `--kv <类型>` | KV cache 精度：`f16`（默认）/ `q8_0`（省一半显存）/ `q4_0` |
| `--vram 12` | 假装有 12 GB 显存（保留卡名和带宽），评估「换卡值不值」 |
| `--gpu N` | 按第 N 块卡评估，双卡机器必指定；不支持跨卡切分 |
| `--mirror <地址>` | 默认 `hf-mirror.com`；写 `https://huggingface.co` 直连官方 |
| `--lang zh\|en` | 界面语言，默认跟随系统，也可设 `VRAMFIT_LANG` |
| `--no-color` / `--ascii` | 关颜色 / 换 ASCII 符号，重定向和老终端用 |
| `--about` | 打印全部参数与假设，交代这份报告怎么算出来的 |
| `-v, --version` | 版本号 + 仓库地址 |

参数写错直接报错、退出码 1，不会悄悄用默认值；`--kv=q8_0` 这种等号写法也认。想长期换源，设 `VRAMFIT_MIRROR`。

**语言**：默认跟随系统，`--lang` 可固定；交互模式里敲 `lang en` / `en` / `cn` 即时切换，不清屏。GGUF、KV cache、Q4_K_M、tok/s 这些术语不翻，数字也不做本地化。`--json` 里的 `verdict` 是稳定标识，**不跟语言走**，同一份输入在哪台机器上都输出一样。

**退出码**：有文件读不到（或仓库里一个变体都读不到）返回 1，正常 0。配 `--json` 可以直接进 CI 卡流程。

### 报告长什么样

RTX 3050（8 GB）查 7B Q4_K_M，真实输出节选：

```
  GGUF 体检报告
  ═══════════════════════════════════════════════════════

  ✓ 可以当 coding agent 用
    32K 上下文装得下，模板也能驱动工具调用
    ⚠ 静态推算，仅供参考；实际加载运行一次才算数

  模型      4.36 GB · qwen2 · 7.00B · Q4_K_M · 原生 128K
           28 层 · 28 head / 4 KV head（GQA）
  硬件      RTX 3050 · CUDA · 带宽 224 GB/s
           显存 8.00 GB 总量 / 1.15 GB 已用 / 6.85 GB 可用
  显存预算  权重 4.36 GB + 开销 200 MiB → 上限 7.52 GB

  上下文       需要     占上限
      4K     4.78 GB  █████████████░░░░░░░ ✓
     32K     6.31 GB  █████████████████░░░ ✓
     64K     8.06 GB  ████████████████████ ✗
    128K    11.56 GB  ████████████████████ ✗

  建议上下文  32K（6.31 GB / 上限 7.52 GB）
     原生支持 128K，还能往上开，但显存不够
  Agent      模板 2.5 KB · ✓ tools 分支 · ✓ tool_call 格式
             模板级支持，稳不稳还得实跑
  预估速度   约 33 tok/s（224 GB/s ÷ 4.68 GB × 0.7）
```

真正影响使用的不是「能跑」，是 **「原生支持 128K，但你这台机器只能开到 32K」**。报告末尾都带一段「参数与假设」，`--about` 是完整版。

## 和网页版的关系

网页版源码在仓库的 `site/`，部署在 <https://www.roroto.com/tools/vramfit/>。构建时**直接读根目录**这几个目录，不复制、不改写：

| 目录 | 内容 | 谁在用 |
|---|---|---|
| `core/` | GGUF 解析、KV 推算、显存预算、量化判定；纯计算、无 IO | 命令行 + 网页 |
| `net/` | HTTP Range 读取 + HF 仓库列表，只用 `fetch` | 命令行 + 网页 |
| `cli/` | 本机硬件探测（`nvidia-smi` / `rocm-smi` / `sysctl`） | 只有命令行 |

同一份元数据进去，两边数字一样；差别只在硬件参数从哪来、结果怎么显示。

两条约束：`site/` 必须是仓库根的直接子目录，否则 `node site/build.mjs` 找不到 `core/`；`core/` 和 `net/` 不许 import `node:` 模块（浏览器直接引用，测试和 CI 守着）。npm 包里没有 `site/`，装命令行的人不会多下网页。

| | 网页版 | 命令行 |
|---|---|---|
| 安装 | 不用 | Node 18+ |
| 贴链接 / 拖文件 | ✅ 文件不出浏览器 | ✅ |
| 递归扫目录、批量、`--json` | ❌ | ✅ |
| 显存 / 已占用 | 查表（可手改） | 实测 |
| 分享结论 | 一条链接 | 截图 |

## 预估速度（tok/s）

每吐一个 token 要把全部权重读一遍，所以瓶颈是**显存带宽**，不是算力。就一行公式：

```
tok/s ≈ 带宽(GB/s) × 效率 ÷ 权重体积(GB)
```

拿 RTX 2080（448 GB/s）+ 9B Q4_K_M（5.78 GB）校准：`448 × 0.7 ÷ 5.78 = 54.3`，**实测 53.9**。0.7 这个系数就是这么定下来的。同一台机器把 8K / 16K / 32K / 64K 四档真拉起来测过：

| 上下文 | 预测 | 实测显存 | 误差 | 实测速度 |
|---|---|---|---|---|
| 8K | 5969 MiB | 5875 MiB | +1.6% | 52.7 tok/s |
| 16K | 6226 MiB | 6119 MiB | +1.7% | 51.1 tok/s |
| 32K | 6738 MiB | 6676 MiB | +0.9% | 53.9 tok/s |
| 64K | 7762 MiB | 7737 MiB | +0.3% | 57.1 tok/s |

预测一律略高于实测（宁可保守），误差都在 2% 内。64K 判 ✗ 是刻意的：实测能起来，但只剩 251 MiB，开个浏览器就 OOM——它推荐「敢放心用」的配置，不是「极限能塞进去」的最大值。

几处取舍：

- **权重装不下**就改用内存带宽算（约 60 GB/s），所以会看到 `~6 tok/s`，部分 offload 就这体验。
- **权重 < 2 GB 只给上限**：0.6B Q4 在 3050 上公式算出 395，实测 70–120，kernel launch、采样、传输这些固定开销占大头，公式在这个量级没意义。
- **MoE 会偏低**：按整体体积算，实际只激活部分专家，真实速度更高，报告里会标。
- **卡不在规格表里就不给速度**，不瞎猜。

`--json` 里两个字段别混：`genTokPerSec` 是零上下文、batch=1 的理论峰值，`genTokPerSecAtCtx` 是按建议上下文补上 KV 读取代价后的折减值。都不含首字延迟和工具执行，`speedBasis` 写明用的哪套口径。

一句话：**显存决定能开多少 token 上下文，带宽决定每秒吐多少 token。**

## 结论怎么读

| 字段 | 含义 |
|---|---|
| `verdict` | `agent-ready` / `runs-only` / `not-recommended` / `unknown`（元数据不全，不等于跑不动） |
| `recommendedCtx` | 装得下又不超过原生上下文的最大档；`null` 表示一档都不行，`tiers[]` 看各档边界 |
| `budget.limitBytes` / `basis` | 显存上限和它按哪套规则算的 |
| `gpu` / `cpuOnly` | 探到的卡，以及是不是退成 CPU 推理了 |
| `tools` | `strong/partial/weak/none`，模板字符串特征，不是实测能力 |

## 支持范围

| 平台 | 显存从哪读 | 上限怎么算 |
|---|---|---|
| Windows | `nvidia-smi` / `rocm-smi`，失败退注册表 | `max(可用×0.92, 总显存×0.94)`，WDDM 能驱逐 |
| Linux | `nvidia-smi` / `rocm-smi`，退 `/sys/class/drm` | 可用 × 0.92，显存不可驱逐 |
| macOS | `sysctl hw.memsize`，Metal 建议工作集 | 建议工作集 × 0.9 |
| 没有独显 | 物理内存 | × 0.8，按 CPU 推理算 |

核显按共享内存一半估，同时有独显时不会被选中。上限那行会写明当前用的哪套算法。

| 格式 | 状态 |
|---|---|
| **GGUF** | 支持：分片按「第 1 片 × 片数」折算，跳过 `mmproj`，量化和模板都从元数据读 |
| safetensors / MLX | 不支持：bf16 原文件不等于跑起来的样子，贴进来会直说格式不认识，不硬算 |

## 推算口径

常量全在 [`core/assumptions.mjs`](core/assumptions.mjs)，报告末尾的「参数与假设」、`--about`、网页面板读的都是这一份。

| 环节 | 怎么算 |
|---|---|
| 权重 | 文件字节数，分片按片数折算 |
| KV cache | `ctx × 层数 × n_kv_head × (k+v) × 每元素字节`；f16=2 B、q8_0=1.0625 B、q4_0=0.5625 B |
| 运行时开销 | 固定 200 MiB |
| 速度 | `带宽 × 0.7 ÷ 权重GB`，±15% |
| 门槛 | 需要量 > 上限×0.85 标「接近」；< 3B 只算能跑；< 8K 判太短；1–2 bit 判「别用」（经验分级） |

混合线性注意力（Qwen3-Next 等）、滑窗注意力（Gemma 3/4）、MTP 层、分片、原生上下文边界都自动处理，报告里会区分哪些是读到的、哪些是推断的。只看一张卡，不做张量并行。

## 免责

**所有数字都是算出来的，不是测出来的。** 它不加载模型、不跑推理、不测吞吐、不测首字延迟——只读 GGUF 头部的元数据，套一套硬件规格做算术。

所以：

- 显存预测在真机校准过，误差 < 2%，但那是 RTX 2080 上的四档；换平台、换架构会有偏差。
- 速度按带宽估，±15%；小模型和大 MoE 偏得更多。
- `agent-ready` 只说明「装得下、模板里有 tools 分支」，**不代表模型真能稳定调工具**；`unknown` 是元数据不全算不出来，**不代表跑不动**。
- 结论只供参考，不是对性能、兼容性或购买决策的承诺。真答案永远是你在自己机器上加载跑一次。

**许可层面**：MIT，按「现状」提供，不含任何明示或暗示的担保；照着它买硬件、下模型最后跑不起来，作者不承担责任（详见 [`LICENSE`](LICENSE)）。

## 常见问题

- **没有独显能用吗？** 能，按内存 80% 和内存带宽算，报告标「CPU 推理」。这速度做 agent 基本没戏，但装不装得下、模板支不支持工具这些结论仍然有效。
- **AMD / Intel 卡呢？** 显存靠注册表读，能给容量判断；但 llama.cpp 走 Vulkan/ROCm，实际可用显存和速度有出入，报告后端会标 Vulkan。
- **为什么建议上下文比宣传的小这么多？** KV cache 跟着上下文涨，9B 开 64K 光 KV 就 4 GB 以上，8G 卡塞不下。宣传「支持 256K」通常指 24G 以上的卡。
- **粘贴没反应 / 拖网址报错？** 旧版 raw 模式的问题修了（现在用熟模式，保留 `ENABLE_QUICK_EDIT_MODE`）。还不行就敲 `paste`；`&` 被 `cmd.exe` 截断的，加引号或粘进窗口。
- **提示「没认出这是链接还是文件」？** 域名只认 `huggingface.co` / `hf-mirror.com` / `hf-mirror.net`。零宽字符、中文引号、`&amp;` 会自动清掉，还不行就看看链接里是不是夹了中文说明或空格。
- **报「网络连不上 / 拿不到文件大小」？** 两种原因：不是 `.gguf` 直链（换成直链或模型主页），或者镜像限流（等 1–2 分钟，工具会重试并退回官方源）。
- **分片模型怎么查？** 指第 1 片，体积自动按片数折算。指到后面几片会提示你改回来——那些文件里没元数据。
- **0.6B 各项都合格，还说不能做 agent？** 有条硬门槛：< 3B 只判「能跑，但太小」。这不是能力评测，是拦掉明显不可能的档位。

## 反馈与许可

| 情况 | 去哪 |
|---|---|
| 算错 / 崩了 / 模型认不出来 | [GitHub Issues](https://github.com/RoRoToCode/vramfit/issues) |
| 安全问题 / 商用合作 | <su@roroto.com>（安全别开 Issue） |
| 想自己改 | [CONTRIBUTING.md](CONTRIBUTING.md) |

提 Issue 带上三样：模型链接、显卡型号和显存、`node check.mjs --about` 的输出。

觉得有用，给仓库点个 **Star** ⭐——让更多人少白下几个 G 的模型。

**MIT**：商用、闭源、改名、打包进自己的产品都行，没有义务公开代码。但复制代码或二次分发时保留 [`LICENSE`](LICENSE)、注明「基于 vramfit」，别叫官方版；引用结论建议写「数据来自 vramfit」并附链接（仓库页 **Cite** 按钮能按 [CITATION.cff](CITATION.cff) 生成 BibTeX / APA）。
