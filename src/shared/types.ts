import type { RunPriority } from './runqueue'
import type { ResultFile } from './resultfiles'
import type { SkillDepReport } from './skilldeps'

export type ProviderKind = 'openai' | 'anthropic' | 'ollama'

/**
 * 多槽并发实测的结论。
 *
 * 这几个值不是「成功/失败」的粗糙二分，而是四种需要不同动作的处境：
 * - parallel：真的能并行，单请求也能用满上下文 —— 保持现状
 * - slot-split：槽开了，但上下文被切成 1/N —— 启动参数少了 -kvu
 * - serialized：槽数报得好看，实际是排队跑 —— 把槽位调回 1，别白占显存
 * - unsupported：不是 llama.cpp，探不到也测不了
 */
export type SlotsVerdict = 'parallel' | 'slot-split' | 'serialized' | 'unsupported' | 'error'

export interface SlotsProbeResult {
  verdict: SlotsVerdict
  /** 服务端报告的槽位数；0 表示探测不到 */
  slots: number
  /** 实际用来测的上下文长度（会压到 16K，避免在 CPU 上跑几分钟） */
  testCtx: number
  /** 单个长请求的耗时；null 表示失败 */
  singleMs: number | null
  /** 两个并发请求各自的耗时；null 表示没测 */
  concurrentMs: [number, number] | null
  /** 服务端自己报的 prompt token 数，比我们估的准 */
  promptTokens: number | null
  message: string
  /** 失败时的原始错误 */
  detail?: string
}

export interface ProviderConfig {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey?: string
  model: string
  contextWindow: number
  temperature?: number
  /**
   * 核采样阈值（top_p）。留空用服务端默认（多数是 1.0 = 不截断）。
   * 本地小模型复读、绕圈时压到 0.8~0.9 通常比调温度更有效。
   */
  topP?: number
  /**
   * 重复惩罚（repeat_penalty）。留空用服务端默认（llama.cpp 是 1.0 = 不惩罚）。
   * 1.05~1.15 能压住重复，超过 1.3 会开始破坏正常用词。
   */
  repeatPenalty?: number
  /**
   * 只要合法 JSON（response_format = json_object）。
   *
   * 只对**不带工具**的请求生效：带 tools 时强制 JSON 会把工具调用挤成普通文本，
   * 反而更糟。留空/true 之外的值一律按关闭处理。
   */
  jsonMode?: boolean
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
  /**
   * 上一次启动实测到的显存占用（只对 runtime='llama' 有意义）。
   *
   * 体检是按元数据估的，同一个 9B 模型在不同架构上能差 10%；实测一次之后，
   * 下次启动就能直接算出「最大装得下哪一档」，不用再试错重启。
   * model 存文件名：换了模型这份实测就作废。
   */
  ctxProbe?: {
    model: string
    /** 实测时用的上下文长度 */
    ctx: number
    /** 模型真实占用（MiB），不含桌面等其它进程 */
    footMiB: number
    /**
     * 实测解码速度（tok/s）。验证据点跑的那一次 max_tokens=8 的真实请求。
     *
     * 存在的意义是给界面一个「跑起来到底多快」的锚：体检那栏的 23~33 tok/s 是
     * 带宽公式算的理论上限，同一台机器实测只有 13。没有这个字段，用户没法判断
     * 推荐值是不是乐观了。
     */
    tokPerSec?: number
    /** 实测时间（ms），只用于界面展示 */
    at?: number
  }
  /**
   * 实测证明跑得住的最大档位（tokens）。
   *
   * 和 `ctxProbe` 的分工：probe 记「多大上下文占多少显存」，ceiling 记「试到哪一档为止」。
   * 升档失败时把 ceiling 定在当前档，下次启动就不会再拿一次 10 秒的重载去撞同一堵墙。
   */
  ctxCeiling?: number
  /**
   * 探测结论的「环境指纹」（显卡 / 显存预算 / 模型体积与 mtime / KV 精度 /
   * 槽位数 / FA / EXTRA 参数 / 全局上下限开关）。
   *
   * 和 ctxProbe 配套使用：指纹一致才认为这份实测结论还有效。
   * 换卡、换模型量化、改槽位数之后指纹就变，下次启动会重新探测 ——
   * 用户的判断是对的（每台机器都不一样），但同一台机器上没必要每次重试。
   */
  ctxFingerprint?: string
}

export type ApprovalMode = 'ask' | 'auto' | 'readonly' | 'plan'

/**
 * 计划模式下产出的方案。
 * 存在会话里而不是内存里：程序重启后「批准执行」按钮还得在。
 */
export interface SessionPlan {
  text: string
  steps: string[]
  at: number
  approved: boolean
  approvedAt?: number
}

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
  /**
   * 每写完一个文件就做一次增量类型检查，把编译错误当场回灌给模型。
   * 和 autoVerify 分工：这个是「边改边查」，那个是「一轮结束跑全量」。
   */
  diagnoseOnWrite: boolean
  /**
   * 写完文件后按项目自带的格式化器自动对齐（prettier / gofmt / ruff|black / rustfmt）。
   * 项目里没装对应工具就静默跳过，不会联网安装。
   */
  formatOnWrite?: boolean
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
  /** 单次运行 token 上限；0 / 不填 = 不限。撞上了先问一句，不硬断 */
  tokenLimitPerRun?: number
  /** 每日累计 token 上限；0 / 不填 = 不限。跨天自动清零 */
  tokenLimitPerDay?: number
  /**
   * 允许执行工作区里的 `.roroto/hooks.json`。
   *
   * 默认关：这个文件随仓库走，克隆别人的仓库再打开，就等于让仓库作者在本机执行命令。
   * 打开后它们会和 ~/.roroto/hooks.json 一样在 sessionStart / preToolUse 等节点运行。
   */
  trustWorkspaceHooks?: boolean
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
  /**
   * 本地服务空闲多少分钟后自动卸载（释放显存）。0 = 不卸载，默认 10。
   *
   * 桌面程序没有「请求结束」这个概念：对话停了，llama-server 仍然占着几个 G，
   * 用户开个游戏或剪个视频就得手动来关。空闲卸载把「常驻」变成「按需」，
   * 下一次发消息时由 wakeLlama() 用原参数重新拉起（约几秒到十几秒）。
   */
  llamaIdleMin?: number
  /**
   * 模型装不下时，允许把一部分层留在 CPU 上跑（部分 offload）。
   *
   * @deprecated 用 `llamaPartialOffloadMode`。保留只为读老配置：
   * 老版本写成 `true`（当时含义就是「装不下才降级」），升级时会被翻译成 `auto`。
   */
  llamaPartialOffload?: boolean
  /**
   * 分层加载的三态模式，默认 `auto`。
   *
   * - `auto`：**按模型自动** —— 这个模型装不下（体检判定，或文件比显存预算还大）
   *   才分层；装得下的普通模型完全不动，`-ngl all` 全放显存，速度不受影响。
   * - `on`：总是允许。用于体检估偏乐观（说装得下、实际 OOM）的少数模型。
   * - `off`：禁用。装不下就直接报错，由用户自己换更小的模型。
   */
  llamaPartialOffloadMode?: 'auto' | 'on' | 'off'
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

