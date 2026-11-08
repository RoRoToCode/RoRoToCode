export type ProviderKind = 'openai' | 'anthropic' | 'ollama'

export interface ProviderConfig {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey?: string
  model: string
  contextWindow: number
  temperature?: number
  noTools?: boolean
  /** 看图能力：auto 按模型名判断，on/off 手动指定 */
  vision?: 'auto' | 'on' | 'off'
  /**
   * 多模态投影器（mmproj）文件，只对 llama.cpp 本地服务生效。
   * 可写绝对路径或 models/ 下的文件名；留空则启动时按文件名自动配对。
   */
  mmproj?: string
  /**
   * llama.cpp 本地服务本次是否真的加载了多模态投影器。
   * 由 startLlama() 写入并持久化，auto 判定优先读它，比按模型名猜可靠。
   */
  llamaVision?: boolean
  /** 备用供应商：当前模型额度用完 / 连不上时自动切到它 */
  fallback?: boolean
  /**
   * 本地运行时类型。留空时按 id / 端口推断（老配置兼容）。
   * 写成 'llama' 表示这一条由本程序拉起 llama-server —— 此时端口和显卡都能单独指定，
   * 一台双卡机器可以同时挂两个本地模型。
   */
  runtime?: 'llama' | LocalRuntimeKind
  /**
   * llama.cpp 实例端口（仅 runtime='llama' 有意义）。
   * 留空 = 自动：启动时真实探测端口是否可监听，从 8080 起找第一个空闲的并写进 baseUrl。
   * 填了值 = 用户手动锁定该端口，被占用时直接报错，不自动改。
   */
  port?: number
  /**
   * 绑定到哪张显卡（仅 runtime='llama' 有意义）。
   * 取值来自 `llama-server --list-devices`：CUDA0 / CUDA1 / Vulkan0 …；填 CPU 表示只用处理器。
   * 留空交给 llama.cpp 自己分配（单卡机器上的老行为）。
   */
  device?: string
  /**
   * 角色。worker 表示「给子代理干活用」：主对话走一个模型，子代理派到另一个，
   * 两张卡各跑一个才真正并行。留空按主模型处理。
   */
  role?: 'main' | 'worker'
}

export type ApprovalMode = 'ask' | 'auto' | 'readonly'

export interface AppConfig {
  providers: ProviderConfig[]
  activeId: string | null
  workspace: string | null
  approvalMode: ApprovalMode
  maxSteps: number
  /**
   * 是否给上下文设上限。
   * 关（默认）＝不限制：按模型真实窗口跑，装不下时靠自动压缩兜底；
   * 开＝用下面的 contextWindow 压小，省显存 / 省 token 花销。
   */
  contextLimit: boolean
  /** 上限值（tokens）：只在 contextLimit 打开时生效 */
  contextWindow: number
  /** 接近上限时自动把早期对话压成摘要 */
  autoCompact: boolean
  /** 改完代码后自动跑测试 / 构建，失败则让模型继续修 */
  autoVerify: boolean
  /** 允许助手联网：web_search 搜索、web_fetch 读网页 */
  webSearch: boolean
  /** 跨对话的项目长期记忆：remember 工具 + 每次对话注入 */
  memory: boolean
  /** HTTP 代理，形如 http://127.0.0.1:7890；留空表示直连 */
  proxyUrl: string
  /** 接入 MCP 外部工具服务（userData/mcp.json） */
  mcpEnabled: boolean
  /** 当前模型 429 / 断网 / 5xx 时，自动按顺序切到标记为「备用」的供应商 */
  autoFallback?: boolean
  /**
   * 任务没做完就自动接着跑：模型一轮结束时如果计划里还有未完成的项，
   * 或者它自己说「接下来 / 下一步」却没调工具，就不再等用户手点「继续」，自己再推一轮。
   */
  autoContinue?: boolean
  /**
   * 只在内存里有效、不落盘：这些 provider 的 apiKey 是密文但本机解不开
   * （换过机器或换过系统账户），设置页要提示用户重新填写。
   */
  undecryptable?: string[]
  /**
   * llama-server 的并发槽位数。不填（默认）= 交给 llama.cpp 自己按可用显存决定。
   *
   * 为什么要显式给：多槽能让「短请求不必排在长任务后面」，但每槽都会占用上下文预算。
   * 显式指定时程序会同时加 `-kvu`（共享 KV 池），否则 `-c` 会被按槽切分，
   * 每槽只剩 1/N，长 prompt 会直接超出槽窗口报错。
   */
  llamaParallel?: number
}

/** 免费 / 低价模型目录里的一条 */
export interface FreeModel {
  /** 直接填进 provider.model 的值 */
  id: string
  name: string
  context: number
  /** 是否支持原生函数调用（不支持的话 agent 只能聊天） */
  tools: boolean
  /** 附加说明，例如「即将下线」「需开通」 */
  note?: string
}

/** 一个免费模型来源（固定推荐位 + OpenRouter 目录） */
export interface FreeSource {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  /** 申请 API Key 的页面 */
  keyUrl: string
  /** 说明文案 */
  hint: string
  /** 有目录接口的来源会带上模型清单 */
  models: FreeModel[]
  /** 目录拉取失败时的提示 */
  error?: string
}

export interface FreeCatalog {
  sources: FreeSource[]
  /** 目录缓存时间（毫秒时间戳） */
  fetchedAt: number
  /** 整体错误（例如断网） */
  error?: string
}

