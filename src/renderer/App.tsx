import { t as tr, useLang, toggleLang } from './i18n'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type {
  AgentEvent,
  AgentEventEnvelope,
  AgentProfile,
  AppConfig,
  ApprovalRequest,
  ChatMessage,
  FileAttachment,
  FileChange,
  InterruptedCheckpoint,
  ProviderConfig,
  QuestionRequest,
  Session,
  SessionMeta,
  SessionPlan,
  Skill,
  SlashCommand,
  SubAgentTask,
  TodoItem,
  TokenUsage,
  WorkspaceFile
} from '../shared/types'
import { isImagePath, providerSupportsVision } from '../shared/vision'
import { todosFromArgs } from '../shared/todos'
import { turnRangeOf } from '../shared/turns'
import { MSG_WINDOW_STEP, windowRows } from '../shared/msgwindow'
import { isLlamaProvider, isLoopbackUrl } from '../shared/providers'
import { Sidebar } from './components/Sidebar'
import { MessageItem, StepGroup } from './components/MessageItem'
import { isComposingKey, isPlainEnter } from './keyboard'
import { RunStatus } from './components/RunStatus'
import { PlanCard } from './components/PlanCard'
import { PlanApproval } from './components/PlanApproval'
import { Settings } from './components/Settings'
import { AppSettings } from './components/AppSettings'
import { ModelPicker, type ProbeInfo } from './components/ModelPicker'
import { SkillsPanel } from './components/SkillsPanel'
import { AgentPanel } from './components/AgentPanel'
import { OutputPanel, collectOutputs, filterOutputs } from './components/OutputPanel'
import type { ResultFile } from '../shared/resultfiles'
import { DiffView } from './components/DiffView'
import { applyFontScale } from './theme'

function sizeText(bytes: number): string {
  if (!bytes) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function shortenPath(full: string, keep = 2): string {
  const parts = full.split(/[\\/]/).filter(Boolean)
  if (parts.length <= keep + 1) return full
  return `…\\${parts.slice(-keep).join('\\')}`
}

/** 只取最后一段目录名：输入框那一行很窄，完整路径留给 title */
function baseName(full: string): string {
  const parts = full.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : full
}

/** token 数好看一点：12.5K / 32K（按 1024 进位，跟模型的窗口口径一致） */
function fmtTokens(n: number): string {
  if (n >= 10240) return `${Math.round(n / 1024)}K`
  if (n >= 1024) return `${(n / 1024).toFixed(1)}K`
  return String(n)
}

/** 花费写法：不到 1 分钱也显示出来（否则小额永远看起来是 0） */
function fmtCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

/**
 * 把连续的执行过程合成一张折叠卡。
 *
 * 模型干活是「说一句 → 调工具 → 再说一句 → 再调工具」的循环，慢任务（下载依赖、跑长构建）
 * 能连着几十条「仍在继续，继续等待」加命令卡，把真正的结论顶到几屏之外。
 * 这里把「助手旁白 + 工具结果」的连续段收成一行，结论（不调工具的助手回答）保持原样可见。
 * task（子 agent）单独成卡，不并进来，它自己会显示进度。
 */
type Row =
  | { key: string; steps: ChatMessage[] | null; one: ChatMessage }

function isStepMessage(m: ChatMessage): boolean {
  if (m.role === 'tool') return m.toolName !== 'task'
  if (m.role === 'assistant') return Boolean(m.toolCalls?.length)
  return false
}

function groupRows(messages: ChatMessage[]): Row[] {
  const rows: Row[] = []
  for (const m of messages) {
    const prev = rows[rows.length - 1]
    if (isStepMessage(m)) {
      if (prev?.steps) prev.steps.push(m)
      else rows.push({ key: m.id, steps: [m], one: m })
      continue
    }
    rows.push({ key: m.id, steps: null, one: m })
  }
  return rows
}

/** 从历史消息里还原最后一次计划：update_todos 的参数里带着完整列表 */
function restoreTodos(messages: ChatMessage[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'tool' && m.toolName === 'update_todos') {
      const items = todosFromArgs(m.toolArgs)
      if (items) return items
    }
  }
  return []
}

const RISK_LABEL: Record<string, string> = {
  get network() { return tr("访问网络") },
  get delete() { return tr("删除文件") },
  get outside() { return tr("工作区之外") },
  get write() { return tr("修改文件") },
  get shell() { return tr("执行命令") }
}