/**
 * 点右上角 × 时做什么。
 * - tray：收进托盘，进程与正在跑的任务继续（默认，后台还能干活）
 * - minimize：最小化到任务栏，一眼看得见还活着
 * - quit：真的退出
 */
export type CloseAction = 'tray' | 'minimize' | 'quit'

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
  /** 关闭按钮行为 */
  closeAction: CloseAction
  /** 「已收进托盘」的气泡提示只弹一次，弹过就记下来 */
  trayHinted: boolean
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

/**
 * 工具参数是怎么被修出来的。
 * none = 模型写的就是合法 JSON；其余每一种都意味着「模型写坏了，我们救了一次」。
 */
export type ArgRepair = 'none' | 'unwrapped' | 'syntax' | 'salvaged' | 'failed'

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /**
   * 参数不是合法 JSON 时的修复方式。存进历史，重开会话也能知道这一条被救过。
   * 只在「修过 / 没救回来」时写，合法调用不带这个字段，不占空间。
   */
  argRepair?: ArgRepair
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

/** 一个用过的工作区（最近打开列表里的一行） */
export interface WorkspaceEntry {
  path: string
  name: string
  lastOpened: number
  pinned?: boolean
}

export interface SessionMeta {
  id: string
  title: string
  workspace: string | null
  createdAt: number
  updatedAt: number
  /** 本会话绑定的供应商（providerId）。不填 = 跟随全局 activeId */
  modelId?: string | null
  /**
   * 本会话额外指定的具体模型名。绑了它就用这个，
   * 否则用供应商配置里的默认 model —— 同一个本地服务换模型不用改全局配置。
   */
  modelOverride?: string | null
  /** 本会话属于哪个 Agent 档案。不填 = 普通会话，用默认人格与全套工具 */
  agentId?: string | null
  /**
   * 本会话的模式覆盖：'plan' 只读出方案，'build' 正常执行。
   * 不填 = 跟随全局 approvalMode。批准计划后会把这里改成 'build'。
   */
  modeOverride?: 'plan' | 'build' | null
  /** 计划模式下产出的方案（含是否已批准） */
  plan?: SessionPlan | null
  /** 从哪个会话分叉出来的（只做溯源与展示分支树） */
  forkedFrom?: string
}

export interface Session extends SessionMeta {
  messages: ChatMessage[]
  /** 本会话累计用量（只统计主 agent 的成功轮次） */
  usage?: TokenUsage
  /** 从哪个会话分叉出来的。只做溯源，不影响执行 —— 分叉出来的会话是彻底独立的 */
  forkedFrom?: string
}

/**
 * 某一刻正在跑的会话。
 *
 * 只用于观测，不参与调度决策：判断「要不要抢」用的是 hasRunning()（一个布尔），
 * 这里回答的是另一个问题 —— 现在到底是谁在干活、从几点开始干的。
 * 定时任务跑起来之后，会话标题会被改成「任务名 · 时间」，所以看标题就知道是谁。
 */
export interface RunningRun {
  sessionId: string
  agentId: string | null
  title: string
  /** chat = 用户提问；regen = 重新生成；edit = 改问重跑；resume = 断点续跑；handoff = 别的档案交过来的活；routine = 定时任务 */
  kind: 'chat' | 'regen' | 'edit' | 'resume' | 'handoff' | 'routine'
  /**
   * running = 真的在发请求；queued = 抢不到全局并发槽位，正在排队。
   * 两者都占着会话锁（不能往里发第二条消息），区别只在有没有在烧算力。
   */
  state: 'running' | 'queued'
  /** 排队位置，1 表示下一个轮到它；在跑时为 0 */
  position: number
  startedAt: number
}

/**
 * 「以后都这样」的长期放行：某个工作区里的某个工具不再弹确认框。
 * 只有非高危操作会出现在这里 —— 删除、越界写盘、外部 MCP 永远每次都要问。
 */
export interface ApprovalGrant {
  tool: string
  workspace: string
  at: number
}

/**
 * 常驻 Agent 档案。
 *
 * 和子 agent（task 工具）的区别：子 agent 是一次性的、跑完就蒸发；
 * 档案是持久的 —— 有名字、有岗位、有自己那份记忆和工具边界，
 * 同一个档案被反复唤醒时，积累的经验才留得下来。
 */
