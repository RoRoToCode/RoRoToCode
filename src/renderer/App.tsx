import { t as tr, useLang, toggleLang } from './i18n'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type {
  AgentEvent,
  AgentEventEnvelope,
  AppConfig,
  AppPrefs,
  ApprovalRequest,
  ChatMessage,
  FileAttachment,
  FileChange,
  InterruptedCheckpoint,
  QuestionRequest,
  Session,
  SessionMeta,
  Skill,
  SubAgentTask,
  TodoItem,
  TokenUsage,
  WorkspaceFile
} from '../shared/types'
import { isImagePath, providerSupportsVision } from '../shared/vision'
import { comboMatches, normalizeKeys, type KeyAction } from '../shared/keys'
import { todosFromArgs } from '../shared/todos'
import { turnRangeOf } from '../shared/turns'
import { isLlamaProvider, isLoopbackUrl } from '../shared/providers'
import { Sidebar } from './components/Sidebar'
import { MessageItem, StepGroup } from './components/MessageItem'
import { RunStatus } from './components/RunStatus'
import { PlanCard } from './components/PlanCard'
import { Settings } from './components/Settings'
import { AppSettings } from './components/AppSettings'
import { ModelPicker, StatusDot, type ProbeInfo } from './components/ModelPicker'
import { SkillsPanel } from './components/SkillsPanel'
import { OutputPanel, collectOutputs } from './components/OutputPanel'
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
  /** 本轮开始的时刻与当前在做什么，供输入框上方的「执行中」状态条显示 */
  const [runStart, setRunStart] = useState(0)
  const [runNote, setRunNote] = useState('')
  const [input, setInput] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showAppSettings, setShowAppSettings] = useState(false)
  // 窗口是否最大化：右上角那个按钮的图标要跟着换
  const [maximized, setMaximized] = useState(false)
  const [showSkills, setShowSkills] = useState(false)
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
  useEffect(() => setHighAck(false), [approval?.id])
  /** 正在跑的子任务，按父 agent 的 callId 索引 */
  const [subTasks, setSubTasks] = useState<Record<string, SubAgentTask>>({})
  const [toast, setToast] = useState<{ text: string; kind: 'info' | 'warn' | 'error' } | null>(null)
  /** 上次崩溃/中断未跑完的会话，启动时提示可恢复 */
  const [interrupted, setInterrupted] = useState<InterruptedCheckpoint[]>([])
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
  // 本地模型加载中（切换/首次启动需要时间）
  const [llamaLoading, setLlamaLoading] = useState(false)
  // 探测时顺带拿到的可用模型列表，供设置面板下拉复用（一次读取，两处共享）
  const [modelCache, setModelCache] = useState<Record<string, string[]>>({})
  // 待发送的附件（已复制到工作区 inbox/）
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  // 文件正被拖到窗口上方
  const [dragging, setDragging] = useState(false)
  const [attachBusy, setAttachBusy] = useState(false)
  // 当前执行计划（update_todos 推送；换会话时从历史消息里还原）
  const [todos, setTodos] = useState<TodoItem[]>([])
  /** 引擎上报的上下文占用（token 估算 / 窗口大小） */
  const [context, setContext] = useState<{
    used: number
    window: number
    compacted: boolean
  } | null>(null)
  /** 本会话累计用量；模型在价格表里时才有 costUsd */
  const [usage, setUsage] = useState<TokenUsage | null>(null)
  /** 当前生效的快捷键绑定（可由设置页修改） */
  const [keys, setKeys] = useState<Record<KeyAction, string>>(() => normalizeKeys(null))
  /** 本次会话的文件改动（快照），用于「变更」面板角标 */
  const [changes, setChanges] = useState<FileChange[]>([])
  const [changesKey, setChangesKey] = useState(0)
  /** 输入框里的 @ 引用弹层 */
  const [mention, setMention] = useState<{
    start: number
    end: number
    query: string
    items: WorkspaceFile[]
    index: number
  } | null>(null)

  const currentRef = useRef<string | null>(null)
  const configRef = useRef<AppConfig | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
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
              ? { state: 'ok' }
              : result.loading
                ? { state: 'checking', error: result.error ?? tr("模型加载中…") }
                : { state: 'fail', error: result.error }
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

  /** 技能面板里点「使用」：把指令填进输入框（已有内容就接在后面），并把光标落到末尾 */
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

  const refreshSessions = useCallback(async () => {
    const list = await window.pico.sessions.list()
    setSessions(list)
  }, [])

  const openSession = useCallback(
    async (id: string) => {
      const session = await window.pico.sessions.load(id)
      currentRef.current = id
      setCurrent(session)
      setRunning(false)
      setRunStart(0)
      setRunNote('')
      setApprovals([])
      setTodos(restoreTodos(session.messages))
      setContext(null)
      setUsage(session.usage ?? null)
      setMention(null)
      // 变更记录按会话存放：切会话就把列表换成这个会话的
      const list = await window.pico.changes.list(id).catch(() => [])
      setChanges(list)
      setChangesKey((k) => k + 1)

      // 会话自带工作区：打开时把全局工作区切过去，保证模型在正确目录干活
      const target = session.workspace ?? null
      const cfg = configRef.current
      if (cfg && target && cfg.workspace !== target) {
        const saved = await window.pico.config.save({ ...cfg, workspace: target })
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
      void window.pico.checkpoints
        .interrupted()
        .then((list) => setInterrupted(list ?? []))
        .catch(() => undefined)

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
  }, [applyConfig, openSession, refreshProbes, notify, waitLocalReady])

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case 'attach_reading':
          notify(tr("正在读取附件：{file}…", { file: event.file }))
          break
        case 'attach_no_vision':
          notify(tr("当前模型（{model}）看不了图。在「模型设置 → 模型 API」换成 qwen2.5-vl / llava / gemma3 这类视觉模型，就能直接看图。", { model: event.model }), 'warn')
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
          setRunNote(tr("模型正在回复"))
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
        case 'context':
          setContext({ used: event.used, window: event.window, compacted: event.compacted })
          break
        case 'usage':
          setUsage(event.usage)
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
        case 'error':
          notify(event.message, 'error')
          setRunning(false)
          setRunStart(0)
          break
        case 'done':
          setRunning(false)
          setRunStart(0)
          setApprovals([])
          setQuestion(null)
          setQuestionAnswer('')
          void refreshSessions()
          break
        default:
          break
      }
    },
    [notify, refreshSessions]
  )

  useEffect(() => {
    const off = window.pico.onEvent((payload: AgentEventEnvelope) => {
      const { sessionId, event } = payload
      if (sessionId !== currentRef.current) return
      handleEvent(event)
    })
    return off
  }, [handleEvent])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [current?.messages.length, running])

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
    if ((!text && attachments.length === 0) || !current || running) return
    // 附件以「路径 + 类型 + 大小」的形式带进消息，模型据此去读文件
    const body = attachments.length
      ? tr("{text}{1}【附件】\n{2}", { text: text, "1": text ? '\n\n' : '', "2": attachments
          .map((a) => `- ${a.path}（${a.kindLabel}，${sizeText(a.size)}）`)
          .join('\n') })
      : text
    const userMessage: ChatMessage = {
      id: `local_${Date.now()}`,
      role: 'user',
      content: body,
      createdAt: Date.now()
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
  }, [attachments, config?.workspace, current, input, notify, running])

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

  /** 运行时不给删：正在跑的那一轮拿着的是旧历史，中途改会错位 */
  const deleteTurnHandler = running ? undefined : requestDeleteTurn

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

  const newSession = useCallback(    async (workspace?: string | null) => {
      const cfg = configRef.current
      // 不强制选工作区：undefined 表示沿用当前目录，null 表示明确不绑定目录
      const target = workspace === undefined ? cfg?.workspace ?? null : workspace
      const created = await window.pico.sessions.create(target)

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
    },
    []
  )

  const newWorkspace = useCallback(async () => {
    const dir = await window.pico.workspace.choose()
    if (!dir) return
    await newSession(dir)
  }, [newSession])

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

  const chooseWorkspace = useCallback(async () => {
    const dir = await window.pico.workspace.choose()
    if (!dir) return
    const cfg = configRef.current
    if (cfg) {
      const saved = await window.pico.config.save({ ...cfg, workspace: dir })
      configRef.current = saved
      setConfig(saved)
    }
    // 当前会话跟着换目录，列表里也会移动到对应分组
    if (currentRef.current) {
      await window.pico.sessions.setWorkspace(currentRef.current, dir)
      await refreshSessions()
    }
  }, [refreshSessions])

  const updateActive = useCallback(
    async (activeId: string) => {
      if (!config) return
      const saved = await window.pico.config.save({ ...config, activeId })
      applyConfig(saved)
      // 切换模型时先清掉用不到的本地运行时：8 GB 显存上两个 7B 同时驻留会直接爆
      const freed = await window.pico.local.release(activeId).catch(() => null)
      if (freed?.freed.length) notify(tr("已释放显存：{0}", { "0": freed.freed.join('；') }))
      const target = saved.providers.find((p) => p.id === activeId)
      const isLocalLlama = Boolean(target && isLlamaProvider(target))
      /**
       * 工人模型的预热与「主模型是不是本地」无关：
       * 主模型走远端时，本地那块卡正好由工人模型独占，也要把它拉起来。
       * 是否真的能起、能不能并行，由主进程按显卡绑定判断。
       */
      const warmWorker = () =>
        void window.pico.worker
          .warm(activeId)
          .then((w) => {
            if (w.ok && /已启动/.test(w.message)) notify(tr("工作模型已在后台加载"))
          })
          .catch(() => undefined)
      if (isLocalLlama) {
        // 选中本地 llama.cpp 才启动；启动会立即写好模型配置，服务在后台加载
        setLlamaLoading(true)
        setProbes((prev) => ({ ...prev, [activeId]: { state: 'checking' } }))
        const r = await window.pico.llama.start(target?.model || undefined, undefined, {
          providerId: target!.id
        })
        if (!r.ok) notify(r.message, 'error')
        const cfg = await window.pico.config.get()
        applyConfig(cfg)
        void refreshProbes()
        if (r.ok) {
          // 工人模型在后台起：双卡机器上它占另一张卡，子代理才是真并行
          warmWorker()
          // 模型就绪前保持顶部「加载中」提示，就绪后再放开
          void (async () => {
            await waitLocalReady(target!.id)
            setLlamaLoading(false)
            void refreshProbes()
          })()
        } else {
          setLlamaLoading(false)
        }
        return
      }
      // 非 llama.cpp 的目标：上面的 release 已经按需停掉旧进程与占显存的模型，
      // 但工人模型可能还该在本地跑（主模型在远端时不冲突）
      warmWorker()
      void refreshProbes()
    },
    [applyConfig, config, notify, refreshProbes, waitLocalReady]
  )

  /** 给当前会话单独绑定模型（空串 = 跟随全局） */
  const bindSessionModel = useCallback(
    async (modelId: string) => {
      if (!current) return
      const val = modelId || null
      await window.pico.sessions.setModel(current.id, val)
      setCurrent((prev) => (prev ? { ...prev, modelId: val } : prev))
      void refreshSessions()
      // 绑到本地 llama.cpp provider 时，确保它的服务已启动，
      // 否则下一条消息会撞连接失败、只能靠自动兜底换模型。
      const target = config?.providers.find((p) => p.id === val)
      if (target && isLlamaProvider(target)) {
        const st = await window.pico.llama.status(target.id).catch(() => null)
        if (!st?.running) {
          setLlamaLoading(true)
          setProbes((prev) => ({ ...prev, [target.id]: { state: 'checking' } }))
          const r = await window.pico.llama.start(target.model || undefined, undefined, {
            providerId: target.id
          })
          if (!r.ok) notify(r.message, 'error')
          void (async () => {
            await waitLocalReady(target.id)
            setLlamaLoading(false)
            void refreshProbes()
          })()
        } else {
          void refreshProbes()
        }
      }
    },
    [current, config, notify, refreshProbes, refreshSessions, waitLocalReady]
  )

  const respondApproval = useCallback(
    (approved: boolean, always = false) => {
      if (!approval) return
      // 「之后全允许」只对当前这轮任务生效，由主进程按会话记录
      window.pico.approval.respond(approval.id, approved, always)
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

  const provider = config?.providers.find((p) => p.id === config.activeId) ?? config?.providers[0] ?? null
  const activeProbe = probes[provider?.id ?? ''] ?? { state: 'checking' as const }
  const workspaceLabel = config?.workspace ? shortenPath(config.workspace) : tr("默认 workspace")
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
  // 本次会话写过的文件：直接从工具调用记录里推算，切会话/重开程序都还在
  const outputs = useMemo(() => collectOutputs(current?.messages ?? []), [current])
  // 附件里有图片、而当前模型看不了图时，输入框上方直接提醒，别等模型答非所问
  const hasImageAttach = attachments.some((a) => isImagePath(a.absPath) || a.kind === 'image')
  const visionReady = providerSupportsVision(provider)
  const activeModelName = provider ? provider.model : tr("未选择")
  // 「限制上下文」没开时窗口只是模型的自然上限，不是用户设的天花板：
  // 这时不摆上限、不画进度条，只报这一轮实际用了多少（进度条没有上限就没意义，还容易吓人）
  const ctxCapped = config ? config.contextLimit === true : true
  const ctxPct = context ? Math.min(100, Math.round((context.used / Math.max(1, context.window)) * 100)) : 0

  // 快捷键绑定来自 prefs.json；设置页保存后通过自定义事件即时同步，不用重启
  useEffect(() => {
    void window.pico.app
      .prefs()
      .then((p) => setKeys(normalizeKeys(p.keys)))
      .catch(() => undefined)
    const onPrefs = (e: Event) => {
      const p = (e as CustomEvent<AppPrefs | undefined>).detail
      if (p && p.keys) setKeys(normalizeKeys(p.keys))
    }
    window.addEventListener('roroto:prefs', onPrefs)
    return () => window.removeEventListener('roroto:prefs', onPrefs)
  }, [])

  // 全局快捷键：默认 Ctrl+K 搜索会话、Ctrl+N 新会话、Ctrl+E 导出、Ctrl+, 软件设置，
  // 具体绑定可由用户在「软件设置 → 快捷键」里改，存在 prefs.json
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (comboMatches(e, keys.search)) {
        e.preventDefault()
        document.getElementById('session-search')?.focus()
      } else if (comboMatches(e, keys.newSession)) {
        e.preventDefault()
        void newSession()
      } else if (comboMatches(e, keys.export)) {
        e.preventDefault()
        void exportCurrent()
      } else if (comboMatches(e, keys.settings)) {
        e.preventDefault()
        setShowAppSettings(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keys, newSession, exportCurrent])

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
            <span className="drop-hint-sub">{tr("PDF / 图片 / 文档 / 表格都可以，会复制一份到工作区 inbox/")}</span>
          </div>
        </div>
      )}
      <Sidebar
        sessions={sessions}
        currentId={current?.id ?? null}
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
          {current && config && config.providers.length > 1 && (
            <select
              className="session-model-select"
              value={current.modelId ?? ''}
              onChange={(e) => void bindSessionModel(e.target.value)}
              title={tr("本会话单独用哪个模型（不影响其他会话）")}
            >
              <option value="">{tr("跟随全局")}</option>
              {config.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
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
          {/* 自绘标题栏的三个按钮：系统的标题栏已经去掉，这三个是唯一的关窗方式 */}
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
        </header>

        {noModels && (
          <div className="no-model-bar">
            <span className="no-model-icon">!</span>
            <span className="no-model-text">{tr("请点击模型设置 添加模型")}</span>
            <button className="btn primary sm" onClick={() => setShowSettings(true)}>
              {tr("打开模型设置")}</button>
          </div>
        )}

        {llamaLoading && <div className="llama-loading">{tr("正在加载本地模型，请稍后…")}</div>}

        <PlanCard items={todos} running={running} />

        <div className="messages">
          {!current || current.messages.length === 0 ? (
            <div className="empty">
              {noModels || needsSetup ? (
                <>
                  <h1>
                    {noModels ? tr("请点击模型设置 添加模型") : tr("请点击模型设置 配置核心 与本地模型")}
                  </h1>
                  <div>
                    {noModels
                      ? tr("还没有任何可用模型。可以在「模型设置 → ② 本地模型」跑本地模型，也可以在「③ 模型 API」填一个接口。")
                      : tr("本机还没装好模型。点下面的按钮打开模型设置：先在「① 基础核心」点「简易核心」一键装好，再到「② 本地模型」挑一个模型就能开始。")}
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
              {groupRows(current.messages).map((row) => {
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
                        onDelete={deleteTurnHandler}
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
                          onDelete={deleteTurnHandler}
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
                    onRegenerate={() => void regenerate()}
                    onEdit={(id, text) => void editAndResend(id, text)}
                    onDelete={deleteTurnHandler}
                    subTask={m.toolCallId ? subTasks[m.toolCallId] : undefined}
                  />
                )
              })}
              <div ref={bottomRef} />
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
          {running && <RunStatus note={runNote} startedAt={runStart} />}
          {context && (
            <div
              className={`ctx-bar ${ctxCapped ? (ctxPct >= 85 ? 'hot' : ctxPct >= 70 ? 'warm' : '') : 'free'}`}
              title={
                ctxCapped
                  ? tr("本轮实际占用约 {used} tokens，窗口 {window} tokens", { used: context.used, window: context.window })
                  : tr("本轮实际占用约 {used} tokens（未限制上下文，不设上限）", { used: context.used })
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
              {!ctxCapped && <span className="ctx-tag">{tr("不限制")}</span>}
              {context.compacted && <span className="ctx-tag">{tr("已压缩早期对话")}</span>}
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
              {tr("当前模型看不了图（")}{activeModelName}{tr("）。发出去模型只能收到文字说明；要看图请在「模型设置」里换成视觉模型。")}</div>
          )}
          <div className="composer-inner">
            <textarea
              ref={textareaRef}
              rows={1}
              placeholder={tr("描述你的需求，Enter 发送，Shift+Enter 换行")}
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                const el = e.currentTarget
                el.style.height = 'auto'
                el.style.height = `${Math.min(el.scrollHeight, 320)}px`
                syncMention(e.target.value, el.selectionStart ?? e.target.value.length)
              }}
              onKeyDown={(e) => {
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
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            {running ? (
              <button
                className="stop-btn"
                onClick={() => {
                  if (current) void window.pico.chat.abort(current.id)
                }}
              >
                {tr("停止")}</button>
            ) : (
              <>
                {current && current.messages.length > 0 && (
                  <button
                    className="resume-btn"
                    title={tr("从上次中断的地方接着做（会作为一条「继续」发出去）")}
                    onClick={() => void resumeRun()}
                  >
                    {tr("继续")}</button>
                )}
                <button
                  className="send-btn"
                  onClick={() => void send()}
                  disabled={!input.trim() && attachments.length === 0}
                >
                  {tr("发送")}</button>
              </>
            )}
            <button
              className="icon-btn export-btn"
              onClick={() => void exportCurrent()}
              title={tr("把这次对话导出成 Markdown（Ctrl+E）")}
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
          <div className="composer-foot">
            <button
              className="foot-pill attach-btn"
              onClick={pickFiles}
              disabled={attachBusy}
              title={tr("添加文件：PDF、图片、文档、表格、代码等（也可以直接把文件拖进窗口）")}
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
                    ? tr("本会话累计：输入 {in} tokens，输出 {out} tokens（模型不在价格表里，不估算花费）", {
                        in: String(usage.prompt),
                        out: String(usage.completion)
                      })
                    : tr("本会话累计：输入 {in} tokens，输出 {out} tokens，约 {cost}", {
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
            <span
              className="foot-pill model-pill"
              title={activeProbe.error ? tr("不可用：{error}", { error: activeProbe.error }) : tr("当前使用的模型")}
            >
              <span className="foot-label">{tr("模型选择")}</span>
              <StatusDot state={activeProbe.state} error={activeProbe.error} />
              <span className="model-chip">
                {provider ? tr("{name} · {1}", { name: provider.name, "1": provider.model || tr("未选模型") }) : tr("未配置模型")}
              </span>
            </span>
          </div>
        </div>
      </main>

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

      {showSkills && (
        <SkillsPanel
          onClose={() => setShowSkills(false)}
          onUse={useSkill}
          notify={notify}
        />
      )}

      {showAppSettings && config && (
        <AppSettings
          config={config}
          notify={notify}
          onClose={() => setShowAppSettings(false)}
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
            const saved = await window.pico.config.save(next)
            applyConfig(saved)
            // 设置页里换模型/换供应商，同样要把用不到的本地运行时清掉
            const freed = await window.pico.local.release(saved.activeId ?? null).catch(() => null)
            if (freed?.freed.length) notify(tr("已释放显存：{0}", { "0": freed.freed.join('；') }))
            const target = saved.providers.find((p) => p.id === saved.activeId)
            const isLocalLlama = Boolean(target && isLlamaProvider(target))
            if (isLocalLlama) {
              setLlamaLoading(true)
              setProbes((prev) => ({ ...prev, [target!.id]: { state: 'checking' } }))
              const r = await window.pico.llama.start(target?.model || undefined, undefined, {
                providerId: target!.id
              })
              if (!r.ok) notify(r.message, 'error')
              const cfg = await window.pico.config.get()
              applyConfig(cfg)
              if (r.ok) {
                void window.pico.worker
                  .warm(target!.id)
                  .then((w) => {
                    if (w.ok && /已启动/.test(w.message)) notify(tr("工作模型已在后台加载"))
                  })
                  .catch(() => undefined)
                void (async () => {
                  await waitLocalReady(target!.id)
                  setLlamaLoading(false)
                  void refreshProbes()
                })()
              } else {
                setLlamaLoading(false)
              }
            } else {
              // 目标不是本地模型：release 已经把该停的停掉了，
              // 这里再 stop() 全停会把刚好该留着的工人模型一起杀掉
              void window.pico.worker
                .warm(saved.activeId ?? undefined)
                .then((w) => {
                  if (w.ok && /已启动/.test(w.message)) notify(tr("工作模型已在后台加载"))
                })
                .catch(() => undefined)
            }
            void refreshProbes()
          }}
        />
      )}

      {approval && (
        <div className="overlay">
          <div className={`modal ${approval.preview ? 'modal-diff' : 'modal-sm'}`}>
            <h2>{tr("需要确认")}</h2>
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
                  {tr("该操作不可撤销，也不会被「之后全允许」或自动模式顺带放行，每次都要单独确认。")}
                </span>
              </div>
            )}
            <div style={{ color: '#8b8b95', fontSize: 'calc(12.5px * var(--fs, 1))' }}>
              {tr("模型请求执行")}<b style={{ color: '#e9e9ec' }}>{approval.tool}</b>
            </div>
            {approval.preview ? (
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
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => void respondApproval(false)}>
                {tr("拒绝")}</button>
              <button className="btn" onClick={() => void respondApproval(true, false)}>
                {tr("本次允许")}</button>
              {approval.high ? (
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
                    {tr("始终允许高危操作")}
                  </button>
                </>
              ) : (
                <button className="btn primary" onClick={() => void respondApproval(true, true)}>
                  {tr("之后全允许")}</button>
              )}
            </div>
          </div>
        </div>
      )}

      {question && (
        <div className="overlay">
          <div className="modal modal-sm">
            <h2>{tr("模型想问你")}</h2>
            <div style={{ color: '#e9e9ec', fontSize: 'calc(13px * var(--fs, 1))', lineHeight: 1.6, marginBottom: 12 }}>
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
                  if (e.key === 'Enter') void respondQuestion(questionAnswer)
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
            <div style={{ color: '#8b8b95', fontSize: 'calc(12.5px * var(--fs, 1))', lineHeight: 1.8 }}>
              {tr("将删除会话")}{' '}
              <b style={{ color: '#e9e9ec' }}>{pendingSessionDelete.title}</b>
              。<br />
              {tr("它会先移入回收站并保留 7 天，期间可以在「设置 → 回收站」里恢复。")}<br />
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
              {tr("将删除这一轮共 {n} 条消息（含助手回答与工具输出），后续每轮请求都会少带上它们。", {
                n: pendingDeleteCount
              })}<br />
              {tr("此操作不可恢复，也不会移入回收站；磁盘上的项目文件不受影响。")}<br />
              {tr("已压缩的早期对话摘要会一并作废，下一轮会按剩余历史重新压缩。")}
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
            <div style={{ color: '#8b8b95', fontSize: 'calc(12.5px * var(--fs, 1))', lineHeight: 1.8 }}>
              {tr("将删除工作区")}{' '}
              <b style={{ color: '#e9e9ec' }}>
                {pendingWsDelete.workspace
                  ? shortenPath(pendingWsDelete.workspace)
                  : tr("未指定工作区")}
              </b>{' '}
              {tr("下的")}{pendingWsDelete.count} {tr("个会话。")}<br />
              {tr("只删除左侧列表里的会话记录，磁盘上的项目文件不受影响。")}{pendingWsDelete.workspace === config?.workspace && (
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
    </div>
  )
}
