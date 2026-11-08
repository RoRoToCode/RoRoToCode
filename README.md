# RoRoTo Code

Windows 上的本地 coding agent：把 llama.cpp 模型、Ollama / LM Studio、云端 API 放在同一个对话界面里，
按「这台机器能不能跑得动」来判断该用哪个模型、能把上下文开多大。

![status](https://img.shields.io/badge/platform-Windows-blue)
![license](https://img.shields.io/badge/license-MIT-green)

## 它解决什么

本地跑大模型最烦的不是「怎么启动」，而是**判断**：

- 这张 8G 卡能装下 32B 的 Q4，还是只能跑 14B？
- 上下文开 64K 会不会直接 OOM？
- 装进系统提示 + 工具定义 + 历史之后，还剩几轮可用？

`tools/vramfit` 读真实 GGUF 文件头（不是按参数量估），结合本机显存与内存给出档位建议，
启动时按体检结论自动收缩上下文。这部分可以脱离主程序单独用：

```bash
node tools/vramfit/check.mjs <模型.gguf>
node tools/vramfit/check.mjs <模型.gguf> --json
```

## 功能

- **本地模型**：自动下载 / 解压 llama.cpp，按供应商建实例（双卡可各跑一个），端口被占自动换
- **模型体检**：启动前算显存够不够、建议上下文、预估 tok/s，并给出**agent 余量**
  （扣掉系统提示与工具定义后还能跑几轮，而不只是「上下文能开多大」）
- **崩溃自愈**：非零退出按 2s / 6s / 18s 退避重启，最多 3 次；日志落 `userData/logs/`，状态接口带退出码与日志尾部
- **四态状态**：`idle / loading / ready / error` + 机器可读 `error.code`
- **多种后端**：llama.cpp、Ollama、LM Studio、任意 OpenAI 兼容 API、Anthropic
- **Agent 能力**：工具调用、子代理并行、diff 预览、审批确认、skills
- **长任务**：`run_shell` 带 `background` 参数，挂到后台后用 `shell_bg` 看日志、结束进程
- **回收站**：删掉的会话保留 7 天，可恢复
- **删掉某一轮对话**：提问、回答、工具输出整轮一起删，后续每轮少带这段历史；已压缩的摘要同步作废，不会把删掉的内容再喂回模型
- **用量与花费**：按会话累计输入 / 输出 token；模型在价格表里才估花费，不认识的只报 token，不编数字
- **可定制快捷键**：默认 `Ctrl+K` 搜索、`Ctrl+N` 新建、`Ctrl+E` 导出、`Ctrl+,` 设置，可在设置里重绑
- **五套配色**：黑 / 白 / 灰 / 大条纹 / 高对比（纯黑底白字，焦点框加粗）
- **字体独立可调**：字号 85%～140%，对话正文可单独设，和界面缩放互不影响
- **可查的故障现场**：滚动 `main.log`，`uncaughtException` / `unhandledRejection` 落盘，设置里一键打开日志目录

## 安全边界

这些是「减少误伤」的设计，不是安全沙箱，用之前请心里有数：

- **API Key 加密落盘**：用 Electron `safeStorage`（Windows 上即 DPAPI）加密后写 `config.json`，
  密文前缀 `enc:v1:`。它是「当前用户 + 当前机器」级别——同一个账户下的其他程序照样能解。
  真正挡住的是「配置文件被拷走 / 误传 / 打进日志」。换机器或换系统账户后解不开，设置页会提示重填。
- **命令执行不是隔离环境**：子进程只继承 PATH、SystemRoot、TEMP 这类白名单变量，
  用户 shell 里的 `*_API_KEY` / `*_TOKEN` 不会下传；但命令本身仍以你的身份运行，
  请勿在不受信任的仓库里开「自动执行」模式。
- **不可逆命令直接拒绝**：`format`、`diskpart`、`bcdedit`、`reg delete`、`rm -rf /`、
  `git push --force`、`git clean -xdf` 等不弹确认框，直接拒绝执行。
- **高危操作永远要确认**：删除、写工作区之外的文件、访问网络、调用外部 MCP 工具，
  即使开了自动模式或点过「之后全允许」，也每次单独确认（可勾选「始终允许高危操作」）。
- **只读模式**：`readonly` 审批档拒绝一切有副作用的操作，适合只想让助手读代码的场景。
- **风险判定不是安全机制**：正则黑名单必然可以被绕过（引号拼接、`$IFS`、编码、`python -c`），
  它的作用是让常见误操作停下来问一句，不要把它当成防护墙。

## 开发

要求 Node 22+、Windows。

```bash
npm install
npm run dev      # vite + electron，热更新
npm run build    # 编译主进程 + 打包渲染进程
npm test         # 编译主进程后跑纯函数单测（Node 内置 runner，无额外依赖）
npm run typecheck
npm start        # 构建后启动
npm run dist     # 打 portable exe
```

目录：

```
src/main/       Electron 主进程：agent、llama 管理、工具、存储
src/renderer/   React 界面
src/shared/     两侧共用的类型与协议常量
tools/vramfit/  显存体检（独立 CLI，可单独发布）
skills/         内置 skills
```

## HTTP 控制面

llama-server 只提供 OpenAI 兼容的数据面（`/v1`），它答不了「模型加载完没有」「崩溃为什么崩」。
主进程因此内置一个小控制面，默认 `127.0.0.1:7788`，只绑本机，每次启动生成随机 token，
写入 `%APPDATA%/RoRoToCode/daemon.json`（也打印在控制台）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 免鉴权，只报活着 |
| GET | `/status?provider=<id>` | 四态、`code`、已耗时、崩溃现场、可用 OpenAI 入口 |
| GET | `/events` | SSE，状态变化即推 |
| POST | `/start` | `{ model?, ctx?, providerId?, device?, port? }` |
| POST | `/stop` | `{ providerId? }` |

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7788/status
```

`/status` 的 `llama` 段示例：

```json
{
  "state": "error",
  "code": "CRASHED",
  "elapsedMs": 41230,
  "crash": { "code": -1073741819, "tail": "ggml_cuda_host_malloc: failed" },
  "message": "llama-server 已退出（退出码 -1073741819）"
}
```

> 故意不提供「预计剩余 N 秒」。首次加载受模型大小、量化、磁盘缓存、mmap、显存带宽影响，
> 实测方差可达 3 倍，猜出来的倒计时再超时比不报更伤信任。这里给的是阶段 `phase` 与已耗时 `elapsedMs`。

### 无窗口模式

```bash
RoRoToCode.exe --headless --port=7788
```

只跳过创建窗口，其余照常，可交给 nssm / 计划任务托管。

已知限制：主进程持有单实例锁，所以 `--headless` 不能与 GUI 同时运行。

## 给别的工具用

模型跑起来后，`/v1` 是标准 OpenAI 兼容接口，可以直接填进 Cline / Cursor / Continue：

- Base URL：`http://127.0.0.1:<llama 端口>/v1`
- API Key：`local`（本地服务不校验，填非空即可）
- Model：`/status` 里 `openai[].model`，或设置页「外部接入」直接复制

Claude Code 走 Anthropic 协议，不能直连 llama-server；本程序的控制面也不代理 Anthropic 格式。

## 状态

已完成：进程存活回验、崩溃日志与限次自愈、四态状态机、HTTP 控制面、headless、
agent 余量估算（扣掉系统提示与工具定义后还能跑几轮）、长时间无输出提前中止、
本机请求闸门（按服务端槽位排队，满了立刻拒绝，绝不无声挂住）、离线读取 Ollama 模型目录。

待做：

- 真正多槽并行：代码已支持（`llamaParallel` + `-kvu`），但默认留给 llama.cpp 按显存
  自动决定；需要实测「开 2 槽后 30K 上下文的 prompt 会不会互相挤掉」
- 发布渠道（winget / 便携版一行安装）

## 许可

MIT