/** 执行计划里的一步 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
}

/** 界面配色：黑 / 白（浅色）/ 灰 / 大条纹 / 高对比 */
export type ThemeKey = 'dark' | 'light' | 'gray' | 'stripe' | 'contrast'

/** 软件级偏好（存在 userData/prefs.json，和模型配置分开） */
export interface AppPrefs {
  /** 界面缩放：1 = 100%，整页等比放大（Electron zoomFactor） */
  zoom: number
  /** 界面配色 */
  theme: ThemeKey
  /** 界面字体大小：1 = 100%，只改文字、不动间距与布局 */
  fontScale: number
  /** 对话正文字号；null = 跟随界面字体 */
  chatFontScale: number | null
}

/** 软件信息，用于「软件设置 → 关于」 */
export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  /** 用户数据目录（配置、会话都在这里） */
  dataDir: string
  sessionsDir: string
  sessionCount: number
  zoom: number
  packaged: boolean
}

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface ChatMessage {
  id: string
  role: Role
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  /** 用户这条消息里附带的图片（绝对路径），只有视觉模型才会真正发出去 */
  images?: string[]
  createdAt: number
}

export interface SessionMeta {
  id: string
  title: string
  workspace: string | null
  createdAt: number
  updatedAt: number
  /** 本会话绑定的模型（providerId）。不填 = 跟随全局 activeId */
  modelId?: string | null
}

export interface Session extends SessionMeta {
  messages: ChatMessage[]
  /** 本会话累计用量（只统计主 agent 的成功轮次） */
  usage?: TokenUsage
}

/** 崩溃/中断的会话及其结构化进度，供恢复入口展示 */
export interface InterruptedCheckpoint {
  sessionId: string
  workspace: string | null
  /** 未完成的计划项（completed 已剔除） */
  todos: TodoItem[]
  /** 上次已改动的文件（相对工作区路径） */
  touched: string[]
  updatedAt: number
}

/** 删除会话内一轮对话的结果 */
export interface DeleteTurnResult {
  /** 删除后的完整会话，界面直接用它替换本地状态 */
  session: Session
  /** 实际删掉的消息条数（含工具输出，所以通常大于 1） */
  removed: number
  /** 被删消息估算出来的 token 数：后续每轮请求大约能少这么多输入 */
  savedTokens: number
}

/** token 用量：prompt = 输入，completion = 输出 */
export interface TokenUsage {
  prompt: number
  completion: number
  /** 命中缓存的输入 token（有的供应商不给） */
  cached?: number
  /** 估算花费（美元）；模型不在价格表里时为 undefined，不猜 */
  costUsd?: number
}

export type RiskKind = 'network' | 'delete' | 'outside' | 'write' | 'shell'

/**
 * 用户可写的一条权限规则（项目级 roroto.json 里的 permissions 数组）。
 * 按顺序匹配，最后一条命中的生效；只用于「加严」或「明确放行普通操作」，
 * 永远无法绕过 HARD_BLOCK 硬拒与高危强制确认。
 */
export interface PermissionRule {
  /** 工具名，'*' 表示所有工具 */
  action: string
  /** 匹配资源：命令字符串 / 文件路径（相对工作区），支持 * 通配 */
  resource: string
  /** allow = 明确放行（仍受硬拒约束）；deny = 明确拒绝 */
  effect: 'allow' | 'deny'
}

/** 一条带来源标注的权限规则（多层合并后，供 UI 展示它来自哪个 roroto.json） */
export interface PermRuleWithSource extends PermissionRule {
  /** 规则来源文件的绝对路径 */
  from: string
}

export interface ApprovalRequest {
  id: string
  tool: string
  args: Record<string, unknown>
  summary: string
  risk?: RiskKind
  reason?: string
  /** 高危（删除/越界/网络/外部 MCP）：不受「之后全允许」影响，弹窗要醒目标注 */
  high?: boolean
  /** 写文件类操作先算好改动，弹窗里直接给用户看 */
  preview?: {
    path: string
    kind: 'create' | 'modify' | 'delete'
    added: number
    removed: number
    lines: DiffLine[]
    /** patch 等多文件操作时，逐文件展示，此时上面的字段只代表第一个文件 */
    files?: Array<{
      path: string
      kind: 'create' | 'modify' | 'delete'
      added: number
      removed: number
      lines: DiffLine[]
    }>
  }
}

/** question 工具：模型暂停下来向用户提问（可带选项），等待作答后继续 */
export interface QuestionRequest {
  id: string
  question: string
  options?: string[]
  /** 多选：用户可选多个选项，答案以逗号分隔回传 */
  multiSelect?: boolean
}

/** 一处文件改动（每次 write_file / edit_file 记一条，可单独撤销） */
export interface FileChange {
  id: string
  sessionId: string
  /** 展示用路径（相对工作区） */
  path: string
  absPath: string
  kind: 'create' | 'modify' | 'delete'
  at: number
  tool: string
  added: number
  removed: number
  /** 改动后文件大小，字节 */
  size: number
  /** 原文太大没存下来时为 false，不能撤销 */
  revertable?: boolean
}

/** diff 的一行；kind=ctx 为未改动的上下文 */
export interface DiffLine {
  kind: 'ctx' | 'add' | 'del'
  text: string
  before?: number
  after?: number
}

export interface ChangeDetail {
  change: FileChange
  lines: DiffLine[]
  /** 文件太大时只记录统计，不能撤销 */
  revertable: boolean
  reverted?: boolean
}

