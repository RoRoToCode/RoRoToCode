# RoRoTo Code

![platform](https://img.shields.io/badge/platform-Windows-blue)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![license](https://img.shields.io/badge/license-MIT-green)

> 把 llama.cpp / GGUF 从「能跑起来」做到「能当 coding agent 稳定用」的 Windows 本地工程化层。

本地跑大模型最麻烦的从来不是「怎么启动」，而是**判断**和**善后**：

- 这张 8G 卡装得下 14B 的 Q4，还是连 7B 都吃紧？上下文开 64K 会不会直接 OOM？
- 装完系统提示和工具定义，还剩几轮可用？
- 界面写着「GPU · CUDA」，为什么显存一动不动、速度只有 1/5？
- 14B 吐出来的工具参数不是合法 JSON、思考把输出预算吃光、同一段话复读三遍……

RoRoTo Code 是一个 Windows 桌面 coding agent，把本地模型这条链路——选模型、装后端、定上下文、看住进程、兜住小模型的坏脾气——整条收敛掉。Ollama、LM Studio、OpenAI 兼容 API 与 Anthropic 也放在同一个界面里，但**本地 GGUF 是主战场**。

---

## 核心：本地模型这一整条链路

### 1. 体检：读真实 GGUF 文件头，不按参数量估

`tools/vramfit` 只读文件头的元数据（几十 KB，从不下载权重），解析出架构、层数、KV 头数、量化类型、原生上下文和 chat template，再结合本机显存算账：

```bash
node tools/vramfit/check.mjs Qwen2.5-Coder-14B-Q4_K_M.gguf
node tools/vramfit/check.mjs Qwen2.5-Coder-14B-Q4_K_M.gguf --json
```

静态推算的口径是公开的，不是黑盒：

- 显存占用 ≈ **权重字节 + `ctx × KV 层数 × n_kv_head × (k_dim + v_dim) × 每元素字节` + 200 MiB 开销**（滑窗层、GQA、MoE、混合线性注意力分别折算）
- Windows 可用上限 ≈ `min(空闲显存 × 0.92, 总显存 × 0.94)`；读不到已用显存时按 `总量 × 0.6` 保守估
- 生成速度 ≈ `显存带宽 × 0.7 ÷ 权重 GB`，再随上下文增长折减

输出给出 4K / 8K / 16K / 32K / 64K / 128K 各档能否装下、建议上下文、`agent-ready / runs-only / not-recommended` 判定与预估 tok/s。报告会分辨「能跑」和「能当 agent 用」——3B 以下只判 `runs-only`，工具调用模板缺失也会点名。

**agent 余量**是主程序在体检报告上补的一层（`src/main/vramfit.ts`）：按本程序自己的系统提示与工具定义约 6000 token、每轮工具往返约 1800 token，算出「装完这些之后还能跑几轮」，而不只是「上下文能开多大」。这是本地小模型最该看的数字。

> 体检是静态推算，不是实测。真正的加载结果由下面的启动探测链兜底。

### 2. 装包：显卡后端不靠猜

- **三层探测选后端**：`nvidia-smi`（含驱动 CUDA 版本、算力）→ WMI 显卡名 → 才落 CPU；N 卡装 CUDA + cudart，A 卡 / Intel 核显装 Vulkan，选包时避开「运行时比驱动新」的组合。想钉死后端设 `ROROTO_LLAMA_BACKEND=cuda|vulkan|cpu`。
- **自动补齐运行库**：只解出 `ggml-cuda.dll` 而没有 cuBLAS / cudart 时，llama.cpp 会**静默退回 CPU**——界面显示 GPU，实际速度只有 1/5。现在缺哪几个 dll 会直接点名，并在安装时单独下载 `cudart` 包补齐。
- **装完和启动前各跑一次 `llama-server --list-devices`**：列不出 GPU 就警告；用户显式绑卡却看不到设备，直接以 `GPU_UNAVAILABLE` 拒绝启动，不再假装成功。
- **下载不抢跑**：4 个源并发测速排序，换源前每个源至少给 15 秒窗口（一次瞬时 429/403 不会把四个源几秒内全判死），`Range` 断点续传换源不丢进度，解压前校验 `PK` 防止把镜像错误页当安装包。等待期间点「取消」立即返回。

### 3. 启动：体检结论直接变成启动参数

按**这次实际绑的那张卡**重新体检，KV 精度（`-ctk/-ctv`）与体检用的 `--kv` 保持一致，避免按 f16 估算少算 25%；贴着上限就主动降一档。

- **上下文探测链**：首档取体检建议，就绪后按「能否应答 / `n_ctx` 是否生效 / 单槽窗口够不够 agent 用」三重判据决定降档或升档；结论带环境指纹落盘，下次同环境走快路径不重载。只因「显存不够」「窗口超训练长度」才降档，最坏 5 次加载。
- **超预算转部分卸载**：权重确实装不下时用 `--fit on --fit-target <MiB>` 分层卸载，而不是直接判失败；发图时按 mmproj 投影器预算重新收窗口。
- **为本地模型调过的启动参数**：`--repeat-penalty 1.05`、DRY（`--dry-penalty-last-n 2048`，抓整段循环）、`--reasoning-budget 512`（给 `<think>` 封顶）、`-fa on`、`--cache-reuse 256`、可选的投机解码；`-np` 恒定显式传（llama.cpp 不传会自作主张开 4 槽，8G 卡实测掉到 1.55 tok/s），多槽时才加 `-kvu` 做 KV 共享。
- **多槽并发实测**：设置页可一键测「真并行 / 上下文被切成 1/N / 其实是排队跑 / 不是 llama.cpp」，判定看两个并发请求**各自的耗时比值**，不是总时长。
- 空闲自动卸载显存；本机请求按服务端槽位排队，满了立刻拒绝，绝不无声挂住。

### 4. 跑起来之后：可观测、可自愈

- **四态状态机** `idle / loading / ready / error` + 10 个机器可读 `error.code`（`VRAM_SHORT`、`GPU_UNAVAILABLE`、`CRASHED`、`START_TIMEOUT`、`PORT_BUSY`…）。
- 非零退出按 **2s / 6s / 18s** 退避重启，最多 3 次；退出码与日志尾部落 `userData/logs/`。
- **日志翻译**：`unknown model architecture`、显存不足、缺 CUDA dll、端口占用各自给出下一步怎么办，而不是只丢一句「已退出（退出码 1）」。
- **断流说人话**：流式请求中途断开会先探一次服务是否还活着，再区分「进程已经不在了」和「服务在、但把这次请求掐了（上下文超了 / 显存不够 / 正在重启）」；`TypeError: terminated` 不会原样弹到界面。
- 故意不提供「预计剩余 N 秒」——首次加载受模型大小、量化、磁盘缓存、mmap 影响，实测方差可达 3 倍。给的是阶段 `phase` 与已耗时 `elapsedMs`。

### 5. 小模型护栏（14B 以下尤其明显）

- **坏 JSON 三层修复**：先修语法（剥掉 Markdown 代码块外壳、补引号、去尾逗号、认 `True`/`None`、字符串内裸换行），再按工具 schema 强转类型认别名（`file_path`→`path`、`text`→`content`、`{"input":{...}}` 解包），最后按字段名逐个抢救；真救不回来就把「第几个字符附近坏了」告诉模型。修过的调用会在结果前标注，不让模型以为自己本来就写对了。
- **写到一半的内容绝不落盘**：字符串没闭合（上下文被截断）时整个字段放弃、整条调用不执行，并明确说「截断了」而不是「缺参数」——后者会让模型补一个空字符串再发一遍，那才是真把文件清空。
- **防复读**：服务端 repeat-penalty + DRY，客户端另有流式熔断（末尾探针在窗口内周期性出现 3 次即停推、落库前剪掉重复尾巴）；`reasoning_content` 单独接收不混进正文，思考耗尽预算时直接说明原因，不做空白重试。
- **重复动作护栏**：同工具 + 同参数 + 同样结果算空转，写工具第 3 次、只读工具第 5 次拦下并把上次结果还回去。
- 本地模型上下文小，因此还有 `repo_map`（按 mtime 增量维护的仓库符号地图）、按改动清单只跑相关测试、失败只回灌失败段落这些省上下文的设计。

### 6. 多实例与多来源

按供应商建实例，每个实例有自己的端口、绑的显卡和 PID；双卡可以各跑一个模型（`-dev CUDA0 -ngl 999`，不做跨卡切分）。端口真的 bind 探测，`8080 → 8083` 顺延后可再扫 64 个端口，崩溃重启也会重新确认端口。

模型来源：本地 GGUF（含离线把 Ollama 的 blob 搬进来、自动配对 mmproj）、Ollama（原生协议以带上 `num_ctx`）、LM Studio、任意 OpenAI 兼容 API、Anthropic。云端条目不预置，需要自己在设置里添加。

---

## vramfit：可以单独拿走用

`tools/vramfit/` 是零依赖的独立 CLI，**跨平台、Node 18+**（主程序是 Windows + Node 22+），不装 RoRoTo Code 也能用：

```bash
node tools/vramfit/check.mjs <模型.gguf>              # 本地文件、目录（递归 6 层）
node tools/vramfit/check.mjs Qwen/Qwen2.5-Coder-14B   # HF 直链 / owner/repo，HTTP Range 只读头部
node tools/vramfit/check.mjs <模型.gguf> --json       # 可进 CI / 脚本
```

常用参数：`--kv f16|q8_0|q4_0|k8v16`、`--vram <GB>`、`--gpu N`、`--mmproj <file>`、`--mirror <url>`、`--lang zh|en`。无参数进交互模式，Windows 可双击 `check.cmd`，支持从剪贴板读链接。

`--json` 输出 `tiers`、`recommendedCtx`、`genTokPerSec`、`genTokPerSecAtCtx`、`tools`、`verdict` 等字段，恒定不随语言变化。自带 64 项测试，跑在 3 个 OS × Node 18/20/22 上。

---

## 安装

要求 **Windows 10/11**。

```powershell
winget install RoRoToCode.RoRoToCode   # winget 清单通过社区仓库审核后可用
```

也可以从 [Releases](https://github.com/RoRoToCode/RoRoToCode/releases) 直接下载 `RoRoToCode-<版本>-portable.exe`，免安装双击即用；需要安装向导（可选安装目录）时用 `RoRoToCode-<版本>-setup.exe`。首次启动后在设置里选本地 GGUF → 一键安装 llama.cpp → 体检 → 起服务。

运行时的大文件（llama.cpp 运行库、GGUF 模型、简易核心）默认存在用户数据目录，升级版本不会丢；需要「模型跟 exe 放一起」时设 `ROROTO_PORTABLE=1`，自定义位置设 `ROROTO_DATA_DIR`。配置、会话、日志一直都在用户数据目录。

从源码运行或参与开发见下面的「快速开始」。

---

## 快速开始

要求 **Windows + Node 22+**（进程管理、显卡探测、密钥加密用到 `taskkill` / WMI / DPAPI）。

```bash
npm install
npm run dev        # vite + electron，热更新
npm run build      # 编译主进程 + 打包渲染进程
npm start          # 构建后启动
npm run dist       # 打 portable exe
npm test           # 462 项纯函数单测
npm run typecheck  # 主进程 + 渲染层
npm run lint
```

启动后在设置里选本地 GGUF → 一键安装 llama.cpp → 体检 → 起服务。`npm run smoke:realmodel` 会起真的 llama-server、加载真的 gguf 走一次真对话（配置写临时 userData，不碰真实数据）。

目录：`src/main/` 主进程（agent、llama 管理、工具、存储）、`src/renderer/` React 界面、`src/shared/` 共用类型与协议、`tools/vramfit/` 显存体检 CLI、`sdk/` 零依赖控制面客户端、`tests/` 单测。

---

## 对外接口

**数据面**：`llama-server` 提供标准 OpenAI 兼容 `/v1`，可直接填进 Cline / Cursor / Continue：

- Base URL：`http://127.0.0.1:<llama 端口>/v1`
- API Key：`local`（本地服务不校验，填非空即可）
- Model：`/status` 里的 `openai[].model`，或设置页「外部接入」直接复制

Claude Code 走 Anthropic 协议，不能直连 llama-server，本程序也不代理 Anthropic 格式。

**控制面**：主进程内置 `127.0.0.1:7788`（只绑本机），每次启动生成随机 token 写入用户数据目录的 `daemon.json`。`GET /health`、`GET /status?provider=<id>`、`GET /events`（SSE）、`POST /start`、`POST /stop`，另有 OpenAPI 3.1 的 `/openapi.json` 与把 15 个 agent 工具暴露出去的 `/mcp`（Streamable HTTP）。`sdk/roroto.mjs` 是零依赖客户端。

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7788/status
RoRoToCode.exe --headless --port=7788   # 无窗口模式，可交给 nssm / 计划任务
```

> 主进程持有单实例锁，`--headless` 不能与 GUI 同时运行。

---

## 其余功能（简）

agent 工具调用与子代理并行、diff 预览与逐块审阅、计划模式（只读方案 → 批准后本会话可写）、TS/JS 内置 tsserver 与多语言诊断、结构化 Git、格式化/lint、交互式终端、扩展点（hooks / 斜杠命令 / 自定义档案）、技能系统与 `/learn` 蒸馏、常驻档案与定时任务、会话分叉与便签、审批与用量闸门、五套配色与字体调节。安全相关的边界（API Key 用 `safeStorage`/DPAPI 加密、随仓库的 hooks 默认不执行、高危操作每次确认、命令并非沙箱）也都在实现里，请勿在不受信任的仓库开自动执行。

## 质量

`npm test` 462 项全过，`npm run typecheck` 与 `npm run lint` 零报错；`.github/workflows/ci.yml` 在每次 push / PR 的 `windows-latest` 上固化这三道门。测试数随提交变化，以本地实跑为准。

## 许可与第三方组件

本项目源码为 **MIT**（见 `LICENSE`）。运行时会下载或依赖不属于本项目的组件，各自适用其条款：[llama.cpp](https://github.com/ggml-org/llama.cpp)（MIT）、NVIDIA CUDA / cuBLAS / cudart（NVIDIA 专有许可）、LLVM OpenMP（Apache-2.0 WITH LLVM-exception）、以及每个 GGUF 模型自身的模型许可。**本源码仓库不包含这些二进制与模型文件**；若通过 Releases 获取便携包，请一并遵守上述条款。

另外，`tools/apiprobe/check.mjs` 是一个连测多个 API 端点连通性的命令行工具，属于开发期的调研脚本，不随产品分发。

## 免责声明

本项目按 MIT 许可「按原样」提供，不附带任何明示或暗示的担保。它是一个会替你读写文件、执行命令的 agent，请知悉并自行承担以下风险：

- 模型生成或执行的代码、命令、文件改动，后果由使用者自行承担；涉及删除、改系统配置、联网操作时请先审阅再放行。
- 命令并非在沙箱中运行，均以你的账户身份执行，请勿在不受信任的仓库里开启自动执行。
- 运行时会下载或依赖 llama.cpp、显卡驱动、CUDA 运行库及 GGUF 模型等第三方组件，其许可、可用性与安全性归各自所有方，与本项目无关。