export interface AgentProfile {
  id: string
  /** 展示名，如「巡检」 */
  name: string
  /** 岗位描述，原样注入系统提示。写清楚「你负责什么、什么算做完」 */
  role: string
  /** 工具白名单。空数组或省略 = 不限制（除 task / update_todos 这类编排工具） */
  tools?: string[]
  /** 是否使用独立记忆命名空间（默认 true）：档案之间互不串味 */
  ownMemory?: boolean
  /** 默认模型（providerId）。不填 = 跟随全局 */
  modelId?: string | null
  /** 默认工作区。不填 = 跟随全局 */
  workspace?: string | null
  /** 内置档案：可以改，但不建议删 */
  builtin?: boolean
  /** 档案从哪来：内置 / 用户目录或项目里的 .md 文件 / 界面里手建 */
  source?: 'builtin' | 'file' | 'stored'
  /** source=file 时的源文件，删档案要删这个文件 */
  filePath?: string
  createdAt: number
  updatedAt: number
}

/** 触发方式：cron 是「每天 9 点」这类日历表达式，interval 是「每 N 分钟」 */
export type RoutineTrigger =
  | { kind: 'cron'; expr: string }
  | { kind: 'interval'; minutes: number }

export type RoutineStatus = 'ok' | 'fail' | 'running' | 'skipped'

/**
 * 定时任务：到点唤醒某个 Agent 档案，把 prompt 发过去。
 *
 * 刻意不叫「自动化流程」：它没有分支、没有节点图，就是一句交代 + 一个时间，
 * 这样才能在本地小模型上也跑得动。
 */
export interface Routine {
  id: string
  name: string
  /** 唤醒哪个档案；空 = 普通会话 */
  agentId: string
  /** 每次唤醒时发给 agent 的话。要写成自包含的，它看不到上一次的对话 */
  prompt: string
  trigger: RoutineTrigger
  enabled: boolean
  /** 非交互审批策略：deny 只读安全，allow 允许普通写操作（高危永远拒绝） */
  approvalPolicy?: 'deny' | 'allow'
  createdAt: number
  updatedAt: number
  /** 下一次该跑的时间戳；由调度器维护 */
  nextRunAt?: number
  lastRunAt?: number
  lastSessionId?: string
  lastStatus?: RoutineStatus
  lastError?: string
  /**
   * 自动调度连续失败的次数：成功一次清零。
   * 用来决定「2 分钟后重试」还是「连续失败太多次，先停用别再烧电」。
   * 手动点「运行」不计入：那是人在调试，不该把任务搞停用。
   */
  consecutiveFails?: number
}

export type HandoffStatus = 'pending' | 'running' | 'ok' | 'fail' | 'canceled'

/**
 * 交接回执：接手方干完之后留下的交代。
 *
 * 为什么要它：交接链可以一路往下传（巡检 → 主控 → 审查），没有回执的话
 * 发起方不知道活干完没有、你也不知道该找谁。这里只放「一行能读懂」的东西，
 * 详细过程在承载它的那条会话里，点进去看。
 */
export interface HandoffResult {
  status: 'ok' | 'fail'
  /** 接手方最后一句结论，截断到 200 字 */
  summary: string
  /** 这一手用掉的 token（只算接手会话的主 agent），不是整条链路 */
  tokens: { prompt: number; completion: number }
  /** 这一手改过的文件（相对工作区），最多 20 个 */
  files?: string[]
  at: number
}

/**
 * 一次交接：某个档案把一件独立的活交给另一个档案。
 *
 * 和定时任务的区别是「谁触发」：routines 是时间触发，handoff 是 agent 自己判断该交给谁。
 * 落地形态一样 —— 建一个普通会话再发一条消息，所以结果同样能看、能改、能删。
 */
export interface Handoff {
  id: string
  createdAt: number
  /** 交出方。普通会话里交出去时 fromAgentId 为空 */
  fromAgentId: string | null
  fromName?: string | null
  fromSessionId: string | null
  toAgentId: string
  toName?: string | null
  /** 要对方做什么，自包含的一句话 */
  task: string
  /** 交出方查到的关键情况：文件、行号、复现步骤 */
  context?: string
  /** 相关文件（相对工作区），让接手方自己读，而不是把全文塞进上下文 */
  files?: string[]
  /** 链路上第几手；超过上限就不再往后传 */
  depth: number
  /** 继承来的审批策略：只能继承，不能升级 */
  approvalPolicy: 'deny' | 'allow'
  workspace: string | null
  /** 真正承载它的会话 */
  sessionId?: string | null
  status: HandoffStatus
  startedAt?: number
  finishedAt?: number
  error?: string
  /** 接手方的交代：结论、token、改了哪些文件。跑完之前没有 */
  result?: HandoffResult
}

/**
 * 共享黑板：同一个工作区里所有档案共用的一页便签。
 *
 * 和长期记忆的分工：记忆记「这个项目一直是这样的」（跑测试用哪条命令、目录怎么分），
 * 黑板记「这摊活现在到哪了」（谁在改哪块、还剩什么、刚踩到的坑）。
 */