/** 会话搜索结果（标题或正文命中） */
export interface SessionHit extends SessionMeta {
  snippet: string
  /** 命中条数 */
  hits: number
}

/** 回收站里的一条已删除会话 */
export interface TrashEntry {
  /** 回收站内的文件名（恢复 / 永久删除时按它定位） */
  file: string
  id: string
  title: string
  workspace: string | null
  deletedAt: number
  /** 消息条数，恢复前心里有数 */
  messages: number
}

/** @ 引用列表里的工作区文件 */
export interface WorkspaceFile {
  path: string
  name: string
  dir: string
}

/** git status 的一行 */
export interface GitFile {
  path: string
  /** 两位状态码，如 M / ?? / A */
  status: string
  staged: boolean
  untracked: boolean
}

export interface GitStatus {
  ok: boolean
  branch?: string
  files: GitFile[]
  message?: string
}

export interface McpToolInfo {
  name: string
  description?: string
}

export interface McpServerStatus {
  name: string
  command: string
  ok: boolean
  tools: McpToolInfo[]
  error?: string
}

/** 本机显卡信息 */
/** 本地模型服务的四态。agent 要的是确定答案，「加载中…」三个字给不出答案 */
export type LlamaState = 'idle' | 'loading' | 'ready' | 'error'

/**
 * 机器可读的失败原因。
 *
 * 不给 code 只能给人看中文 message，外部调用（脚本、Claude Code / Cline 这类 agent）
 * 没法据此决定是重试、换模型还是提示用户。START_TIMEOUT 与 CRASHED 要分开：
 * 前者多半是模型太大显存不够，后者多半是二进制或文件损坏，处置完全不同。
 */
export type LlamaErrorCode =
  | 'NONE'
  | 'MODEL_MISSING'
  | 'BINARY_MISSING'
  | 'PORT_BUSY'
  | 'VRAM_SHORT'
  | 'CRASHED'
  | 'START_TIMEOUT'
  | 'SPAWN_FAILED'
  | 'UNKNOWN'

/** 一次状态查询的完整结果：IPC、未来的 HTTP 控制面都读同一份 */
export interface LlamaStatus {
  ok: boolean
  state: LlamaState
  /** 兼容老字段，等价于 state === 'ready' */
  running: boolean
  /** 兼容老字段，等价于 state === 'loading' */
  loading?: boolean
  code: LlamaErrorCode
  /** 加载走到哪一步：spawn（已拉起进程）/ load（进程在加载模型）/ ready */
  phase?: string
  /**
   * 从拉起进程到现在过了多久（ms）。
   * 故意不报「预计剩余 N 秒」：首次加载受模型大小、量化、磁盘缓存、mmap、显存带宽影响，
   * 实测方差能到 3 倍，报一个猜出来的倒计时再超时，比不报更伤信任。
   */
  elapsedMs?: number
  models?: string[]
  port?: number
  device?: string
  /** 最近一次异常退出的现场：退出码 + 日志尾部，排查不用再靠猜 */
  crash?: { code: number | null; signal: string | null; at: number; tail: string; logFile: string }
  /**
   * 请求队列：本机服务的槽位有限，超出的请求会排队。
   * 有了这个，界面和外部 agent 都能知道「是在算，还是在等」。
   */
  queue?: { active: number; queued: number; limit: number }
  message: string
}

/** 本机常驻推理服务：Ollama 与 LM Studio（llama.cpp 走单独的 llama 通道） */
export type LocalRuntimeKind = 'ollama' | 'lmstudio'

export interface LocalRuntimeStatus {
  kind: LocalRuntimeKind
  /** 「Ollama」「LM Studio」 */
  label: string
  /** 对应配置里的供应商 id */
  providerId: string
  /** 形如 http://127.0.0.1:11434/v1 */
  baseUrl: string
  /** 本机是否装了它的 CLI */
  installed: boolean
  cliPath?: string
  /** 服务端口是否可访问 */
  running: boolean
  /** 实际监听的端口：LM Studio 的 1234 被占用时会自动换端口 */
  port?: number
  /** 本机已安装的模型 id 列表 */
  models: string[]
  message: string
}

/** 本程序模型目录里的一个 GGUF，可用于导入到 Ollama / LM Studio */
export interface LocalGgufFile {
  /** 绝对路径 */
  path: string
  /** 文件名 */
  name: string
  sizeBytes: number
  /** 相对程序目录的路径，展示用 */
  rel: string
  /**
   * 这个文件是哪来的。`ollama` 表示是从本机 Ollama 的模型目录里读出来的
   * （blob 没有 .gguf 后缀，扫盘扫不到，只能解析清单定位）。
   * 它们同样是 GGUF，可以直接导入或体检，不必重新下载。
   */
  source?: 'local' | 'ollama'
}

export interface GpuInfo {
  name: string
  /** 显存字节数；0 表示没读到（如集显或驱动未提供） */
  vramBytes: number
  driver?: string
  source?: 'nvidia-smi' | 'wmi'
}

/** 本机硬件参数（用于推荐可运行的本地模型规模） */export interface SystemSpecs {
  ok: boolean
  message?: string
  cpu: { model: string; physicalCores: number; logicalCores: number; speedGHz: number }
  memory: { totalBytes: number; freeBytes: number }
  gpus: GpuInfo[]
  os: { platform: string; release: string; arch: string }
  disk: { path: string; freeBytes: number; totalBytes: number } | null
}