export function App() {
  // 订阅界面语言：切换后整棵树重渲染，所有 tr() 重新取词
  const lang = useLang()
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [current, setCurrent] = useState<Session | null>(null)
  const [running, setRunning] = useState(false)
  /** /learn 正在跑（一次模型调用，十几秒），期间重复回车不再触发第二次 */
  const [learning, setLearning] = useState(false)
  /** 本轮开始的时刻与当前在做什么，供输入框上方的「执行中」状态条显示 */
  const [runStart, setRunStart] = useState(0)
  const [runNote, setRunNote] = useState('')
  /** 排队位置：>0 表示还没抢到全局并发槽位，状态条要显示「排队」而不是计时 */
  const [queuePos, setQueuePos] = useState(0)
  const [input, setInput] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showAppSettings, setShowAppSettings] = useState(false)
  // 窗口是否最大化：右上角那个按钮的图标要跟着换
  const [maximized, setMaximized] = useState(false)
  const [showSkills, setShowSkills] = useState(false)
  /** Agent 档案面板：只在「软件设置 → Agent 档案」里主动打开 */
  const [showAgents, setShowAgents] = useState(false)
  // 审批队列：并行派出去的子 agent 可能同时要审批，一条一条处理
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const approval = approvals[0] ?? null
  /** question 工具：模型暂停问用户，一次一个 */
  const [question, setQuestion] = useState<QuestionRequest | null>(null)
  const [questionAnswer, setQuestionAnswer] = useState('')
  /** 多选时已勾选的选项（无序集合） */
  const [questionPicked, setQuestionPicked] = useState<Set<string>>(new Set())
  /** 高危审批要求勾选后才能「始终允许」，切换审批项时重置 */
  const [highAck, setHighAck] = useState(false)
  /** 「以后都这样」勾选（只对非高危出现），换一条审批就重置 */
  const [rememberGrant, setRememberGrant] = useState(false)
  useEffect(() => {
    setHighAck(false)
    setRememberGrant(false)
  }, [approval?.id])
  /** 正在跑的子任务，按父 agent 的 callId 索引 */
  const [subTasks, setSubTasks] = useState<Record<string, SubAgentTask>>({})
  const [toast, setToast] = useState<{ text: string; kind: 'info' | 'warn' | 'error' } | null>(null)
  /** 上次崩溃/中断未跑完的会话，启动时提示可恢复 */
  const [interrupted, setInterrupted] = useState<InterruptedCheckpoint[]>([])
  /**
   * 重拉「可续跑」清单。
   * 不只是启动时用：用户点「停止」之后 checkpoint 才落盘，正常跑完又会清掉，
   * 发送键要在「发送 / 继续」之间切换，就必须每次运行结束时重新问一遍。
   */
  const refreshInterrupted = useCallback(async () => {
    try {
      setInterrupted((await window.pico.checkpoints.interrupted()) ?? [])
    } catch {
      // 拿不到就当没有可续的：按钮退回「发送」，不影响正常对话
    }
  }, [])
  const [probes, setProbes] = useState<Record<string, ProbeInfo>>({})
  // 待确认的工作区删除（连同该分组下的所有会话）
  const [pendingWsDelete, setPendingWsDelete] = useState<{
    workspace: string | null
    count: number
  } | null>(null)
  // 待确认的单条会话删除（确认后移入回收站）
  const [pendingSessionDelete, setPendingSessionDelete] = useState<{
    id: string
    title: string
  } | null>(null)
  // 待确认的「删除会话内某一轮」：存消息 id，范围到确认时再按当前历史算
  const [pendingMessageDelete, setPendingMessageDelete] = useState<string | null>(null)
  /**
   * 模型切换时的加载提示：**任意**供应商都要亮，不只本程序托管的 llama.cpp。
   * 存的是目标名（横幅上显示「在加载谁」），null 表示不显示。
   */
  const [modelLoading, setModelLoading] = useState<string | null>(null)
  /** 每次切换的序号：只有最后一次切换允许收起横幅，旧任务的等待不能抢着关掉新提示 */
  const modelSwitchSeq = useRef(0)
  // 探测时顺带拿到的可用模型列表，供设置面板下拉复用（一次读取，两处共享）
  const [modelCache, setModelCache] = useState<Record<string, string[]>>({})
  // 待发送的附件（已复制到工作区 inbox/）
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  // 文件正被拖到窗口上方
  const [dragging, setDragging] = useState(false)
  const [attachBusy, setAttachBusy] = useState(false)
  // 当前执行计划（update_todos 推送；换会话时从历史消息里还原）
  const [todos, setTodos] = useState<TodoItem[]>([])
  /** 计划模式下产出的方案：等用户点「批准执行」 */
  const [plan, setPlan] = useState<SessionPlan | null>(null)
  /** 引擎上报的上下文占用（token 估算 / 窗口大小） */
  const [context, setContext] = useState<{
    used: number
    window: number
    compacted: boolean
  } | null>(null)
  /** 本会话累计用量；模型在价格表里时才有 costUsd */
  const [usage, setUsage] = useState<TokenUsage | null>(null)
  /**
   * 本轮用量（含生成速度）。
   * 本地模型最有意义的就是这个：同样一个任务换了量化/参数，tok/s 立刻能看出差别。
   * approx=true 表示 tps 是端到端墙钟估算（含首字延迟/排队），不是纯解码速度。
   */
  const [turnUsage, setTurnUsage] = useState<{
    prompt: number
    completion: number
    /** 命中前缀缓存的输入 token：本地模型上调参（稳定提示 / 工具数量）最直接的验证指标 */
    cached?: number
    /** prefill 实际处理的 token（timings.prompt_n），配合 prompt 算命中率 */
    promptN?: number
    tps?: number
    approx?: boolean
  } | null>(null)
  /** 本次会话的文件改动（快照），用于「变更」面板角标 */
  const [changes, setChanges] = useState<FileChange[]>([])
  const [changesKey, setChangesKey] = useState(0)
  /** 命令 / 技能在工具参数之外生成的成果（run_shell 跑 Python 产出的 xlsx、pdf 等） */
  const [shellOutputs, setShellOutputs] = useState<ResultFile[]>([])
  useEffect(() => setShellOutputs([]), [current?.id])
  /**
   * 消息列表额外展开的行数。
   *
   * 长会话里几百条消息全量挂到 DOM 上，每次流式输出一个字都要重排整棵树，
   * 越到后面越卡。这里默认只渲染尾部一批，往上看时再按批展开 ——
   * 只影响「画多少」，数据仍然全在 current.messages 里，搜索/导出/上下文计算都不变。
   */
  const [extraRows, setExtraRows] = useState(0)
  useEffect(() => setExtraRows(0), [current?.id])
  /** 输入框里的 @ 引用弹层 */
  const [mention, setMention] = useState<{
    start: number
    end: number
    query: string
    items: WorkspaceFile[]
    index: number
  } | null>(null)
  /** 输入框里的 / 命令弹层 + 可用的命令清单 */
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [slash, setSlash] = useState<{
    start: number
    end: number
    query: string
    items: SlashCommand[]
    index: number
  } | null>(null)

  const currentRef = useRef<string | null>(null)
  /** 打开会话的请求序号：只有最后一次点击允许写状态 */
  const openSeq = useRef(0)
  /** 本轮开始生成的时间点：引擎不上报解码耗时时的墙钟兜底（含首字延迟与等待） */
  const genStartedAt = useRef(0)
  const configRef = useRef<AppConfig | null>(null)
  /** 消息滚动区：流式输出要跟着走到底，但用户往上翻看历史时不抢他的位置 */
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const stickBottom = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // 主进程在窗口最大化 / 还原时通知过来，右上角的图标跟着换
  useEffect(() => window.pico.win.onMaximize(setMaximized), [])

  // 字号以主进程 prefs.json 为准：换过机器或清了 localStorage 时，这里把它纠正回来
  useEffect(() => {
    void window.pico.app
      .prefs()
      .then((p) => applyFontScale(p.fontScale, p.chatFontScale ?? null))
      .catch(() => undefined)
  }, [])

  const applyConfig = useCallback((next: AppConfig) => {
    configRef.current = next
    setConfig(next)
  }, [])

  /**
   * 斜杠命令跟着工作区走：项目里的 .roroto/commands/ 只在该仓库里出现。
   * 读失败不报错 —— 内置的 /init、/review 仍然可用，不能因为磁盘问题让输入框罢工。
   */
  const refreshCommands = useCallback(async () => {
    try {
      setCommands(await window.pico.commands.list(configRef.current?.workspace ?? null))
    } catch {
      setCommands([])
    }
  }, [])
  useEffect(() => {
    void refreshCommands()
  }, [config?.workspace, refreshCommands])

  // 逐个探测配置是否可用：能连上端点、且配置的模型确实存在于列表里
  const refreshProbes = useCallback(async () => {
    const list = configRef.current?.providers ?? []
    if (!list.length) return
    setProbes(Object.fromEntries(list.map((p) => [p.id, { state: 'checking' } as ProbeInfo])))
    await Promise.all(
      list.map(async (p) => {
        try {
          const result = await window.pico.models.probe(p.id)
          setProbes((prev) => ({
            ...prev,
            [p.id]: result.ok
              ? // running 决定这个点是绿（模型已加载在跑）还是黄（能用但没启动）
                { state: 'ok', running: result.running === true }
              : result.loading
                ? { state: 'checking', error: result.error ?? tr("模型加载中…") }
                : { state: 'fail', error: result.error, idle: result.idle === true }
          }))
          if (result.ok && result.models.length) {
            setModelCache((prev) => ({ ...prev, [p.id]: result.models }))
          }
        } catch (err) {
          setProbes((prev) => ({ ...prev, [p.id]: { state: 'fail', error: (err as Error).message } }))
        }
      })
    )
  }, [])

  /** 顶部提示：默认中性色，只有真正的错误才标红（原来一律红色，普通提示也像报错） */
  const notify = useCallback((message: string, kind: 'info' | 'warn' | 'error' = 'info') => {
    setToast({ text: message, kind })
    window.setTimeout(() => setToast((t) => (t && t.text === message ? null : t)), 6000)
  }, [])

  /**
   * 主进程在后台卸载了其它运行时（切走时模型可能还在加载，几秒后才看得到）。
   * 说一声，否则用户只会发现「显存突然空出来了」，不知道是谁动的。
   */
  useEffect(() => {
    const off = window.pico?.local?.onFreed?.((freed) => {
      if (freed.length) notify(tr("已释放显存：{0}", { "0": freed.join('；') }))
    })
    return off
  }, [notify])

  /** 技能面板里点「调用」：把指令填进输入框（已有内容就接在后面），并把光标落到末尾 */
  const useSkill = useCallback((skill: Skill) => {
    setShowSkills(false)
    setInput((prev) => {
      const text = prev.trim()
      return text ? `${text}\n\n${skill.prompt}` : skill.prompt
    })
    window.setTimeout(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 320)}px`
      el.setSelectionRange(el.value.length, el.value.length)
    }, 80)
  }, [])

  /**
   * 轮询本地 llama 服务，直到真的能连上（启动命令本身现在是秒回的）。
   * 必须点名实例：双卡双模型时工人模型可能先就绪，
   * 不指定就会把「工人起来了」误判成「主模型起来了」，随后主模型请求撞 503。
   */
  const waitLocalReady = useCallback(async (providerId?: string, maxMs = 90000) => {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
      try {
        const s = await window.pico.llama.status(providerId)
        if (s.running) return true
      } catch {
        // 服务还没起来，继续等
      }
      await new Promise((r) => window.setTimeout(r, 1500))
    }
    return false
  }, [])

  /**
   * 切换后的统一等待：横幅一直挂到「新模型有结论」才收起。
   *
   * 以前只有 llama.cpp 才亮「正在加载本地模型」，切到 Ollama / LM Studio /
   * 远端 API 时界面一声不吭，看着像没切换成功。现在所有目标都走这里：
   * - llama.cpp：等本程序拉起的实例真正 listen（模型加载完才算就绪）
   * - 其它：等一次探活给出结论；主进程回报 loading（服务正在载入模型）就继续等
   * 探活再快也至少显示 900ms，避免远端模型切换时横幅一闪而过；超时同样收起，
   * 服务没启动也不会让横幅永远挂着。
   */
  const finishModelLoading = useCallback(
    async (seq: number, target: ProviderConfig, isLlama: boolean) => {
      const startedAt = Date.now()
      const maxMs = isLlama ? 90000 : 20000
      try {
        if (isLlama) {
          await waitLocalReady(target.id, maxMs)
        } else {
          while (Date.now() - startedAt < maxMs) {
            const r = await window.pico.models.probe(target.id).catch(() => null)
            if (r && !r.loading) break
            await new Promise<void>((resolve) => window.setTimeout(() => resolve(), 1200))
          }
        }
        const rest = 900 - (Date.now() - startedAt)
        if (rest > 0) await new Promise<void>((resolve) => window.setTimeout(() => resolve(), rest))
      } finally {
        if (modelSwitchSeq.current === seq) setModelLoading(null)
        void refreshProbes()
      }
    },
    [refreshProbes, waitLocalReady]
  )

  /**
   * 切到某个供应商后的收尾，模型下拉与设置页共用同一份，避免两条路径行为不一致。
   * 无论目标是什么类型，先亮出「正在加载模型」，再按类型拉起 / 探测。
   * 等待放后台跑，不阻塞设置页保存按钮和下拉菜单的交互。
   */
  const activateModel = useCallback(
    async (
      activeId: string,
      saved: AppConfig,
      opts: { showLoading?: boolean; notifyHistory?: boolean } = {}
    ) => {
      const target = saved.providers.find((p) => p.id === activeId)
      if (!target) return
      const seq = ++modelSwitchSeq.current
      const isLlama = isLlamaProvider(target)
      if (opts.showLoading !== false) {
        setModelLoading(`${target.name || activeId}${target.model ? ` · ${target.model}` : ''}`)
      }
      setProbes((prev) => ({ ...prev, [activeId]: { state: 'checking' } }))

      /**
       * 工人模型的预热与「主模型是不是本地」无关：
       * 主模型走远端时，本地那块卡正好由工人模型独占，也要把它拉起来。
       */
      const warmWorker = () =>
        void window.pico.worker
          .warm(activeId)
          .then((w) => {
            if (w.ok && /已启动/.test(w.message)) notify(tr("工作模型已在后台加载"))
          })
          .catch(() => undefined)

      if (isLlama) {
        // 选中本地 llama.cpp 才启动；启动会立即写好模型配置，服务在后台加载
        let r: { ok: boolean; message: string }
        try {
          r = await window.pico.llama.start(target.model || undefined, undefined, {
            providerId: target.id
          })
        } catch (err) {
          /**
           * 启动失败（模型目录不可写、exe 被杀软占用、端口绑不上）会 reject。
           * 以前没有 try，横幅就永远停在「正在加载模型」，界面也不报错。
           */
          if (modelSwitchSeq.current === seq) {
            setModelLoading(null)
            setProbes((prev) => ({ ...prev, [activeId]: { state: 'fail' } }))
          }
          notify(tr("启动本地模型失败：{0}", { "0": (err as Error).message }), 'error')
          return
        }
        if (!r.ok) notify(r.message, 'error')
        // start 会把实际端口 / 模型写回配置，重读一次，别让界面拿着旧值
        const cfg = await window.pico.config.get()
        applyConfig(cfg)
        if (!r.ok) {
          // 启动就没成功：别空等 90 秒的就绪轮询，直接收起横幅并重新探活
          if (modelSwitchSeq.current === seq) setModelLoading(null)
          void refreshProbes()
          return
        }
        // 工人模型在后台起：双卡机器上它占另一张卡，子代理才是真并行
        warmWorker()
        /**
         * 诚实告知：换到本地模型时，历史不是「无缝接续」。
         * KV 缓存绑定模型权重，换了就作废，新模型要重新 prefill 整段历史。
         */
        if (opts.notifyHistory && currentRef.current && (current?.messages.length ?? 0) > 0) {
          notify(tr("已切换到本地模型：对话历史保留，但新模型会重新理解整段历史，首次响应会稍慢。"))
        }
      } else {
        // 目标不是 llama.cpp：release 已经按需停掉旧进程与占显存的模型，
        // 这里再 stop() 全停会把刚好该留着的工人模型一起杀掉
        warmWorker()
      }
      void refreshProbes()
      void finishModelLoading(seq, target, isLlama)
    },
    [applyConfig, current, notify, refreshProbes, finishModelLoading]
  )

  const refreshSessions = useCallback(async () => {
    const list = await window.pico.sessions.list()
    setSessions(list)
  }, [])

  const openSession = useCallback(
    async (id: string) => {
      /**
       * 连点两个会话时，只有最后一次点击算数。
       * 每个 await 之后都要复核一遍：磁盘慢的时候 A 的 load 可能比 B 晚返回，
       * 那样界面会停在 A，而用户点的是 B；A 的运行态和改动列表也会被贴到 B 上。
       */
      const seq = ++openSeq.current
      const alive = () => seq === openSeq.current
      const session = await window.pico.sessions.load(id)
      if (!alive()) return
      currentRef.current = id
      setCurrent(session)
      // 切走不会中断上一次运行：引擎按会话持锁，跑完才放。
      // 所以这里不能无脑置 false —— 否则切回来会显示「空闲」，
      // 用户再点发送才收到「这个会话正在运行中」，等于界面在骗人。
      const busy = await window.pico.chat.isRunning(id).catch(() => false)
      if (!alive()) return
      setRunning(busy)
      let start = 0
      let pos = 0
      let note = ''
      if (busy) {
        const live = await window.pico.agents.running().catch(() => [])
        if (!alive()) return
        const me = live.find((r) => r.sessionId === id)
        if (me?.state === 'queued') {
          // 排队中：计时从真正开跑算起，现在显示的是「还要等几个」
          pos = me.position
          note = tr("排队中 · 前面还有 {0} 个任务在跑", { "0": me.position })
        } else {
          start = me?.startedAt ?? Date.now()
        }
      }
      setRunStart(start)
      setQueuePos(pos)
      setRunNote(note)
      setApprovals([])
      setTodos(restoreTodos(session.messages))
      setPlan(session.plan ?? null)
      setContext(null)
      setTurnUsage(null)
      setUsage(session.usage ?? null)
      setMention(null)
      // 变更记录按会话存放：切会话就把列表换成这个会话的
      const list = await window.pico.changes.list(id).catch(() => [])
      if (!alive()) return
      setChanges(list)
      setChangesKey((k) => k + 1)

      // 会话自带工作区：打开时把全局工作区切过去，保证模型在正确目录干活
      const target = session.workspace ?? null
      const cfg = configRef.current
      if (cfg && target && cfg.workspace !== target) {
        const saved = await window.pico.config.save({ ...cfg, workspace: target })
        if (!alive()) return
        configRef.current = saved
        setConfig(saved)
      }
    },
    []
  )

  useEffect(() => {
    void (async () => {
      const cfg = await window.pico.config.get()
      applyConfig(cfg)
      void refreshProbes()
      const list = await window.pico.sessions.list()
      setSessions(list)
      if (list.length) {
        await openSession(list[0].id)
      } else {
        const created = await window.pico.sessions.create(cfg.workspace)
        setSessions([created])
        await openSession(created.id)
      }

      // 崩溃自动恢复：查上次没跑完的会话，有就提示（可一键恢复或忽略）
      void refreshInterrupted()

      // 当前选中的是本地 llama.cpp 但服务没跑时自动拉起，
      // 否则一打开程序这个模型必然显示红叉（其实只是没启动）
      const active = cfg.providers.find((p) => p.id === (cfg.activeId ?? ''))
      const isLocal = Boolean(active && isLlamaProvider(active))
      if (isLocal) {
        const s = await window.pico.llama.status(active!.id)
        if (!s.running && !s.loading) {
          const r = await window.pico.llama.start(active!.model || undefined, undefined, {
            providerId: active!.id
          })
          if (r.ok) {
            notify(tr("正在启动本地模型…"))
            await waitLocalReady(active!.id)
            void refreshProbes()
          }
        }
        // 工人模型一并预热：服务本来就在跑时也要看一眼，它是另一张卡上的独立实例
        void window.pico.worker
          .warm(active!.id)
          .then((w) => {
            if (w.ok && /已启动/.test(w.message)) notify(tr("工作模型已在后台加载"))
          })
          .catch(() => undefined)
      }
    })()
  }, [applyConfig, openSession, refreshProbes, notify, waitLocalReady, refreshInterrupted])

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case 'attach_reading':
          notify(tr("正在读取附件：{file}…", { file: event.file }))
          break
        case 'attach_no_vision':
          notify(tr("当前模型（{model}）看不了图。在「模型设置 → 模型 API」换成 qwen2.5-vl / llava / gemma3 这类视觉模型，就能直接看图。", { model: event.model }), 'warn')
          break
        case 'vision_switch':
          // 切视觉要重启服务（十来秒）：状态条上一直挂着，别只闪一个提示就没了
          if (event.state === 'loading') setRunNote(tr("正在切换视觉模型…"))
          else setRunNote('')
          notify(event.message, event.state === 'failed' ? 'warn' : 'info')
          break
        case 'compacting':
          notify(tr("对话较长，正在压缩早期内容…"))
          setRunNote(tr("正在压缩早期对话"))
          break
        case 'hint':
          notify(event.message, 'warn')
          break
        case 'failover':
          notify(tr("「{from}」不可用（{reason}），已自动切到「{to}」", { from: event.from, reason: event.reason, to: event.to }), 'warn')
          setRunNote(tr("已切换到 {to}", { to: event.to }))
          break
        case 'todos':
          setTodos(event.items)
          break
        case 'plan':
          setPlan(event.plan)
          break
        case 'diagnostics':
          // 刚写完的文件有编译错：只改状态条，不弹提示。
          // 一个任务里改坏两次是很正常的迭代过程，每次都弹窗会变成噪音；
          // 详情已经在工具结果里，用户点开那一轮就能看到具体哪行。
          setRunNote(tr("编译检查发现 {n} 个错误，正在修", { n: event.errors }))
          break
        case 'verify_start':
          setRunNote(tr("自动验证 · {label}", { label: event.label }))
          setCurrent((prev) =>
            prev
              ? {
                  ...prev,
                  messages: [
                    ...prev.messages,
                    {
                      id: `verify_${prev.messages.length}_${Date.now()}`,
                      role: 'tool',
                      content: '',
                      toolName: tr("自动验证 · {label}", { label: event.label }),
                      toolArgs: { command: event.command },
                      createdAt: Date.now()
                    }
                  ]
                }
              : prev
          )
          break
        case 'verify_result': {
          setRunNote(event.ok ? tr("验证通过，正在收尾") : tr("验证未通过，正在修复"))
          const text = tr("{0}（{1}s）\n\n{output}", { "0": event.ok ? tr("✓ 验证通过") : tr("✗ 验证未通过"), "1": (event.durationMs / 1000).toFixed(1), output: event.output })
          setCurrent((prev) => {
            if (!prev) return prev
            // 回填最后一张还没内容的验证卡片
            for (let i = prev.messages.length - 1; i >= 0; i--) {
              const m = prev.messages[i]
              if (m.role === 'tool' && m.toolName?.startsWith(tr("自动验证")) && !m.content) {
                const messages = prev.messages.slice()
                messages[i] = { ...m, content: text }
                return { ...prev, messages }
              }
            }
            return {
              ...prev,
              messages: [
                ...prev.messages,
                {
                  id: `verify_res_${Date.now()}`,
                  role: 'tool',
                  content: text,
                  toolName: tr("自动验证 · {label}", { label: event.label }),
                  toolArgs: { command: event.command },
                  createdAt: Date.now()
                }
              ]
            }
          })
          break
        }
        case 'assistant_start':
          setRunning(true)
          setRunStart((s) => s || Date.now())
          genStartedAt.current = Date.now()
          // 新一段正文开始 = 上一件工具活干完了，状态条该收起来。
          // 这里不再写「模型正在回复」：正文区自己在出字，重复一遍只是噪音。
          setRunNote('')
          setCurrent((prev) =>
            prev
              ? {
                  ...prev,
                  messages: [
                    ...prev.messages,
                    {
                      id: event.messageId,
                      role: 'assistant',
                      content: '',
                      createdAt: Date.now()
                    }
                  ]
                }
              : prev
          )
          break
        case 'delta':
          setCurrent((prev) =>
            prev
              ? {
                  ...prev,
                  messages: prev.messages.map((m) =>
                    m.id === event.messageId ? { ...m, content: m.content + event.text } : m
                  )
                }
              : prev
          )
          break
        case 'assistant_end':
          setCurrent((prev) =>
            prev
              ? {
                  ...prev,
                  messages: prev.messages.map((m) =>
                    m.id === event.messageId
                      ? { ...m, content: event.content, toolCalls: event.toolCalls }
                      : m
                  )
                }
              : prev
          )
          break
        case 'tool_start':
          setRunNote(tr("正在执行 {tool}", { tool: event.tool }))
          setCurrent((prev) =>
            prev
              ? {
                  ...prev,
                  messages: [
                    ...prev.messages,
                    {
                      id: `tool_${event.callId}`,
                      role: 'tool',
                      content: '',
                      toolCallId: event.callId,
                      toolName: event.tool,
                      toolArgs: event.args,
                      createdAt: Date.now()
                    }
                  ]
                }
              : prev
          )
          break
        case 'tool_result':
          setRunNote(tr("等待模型继续"))
          setCurrent((prev) =>
            prev
              ? {
                  ...prev,
                  messages: prev.messages.map((m) =>
                    m.toolCallId === event.callId ? { ...m, content: event.result } : m
                  )
                }
              : prev
          )
          break
        case 'file_change':
          setChanges((prev) => [event.change, ...prev.filter((c) => c.id !== event.change.id)])
          setChangesKey((k) => k + 1)
          break
        case 'artifacts':
          // 同一个文件被多次命令改动时合并成一行，别把成果面板刷成十几条
          setShellOutputs((prev) => {
            const map = new Map(prev.map((f) => [f.path, f]))
            for (const f of event.items) {
              const old = map.get(f.path)
              map.set(
                f.path,
                old
                  ? {
                      path: f.path,
                      action: old.action === 'created' || f.action === 'created' ? 'created' : 'edited',
                      at: Math.max(old.at, f.at),
                      writes: old.writes + f.writes
                    }
                  : f
              )
            }
            return [...map.values()]
          })
          break
        case 'context':
          setContext({ used: event.used, window: event.window, compacted: event.compacted })
          break
        case 'usage':
          setUsage(event.usage)
          if (event.last) {
            const wallMs = genStartedAt.current ? Date.now() - genStartedAt.current : 0
            // 本地引擎（Ollama eval_duration / llama.cpp timings.predicted_ms）会上报
            // 「纯解码耗时」。用它算 tok/s，才排掉排队、预填充（首字延迟）、工具执行和落盘。
            // 注意仍不等于「本地模型体检」的参考速度：那个是零上下文的理论上限，
            // 不含每步读取 KV cache 的代价，长上下文下实测必然更低。
            // 以前的算法一律拿「assistant_start → usage」的墙钟当分母，把 prefill 和
            // 各种等待全算进去，本地模型上会比真实解码速度低一大截。
            const genMs = event.genMs
            const measured =
              typeof genMs === 'number' && Number.isFinite(genMs) && genMs > 0 && genMs < 600000
            const ms = measured ? (genMs as number) : wallMs
            // 耗时太短（缓存命中 / 极短回答）时不给数字，免得算出几百 tok/s 的假值
            const tps = ms > 400 && event.last.completion > 0
              ? (event.last.completion / ms) * 1000
              : undefined
            setTurnUsage({
              prompt: event.last.prompt,
              completion: event.last.completion,
              cached: event.last.cached,
              promptN: event.last.promptN,
              tps,
              approx: tps !== undefined && !measured
            })
          }
          break
        case 'subagent_start':
        case 'subagent_update':
        case 'subagent_end':
          setSubTasks((prev) => ({ ...prev, [event.task.callId]: event.task }))
          if (event.type === 'subagent_start') {
            setRunNote(tr("子任务 · {description}", { description: event.task.description }))
          } else if (event.type === 'subagent_update') {
            setRunNote(tr("子任务 · {description} · 第 {steps} 步", { description: event.task.description, steps: event.task.steps }))
          } else {
            setRunNote(tr("子任务完成，等待模型继续"))
          }
          break
        case 'approval':
          setApprovals((q) => (q.some((a) => a.id === event.request.id) ? q : [...q, event.request]))
          setRunNote(tr("等待你确认操作"))
          break
        case 'approval_dismiss':
          // 停止或超时：主进程已经不会再等这个弹窗了，界面上必须一起收掉
          setApprovals((q) => q.filter((a) => a.id !== event.id))
          break
        case 'question':
          setQuestion(event.request)
          setQuestionAnswer('')
          setQuestionPicked(new Set())
          setRunNote(tr("等待你回答"))
          break
        case 'question_dismiss':
          setQuestion((q) => (q && q.id === event.id ? null : q))
          setQuestionAnswer('')
          setQuestionPicked(new Set())
          break
        case 'step_limit':
          notify(tr("已达到单轮最大步数 {maxSteps}，任务可能未完成，可以继续发消息推动。", { maxSteps: event.maxSteps }), 'warn')
          break
        case 'auto_continue':
          // 任务没做完，引擎自己接着跑：只更新状态行，不打断用户
          setRunNote(tr("任务未完成 · 自动继续（第 {round} 次）", { round: event.round }))
          break
        case 'steer':
          // 消息本体界面上已经有了（发出去时就地追加），这里只改状态行
          setRunNote(tr("已插话，正在按新指令重新规划"))
          break
        case 'queue':
          // position=0 是「终于轮到它了」；>0 是「前面还有几个在跑」
          setQueuePos(event.position)
          setRunStart(event.position > 0 ? 0 : Date.now())
          setRunNote(
            event.position > 0
              ? event.priority && event.priority !== 'manual'
                ? // 后台任务在排队时说清楚「为什么还没轮到它」：
                  // 不是卡住了，是用户在键盘前的提问优先
                  tr("排队中 · 前面还有 {0} 个任务在跑（后台任务，手动提问优先）", {
                    "0": event.position
                  })
                : tr("排队中 · 前面还有 {0} 个任务在跑（同时最多 {1} 个）", {
                    "0": event.position,
                    "1": event.limit
                  })
              : tr("正在理解你的需求")
          )
          break
        case 'error':
          notify(event.message, 'error')
          setRunning(false)
          setRunStart(0)
          setQueuePos(0)
          // 出错多半是「中断」：checkpoint 还留着，发送键要能变成「继续」
          void refreshInterrupted()
          break
        case 'done':
          setRunning(false)
          setRunStart(0)
          setQueuePos(0)
          setApprovals([])
          setQuestion(null)
          setQuestionAnswer('')
          // 收工结论必须说出来：以前这里只复位界面，正常收工和中途断掉看起来一模一样
          if (event.note) notify(event.note, event.ok === false ? 'warn' : 'info')
          void refreshSessions()
          // 正常收工主进程会清掉 checkpoint：这里刷新一次，按钮立刻退回「发送」
          void refreshInterrupted()
          break
        default:
          break
      }
    },
    [notify, refreshSessions, refreshInterrupted]
  )

  useEffect(() => {
    const off = window.pico.onEvent((payload: AgentEventEnvelope) => {
      const { sessionId, event } = payload
      if (sessionId !== currentRef.current) return
      handleEvent(event)
    })
    return off
  }, [handleEvent])

  /** 记下视口是不是贴着底：判定阈值给 56px，免得差一两行就判定为「用户翻走了」 */
  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    // 换会话等于换一屏内容，重新贴底
    stickBottom.current = true
    const onScroll = () => {
      stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 56
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [current?.id])

  /**
   * 跟着正文走。
   *
   * 依赖里放整个 messages 而不只是 length：流式输出时长度一直不变、变的是最后一条的内容，
   * 只看 length 的话视图会停在原地，长回答越写越低，用户得自己追着滚。
   * 用户主动往上翻（stickBottom 为 false）时不打扰，滚回底部后自动恢复跟随。
   */
  useEffect(() => {
    if (!stickBottom.current) return
    const el = messagesRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [current?.messages, running])

  /** 新加进来的附件按绝对路径去重，拖两次不会出现两份 */
  const mergeAttachments = useCallback((list: FileAttachment[]) => {
    setAttachments((prev) => {
      const seen = new Set(prev.map((a) => a.absPath))
      const next = [...prev]
      for (const item of list) {
        if (seen.has(item.absPath)) continue
        seen.add(item.absPath)
        next.push(item)
      }
      return next
    })
  }, [])

  const attachFrom = useCallback(
    async (loader: () => Promise<{ items: FileAttachment[]; errors: string[] }>) => {
      if (attachBusy) return
      setAttachBusy(true)
      try {
        const r = await loader()
        mergeAttachments(r.items)
        if (r.items.length) notify(tr("已添加 {length} 个文件", { length: r.items.length }))
        if (r.errors.length) notify(r.errors[0], 'error')
      } catch (err) {
        notify(tr("添加文件失败：{0}", { "0": (err as Error).message }), 'error')
      } finally {
        setAttachBusy(false)
      }
    },
    [attachBusy, mergeAttachments, notify]
  )

  const pickFiles = useCallback(() => {
    void attachFrom(() => window.pico.files.pick())
  }, [attachFrom])

  /** 截图当附件：报错不对、界面画歪时，一张图比十行描述管用 */
  const captureScreen = useCallback(() => {
    void attachFrom(() => window.pico.files.captureScreen())
  }, [attachFrom])

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }, [])

  const onDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null
    if (!next || !e.currentTarget.contains(next)) setDragging(false)
  }, [])

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setDragging(false)
      const files = Array.from(e.dataTransfer.files)
      if (!files.length) return
      const paths = files.map((f) => window.pico.files.pathOf(f)).filter(Boolean)
      if (!paths.length) {
        notify(tr("没拿到文件路径，改用「添加文件」按钮选一下"), 'warn')
        return
      }
      void attachFrom(() => window.pico.files.attach(paths))
    },
    [attachFrom, notify]
  )

  const send = useCallback(async () => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || !current) return
    // 附件以「路径 + 类型 + 大小」的形式带进消息，模型据此去读文件
    const compose = (raw: string): string =>
      attachments.length
        ? tr("{text}{1}【附件】\n{2}", {
            text: raw,
            "1": raw ? '\n\n' : '',
            "2": attachments.map((a) => `- ${a.path}（${a.kindLabel}，${sizeText(a.size)}）`).join('\n')
          })
        : raw
    let body = compose(text)

    /**
     * /learn：把这段对话干过的活蒸馏成技能。
     *
     * 它不发给模型当提问，所以不进消息历史；但要走模型（主进程里调一次），
     * 所以必须等这一轮结束 —— 跑到一半蒸馏，拿到的轨迹是断的。
     */
    if (text === '/learn' || text.startsWith('/learn ')) {
      if (running) {
        notify(tr("这一轮还在跑，等它结束再蒸馏，才拿得到完整的操作记录"), 'warn')
        return
      }
      if (learning) return
      setLearning(true)
      setInput('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      notify(tr("正在把这次的做法蒸馏成技能，大概十几秒"))
      try {
        const res = await window.pico.skills.distill(current.id)
        notify(res.message, res.ok ? 'info' : 'error')
      } catch (err) {
        notify((err as Error).message, 'error')
      } finally {
        setLearning(false)
      }
      return
    }

    /**
     * 斜杠命令：/fix-ci 123 → 把 .roroto/commands/fix-ci.md 展开成真正发给模型的话。
     * 展开失败就按原文发，不能因为一个坏文件让消息发不出去。
     */
    if (text.startsWith('/') && !running) {
      try {
        const r = await window.pico.commands.expand(text, configRef.current?.workspace ?? null)
        if (r.ok && r.prompt) body = compose(r.prompt)
      } catch {
        // 按原文发
      }
    }

    const userMessage: ChatMessage = {
      id: `local_${Date.now()}`,
      role: 'user',
      content: body,
      createdAt: Date.now()
    }

    /**
     * 运行中按发送 = 插话，不是「再排一个任务」。
     * 引擎会当场停掉正在跑的工具，把这句话插进当前这一轮重新规划。
     */
    if (running) {
      if (attachments.length > 0) {
        notify(tr("运行中不能带附件：先把这句话发出去，附件等这一轮结束再发"), 'warn')
        return
      }
      const accepted = await window.pico.chat.steer(current.id, body)
      if (!accepted) {
        // 引擎那边这一轮刚好收尾了：让用户再按一次，别把话吞掉
        notify(tr("这一轮刚刚结束了，再按一次发送就行"))
        return
      }
      setCurrent((prev) => (prev ? { ...prev, messages: [...prev.messages, userMessage] } : prev))
      setInput('')
      setRunNote(tr("已插话，正在按新指令重新规划"))
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      return
    }

    setCurrent((prev) => (prev ? { ...prev, messages: [...prev.messages, userMessage] } : prev))
    setInput('')
    setAttachments([])
    setRunning(true)
    setRunStart(Date.now())
    setRunNote(tr("正在理解你的需求"))
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    try {
      // 附件本体交给主进程抽正文：模型看到的是文件内容，而不是一个路径
      await window.pico.chat.send(
        current.id,
        body,
        attachments.map((a) => ({
          path: a.path,
          absPath: a.absPath,
          kindLabel: a.kindLabel,
          size: a.size
        }))
      )
    } catch (err) {
      notify((err as Error).message, 'error')
      setRunning(false)
    }
  }, [attachments, config?.workspace, current, input, notify, running, learning])

  /** 重新生成上一轮回答 */
  const regenerate = useCallback(async () => {
    if (!current || running) return
    setRunning(true)
    setRunStart(Date.now())
    setRunNote(tr("正在重新生成回答"))
    setContext(null)
    try {
      await window.pico.chat.regenerate(current.id)
    } catch (err) {
      notify((err as Error).message, 'error')
      setRunning(false)
      setRunStart(0)
    }
  }, [current, running, notify])

  /** 改掉自己的一句话后重发：本地先截断，界面立刻看到效果 */
  const editAndResend = useCallback(
    async (messageId: string, text: string) => {
      if (!current || running) return
      setCurrent((prev) => {
        if (!prev) return prev
        const idx = prev.messages.findIndex((m) => m.id === messageId)
        if (idx < 0) return prev
        const kept = prev.messages.slice(0, idx)
        return {
          ...prev,
          messages: [...kept, { ...prev.messages[idx], content: text, createdAt: Date.now() }]
        }
      })
      setRunning(true)
      setRunStart(Date.now())
      setRunNote(tr("正在按你的修改重新回答"))
      try {
        await window.pico.chat.editAndResend(current.id, messageId, text)
      } catch (err) {
        notify((err as Error).message, 'error')
        setRunning(false)
        setRunStart(0)
      }
    },
    [current, running, notify]
  )

  /** 删除会话内某一轮：确认前按当前历史算出会带走几条消息，弹窗里说清楚 */
  const pendingDeleteCount = useMemo(() => {
    if (!pendingMessageDelete || !current) return 0
    const range = turnRangeOf(current.messages, pendingMessageDelete)
    return range ? range.end - range.start : 0
  }, [pendingMessageDelete, current])

  const requestDeleteTurn = useCallback(
    (messageId: string) => {
      if (running) return
      setPendingMessageDelete(messageId)
    },
    [running]
  )

  const confirmDeleteTurn = useCallback(async () => {
    if (!current || !pendingMessageDelete || running) return
    const sessionId = current.id
    const messageId = pendingMessageDelete
    setPendingMessageDelete(null)
    try {
      const res = await window.pico.sessions.deleteTurn(sessionId, messageId)
      setCurrent(res.session)
      setTodos(restoreTodos(res.session.messages))
      // 顶部那条占用量是旧历史的估算，删完就不准了，等下一次请求重新上报
      setContext(null)
      void refreshSessions()
      notify(
        tr("已删除 {n} 条消息，后续每轮约少 {tokens} tokens", {
          n: res.removed,
          tokens: res.savedTokens
        })
      )
    } catch (err) {
      notify((err as Error).message, 'error')
    }
  }, [current, pendingMessageDelete, running, notify, refreshSessions])

  /**
   * 从某条消息分叉。
   *
   * 和「编辑重发」的区别说在这里，因为界面上两个按钮挨着：
   * 编辑重发是把当前这条路改掉（后面的回答直接没），分叉是把历史复制一份，
   * 原来那条对话一个字不动地留在侧栏里 —— 想两条路子都试试的时候用它。
   */
  const forkFrom = useCallback(
    async (messageId: string) => {
      if (!current || running) return
      try {
        const fork = await window.pico.sessions.fork(current.id, messageId)
        await refreshSessions()
        // 直接切过去：分叉完下一步就是接着问，停在原地会让人以为没成功
        await openSession(fork.id)
        notify(tr("已分叉出新会话，原来那条对话保留不动"))
      } catch (err) {
        notify((err as Error).message, 'error')
      }
    },
    [current, running, notify, refreshSessions, openSession]
  )

  /** 运行时不给删：正在跑的那一轮拿着的是旧历史，中途改会错位 */
  const deleteTurnHandler = running ? undefined : requestDeleteTurn

  /**
   * 传给 MessageItem 的三个回调必须引用稳定，否则 memo 形同虚设。
   *
   * 这几个回调都闭包了 current / running，而流式输出时 current 每帧都换引用。
   * 用 ref 存「最新实现」，对外的包装函数体只读 ref、依赖为空 —— 引用永远不变，
   * 但点下去执行的一定是当前这一版的逻辑。
   */
  const latestHandlers = useRef({
    regenerate,
    editAndResend,
    deleteTurn: deleteTurnHandler,
    fork: forkFrom
  })
  latestHandlers.current = {
    regenerate,
    editAndResend,
    deleteTurn: deleteTurnHandler,
    fork: forkFrom
  }
  const onRegenerateMsg = useCallback(() => void latestHandlers.current.regenerate(), [])
  const onEditMsg = useCallback(
    (messageId: string, text: string) => void latestHandlers.current.editAndResend(messageId, text),
    []
  )
  const onDeleteMsg = useCallback((messageId: string) => latestHandlers.current.deleteTurn?.(messageId), [])
  const onForkMsg = useCallback((messageId: string) => void latestHandlers.current.fork(messageId), [])

  /** 中断后接着做 */
  const resumeRun = useCallback(async () => {
    if (!current || running) return
    setRunning(true)
    setRunStart(Date.now())
    setRunNote(tr("从断点继续"))
    try {
      await window.pico.chat.resume(current.id)
    } catch (err) {
      notify((err as Error).message, 'error')
      setRunning(false)
      setRunStart(0)
    }
  }, [current, running, notify])

  /** 启动恢复提示条：点「恢复」跳到那个会话并从中断处继续 */
  const resumeInterrupted = useCallback(
    async (sessionId: string) => {
      await openSession(sessionId)
      setInterrupted((list) => list.filter((c) => c.sessionId !== sessionId))
      // openSession 是异步的，等 current 就位后再触发 resume；这里直接调 chat.resume 即可，
      // 主进程会从 checkpoint 还原进度并接着跑
      if (running) return
      setRunning(true)
      setRunStart(Date.now())
      setRunNote(tr("从断点继续"))
      try {
        await window.pico.chat.resume(sessionId)
      } catch (err) {
        notify((err as Error).message, 'error')
        setRunning(false)
        setRunStart(0)
      }
    },
    [openSession, running, notify]
  )

  /** 忽略中断提示：清除该会话的 checkpoint 标记 */
  const dismissInterrupted = useCallback(async (sessionId: string) => {
    setInterrupted((list) => list.filter((c) => c.sessionId !== sessionId))
    await window.pico.checkpoints.dismiss(sessionId).catch(() => undefined)
  }, [])

  /** 导出当前会话为 Markdown */
  const exportCurrent = useCallback(async () => {
    if (!current) return
    try {
      const r = await window.pico.sessions.export(current.id)
      if (r.ok) notify(tr("已导出到 {path}", { path: r.path }))
      else if (r.message && r.message !== '已取消') notify(r.message, 'error')
    } catch (err) {
      notify((err as Error).message, 'error')
    }
  }, [current, notify])

  /** @ 引用：识别光标前那段 @xxx，去工作区里找文件 */
  const mentionTimer = useRef<number | null>(null)
  const syncMention = useCallback((value: string, caret: number) => {
    if (mentionTimer.current) window.clearTimeout(mentionTimer.current)
    const before = value.slice(0, caret)
    const m = /(^|[\s([{])@([^\s@]*)$/.exec(before)
    if (!m) {
      setMention(null)
      return
    }
    const query = m[2]
    const start = caret - query.length - 1
    mentionTimer.current = window.setTimeout(() => {
      void window.pico.files
        .list(query)
        .then((items) => setMention({ start, end: caret, query, items, index: 0 }))
        .catch(() => setMention(null))
    }, 160)
  }, [])

  /** 选中一个文件：把 @query 替换成 @路径 */
  const applyMention = useCallback(
    (file: WorkspaceFile) => {
      if (!mention) return
      const next = `${input.slice(0, mention.start)}@${file.path} ${input.slice(mention.end)}`
      const caret = mention.start + file.path.length + 2
      setInput(next)
      setMention(null)
      window.requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(caret, caret)
      })
    },
    [input, mention]
  )

  /**
   * / 命令补全：只在「整个输入还是一条 /xxx」时出现。
   * 一旦打了空格（开始填参数）就收起，不挡着正文。
   */
  const syncSlash = useCallback(
    (value: string, caret: number) => {
      const m = /^\/([\w-]*)$/.exec(value.slice(0, caret))
      if (!m) {
        setSlash(null)
        return
      }
      const q = m[1].toLowerCase()
      const items = commands.filter((c) => c.name.toLowerCase().includes(q))
      setSlash({ start: 0, end: caret, query: q, items, index: 0 })
    },
    [commands]
  )

  const applySlash = useCallback(
    (cmd: SlashCommand) => {
      const next = `/${cmd.name} `
      setInput(next)
      setSlash(null)
      window.requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.style.height = 'auto'
        el.style.height = `${Math.min(el.scrollHeight, 320)}px`
        el.setSelectionRange(next.length, next.length)
      })
    },
    []
  )

  const newSession = useCallback(async (workspace?: string | null, agentId?: string | null) => {
      const cfg = configRef.current
      // 不强制选工作区：undefined 表示沿用当前目录，null 表示明确不绑定目录
      const target = workspace === undefined ? cfg?.workspace ?? null : workspace
      try {
        const created = await window.pico.sessions.create(target, agentId ?? null)

        if (cfg && (cfg.workspace ?? null) !== (target ?? null)) {
          const saved = await window.pico.config.save({ ...cfg, workspace: target })
          configRef.current = saved
          setConfig(saved)
        }

        setSessions((prev) => [created, ...prev])
        currentRef.current = created.id
        setCurrent(created)
        setRunning(false)
        setRunStart(0)
        setRunNote('')
        setApprovals([])
      } catch (err) {
        // 侧栏的「新对话」是 void 调用的：不接住就只剩一条 unhandled rejection
        notify(tr("新建会话失败：{0}", { "0": (err as Error).message }), 'error')
      }
    },
    [notify]
  )

  const newWorkspace = useCallback(async () => {
    const dir = await window.pico.workspace.choose()
    if (!dir) return
    await newSession(dir)
  }, [newSession])

  /**
   * 用某个常驻档案开一个新会话 —— 只在用户明确说「用它开始一个任务」时调用。
   * 档案自己钉了工作区就用它，否则沿用当前工作区：用户预期是
   * 「在当前项目里叫一个角色来干活」，不是被拽去别的目录。
   */
  const newSessionWithAgent = useCallback(
    async (agent: AgentProfile) => {
      await newSession(agent.workspace ?? undefined, agent.id)
    },
    [newSession]
  )
  const deleteSession = useCallback(
    async (id: string) => {
      await window.pico.sessions.remove(id)
      const list = await window.pico.sessions.list()
      setSessions(list)
      if (currentRef.current === id) {
        if (list.length) {
          await openSession(list[0].id)
        } else {
          const created = await window.pico.sessions.create(configRef.current?.workspace ?? null)
          setSessions([created])
          await openSession(created.id)
        }
      }
    },
    [openSession]
  )

  /** 单条会话删除：先弹确认，确认后移入回收站（7 天内可恢复） */
  const requestDeleteSession = useCallback(
    (id: string) => {
      const meta = sessions.find((s) => s.id === id)
      setPendingSessionDelete({ id, title: meta?.title || tr("未命名会话") })
    },
    [sessions]
  )

  const confirmDeleteSession = useCallback(async () => {
    const target = pendingSessionDelete
    if (!target) return
    setPendingSessionDelete(null)
    try {
      await deleteSession(target.id)
      notify(tr("已移入回收站，7 天内可在设置里恢复"))
    } catch (err) {
      notify(tr("删除失败：{0}", { "0": (err as Error).message }), 'error')
    }
  }, [deleteSession, notify, pendingSessionDelete])

  // 工作区分组删除：先弹确认，确认后删掉该分组下的所有会话
  const requestDeleteWorkspace = useCallback(
    (workspace: string | null) => {
      const count = sessions.filter((s) => (s.workspace ?? null) === (workspace ?? null)).length
      if (count === 0) return
      setPendingWsDelete({ workspace, count })
    },
    [sessions]
  )

  const confirmDeleteWorkspace = useCallback(async () => {
    const target = pendingWsDelete
    if (!target) return
    setPendingWsDelete(null)

    const victims = sessions.filter(
      (s) => (s.workspace ?? null) === (target.workspace ?? null)
    )
    for (const v of victims) {
      try {
        await window.pico.sessions.remove(v.id)
      } catch {
        // 单个会话删除失败不影响其他会话
      }
    }

    // 当前全局工作区被删掉了，就解除绑定，避免立刻又生成分组
    const cfg = configRef.current
    if (cfg && target.workspace && (cfg.workspace ?? null) === target.workspace) {
      const saved = await window.pico.config.save({ ...cfg, workspace: null })
      configRef.current = saved
      setConfig(saved)
    }

    const list = await window.pico.sessions.list()
    setSessions(list)

    // 正在看的会话被删了：切到别的会话，没有了就新建一个
    if (currentRef.current && victims.some((v) => v.id === currentRef.current)) {
      if (list.length) {
        await openSession(list[0].id)
      } else {
        const created = await window.pico.sessions.create(null)
        setSessions([created])
        await openSession(created.id)
      }
    }
  }, [openSession, pendingWsDelete, sessions])

  /**
   * 切到某个工作区：当前会话跟着换目录，列表里也会移动到对应分组。
   * chooseWorkspace 和「最近工作区」走同一条路径，避免两套行为跑偏。
   */
  const switchWorkspace = useCallback(
    async (dir: string) => {
      if (!dir) return
      try {
        const cfg = configRef.current
        if (cfg) {
          const saved = await window.pico.config.save({ ...cfg, workspace: dir })
          configRef.current = saved
          setConfig(saved)
        }
        if (currentRef.current) {
          await window.pico.sessions.setWorkspace(currentRef.current, dir)
          await refreshSessions()
        }
      } catch (err) {
        // 目录权限不对 / 配置写不进去时，界面必须说清楚，否则像是「点了没反应」
        notify(tr("切换工作区失败：{0}", { "0": (err as Error).message }), 'error')
      }
    },
    [notify, refreshSessions]
  )

  const chooseWorkspace = useCallback(async () => {
    const dir = await window.pico.workspace.choose()
    if (!dir) return
    await switchWorkspace(dir)
  }, [switchWorkspace])

  const updateActive = useCallback(
    async (activeId: string) => {
      if (!config) return
      const saved = await window.pico.config.save({ ...config, activeId })
      applyConfig(saved)
      // 切换模型时先清掉用不到的本地运行时：8 GB 显存上两个 7B 同时驻留会直接爆
      const freed = await window.pico.local.release(activeId).catch(() => null)
      if (freed?.freed.length) notify(tr("已释放显存：{0}", { "0": freed.freed.join('；') }))
      // 下拉里每次点选都是真切换：统一走加载提示，不再只认 llama.cpp
      void activateModel(activeId, saved, { notifyHistory: true })
    },
    [applyConfig, config, notify, activateModel]
  )

  /** 批准方案：会话切到 build，然后自动补一句「按方案执行」，不用用户再打字 */
  const approvePlan = useCallback(async () => {
    const id = currentRef.current
    if (!id) return
    try {
      const s = await window.pico.sessions.approvePlan(id)
      setPlan(s.plan ?? null)
      setCurrent((prev) =>
        prev && prev.id === s.id ? { ...prev, modeOverride: s.modeOverride, plan: s.plan } : prev
      )
      setSessions((prev) =>
        prev.map((x) => (x.id === s.id ? { ...x, modeOverride: s.modeOverride, plan: s.plan } : x))
      )
      notify(tr('计划已批准，开始执行'), 'info')
      await window.pico.chat.send(id, tr('计划已批准，按方案开始执行。'))
    } catch (err) {
      notify((err as Error).message || tr('批准失败'), 'error')
    }
  }, [notify])

  const respondApproval = useCallback(
    (approved: boolean, always = false, persist = false) => {
      if (!approval) return
      // always = 这一轮不再问（主进程按会话记）；persist = 以后都这样（按工作区+工具落盘）
      window.pico.approval.respond(approval.id, approved, always, persist)
      setRememberGrant(false)
      // 只移除这一条，后面排队的（并行的子 agent）接着弹
      setApprovals((q) => q.filter((a) => a.id !== approval.id))
    },
    [approval]
  )

  const respondQuestion = useCallback(
    (answer: string) => {
      if (!question) return
      const a = answer.trim()
      if (!a) return
      window.pico.question.respond(question.id, a)
      setQuestion(null)
      setQuestionAnswer('')
      setQuestionPicked(new Set())
    },
    [question]
  )

  /**
   * Esc 关掉最上层的弹窗。
   *
   * 每个动作都取「最保守的那一步」：审批 = 拒绝（模型还能换个方式再问），
   * 删除类 = 取消，提问 = 跳过。输入框自己消费掉的 Esc（关 @ 补全、退出编辑）
   * 会 preventDefault，这里让路。
   */
  useEffect(() => {
    if (!approval && !question && !pendingSessionDelete && !pendingMessageDelete && !pendingWsDelete) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (pendingMessageDelete) {
        setPendingMessageDelete(null)
        return
      }
      if (pendingSessionDelete) {
        setPendingSessionDelete(null)
        return
      }
      if (pendingWsDelete) {
        setPendingWsDelete(null)
        return
      }
      if (question) {
        window.pico.question.respond(question.id, '')
        setQuestion(null)
        setQuestionAnswer('')
        setQuestionPicked(new Set())
        return
      }
      if (approval) respondApproval(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [approval, question, pendingSessionDelete, pendingMessageDelete, pendingWsDelete, respondApproval])

  const provider = config?.providers.find((p) => p.id === config.activeId) ?? config?.providers[0] ?? null
  const activeProbe = probes[provider?.id ?? ''] ?? { state: 'checking' as const }
  // 输入框下方只放目录名（路径太长会把这一行挤爆），完整路径在按钮 title 里
  const workspaceLabel = config?.workspace ? baseName(config.workspace) : tr("默认 workspace")
  // 一个模型都没配：顶部与空状态都要引导到「模型设置」
  const noModels = Boolean(config) && (config as AppConfig).providers.length === 0
  /**
   * 首次运行：本机什么都没准备好。
   *
   * 默认配置里本来就带了几个供应商（OpenAI / Ollama / llama.cpp…），所以「providers 为空」
   * 永远不成立，首装那一刻中间区域会直接摆出「说说你想改什么」——可此时一个能用的模型都没有。
   * 这里按「实际能不能跑」判断：本地没有「llama.cpp + 至少一个模型」这种组合、也没有填了 Key
   * 的远端接口、当前模型也探不通，才换成引导文案。在设置里装完东西关掉，会重新问一次。
   */
  const [llamaInstalled, setLlamaInstalled] = useState<boolean | null>(null)
  const [localModelCount, setLocalModelCount] = useState(0)
  useEffect(() => {
    let alive = true
    void (async () => {
      // 两件事一起问：装没装、有没有现成的 .gguf。只有「装了且有模型」才算本地可用
      const [b, m] = await Promise.all([
        window.pico.llama.backend().catch(() => ({ installed: true } as { installed?: boolean })),
        window.pico.llama.models().catch(() => ({ models: [] as string[] }))
      ])
      if (!alive) return
      // 问不到就按「已装」放过，宁可显示普通空状态，也不要误导
      setLlamaInstalled(b.installed ?? true)
      setLocalModelCount(m.models?.length ?? 0)
    })()
    return () => {
      alive = false
    }
  }, [showSettings])
  const hasRemoteKey = Boolean(
    config?.providers.some((p) => (p.apiKey ?? '').trim() !== '' && !isLoopbackUrl(p.baseUrl))
  )
  const localReady = llamaInstalled === true && localModelCount > 0
  const needsSetup =
    Boolean(config) && llamaInstalled !== null && !localReady && !hasRemoteKey && activeProbe.state !== 'ok'
  // 成果 = 工具参数里写过的文件 + 命令/技能在磁盘上新生成的产物；后者切会话后清空
  const outputs = useMemo(
    () => filterOutputs([...collectOutputs(current?.messages ?? []), ...shellOutputs]),
    [current, shellOutputs]
  )
  // 附件里有图片、而当前模型看不了图时，输入框上方直接提醒，别等模型答非所问
  const hasImageAttach = attachments.some((a) => isImagePath(a.absPath) || a.kind === 'image')
  const visionReady = providerSupportsVision(provider)
  const activeModelName = provider ? provider.model : tr("未选择")
  // 「限制上下文」没开时窗口只是模型的自然上限，不是用户设的天花板：
  // 这时不摆上限、不画进度条，只报这一轮实际用了多少（进度条没有上限就没意义，还容易吓人）
  const ctxCapped = config ? config.contextLimit === true : true
  const ctxPct = context ? Math.min(100, Math.round((context.used / Math.max(1, context.window)) * 100)) : 0

  /**
   * 发送键兼作「继续」：输入框空着、而这个会话确实中断过（checkpoint 还在）才让位。
   * 正常跑完的会话没有断点，继续按下去只会白烧一轮。
   */
  const hasInput = Boolean(input.trim()) || attachments.length > 0
  const canResume = Boolean(current && interrupted.some((c) => c.sessionId === current.id))

  return (
    <div
      className="app"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="drop-hint">
          <div className="drop-hint-inner">
            <span className="drop-hint-title">{tr("松开就把文件交给模型")}</span>
            <span className="drop-hint-sub">{tr("PDF / 图片 / 文档 / 表格，会复制到工作区 inbox/")}</span>
          </div>
        </div>
      )}
      <Sidebar
        sessions={sessions}
        currentId={current?.id ?? null}
        runningId={running ? current?.id ?? null : null}
        currentWorkspace={config?.workspace ?? null}
        onNewIn={(ws) => void newSession(ws)}
        onNewWorkspace={() => void newWorkspace()}
        onSelect={(id) => void openSession(id)}
        onDelete={(id) => requestDeleteSession(id)}
        onDeleteWorkspace={(ws) => requestDeleteWorkspace(ws)}
        onOpenSkills={() => setShowSkills(true)}
      />

      <main className="main">
        <header className="header">
          <span className="header-label">{tr("模型选择")}</span>
          <ModelPicker
            providers={config?.providers ?? []}
            activeId={config?.activeId ?? null}
            probes={probes}
            onSelect={(id) => void updateActive(id)}
            onRefresh={() => void refreshProbes()}
            onOpenSettings={() => setShowSettings(true)}
          />
          <button
            className="header-settings"
            onClick={() => setShowSettings(true)}
            title={tr("模型设置：本地模型、模型 API、模型列表")}
          >
            {tr("模型设置")}</button>
          <div className="spacer" />
          <button
            className="icon-btn header-lang"
            onClick={toggleLang}
            title={lang === 'zh' ? '切换到英文 · Switch to English' : '切换到中文 · Switch to Chinese'}
            aria-label={lang === 'zh' ? 'Switch to English' : 'Switch to Chinese'}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.1" stroke="currentColor" strokeWidth="1.2" />
              <ellipse cx="8" cy="8" rx="2.6" ry="6.1" stroke="currentColor" strokeWidth="1.2" />
              <path d="M2 8h12" stroke="currentColor" strokeWidth="1.2" />
            </svg>
            <span>{lang === 'zh' ? 'EN' : '中'}</span>
          </button>
          <button
            className="icon-btn header-gear"
            onClick={() => setShowAppSettings(true)}
            title={tr("软件设置")}
            aria-label={tr("软件设置")}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z"
                stroke="currentColor"
                strokeWidth="1.3"
              />
              <path
                d="M12.9 9.6a1 1 0 0 0 .2 1.1l.1.1a1.2 1.2 0 1 1-1.7 1.7l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9v.3a1.2 1.2 0 1 1-2.4 0v-.2a1 1 0 0 0-.7-.9 1 1 0 0 0-1.1.2l-.1.1a1.2 1.2 0 1 1-1.7-1.7l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H2.8a1.2 1.2 0 1 1 0-2.4h.2a1 1 0 0 0 .9-.7 1 1 0 0 0-.2-1.1l-.1-.1a1.2 1.2 0 1 1 1.7-1.7l.1.1a1 1 0 0 0 1.1.2h.1a1 1 0 0 0 .6-.9V2.8a1.2 1.2 0 1 1 2.4 0v.2a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a1.2 1.2 0 1 1 1.7 1.7l-.1.1a1 1 0 0 0-.2 1.1v.1a1 1 0 0 0 .9.6h.3a1.2 1.2 0 1 1 0 2.4h-.2a1 1 0 0 0-.9.6Z"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </header>
        {/* 标题栏以下才分左右两栏：左边对话 + 输入框，右边成果面板。
            成果面板从标题栏下方开始，不再盖住窗口右上角的最小 / 最大 / 关闭。 */}
        <div className="workbench">
          <div className="chat-col">
            {noModels && (
              <div className="no-model-bar">
                <span className="no-model-icon">!</span>
                <span className="no-model-text">{tr("请点击模型设置 添加模型")}</span>
                <button className="btn primary sm" onClick={() => setShowSettings(true)}>
                  {tr("打开模型设置")}</button>
              </div>
            )}

            {modelLoading && (
              <div className="model-loading">
                {tr("正在加载模型：{0}，请稍后…", { "0": modelLoading })}
              </div>
            )}

            <PlanApproval plan={plan} running={running} onApprove={() => void approvePlan()} />
            <PlanCard items={todos} running={running} />

            <div className="messages" ref={messagesRef}>
              {!current || current.messages.length === 0 ? (
                <div className="empty">
                  {noModels || needsSetup ? (
                    <>
                      <h1>
                        {noModels ? tr("请点击模型设置 添加模型") : tr("请点击模型设置 配置核心 与本地模型")}
                      </h1>
                      <div>
                        {noModels
                          ? tr("还没有模型：到「模型设置」跑本地模型或填 API。")
                          : tr("本机还没装好：到「模型设置 → ② 本地模型」装好 llama.cpp，再挑一个模型。")}
                      </div>
                      <button
                        className="btn primary empty-cta"
                        onClick={() => setShowSettings(true)}
                      >
                        {noModels ? tr("打开模型设置") : tr("去配置")}</button>
                    </>
                  ) : (
                    <>
                      <h1>{tr("说说你想改什么")}</h1>
                      <div>
                        {tr("例如：")}<code>{tr("看一下这个项目的入口文件，然后加一个 /health 接口")}</code>
                      </div>
                      {provider && (
                        <div style={{ marginTop: 10, fontSize: 'calc(12px * var(--fs, 1))' }}>
                          {tr("当前模型：")}{provider.name} · {provider.model || tr("未设置")}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <div className="msg-wrap">
                  {(() => {
                    // 只画尾部一批：数据全在 current.messages 里，这里控制的仅是 DOM 数量
                    const { shown, hidden } = windowRows(groupRows(current.messages), extraRows)
                    return (
                      <>
                        {hidden > 0 && (
                          <button
                            className="msg-more"
                            onClick={() => setExtraRows((n) => n + MSG_WINDOW_STEP)}
                            title={tr("更早的 {n} 条没有渲染，点开继续往前看", { n: hidden })}
                          >
                            {tr("显示更早的 {n} 条", { n: Math.min(hidden, MSG_WINDOW_STEP) })}
                          </button>
                        )}
                        {shown.map((row) => {
                          const lastIndex = current.messages.length - 1
                          const isLast =
                            current.messages[lastIndex]?.id === row.key ||
                            current.messages[lastIndex]?.id === row.steps?.[row.steps.length - 1]?.id
                          // 一段执行过程：两条以上的工具调用才值得折起来；只有一条就保持原样的小卡片
                          if (row.steps) {
                            const tools = row.steps.filter((m) => m.role === 'tool')
                            if (tools.length > 1) {
                              return (
                                <StepGroup
                                  key={row.key}
                                  messages={row.steps}
                                  running={running && isLast}
                                  onDelete={running ? undefined : onDeleteMsg}
                                />
                              )
                            }
                            return (
                              <Fragment key={row.key}>
                                {row.steps.map((m) => (
                                  <MessageItem
                                    key={m.id}
                                    message={m}
                                    running={running && m.id === current.messages[lastIndex]?.id}
                                    onDelete={running ? undefined : onDeleteMsg}
                                    subTask={m.toolCallId ? subTasks[m.toolCallId] : undefined}
                                  />
                                ))}
                              </Fragment>
                            )
                          }
                          const m = row.one
                          return (
                            <MessageItem
                              key={m.id}
                              message={m}
                              running={running && m.id === current.messages[lastIndex]?.id}
                              canRegenerate={!running && m.id === current.messages[lastIndex]?.id && m.role === 'assistant'}
                              onRegenerate={onRegenerateMsg}
                              onEdit={onEditMsg}
                              onDelete={running ? undefined : onDeleteMsg}
                              onFork={running ? undefined : onForkMsg}
                              subTask={m.toolCallId ? subTasks[m.toolCallId] : undefined}
                            />
                          )
                        })}
                      </>
                    )
                  })()}
                  <div />
                </div>
              )}
            </div>

            {interrupted.length > 0 && (
              <div className="resume-banner">
                <div className="resume-banner-text">
                  <strong>{tr("检测到上次有任务没跑完")}</strong>
                  <span>
                    {interrupted.length === 1
                      ? tr("有 {n} 个会话在中断时仍在执行，可以接着做。", { n: interrupted.length })
                      : tr("有 {n} 个会话在中断时仍在执行，可以接着做。", { n: interrupted.length })}
                  </span>
                </div>
                {interrupted.slice(0, 1).map((c) => (
                  <div key={c.sessionId} className="resume-banner-actions">
                    <button className="btn primary" onClick={() => void resumeInterrupted(c.sessionId)}>
                      {tr("恢复执行")}
                    </button>
                    <button className="btn" onClick={() => void dismissInterrupted(c.sessionId)}>
                      {tr("忽略")}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="composer">
              {/* 运行状态与上下文占用固定在输入区上方同一行：左边「正在思考 / 正在执行…」，
                  右边上下文、用量与自动分配。运行中只在这一格里换文字，不再跨区域跳。 */}
              {(running || context) && (
                <div className="composer-status">
                  <div className="composer-status-left">
                    {running && <RunStatus note={runNote} startedAt={runStart} queued={queuePos > 0} />}
                  </div>
                  {context && (
                    <div
                      className={`ctx-bar ${ctxCapped ? (ctxPct >= 85 ? 'hot' : ctxPct >= 70 ? 'warm' : '') : 'free'}`}
                      title={
                        ctxCapped
                          ? tr("本轮占用 {used}，窗口 {window}", { used: context.used, window: context.window })
                          : tr("本轮占用 {used} tokens（未设上限）", { used: context.used })
                      }
                    >
                      <span className="ctx-label">{tr("上下文")}</span>
                      {ctxCapped && (
                        <span className="ctx-track">
                          <span className="ctx-fill" style={{ width: `${Math.max(2, ctxPct)}%` }} />
                        </span>
                      )}
                      <span className="ctx-num">
                        {ctxCapped ? `${fmtTokens(context.used)} / ${fmtTokens(context.window)}` : fmtTokens(context.used)}
                      </span>
                      {!ctxCapped && <span className="ctx-tag">{tr("自动分配")}</span>}
                      {context.compacted && <span className="ctx-tag">{tr("已压缩早期对话")}</span>}
                    </div>
                  )}
                </div>
              )}
              {slash && slash.items.length > 0 && (
                <div className="mention slash-menu">
                  <div className="mention-head">{tr("斜杠命令 · ↑↓ 选择 · Enter 插入 · Esc 关闭")}</div>
                  {slash.items.map((c, i) => (
                    <button
                      key={c.name}
                      className={`mention-item ${i === slash.index ? 'on' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applySlash(c)}
                      title={c.desc}
                    >
                      <span className="mention-name">/{c.name}</span>
                      <span className="mention-dir">{c.desc}</span>
                      {c.source !== 'builtin' && (
                        <span className="slash-src">{c.source === 'project' ? tr("项目") : tr("用户")}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {mention && mention.items.length > 0 && (
                <div className="mention">
                  <div className="mention-head">{tr("引用工作区文件 · ↑↓ 选择 · Enter 插入 · Esc 关闭")}</div>
                  {mention.items.map((f, i) => (
                    <button
                      key={f.path}
                      className={`mention-item ${i === mention.index ? 'on' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyMention(f)}
                      title={f.path}
                    >
                      <span className="mention-name">{f.name}</span>
                      {f.dir && <span className="mention-dir">{f.dir}</span>}
                    </button>
                  ))}
                </div>
              )}
              {attachments.length > 0 && (
                <div className="attach-list">
                  {attachments.map((a) => (
                    <div className="attach-chip" key={a.id} title={a.path}>
                      <span className={`attach-kind k-${a.kind}`}>{a.kindLabel}</span>
                      <span className="attach-name">{a.name}</span>
                      <span className="attach-size">{sizeText(a.size)}</span>
                      <button
                        className="attach-x"
                        title={tr("移除")}
                        onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {hasImageAttach && !visionReady && (
                <div className="attach-warn">
                  {isLlamaProvider(provider)
                    ? tr('当前是纯文本模式。发送时会自动重启服务加载视觉投影器（约 10 秒），这一轮就能看图；闲置 10 分钟后自动切回。')
                    : <>{tr("当前模型看不了图（")}{activeModelName}{tr("）。只能收到文字说明；看图请换视觉模型。")}</>}
                </div>
              )}
              <div className="composer-inner">
                <textarea
                  ref={textareaRef}
                  rows={1}
                  placeholder={
                    running
                      ? tr("运行中 · 直接说能改方向，会打断正在做的动作")
                      : tr("描述需求 · Enter 发送 · Shift+Enter 换行")
                  }
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value)
                    const el = e.currentTarget
                    el.style.height = 'auto'
                    el.style.height = `${Math.min(el.scrollHeight, 320)}px`
                    const caret = el.selectionStart ?? e.target.value.length
                    syncMention(e.target.value, caret)
                    syncSlash(e.target.value, caret)
                  }}
                  onKeyDown={(e) => {
                    // 拼音/五笔选字时的回车与上下键归输入法，不能拿来发消息或选 @ 补全
                    if (isComposingKey(e)) return
                    if (slash && slash.items.length > 0) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault()
                        setSlash({ ...slash, index: Math.min(slash.items.length - 1, slash.index + 1) })
                        return
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault()
                        setSlash({ ...slash, index: Math.max(0, slash.index - 1) })
                        return
                      }
                      if (e.key === 'Enter' || e.key === 'Tab') {
                        e.preventDefault()
                        applySlash(slash.items[slash.index])
                        return
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setSlash(null)
                        return
                      }
                    }
                    if (mention) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault()
                        setMention({ ...mention, index: Math.min(mention.items.length - 1, mention.index + 1) })
                        return
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault()
                        setMention({ ...mention, index: Math.max(0, mention.index - 1) })
                        return
                      }
                      if (e.key === 'Enter' || e.key === 'Tab') {
                        const file = mention.items[mention.index]
                        if (file) {
                          e.preventDefault()
                          applyMention(file)
                          return
                        }
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setMention(null)
                        return
                      }
                    }
                    if (isPlainEnter(e)) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                />
                {/* 一行装完：左边「添加文件 / 工作区」，右边用量、发送与导出。
                    分两行会让发送键在窄窗口下被挤到另一排，这里用 nowrap 的独立行管住它 */}
                <div className="composer-actions">
                  <button
                    className="foot-pill attach-btn"
                    onClick={pickFiles}
                    disabled={attachBusy}
                    title={tr("添加文件：PDF、图片、文档、表格、代码")}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path
                        d="M8 3.2v9.6M3.2 8h9.6"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      />
                    </svg>
                    {attachBusy ? tr("添加中…") : tr("添加文件")}
                  </button>
                  <button
                    className="foot-pill attach-btn"
                    onClick={captureScreen}
                    disabled={attachBusy}
                    title={tr("截取当前屏幕作为图片附件（需要视觉模型）")}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <rect x="2.2" y="3.6" width="11.6" height="8.4" rx="1.6" stroke="currentColor" strokeWidth="1.2" />
                      <circle cx="8" cy="7.8" r="1.9" stroke="currentColor" strokeWidth="1.2" />
                    </svg>
                    {tr("截屏")}
                  </button>
                  <button
                    className={`foot-pill ws-chip ${config?.workspace ? '' : 'unset'}`}
                    onClick={() => void chooseWorkspace()}
                    title={config?.workspace ?? tr("点击选择工作区目录")}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path
                        d="M1.6 4.3c0-.6.5-1.1 1.1-1.1h3l1.3 1.6h6.3c.6 0 1.1.5 1.1 1.1v5.8c0 .6-.5 1.1-1.1 1.1H2.7c-.6 0-1.1-.5-1.1-1.1V4.3Z"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span className="ws-chip-text">{workspaceLabel}</span>
                  </button>
                  <span className="spacer" />
                  {usage && (usage.prompt > 0 || usage.completion > 0) && (
                    <span
                      className="foot-pill usage-pill"
                      title={
                        usage.costUsd === undefined
                          ? tr("本会话：输入 {in}、输出 {out} tokens（不计花费）", {
                              in: String(usage.prompt),
                              out: String(usage.completion)
                            })
                          : tr("本会话：输入 {in}、输出 {out} tokens，约 {cost}", {
                              in: String(usage.prompt),
                              out: String(usage.completion),
                              cost: fmtCost(usage.costUsd)
                            })
                      }
                    >
                      <span className="foot-label">{tr("用量")}</span>
                      <span className="usage-num">
                        ↑{fmtTokens(usage.prompt)} ↓{fmtTokens(usage.completion)}
                      </span>
                      {usage.costUsd !== undefined && <span className="usage-cost">{fmtCost(usage.costUsd)}</span>}
                    </span>
                  )}
                  {/* 本轮用量：和「本会话累计」分开，调小模型时最常看的是这一轮到底烧了多少、快不快 */}
                  {turnUsage && (
                    <span
                      className="foot-pill turn-pill"
                      title={tr("这一轮：输入 {in}、输出 {out} tokens，其中 {cached} 命中缓存{tps}", {
                        in: String(turnUsage.prompt),
                        out: String(turnUsage.completion),
                        cached: String(turnUsage.cached ?? 0),
                        tps: turnUsage.tps
                          ? turnUsage.approx
                            ? tr("，端到端约 {tps} tokens/秒（含首字延迟与等待，不是纯生成速度）", { tps: turnUsage.tps.toFixed(1) })
                            : tr("，生成 {tps} tokens/秒（引擎实测解码速度）", { tps: turnUsage.tps.toFixed(1) })
                          : ''
                      })}
                    >
                      <span className="foot-label">{tr("本轮")}</span>
                      <span className="usage-num">
                        ↑{fmtTokens(turnUsage.prompt)} ↓{fmtTokens(turnUsage.completion)}
                      </span>
                      {turnUsage.cached ? (
                        <span className="turn-cached" title={tr("命中前缀缓存，这部分没有重新计算")}>
                          ⚡{fmtTokens(turnUsage.cached)}
                        </span>
                      ) : null}
                      {turnUsage.promptN !== undefined && turnUsage.promptN > 0 && turnUsage.prompt > 0 ? (
                        <span
                          className="turn-cached"
                          title={tr("前缀缓存命中率：输入 {prompt} tokens，实际 prefill 仅 {promptN} tokens", {
                            prompt: String(turnUsage.prompt),
                            promptN: String(turnUsage.promptN)
                          })}
                        >
                          ⚡{Math.round((1 - turnUsage.promptN / turnUsage.prompt) * 100)}%
                        </span>
                      ) : null}
                      {turnUsage.tps ? (
                        <span
                          className="turn-tps"
                          title={turnUsage.approx
                            ? tr("端到端估算：含排队、预填充与等待，通常低于纯生成速度")
                            : tr("按推理引擎上报的实际解码耗时计算，不含等待与预填充")}
                        >
                          {turnUsage.approx ? '≈' : ''}{turnUsage.tps.toFixed(0)} t/s
                        </span>
                      ) : null}
                    </span>
                  )}
                  {running ? (
                    <>
                      {/* 运行中还能说话：这句话表示「停一下，改成这样」，不是再排一个任务 */}
                      {input.trim() && (
                        <button
                          className="send-btn"
                          onClick={() => void send()}
                          title={tr("打断正在执行的动作，把这句话插进去重新规划")}
                        >
                          {tr("插话")}</button>
                      )}
                      <button
                        className="stop-btn"
                        onClick={async () => {
                          if (!current) return
                          await window.pico.chat.abort(current.id).catch(() => undefined)
                          // 停下才算「中断」：这时才可能出现 checkpoint，键位从「停止」回到「继续」
                          void refreshInterrupted()
                        }}
                      >
                        {tr("停止")}</button>
                    </>
                  ) : (
                    /* 发送 / 继续合并成一键：有内容就发，没内容但断过就续。
                       「继续」按钮以前只要有历史就出现，正常跑完的会话也亮着，纯占地方 */
                    <button
                      className="send-btn"
                      onClick={() => (hasInput ? void send() : void resumeRun())}
                      disabled={!hasInput && !canResume}
                      title={
                        !hasInput && canResume
                          ? tr("从上次中断的地方接着做（会作为一条「继续」发出去）")
                          : undefined
                      }
                    >
                      {!hasInput && canResume ? tr("继续") : tr("发送")}
                    </button>
                  )}
                  <button
                    className="icon-btn export-btn"
                    onClick={() => void exportCurrent()}
                    title={tr("把这次对话导出成 Markdown")}
                    aria-label={tr("导出对话")}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path
                        d="M8 2.4v7.2m0 0 2.6-2.6M8 9.6 5.4 7M3.2 11.2v1.4c0 .6.5 1 1 1h7.6c.5 0 1-.4 1-1v-1.4"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <OutputPanel
            files={outputs}
            workspace={config?.workspace ?? null}
            sessionId={current?.id ?? null}
            changeCount={changes.length}
            changesKey={changesKey}
            onNotify={notify}
            onReverted={() => {
              if (!current) return
              void window.pico.changes
                .list(current.id)
                .then((list) => setChanges(list))
                .catch(() => undefined)
            }}
          />
        </div>
      </main>

      {showSkills && (
        <SkillsPanel
          onClose={() => setShowSkills(false)}
          onUse={useSkill}
          notify={notify}
        />
      )}

      {showAgents && (
        <AgentPanel
          onClose={() => setShowAgents(false)}
          notify={notify}
          providers={config?.providers ?? []}
          currentWorkspace={config?.workspace ?? null}
          onStartTask={(agent) => {
            // 「开始一个任务」是用户明确开口，这时才建会话
            setShowAgents(false)
            void newSessionWithAgent(agent)
          }}
        />
      )}

      {showAppSettings && config && (
        <AppSettings
          config={config}
          notify={notify}
          onClose={() => setShowAppSettings(false)}
          onOpenAgents={() => {
            // 两层设置弹窗叠在一起会互相挡，先收起软件设置再打开档案面板
            setShowAppSettings(false)
            setShowAgents(true)
          }}
          onSave={async (next) => {
            const saved = await window.pico.config.save(next)
            applyConfig(saved)
            void refreshProbes()
          }}
        />
      )}

      {showSettings && config && (
        <Settings
          config={config}
          probes={probes}
          modelCache={modelCache}
          initialTab={needsSetup ? 'base' : undefined}
          onRefresh={() => void refreshProbes()}
          onConfigChanged={async () => {
            const cfg = await window.pico.config.get()
            applyConfig(cfg)
            void refreshProbes()
          }}
          onClose={() => setShowSettings(false)}
          onSave={async (next) => {
            const prev = configRef.current
            const saved = await window.pico.config.save(next)
            const prevActive = prev?.providers.find((p) => p.id === prev?.activeId)
            const target = saved.providers.find((p) => p.id === saved.activeId)
            // 只改温度 / 提示词这类设置不算切换，不必闪「正在加载模型」
            const activeChanged =
              prev?.activeId !== saved.activeId ||
              prevActive?.model !== target?.model ||
              prevActive?.baseUrl !== target?.baseUrl
            applyConfig(saved)
            // 设置页里换模型/换供应商，同样要把用不到的本地运行时清掉
            const freed = await window.pico.local.release(saved.activeId ?? null).catch(() => null)
            if (freed?.freed.length) notify(tr("已释放显存：{0}", { "0": freed.freed.join('；') }))
            if (saved.activeId) {
              void activateModel(saved.activeId, saved, { showLoading: activeChanged })
            } else {
              // 没有当前模型了：别让上一次切换的加载横幅一直挂着
              modelSwitchSeq.current += 1
              setModelLoading(null)
              void refreshProbes()
            }
          }}
        />
      )}

      {approval && (
        <div className="overlay">
          <div className={`modal approval-modal ${approval.preview ? 'modal-diff' : 'modal-sm'}`}>
            <h2>{approval.quota ? tr("用量到上限了") : tr("需要确认")}</h2>
            {approval.risk && (
              <div className={`approval-risk risk-${approval.risk}`}>
                {RISK_LABEL[approval.risk] ?? approval.risk}
                {approval.reason ? ` · ${approval.reason}` : ''}
              </div>
            )}
            {approval.high && (
              <div className="approval-high">
                <b>{tr("高危操作")}</b>
                <span>
                  {tr("不可撤销；也不会被「之后全允许」或自动模式放行。")}
                </span>
              </div>
            )}
            {!approval.quota && (
              <div style={{ color: 'var(--muted)', fontSize: 'calc(12.5px * var(--fs, 1))' }}>
                {tr("模型请求执行")}<b style={{ color: 'var(--text)' }}>{approval.tool}</b>
              </div>
            )}
            {approval.quota ? (
              // 用量超限不是工具调用：说清是哪条线、用了多少、上限多少，
              // 然后让用户选「再给一点」还是「就停在这」。
              <div className="quota-body">
                <div className="quota-line">
                  {approval.quota.scope === 'day'
                    ? tr("今日累计已用 {used} token，达到上限 {limit}", {
                        used: fmtTokens(approval.quota.used),
                        limit: fmtTokens(approval.quota.limit)
                      })
                    : tr("本次运行已用 {used} token，达到上限 {limit}", {
                        used: fmtTokens(approval.quota.used),
                        limit: fmtTokens(approval.quota.limit)
                      })}
                </div>
                <p className="quota-hint">
                  {tr("继续会超出上限；停下来不会丢失进度，之后发「继续」可从断点接着做。")}
                </p>
              </div>
            ) : approval.preview ? (
              approval.preview.files && approval.preview.files.length > 1 ? (
                <div className="approval-diff">
                  {approval.preview.files.map((f) => (
                    <div className="approval-diff-block" key={f.path}>
                      <div className="approval-diff-head">
                        <span className="approval-diff-path" title={f.path}>
                          {f.path}
                        </span>
                        <span className="approval-diff-stat">
                          {f.added ? <em className="add">+{f.added}</em> : null}
                          {f.removed ? <em className="del">−{f.removed}</em> : null}
                          <em className="kind">
                            {f.kind === 'create' ? tr("新建") : f.kind === 'delete' ? tr("删除") : tr("修改")}
                          </em>
                        </span>
                      </div>
                      <DiffView lines={f.lines} max={160} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="approval-diff">
                  <div className="approval-diff-head">
                    <span className="approval-diff-path" title={approval.preview.path}>
                      {approval.preview.path}
                    </span>
                    <span className="approval-diff-stat">
                      {approval.preview.added ? <em className="add">+{approval.preview.added}</em> : null}
                      {approval.preview.removed ? <em className="del">−{approval.preview.removed}</em> : null}
                      <em className="kind">
                        {approval.preview.kind === 'create'
                          ? tr("新建")
                          : approval.preview.kind === 'delete'
                            ? tr("删除")
                            : tr("修改")}
                      </em>
                    </span>
                  </div>
                  <DiffView lines={approval.preview.lines} max={220} />
                </div>
              )
            ) : (
              <pre className="approval-args">{JSON.stringify(approval.args, null, 2)}</pre>
            )}
            <div className="row approval-actions" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => void respondApproval(false)}>
                {approval.quota ? tr("就停在这里") : tr("拒绝")}
              </button>
              {/* 三个按钮一律中性色：确认框里不摆一个抢眼的蓝色主按钮 */}
              <button className="btn" onClick={() => void respondApproval(true, false)}>
                {approval.quota ? tr("再给一点") : tr("本次允许")}
              </button>
              {approval.quota ? (
                // 配额弹窗里的「之后」是「这一轮别再问」，不是永久授权：
                // 下次运行重新计数，否则一次心软就等于把闸门拆了
                <button className="btn" onClick={() => void respondApproval(true, true)}>
                  {tr("本轮不再询问")}
                </button>
              ) : approval.high ? (
                <>
                  <label className="approval-ack">
                    <input
                      type="checkbox"
                      checked={highAck}
                      onChange={(e) => setHighAck(e.target.checked)}
                    />
                    {tr("我了解该操作不可撤销")}
                  </label>
                  <button
                    className="btn danger"
                    disabled={!highAck}
                    onClick={() => void respondApproval(true, true)}
                  >
                    {tr("始终允许")}
                  </button>
                </>
              ) : (
                <>
                  {/* 「以后都这样」只出现在非高危上：高危那条线不归一次点击管，
                      勾了也不会落盘（主进程会忽略），所以干脆不给这个选项 */}
                  <label className="approval-ack" title={tr("记在这个项目上，以后这个工具都不再问")}>
                    <input
                      type="checkbox"
                      checked={rememberGrant}
                      onChange={(e) => setRememberGrant(e.target.checked)}
                    />
                    {tr("以后都这样")}
                  </label>
                  <button
                    className="btn"
                    onClick={() => void respondApproval(true, true, rememberGrant)}
                  >
                    {rememberGrant ? tr("允许并记住") : tr("之后全允许")}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {question && (
        <div className="overlay">
          <div className="modal modal-sm">
            <h2>{tr("模型想问你")}</h2>
            <div style={{ color: 'var(--text)', fontSize: 'calc(13px * var(--fs, 1))', lineHeight: 1.6, marginBottom: 12 }}>
              {question.question}
            </div>
            {question.options && question.options.length > 0 ? (
              question.multiSelect ? (
                <div className="question-options">
                  {question.options.map((opt) => {
                    const on = questionPicked.has(opt)
                    const toggle = () =>
                      setQuestionPicked((prev) => {
                        const next = new Set(prev)
                        if (next.has(opt)) next.delete(opt)
                        else next.add(opt)
                        return next
                      })
                    return (
                      <label key={opt} className="btn question-option" style={{ cursor: 'pointer' }} onClick={toggle}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={toggle}
                          style={{ marginRight: 8 }}
                        />
                        {opt}
                      </label>
                    )
                  })}
                  <button
                    className="btn primary"
                    style={{ marginTop: 8 }}
                    disabled={questionPicked.size === 0}
                    onClick={() => void respondQuestion([...questionPicked].join('，'))}
                  >
                    {tr("确定（已选 {n} 项）", { n: questionPicked.size })}
                  </button>
                </div>
              ) : (
                <div className="question-options">
                  {question.options.map((opt) => (
                    <button
                      key={opt}
                      className="btn question-option"
                      onClick={() => void respondQuestion(opt)}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )
            ) : null}
            <div className="row" style={{ marginTop: 12 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                value={questionAnswer}
                placeholder={tr("或输入你的回答")}
                onChange={(e) => setQuestionAnswer(e.target.value)}
                onKeyDown={(e) => {
                  if (isPlainEnter(e)) void respondQuestion(questionAnswer)
                }}
              />
              <button
                className="btn primary"
                disabled={!questionAnswer.trim()}
                onClick={() => void respondQuestion(questionAnswer)}
              >
                {tr("发送")}</button>
              <button
                className="btn"
                onClick={() => {
                  window.pico.question.respond(question.id, '')
                  setQuestion(null)
                  setQuestionAnswer('')
                  setQuestionPicked(new Set())
                }}
              >
                {tr("跳过")}</button>
            </div>
          </div>
        </div>
      )}

      {pendingSessionDelete && (
        <div className="overlay" onClick={() => setPendingSessionDelete(null)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <h2>{tr("删除会话")}</h2>
            <div style={{ color: 'var(--muted)', fontSize: 'calc(12.5px * var(--fs, 1))', lineHeight: 1.8 }}>
              {tr("将删除会话")}{' '}
              <b style={{ color: 'var(--text)' }}>{pendingSessionDelete.title}</b>
              。<br />
              {tr("会先移入回收站保留 7 天，可在「设置 → 回收站」恢复。")}<br />
              {tr("磁盘上的项目文件不受影响。")}
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setPendingSessionDelete(null)}>
                {tr("取消")}</button>
              <button className="btn danger" onClick={() => void confirmDeleteSession()}>
                {tr("删除")}</button>
            </div>
          </div>
        </div>
      )}

      {pendingMessageDelete && pendingDeleteCount > 0 && (
        <div className="overlay" onClick={() => setPendingMessageDelete(null)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <h2>{tr("删除这一轮对话")}</h2>
            <div style={{ color: 'var(--dim)', fontSize: 'calc(12.5px * var(--fs, 1))', lineHeight: 1.8 }}>
              {tr("将删除这一轮 {n} 条消息，之后每轮都少带这些。", {
                n: pendingDeleteCount
              })}<br />
              {tr("不可恢复，也不进回收站；项目文件不受影响。")}<br />
              {tr("已压缩的摘要一并作废，下一轮重新压缩。")}
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setPendingMessageDelete(null)}>
                {tr("取消")}</button>
              <button className="btn danger" onClick={() => void confirmDeleteTurn()}>
                {tr("删除")}</button>
            </div>
          </div>
        </div>
      )}

      {pendingWsDelete && (        <div className="overlay" onClick={() => setPendingWsDelete(null)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <h2>{tr("删除工作区")}</h2>
            <div style={{ color: 'var(--muted)', fontSize: 'calc(12.5px * var(--fs, 1))', lineHeight: 1.8 }}>
              {tr("将删除工作区")}{' '}
              <b style={{ color: 'var(--text)' }}>
                {pendingWsDelete.workspace
                  ? shortenPath(pendingWsDelete.workspace)
                  : tr("未指定工作区")}
              </b>{' '}
              {tr("下的")}{pendingWsDelete.count} {tr("个会话。")}<br />
              {tr("只删会话记录，项目文件不受影响。")}{pendingWsDelete.workspace === config?.workspace && (
                <>
                  <br />
                  {tr("该目录将不再作为当前工作区。")}</>
              )}
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setPendingWsDelete(null)}>
                {tr("取消")}</button>
              <button className="btn danger" onClick={() => void confirmDeleteWorkspace()}>
                {tr("删除")}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}

      {/* 自绘标题栏的三个按钮：系统标题栏已经去掉，这三个是唯一的关窗方式。
          它们贴的是「窗口」的右上角，不是顶栏的右上角——右侧成果面板展开时顶栏会变窄，
          按钮如果跟着顶栏走就会往里错位，所以放在这里绝对定位，始终钉在窗口角上。
          注意：必须放在 .app 的最后一个子元素（在 header/output-titlebar 的 drag 区域之后），
          这样它的 no-drag 区域才不会被前面的 drag 区域盖住，否则按钮会点不到。 */}
      <div className="win-btns">
        <button
          className="win-btn"
          onClick={() => window.pico.win.minimize()}
          title={tr("最小化")}
          aria-label={tr("最小化")}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.5 5.5h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
        <button
          className="win-btn"
          onClick={() => window.pico.win.toggleMaximize()}
          title={maximized ? tr("还原窗口") : tr("最大化")}
          aria-label={maximized ? tr("还原窗口") : tr("最大化")}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <rect x="1" y="3" width="5.2" height="5.2" rx="1" stroke="currentColor" strokeWidth="1.1" />
              <path d="M3.4 3V2.2c0-.6.5-1.1 1.1-1.1h3.3c.6 0 1.1.5 1.1 1.1v3.3c0 .6-.5 1.1-1.1 1.1H7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <rect x="1.4" y="1.4" width="7.2" height="7.2" rx="1.1" stroke="currentColor" strokeWidth="1.1" />
            </svg>
          )}
        </button>
        <button
          className="win-btn close"
          onClick={() => window.pico.win.close()}
          title={tr("关闭")}
          aria-label={tr("关闭")}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