export interface BoardInfo {
  path: string
  text: string
  items: number
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
  /** 本次 prefill 实际处理的 token 数（llama.cpp timings.prompt_n）；命中前缀缓存时远小于 prompt */
  promptN?: number
  /** 本次 prefill 耗时（毫秒，llama.cpp timings.prompt_ms） */
  promptMs?: number
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
  /**
   * 用量超限的确认（不是工具调用）。有值就说明这是「还继续吗」，
   * 弹窗要换成配额文案，不能显示成「模型请求执行 quota」。
   */
  quota?: {
    scope: 'run' | 'day'
    used: number
    limit: number
  }
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

/** 交互式终端（主进程维护常驻 shell，渲染层轮询 read 取增量） */
export type TerminalShell = 'cmd' | 'powershell' | 'bash'

export interface TerminalInfo {
  id: string
  shell: TerminalShell
  cwd: string
  status: 'running' | 'exited'
  exitCode: number | null
  /** 累计输出字符数，作为增量读的游标 */
  seq: number
  startedAt: number
}

export interface TerminalRead {
  text: string
  seq: number
  status: 'running' | 'exited'
  exitCode: number | null
  /** 有内容被 200KB 上限挤掉 */
  truncated: boolean
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
  | 'GPU_UNAVAILABLE'
  | 'CRASHED'
  | 'START_TIMEOUT'
  | 'SPAWN_FAILED'
  | 'UNKNOWN'

/** 一次状态查询的完整结果：IPC、未来的 HTTP 控制面都读同一份 */
/** 自动上下文探测的阶段 */
export type LlamaProbePhase = 'verify' | 'down' | 'up' | 'rollback' | 'done' | 'fail'

/** 自动上下文探测的进度事件（界面显示「正在校准 2/4：64K」） */
export interface LlamaProbeProgress {
  providerId?: string
  phase: LlamaProbePhase
  /** 本次正在处理的档位（tokens） */
  ctx: number
  /** 已经发生的重启次数 */
  attempt: number
  /** 重启预算 */
  budget: number
  message: string
}

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
  /**
   * 服务被「空闲卸载」停掉了（不是崩溃、也不是用户点的停止）。
   *
   * 有了这条，界面能说「已空闲卸载，下次发消息自动加载」而不是一句
   * 「服务未运行」—— 后者会让用户以为程序崩了，跑去手动点启动。
   */
  idle?: { model: string; at: number; idleMin: number }
  /**
   * 运行中实例此刻的真实显存占用（实时可视化用）。
   *
   * 采样有节流：同一实例 3 秒内的 status 查询直接复用上次结果，不会每轮
   * 都 spawn 一次 nvidia-smi。纯 CPU 实例或拿不到 nvidia-smi 时为 undefined。
   */
  vram?: { usedMiB: number; totalMiB: number; at: number }
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

/**
 * 本地服务里**已经加载**的模型（Ollama 的 `/api/ps`），以及它实际落在哪张卡上。
 *
 * 存在的意义：llama.cpp 的实例是本程序自己拉起来的，device 自己就知道；
 * Ollama 是常驻服务，界面上要显示「当前用哪张显卡」只能问它一次。
 */
export interface RunningLocalModel {
  kind: LocalRuntimeKind
  /** 服务端的模型名，如 qwen2.5-coder:7b */
  model: string
  /** 总占用（显存 + 内存） */
  sizeBytes: number
  /** 其中在显存里的部分；0 = 纯 CPU 推理（或还没分配显存） */
  vramBytes: number
  /** 用到的显卡名（多卡时有多个）；纯 CPU 时为空 */
  devices: string[]
  /** devices 是按本机显卡推断的（Ollama 日志读不到时的兜底），不是服务自己报的 */
  guessed: boolean
}

/**
 * 常驻服务（Ollama / LM Studio）此刻的显卡使用情况。
 *
 * 为什么不是单纯的「已加载模型列表」：模型没加载时服务照样在跑，
 * 一但发消息它就会用默认显卡加载 —— 顶栏要能像 llama.cpp 那样先报出这张卡，
 * 只是 tooltip 里要说明「还没加载，这是会自动用的那张」。
 */
export interface LocalGpuSnapshot {
  /** 服务是否可达：不可达时 devices / models 一定为空，界面不该猜任何卡 */
  running: boolean
  /** 服务认到的显卡名（Ollama 日志里的设备清单；读不到时按本机显卡兜底） */
  devices: string[]
  /** 显卡名是不是按本机推断的（日志读不到时的兜底） */
  guessed: boolean
  /** 已经加载进显存 / 内存的模型 */
  models: RunningLocalModel[]
  /**
   * 两个常驻服务里**此刻加载着**的模型清单（含 LM Studio）。
   *
   * 和 models 的区别：models 只覆盖 Ollama（它才报显存），这张表只用来回答
   * 「这条配置启动了没有」—— 界面上的绿点 / 黄点就按它判，不能看探活结果，
   * 探活通过只说明端点通、模型存在，没加载的模型一点也不占显存。
   */
  loaded: Array<{ kind: LocalRuntimeKind; model: string }>
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
    /** 已用显存读不到（A 卡 / 核显驱动不提供）：预算按总显存×保守系数算的 */
    usedUnknown?: boolean
    kind?: string
    unified?: boolean
    backend?: string | null
  } | null
  cpuOnly: boolean
  budget: { limitBytes: number; basis: string }
  /**
   * 看图口径：只有传了投影器（--mmproj）才有。
   * 主报告（`tiers` / `recommendedCtx`）按纯文本算，这里给「发图片时」会发生什么。
   */
  vision?: {
    /** 投影器文件本身的体积 */
    projectorBytes: number
    /** CLIP 编码器的激活与计算缓冲 */
    activationBytes: number
    totalBytes: number
    /** 挂上投影器后还能开的最大档；null = 一档都不行 */
    recommendedCtx: number | null
    fits: boolean
  } | null
  /** 每一档上下文的估算占用与是否装得下 */
  tiers: Array<{
    ctx: number
    needBytes: number | null
    fits: boolean | null
    /** need > limit × 0.85：装得下但贴着上限，估算稍偏就会 OOM */
    tight?: boolean
    /** 超过模型训练窗口，靠 RoPE 外推，长任务会退化 */
    beyondNative?: boolean
  }>
  /** 装得下且不超过原生上下文的最大档位；null 表示一档都不行 */
  recommendedCtx: number | null
  /** false = 元数据不全算不出来（不是装不下） */
  estimated: boolean
  /** 零上下文、batch=1、全权重驻留显存时的理论解码峰值，不计 KV cache 读取；不是实测 */
  genTokPerSec: number | null
  /** 同口径，但按系统内存带宽算（offload 到内存 / 纯 CPU 推理） */
  genTokPerSecOnCpu: number | null
  /** 按建议上下文补上 KV cache 读取代价后的折减估算，仍非实测 */
  genTokPerSecAtCtx?: number | null
  /** 折减估算所用的上下文长度 */
  speedCtx?: number | null
  /** 速度口径标识：zero-context-decode-peak */
  speedBasis?: string
  /** MoE 专家数；估算未计入激活比例，实测通常更快 */
  moe?: { experts: number; active: number | null } | null
  verdict: 'agent-ready' | 'runs-only' | 'not-recommended' | 'unknown'
  /** 装下典型 agent 负载后还剩几轮；算不出来时不出现 */
  agent?: AgentHeadroom
}

export type VramfitResult = { ok: true; report: VramfitReport } | { ok: false; message: string }

/** 可下载模型的一个源（镜像） */
export interface ModelSource {
  label: string
  url: string
  /** 同一份文件的镜像填相同值，才允许它们并发分段下载同一个文件 */
  family?: string
}

/**
 * 模型模态。text / vision 能由 llama.cpp 直接加载（vision 还要配套 mmproj）；
 * audio / image 这类只做归档下载，需要 whisper.cpp / ComfyUI 等专用运行时。
 */
export type CatalogModality = 'text' | 'vision' | 'audio' | 'image' | 'other'

/** 流式目录：主进程每解析出一个模型就推一条，界面「刷出一个显示一个」 */
export interface CatalogStreamItem {
  /** 一次检索的编号，界面用它丢掉上一次检索迟到的条目 */
  runId: string
  model: CatalogModel
  dir: string
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
  /** remote = 实时检索到；builtin = 断网时的兜底清单 */
  origin?: 'remote' | 'builtin'
  /** 目录来自哪个站点（HF 镜像 / HF 官方 / 魔搭…），展示用 */
  sourceSite?: string
  /** 模态标注：音频 / 图像等会被标出来，并说明本地运行时不兼容 */
  modality?: CatalogModality
  /** 体积还在探测中：条目已经能显示，sizeBytes 暂时是 0 */
  probing?: boolean
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
 * llama.cpp 更新检查结果。
 *
 * 版本号取自 `llama-server --version` 自报的 build 数（如 `build 12211`），
 * 对比 GitHub 最新 release 的 tag（b12211）。取不到任何一边时不算「有更新」，
 * 只带 note 说明原因——宁可不提示，也不能误报。
 */
export interface LlamaUpdateInfo {
  /** 本机装了 llama-server.exe（没装时谈不上更新，安装按钮本来就是「一键安装」） */
  installed: boolean
  /** 已装版本的自报 build 数；识别不出为 undefined */
  installedBuild?: number
  /** GitHub 最新 release 的 build 数；取不到为 undefined */
  latestBuild?: number
  updateAvailable: boolean
  /** 取不到版本 / 无法识别时的说明，界面可选择性显示 */
  note?: string
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

/** 技能：一段可复用的指令模板，点「调用」填进输入框；打开开关后可被模型自动调用 */
export interface Skill {
  id: string
  name: string
  desc: string
  prompt: string
  /**
   * 自动调用开关。开着时这个技能的名称与说明会进系统提示，
   * 模型在合适的任务里可以用 use_skill 取到完整正文。默认关。
   */
  enabled?: boolean
  /** 内置技能不可删除 / 不可改 */
  builtin?: boolean
  /** 来自 GitHub 技能源时的仓库，如 anthropics/skills */
  source?: string
  /** 技能源里的文件路径，如 skills/pdf/SKILL.md */
  sourcePath?: string
  /** 网页地址，方便回去看原文 */
  url?: string
  /** 本机技能（从 ~/.workbuddy/skills 扫到的 SKILL.md）所在目录，调用时按这个目录找脚本 */
  localPath?: string
  createdAt: number
}

/**
 * 自定义斜杠命令：一个 .md 文件就是一条命令。
 * 项目里的 .roroto/commands/ 会覆盖用户目录的同名命令。
 */
export interface SlashCommand {
  /** 不含斜杠，如 fix-ci */
  name: string
  desc: string
  /** 参数提示，如 [run-id] */
  hint?: string
  /** 命令正文（已含占位符 $ARGUMENTS / $1） */
  body: string
  source: 'builtin' | 'user' | 'project'
  path?: string
  /** frontmatter 里建议的档案 / 模型 / 工具（界面参考用） */
  agent?: string
  model?: string
  tools?: string[]
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
   * 正在传的是哪一份：weights = 主权重，mmproj = 视觉投影器，verify = 下完在算哈希。
   * 投影器是第二段下载，字节数会重新从 0 开始，界面按这个字段换文案。
   */
  phase?: 'weights' | 'mmproj' | 'verify'
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
  /**
   * 本地模型在纯文本 / 视觉模式之间切换（发图时自动挂投影器，闲置后自动卸掉）。
   * 重启服务要十来秒，界面必须说清楚在干什么，否则看着像卡死。
   */
  | { type: 'vision_switch'; state: 'loading' | 'ready' | 'failed'; message: string }
  | { type: 'compacting' }
  | { type: 'hint'; message: string }
  | { type: 'failover'; from: string; to: string; reason: string }
  | { type: 'todos'; items: TodoItem[] }
  /** 计划模式下模型写好了方案：界面弹出批准按钮 */
  | { type: 'plan'; plan: SessionPlan }
  | { type: 'file_change'; change: FileChange }
  /** 命令 / 技能在工具参数之外生成的成果文件，送进「成果」面板 */
  | { type: 'artifacts'; items: ResultFile[] }
  | { type: 'context'; used: number; window: number; messages: number; compacted: boolean }
  | { type: 'verify_start'; command: string; label: string }
  | { type: 'verify_result'; command: string; label: string; ok: boolean; output: string; durationMs: number }
  /** 写文件后的增量编译检查报了错。没错时不发事件（静默通过） */
  | { type: 'diagnostics'; errors: number; files: number }
  | { type: 'subagent_start'; task: SubAgentTask }
  | { type: 'subagent_update'; task: SubAgentTask }
  | { type: 'subagent_end'; task: SubAgentTask }
  | { type: 'assistant_start'; messageId: string }
  | { type: 'delta'; messageId: string; text: string }
  | { type: 'assistant_end'; messageId: string; content: string; toolCalls: ToolCall[] }
  | { type: 'tool_start'; callId: string; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; callId: string; tool: string; result: string; ok: boolean; durationMs: number }
  | { type: 'approval'; request: ApprovalRequest }
  /** 弹窗被撤回（用户点了停止 / 审批超时）：界面要把对应的那张卡收掉 */
  | { type: 'approval_dismiss'; id: string }
  | { type: 'question'; request: QuestionRequest }
  | { type: 'question_dismiss'; id: string }
  /**
   * genMs：推理引擎上报的「纯生成耗时」（Ollama eval_duration / llama.cpp
   * timings.predicted_ms），不含排队、预填充与落盘。没有就不给，界面退回墙钟估算。
   */
  | { type: 'usage'; usage: TokenUsage; last?: TokenUsage; genMs?: number }
  /** 用户在这一轮跑到一半时插了新话：工具已停，接下来按新话重新规划 */
  | { type: 'steer'; text: string }
  | { type: 'step_limit'; maxSteps: number }
  | { type: 'auto_continue'; round: number; reason: string }
  /** 全局并发闸门：position=0 表示终于轮到它了，>0 表示前面还有几个在跑 */
  | { type: 'queue'; position: number; active: number; limit: number; priority?: RunPriority }
  | { type: 'error'; message: string }
  /**
   * 这一轮结束。note 是收工结论（改了几个文件 / 一个字没改 / 已中止），
   * 界面据此给出明确提示——否则正常收工和静默中断看起来完全一样。
   */
  | { type: 'done'; note?: string; ok?: boolean }

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
    /** 用过的工作区：按「置顶 + 最近打开」排序 */
    list(): Promise<WorkspaceEntry[]>
    /** 登记并置顶到最近（切换工作区时调用） */
    remember(dir: string): Promise<WorkspaceEntry[]>
    forget(dir: string): Promise<WorkspaceEntry[]>
    /** 目录是否还存在：路径被删/移走时切换前先提示 */
    exists(dir: string): Promise<boolean>
  }
  sessions: {
    list(): Promise<SessionMeta[]>
    /** agentId 给了就建一个属于该档案的会话，提示词和工具白名单随之生效 */
    create(workspace?: string | null, agentId?: string | null): Promise<Session>
    load(id: string): Promise<Session>
    remove(id: string): Promise<void>
    /** 删掉会话内某一轮对话（连同它的工具输出），用来给上下文减负 */
    deleteTurn(id: string, messageId: string): Promise<DeleteTurnResult>
    rename(id: string, title: string): Promise<void>
    setWorkspace(id: string, workspace: string | null): Promise<void>
    /** 给会话绑定模型（providerId），传 null 跟随全局 */
    setModel(id: string, modelId: string | null): Promise<void>
    /** 给会话指定具体模型名（同一供应商内切换），传 null 回到供应商默认 */
    setModelOverride(id: string, model: string | null): Promise<void>
    /** 切换会话模式：plan 只出方案，build 正常执行，null 跟随全局 */
    setMode(id: string, mode: 'plan' | 'build' | null): Promise<void>
    /** 批准当前计划：会话切到 build 并返回更新后的会话 */
    approvePlan(id: string): Promise<Session>
    /**
     * 从某条消息处复制出一份新会话，原会话保留不动。
     * 不传 messageId 表示复制整段历史（相当于「另存一份」）。
     */
    fork(id: string, messageId?: string | null): Promise<Session>
    /** 按标题和正文搜索会话 */
    search(query: string): Promise<SessionHit[]>
    /** 导出为 Markdown（弹出保存对话框） */
    export(id: string): Promise<{ ok: boolean; message?: string; path?: string }>
    /** 回收站：删除的会话默认保留 7 天 */
    trash(): Promise<TrashEntry[]>
    restore(file: string): Promise<string>
    purgeTrash(file: string): Promise<void>
    /** 清空整个回收站（用户点「全部删除」），返回实际删掉的条数 */
    purgeAllTrash(): Promise<number>
  }
  chat: {
    /** files 为本次消息的附件，主进程会先抽出正文再交给模型 */
    send(sessionId: string, text: string, files?: SendAttachment[]): Promise<void>
    abort(sessionId: string): Promise<void>
    /** 这个会话此刻是否在跑：切会话回来时用它恢复状态 */
    isRunning(sessionId: string): Promise<boolean>
    /**
     * 运行中插话：不新建一轮、不排队，直接打断当前这一步（工具执行立即停），
     * 把这句话插进对话重新规划。会话没在跑时返回 false，调用方应改走 send。
     */
    steer(sessionId: string, text: string): Promise<boolean>
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
    /** 只保留选中的块（hunk），其余改动当作没发生 */
    applyHunks(sessionId: string, id: string, keep: number[]): Promise<{ ok: boolean; message: string }>
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
  /** 常驻交互式终端：渲染层可以分次写入、轮询读增量 */
  terminal: {
    open(workspace: string, shell?: TerminalShell): Promise<TerminalInfo>
    write(id: string, data: string): Promise<TerminalInfo>
    read(id: string, since?: number, opts?: { tail?: number; waitMs?: number }): Promise<TerminalRead>
    close(id: string): Promise<TerminalInfo | null>
    list(): Promise<TerminalInfo[]>
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
    /**
     * always = 这一轮不再问；persist = 「以后都这样」，按「工作区 + 工具」落盘。
     * 高危操作不接受 persist：主进程会忽略它，只保留本轮有效。
     */
    respond(id: string, approved: boolean, always?: boolean, persist?: boolean): void
  }
  /** 「以后都这样」的授权记录，设置页用来展示与撤销 */
  approvals: {
    list(): Promise<ApprovalGrant[]>
    revoke(workspace: string, tool: string): Promise<boolean>
    clear(): Promise<number>
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
    probe(
      providerId: string
    ): Promise<{
      ok: boolean
      models: string[]
      error?: string
      loading?: boolean
      /** 模型此刻是否真的加载着（local 服务才给；可用但没启动时为 false） */
      running?: boolean
      /** 本地服务装了但没起来：能用，只是没启动 —— 界面报黄灯而不是红叉 */
      idle?: boolean
    }>
    /** 用当前表单里的供应商配置（而非已保存配置）拉取模型列表 */
    listDraft(provider: ProviderConfig): Promise<{ ok: boolean; models: string[]; error?: string }>
    /** 用当前表单里的供应商配置探测可用性 */
    probeDraft(provider: ProviderConfig): Promise<{ ok: boolean; models: string[]; error?: string }>
    /** 可下载的本地模型目录：多站点实时检索，失败时退回内置清单 */
    catalog(opts?: { query?: string; refresh?: boolean; runId?: string; localOnly?: boolean }): Promise<{
      ok: boolean
      models: CatalogModel[]
      dir: string
      freeBytes: number
      origin?: 'remote' | 'builtin'
      message?: string
    }>
    /**
     * 订阅「解析出一个模型就推一条」的目录条目。
     * 检索期间界面不用等全部探测完，按 runId 追加 / 覆盖即可渐进显示。
     */
    onCatalogItem(cb: (item: CatalogStreamItem) => void): () => void
    /** 下载指定模型到 models/，过程中通过 onProgress 推送进度 */
    download(id: string): Promise<{ ok: boolean; message: string; file?: string }>
    /** 取消下载 */
    cancel(id: string): void
    /** 删除已下载的模型文件（坏了要重下、或腾磁盘空间） */
    remove(id: string): Promise<{ ok: boolean; message: string }>
    /** 订阅下载进度，返回取消订阅函数 */
    onProgress(cb: (p: DownloadProgress) => void): () => void
  }
  /**
   * 下载快照：下载都在主进程跑，界面只是观众。
   * 面板重新挂载（切走再切回）时先取一次，把进度条接回来。
   */
  downloads: {
    snapshot(): Promise<{
      models: DownloadProgress[]
      llama: SetupProgress | null
      local: SetupProgress | null
      core: { running: boolean; progress: CoreProgress | null }
    }>
  }
  shell: {
    showItemInFolder(path: string): void
    /** 用系统默认程序打开文件，路径不存在时返回错误信息 */
    openPath(path: string): Promise<{ ok: boolean; message?: string }>
  }
  /** 自定义斜杠命令：.roroto/commands/*.md */
  commands: {
    list(workspace: string | null): Promise<SlashCommand[]>
    /** 把「/name 参数」展开成真正发给模型的话；不是命令返回 ok:false */
    expand(
      text: string,
      workspace: string | null
    ): Promise<{ ok: boolean; prompt: string; command?: string; message?: string }>
  }
  /** 钩子：查看当前工作区挂了哪些（设置页/自检用） */
  hooks: {
    describe(workspace: string | null): Promise<{
      files: string[]
      rules: Array<{
        event: string
        matcher?: string
        command: string
        timeoutMs: number
        name?: string
      }>
    }>
    reload(): Promise<{ ok: boolean }>
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
    /** 开关某个技能的自动调用：开着时模型能自己用 use_skill 取到它 */
    toggle(id: string, enabled: boolean): Promise<{ ok: boolean; message: string; skills: Skill[] }>
    /**
     * /learn：把一条会话的操作轨迹蒸馏成技能（一次模型调用）。
     * 失败返回可读原因而不是抛错 —— 它是从输入框触发的，用户要看到的是「为什么没成」。
     */
    distill(sessionId: string): Promise<{ ok: boolean; message: string; skill?: Skill }>
    /** 预置的在线技能源 */
    sources(): Promise<SkillSource[]>
    /** 扫描一个 GitHub 仓库（或预置源）里的 SKILL.md */
    scan(input: { repo?: string; sourceId?: string }): Promise<SkillScanResult>
    /** 安装扫描结果里的技能，重复安装等于覆盖更新 */
    install(items: RemoteSkill[]): Promise<{ ok: boolean; message: string; skills: Skill[] }>
    /** 只读探测离线技能需要的 Python 包是否齐备，不安装、不联网 */
    checkDeps(): Promise<SkillDepReport>
  }
  /** 对话窗里添加文件：选文件 / 拖进来 */
  files: {
    /** 打开系统文件选择框，选完即复制到工作区 */
    pick(): Promise<{ items: FileAttachment[]; errors: string[] }>
    /** 拖拽进来的路径，同样复制到工作区 */
    attach(paths: string[]): Promise<{ items: FileAttachment[]; errors: string[] }>
    /** 生成缩略图 data URL，只用于界面预览 */
    thumb(absPath: string): Promise<string | null>
    /** 正文里引用的图片（相对工作区的路径 / 绝对路径）→ data URL，用于对话框内直接显示 */
    image(src: string): Promise<{ ok: boolean; url?: string; error?: string }>
    /** 拖拽事件里拿到磁盘路径（浏览器出于安全只给 File 对象） */
    pathOf(file: File): string
    /** 工作区文件清单，供输入框 @ 引用 */
    list(query?: string): Promise<WorkspaceFile[]>
    /** 截当前屏幕，按普通图片附件返回（走同一条附件通道） */
    captureScreen(): Promise<{ items: FileAttachment[]; errors: string[] }>
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
      sizes?: Record<string, number>
    }>
    /**
     * 删除本地模型文件。只接受本程序模型目录内的 .gguf；
     * 运行中的模型、目录外的路径一律拒绝，配套投影器会一起删掉。
     */
    deleteModel(rel: string): Promise<{ ok: boolean; message: string; freedBytes?: number }>
    /**
     * 一键启动 llama-server：立即返回并写好模型配置，服务在后台加载。ctx 为空时按配置上限。
     * providerId 指定属于哪个供应商（不同供应商各自一个实例，可同时驻留）；
     * device 覆盖该供应商的显卡绑定（CUDA0 / CUDA1 / CPU…）。
     * activate=true 表示「启动并使用」：顺手把这条设为当前模型；
     * 后台兜底 / 工人模型拉起的实例不要传，否则会把用户正在聊的模型换掉。
     */
    start(
      model?: string,
      ctx?: number,
      /**
       * ctxExplicit=true 表示用户手点了某一档上下文：锁定该档，
       * 禁止就绪后按实测显存自动升/降档（否则「点 8K」会变成「跑 64K」）。
       */
      opts?: { providerId?: string; device?: string | null; port?: number; activate?: boolean; ctxExplicit?: boolean }
    ): Promise<{ ok: boolean; message: string; model?: string; loading?: boolean; port?: number; device?: string }>
    /** 查询本地服务状态：四态 + 机器可读 code + 崩溃现场 */
    status(providerId?: string): Promise<LlamaStatus>
    /** 停止 llama-server 释放显存：传 providerId 只停那个实例，不传全停 */
    stop(providerId?: string): Promise<{ ok: boolean; message: string; stopped?: string[] }>
    /** 当前在跑的本地实例（双卡双模型时会有多个） */
    instances(): Promise<
      Array<{
        key: string
        port: number
        model: string
        device: string
        pid: number | null
        ctx: number
        /** 部分层在 CPU（装不下时的降级）：界面要提示速度会明显更慢 */
        partial: boolean
      }>
    >
    /** 可绑定设备清单（值就是 -dev 认的设备名：CUDA0 / Vulkan1 …） */
    devices(): Promise<Array<{ id: string; name: string; vramMiB?: number; freeMiB?: number }>>
    /**
     * 实测多槽并发：先发一个 0.8 窗口的长请求，再并发两个 0.4 窗口的，
     * 据此判断 -kvu 有没有生效、并发是真并行还是排队。
     * 只对 llama.cpp 有意义，其他服务返回 unsupported。
     */
    probeSlots(providerId?: string): Promise<SlotsProbeResult>
    /** 检查已安装的 llama.cpp 是 CPU 还是 GPU 后端（installed=false 表示压根没装） */
    backend(): Promise<{
      backend: 'cuda' | 'vulkan' | 'hip' | 'cpu'
      gpuReady: boolean
      installed: boolean
      /** 后端在、显卡用不上时的原因（缺运行库等），界面直接显示 */
      note?: string
      /** 缺的运行时文件 */
      missing?: string[]
    }>
    /** 检查 llama.cpp 有没有新版本（有则安装按钮变「可更新」） */
    checkUpdate(): Promise<LlamaUpdateInfo>
    /**
     * 自动上下文探测的进度。
     *
     * 首次启动 / 换模型 / 换硬件时会真的起停几次来确认「这台机器到底能开多大」，
     * 期间界面要能显示「正在校准 2/4：64K」，否则几十秒没有任何反馈，看起来像卡死。
     * 返回取消订阅函数。
     */
    onProbe(cb: (p: LlamaProbeProgress) => void): () => void
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
      model?: string,
      opts?: { activate?: boolean }
    ): Promise<{ ok: boolean; message: string; model?: string; providerId?: string; created?: boolean }>
    /** ollama pull：后台拉取模型 */
    pull(name: string): Promise<{ ok: boolean; message: string }>
    /** 切换模型后卸载其他本地运行时已加载的模型，返回释放说明 */
    release(providerId: string | null): Promise<{ ok: boolean; freed: string[] }>
    /**
     * 切换模型后，主进程在后台把别的运行时卸载掉时发来的通知。
     *
     * 为什么要有：切走那一刻模型可能还在加载，`/api/ps` 看不到它，
     * 几秒后复查才发现并卸载 —— 这条消息让界面能说清「刚才释放了什么」。
     */
    onFreed(cb: (freed: string[]) => void): () => void
    /**
     * 本地服务此刻用着哪张显卡：已加载的模型 + 各自的显存占用（Ollama 读 `/api/ps` + 服务日志）。
     * 模型没加载时 models 为空，但 running / devices 仍会告诉界面「发消息会用哪张卡」。
     */
    gpu(): Promise<LocalGpuSnapshot>
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
  /** 常驻档案与定时任务 */
  agents: {
    list(): Promise<AgentProfile[]>
    /** 可选工具清单（勾白名单用） */
    tools(): Promise<Array<{ name: string; desc: string }>>
    save(agent: Partial<AgentProfile>): Promise<AgentProfile>
    remove(id: string): Promise<{ removed: boolean; reason?: string }>
    /** 正在跑的会话（侧栏用它给 agent 图标点灯） */
    running(): Promise<RunningRun[]>
  }
  routines: {
    list(): Promise<Routine[]>
    save(routine: Partial<Routine>): Promise<Routine>
    remove(id: string): Promise<{ ok: boolean }>
    enable(id: string, enabled: boolean): Promise<Routine | null>
    run(id: string): Promise<{ ok: boolean; sessionId?: string; error?: string }>
  }
  /** 交接：agent 之间转交的活，以及它们落地成的那条会话 */
  handoffs: {
    list(): Promise<Handoff[]>
    cancel(id: string): Promise<{ ok: boolean }>
    run(id: string): Promise<{ ok: boolean; sessionId?: string; error?: string }>
  }
  /** 共享黑板：当前工作区那一页，读给界面看 / 清空 */
  board: {
    get(): Promise<BoardInfo>
    clear(): Promise<{ ok: boolean }>
  }
  /** 用量闸门：今天累计用了多少 token（设置页显示，方便对照上限调） */
  quota: {
    today(): Promise<{ used: number }>
  }
  /**
   * 主进程推过来的「该刷新了」通知。
   * 定时任务和交接都在后台自己跑，界面不订阅就永远停在打开那一刻的状态。
   */
  onChange(channel: 'routines' | 'handoffs', cb: () => void): () => void
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