/**
 * vramfit 体检报告（只取界面要用的字段，字段名与 vramfit --json 保持一致）。
 * 它是 vramfit 的稳定契约：verdict 是固定标识，不跟界面语言走。
 */
/**
 * agent 余量：vramfit 独有的判断，别人只报 ctxMax。
 *
 * 「能开 64K」和「装进系统提示 + 工具定义之后还能跑几轮」是两件事：
 * 后者才是 coding agent 会不会三轮就 compaction 的直接原因。
 */
export interface AgentHeadroom {
  /** 算这一份余量所基于的上下文 */
  ctx: number
  /** 固定开销假设：系统提示 + 工具定义 + 技能索引 */
  systemTokens: number
  /** 每轮假设：用户消息 + 工具结果 + 模型回复 */
  perRoundTokens: number
  /** 扣掉固定开销后还能装下几轮；0 表示连系统提示都放不下 */
  rounds: number
}

export interface VramfitReport {
  file: string
  name: string
  arch: string
  sizeBytes: number
  /** 分片模型按片数折算后的整体体积 */
  weightsBytes: number
  quant: string | null
  params: number | null
  layers: number | null
  nativeContext: number | null
  chatTemplate: { present: boolean; bytes?: number }
  /** 模板能驱动工具调用的程度：strong / partial / weak / none */
  tools: string
  gpu: {
    name: string
    totalBytes: number
    usedBytes: number
    kind?: string
    unified?: boolean
    backend?: string | null
  } | null
  cpuOnly: boolean
  budget: { limitBytes: number; basis: string }
  /** 每一档上下文的估算占用与是否装得下 */
  tiers: Array<{ ctx: number; needBytes: number | null; fits: boolean | null }>
  /** 装得下且不超过原生上下文的最大档位；null 表示一档都不行 */
  recommendedCtx: number | null
  /** false = 元数据不全算不出来（不是装不下） */
  estimated: boolean
  genTokPerSec: number | null
  genTokPerSecOnCpu: number | null
  verdict: 'agent-ready' | 'runs-only' | 'not-recommended' | 'unknown'
  /** 装下典型 agent 负载后还剩几轮；算不出来时不出现 */
  agent?: AgentHeadroom
}

export type VramfitResult = { ok: true; report: VramfitReport } | { ok: false; message: string }

/** 可下载模型的一个源（镜像） */
export interface ModelSource {
  label: string
  url: string
}

/** 可下载模型条目 */
export interface CatalogModel {
  id: string
  name: string
  family: string
  paramsB: number
  /** 参数量由文件体积反推（模型名里没写），UI 用 ≈ 提示 */
  paramsEstimated?: boolean
  quant: string
  sizeBytes: number
  /** 落地到 models/ 下的文件名 */
  file: string
  note: string
  sources: ModelSource[]
  /**
   * 同仓库里配套的视觉投影器（mmproj）文件名。
   * 有值表示下载主权重时会一并下载，落盘成 `<主模型名>-mmproj.gguf`。
   */
  mmproj?: string
  /** 来源仓库（如 unsloth/Qwen3.8-27B-GGUF），内置条目为空 */
  repo?: string
  /** 镜像侧的下载量，用于展示热度 */
  downloads?: number
  /** remote = 从 hf-mirror 实时检索到；builtin = 断网时的兜底清单 */
  origin?: 'remote' | 'builtin'
  /** 本地是否已存在同名主权重文件 */
  installed: boolean
  /**
   * 配套投影器是否也已在本地。只在 mmproj 有值时出现：
   * false 表示主权重下过、投影器缺（老版本下载的），重新点下载只会补这一份。
   */
  mmprojInstalled?: boolean
  downloading?: boolean
}

export type DownloadState = 'running' | 'done' | 'error' | 'cancelled'

/** 能一键安装 / 下载的本地运行时：llama.cpp 自己管进程，Ollama / LM Studio 是常驻服务 */
export type SetupKind = 'llama' | LocalRuntimeKind

export type SetupState = 'preparing' | 'downloading' | 'extracting' | 'done' | 'error'

/** 本地运行时安装包 / 压缩包的下载进度 */
export interface SetupProgress {
  kind: SetupKind
  receivedBytes: number
  totalBytes: number
  state: SetupState
  /** 实时速度（字节/秒），用于界面显示「3.4 MB/s」 */
  bytesPerSec?: number
  /** 正在使用的下载源，如「gh-proxy 镜像」 */
  source?: string
  /** 正在下载的文件名 */
  file?: string
  message?: string
}

/**
 * 简易核心的六个阶段：建目录 → 下模型 → 装 llama.cpp → 写配置 → 加载 → 自检。
 * 顺序就是依赖顺序，界面按这个顺序显示勾选状态。
 */
export type CorePhase = 'dir' | 'model' | 'mmproj' | 'llama' | 'config' | 'start' | 'check'

/** 简易核心的进度：只有下载类的阶段会带字节数 */
export interface CoreProgress {
  phase: CorePhase
  receivedBytes?: number
  totalBytes?: number
  bytesPerSec?: number
  message?: string
}

/** 一步的结果：ok 做成了、skip 这轮不需要做、error 卡住了（后面的步骤不再继续） */
export interface CoreStep {
  id: CorePhase
  label: string
  state: 'ok' | 'skip' | 'error'
  message: string
}

export interface CoreSetupResult {
  ok: boolean
  message: string
  /** core/ 的绝对路径 */
  dir: string
  /** 这次加载的模型文件（地址还没填时为 undefined） */
  modelFile?: string
  providerId?: string
  steps: CoreStep[]
  /** 自检结论：后端、服务状态、体检 */
  checks: {
    backend?: string
    gpuReady?: boolean
    running?: boolean
    port?: number
    fit?: string
  }
}

/** 基础核心库：Node.js / Git / Python */
export type BaseToolId = 'node' | 'git' | 'python'

export interface BaseToolStatus {
  id: BaseToolId
  label: string
  /** 检测用的命令，展示给用户 */
  command: string
  installed: boolean
  version?: string
  optional?: boolean
  page?: string
}

export interface ToolSetupProgress {
  id: BaseToolId
  label: string
  phase: 'download' | 'install' | 'done' | 'error'
  receivedBytes: number
  totalBytes: number
}

/** 技能：一段可复用的指令模板，点一下就填进输入框 */
export interface Skill {
  id: string
  name: string
  desc: string
  prompt: string
  /** 内置技能不可删除 / 不可改 */
  builtin?: boolean
  /** 来自 GitHub 技能源时的仓库，如 anthropics/skills */
  source?: string
  /** 技能源里的文件路径，如 skills/pdf/SKILL.md */
  sourcePath?: string
  /** 网页地址，方便回去看原文 */
  url?: string
  /** 本机技能（从 ~/.workbuddy/skills 扫到的 SKILL.md）所在目录，点「使用」时按这个目录找脚本 */
  localPath?: string
  createdAt: number
}

/** 在线技能源：一个装有 SKILL.md 的 GitHub 仓库 */
export interface SkillSource {
  id: string
  label: string
  /** owner/repo */
  repo: string
  ref: string
  desc: string
  /** 预置源（面板上一键切换） */
  builtin?: boolean
  /** 离线兜底：直接读程序内置清单，不走网络 */
  offline?: boolean
}

/** 从 GitHub 扫到、还没安装的技能 */
export interface RemoteSkill {
  /** 稳定标识：repo@ref:path，用于判重与更新 */
  key: string
  name: string
  desc: string
  prompt: string
  path: string
  repo: string
  url: string
  /** 已安装过（同名同来源） */
  installed: boolean
}

export interface SkillScanResult {
  ok: boolean
  repo: string
  ref: string
  skills: RemoteSkill[]
  /** 这次结果来自离线内置清单 */
  offline: boolean
  message?: string
}

export type FileKind =
  | 'image'
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slide'
  | 'text'
  | 'code'
  | 'archive'
  | 'audio'
  | 'video'
  | 'other'

/** 用户拖进 / 选进对话窗的文件 */
/** 发送时随消息一起交给主进程的附件信息 */
export interface SendAttachment {
  /** 给模型看的路径：工作区内是相对路径 */
  path: string
  absPath: string
  kindLabel: string
  size: number
}

export interface FileAttachment {
  id: string
  name: string
  /** 交给模型的路径：拷进工作区就是相对路径，否则是绝对路径 */
  path: string
  absPath: string
  size: number
  kind: FileKind
  /** 展示用的类型名，如「PDF」「图片」 */
  kindLabel: string
  /** 是否已复制到工作区 inbox/ */
  copied: boolean
}

export interface DownloadProgress {
  id: string
  file: string
  receivedBytes: number
  totalBytes: number
  speedBps: number
  state: DownloadState
  /**
   * 正在传的是哪一份：weights = 主权重，mmproj = 视觉投影器。
   * 投影器是第二段下载，字节数会重新从 0 开始，界面按这个字段换文案。
   */
  phase?: 'weights' | 'mmproj'
  source?: string
  message?: string
}

/** 子 agent 派出去的一个子任务 */
export interface SubAgentTask {
  id: string
  /** 父 agent 里那次 task 工具调用的 id，界面靠它对上卡片 */
  callId: string
  /** 短标题，3-5 个字 */
  description: string
  /** 派给子 agent 的完整说明 */
  prompt: string
  status: 'running' | 'ok' | 'fail'
  /** 子 agent 走了几轮 */
  steps: number
  startedAt: number
  endedAt?: number
  /** 回传给主 agent 的总结（也是工具结果） */
  summary: string
  /** 这个子 agent 实际用的模型（配了「工作模型」时和主模型不同） */
  model?: string
  /** 为什么用/没用工作模型：并行是否生效、回落原因，直接显示给用户 */
  note?: string
  error?: string
  /** 子 agent 做过的工具调用，界面展开可看 */
  tools: Array<{ tool: string; ok: boolean; durationMs: number; note: string }>
}

/** 工人模型与主模型在显存/算力上的隔离方式 */
export type WorkerIsolation =
  /** 工人模型在远端 API，完全不抢本地显存 */
  | 'remote'
  /** 两边各占一块不同的卡 */
  | 'gpu'
  /** 一边 GPU 一边 CPU，慢但不抢显存 */
  | 'cpu'
  /** 分不开：同一块卡，或有一方没绑卡 */
  | 'none'

/** 这次派子代理到底用不用工人模型、能不能真并行 */
export interface WorkerPlan {
  /** 实际该用的供应商；null 表示回落主模型 */
  provider: ProviderConfig | null
  /** 配置里声明的工人模型（不管这次能不能用） */
  configured: ProviderConfig | null
  isolation: WorkerIsolation
  /** 能不能真并行 */
  parallel: boolean
  /** 本地实例是否已经能接请求 */
  ready: boolean
  /** 给人看的一句话结论 */
  reason: string
}

export type AgentEvent =
  | { type: 'attach_reading'; file: string }
  | { type: 'attach_no_vision'; model: string }
  | { type: 'compacting' }
  | { type: 'hint'; message: string }
  | { type: 'failover'; from: string; to: string; reason: string }
  | { type: 'todos'; items: TodoItem[] }
  | { type: 'file_change'; change: FileChange }
  | { type: 'context'; used: number; window: number; messages: number; compacted: boolean }
  | { type: 'verify_start'; command: string; label: string }
  | { type: 'verify_result'; command: string; label: string; ok: boolean; output: string; durationMs: number }
  | { type: 'subagent_start'; task: SubAgentTask }
  | { type: 'subagent_update'; task: SubAgentTask }
  | { type: 'subagent_end'; task: SubAgentTask }
  | { type: 'assistant_start'; messageId: string }
  | { type: 'delta'; messageId: string; text: string }
  | { type: 'assistant_end'; messageId: string; content: string; toolCalls: ToolCall[] }
  | { type: 'tool_start'; callId: string; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; callId: string; tool: string; result: string; ok: boolean; durationMs: number }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'question'; request: QuestionRequest }
  | { type: 'question_dismiss'; id: string }
  | { type: 'usage'; usage: TokenUsage; last?: TokenUsage }
  | { type: 'step_limit'; maxSteps: number }
  | { type: 'auto_continue'; round: number; reason: string }
  | { type: 'error'; message: string }
  | { type: 'done' }

export interface AgentEventEnvelope {
  sessionId: string
  event: AgentEvent
}

export interface PicoAPI {
  config: {
    get(): Promise<AppConfig>
    save(config: AppConfig): Promise<AppConfig>
    defaults(): Promise<ProviderConfig[]>
  }
  workspace: {
    choose(): Promise<string | null>
  }
  sessions: {
    list(): Promise<SessionMeta[]>
    create(workspace?: string | null): Promise<Session>
    load(id: string): Promise<Session>
    remove(id: string): Promise<void>
    /** 删掉会话内某一轮对话（连同它的工具输出），用来给上下文减负 */
    deleteTurn(id: string, messageId: string): Promise<DeleteTurnResult>
    rename(id: string, title: string): Promise<void>
    setWorkspace(id: string, workspace: string | null): Promise<void>
    /** 给会话绑定模型（providerId），传 null 跟随全局 */
    setModel(id: string, modelId: string | null): Promise<void>
    /** 按标题和正文搜索会话 */
    search(query: string): Promise<SessionHit[]>
    /** 导出为 Markdown（弹出保存对话框） */
    export(id: string): Promise<{ ok: boolean; message?: string; path?: string }>
    /** 回收站：删除的会话默认保留 7 天 */
    trash(): Promise<TrashEntry[]>
    restore(file: string): Promise<string>
    purgeTrash(file: string): Promise<void>
  }
  chat: {
    /** files 为本次消息的附件，主进程会先抽出正文再交给模型 */
    send(sessionId: string, text: string, files?: SendAttachment[]): Promise<void>
    abort(sessionId: string): Promise<void>
    /** 丢掉最后一轮回答重跑 */
    regenerate(sessionId: string): Promise<void>
    /** 改掉某条用户消息后从那里重跑 */
    editAndResend(sessionId: string, messageId: string, text: string): Promise<void>
    /** 中断后接着做 */
    resume(sessionId: string): Promise<void>
  }
  /** 文件改动记录：查看 / 撤销 */
  changes: {
    list(sessionId: string): Promise<FileChange[]>
    detail(sessionId: string, id: string): Promise<ChangeDetail | null>
    revert(sessionId: string, id: string): Promise<{ ok: boolean; message: string }>
    revertAll(sessionId: string): Promise<{ ok: boolean; message: string; count: number }>
  }
  /** 工作区 Git：状态 / 单个文件 diff / 提交 */
  git: {
    status(workspace: string | null): Promise<GitStatus>
    diff(workspace: string | null, path: string): Promise<{ ok: boolean; text: string; message?: string }>
    commit(
      workspace: string | null,
      message: string,
      paths?: string[]
    ): Promise<{ ok: boolean; message: string }>
  }
  /** 免费模型目录（OpenRouter 动态拉取 + 固定推荐位） */
  free: {
    list(opts?: { refresh?: boolean }): Promise<FreeCatalog>
  }
  /** MCP 外部工具服务 */
  mcp: {
    status(): Promise<McpServerStatus[]>
    /** 改完 mcp.json 后重新连接 */
    reload(): Promise<McpServerStatus[]>
    /** 打开 mcp.json 所在目录（没有就先生成模板） */
    openConfig(): Promise<{ ok: boolean; path: string; message?: string }>
  }
  approval: {
    respond(id: string, approved: boolean, always?: boolean): void
  }
  question: {
    respond(id: string, answer: string): void
  }
  checkpoints: {
    /** 上次没跑完（崩溃/中断）的会话及其结构化进度 */
    interrupted(): Promise<InterruptedCheckpoint[]>
    /** 用户选择忽略，清除中断标记 */
    dismiss(sessionId: string): Promise<void>
  }
  models: {
    list(providerId: string): Promise<{ ok: boolean; models: string[]; error?: string }>
    probe(providerId: string): Promise<{ ok: boolean; models: string[]; error?: string; loading?: boolean }>
    /** 用当前表单里的供应商配置（而非已保存配置）拉取模型列表 */
    listDraft(provider: ProviderConfig): Promise<{ ok: boolean; models: string[]; error?: string }>
    /** 用当前表单里的供应商配置探测可用性 */
    probeDraft(provider: ProviderConfig): Promise<{ ok: boolean; models: string[]; error?: string }>
    /** 可下载的本地模型目录（实时检索 hf-mirror，失败时退回内置清单） */
    catalog(opts?: { query?: string; refresh?: boolean }): Promise<{
      ok: boolean
      models: CatalogModel[]
      dir: string
      freeBytes: number
      origin?: 'remote' | 'builtin'
      message?: string
    }>
    /** 下载指定模型到 models/，过程中通过 onProgress 推送进度 */
    download(id: string): Promise<{ ok: boolean; message: string; file?: string }>
    /** 取消下载 */
    cancel(id: string): void
    /** 订阅下载进度，返回取消订阅函数 */
    onProgress(cb: (p: DownloadProgress) => void): () => void
  }
  shell: {
    showItemInFolder(path: string): void
    /** 用系统默认程序打开文件，路径不存在时返回错误信息 */
    openPath(path: string): Promise<{ ok: boolean; message?: string }>
  }
  /** 技能库：内置 + 用户自定义 */
  skills: {
    list(): Promise<Skill[]>
    /** 不传 id 为新建，传 id 为修改（内置技能不可改） */
    save(input: { id?: string; name: string; desc?: string; prompt: string }): Promise<{
      ok: boolean
      message: string
      skills: Skill[]
    }>
    remove(id: string): Promise<{ ok: boolean; message: string; skills: Skill[] }>
    /** 预置的在线技能源 */
    sources(): Promise<SkillSource[]>
    /** 扫描一个 GitHub 仓库（或预置源）里的 SKILL.md */
    scan(input: { repo?: string; sourceId?: string }): Promise<SkillScanResult>
    /** 安装扫描结果里的技能，重复安装等于覆盖更新 */
    install(items: RemoteSkill[]): Promise<{ ok: boolean; message: string; skills: Skill[] }>
  }
  /** 对话窗里添加文件：选文件 / 拖进来 */
  files: {
    /** 打开系统文件选择框，选完即复制到工作区 */
    pick(): Promise<{ items: FileAttachment[]; errors: string[] }>
    /** 拖拽进来的路径，同样复制到工作区 */
    attach(paths: string[]): Promise<{ items: FileAttachment[]; errors: string[] }>
    /** 生成缩略图 data URL，只用于界面预览 */
    thumb(absPath: string): Promise<string | null>
    /** 拖拽事件里拿到磁盘路径（浏览器出于安全只给 File 对象） */
    pathOf(file: File): string
    /** 工作区文件清单，供输入框 @ 引用 */
    list(query?: string): Promise<WorkspaceFile[]>
  }
  llama: {
    /** 下载并解压 llama.cpp 到项目根目录下的 llama.cpp/ */
    install(): Promise<{ ok: boolean; message: string; dir?: string; exe?: string }>
    /** 取消正在进行的安装包下载 */
    cancelInstall(): Promise<{ ok: boolean; message: string }>
    /** 安装包下载 / 解压进度 */
    onSetupProgress(cb: (p: SetupProgress) => void): () => void
    /** 自动写入（或新建）llama.cpp 本地供应商配置 */
    configure(): Promise<{ ok: boolean; message: string; model?: string; providerId?: string; created?: boolean }>
    /**
     * 扫描本地 .gguf 模型（若服务已启动则合并服务端模型）。
     * vision 按模型条目给出看图状态：ready = 已配上投影器；missing = 视觉模型但缺投影器；
     * text = 普通文本模型。服务端额外返回的条目没有这个键。
     */
    models(): Promise<{
      ok: boolean
      models: string[]
      dir?: string
      message: string
      vision?: Record<string, 'ready' | 'missing' | 'text'>
    }>
    /**
     * 一键启动 llama-server：立即返回并写好模型配置，服务在后台加载。ctx 为空时按配置上限。
     * providerId 指定属于哪个供应商（不同供应商各自一个实例，可同时驻留）；
     * device 覆盖该供应商的显卡绑定（CUDA0 / CUDA1 / CPU…）。
     */
    start(
      model?: string,
      ctx?: number,
      opts?: { providerId?: string; device?: string | null; port?: number }
    ): Promise<{ ok: boolean; message: string; model?: string; loading?: boolean; port?: number; device?: string }>
    /** 查询本地服务状态：四态 + 机器可读 code + 崩溃现场 */
    status(providerId?: string): Promise<LlamaStatus>
    /** 停止 llama-server 释放显存：传 providerId 只停那个实例，不传全停 */
    stop(providerId?: string): Promise<{ ok: boolean; message: string; stopped?: string[] }>
    /** 当前在跑的本地实例（双卡双模型时会有多个） */
    instances(): Promise<Array<{ key: string; port: number; model: string; device: string; pid: number | null; ctx: number }>>
    /** 可绑定设备清单（值就是 -dev 认的设备名：CUDA0 / Vulkan1 …） */
    devices(): Promise<Array<{ id: string; name: string; vramMiB?: number; freeMiB?: number }>>
    /** 检查已安装的 llama.cpp 是 CPU 还是 GPU 后端（installed=false 表示压根没装） */
    backend(): Promise<{ backend: 'cuda' | 'vulkan' | 'hip' | 'cpu'; gpuReady: boolean; installed: boolean }>
  }
  /** 简易核心：一键把「目录 + 模型 + llama.cpp + 配置 + 加载 + 自检」串起来跑完 */
  core: {
    setup(): Promise<CoreSetupResult>
    /** 取消正在下载的模型 / 安装包 */
    cancel(): Promise<{ ok: boolean; message: string }>
    onProgress(cb: (p: CoreProgress) => void): () => void
  }
  system: {
    /** 读取本机显卡 / CPU / 内存 / 磁盘等硬件参数 */
    specs(): Promise<SystemSpecs>
  }
  /** vramfit 体检：模型文件在不在本机跑得动、能开多大上下文 */
  vramfit: {
    /** vramfit 是否就位（打包时缺失会返回 false，界面据此隐藏入口） */
    available(): Promise<{ ok: boolean; message: string }>
    /** 体检某个 .gguf；gpuIndex 指按第几块卡算（双卡机器上第二个模型用） */
    check(file: string, gpuIndex?: number): Promise<VramfitResult>
  }
  /** 工人模型（子代理专用模型）的可用性判断 */
  worker: {
    /** 当前对话模型配的工人模型能不能真并行；null 表示找不到当前模型 */
    plan(providerId?: string): Promise<WorkerPlan | null>
    /** 后台拉起工人模型的本地实例（不等待加载完成） */
    warm(providerId?: string): Promise<{ ok: boolean; message: string }>
  }
  /** 软件自身的设置（与模型无关）：界面缩放、数据目录等 */
  /** 自绘标题栏：窗口的最小化 / 最大化 / 关闭 */
  win: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    /** 最大化状态变化时回调（图标要跟着换），返回取消订阅函数 */
    onMaximize(cb: (maximized: boolean) => void): () => void
  }
  app: {
    info(): Promise<AppInfo>
    prefs(): Promise<AppPrefs>
    setZoom(factor: number): Promise<AppPrefs>
    /** 批量写偏好（配色等），返回落盘后的完整偏好 */
    setPrefs(patch: Partial<AppPrefs>): Promise<AppPrefs>
    /** 在资源管理器里打开用户数据目录 */
    openDataDir(): Promise<{ ok: boolean; message?: string }>
    /** 打开主进程日志目录（main.log 就在这里） */
    openLogs(): Promise<{ ok: boolean; message?: string }>
    /** 同步界面语言给主进程，让系统对话框也跟着切 */
    setLang(lang: 'zh' | 'en'): Promise<void>
  }
  /** 基础核心库：检测与一键安装 */
  tools: {
    check(): Promise<BaseToolStatus[]>
    install(ids: BaseToolId[]): Promise<{
      ok: boolean
      message: string
      installed?: string[]
      failed?: Array<{ label: string; reason: string }>
      tools?: BaseToolStatus[]
    }>
    onProgress(cb: (p: ToolSetupProgress) => void): () => void
  }
  /** 本机常驻服务（Ollama / LM Studio）：检测、启动、写配置 */
  local: {
    status(kind: LocalRuntimeKind): Promise<LocalRuntimeStatus>
    start(kind: LocalRuntimeKind): Promise<{ ok: boolean; message: string; models?: string[] }>
    configure(
      kind: LocalRuntimeKind,
      model?: string
    ): Promise<{ ok: boolean; message: string; model?: string; providerId?: string; created?: boolean }>
    /** ollama pull：后台拉取模型 */
    pull(name: string): Promise<{ ok: boolean; message: string }>
    /** 切换模型后卸载其他本地运行时已加载的模型，返回释放说明 */
    release(providerId: string | null): Promise<{ ok: boolean; freed: string[] }>
    /** 本程序模型目录里的 .gguf 列表（可导入到 Ollama / LM Studio，不用重新下载） */
    ggufs(): Promise<{ ok: boolean; files: LocalGgufFile[]; message?: string }>
    /** 把本程序已下载的 GGUF 导入到 Ollama / LM Studio */
    importModel(
      kind: LocalRuntimeKind,
      file: string,
      /** 展示名：Ollama 的 blob 文件名是 sha256-xxx，用它命名会得到一串哈希 */
      label?: string
    ): Promise<{ ok: boolean; message: string; model?: string }>
    /** 一键安装 / 下载：能直连安装包的自动下好并启动安装，否则打开官方下载页 */
    install(kind: LocalRuntimeKind): Promise<{ ok: boolean; message: string; path?: string; launched?: boolean }>
    /** 取消正在下载的安装包 */
    cancelInstall(): Promise<boolean>
    /** 安装包下载进度 */
    onSetupProgress(cb: (p: SetupProgress) => void): () => void
  }
  /** 项目长期记忆（每个工作区一份，存在数据目录里） */
  memory: {
    info(): Promise<{ path: string; items: number; chars: number }>
    clear(): Promise<{ ok: boolean }>
  }
  /** 项目规则（AGENTS.md / CLAUDE.md，只读，随仓库提交共享） */
  instructions: {
    info(): Promise<{ path: string | null; text: string; truncated: boolean; name: string | null }>
    init(): Promise<{ created: boolean; path: string }>
  }
  permissions: {
    info(): Promise<{
      workspace: string | null
      path: string | null
      rules: PermissionRule[]
      detailed: PermRuleWithSource[]
      files: string[]
    }>
    save(rules: PermissionRule[]): Promise<{ path: string; created: boolean; count: number }>
  }
  onEvent(cb: (payload: AgentEventEnvelope) => void): () => void
}

declare global {
  interface Window {
    pico: PicoAPI
  }
}
