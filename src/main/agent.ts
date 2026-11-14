import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  AgentEvent,
  ApprovalMode,
  ApprovalRequest,
  AppConfig,
  ChatMessage,
  FileChange,
  ProviderConfig,
  QuestionRequest,
  RunningRun,
  SendAttachment,
  Session,
  SubAgentTask,
  TodoItem,
  TokenUsage,
  ToolCall
} from '../shared/types'
import { getAgent, listAgents } from './agents'
import { combineSignals, type CombinedSignal } from '../shared/abort'
import { dropOldestTurns } from '../shared/turns'
import { agentBrief, handoffTargets } from '../shared/roster'
import { checkQuota, parseLimit, quotaAutoStopNote, quotaStopNote, quotaText, type QuotaHit } from '../shared/quota'
import { bumpDayUsage, dayUsage } from './quota'
import { enqueueHandoff } from './handoff'
import {
  defaultWorkspaceDir,
  effectiveWorkspace,
  loadConfig,
  resolveProvider,
  saveConfig
} from './config'
import * as store from './store'
import { chat, effectiveContextWindow } from './providers'
import type { StreamResult } from './providers/base'
import { classifyRisk, classifyMcpRisk, executeTool, previewWrite, previewPatch, patchTargets, summarize, toolTargetPath, type RiskInfo } from './tools'
import { decideApproval } from './approval'
import { TOOLBOX_SPEC, toolSpecs, type ToolSpec } from './tools/spec'
import { settleToolArgs } from '../shared/toolargs'
import { createLoopGuard } from '../shared/degenerate'
import { createToolCallGuard } from '../shared/toolguard'
import { extractAttachment, renderAttachmentBody } from './extract'
import { isImagePath, providerSupportsVision } from '../shared/vision'
import { isLlamaProvider } from '../shared/providers'
import { setLlamaVision, llamaVisionLoaded } from './llama'
import { formatTodos, normalizeTodos } from '../shared/todos'
import { memoryForPrompt } from './memory'
import { boardForPrompt } from './board'
import { diagnoseReport } from './lsp'
import { formatFiles } from './format'
import { formatDiagGap, formatDiagnostics } from '../shared/diagnostics'
import { grantKey, grantTool, loadGrantSet } from './grants'
import { scratchForPrompt } from './scratch'
import { runHooks } from './hooks'
import { findInstructions, instructionsBlock, type InstructionsResult } from './instructions'
import { loadProjectPermissions } from './permissions'
import { detectVerifyPlan, runVerify } from './verify'
import { asCalls, balancedEnd, parseTextToolCalls, type RawCall } from './parse'
import { runSubAgent } from './subagent'
import { recordChange } from './changes'
import { diffLines, diffStats } from './diff'
import { callMcpTool, isMcpTool, mcpToolSpecs } from './mcp'
import { coreFallbackProvider, ensureCoreReady, CORE_PROVIDER_ID } from './core'
import { enabledSkills } from './skills'
import { snapshotResults, diffResults, mayProduceFiles } from './artifacts'
import { workerPlan } from './worker'
import { estimateCost } from '../shared/pricing'
import { MAX_CONCURRENT_RUNS, priorityOf, RunQueue } from '../shared/runqueue'
import { saveCheckpoint, clearCheckpoint, loadCheckpoint, checkpointBrief, type Checkpoint } from './checkpoint'

type Emit = (sessionId: string, event: AgentEvent) => void

/**
 * 非交互运行选项（无头 /chat 用）。GUI 不传，行为完全不变。
 *
 * 非交互模式下没有窗口可弹，审批和提问都必须有确定性的兜底：
 * - approvalPolicy: 'deny'（默认，保守）—— 需要确认的操作一律拒绝并回传；
 *   'allow' —— 放行普通写/命令，但高危（删除/越界/网络/外部 MCP）永不自动放行。
 * - question 直接跳过，返回空答案，模型拿「未回答」继续或结束。
 */
export interface RunOptions {
  /** 非交互运行：不弹审批/提问，走确定性决策 */
  nonInteractive?: boolean
  /** 非交互下遇到需要审批的操作怎么处理（默认 deny）；高危不受此开关影响 */
  approvalPolicy?: 'deny' | 'allow'
  /**
   * 指定这次运行的工作区。
   * 定时任务用的档案可能钉死在一个仓库上，不能跟着界面当前选的工作区跑。
   */
  workspace?: string | null
  /** 这次运行因何而起。只用于观测（「谁在干活」列表里显示），不影响执行逻辑 */
  reason?: RunningRun['kind']
}

/**
 * 判断一次失败值不值得换下一个供应商。
 * 400 / 413 / 422 是这次请求本身有问题（上下文超长、参数不合法），换谁都会一样失败；
 * 其余 401 / 402 / 403 / 404 / 429 / 5xx 和网络错误都可以试下一家。
 */
export function switchReason(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (!msg || /已取消/.test(msg)) return null
  const status = msg.match(/\bHTTP\s+(\d{3})\b/)
  if (status) {
    const code = Number(status[1])
    if (code === 400 || code === 413 || code === 422) return null
    return `HTTP ${code}`
  }
  if (/连接失败|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|请求超时|network|socket/i.test(msg)) {
    return '连接失败'
  }
  return null
}

/** 同家重试：2 次，退避 1.2s / 2.4s。够躲过一次 5xx 抖动，又不至于让用户干等 */
const RETRY_TIMES = 2
const RETRY_BASE_MS = 1200

/**
 * 视觉模式闲置多久后自动切回纯文本（毫秒）。
 *
 * 挂上投影器时文本解码只有原来的 1/3～1/4，而发完图之后可能十几分钟都在改代码。
 * 10 分钟是个折中：连着发几张图不会来回重启，长时间不用又能把速度还回来。
 */
const VISION_IDLE_MS = 10 * 60 * 1000

/**
 * 值不值得在原地再试一次（而不是换下一家）。
 *
 * 只认「过一会儿可能会好」的故障：429 限流、408 超时、5xx、网络断。
 * 401/402/403/404 和 400 类参数错误重试没有意义，只会白等十几秒。
 */
export function retryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (!msg || /已取消/.test(msg)) return false
  const status = msg.match(/\bHTTP\s+(\d{3})\b/)
  if (status) {
    const code = Number(status[1])
    return code === 408 || code === 429 || code >= 500
  }
  return /连接失败|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|请求超时|socket hang up|network/i.test(msg)
}

/** 可被 abort 打断的等待：用户点停止时不该还在这儿睡 2 秒 */
function waitAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 本地 llama.cpp 的「正在加载」不是故障。
 *
 * llama-server 加载模型时会返回 503 `Loading model`；进程刚重启时干脆连不上
 * （fetch failed）。以前这两种都被当成"这家不可用"，2 次短重试（1.2s / 2.4s）
 * 根本跨不过几十秒的加载窗口，于是自动切到核心模型 —— 用户看到的是
 * 「刚启动的 9B 没用上，莫名其妙变成 Core.gguf」。
 */
function httpStatusOf(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  const m = msg.match(/\bHTTP\s+(\d{3})\b/)
  return m ? Number(m[1]) : null
}

function isConnFail(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return /连接失败|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(msg)
}

/** 「模型在加载 / 服务在重启」：值得等一会儿，而不是立刻换模型 */
function isWarmingUp(err: unknown): boolean {
  return httpStatusOf(err) === 503 || isConnFail(err)
}

/**
 * 等本地模型真的能应答。
 *
 * 轮询 `/health`：503 = 还在加载，连不上 = 进程刚起（或崩了）。
 * 连续 20 秒都连不上就认为进程没起来，早点放手去走兜底，别让用户干等 3 分钟。
 */
async function waitLocalServing(
  provider: ProviderConfig,
  signal: AbortSignal,
  onHint: (message: string) => void,
  maxMs = 180_000
): Promise<boolean> {
  const root = (provider.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/i, '')
  if (!root) return false
  const started = Date.now()
  let refusedSince: number | null = null
  let lastHint = 0
  onHint(`「${provider.model || provider.name}」正在加载，等它就绪后再发这一条…`)
  while (Date.now() - started < maxMs) {
    if (signal.aborted) return false
    try {
      const r = await fetch(`${root}/health`, { signal: AbortSignal.timeout(3000) })
      refusedSince = null
      if (r.ok) {
        const body = (await r.json().catch(() => null)) as { status?: string } | null
        // llama.cpp: {"status":"ok"}；Ollama 风格没有 status 字段，200 就算就绪
        if (!body || body.status === undefined || body.status === 'ok') return true
      }
    } catch {
      // 端口还没 Listen：先记个起点，连续太久就当作进程没起来
      if (refusedSince === null) refusedSince = Date.now()
      else if (Date.now() - refusedSince > 20_000) return false
    }
    const waited = Date.now() - started
    if (waited - lastHint > 10_000) {
      lastHint = waited
      onHint(`模型还在加载（已等 ${Math.round(waited / 1000)} 秒）…`)
    }
    await waitAbortable(1500, signal)
  }
  return false
}

/** 派子 agent 时用到的一组运行参数，避免在每处都传一长串 */
interface SubCtx {
  session: Session
  sessionId: string
  config: AppConfig
  provider: ProviderConfig
  workspace: string
  tools: ToolSpec[]
  budget: number
  web: boolean
  signal: AbortSignal
  /** 项目级规则（AGENTS.md）注入给子 agent，避免子 agent 违反项目约定 */
  instructions?: string | null
  /** 非交互运行（无头）：子 agent 的审批也要走确定性决策，不能弹框 */
  nonInteractive?: boolean
  approvalPolicy?: 'deny' | 'allow'
  /** 本次生效的审批模式；不传则回落到 config.approvalMode */
  mode?: ApprovalMode
}

/** 子 agent 的结论要怎么回灌给主 agent：先给一行统计，再给它的总结 */
function formatTaskResult(t: SubAgentTask): string {
  const secs = ((t.endedAt ?? Date.now()) - t.startedAt) / 1000
  const head = `子任务「${t.description}」${t.status === 'ok' ? '已完成' : '失败'}（${t.steps} 步 · ${t.tools.length} 次工具调用 · ${secs.toFixed(1)}s）`
  if (t.status === 'fail') {
    return `${head}\n失败原因：${t.error ?? '未知'}\n\n${t.summary}`
  }
  return `${head}\n\n${t.summary}`
}

/** 写文件类工具才需要记快照 */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'patch'])

/**
 * 计划模式追加到系统提示的约束。
 *
 * 说清「为什么被拒」比只说「不允许」有用：模型知道自己处在只读阶段，
 * 就不会反复试 write_file 然后被拒，而是老实读完代码、给出方案。
 */
const PLAN_MODE_NOTE = [
  '【计划模式】现在只能读、不能改。',
  '1) 先用 repo_map / grep / read_file 把相关代码看清楚，不要凭猜测写方案；',
  '2) 然后用 write_plan 输出方案：改哪些文件、每个文件改什么、跑什么命令验证；',
  '3) 写完 write_plan 立刻停下，等用户点「批准执行」，不要尝试 write_file / edit_file / run_shell —— 它们会被直接拒绝。'
].join('\n')

/**
 * 会话级模式优先于全局审批档。
 *
 * 这样「批准计划」只放开当前会话，不会把全局从只读改成自动：
 * 用户批准的是这一个任务，不是以后所有任务。
 */
export function modeOf(
  config: Pick<AppConfig, 'approvalMode'>,
  session: { modeOverride?: 'plan' | 'build' | null } | null | undefined
): ApprovalMode {
  const override = session?.modeOverride ?? null
  if (override === 'plan') return 'plan'
  if (override === 'build') {
    // 全局还是只读/计划时，批准过的会话按「询问」走：能动手，但每步仍可被拦
    return config.approvalMode === 'readonly' || config.approvalMode === 'plan' ? 'ask' : config.approvalMode
  }
  return config.approvalMode
}

/**
 * 因插话没执行的工具，补一条说明。
 * 措辞要说清「不是工具坏了」，否则模型下一轮会按原样重试一遍，白烧一次。
 */
const STEER_SKIP_NOTE = '因用户插入了新的指令，这个调用没有执行。请按新指令重新决定下一步，不要照原样重试。'

/** 工具被插话打断时的结果文案（和「跑失败了」区分开：这不是错误） */
const STEER_CUT_NOTE = '被用户的新消息打断，这一步没做完（环境没坏，不用重试；按新消息说的来）。'

/** 因为整轮被护栏叫停而没轮到的工具：别让模型以为是自己参数写坏了 */
const REPEAT_SKIP_NOTE =
  '这一轮因为多次重复同一个动作已经被叫停，这个调用没有执行。要接着做，请换个明确不同的下一步，别照原样重发。'

async function readTextOrNull(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, 'utf8')
  } catch {
    return null
  }
}

/**
 * 小模型只给这几个工具：工具定义本身也占上下文，11 个全塞进去会把 1.5B 压垮，
 * 它反而一个都不调。计划、记忆这类「锦上添花」的工具先不给。
 */
const LITE_TOOLS = new Set([
  'list_dir',
  'read_file',
  'grep',
  'write_file',
  'edit_file',
  'patch',
  'run_shell',
  'shell_bg',
  'web_search',
  'web_fetch',
  'handoff'
])

/**
 * 上下文紧张时的「直接下发」白名单。
 *
 * 全量 25 个工具 ≈ 4900 tokens（见 tests/toolargs 里的实测值），16K 窗口的本地模型
 * 光工具表就占三成。这里留下开工必须的读写/搜索/执行/计划，加上联网、提问、派活、
 * 多文件补丁和仓库地图 —— 其余（git / terminal / board / handoff / 格式化 / LSP 跳转）
 * 通过 toolbox 网关按需调用，一次只多花一条调用的 token，而不是每轮都付。
 *
 * 注意：这个集合**不能随对话变化**。工具表一变，前缀缓存立刻失效，
 * 省下的几千 token 会以「整段重新 prefill」的形式还回去。
 */
const LEAN_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'glob',
  'grep',
  'run_shell',
  'update_todos',
  'patch',
  'web_search',
  'web_fetch',
  'remember',
  'question',
  'task',
  'repo_map',
  // 技能只在用户打开开关后才存在；一旦存在就别塞进网关 ——
  // 提示里正让模型「用 use_skill 取步骤」，藏起来它就得先猜一层网关
  'use_skill'
])

/** 低于这个窗口就别全量下发工具了：16K / 24K 的本地模型扛不住 */
const LEAN_CTX = 24 * 1024

/**
 * 挑本轮要下发的工具。
 *
 * `ctx` 是服务端真实可用的窗口（/props 或 num_ctx），不是配置里那个数字：
 * 配置写 32K、Ollama 实际只给 8K 的机器上，按配置判断会错判成「不需要精简」。
 */
export function pickTools(full: ToolSpec[], ctx: number): { list: ToolSpec[]; hidden: ToolSpec[] } {
  if (ctx >= LEAN_CTX) return { list: full, hidden: [] }
  const hidden = full.filter((t) => !LEAN_TOOLS.has(t.name) && !isMcpTool(t.name))
  if (!hidden.length) return { list: full, hidden: [] }
  const list = full.filter((t) => LEAN_TOOLS.has(t.name) || isMcpTool(t.name))
  return { list: [...list, TOOLBOX_SPEC], hidden }
}

/**
 * 把 toolbox 调用展开成真工具。
 *
 * 展开放在「风险评估 / 审批 / 钩子 / 写前快照」之前：网关只负责省下提示里的版面，
 * 模型通过它调 git 照样会走 git 的审批和越界检查，不存在绕过检查的路径。
 * 返回 null 表示这不是一次可展开的调用（比如只是要工具清单），交给 executeTool 处理。
 */
export function unwrapToolbox(call: ToolCall, universe: ToolSpec[]): ToolCall | null {
  if (call.name !== TOOLBOX_SPEC.name) return null
  const want = typeof call.args?.tool === 'string' ? call.args.tool.trim() : ''
  if (!want) return null
  const hit = universe.find((t) => t.name === want)
  if (!hit) return null
  const inner = call.args?.args
  const args =
    inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Record<string, unknown>) : {}
  return { ...call, name: hit.name, args }
}

function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 3.5)
}

export function messagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => {
    const calls = m.toolCalls ? JSON.stringify(m.toolCalls).length : 0
    return sum + estimateTokens(m.content) + Math.ceil(calls / 3.5) + 8
  }, 0)
}

/** 工具定义（名字 + 说明 + JSON Schema）也要算进请求体，本地小窗口模型上这笔开销不小 */
function toolSpecsTokens(tools: ToolSpec[]): number {
  return tools.reduce(
    (n, t) =>
      n +
      estimateTokens(t.name) +
      estimateTokens(t.description || '') +
      Math.ceil(JSON.stringify(t.parameters ?? {}).length / 3.5) +
      12,
    0
  )
}

/**
 * 服务端「上下文放不下」这一类报错的统一识别。
 * llama.cpp 是 `request (16566 tokens) exceeds the available context size (16384 tokens)`，
 * OpenAI 是 `maximum context length`，别的网关还有 `context_length_exceeded`、`prompt is too long`。
 */
function isContextOverflow(msg: string): boolean {
  return /exceeds the available context|context_length_exceeded|maximum context length|context size|prompt is too long|too many tokens|reduce the length/i.test(
    msg
  )
}

/** 从报错里抠出服务端真实可用的窗口大小（抠不到返回 0） */
function contextLimitOf(msg: string): number {
  const patterns = [
    /exceeds the available context size\s*\(?\s*(\d+)/i,
    /context size\s*\(?\s*(\d+)\s*tokens/i,
    /(?:maximum|max)\s+context\s*(?:length|size)\D{0,24}(\d{3,})/i,
    // Anthropic：`prompt is too long: 210000 tokens > 200000 maximum`
    /\d{3,}\s*tokens?\s*>\s*(\d{3,})/i,
    /available\D{0,16}(\d{3,})\s*tokens/i
  ]
  for (const re of patterns) {
    const m = msg.match(re)
    if (!m) continue
    const n = Math.round(Number(m[1]))
    if (Number.isFinite(n) && n >= 512) return n
  }
  return 0
}

/** 附件正文标记，和 extract.ts 里的一致 */
const ATTACH_BODY_MARK = '----- 以下正文由程序自动'

/** 从模型名里读参数量（1.5b / 7b / 30b-a3b），读不到返回 null */
function modelSizeB(model: string): number | null {
  const m = (model || '').toLowerCase().match(/(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 3B 以下的小模型扛不住长提示：实测同一个 1.5B 模型，系统提示 360 字时会老实输出工具调用，
 * 一到 500 字以上就开始复读「好的，我正在搜索，请稍后」。所以小模型单独走一版精简提示。
 */
function isSmallModel(model: string): boolean {
  const size = modelSizeB(model)
  return size !== null && size <= 3
}

/**
 * 子代理该用哪个模型 —— 见 `worker.ts` 的 `workerPlan()`。
 *
 * 这里以前只挑 `role='worker'` 的那一条，结果就是「配置里写了」被当成「能用」：
 * 同一块卡上两个模型、或者工人实例压根没启动，都会让子代理白跑一趟。
 * 现在改由 worker.ts 判断能不能真并行，并给出回落原因。
 */

/** 精简提示：小模型专用，控制在 400 字以内，只留最关键的几条 */
function litePrompt(
  workspace: string | null,
  opts: {
    web?: boolean
    remember?: boolean
    instructions?: InstructionsResult | null
    summary?: string | null
    verify?: string | null
    /** 诊断收口：收工前编译诊断仍报错，带上错误让它继续修 */
    diag?: string | null
    nudge?: string | null
    cont?: string | null
    /** 档案的岗位说明：小模型只取开头一段，避免把精简提示撑回去 */
    persona?: string | null
    /** 可交接的档案名：小模型只认名字，不给岗位说明，省字数 */
    handoffTo?: string[]
    /** sessionStart 钩子给的补充上下文 */
    hook?: string | null
  }
): string {
  const ws = workspace || '（未选择工作区）'
  const instructions = opts.instructions ? instructionsBlock(opts.instructions) : ''
  return [
    '你是 RoRoTo Code，Windows 上的编程助手，用中文回答。回答要具体，不要客套。',
    `当前工作区：${ws}`,
    ...(opts.persona ? [`你的角色：${opts.persona.replace(/\s+/g, ' ').slice(0, 240)}`] : []),
    '规则：',
    opts.web === false
      ? '1. 联网已关闭，无法搜索网页；需要最新资料时直接说明。'
      : '1. 问「有没有 / 推荐哪些 / 最新版本」这类外部事实（含 GitHub 项目、仓库名、网址）时，先调 web_search 核实再回答。不要只说「我正在搜索」，必须真的调用工具。',
    '2. 只写工具查到或用户给过的名字和网址；没查到就直说不确定，绝不凭记忆编项目名、仓库名或链接。也不要说「请稍等」。',
    '3. 改代码前用 list_dir / grep / read_file 看清现状，修改用 edit_file。文件读不全时分段读（offset/limit）或 grep，不要写临时脚本去打印文件。',
    '4. 要改的代码必须写进文件（edit_file / write_file），不要把整段代码贴在回复里；确认不需要了的一次性脚本要删掉，别留在用户目录。',
    '5. 需要命令时用 run_shell；工具报错先读错误再换方案。',
    '6. 用户消息里的附件正文直接使用，不要让用户再粘贴。',
    ...(opts.remember === false ? [] : ['7. 值得下次知道的事实用 remember 记一条。']),
    ...(opts.handoffTo?.length
      ? [`可以交接给：${opts.handoffTo.join('、')}（用 handoff 工具，交出去就不要等它）`]
      : []),
    ...(instructions ? ['', instructions] : []),
    '如果无法原生调用工具，就输出一行 JSON：{"name":"web_search","args":{"query":"关键词"}}',
    '程序会执行并把结果回传给你。',
    ...(opts.summary ? ['', '【更早对话的摘要】', opts.summary] : [])
  ].join('\n')
}

/** 模型只在嘴上说「正在搜索 / 请稍后 / 我找到了一些」，其实一个工具都没调 */
const CLAIM_PATTERNS = [
  /正在(搜索|查询|查找|获取|读取|打开|处理|整理)/,
  /请稍(等|候)/,
  /稍后(再|给|告|回|为)/,
  /我(已经|已|先)?(找到|搜索到|查到|完成|整理)了/,
  /马上(就)?(给|为|搜|查)/
]

function claimsAction(text: string): boolean {
  const t = (text || '').trim()
  if (!t || t.length > 200) return false
  return CLAIM_PATTERNS.some((re) => re.test(t))
}

/**
 * 模型把话放这儿了、活却没干：说完「接下来 / 下一步 / 现在开始」就结束这一轮。
 * 和 claimsAction 的区别是它允许更长的正文 —— 常见形态是先总结一下再承诺下一步。
 */
const NEXT_STEP_PATTERNS = [
  /接下来(我)?(会|将|要|开始|去|做|实现|继续)/,
  /下一步(我)?(会|将|要|是|开始|去|做)/,
  /下面(我)?(将|会|来|开始|去)/,
  /然后(我)?(会|将|再|开始|去)/,
  /现在(我)?(开始|去|就)(做|写|实现|改|创建|执行)/,
  /(稍后|随后|接着)(我)?(会|再|继续|开始)/,
  /我会(继续|接着|开始|去)/
]

function promisesNextStep(text: string): boolean {
  const t = (text || '').trim()
  if (!t || t.length > 800) return false
  return NEXT_STEP_PATTERNS.some((re) => re.test(t))
}

/**
 * 小模型的上下文很宝贵：一次 web_fetch 抓 16000 字就能把 1.5B 的窗口塞满，
 * 它会直接吐出空回复。这里把抓取量和搜索条数压小，保证还留得住对话。
 */
function shrinkArgsForSmall(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'web_fetch') {
    const n = Number(args.max_chars)
    return { ...args, max_chars: Math.min(Number.isFinite(n) && n > 0 ? n : 3000, 3000) }
  }
  if (name === 'web_search') {
    const n = Number(args.count)
    return { ...args, count: Math.min(Number.isFinite(n) && n > 0 ? n : 5, 5) }
  }
  return args
}

function compact(messages: ChatMessage[], budget: number): ChatMessage[] {
  if (messagesTokens(messages) <= budget) return messages
  const last = messages.length - 1
  const trimmed = messages.map((m, idx) => {
    if (m.role === 'tool' && m.content.length > 1200) {
      return { ...m, content: `${m.content.slice(0, 1200)}\n…（历史工具输出已压缩）` }
    }
    // 早期轮次里的附件正文最占地方：留个开头，细节让模型按需重读
    if (m.role === 'user' && idx < last && m.images?.length) {
      return { ...m, images: undefined }
    }
    if (m.role === 'user' && idx < last && m.content.length > 2400) {
      const at = m.content.indexOf(ATTACH_BODY_MARK)
      if (at > 0) {
        return {
          ...m,
          content: `${m.content.slice(0, at + 800).trimEnd()}\n…（附件正文已压缩，需要细节时重新读取文件）`
        }
      }
    }
    return m
  })
  /**
   * 裁掉最早的一段时，必须按「轮」切，不能按条切 —— 具体规则和原因见
   * shared/turns.ts 的 dropOldestTurns（丢掉半条 tool 结果会让之后每次请求都 400）。
   */
  return dropOldestTurns(trimmed, (next) => messagesTokens(next) > budget)
}

/** 折叠标记：带这个尾巴的说明已经被折叠过，不要重复处理 */
const MASK_MARK = '（较早的工具输出已折叠'

/**
 * 较早的工具输出折叠掉，只留开头一段。
 *
 * 这一步和 compact() 的分工：compact 是「装不下时硬砍」，会连着早期对话一起丢；
 * 这里只动工具输出 —— read_file / grep 那种一整屏的正文，后面几轮基本不再需要原文，
 * 留个开头足够让模型想起「我查过这个」，真要细节它会重新调用。
 *
 * 关键约束：**只在总量超过 75% 时才做一次**。历史里每改一个字节，前缀缓存就从那里断掉，
 * 如果每一轮都按「距现在第几轮」来折叠，等于每轮都把整个历史重算一遍，反而更慢。
 * 所以做成「超阈值时一次性折一大批，然后很久不再动」的阶梯式行为。
 */
export function maskObservations(list: ChatMessage[], cap: number): ChatMessage[] {
  if (cap <= 0 || messagesTokens(list) <= cap * 0.75) return list
  // 最近一轮的原文必须留着（模型正在用它推理），倒数第二条也留着，避免刚查完就看不见
  let lastUser = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'user') {
      lastUser = i
      break
    }
  }
  const guard = Math.max(0, Math.min(lastUser < 0 ? list.length : lastUser, list.length - 2))
  let changed = false
  const out = list.map((m, i) => {
    if (i >= guard || m.role !== 'tool') return m
    if (m.content.length <= 900 || m.content.includes(MASK_MARK)) return m
    changed = true
    const head = m.content.slice(0, 600).trimEnd()
    return {
      ...m,
      content: `${head}\n${MASK_MARK}：原输出 ${m.content.length} 字符，需要细节请重新调用 ${m.toolName ?? '该工具'}）`
    }
  })
  return changed ? out : list
}

/** 把当前时间写进提示，避免模型为了「今天几号」去跑命令 */
function nowText(): string {
  const d = new Date()
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${week} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function systemPrompt(
  workspace: string | null,
  provider: ProviderConfig,
  opts: {
    memory?: string | null
    instructions?: InstructionsResult | null
    summary?: string | null
    verify?: string | null
    /** 诊断收口：收工前编译诊断仍报错，这里带上错误让它继续修 */
    diag?: string | null
    /** 联网 / 记忆开关，关掉后提示里不再教它用这些工具 */
    web?: boolean
    remember?: boolean
    /** 上一轮「只说不做」的原文，用来逼它真的调工具 */
    nudge?: string | null
    /** 自动续跑：上一轮为什么没算完，逼它接着做 */
    cont?: string | null
    /** 档案的岗位说明 */
    persona?: string | null
    /** 共享黑板上「已拼好的那几行」；空串表示这页还是空的，不占提示 */
    board?: string | null
    /** 本次会话的临时便签；空串表示还没写，不占提示 */
    scratch?: string | null
    /** 可交接的档案：有值才在提示里教它用 handoff，否则这个工具它根本用不上 */
    handoffTo?: Array<{ name: string; role: string }>
    /**
     * 打开了自动调用开关的技能。
     * 只给名称和一句话说明 —— 正文等它真要用时用 use_skill 现取，
     * 否则装了十个技能就等于每轮多喂几万字。
     */
    skills?: Array<{ name: string; desc: string }>
    /** sessionStart 钩子给的补充上下文（当前分支、环境差异、上次失败原因等） */
    hook?: string | null
    /** 本轮是否用 toolbox 网关收起了部分工具：提示里要教它怎么用 */
    toolbox?: boolean
  } = {}
): string {
  const ws = workspace || '（未选择工作区）'
  const webOn = opts.web !== false
  const rememberOn = opts.remember !== false
  const instructions = opts.instructions ? instructionsBlock(opts.instructions) : ''

  const rules = [
    '闲聊、常识、日期时间这类问题直接用文字回答：本轮末尾的环境信息里已经给了当前时间，不要为了「今天几号／星期几」去执行命令。',
    '改代码前先看清现状：用 list_dir / glob / grep / read_file 获取真实内容，绝不凭空假设文件存在或内容如何。',
    '修改用 edit_file 做精确替换，保持最小改动；只有新建文件或整体重写才用 write_file。',
    '需要验证时用 run_shell。默认 shell 是 cmd.exe，需要 unix 命令时把 shell 参数设为 bash。改完代码程序会自动跑测试或构建，你只要按结果继续修。',
    '工具返回错误时先读错误信息再换方案，不要重复同一次失败调用。',
    '不要一次读取大量无关文件，按需逐步获取。',
    '读文件被截断时用 offset/limit 分段读、用 grep 定位关键词；不要为了看内容写 .py / .sh 临时脚本。',
    '改代码必须落到文件里：新建用 write_file、改动用 edit_file，不要把整段代码贴在回复里当交付。',
    '一次性调试脚本不要留在用户目录：确需运行时写到系统临时目录，用完删掉；交付目录里只留最终成果文件。',
    '任务完成后用一两句话说明改了什么，不要长篇总结。',
    '一次任务要一直做到完：计划里还有没勾掉的项、或还有文件 / 命令没处理时，不要收工，也不要只说「接下来我会…」就结束。全部做完再给结论。',
    '有附件正文时，先通读再回答；不要只凭文件名猜内容。'
  ]
  rules.push(
    webOn
      ? '需要外部事实（开源项目与仓库名、链接、版本、不熟的库、报错含义、官方文档）时先 web_search，再用 web_fetch 读最相关的一两个页面；引用结论要给出网址。不许凭记忆编造仓库名、项目名或链接——没查到就直说「不确定」。'
      : '联网已在「软件设置」里关闭：你不能搜索或打开网页。遇到必须查最新资料的问题，用已有知识回答并说明可能不是最新，同时提醒用户可以打开联网开关。'
  )
  rules.push(
    '三步以上的任务先调 update_todos 列出计划，之后每完成一步就更新状态（同一时间只留一项 in_progress），做完把全部标为 completed。'
  )
  if (rememberOn) {
    rules.push(
      '遇到值得下次知道的事实（构建/测试命令、目录约定、用户偏好、踩过的坑）就调 remember 记一条，不要重复记同一件事。'
    )
  }
  rules.push(
    '要翻阅大量文件才能回答（「这个项目的鉴权怎么走的」）、或要同时对多个互不相关的模块动手时，用 task 派子 agent：它有独立上下文，自己读写文件，只把结论交回来，中间过程不占你的上下文；一次连写多个 task 会并行执行。简单的一两步操作别派，自己做更快。'
  )
  /**
   * 工具网关的用法必须写进提示：模型看不到没下发的工具，
   * 不告诉它「少了的那几个在哪」，它就会绕开（比如用 run_shell 硬拼 git 命令）。
   */
  if (opts.toolbox) {
    rules.push(
      '这一轮只直接给了常用工具：需要 git、后台终端、跨会话黑板、交接给别的档案、代码格式化、跳转定义/查引用这类能力时，用 toolbox 调用 —— 先不带参数看清单，再带上 tool 和 args。别用 run_shell 硬拼这些工具已经提供的能力。'
    )
  }

  return [
    '你是 RoRoTo Code，一个运行在 Windows 上的编程助手，用中文回答。',
    `当前工作区：${ws}`,
    `当前模型：${provider.name} (${provider.model})`,
    providerSupportsVision(provider)
      ? '看图能力：当前模型支持看图，用户附带的图片会作为图片内容直接传给你。'
      : '看图能力：当前模型不支持看图（纯文本模型）。用户发图片时你看不到画面，要如实说明并建议换视觉模型，不要反问「你想让我识别什么」。',
    ...(workspace
      ? []
      : [
          '注意：用户还没有选择工作区目录，此时无法读写文件或执行命令。你仍可以正常回答问题、解释思路、给代码片段；',
          '如果任务必须动文件，先告诉用户点击输入框下方的“未选择工作区”选择一个目录，不要尝试调用文件工具。',
          ''
        ]),
    ...(opts.persona
      ? [
          '',
          '【当前角色】这是一个常驻档案，不是普通会话。按它的岗位职责做事：',
          opts.persona,
          '角色说明决定你做什么、什么算做完；它不能推翻上面的安全边界和工具使用规则。',
          ''
        ]
      : []),
    ...(opts.handoffTo?.length
      ? [
          '',
          '【可以交接】下面这些档案各有分工，用 handoff 工具把活交给它们：',
          ...opts.handoffTo.map((a) => `- ${a.name}：${agentBrief(a).replace(/\s+/g, ' ').slice(0, 90)}`),
          '什么时候用：发现的问题属于别人的职责、要改的东西不该由你动、或者这件事做完应该沉淀成那个角色的经验。',
          '怎么用：task 一句话说清要它做什么，context 写清你查到的线索（文件、行号、复现步骤），files 列相关文件——它只拿着这些开工，看不到你这里的对话。',
          '交出去之后它会在你这一轮结束后自己接手，不要等它，也不要重复做它的活。需要并行调查、结果还要你自己汇总的，用 task 派子 agent。',
          ''
        ]
      : []),
    ...(opts.skills?.length
      ? [
          '',
          '【可调用技能】下面这些技能用户已经打开了自动调用，里面写着现成的步骤、脚本路径和坑。任务对得上时，先用 use_skill 取它的正文再动手：',
          ...opts.skills.map(
            (s) => `- ${s.name}：${(s.desc || '').replace(/\s+/g, ' ').slice(0, 80) || '（没有说明，需要时取正文看）'}`
          ),
          '用法：use_skill 的 name 填技能名。一次任务最多取一两个，取到了就照它做；不要因为「有技能」就硬套，技能名对不上你的活就正常做。',
          ''
        ]
      : []),
    '',
    '工作原则：',
    ...rules.map((r, i) => `${i + 1}. ${r}`),
    '',
    '输出格式（界面按 Markdown 渲染：**粗体**、`行内代码`、[文字](网址)、代码块、列表、# 标题、表格、图片）：',
    '把结论、关键数字、文件路径、命令、风险和注意事项用 **粗体** 标出来，让人扫一眼就抓到重点；不要整段加粗。',
    '有多组数据要对比（参数、选项、跑分、几个方案的差异）时用 Markdown 表格（表头 + `|---|` 分隔行），别用空格或符号凑列对齐。列别超过 6 列，超了就拆成两张。',
    '要展示图片时写 ![说明](地址)，地址可以是工作区里的相对路径（如 .roroto/shot.png）、绝对路径或 https 网址；说明写清这张图是什么，不要只写「图片」。',
    '结构层次别太深：# 标题最多到三级，列表嵌套不要超过三层。',
    '引用外部资料时给真实可点击的链接，写成 [说明](https://…) 或直接贴完整的 https:// 网址；没把握的网址不要编造。',
    '',
    '关于附件：用户拖进对话框的文件，正文已经由程序抽取好、贴在用户消息里，位置在「【附件1】…【附件1 结束】」之间。',
    '只要消息里有这段正文，就必须直接基于它回答；不允许说「请把文件内容提供给我 / 请粘贴内容 / 我无法访问附件」——那等于没读消息。用户问「分析这个文件」时，要引用文件里的原文、指出具体位置，再给改法。',
    '如果附件只有「程序没能抽取正文」的说明，才需要你自己动手：用 run_shell 调 python（pypdf / python-docx / openpyxl / python-pptx），或直接告诉用户这个格式读不了、建议换格式。',
    '',
    '如果当前模型不支持原生工具调用，请直接输出一行 JSON 来调用工具（可以不加代码块，也可以放进 ```tool 代码块）：',
    '{"name":"read_file","args":{"path":"src/index.ts"}}',
    '程序会执行它并把结果回传给你。一行一个调用，需要多个就分行输出。调用工具时不要再解释这段话。',
    ...(opts.memory
      ? [
          '',
          '【项目长期记忆】以下是过去会话在这个项目里记下的约定和经验。处理任务时默认遵守，不要重复询问：',
          opts.memory
        ]
      : []),
    ...(opts.board
      ? [
          '',
          '【共享黑板】同一个工作区里所有档案共用的一页便签，写的是「这摊活现在到哪了」。据此判断有没有别人正在改同一处，别重复做、也别覆盖别人的结论：',
          opts.board,
          '（发现新的跨会话事实用 board 工具写一条，别只留在自己的对话里。）'
        ]
      : []),
    ...(opts.scratch
      ? [
          '',
          '【本次会话的便签】你自己写下的临时笔记，只有这次对话看得到（别的会话、别的档案都看不到）：',
          opts.scratch,
          '（要继续记就调 scratch 追加；它跑完这摊活就作废，别把长期结论写在这上面。）'
        ]
      : []),
    ...(instructions
      ? ['', instructions]
      : []),
    ...(opts.summary
      ? [
          '',
          '【更早对话的摘要】以下是本次会话前段内容的压缩记录，事实以它为准，不要向用户复述这段话：',
          opts.summary
        ]
      : [])
  ].join('\n')
}

/**
 * 本轮的环境信息：**不进 system 提示**，拼在最后一条 user 消息尾部。
 *
 * 为什么必须分开：llama.cpp（cache_prompt）和 Ollama 的 KV 复用都按「最长公共前缀」算。
 * 时间戳、验证结论、续跑提示这些东西每轮都变，只要它们出现在 system 里，
 * 前缀就在那里断开 —— 系统提示 + 20 多个工具定义 + 全部历史每轮都要重新 prefill。
 * 实测 7B Q4 上这是每轮 3～5 秒（纯 CPU 40～90 秒），比模型本身慢得多。
 *
 * 所以 system 保持逐字节稳定，只有「这一轮才成立」的内容放在这里：
 * 它在请求体的最末尾，前面全部命中缓存，只 prefill 这几百个 token。
 */
export function runtimeBlock(opts: {
  clock: string
  hook?: string | null
  verify?: string | null
  diag?: string | null
  nudge?: string | null
  cont?: string | null
}): string {
  const parts = [`【本轮环境】当前时间：${opts.clock}（系统本地时区）`]
  if (opts.hook) {
    parts.push('', '【项目钩子提供的事实】直接当已知条件用，不要重复去查：', opts.hook)
  }
  if (opts.verify) {
    parts.push('', '【自动验证结果】你刚才说做完了，程序跑了项目的验证命令，结果如下。请据此修正，不要无视：', opts.verify)
  }
  if (opts.diag) {
    parts.push('', '【编译诊断】你刚才说做完了，但刚改过的文件还有编译错误没修掉。逐个修掉下面的错误再收工：', opts.diag)
  }
  if (opts.nudge) parts.push('', '【需要你重做】', opts.nudge)
  if (opts.cont) {
    parts.push(
      '',
      '【继续执行】上一轮你没有调用工具，但任务还没结束。别停下来等用户催，直接接着做：',
      opts.cont
    )
  }
  return parts.join('\n')
}


/**
 * 流式输出闸门：模型开始吐工具调用时先按住不显示，
 * 判定是调用就直接丢掉（界面上只出现工具卡片）；判定是正文再原样放出去。
 * 判定规则和 parseTextToolCalls 一致：行首的 { / [ / <tool_call，且名字在工具白名单里。
 */
export function createDeltaGate(send: (text: string) => void) {
  let buf = ''
  let dropped = false

  /** 找出第一个「可能是工具调用」的起点：行首的 { 或 [，或 <tool_call 标签 */
  const openerAt = (s: string): number => {
    let brace = -1
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if ((c === '{' || c === '[') && (i === 0 || s[i - 1] === '\n')) {
        brace = i
        break
      }
    }
    const tag = /<tool_call/i.exec(s)?.index ?? -1
    if (tag < 0) return brace
    if (brace < 0) return tag
    return Math.min(tag, brace)
  }

  const clearlyNotJson = (t: string): boolean => {
    if (t.startsWith('{')) {
      const rest = t.slice(1).trimStart()
      if (!rest) return false
      return rest[0] !== '"' && rest[0] !== '}'
    }
    if (t.startsWith('[')) {
      const rest = t.slice(1).trimStart()
      if (!rest) return false
      return !'"[]{0123456789-'.includes(rest[0])
    }
    return false
  }

  const pump = (): void => {
    for (;;) {
      if (!buf) return
      const cut = openerAt(buf)

      // 没有可疑起点：整段都是正文
      if (cut < 0) {
        send(buf)
        buf = ''
        return
      }
      // 前面还有正文：先把它放出去，剩下的从候选起点开始判
      if (cut > 0) {
        send(buf.slice(0, cut))
        buf = buf.slice(cut)
      }

      // <tool_call> 标签
      if (/^<tool_call/i.test(buf)) {
        const close = buf.search(/<\/tool_call>/i)
        if (close >= 0) {
          dropped = true
          buf = buf.slice(close + '</tool_call>'.length)
          continue
        }
        if (buf.length > 1500) {
          send(buf)
          buf = ''
        }
        return
      }

      // 裸 JSON
      const end = balancedEnd(buf, 0)
      if (end < 0) {
        // 还没写完：先按着；明显不是 JSON 或太长才放弃
        if (buf.length > 1500 || clearlyNotJson(buf)) {
          send(buf)
          buf = ''
          return
        }
        return
      }

      const body = buf.slice(0, end + 1)
      let calls: RawCall[] = []
      try {
        calls = asCalls(JSON.parse(body))
      } catch {
        calls = []
      }
      buf = buf.slice(end + 1)
      if (calls.length) {
        dropped = true
        continue
      }
      send(body)
    }
  }

  return {
    push(delta: string): void {
      buf += delta
      pump()
    },
    /** 收尾：还按着的内容（多半是没写完的 JSON）原样发出 */
    flush(): void {
      if (buf) {
        send(buf)
        buf = ''
      }
    },
    /** 是否丢弃过工具调用片段（调试用） */
    hasDropped(): boolean {
      return dropped
    }
  }
}

export class AgentEngine {
  private controllers = new Map<string, AbortController>()
  /**
   * 这一轮结束时要告诉用户的一句话。
   *
   * done 事件以前只用来复位界面，正常收工和「跑完了但什么都没改」看起来一模一样，
   * 用户只能盯着屏幕猜「到底完成了还是被中断了」。这里在收工处写下结论，end() 随 done 带出去。
   */
  private finishNotes = new Map<string, { note: string; ok: boolean }>()
  /**
   * 谁在干活 —— 和 controllers 一一对应，只是多了身份信息。
   *
   * 为什么要分开存：controllers 的 value 是 AbortController，塞不进别的东西；
   * 而「有几个在跑」和「跑的是哪个」是两个问题，前者只要长度，后者要档案和标题。
   * 两边必须同进同退，漏删会让界面永远显示一个幽灵任务。
   */
  private live = new Map<string, RunningRun>()
  private approvals = new Map<
    string,
    { resolve: (ok: boolean) => void; sessionId: string; high: boolean; tool: string }
  >()
  /**
   * 「以后都这样」的长期放行：键是 `工作区|工具名`（见 main/grants.ts）。
   * 懒加载一次，之后每次「记住」增量写回 —— 判断要同步做，
   * 不能每个工具调用都去读一遍磁盘。
   */
  private grants: Set<string> | null = null
  /**
   * 用量超限的确认。和审批分开存：它们的返回值不同
   * （审批是「准/不准」，这个是「这次/这次之后都/不」），混在一起会丢语义。
   */
  private quotas = new Map<string, { resolve: (v: 'once' | 'always' | 'deny') => void; sessionId: string }>()
  // question 工具：模型暂停问用户，等应答后继续。value 的 resolve 传回用户答案
  private questions = new Map<string, { resolve: (answer: string) => void; sessionId: string }>()
  // 用户在本次运行中选择「之后全允许」的会话
  private alwaysApprove = new Set<string>()
  /** 用户显式选择「始终允许高危操作」的会话（不随普通放行一起生效） */
  private alwaysApproveHigh = new Set<string>()
  /** 会话级摘要：早期对话压成一段文字，避免每一步都重新压缩 */
  private summaries = new Map<string, { upTo: number; text: string; tokens: number }>()
  /** 「工作区钩子未受信任」的提示每个会话只说一次，别每轮都念 */
  private hookNotice = new Set<string>()
  /** 各会话当前的执行计划（update_todos 维护，只用于界面展示） */
  private todos = new Map<string, TodoItem[]>()
  /** resume 时从 checkpoint 还原的「上次改过的文件」，接入本轮 touched 判断 */
  private resumeTouched = new Map<string, Set<string>>()
  /**
   * 运行中插话攒下的指令。用户在一轮跑到一半时说的话不进队列、也不开新会话，
   * 而是停在这里，等下一步开始时落成一条 user 消息 —— 模型下一轮就看到新方向。
   */
  private steers = new Map<string, string[]>()
  /**
   * 当前这一步的急停开关。和 controllers（整轮）分开：
   * 插话只断这一步，点「停止」才断整轮。工具执行时同时听两个信号。
   */
  private stepCut = new Map<string, AbortController>()
  /**
   * 全局并发闸门：会话锁管「同一个会话不重复跑」，它管「同时别开太多会话」。
   * 本地一份模型服务被 5 个会话一起抢，5 个都会变慢，等于全都卡住。
   */
  private queue: RunQueue

  constructor(private emit: Emit) {
    // 字段初始化器读不到参数属性，所以放在构造函数体里建
    this.queue = new RunQueue(MAX_CONCURRENT_RUNS, (n) =>
      this.emit(n.sessionId, {
        type: 'queue',
        position: n.position,
        active: n.active,
        limit: n.limit,
        priority: n.priority
      })
    )
  }

  /** 当前真正在跑的会话数（不含排队的） */
  activeRuns(): number {
    return this.queue.activeCount
  }

  /** 排队中的会话数，daemon 的 /status 用它解释「为什么还没开始」 */
  queuedRuns(): number {
    return this.queue.waitingCount
  }

  isRunning(sessionId: string): boolean {
    return this.controllers.has(sessionId)
  }

  /**
   * 有没有任何一个会话在跑（含排队中的）。
   * 调度器用它做「别抢」判断：本地一份模型服务被两个长任务抢，两个都会变慢。
   * 排队者也算法：排队已经说明槽位满了，再塞一个只是把队伍排得更长。
   */
  hasRunning(): boolean {
    return this.controllers.size > 0
  }

  /**
   * 正在跑的会话，按开始时间排。只读快照，外部改不动引擎内部状态。
   *
   * state / position 每次现算而不是落盘：排队位置会随着别人跑完而前移，
   * 存下来的数字一不留神就是过期的。queue 是唯一真相，这里只是投影。
   */
  runningRuns(): RunningRun[] {
    return [...this.live.values()]
      .map((r) => {
        const running = this.queue.holding(r.sessionId)
        return {
          ...r,
          state: running ? ('running' as const) : ('queued' as const),
          position: running ? 0 : this.queue.position(r.sessionId)
        }
      })
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  /**
   * 登记一次运行。会话可能不存在（极少见），这时按「普通会话」记，
   * 宁可少一个档案名，也不要因为拿不到标题就把这次运行从列表里漏掉。
   *
   * 一进来先按 queued 记：能不能立刻拿到槽位要等 acquire 的结果，
   * 而侧栏希望「一提交就看得见」，所以先上线再改状态。
   */
  private track(sessionId: string, session: Session | null, kind: RunningRun['kind']): void {
    this.live.set(sessionId, {
      sessionId,
      agentId: session?.agentId ?? null,
      title: session?.title ?? '新会话',
      kind,
      state: 'queued',
      position: 0,
      startedAt: Date.now()
    })
  }

  /**
   * 会话消息被删过之后，摘要缓存不能再用了。
   *
   * summaries 记的是 upTo（压到了第几条消息），删掉中间几条后这个数字会整体错位：
   * 轻则把删掉的内容又从摘要里喂给模型，重则 slice 跳过还该保留的消息。
   * 直接丢掉最稳妥 —— 下一轮会按剩下的历史重新压一次。
   */
  forgetSummary(sessionId: string): void {
    this.summaries.delete(sessionId)
  }

  abort(sessionId: string): void {
    const controller = this.controllers.get(sessionId)
    if (controller) {
      // 先写结论再 abort：中止会一路抛到 end()，晚了就来不及带上这句话
      this.finishNotes.set(sessionId, { note: '已中止；没做完的部分可以点「继续」接着跑', ok: false })
      controller.abort(new Error('已取消'))
    }
    // 挂起的 question 也一起清掉，否则弹窗残留、Promise 永不 resolve、会话卡死
    // entry.resolve 即 finish，会统一清理并 emit question_dismiss
    for (const [, entry] of this.questions) {
      if (entry.sessionId === sessionId) entry.resolve('')
    }
    // 挂着的配额确认同理：不 resolve 掉，这个会话的 Promise 就永远悬着
    for (const [id, entry] of this.quotas) {
      if (entry.sessionId !== sessionId) continue
      this.quotas.delete(id)
      entry.resolve('deny')
    }
    /**
     * 审批弹窗也必须一起收掉。
     *
     * 只清 question / quota 是不够的：runLoop 停在 `await askApproval` 上，
     * 用户点了停止、弹窗被界面关掉，这个 Promise 就没有任何人会 resolve ——
     * send() 的 finally 不执行、并发槽位不释放，这个会话从此永远「运行中」，
     * 连别的会话都可能排不进来。entry.resolve 即 finish，会清理并 emit dismiss。
     */
    for (const [, entry] of this.approvals) {
      if (entry.sessionId === sessionId) entry.resolve(false)
    }
  }

  /**
   * 运行中插话。
   *
   * 和「排队」的区别：排队是等这一轮整个跑完再看新消息，这里的意图是
   * 「你正在做的事情不对，先停下」。所以它做三件事：
   *   1. 记下这句话（下一步开始时落成一条 user 消息，模型立刻看到新方向）
   *   2. 断掉当前这一步的工具执行（长命令 kill 掉，不再往下读几十个文件）
   *   3. 已经开始跑的那一批里没轮到的工具，直接跳过
   *
   * 不打断模型正在生成的那句话：那个最多几秒，而且截断会留下半句回答，
   * 对用户没有好处。断的是「动作」，不是「说话」。
   *
   * 返回 false 表示这个会话没在跑，调用方应当改走 send ——
   * 这样界面上「运行中就插话、没运行就发送」永远只有一个通道是对的。
   */
  steer(sessionId: string, text: string): boolean {
    const body = String(text ?? '').trim()
    if (!body) return false
    if (!this.controllers.has(sessionId)) return false
    const list = this.steers.get(sessionId) ?? []
    list.push(body)
    this.steers.set(sessionId, list)
    // 只断这一步：步级开关断了之后，循环会重建一个新的继续跑
    this.stepCut.get(sessionId)?.abort(new Error('用户插话'))
    return true
  }

  /** 有没有攒着没处理的插话（工具循环每轮问一次，决定还要不要继续动手） */
  private steered(sessionId: string): boolean {
    return (this.steers.get(sessionId)?.length ?? 0) > 0
  }

  /**
   * 把攒下的插话落成正式的 user 消息。
   * 必须落库而不是只进内存：这一轮结束前后崩溃，用户说的话不能凭空消失。
   */
  private async drainSteers(session: Session): Promise<boolean> {
    const list = this.steers.get(session.id)
    if (!list || list.length === 0) return false
    this.steers.delete(session.id)
    for (const text of list) {
      const message: ChatMessage = {
        id: store.newId(),
        role: 'user',
        content: text,
        createdAt: Date.now()
      }
      session.messages.push(message)
      await store.appendMessages(session.id, [message])
      this.emit(session.id, { type: 'steer', text })
    }
    return true
  }

  /**
   * 给「决定不执行的工具调用」补结果。
   *
   * 这不是为了好看，是为了不把下一步的请求打崩：assistant 消息里声明了 3 个 tool_call，
   * 请求就必须跟着 3 条 tool 消息，少一条整轮 400，用户看到的是「模型报错了」。
   */
  private async skipTools(
    session: Session,
    calls: ToolCall[],
    why: string,
    announced: Set<string>
  ): Promise<void> {
    if (calls.length === 0) return
    const now = Date.now()
    const rows: ChatMessage[] = []
    for (const call of calls) {
      rows.push({
        id: store.newId(),
        role: 'tool',
        content: why,
        toolCallId: call.id,
        toolName: call.name,
        toolArgs: call.args,
        createdAt: now
      })
      // 只有已经在界面上亮过卡的才补一条结果，否则会凭空冒出一堆「未执行」卡片
      if (announced.has(call.id)) {
        this.emit(session.id, {
          type: 'tool_result',
          callId: call.id,
          tool: call.name,
          result: why,
          ok: false,
          durationMs: 0
        })
      }
    }
    session.messages.push(...rows)
    await store.appendMessages(session.id, rows)
  }

  respondApproval(id: string, approved: boolean, always = false, persist = false): void {
    // 配额确认走同一个 IPC（界面上都是「需要确认」弹窗），但返回值是三态
    const quota = this.quotas.get(id)
    if (quota) {
      this.quotas.delete(id)
      quota.resolve(approved ? (always ? 'always' : 'once') : 'deny')
      return
    }
    const entry = this.approvals.get(id)
    if (!entry) return
    this.approvals.delete(id)
    // 放行范围以主进程记录的 risk.high 为准，不信渲染层传上来的标记
    if (approved && always) {
      if (entry.high) this.alwaysApproveHigh.add(entry.sessionId)
      else this.alwaysApprove.add(entry.sessionId)
    }
    /**
     * 「以后都这样」落盘。只对非高危生效 —— 高危操作即便用户勾了「始终允许」，
     * 也只在这一轮有效。把「删除永远不再确认」写进磁盘，是事后没人想得起来的隐患。
     */
    if (approved && persist && !entry.high) void this.persistGrant(entry.sessionId, entry.tool)
    entry.resolve(approved)
  }

  /** 这个工作区里这个工具是否长期放行。同步查内存，热路径上不能读盘 */
  private grantedIn(workspace: string | null, tool: string): boolean {
    if (!workspace || !this.grants) return false
    return this.grants.has(grantKey(workspace, tool))
  }

  /** 授权记录被外部改过（设置页撤销 / 清空）：丢掉内存缓存，下次运行重新读 */
  forgetGrants(): void {
    this.grants = null
  }

  /** 写一条长期放行：先改内存（这一轮后面几步立刻生效），再落盘 */
  private async persistGrant(sessionId: string, tool: string): Promise<void> {
    try {
      const session = await store.loadSession(sessionId).catch(() => null)
      const config = await loadConfig()
      const ws = session?.workspace ?? config.workspace ?? defaultWorkspaceDir()
      if (!this.grants) this.grants = await loadGrantSet().catch(() => new Set<string>())
      this.grants.add(grantKey(ws, tool))
      await grantTool(ws, tool)
    } catch {
      // 记不住就退回「本轮有效」：不能因为磁盘写不进去把审批流程卡死
    }
  }

  /** question 工具：用户点选/输入答案后，resolve 回传给模型继续跑 */
  respondQuestion(id: string, answer: string): void {
    const entry = this.questions.get(id)
    if (!entry) return
    // resolve 即 finish：统一做清理、解绑 abort、emit question_dismiss
    entry.resolve(answer)
  }

  private askQuestion(
    sessionId: string,
    question: string,
    options?: string[],
    signal?: AbortSignal,
    multiSelect = false
  ): Promise<string> {
    const request: QuestionRequest = { id: store.newId(), question, options, multiSelect }
    this.emit(sessionId, { type: 'question', request })
    return new Promise((resolve) => {
      let settled = false
      // 同 askApproval：signal 已断时会在建 timer 之前就 finish，用 const 会踩 TDZ
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (answer: string) => {
        if (settled) return
        settled = true
        this.questions.delete(request.id)
        if (signal) signal.removeEventListener('abort', onAbort)
        if (timer) clearTimeout(timer)
        this.emit(sessionId, { type: 'question_dismiss', id: request.id })
        resolve(answer)
      }
      // 中止信号：用户点「停止」或超时，用空答案收尾，让模型拿「未回答」继续或结束
      const onAbort = () => finish('')
      if (signal) {
        if (signal.aborted) {
          finish('')
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      // 兜底超时：10 分钟没人回答就自动跳过，避免会话永久挂起
      timer = setTimeout(() => finish(''), 10 * 60 * 1000)
      this.questions.set(request.id, {
        resolve: finish,
        sessionId
      })
    })
  }

  private askApproval(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    risk?: RiskInfo,
    preview?: ApprovalRequest['preview'],
    signal?: AbortSignal
  ): Promise<boolean> {
    const request: ApprovalRequest = {
      id: store.newId(),
      tool,
      args,
      summary: summarize(tool, args),
      risk: risk?.kind,
      reason: risk?.reason,
      high: risk?.high === true,
      preview
    }
    this.emit(sessionId, { type: 'approval', request })
    return new Promise((resolve) => {
      let settled = false
      // 先声明再赋值：signal 已经断了的分支会在下面立刻 finish，
      // 那时 timer 还没建立，用 const 会踩进 TDZ 直接抛 ReferenceError
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (approved: boolean): void => {
        if (settled) return
        settled = true
        this.approvals.delete(request.id)
        if (signal) signal.removeEventListener('abort', onAbort)
        if (timer) clearTimeout(timer)
        // 界面据此把弹窗收掉：中止或超时时没人会点按钮，不主动通知就会留一个僵尸弹窗
        this.emit(sessionId, { type: 'approval_dismiss', id: request.id })
        resolve(approved)
      }
      /**
       * 停止 = 不同意。这里和 askQuestion 用同一套收尾方式：不监听的话，
       * 弹窗还开着、Promise 却没人 resolve，整轮永远挂在 await 上。
       */
      const onAbort = (): void => finish(false)
      if (signal) {
        if (signal.aborted) {
          finish(false)
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      // 兜底超时：人不在电脑前时不能把这一轮永久挂住（与 askQuestion 一致）
      timer = setTimeout(() => finish(false), 10 * 60 * 1000)
      this.approvals.set(request.id, {
        resolve: finish,
        sessionId,
        high: request.high === true,
        tool
      })
    })
  }

  /**
   * 用量撞上限：问一句「还继续吗」。
   * 不硬断是有意的 —— 有些任务就差最后两步，为了省几 k token 前功尽弃更亏；
   * 但也不能一声不响地一路烧下去，所以把决定权交回用户，一次运行只问一次。
   */
  private askQuota(sessionId: string, hit: QuotaHit): Promise<'once' | 'always' | 'deny'> {
    const request: ApprovalRequest = {
      id: store.newId(),
      tool: 'quota',
      args: {},
      summary: quotaText(hit),
      quota: { scope: hit.scope, used: hit.used, limit: hit.limit }
    }
    this.emit(sessionId, { type: 'approval', request })
    return new Promise((resolve) => {
      this.quotas.set(request.id, { resolve, sessionId })
    })
  }

  async send(sessionId: string, text: string, files?: SendAttachment[], options?: RunOptions): Promise<void> {
    if (this.controllers.has(sessionId)) throw new Error('这个会话正在运行中')

    const config = await loadConfig()
    const existing = await store.loadSession(sessionId).catch(() => null)
    // 会话级模型绑定已经取消（界面只保留顶栏「模型选择」）。
    // 只有档案建出来的会话还认自己的默认模型，普通会话一律用全局当前供应商——
    // 否则老会话里残留的 modelId 会让顶栏选了别的模型却不变，回到「配了不生效」。
    let provider = resolveProvider(
      config,
      existing?.agentId ? existing?.modelId : null,
      existing?.modelOverride
    )
    if (!provider) throw new Error('还没有配置模型')

    /**
     * userPromptSubmit：用户按发送后、落盘之前。
     * 典型用法是「把工单号自动换成背景资料」「发现提到密码就拦下来」。
     * 阻断要抛错而不是静默返回，否则界面停在“正在思考”。
     */
    const submitHook = await runHooks('userPromptSubmit', {
      workspace: existing?.workspace ?? (await effectiveWorkspace(config)),
      sessionId,
      agentId: existing?.agentId ?? null,
      text
    })
    if (submitHook.blocked) throw new Error(`这条消息被钩子拦下了：${submitHook.blocked}`)

    const controller = new AbortController()
    this.controllers.set(sessionId, controller)
    this.track(sessionId, existing, options?.reason ?? 'chat')

    try {
      const prepared = await this.withAttachments(sessionId, text, files, provider)
      const { body, images } = prepared
      // 发了图并自动切到视觉模式时，配置里的 llamaVision / baseUrl 已经变了：
      // 后面的系统提示和预算都得按切换后的那份算，否则这一轮还会说「我看不了图」。
      const visionChanged = prepared.provider.llamaVision !== provider.llamaVision
      provider = prepared.provider
      const live = visionChanged ? await loadConfig() : null
      const session = await store.appendMessages(sessionId, [
        {
          id: store.newId(),
          role: 'user',
          content: body,
          ...(images.length ? { images } : {}),
          createdAt: Date.now()
        }
      ])
      /**
       * 先把提问落盘再去抢槽位：排队可能等好几分钟，
       * 这段时间里用户切走再切回来、甚至重启软件，这句话都得还在。
       *
       * 抢槽位按优先级插队：用户手打的话永远排在定时任务前面，
       * 否则用户坐在键盘前等，后台却在跑按表任务。
       */
      await this.queue.acquire(sessionId, controller.signal, priorityOf(options?.reason))
      await this.runLoop(session, live ?? config, provider, controller.signal, options)
    } finally {
      this.end(sessionId)
    }
  }

  /** 共用的「准备一次运行」：抢锁、读配置、取供应商 */
  private async begin(
    sessionId: string,
    kind: RunningRun['kind'] = 'regen'
  ): Promise<{ config: AppConfig; provider: ProviderConfig; signal: AbortSignal }> {
    if (this.controllers.has(sessionId)) throw new Error('这个会话正在运行中')
    const config = await loadConfig()
    const existing = await store.loadSession(sessionId).catch(() => null)
    // 同上：只有档案会话认自己的默认模型，普通会话跟随全局
    const provider = resolveProvider(
      config,
      existing?.agentId ? existing?.modelId : null,
      existing?.modelOverride
    )
    if (!provider) throw new Error('还没有配置模型')
    const controller = new AbortController()
    this.controllers.set(sessionId, controller)
    this.track(sessionId, existing, kind)
    /**
     * 调用方是「begin 成功之后」才进 try 的，所以这里抢槽位失败得自己收拾干净，
     * 否则一次取消就会把这个会话永久锁在「运行中」。
     */
    try {
      // 交接进来的活让一档给用户，定时任务让两档（见 priorityOf）
      await this.queue.acquire(sessionId, controller.signal, priorityOf(kind))
    } catch (err) {
      this.end(sessionId)
      throw err
    }
    return { config, provider, signal: controller.signal }
  }

  private end(sessionId: string): void {
    this.queue.release(sessionId)
    this.controllers.delete(sessionId)
    this.live.delete(sessionId)
    this.alwaysApprove.delete(sessionId)
    this.alwaysApproveHigh.delete(sessionId)
    // 插话只属于这一轮：不清掉的话，下次提问会莫名带上上一轮没说完的那句话
    this.steers.delete(sessionId)
    this.stepCut.delete(sessionId)
    // 收工结论只属于这一轮：读走就删，下次运行不该带着上次的结论
    const note = this.finishNotes.get(sessionId)
    this.finishNotes.delete(sessionId)
    this.emit(sessionId, { type: 'done', ...(note ?? {}) })
  }

  /** 重新生成：退回到最后一条用户消息之前，把这一轮重跑 */
  async regenerate(sessionId: string): Promise<void> {
    const { config, provider, signal } = await this.begin(sessionId)
    try {
      const before = await store.loadSession(sessionId)
      const lastUser = [...before.messages].reverse().find((m) => m.role === 'user')
      if (!lastUser) throw new Error('这个会话还没有提问，没法重新生成')
      const session = await store.truncateFrom(sessionId, lastUser.id)
      /**
       * 摘要缓存必须作废。它记的是「压到第几条消息」（upTo），历史一被截短
       * 这个下标就错位了：slice(upTo) 可能整段为空，等于这次提问根本没发出去，
       * 模型拿着旧摘要和一句「本轮环境」就作答，而且这条回答还会正常落库。
       */
      this.forgetSummary(sessionId)
      await this.runLoop(session, config, provider, signal)
    } finally {
      this.end(sessionId)
    }
  }

  /** 改掉某条用户消息，从那里重新跑（后面的回答和工具结果都丢掉） */
  async editAndResend(sessionId: string, messageId: string, text: string): Promise<void> {
    const { config, provider, signal } = await this.begin(sessionId, 'edit')
    try {
      const before = await store.loadSession(sessionId)
      const target = before.messages.find((m) => m.id === messageId)
      if (!target || target.role !== 'user') throw new Error('只能修改自己的提问')
      await store.truncateFrom(sessionId, messageId)
      const session = await store.appendMessages(sessionId, [
        { ...target, content: text, createdAt: Date.now() }
      ])
      // 同上：截断之后 upTo 已经失效，继续用会把刚改的这条也切掉
      this.forgetSummary(sessionId)
      await this.runLoop(session, config, provider, signal)
    } finally {
      this.end(sessionId)
    }
  }

  /** 中断后接着做：先还原结构化 checkpoint（计划 + 改过的文件），再让模型从断点往下走 */
  async resume(sessionId: string): Promise<void> {
    // 崩溃 / 中断后，引擎内存里的计划已经丢了：从 checkpoint 还原，这样「计划还有未完成项」的判断才成立
    const cp = await loadCheckpoint(sessionId)
    if (cp) {
      if (cp.todos.length && !this.todos.has(sessionId)) {
        this.todos.set(sessionId, cp.todos)
      }
      if (cp.touched.length) {
        this.resumeTouched.set(sessionId, new Set(cp.touched))
      }
    }
    // 把结构化进度拼进「继续」消息：明确告诉模型做到哪、还剩什么、别重复已完成的部分
    const brief = cp ? `\n\n${checkpointBrief(cp)}` : ''
    await this.send(
      sessionId,
      `继续。上次执行被中断了，请从断点接着做完，不要重复已经完成的部分。${brief}`,
      undefined,
      { reason: 'resume' }
    )
  }

  /**
   * 附件处理分两条路：
   * - 图片：交给视觉模型直接看（随消息附带 base64）。本地 llama.cpp 默认按纯文本跑，
   *   检测到图片先自动重启挂上投影器（约 10 秒），这一轮就能看图；换完不改回来，
   *   由闲置回收负责切回。模型看不了就明确告知，别让它反问「你想识别什么」。
   * - 其他：正文由程序抽取后拼进消息，模型拿到的是文字而不是路径。
   */
  private async withAttachments(
    sessionId: string,
    text: string,
    files: SendAttachment[] | undefined,
    provider: ProviderConfig
  ): Promise<{ body: string; images: string[]; provider: ProviderConfig }> {
    const list = (files ?? []).filter((f) => f && f.absPath)
    if (!list.length) return { body: text, images: [], provider }

    const imageFiles = list.filter((f) => isImagePath(f.absPath) && f.size <= 40 * 1024 * 1024)
    /**
     * 判断「这轮有没有图」只看文件名，**不能**用 providerSupportsVision：
     * 纯文本模式下 llamaVision 是 false，靠它判断会直接走进「没图」分支，
     * 永远触发不到下面的自动切换。
     */
    let use = provider
    let canSee = this.canSeeImages(use)
    if (imageFiles.length && !canSee && this.canSwitchToVision(use)) {
      const switched = await this.ensureVision(sessionId, use)
      if (switched) {
        use = switched
        canSee = this.canSeeImages(use)
      }
    }
    const docFiles = list.filter((f) => !imageFiles.includes(f))
    const images = canSee ? imageFiles.slice(0, 6).map((f) => f.absPath) : []

    // 给附件正文留出上下文预算，剩下的留对话历史
    const total = Math.max(2000, Math.min(30000, Math.floor(use.contextWindow * 0.35)))
    const each = Math.max(1200, Math.floor(total / Math.max(1, docFiles.length)))

    const items: Parameters<typeof renderAttachmentBody>[0] = []
    for (const f of docFiles) {
      // 抽取大文件可能要几秒（老 .doc 走 Word 转换），先告诉界面在干什么
      this.emit(sessionId, { type: 'attach_reading', file: f.path })
      const outcome = await extractAttachment({
        absPath: f.absPath,
        display: f.path,
        kindLabel: f.kindLabel || '文件',
        size: f.size || 0,
        budget: each
      })
      items.push({
        display: f.path,
        kindLabel: f.kindLabel || '文件',
        size: f.size || 0,
        outcome
      })
    }

    const notes: string[] = []
    if (images.length) {
      notes.push(
        [
          `【图片】本次消息附带 ${images.length} 张图片，画面已经直接传给你了（不是路径，你看得见）：`,
          ...imageFiles.slice(0, 6).map((f, i) => `- 图${i + 1}：${f.path}`),
          '直接描述你看到的内容，不要说「请提供图片」或「请说明要识别什么」。'
        ].join('\n')
      )
    }
    if (imageFiles.length && !canSee) {
      notes.push(
        [
          `【图片看不了】用户发了 ${imageFiles.length} 张图片，但当前模型（${use.model}）没有视觉能力，你确实看不到画面。`,
          '必须直接说明这一点，并给出可行做法：在「模型设置 → 模型 API」里换成支持看图的模型（如 qwen2.5-vl、llava、gemma3、mistral-small-3.1、gpt-4o），',
          '或者让用户把图里的文字/关键数据打字发过来。绝对不要反问「你想让我识别什么」，那等于没读消息。'
        ].join('\n')
      )
      this.emit(sessionId, { type: 'attach_no_vision', model: use.model })
    }

    const rendered = renderAttachmentBody(items, notes)
    return { body: rendered ? `${text}\n\n${rendered}` : text, images, provider: use }
  }

  /**
   * 这一轮到底能不能看图。
   *
   * 不能只看配置：`llamaVision` 是上次启动时写进去的，软件重启后模型还没起来
   * （或已经按纯文本起来了）它仍然是 true，照它判断就会把图片发给一个看不见图的
   * 服务，模型只能硬编。所以本地实例一律再问一句「进程里真的挂了投影器吗」。
   */
  private canSeeImages(provider: ProviderConfig): boolean {
    if (!providerSupportsVision(provider)) return false
    if (isLlamaProvider(provider)) return llamaVisionLoaded(provider.id)
    return true
  }

  /**
   * 能不能为这一轮自动切到视觉模式。
   *
   * 用户在设置里把「看图」明确关掉（vision: 'off'）就尊重他 —— 那种情况下
   * 发图仍然走「我看不见，换模型」的提示，而不是背着他重启服务。
   */
  private canSwitchToVision(provider: ProviderConfig): boolean {
    return isLlamaProvider(provider) && provider.vision !== 'off'
  }

  /**
   * 确保这一轮能看图：本地 llama.cpp 默认按纯文本跑，检测到图片时自动重启挂上投影器。
   *
   * 不弹确认框 —— 用户发图就是想看图，让他先去点一个「确定」只会更烦。
   * 但必须说清楚在干什么：这一步要重启服务（10 秒上下），期间界面不该像卡死。
   *
   * 返回切换后重新读到的供应商配置（llamaVision 已更新）；切不了就返回 null，
   * 调用方按「看不了图」的老路径提示用户。
   */
  private async ensureVision(
    sessionId: string,
    provider: ProviderConfig
  ): Promise<ProviderConfig | null> {
    /**
     * 别的会话正在跑：重启会把它这一轮的流式输出直接打断。
     * 全局并发只有 2，最多等两分钟；等不到也只能继续 —— 用户已经把图发出来了。
     */
    if (this.controllers.size > 1) {
      this.emit(sessionId, {
        type: 'hint',
        message: '另一个会话正在运行，等它结束后再切换视觉模型（最多等 2 分钟）…'
      })
      const deadline = Date.now() + 120000
      while (this.controllers.size > 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500))
      }
    }

    this.emit(sessionId, {
      type: 'vision_switch',
      state: 'loading',
      message: '检测到图片，正在切换视觉模型（重启服务加载投影器，约 10 秒）…'
    })
    const r = await setLlamaVision(provider.id, true, provider.model)
    if (!r.ok) {
      this.emit(sessionId, { type: 'vision_switch', state: 'failed', message: r.message })
      return null
    }
    const cfg = await loadConfig()
    const fresh = cfg.providers.find((p) => p.id === provider.id)
    // 这一轮用完先别急着切回：连着发图很常见，闲置回收由 armVisionIdle 负责
    this.armVisionIdle(provider.id, sessionId)
    if (r.changed) {
      this.emit(sessionId, { type: 'vision_switch', state: 'ready', message: r.message })
    }
    return fresh ? { ...provider, ...fresh } : { ...provider, llamaVision: true }
  }

  /** 视觉模式闲置回收：发完图一直在挂投影器，文本解码会一直慢下去 */
  private visionIdle = new Map<string, { timer: NodeJS.Timeout; sessionId: string }>()

  private armVisionIdle(providerId: string, sessionId: string, delay = VISION_IDLE_MS): void {
    this.disarmVisionIdle(providerId)
    const timer = setTimeout(() => {
      void this.releaseIdleVision(providerId, sessionId)
    }, delay)
    timer.unref?.()
    this.visionIdle.set(providerId, { timer, sessionId })
  }

  private disarmVisionIdle(providerId: string): void {
    const rec = this.visionIdle.get(providerId)
    if (!rec) return
    clearTimeout(rec.timer)
    this.visionIdle.delete(providerId)
  }

  private async releaseIdleVision(providerId: string, sessionId: string): Promise<void> {
    this.visionIdle.delete(providerId)
    // 还在跑就别动：重启会把正在生成的回答打断。一分钟后再看一次
    if (this.controllers.size > 0) {
      this.armVisionIdle(providerId, sessionId, 60_000)
      return
    }
    const r = await setLlamaVision(providerId, false)
    if (r.ok && r.changed) {
      this.emit(sessionId, {
        type: 'vision_switch',
        state: 'ready',
        message: '好几分钟没发图了，已切回纯文本模式（解码更快）。再发图片会自动切回来。'
      })
    }
  }

  /**
   * 自动压缩上下文。
   *
   * 历史用量超过「历史预算」的 75% 时，把「摘要已经覆盖的部分之后、最近几条之前」的对话
   * 交给模型压成一段要点，下一轮开始就直接用摘要代替那一大段原文。
   * 已经压过的部分不会重复压：新摘要 = 旧摘要 + 新增对话重新合并。
   *
   * budget 传的是「历史实际能放多少 token」（不是整窗的 70%），否则阈值永远够不到，
   * 压缩一次都不会触发。
   */
  private async summarizeIfNeeded(
    session: Session,
    provider: ProviderConfig,
    budget: number,
    ctx: number,
    signal: AbortSignal,
    opts: { force?: boolean; keep?: number } = {}
  ): Promise<{ upTo: number; text: string; tokens: number } | null> {
    const cached = this.summaries.get(session.id) ?? null
    const covered = cached?.upTo ?? 0
    // 最近的几轮原样保留；强制再压时只留 4 条，好腾出位置
    const keep = Math.max(2, Math.round(opts.keep ?? 6))
    if (session.messages.length - covered < keep) return cached

    const uncovered = session.messages.slice(covered)
    const tokens = messagesTokens(uncovered)
    // force：已经确定「装不下」了，就别再按 75% 的阈值等
    if (!opts.force && tokens < Math.floor(budget * 0.75)) return cached

    // 切点落在用户消息上，别把「助手调用工具 + 工具结果」拆散
    let cut = session.messages.length - keep
    while (cut > covered && session.messages[cut]?.role !== 'user') cut--
    if (cut - covered < (opts.force ? 2 : 4)) return cached

    const chunk = session.messages.slice(covered, cut)
    const lines: string[] = []
    for (const m of chunk) {
      const label = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : `工具(${m.toolName ?? ''})`
      let body = (m.content || '').trim()
      if (m.toolCalls?.length) body += `［调用了 ${m.toolCalls.map((c) => c.name).join('、')}］`
      if (body.length > 600) body = `${body.slice(0, 600)}…`
      if (body) lines.push(`${label}: ${body}`)
    }
    if (!lines.length) return cached

    // 摘要请求本身也要塞进同一个窗口：按真实窗口算能写多长（中文≈一字一 token）。
    // 压得太狠的摘要请求会直接 400，上层 catch 会当成「压缩失败」悄悄跳过，
    // 用户就永远等不到自动压缩。
    const maxChars = Math.max(2000, Math.min(24000, Math.floor((ctx - 3500) * 0.75)))
    let body = lines.join('\n')
    if (body.length > maxChars) {
      // 开头（最早的事）和结尾（最近的事）都要留，掐掉中间
      const headLen = Math.floor(maxChars * 0.35)
      const tailLen = Math.max(0, maxChars - headLen)
      body = `${body.slice(0, headLen)}\n…（中间一段已省略）…\n${body.slice(-tailLen)}`
    }

    const prompt = [
      cached?.text ? `已有摘要：\n${cached.text}\n` : '',
      '下面是需要压缩的对话记录：',
      body
    ]
      .filter(Boolean)
      .join('\n')

    this.emit(session.id, { type: 'compacting' })
    try {
      const res = await chat({
        provider,
        messages: [
          {
            id: 'compact-system',
            role: 'system',
            content:
              '你是对话压缩器。把给出的对话记录压成要点摘要，必须保留：用户的目标与约束、已确认的事实与结论、改动过的文件、尚未完成的事项。' +
              '用简洁的中文条目，不要评论、不要客套，控制在 600 字以内。只输出摘要正文。',
            createdAt: Date.now()
          },
          { id: 'compact-user', role: 'user', content: prompt, createdAt: Date.now() }
        ],
        tools: [],
        signal,
        onText: () => undefined
      })
      const text = res.text.trim()
      if (!text) return cached
      const entry = { upTo: cut, text, tokens: estimateTokens(text) }
      // 会话太多时简单清一下，避免常驻内存越攒越大
      if (this.summaries.size > 30 && !this.summaries.has(session.id)) this.summaries.clear()
      this.summaries.set(session.id, entry)
      return entry
    } catch (err) {
      // 压缩失败不能影响正常对话，退回到「只用原来的裁剪逻辑」
      if (signal.aborted) throw err
      return cached
    }
  }

  /**
   * 带自动切换的模型请求。
   *
   * 主供应商失败（额度用完 429、欠费 402、key 失效、断网、5xx）时，按配置顺序试
   * 标记了「备用」的供应商；已经吐过字就不切了——换了会把半截回答重复一遍，
   * 不如把错误直接抛给用户。
   */
  private async chatWithFallback(
    sessionId: string,
    config: AppConfig,
    primary: ProviderConfig,
    messages: ChatMessage[],
    tools: ToolSpec[],
    signal: AbortSignal,
    onText: (text: string) => void
  ): Promise<{ provider: ProviderConfig; result: StreamResult }> {
    const chain: ProviderConfig[] = [primary]
    if (config.autoFallback !== false) {
      for (const p of config.providers) {
        if (p.id === primary.id || !p.fallback || !p.model) continue
        chain.push(p)
      }
      /**
       * 默认核心兜底：用户切到在线 API 或别的本地模型都行，能用就用他的；
       * 都不好使（key 失效 / 断网 / 本地服务没起）才落到 core/Core.gguf。
       * 不管用户有没有给核心那条打「备用」，这里都保证它排在最后。
       */
      if (primary.id !== CORE_PROVIDER_ID) {
        const core = await coreFallbackProvider().catch(() => null)
        if (core && !chain.some((p) => p.id === core.id)) chain.push(core)
      }
    }

    let last: unknown = null
    for (let i = 0; i < chain.length; i++) {
      let use = this.fitted(chain[i], config)
      // 轮到核心兜底：先把 llama-server 拉起来，没在跑就等它就绪（首次要几十秒）
      if (use.id === CORE_PROVIDER_ID) {
        const slow = setTimeout(() => {
          this.emit(sessionId, { type: 'hint', message: '正在加载默认核心模型（首次约几十秒）…' })
        }, 1200)
        try {
          const ready = await ensureCoreReady()
          if (!ready.ok) {
            last = new Error(ready.message)
            continue
          }
          // 启动后端口可能变了，用刚读出来的那条重新算
          if (ready.provider) use = this.fitted(ready.provider, config)
        } finally {
          clearTimeout(slow)
        }
      }
      /**
       * 同一家先自己重试两次，再考虑换下一家。
       *
       * 以前是「失败就切」：用户只配了一家在线模型时，一次 5xx 抖动会直接落到核心小模型，
       * 界面不报错，只是回答质量突然掉下来 —— 这比直接失败更难查。退避一下多数抖动就过去了。
       * 只在这家还没吐字时重试：吐过字再重来会把半截回答重复一遍。
       */
      for (let attempt = 0; ; attempt++) {
        let spoke = false
        /** 这家已经在等加载了：只等一次，超时就正常走兜底，别无限等 */
        let waitedLoad = false
        try {
          const result = await chat({
            provider: use,
            messages,
            tools: use.noTools ? [] : tools,
            signal,
            onText: (t) => {
              spoke = true
              onText(t)
            }
          })
          return { provider: use, result }
        } catch (err) {
          last = err
          if (signal.aborted || spoke) throw err
          /**
           * 「这个模型不支持工具」是本地模型的常客，不是故障。
           *
           * Ollama 会直接回 400 `… does not support tools`（本机的 deepseek 系模型
           * capabilities 只有 completion 就是这样），llama.cpp / LM Studio 也有同样的模型。
           * 原来这条错误一路冒到界面，用户看到一行 HTTP 400 就没了 —— 明明可以退到
           * 「文本协议」（提示里教模型用 JSON 描述工具调用，程序再解析）继续干活。
           * 这里就地降级 + 记进配置，免得每一轮都先失败一次。
           */
          if (!use.noTools && /does not support tools|not support tool|tools? (?:are )?not supported/i.test((err as Error).message ?? '')) {
            use = { ...use, noTools: true }
            this.emit(sessionId, {
              type: 'hint',
              message: `${use.name} 的 ${use.model} 不支持原生工具调用，已自动改用文本协议重试（这个选择会记住）。`
            })
            await this.rememberNoTools(use.id).catch(() => undefined)
            continue
          }
          /**
           * 本地模型在加载 / 刚重启（503 Loading model、fetch failed）：
           * 这不叫"不可用"，等它就绪再试同一家。
           * 不等的话，用户刚点完「启动并使用」，第一条消息必然落到核心模型上。
           */
          const warming = use.runtime === 'llama' && isWarmingUp(err)
          if (warming && !waitedLoad) {
            waitedLoad = true
            const ready = await waitLocalServing(use, signal, (message) =>
              this.emit(sessionId, { type: 'hint', message })
            )
            if (ready) continue
          }
          if (retryable(err) && attempt < RETRY_TIMES) {
            const wait = RETRY_BASE_MS * (attempt + 1)
            const reason = (err as Error).message.slice(0, 80)
            this.emit(sessionId, {
              type: 'hint',
              message: `${use.name} 这次没成功（${reason}），${Math.round(wait / 1000)} 秒后重试（第 ${attempt + 1}/${RETRY_TIMES} 次）。`
            })
            await waitAbortable(wait, signal)
            continue
          }
          const reason = switchReason(err)
          const next = chain[i + 1]
          if (!reason || !next) throw err
          this.emit(sessionId, {
            type: 'failover',
            from: `${use.name} · ${use.model || '未选模型'}`,
            to: `${next.name} · ${next.model}`,
            reason
          })
          break
        }
      }
    }
    throw last instanceof Error ? last : new Error('所有模型都不可用')
  }

  /** Ollama 的 num_ctx 跟着全局上限走：只有开了「限制上下文」才压小，否则用条目自己的值 */
  private fitted(p: ProviderConfig, config: AppConfig): ProviderConfig {
    if (p.kind !== 'ollama') return p
    if (config.contextLimit !== true) return p
    const cap = config.contextWindow || p.contextWindow
    return { ...p, contextWindow: Math.max(2048, Math.min(p.contextWindow || cap, cap)) }
  }

  /**
   * 服务端亲口说了「我只有 N 个 token」：记进配置，
   * 下次开新会话不用再撞一次 400 才知道真实上限。
   */
  private async rememberCtx(providerId: string, ctx: number): Promise<void> {
    try {
      const config = await loadConfig()
      const target = config.providers.find((p) => p.id === providerId)
      if (!target || (target.contextWindow || 0) <= ctx) return
      await saveConfig({
        ...config,
        providers: config.providers.map((p) => (p.id === providerId ? { ...p, contextWindow: ctx } : p))
      })
    } catch {
      // 配置写不进去只影响下次的初始值，不影响本次运行
    }
  }

  /**
   * 这个模型不吃原生工具调用：记进配置（= 设置页里那个「模型不支持原生工具调用」勾选）。
   * 不记的话，每发一条消息都要先撞一次 400 再降级，白等一整轮。
   */
  private async rememberNoTools(providerId: string): Promise<void> {
    try {
      const config = await loadConfig()
      const target = config.providers.find((p) => p.id === providerId)
      if (!target || target.noTools) return
      await saveConfig({
        ...config,
        providers: config.providers.map((p) => (p.id === providerId ? { ...p, noTools: true } : p))
      })
    } catch {
      // 写不进去也只是一次性的多一次重试，不影响本轮
    }
  }

  /**
   * 本轮实际能用的窗口大小。
   *
   * 「限制上下文」关掉时（默认）不拿全局值压小，直接按模型真实窗口跑：
   * 在线 API 的窗口本来就大，没必要自己先砍一刀；本地 16K 的模型也让它把 16K 用满，
   * 真装不下时靠自动压缩 + 上一轮的 400 兜底处理。
   * 打开开关才按用户填的值取小 —— 那是为了省显存 / 省 token 花销。
   */
  private ctxWindowFor(provider: ProviderConfig, config: AppConfig, real: number): number {
    const base = real > 0 ? real : Math.max(0, Math.round(Number(provider.contextWindow) || 0)) || 32768
    if (config.contextLimit !== true) return Math.max(2048, base)
    return Math.max(2048, Math.min(config.contextWindow || base, base))
  }

  private async runLoop(
    session: Session,
    config: AppConfig,
    provider: ProviderConfig,
    signal: AbortSignal,
    options?: RunOptions
  ): Promise<void> {
    /**
     * 历史里已经有图片（重新生成 / 改完再发 / 断点续跑）：这一轮同样得能看图。
     * 新发消息的路径已经在 withAttachments 里切过了，这里只兜「图上一次就在会话里」的情况。
     */
    if (
      this.canSwitchToVision(provider) &&
      !this.canSeeImages(provider) &&
      session.messages.some((m) => m.images?.length)
    ) {
      const switched = await this.ensureVision(session.id, provider)
      if (switched) provider = switched
    }
    // 非交互模式下的审批决策：不弹框，按策略确定性返回 allow/deny
    const nonInteractive = options?.nonInteractive === true
    /** 本次生效的审批模式：会话级覆盖优先（批准计划后只有这个会话解锁） */
    const mode = modeOf(config, session)
    const approveDecision = (input: Parameters<typeof decideApproval>[0]): boolean => {
      const d = decideApproval(input)
      if (d === 'allow') return true
      if (d === 'deny') return false
      // d === 'ask'：非交互下没有窗口可弹。
      // 高危操作永不自动放行（安全底线），普通操作按策略收口。
      if (input.high) return false
      return options?.approvalPolicy === 'allow'
    }
    // 预算按「服务端真实可用的上下文」算：Ollama 可能被模型自身上限截断，llama.cpp 以 /props 为准；
    // 再跟「软件设置 → 上下文」的上限取小（只有开了「限制上下文」才取）
    const realCtx = await effectiveContextWindow(provider)
    let ctxWindow = this.ctxWindowFor(provider, config, realCtx)
    // Ollama 的 num_ctx 由 provider.contextWindow 决定，套上全局上限后再发请求，
    // 否则「软件设置里调到 16K」只影响预算，服务端还是按 32K 占显存
    const chatProvider =
      provider.kind === 'ollama' ? { ...provider, contextWindow: ctxWindow } : provider
    /** 自动切换后当前实际在用的供应商：算预算、写系统提示都按它来 */
    let runProvider = chatProvider
    // 未选择工作区时，默认使用软件根目录下的 workspace/
    // 定时任务可以钉死一个工作区：档案是给某个仓库用的，不该跟着界面当前选择跑
    const forcedWs = options?.workspace ? path.resolve(options.workspace) : null
    if (forcedWs) await fs.mkdir(forcedWs, { recursive: true }).catch(() => undefined)
    const workspace = forcedWs ?? (await effectiveWorkspace(config))

    /**
     * 「以后都这样」的长期放行：一次读盘，之后全用内存判断。
     * 放在这里而不是构造时读：用户可能在设置页刚清空过授权，重新运行就该按新的算。
     */
    if (!this.grants) this.grants = await loadGrantSet().catch(() => new Set<string>())

    // 会话绑定的档案：人格、工具白名单、记忆命名空间都从这里来
    const profile = session.agentId ? await getAgent(session.agentId) : null
    // ownMemory 默认开：档案之间的经验混在一起，比没有记忆更糟
    const memNs = profile && profile.ownMemory !== false ? profile.id : null

    /**
     * sessionStart：这一轮开始时跑一次，stdout 进系统提示。
     * 放在档案解析之后，钩子能拿到 agentId（比如「审查」角色只查 diff，「巡检」角色查全量）。
     */
    const startHook = await runHooks('sessionStart', {
      workspace,
      sessionId: session.id,
      agentId: profile?.id ?? null
    })
    if (startHook.warning) this.emit(session.id, { type: 'hint', message: startHook.warning })
    /**
     * 工作区钩子被跳过时说清楚，否则用户会以为「我明明配了钩子怎么没跑」。
     * 一个会话只说一次：这是配置问题，不是每轮都要提醒的临时状态。
     */
    if (startHook.skippedWorkspace && !this.hookNotice.has(session.id)) {
      this.hookNotice.add(session.id)
      this.emit(session.id, {
        type: 'hint',
        message: `这个仓库带了 ${startHook.skippedWorkspace} 条钩子脚本，出于安全考虑没有执行（项目里的 .roroto/hooks.json 随仓库走）。确认信任它的话，去「软件设置 → 审批与执行」打开「执行工作区里的钩子」。`
      })
    }
    const hookNote = startHook.context ?? null
    /**
     * 本轮的时间戳：一轮之内固定不变。
     *
     * 每步重新取时间看起来更「准」，但会让提示前缀每一步都变一次 —— 缓存全废。
     * 一轮对话通常几分钟，用户问「今天几号 / 现在几点」时这个精度足够。
     */
    const clockNote = nowText()

    // 软件设置里的两个能力开关：关掉后工具不发给模型，提示词里也不再教它用
    const webOn = config.webSearch !== false
    const memoryOn = config.memory !== false
    /**
     * 打开自动调用开关的技能：每轮跑之前读一次盘。
     * 关了开关的技能不读正文（列表里只有名字和说明），这是「渐进披露」的关键 ——
     * 技能正文动辄几千字，全塞进系统提示等于每轮都付一遍 prefill。
     */
    const skillsOn = await enabledSkills().catch(() => [])
    // 小模型走精简提示 + 精简工具集，否则它会只顾着说「好的，我正在搜索」
    const small = isSmallModel(provider.model)
    const mcpOn = config.mcpEnabled !== false
    const disabled = (name: string): boolean =>
      (name === 'web_search' || name === 'web_fetch')
        ? !webOn
        : name === 'remember'
          ? !memoryOn
          : name === 'use_skill'
            ? skillsOn.length === 0
            : false
    // MCP 工具是运行时从外部服务读的：没有配置就是空数组，不会占上下文
    const extra = small || !mcpOn ? [] : await mcpToolSpecs().catch(() => [])
    // 档案的工具白名单：白名单外的工具对它等于不存在，而不是「调了会被拒」
    const allowed = profile?.tools?.length ? new Set(profile.tools) : null
    // 可以交接的对象：至少要有另一个档案，否则这个工具对它没有意义。
    // 规则在 shared/roster：排除自己；没有档案的会话也看不到「主控」（它自己就是主控）
    const roster = handoffTargets(await listAgents().catch(() => []), profile?.id ?? null)
    const keep = (name: string): boolean => {
      if (disabled(name)) return false
      // 非交互（定时任务）没人能回答问题，留着只会让这一轮卡住
      if (nonInteractive && name === 'question') return false
      if (name === 'handoff' && roster.length === 0) return false
      if (!allowed) return true
      // 计划和派活属于编排能力，任何档案都得有，否则它没法把多步任务干完；
      // use_skill 同理：用户打开开关就是在全局层面许可了它，不该被某个档案的白名单挡掉
      return (
        allowed.has(name) ||
        name === 'update_todos' ||
        name === 'task' ||
        name === 'handoff' ||
        name === 'use_skill'
      )
    }
    // 全量工具留着，自动切换到更大的模型时用得上
    const fullTools = [...toolSpecs, ...extra].filter((t) => keep(t.name))
    const tools = fullTools.filter((t) => !small || LITE_TOOLS.has(t.name) || isMcpTool(t.name))

    // 跨会话记忆：默认每个工作区一份；绑了档案就写它自己那份
    let memory = memoryOn ? await memoryForPrompt(workspace, memNs) : null
    // 共享黑板：同一个工作区所有档案共用的一页便签，只带上面能装下的那几条
    let boardText = await boardForPrompt(workspace).catch(() => '')
    // 会话级便签：只属于这一次对话，跑完就作废
    let scratchText = await scratchForPrompt(session.id).catch(() => '')
    // 项目级规则（AGENTS.md / CLAUDE.md）：只读发现，向上逐层找，最近的文件优先
    const instructions = await findInstructions(workspace)
    // 项目级权限规则（roroto.json 的 permissions）：执行引擎用的机器可读规则
    const permRules = await loadProjectPermissions(workspace)
    /** 本轮改过的文件：只有动过代码才值得跑验证 */
    const touched = new Set<string>()
    // resume 还原的「上次改过的文件」接进来：模型从断点续跑时，这些文件也算「动过」，值得接着验证
    const priorTouched = this.resumeTouched.get(session.id)
    if (priorTouched) {
      for (const rel of priorTouched) {
        // checkpoint 里存的是相对工作区路径，还原成绝对路径
        const abs = path.resolve(workspace, rel)
        touched.add(abs)
      }
      this.resumeTouched.delete(session.id)
    }
    // 重开会话后引擎内存里没有计划：从历史里还原最后一次 update_todos，
    // 否则「计划里还有未完成项」这个自动续跑判断就永远不成立
    if (!this.todos.has(session.id)) {
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const call = session.messages[i].toolCalls?.find((c) => c.name === 'update_todos')
        if (call) {
          this.todos.set(session.id, normalizeTodos(call.args.items))
          break
        }
      }
    }
    /** 自动验证失败的结论，下一轮塞进系统提示让模型继续修 */
    let verifyNote: string | null = null
    let verifyRounds = 0
    /** 诊断回灌收口：收工前还有编译错误就再推一轮，计数上限防止死循环 */
    let diagRounds = 0
    let diagNote: string | null = null
    /**
     * 「该查却没查」只提示一次：项目没装 typescript 时每次写文件都提示会白占上下文，
     * 而模型只需要知道一次「别把没报错当成检查通过」。
     */
    let diagGapNoted = false
    /** 「只说不做」的纠正次数，最多两次，避免死循环 */
    let nudges = 0
    /** 空回复的纠正次数，最多一次 */
    let blanks = 0
    /**
     * 输出被截断的纠正次数。本地 16K 窗口下 max_tokens 只有 4096，
     * 模型想一次性把整段代码贴进回复就必然被切在半句——这不是「写完了」。
     */
    let truncNudges = 0
    /** 「只在回复里贴代码、文件一个字没改」的纠正次数 */
    let pasteNudges = 0
    /** 本次运行真正执行过的工具调用数：用来区分「没动手」和「查了但没落盘」 */
    let toolsRun = 0
    let nudgeNote: string | null = null

    /**
     * 自动续跑。
     *
     * 模型经常「早退」：写完一两个文件就说「接下来我会…」，或者计划里还留着没勾掉的项，
     * 这一轮就结束了 —— 引擎把这当成「它认为做完了」，直接把控制权交回用户，
     * 用户只能一次次手点「继续」。下面这些状态就是用来把这一轮自己接上去的。
     */
    const autoContinue = config.autoContinue !== false
    /** 一次提问最多连跑多少步：开着自动续跑时放宽到 4 倍，但仍有硬上限，防止真死循环 */
    const stepBudget = autoContinue
      ? Math.min(600, Math.max(config.maxSteps, config.maxSteps * 4))
      : config.maxSteps
    /** 已自动续跑次数上限（每次续跑之间必须真的有产出，见下面的 sinceContinue 判断） */
    const MAX_CONTINUE = 12
    /** 一轮里重复动作被拦下这么多次，就不再让它自己折腾了 */
    const MAX_REPEAT_BLOCKS = 3
    let continues = 0
    /** 上次续跑之后执行过多少次工具调用：一次都没动就说明再推也没用 */
    let sinceContinue = 0
    let continueNote: string | null = null
    /** 本次运行里有没有重写过计划：老计划留在历史里，不该拿来判断「这次」做没做完 */
    let planTouched = false
    /** 最近若干次工具调用的签名，用来抓「同一个命令反复轮询」 */
    const recentCalls: string[] = []
    let pollWarned = false
    /**
     * 重复调用护栏（动作层面的空转）。
     * 和上面的 pollWarned 不是一回事：那只盯 run_shell 轮询、只提醒一次；
     * 这里按「工具 + 参数 + 结果是否变化」判，达到阈值直接不执行，
     * 否则小模型会把同一个 web_search 发到几十次。
     */
    const callGuard = createToolCallGuard()
    /** 本批次被护栏拦下的次数：连着拦说明它自己走不出去，该停了 */
    let repeatBlocked = 0
    let repeatHinted = false
    /** 护栏判定「这一轮已经不会自己走出去了」：跳出 step 循环，而不是继续空转 */
    let repeatHalted = false

    /**
     * 用量闸门的状态。runTokens 只算这一次运行（含自动续跑，因为是同一个任务），
     * dayTokens 是今天的累计，跨天由 main/quota 自己清零。
     * waived 记录用户已经点过「继续，本轮不再问」——一次运行只问一次，
     * 否则每步都弹一次，人会直接把这个功能关掉。
     */
    const quotaLimits = {
      perRun: parseLimit(config.tokenLimitPerRun),
      perDay: parseLimit(config.tokenLimitPerDay)
    }
    let runTokens = 0
    let dayTokens = await dayUsage().catch(() => 0)
    let quotaWaived = false
    let quotaWarned = false

    /**
     * 结构化 checkpoint：把「计划 + 改过的文件 + 验证结论」独立落盘，不随对话压缩失真。
     * 正常完成 / 交还用户时标 done 并清除；抛异常时保留 running 作为「中断」标记，
     * 下次启动据此提示恢复。写盘失败静默吞掉（checkpoint 是兜底，不拖垮主流程）。
     */
    const checkpointStartedAt = Date.now()
    const persistCheckpoint = (status: Checkpoint['status']): void => {
      void saveCheckpoint({
        sessionId: session.id,
        workspace,
        status,
        todos: this.todos.get(session.id) ?? [],
        touched: [...touched].map((abs) => {
          try {
            return path.relative(workspace, abs).replace(/\\/g, '/') || abs
          } catch {
            return abs
          }
        }),
        verifyNote,
        lastCalls: recentCalls.slice(-10),
        continues,
        createdAt: checkpointStartedAt,
        updatedAt: Date.now()
      })
    }
    persistCheckpoint('running')

    /**
     * 上一步合并出来的信号：每步开头摘掉挂在上面的监听。
     * 不摘的话，跑 600 步就往整轮 signal 上挂 600 对，Node 会打 MaxListeners 警告。
     */
    let prevStep: CombinedSignal | null = null

    for (let step = 0; step < stepBudget; step++) {
      if (signal.aborted) throw new Error('已取消')
      prevStep?.dispose()

      /**
       * 每一步一个新的急停开关。上一轮如果被插话打断，那个开关是断的，
       * 不能拿来继续用 —— 不然这一轮一进工具就立刻又抛「被打断」。
       */
      const cut = new AbortController()
      this.stepCut.set(session.id, cut)
      /** 工具执行时同时听两个信号：整轮停止（signal）和这一步的插话（cut） */
      const combined = combineSignals(signal, cut.signal)
      prevStep = combined
      const stepSignal = combined.signal

      /**
       * 攒着的插话先落进对话，再发请求。
       * 顺序不能反：先发请求的话，模型拿到的还是上一版历史，等于白问一遍。
       */
      await this.drainSteers(session)

      /**
       * 用量闸门。放在发请求之前：拿到结果时这些 token 已经花出去了，事后拦没有意义。
       * 撞上限不是硬断 —— 交互模式问一句，自动模式（定时任务/交接）没人可问才停。
       */
      const verdict = checkQuota(quotaLimits, { run: runTokens, day: dayTokens })
      if (verdict.level === 'warn' && !quotaWarned && !quotaWaived) {
        quotaWarned = true
        this.emit(session.id, {
          type: 'hint',
          message: `${quotaText(verdict)}，接近上限了。`
        })
      }
      if (verdict.level === 'stop' && !quotaWaived) {
        if (nonInteractive) {
          this.emit(session.id, { type: 'hint', message: quotaAutoStopNote(verdict) })
          // 保留 running：这不是「做完了」，下次启动应该能接着干
          persistCheckpoint('running')
          return
        }
        const answer = await this.askQuota(session.id, verdict)
        if (answer === 'deny') {
          this.emit(session.id, { type: 'hint', message: quotaStopNote(verdict) })
          persistCheckpoint('running')
          return
        }
        if (answer === 'always') quotaWaived = true
      }

      // 切换过供应商后，提示词和「小模型」判断都要按新模型来
      const smallNow = isSmallModel(runProvider.model)
      // 小模型走极简工具表；窗口紧张的本地模型走「精简 + toolbox 网关」；其余全量
      const pick = smallNow ? { list: tools, hidden: [] as ToolSpec[] } : pickTools(fullTools, ctxWindow)
      const stepTools = pick.list
      const hiddenSpecs = pick.hidden
      // 输出也要留位置：窗口是「提示 + 生成」共用的，全给历史会把回答挤断
      const outputReserve = Math.min(4096, Math.max(512, Math.floor(ctxWindow * 0.25)))

      const promptFor = (summaryText: string | null | undefined): string => {
        const base = smallNow
          ? litePrompt(workspace, {
              web: webOn,
              remember: memoryOn,
              instructions,
              summary: summaryText,
              persona: profile?.role ?? null,
              handoffTo: roster.map((a) => a.name)
            })
          : systemPrompt(workspace, runProvider, {
              memory,
              board: boardText,
              scratch: scratchText,
              instructions,
              summary: summaryText,
              web: webOn,
              remember: memoryOn,
              persona: profile?.role ?? null,
              handoffTo: roster.map((a) => ({ name: a.name, role: a.role })),
              skills: skillsOn.map((s) => ({ name: s.name, desc: s.desc })),
              toolbox: hiddenSpecs.length > 0
            })
        return mode === 'plan' ? `${base}\n\n${PLAN_MODE_NOTE}` : base
      }
      /**
       * 本轮才成立的环境信息（时间 / 钩子 / 验证 / 续跑）：拼在最后一条 user 消息尾部，
       * 不进 system 提示 —— 见 runtimeBlock 上的说明，这是让前缀缓存能命中的前提。
       */
      const tailNote = runtimeBlock({
        clock: clockNote,
        hook: hookNote,
        verify: verifyNote,
        diag: diagNote,
        nudge: nudgeNote,
        cont: continueNote
      })

      /**
       * 系统提示和工具定义同样占窗口，但以前它们不算进预算：
       * 16K 的本地模型，光「11 个工具的 JSON Schema + 系统提示」就吃掉三四千，
       * 于是历史明明按 70% 裁过，整个请求还是超了服务端上限，直接 400。
       */
      const overheadOf = (prompt: string, extra = ''): number =>
        Math.ceil((estimateTokens(prompt) + estimateTokens(extra) + toolSpecsTokens(stepTools)) * 1.1) + 256

      /** 在这个窗口下，历史最多还能放多少 token */
      const capOf = (ctx: number, prompt: string, summarized: number): number => {
        const usable = Math.floor((ctx - overheadOf(prompt, tailNote) - outputReserve) * 0.95)
        return Math.max(600, Math.min(Math.floor(ctx * 0.7), usable) - summarized)
      }

      // 自动压缩：历史快撑满窗口时，把前段对话压成摘要，只把最近几轮原样带上。
      // 阈值必须按「历史真正能放多少」算 —— 以前拿整窗预算当阈值，而这个预算永远大于
      // 实际能放的历史，于是压缩一次都不会触发，用户只看到消息被悄悄裁掉。
      const capFor = (text: string | null | undefined, summarized: number): number =>
        capOf(ctxWindow, promptFor(text), summarized)
      const cachedSummary = this.summaries.get(session.id) ?? null
      let summary = config.autoCompact === false ? null : cachedSummary
      if (config.autoCompact !== false) {
        // 第一轮按 75% 的阈值：留点余量，别等真的爆了才压，那时服务端已经在截断了
        summary = await this.summarizeIfNeeded(
          session,
          runProvider,
          capFor(summary?.text, summary?.tokens ?? 0),
          ctxWindow,
          signal
        )
        // 压完还是装不下（最近几轮自己就很长，比如一次贴进大段日志）：
        // 再压一轮更狠的，而不是让 compact() 一声不响把前面的对话丢掉
        for (let i = 0; i < 2; i++) {
          const covered = summary?.upTo ?? 0
          const room = capFor(summary?.text, summary?.tokens ?? 0)
          if (messagesTokens(session.messages.slice(covered)) <= room) break
          const deeper = await this.summarizeIfNeeded(session, runProvider, room, ctxWindow, signal, {
            force: true,
            keep: 4
          })
          if (!deeper || deeper.upTo <= covered) break
          summary = deeper
        }
      }
      const summarized = summary ? summary.tokens : 0
      const rest = summary ? session.messages.slice(summary.upTo) : session.messages
      const promptText = promptFor(summary?.text)
      // 提示只对紧接的这一轮有效：用过就清掉，别让它一直挂在系统提示里
      nudgeNote = null
      continueNote = null
      const overhead = overheadOf(promptText, tailNote)

      const historyCap = (ctx: number): number =>
        Math.max(600, Math.min(Math.floor(ctx * 0.7), Math.floor((ctx - overhead - outputReserve) * 0.95)) - summarized)

      const buildMessages = (cap: number): ChatMessage[] => {
        // 先折叠较早的工具输出，再按预算裁剪：这样 compact 丢掉的是整轮对话，
        // 而不是「把宝贵的轮次换成几屏早就没用的 grep 结果」
        const history = compact(maskObservations(rest, cap), cap)
        const list: ChatMessage[] = [
          { id: 'system', role: 'system', content: promptText, createdAt: Date.now() },
          ...history.filter((m) => m.role !== 'system')
        ]
        // Ollama 不接受连续两条 assistant；nudge / 自动验证重试时历史末尾可能正好是它
        const head = list[list.length - 1]
        if (head && head.role === 'assistant') {
          list.push({ id: 'continue', role: 'user', content: '（继续）', createdAt: Date.now() })
        }
        // 本轮环境信息挂在最后一条 user 消息尾部。只存在于这次请求体里，不写回 session.messages，
        // 否则时间戳会在历史中间留下一个永久的断点，下一轮又得从头 prefill。
        let attached = false
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].role !== 'user') continue
          list[i] = { ...list[i], content: `${list[i].content}\n\n${tailNote}` }
          attached = true
          break
        }
        if (!attached) {
          list.push({ id: 'runtime', role: 'user', content: tailNote, createdAt: Date.now() })
        }
        return list
      }

      let stepCap = historyCap(ctxWindow)
      let messages = buildMessages(stepCap)

      const messageId = store.newId()
      this.emit(session.id, { type: 'assistant_start', messageId })

      const gate = createDeltaGate((t) =>
        this.emit(session.id, { type: 'delta', messageId, text: t })
      )
      // 小模型陷入复读循环时，界面不再跟着滚屏；落库前还会把尾巴剪掉
      const loopGuard = createLoopGuard()

      let attempt: { provider: ProviderConfig; result: StreamResult } | null = null
      let spoke = false
      // 撞上「超出上下文」时自动压缩历史重试：这类错误换供应商没用，但压小历史就能过，
      // 不该把一句 400 甩给用户（尤其是「继续」这种什么都没干就失败的情况）
      for (let retry = 0; ; retry++) {
        // 让界面知道这一轮真实吃了多少上下文（估算值，中文≈1 字 1 token，代码≈3.6 字符 1 token）
        this.emit(session.id, {
          type: 'context',
          used:
            messages.reduce(
              (n, m) =>
                n +
                estimateTokens(m.content || '') +
                (m.toolArgs ? estimateTokens(JSON.stringify(m.toolArgs)) : 0),
              0
            ) + toolSpecsTokens(stepTools),
          window: ctxWindow,
          messages: messages.length,
          compacted: Boolean(summary)
        })

        try {
          attempt = await this.chatWithFallback(
            session.id,
            config,
            runProvider,
            messages,
            stepTools,
            signal,
            (t) => {
              spoke = true
              if (loopGuard.push(t)) gate.push(t)
            }
          )
          break
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err ?? '')
          if (signal.aborted || spoke || !isContextOverflow(msg)) throw err
          /**
           * 已经砍过两次历史还是超窗：别再甩一句「HTTP 400」了事。
           * 用户看到的应该是一个能动手的下一步，而不是一串服务端原文。
           */
          if (retry >= 2) {
            throw new Error(
              `${msg}\n这轮对话的历史已经压到极限。可以：① 到「软件设置 → 上下文」把上限调到 8192，引擎会按更小的预算压缩历史；② 换上下文更大的模型；③ 新开一个会话重说需求。`
            )
          }

          const proved = contextLimitOf(msg)
          // 服务端报的上限比我们以为的小：以后都按它的来
          if (proved > 0 && proved < ctxWindow) {
            ctxWindow = Math.max(2048, proved)
            void this.rememberCtx(runProvider.id, ctxWindow)
          }
          // 估算有误差时上限可能正好相等，所以无论成立与否都再砍一半历史试一次
          stepCap = Math.max(600, Math.floor(historyCap(ctxWindow) * 0.5))
          messages = buildMessages(stepCap)
          this.emit(session.id, {
            type: 'hint',
            message:
              `这次请求超出了模型的上下文窗口${proved > 0 ? `（服务端只有 ${proved} tokens）` : ''}，` +
              `已自动把早期对话再压掉一部分重试。若反复出现，到「软件设置 → 上下文」调小该值，或换窗口更大的模型。`
          })
        }
      }
      gate.flush()
      if (!attempt) throw new Error('模型没有返回结果')
      const result = attempt.result
      // 真的换了供应商：后面的步骤直接用新的，避免每轮都先撞一次墙
      if (attempt.provider.id !== runProvider.id) {
        runProvider = attempt.provider
        const real = await effectiveContextWindow(runProvider)
        ctxWindow = this.ctxWindowFor(runProvider, config, real)
      }

      // 用量统计：本地服务不给 usage 就跳过，不编数字
      if (result.usage && (result.usage.prompt || result.usage.completion)) {
        const delta: TokenUsage = {
          prompt: result.usage.prompt,
          completion: result.usage.completion,
          cached: result.usage.cached,
          promptN: result.usage.promptN,
          promptMs: result.usage.promptMs,
          costUsd: estimateCost(attempt.provider.model, result.usage)
        }
        try {
          const total = await store.bumpUsage(session.id, delta)
          const cost = (total.costUsd ?? 0) > 0 ? total.costUsd : undefined
          // genMs 是引擎上报的纯解码耗时；没有就留给界面用墙钟兜底
          this.emit(session.id, { type: 'usage', usage: { ...total, costUsd: cost }, last: delta, genMs: result.genMs })
        } catch {
          // 统计失败不能影响对话本身
        }
        // 用量闸门的计数：本次运行 + 今日累计（跨天由 quota 模块清零）。
        // 写在 try 外面：store 写失败也不能让闸门漏计，否则上限会失效。
        runTokens += delta.prompt + delta.completion
        dayTokens = await bumpDayUsage(delta).catch(() => dayTokens + delta.prompt + delta.completion)
      }

      const parsed = parseTextToolCalls(result.text)
      const toolCalls = result.toolCalls.length ? result.toolCalls : parsed.calls
      // 只有纯文本回答才剪尾巴：文本型工具调用被剪断会变成一次执行不了的坏调用
      const cleaned = toolCalls.length ? { text: result.text, trimmed: false } : loopGuard.apply(result.text)
      const content = toolCalls.length ? result.text : parseTextToolCalls(cleaned.text).cleanText
      if (cleaned.trimmed) {
        this.emit(session.id, {
          type: 'hint',
          message:
            '检测到模型开始整段复读，已自动截断后面的重复内容（本地小模型在低温度 + 长上下文下容易这样）。' +
            '想要完整回答可以换更大的模型、把上下文降到 8192，或到设置里把温度调到 0.4 左右。'
        })
      }

      const assistantMessage: ChatMessage = {
        id: messageId,
        role: 'assistant',
        content,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        createdAt: Date.now()
      }
      // 空转的回复（「好的，请稍等」或干脆空字符串）不入库：留着只会让模型照着学，
      // 而且会让下一轮历史以 assistant 结尾（Ollama 会直接报 400）
      const idle =
        !toolCalls.length && touched.size === 0 && (!content.trim() || claimsAction(content))
      if (!idle) {
        session.messages.push(assistantMessage)
        await store.appendMessages(session.id, [assistantMessage])
      }
      this.emit(session.id, { type: 'assistant_end', messageId, content, toolCalls })

      if (!toolCalls.length) {
        const blank = !content.trim()
        const promised = !blank && claimsAction(content)
        // 推理模型（MiMo / R1 蒸馏等）会把整份输出预算花在 <think> 上，
        // 正文一个字都没有。这时重跑一次也一样空，只会白等两轮。
        const thoughtOnly = blank && Boolean(result.reasoning?.trim())
        if (thoughtOnly) {
          this.emit(session.id, {
            type: 'hint',
            message:
              '这个模型把本次输出预算全用在「思考」上了，没来得及给正文。' +
              '本地 llama.cpp 实例已给思考封顶（512 tokens）；如果你用的是自己启动的服务，' +
              '请加 --reasoning-budget 512（或 --reasoning off），或把输出上限调大后重试。'
          })
        }

        // 空回复：一个字都没给，重跑一次让它把结果说出来（思考耗尽的不算，重来也还是空）
        if (blank && !thoughtOnly && blanks < 1) {
          blanks += 1
          nudgeNote =
            '你上一轮什么都没输出。请直接给出结果：用两三句话总结上面的工具结果；如果还没拿到结果，就现在调用工具去做。'
          continue
        }
        /**
         * 输出撞到上限被硬截断（finish_reason=length）。
         *
         * 这是「静默失败」最常见的一种：模型想把整段代码贴进回复，写到一半被 max_tokens 切断，
         * 而引擎以前只看「有没有工具调用」——没有就当它做完了，直接收工。用户看到的是
         * 「什么提示都没有，文件也没改」。这里不再放行，逼它改成落盘。
         */
        const cut = result.finishReason === 'length'
        /**
         * 只有「在写代码」的场合才把截断当成没干完。
         * 用户问「解释一下 X」时，长答案被切也是截断，但逼它去写文件毫无意义。
         */
        const looksCoded = content.includes('```')
        if (cut && (toolsRun > 0 || looksCoded) && truncNudges < 2) {
          truncNudges += 1
          nudgeNote =
            '你上一轮的输出撞到了输出上限，被截断在中间，代码并没有写完（也没有写进文件）。' +
            '不要继续在回复里贴整段代码：用 write_file 直接写文件，改动多用 edit_file 分几次完成。' +
            '回复里只用一两句话说明改了哪些文件。'
          continue
        }
        /**
         * 查了一圈、却一个字都没落盘：只在聊天里贴代码等于什么都没做。
         * 必须逼它落盘，否则这一轮会被当成「正常完成」，用户以为任务做完了。
         */
        if (!cut && looksCoded && touched.size === 0 && content.length >= 600 && pasteNudges < 2) {
          pasteNudges += 1
          nudgeNote =
            '你刚才只在回复里贴了代码或方案，没有调用 write_file / edit_file —— 文件其实一个字都没改。' +
            '现在直接动手：新建文件用 write_file，改现有文件用 edit_file，写完再回一两句话总结。'
          continue
        }
        // 「好的，我正在搜索，请稍后」——嘴上答应了，一个工具都没调。逼它重来，最多两次
        if (touched.size === 0 && nudges < 2 && promised) {
          nudges += 1
          nudgeNote =
            `你上一轮只回复了「${content.trim().slice(0, 80)}」，没有调用任何工具，等于什么都没做。` +
            '现在立刻调用合适的工具把事做完；确实不需要工具时，就直接给出完整答案，不要承诺「稍后」。'
          continue
        }
        // 逼了两次还是一样：这不是用户的错，得告诉他为什么
        if (touched.size === 0 && nudges >= 2 && promised) {
          this.emit(session.id, {
            type: 'hint',
            message:
              `当前模型（${runProvider.name} · ${runProvider.model}）连续 ${nudges + 1} 次只回「${content
                .trim()
                .slice(0, 40)}」，却没有调用任何工具，所以拿不到真实结果。` +
              '这类小模型常常不会用工具，建议换 7B 以上的模型（本地 llama.cpp 或在线 API）。'
          })
        }

        /**
         * 诊断收口：模型说做完了，但本轮动过的 TS 文件还有编译错误，就再推一轮
         * 让它修，最多两次。这和 verify 是两回事——verify 跑的是项目测试/构建，
         * 这里是 tsserver 的增量类型错误，几百毫秒就能拿到，放在「跑重命令」之前更便宜。
         */
        if (
          config.diagnoseOnWrite !== false &&
          touched.size > 0 &&
          diagRounds < 2
        ) {
          // 不再只筛 TS：Python/Go/Rust/Java 走项目自带的检查命令，也能在收口前拿到错误
          const checkable = [...touched]
          if (checkable.length) {
            const report = await diagnoseReport(workspace, checkable)
            if (report.diags.length) {
              diagRounds += 1
              diagNote = formatDiagnostics(report.diags, { workspace, filesWritten: checkable.length })
              touched.clear()
              continue
            }
            /**
             * 没查成不等于查过了。收口前的这一轮如果静默跳过，
             * 模型会以为「类型没问题」直接交差 —— 把没做检查这件事说清楚。
             */
            if (!diagGapNoted && (report.skipped === 'no-typescript' || report.skipped === 'unavailable')) {
              diagGapNoted = true
              diagNote = formatDiagGap(report.skipped)
              continue
            }
          }
        }

        // 模型认为做完了：如果本轮动过代码，先自己跑一遍测试/构建再交差
        const canVerify =
          config.autoVerify !== false &&
          mode !== 'readonly' &&
          mode !== 'plan' &&
          touched.size > 0 &&
          verifyRounds < 2
        if (canVerify) {
          // 带上改动清单：有 vitest/jest 就只跑相关用例，没有就退回项目脚本
          const plan = await detectVerifyPlan(workspace, [...touched])
          if (plan) {
            verifyRounds += 1
            this.emit(session.id, { type: 'verify_start', command: plan.command, label: plan.label })
            const result = await runVerify(workspace, plan, signal)
            this.emit(session.id, {
              type: 'verify_result',
              command: plan.command,
              label: plan.label,
              ok: result.ok,
              output: result.output,
              durationMs: result.durationMs
            })
            if (!result.ok) {
              // 失败就带着结论再走一轮，最多两次，避免修不好时无限循环
              verifyNote = `命令：${plan.command}（${plan.label}）\n${result.output}`
              touched.clear()
              continue
            }
            // 验证通过也不在这里直接收工：接着走下面的「任务是不是真做完了」判断
          }
        }

        /**
         * 走到了这里：模型给了文字、没调工具，默认理解成「它认为做完了」——以前直接 return，
         * 把控制权交回用户，于是用户只能一遍遍手点「继续」。但模型过早收工很常见：
         * 计划里还留着没勾掉的项，或者刚说完「接下来我会…」就停了。
         * 开着自动续跑时在内部再推一轮，用户看到的是对话自己往下走，直到工程做完。
         *
         * 防死循环：只有在上一轮续跑之后**真的干过活**（sinceContinue > 0）才继续推，
         * 否则说明不是「还没做完」，而是模型确实推不动了，继续也只是空转。
         */
        if (autoContinue && continues < MAX_CONTINUE) {
          const pending = (this.todos.get(session.id) ?? []).filter((t) => t.status !== 'completed')
          // 老会话里可能躺着一份早就过期的计划：只有本次真的动过计划或文件，
          // 才把「还有未完成项」当作任务没做完，否则用户问一句闲话都会被反复续跑
          const planLive = planTouched || touched.size > 0 || continues > 0
          const why = pending.length && planLive
            ? `计划里还有 ${pending.length} 项没完成：${pending
                .slice(0, 5)
                .map((t) => `「${t.content}」`)
                .join('、')}。继续把它们做完；确实不需要做了，就用 update_todos 把对应项标成 completed。`
            : promisesNextStep(content)
              ? '你上一轮说接下来要继续做，但这一轮没有再调用任何工具。现在直接动手，把剩下的事做完。'
              : null
          if (why) {
            if (continues > 0 && sinceContinue === 0) {
              this.emit(session.id, {
                type: 'hint',
                message:
                  '任务看起来还没结束，但模型连续两轮没有做任何实际动作，先停在这里。' +
                  '可以再发一条消息说清下一步，或换一个更强的模型。'
              })
            } else {
              continues += 1
              sinceContinue = 0
              nudges = 0
              blanks = 0
              continueNote = why
              this.emit(session.id, {
                type: 'auto_continue',
                round: continues,
                reason: pending.length && planLive ? '计划里还有未完成的项' : '模型说要继续但停了下来'
              })
              continue
            }
          }
        }

        // 正常收工：任务完成，清除 checkpoint（不是中断，下次启动不该提示恢复）
        persistCheckpoint('done')
        await clearCheckpoint(session.id)
        /**
         * 把结论写清楚再交还控制权。
         *
         * 「改了 N 个文件」和「跑完但一个字没改」在界面上以前长得一模一样，
         * 用户只能猜这一轮到底完成了还是被中断了。这里如实给出两种结论。
         */
        this.finishNotes.set(session.id, {
          note:
            touched.size > 0
              ? `本轮结束：改动了 ${touched.size} 个文件`
              : toolsRun > 0
                ? '本轮结束，但没有改动任何文件 —— 如果你要的是改代码，说明任务还没做完'
                : cut
                  ? '本轮结束，但回答撞到输出上限被截断了（可以让我接着写，或换输出上限更大的模型）'
                  : '本轮结束',
          ok: touched.size > 0 || (toolsRun === 0 && !cut)
        })
        return
      }

      // 派子 agent 时的运行参数：子 agent 不继承「派活」「计划」「提问」这三个工具，避免自己再派下去 / 反客为主提问
      const subCtx: SubCtx = {
        session,
        sessionId: session.id,
        config,
        provider: runProvider,
        workspace,
        tools: (isSmallModel(runProvider.model) ? tools : fullTools).filter(
          // handoff 也不给子 agent：它没有身份、没法承担责任，要交接让父 agent 自己判断
          (t) =>
            t.name !== 'task' &&
            t.name !== 'update_todos' &&
            t.name !== 'question' &&
            t.name !== 'handoff' &&
            // 计划是整个会话的产物，子代理写会让父会话出现一份别人的计划；
            // 技能目录只写在父 agent 的提示里，子 agent 拿不到名字，
            // 给了它也只能瞎猜 —— 真要用技能就让父 agent 自己用，或把步骤写进 task 的 prompt
            t.name !== 'write_plan' &&
            t.name !== 'use_skill'
        ),
        budget: stepCap,
        web: webOn,
        // 插话也要能停下子 agent：它们跑的是同一批「动作」，没有理由继续
        signal: stepSignal,
        instructions: instructionsBlock(instructions) || null,
        nonInteractive,
        approvalPolicy: options?.approvalPolicy,
        mode
      }

      /**
       * 模型说话这会儿用户插了话：这一批动作就别按旧计划做了。
       * 但 assistant 消息已经落库、里面声明了这些 tool_call，
       * 所以必须补上占位结果 —— 少一条下一步请求就 400。
       */
      if (this.steered(session.id)) {
        await this.skipTools(session, toolCalls, STEER_SKIP_NOTE, new Set())
        this.emit(session.id, {
          type: 'hint',
          message: '收到你的新消息，这一批动作已取消，正在按新方向重来。'
        })
        continue
      }

      /**
       * 命令和技能会在工具参数之外生成文件：`python scripts/actions.py …` 吐出的
       * xlsx / pdf / png 从来没出现在任何 path 参数里，成果面板只认 write_file 就永远收不到。
       * 执行前后各扫一次盘，用 mtime 差把真正新落盘的成果送进同一个面板。
       * 只在批次里确实有命令类工具时才扫，纯读写的批次不付这份开销。
       */
      const beforeArtifacts = mayProduceFiles(toolCalls.map((c) => c.name))
        ? await snapshotResults(workspace)
        : null

      /** 这一批里已经在界面上亮过卡的工具，收尾时要补结果 */
      const announced = new Set<string>()
      /** 因为插话而没轮到的，循环结束后统一补占位结果 */
      const notRun: ToolCall[] = []
      let ci = 0
      for (; ci < toolCalls.length; ci++) {
        let call = toolCalls[ci]
        if (signal.aborted) {
          /**
           * 停止也要收干净：这一批里还没轮到的调用必须补上占位结果再退出。
           * 以前这里直接 throw，已落库的 assistant.tool_calls 就留下没有结果的孤儿，
           * 之后每一次发送都被服务端判为非法历史（400），这个会话等于废了。
           */
          notRun.push(...toolCalls.slice(ci))
          break
        }
        // 工具网关：展开成真名后再走风险 / 审批 / 钩子，网关不是绕过检查的后门
        const unwrapped = unwrapToolbox(call, fullTools)
        if (unwrapped) call = unwrapped
        /**
         * 插话就停手：这一批里还没轮到的都不做了。
         * 断的是「动作」，所以已经在跑的那个由它自己响应 stepSignal 停下。
         */
        if (this.steered(session.id)) {
          notRun.push(...toolCalls.slice(ci))
          break
        }

        // task：模型连着写的几个子任务一起并行跑，回来再按原顺序落库
        if (call.name === 'task') {
          const batch: ToolCall[] = [call]
          while (ci + 1 < toolCalls.length && toolCalls[ci + 1].name === 'task') {
            batch.push(toolCalls[++ci])
          }
          for (const f of await this.runTaskBatch(subCtx, batch)) touched.add(f)
          continue
        }

        /**
         * 参数在 provider 层已经尽量修过（尾逗号、单引号、裸键、代码块外壳），
         * 这里按工具自己的 schema 补最后一道：类型强转、认别名（file_path → path）、
         * 以及「实在修不出来就明确告诉模型坏在哪」。
         *
         * 坏参数不执行，也不弹审批框 —— 用户看到一个路径为空的删除确认只会更困惑，
         * 而模型收到「缺少 path」会以为是用法问题，重读工具说明再吐一遍同样的坏 JSON。
         */
        const settled = settleToolArgs(
          call,
          call.name === TOOLBOX_SPEC.name ? TOOLBOX_SPEC : toolSpecs.find((t) => t.name === call.name)
        )
        // 小模型：把抓取量和搜索条数压小，别让它一次吃掉整个上下文
        const args = isSmallModel(runProvider.model)
          ? shrinkArgsForSmall(call.name, settled.args)
          : settled.args
        announced.add(call.id)
        this.emit(session.id, { type: 'tool_start', callId: call.id, tool: call.name, args })

        /**
         * 重复调用护栏：同样的工具 + 同样的参数 + 同样的结果，就是原地打转。
         *
         * 放在审批之前：让用户对第 4 次一模一样的写文件点「允许」毫无意义，
         * 点了也是白改一遍。这里直接不执行，把上次的结果还给模型，
         * 免了它再跑一遍去拿同一份数据。
         */
        const repeat = callGuard.check(call.name, args)
        if (repeat.verdict === 'block') {
          repeatBlocked += 1
          if (!repeatHinted) {
            repeatHinted = true
            this.emit(session.id, {
              type: 'hint',
              message: `助手在重复同一个动作（${call.name}），已拦下这次执行并让它换个做法。`
            })
          }
          const skipMessage: ChatMessage = {
            id: store.newId(),
            role: 'tool',
            content: repeat.note,
            toolCallId: call.id,
            toolName: call.name,
            toolArgs: args,
            createdAt: Date.now()
          }
          session.messages.push(skipMessage)
          await store.appendMessages(session.id, [skipMessage])
          this.emit(session.id, {
            type: 'tool_result',
            callId: call.id,
            tool: call.name,
            result: repeat.note,
            ok: false,
            durationMs: 0
          })
          /**
           * 拦一次它换参数再试是正常的；连着被拦三次说明它已经不会自己走出这个坑，
           * 再转下去只会把上下文和步数烧光，停在这里把话交给用户。
           */
          if (repeatBlocked >= MAX_REPEAT_BLOCKS) {
            repeatHalted = true
            notRun.push(...toolCalls.slice(ci + 1))
            this.emit(session.id, {
              type: 'hint',
              message:
                '助手连续多次在重复同样的动作，已经停下这一轮。可以补一句说明换个方向，或换一个更强的模型。'
            })
            break
          }
          continue
        }

        // 关掉的能力不参与风险评估，否则会先弹一个毫无意义的确认框
        const risk =
          settled.blocked || disabled(call.name)
            ? null
            : isMcpTool(call.name)
              ? classifyMcpRisk(call.name, permRules)
              : classifyRisk(call.name, args, workspace, permRules)
        const decision = settled.blocked
          ? 'deny'
          : decideApproval({
              mode,
              hasRisk: !!risk,
              high: risk?.high === true,
              denied: risk?.denied === true,
              alwaysApprove: this.alwaysApprove.has(session.id),
              alwaysApproveHigh: this.alwaysApproveHigh.has(session.id),
              granted: this.grantedIn(workspace, call.name)
            })
        let approved = decision !== 'deny'
        if (decision === 'ask' && risk) {
          if (nonInteractive) {
            // 无头模式：不弹框，按策略确定性收口（approveDecision 里 ask 分支已处理）
            approved = approveDecision({
              mode,
              hasRisk: true,
              high: risk.high === true,
              denied: risk.denied === true,
              alwaysApprove: this.alwaysApprove.has(session.id),
              alwaysApproveHigh: this.alwaysApproveHigh.has(session.id),
              granted: this.grantedIn(workspace, call.name)
            })
          } else {
            // 写文件的先把 diff 算出来，让用户看清改哪几行再决定
            let preview: ApprovalRequest['preview'] | undefined
            if (call.name === 'patch') {
              const pvs = previewPatch(args, workspace, risk.kind === 'outside')
              if (pvs.length) {
                const files = pvs.map((pv) => {
                  const lines = diffLines(pv.before ?? '', pv.after ?? '')
                  const st = diffStats(lines)
                  return { path: pv.path, kind: pv.kind, added: st.added, removed: st.removed, lines }
                })
                const first = files[0]
                preview = { ...first, files }
              }
            } else if (WRITE_TOOLS.has(call.name)) {
              const pv = await previewWrite(call.name, args, workspace).catch(() => null)
              if (pv) {
                const lines = diffLines(pv.before ?? '', pv.after)
                const st = diffStats(lines)
                preview = { path: pv.path, kind: pv.kind, added: st.added, removed: st.removed, lines }
              }
            }
            approved = await this.askApproval(session.id, call.name, args, risk, preview, stepSignal)
          }
        }

        const started = Date.now()
        // 写文件的：先留一份改前内容，执行完再记一条可撤销的改动
        // patch 是多文件，用 patchTargets 取全部目标；单个文件仍用 toolTargetPath
        const writeTargets: string[] = []
        if (call.name === 'patch') {
          writeTargets.push(...patchTargets(workspace, args, risk?.kind === 'outside'))
        } else if (call.name === 'format') {
          // format 改的是 paths 里的文件，不是单个 path；同样要记快照，才能在「变更」里撤销
          const list = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : []
          for (const p of list) {
            try {
              writeTargets.push(toolTargetPath(workspace, p, risk?.kind === 'outside'))
            } catch {
              // 越界路径交给工具自己报错
            }
          }
        } else if (WRITE_TOOLS.has(call.name)) {
          try {
            const t = toolTargetPath(workspace, String(args.path ?? ''), risk?.kind === 'outside')
            writeTargets.push(t)
          } catch {
            // 路径非法（越界 / 空）：不记快照，正常执行时工具自己会报错
          }
        }
        const beforeByTarget = new Map<string, string | null>()
        for (const t of writeTargets) beforeByTarget.set(t, await readTextOrNull(t))
        let output: string
        let ok = true
        /**
         * preToolUse：审批过了、还没执行。
         * 退出码 2 视为拒绝，stderr 原样回给模型 —— 相当于「这个仓库不许这么干」，
         * 比在提示词里写十句“不要改生成文件”有用。
         */
        const hookReady = !settled.blocked && approved && !disabled(call.name)
        const preHook = hookReady
          ? await runHooks('preToolUse', {
              workspace,
              sessionId: session.id,
              agentId: profile?.id ?? null,
              tool: call.name,
              args
            })
          : { ran: 0 }
        if (preHook.blocked) {
          ok = false
          output = `钩子拒绝了这个操作：${preHook.blocked}`
        } else if (settled.blocked) {
          // 参数坏到不能执行：把「坏在哪、怎么重发」直接还给模型
          ok = false
          output = settled.blocked
        } else if (!approved) {
          ok = false
          output =
            mode === 'plan'
              ? '当前是「计划模式」：只能读和写计划，不能改动文件或跑命令。先把方案用 write_plan 写出来，等用户批准。'
              : mode === 'readonly'
                ? '当前是「只读」模式，已拒绝该操作。需要执行命令或修改文件时，请把顶部模式切换为「询问」或「自动」。'
                : '用户拒绝执行该操作。请换一种方式，或先说明为什么需要它。'
        } else if (disabled(call.name)) {
          // 设置里关掉的能力：不执行，但把原因回传给模型，避免它反复重试
          ok = false
          output = `「${call.name}」已在软件设置里关闭，本次没有执行。请换用其他办法；如果确实需要它，提醒用户到「软件设置 → 联网与记忆」打开。`
        } else if (call.name === 'update_todos') {
          // 计划只在引擎内存里维护 + 推给界面；历史里留着本次调用的参数，重开会话能还原
          const items = normalizeTodos(args.items)
          this.todos.set(session.id, items)
          planTouched = true
          this.emit(session.id, { type: 'todos', items })
          output = formatTodos(items)
        } else if (call.name === 'question') {
          // 暂停下来问用户，等应答后把答案作为工具结果回传，接着跑
          const opts = Array.isArray(args.options)
            ? (args.options as unknown[]).map((o) => String(o)).slice(0, 6)
            : undefined
          const multi = Boolean(args.multiSelect)
          const answer = nonInteractive
            ? '' // 非交互模式没有用户可问，直接跳过
            : await this.askQuestion(session.id, String(args.question ?? ''), opts, signal, multi)
          output = answer ? `用户的回答：${answer}` : '用户没有回答（已跳过）。'
        } else if (isMcpTool(call.name)) {
          try {
            output = await callMcpTool(call.name, args)
          } catch (err) {
            ok = false
            /**
             * 插话造成的中断不是「工具坏了」：这一批剩下的会跳过，
             * 模型看到「环境没坏、别重试」才不会下轮又原样跑一遍。
             */
            output =
              cut.signal.aborted && !signal.aborted
                ? STEER_CUT_NOTE
                : `执行失败：${(err as Error).message}`
          }
        } else {
          try {
            output = await executeTool(call.name, args, {
              workspace,
              signal: stepSignal,
              allowOutside: risk?.kind === 'outside',
              agentId: memNs,
              sessionId: session.id,
              hiddenTools: hiddenSpecs.map((t) => ({ name: t.name, description: t.description })),
              handoff:
                roster.length === 0
                  ? undefined
                  : async (req) => {
                      const target = roster.find((a) => a.id === req.to || a.name === req.to)
                      if (!target) {
                        throw new Error(
                          `没有叫「${req.to}」的档案。可选：${roster.map((a) => a.name).join('、')}`
                        )
                      }
                      const rec = await enqueueHandoff({
                        fromAgentId: profile?.id ?? null,
                        fromName: profile?.name ?? null,
                        fromSessionId: session.id,
                        toAgentId: target.id,
                        task: req.task,
                        context: req.context,
                        files: req.files,
                        workspace,
                        // 只继承不升级：只有明确设成 allow 的运行，下游才允许动文件
                        approvalPolicy: options?.approvalPolicy === 'allow' ? 'allow' : 'deny'
                      })
                      return `已交给「${target.name}」（会话 ${rec.sessionId?.slice(0, 8) ?? ''}）。它会在这一轮结束后自己接手，你看不到它的过程；不要等它，也不要重复做它的活。`
                    }
            })
            if (call.name === 'write_file' || call.name === 'edit_file') {
              /**
               * 一律存绝对路径。模型给的常常是 `src/a.ts` 这种相对路径，
               * 直接塞进 Set 会按进程 cwd（Electron 安装目录）被 path.relative 解析，
               * checkpoint 里就留下 `..\..\src\a.ts`；重启后「继续」还原出错误路径，
               * 诊断和验证拿到的文件全都不存在 —— 而且是静默跳过，看不出来。
               */
              touched.add(path.resolve(workspace, String(args.path ?? '')))
            } else if (call.name === 'patch' || call.name === 'format') {
              for (const t of writeTargets) touched.add(t)
            }
            if (call.name === 'remember') {
              // 刚记下的内容立刻生效，不用等下一轮对话
              memory = await memoryForPrompt(workspace, memNs)
            }
            if (call.name === 'board') {
              // 同上：黑板刚写的那条，这一轮后面几步就该看见
              boardText = await boardForPrompt(workspace).catch(() => boardText)
            }
            if (call.name === 'scratch') {
              // 便签刚写的内容，下一步就要看见；否则模型会以为自己没写成功、再写一遍
              scratchText = await scratchForPrompt(session.id).catch(() => scratchText)
            }
            if (call.name === 'write_plan') {
              // 计划写好了：立刻推给界面，用户能马上看到「批准执行」按钮，
              // 不用等这一轮结束（模型可能还在输出总结）
              const saved = await store.loadSession(session.id).catch(() => null)
              if (saved?.plan) this.emit(session.id, { type: 'plan', plan: saved.plan })
            }
            /**
             * 刚写完文件就做一次增量编译检查，把错误当场还回去。
             *
             * 以前只有一轮结束时的全量 verify：改坏一个类型要等整轮跑完才暴露，
             * 中间那几步全是建立在坏代码上的（后面改的引用全错，模型还以为自己改对了）。
             * tsserver 是增量语义，一个文件几百毫秒，放在每个写操作后面代价可以接受。
             *
             * 出错才追加，没错就什么都不加 —— 每次写文件都塞一句「检查通过」白占上下文。
             */
            /**
             * 刚写完文件，先按项目自带的格式化器对齐，再做编译检查。
             * 顺序很重要：先格式化，诊断看到的就是最终落盘的内容，不会因为
             * 格式化改动而白报一轮。
             */
            if (ok && writeTargets.length && config.formatOnWrite !== false) {
              const fmt = await formatFiles(workspace, writeTargets)
              if (fmt.message) output += `\n\n${fmt.message}`
            }

            if (ok && writeTargets.length && config.diagnoseOnWrite !== false) {
              const report = await diagnoseReport(workspace, writeTargets)
              if (report.diags.length) {
                output += `\n\n${formatDiagnostics(report.diags, {
                  workspace,
                  filesWritten: writeTargets.length
                })}`
                this.emit(session.id, {
                  type: 'diagnostics',
                  errors: report.diags.length,
                  files: new Set(report.diags.map((d) => d.file)).size
                })
              } else if (
                !diagGapNoted &&
                (report.skipped === 'no-typescript' || report.skipped === 'unavailable')
              ) {
                // 一次就够：说清「这次没查」，但不必每次写文件都重复一遍
                diagGapNoted = true
                output += `\n\n${formatDiagGap(report.skipped)}`
              }
            }
          } catch (err) {
            ok = false
            /**
             * 插话造成的中断不是「工具坏了」：这一批剩下的会跳过，
             * 模型看到「环境没坏、别重试」才不会下轮又原样跑一遍。
             */
            output =
              cut.signal.aborted && !signal.aborted
                ? STEER_CUT_NOTE
                : `执行失败：${(err as Error).message}`
          }
        }

        /**
         * 有些工具（run_shell）把「被取消」吞成一条正常结果返回，不抛错。
         * 统一改写成插话文案：模型要能分清「环境坏了」和「用户改主意了」，
         * 否则它可能以为命令失败了，下一轮原样再跑一遍。
         */
        if (ok && cut.signal.aborted && !signal.aborted) {
          ok = false
          output = STEER_CUT_NOTE
        }

        /**
         * 参数是被修过才跑通的：先在结果前面说明一句。
         * 不提醒的话，模型会以为自己写的是合法 JSON，同样的坏习惯会一直保留；
         * 提醒之后它会知道「刚才那次的格式有问题」，下一轮自己就写对了。
         */
        /**
         * postToolUse：已经跑完了，只能补话不能反悔。
         * 典型用途：跑完迁移脚本后把「记得重启服务」写回给模型，
         * 或者把 lint 结果塞进去让它下一步顺手修掉。
         */
        if (hookReady) {
          const postHook = await runHooks('postToolUse', {
            workspace,
            sessionId: session.id,
            agentId: profile?.id ?? null,
            tool: call.name,
            args,
            result: output
          })
          if (postHook.context) output += `\n\n【钩子】\n${postHook.context}`
          if (postHook.warning) this.emit(session.id, { type: 'hint', message: postHook.warning })
        }

        if (settled.note) output = `${settled.note}\n\n${output}`

        /**
         * 记一笔这个签名的结果，供下次判断「是不是又转了一圈」。
         * 记的是还没追加护栏提示的原始输出 —— 否则自己写的提示会污染「结果有没有变」。
         */
        callGuard.record(call.name, args, output)
        // 到警告线但还没到拦截线：这次照跑，只是提醒它别再原样重发
        if (repeat.verdict === 'warn') output += `\n\n${repeat.note}`

        // 改动落盘成功才记快照；失败或没变化不会进「变更」列表
        if (ok && writeTargets.length) {
          for (const target of writeTargets) {
            const afterText = await readTextOrNull(target)
            const beforeText = beforeByTarget.get(target) ?? null
            // 前后都没内容（如 move 的中间态）跳过，不产生无意义快照
            if (afterText === null && beforeText === null) continue
            const change = await recordChange({
              sessionId: session.id,
              root: workspace,
              absPath: target,
              before: beforeText,
              after: afterText,
              tool: call.name
            })
            if (change) this.emit(session.id, { type: 'file_change', change })
          }
        }
        const durationMs = Date.now() - started

        const toolMessage: ChatMessage = {
          id: store.newId(),
          role: 'tool',
          content: output,
          toolCallId: call.id,
          toolName: call.name,
          toolArgs: args,
          createdAt: Date.now()
        }
        session.messages.push(toolMessage)
        await store.appendMessages(session.id, [toolMessage])
        this.emit(session.id, {
          type: 'tool_result',
          callId: call.id,
          tool: call.name,
          result: output,
          ok,
          durationMs
        })
      }

      // 被插话打断 / 被护栏叫停：这一批没轮到的补占位结果，界面才不会留着转圈的卡片
      if (notRun.length) {
        await this.skipTools(session, notRun, repeatHalted ? REPEAT_SKIP_NOTE : STEER_SKIP_NOTE, announced)
      }

      /**
       * 停止是「整轮结束」，不是「这一步结束」。补完占位结果就立刻退出，
       * 别让它走到「步数用尽」那条路 —— 那会被当成可恢复的断点，用户点继续
       * 就带着一份已经取消的批次重跑。
       */
      if (signal.aborted) throw new Error('已取消')

      if (beforeArtifacts) {
        const items = diffResults(beforeArtifacts, await snapshotResults(workspace))
        if (items.length) this.emit(session.id, { type: 'artifacts', items })
      }

      // 这一轮真的动过手：下次模型再停下时，才值得再推它一轮。
      // 被插话跳过的不算 —— 那些没产生任何进展，不该让「自动续跑」更宽容
      sinceContinue += toolCalls.length - notRun.length
      // 同口径统计「这次运行到底动过几次手」：收工判定要用它区分「没动手」和「动了手但没落盘」
      toolsRun += toolCalls.length - notRun.length

      // 同一条命令被反复轮询（「下载还没完，再等三分钟」）时，对话会被几十条一模一样的记录刷屏，
      // 而进度并没有往前。抓到就提醒一次，让它换成一次长等待或直接查进度，别继续空转。
      for (const call of toolCalls) recentCalls.push(`${call.name}:${JSON.stringify(call.args ?? {})}`)
      while (recentCalls.length > 40) recentCalls.shift()
      if (!pollWarned) {
        const lastSig = recentCalls[recentCalls.length - 1]
        const repeatTimes = recentCalls.filter((s) => s === lastSig).length
        if (repeatTimes >= 5) {
          pollWarned = true
          continueNote =
            `同一个调用已经原样重复了 ${repeatTimes} 次，结果看起来没有变化：${lastSig.slice(0, 120)}\n` +
            '不要再照原样重复它。换一种方式：一次等更久（timeout /t 300、Start-Sleep -Seconds 300）、' +
            '直接查进度（日志大小、文件是否生成），或者把这一步交给一条能一次跑完的命令；' +
            '确实卡住了就停下来说明卡在哪里。'
          this.emit(session.id, {
            type: 'hint',
            message: '检测到同一条命令被反复轮询，已提醒助手换一种等待方式。'
          })
        }
      }

      // 每轮结束同步一次 checkpoint：计划 / 改动文件 / 验证结论有任何进展都即时落盘，
      // 这样即使下一秒崩溃，恢复时也能拿到最新的结构化进度
      persistCheckpoint('running')

      /**
       * 护栏已经判定这一轮走不出去了：再让 step 循环转下去，只会继续发请求、
       * 继续被拦，把上下文和用量烧光。这里跳出 step 循环，把控制权交回用户。
       * checkpoint 保持 running —— 这不是「做完了」，恢复时还能接着干。
       */
      if (repeatHalted) break
    }

    // 步数预算用完了还没收工：这不是「做完了」，是「这一轮到点了」。
    // 所以保留 checkpoint（running）—— 否则重启后既不出恢复横幅，「继续」也带不上
    // 计划 / 改过的文件 / 验证结论，用户只能自己重述做到哪了。真正收工才标 done 并清除。
    persistCheckpoint('running')
    // 因为重复动作被叫停的，不是「步数用完了」，别推一条误导的提示
    if (!repeatHalted) this.emit(session.id, { type: 'step_limit', maxSteps: stepBudget })
  }

  /**
   * 并行跑一批子 agent，返回它们改过的文件。
   * 子 agent 之间并行，但落库必须串行：appendMessages 是「读整份文件 → 改 → 写回」，
   * 并发写同一条会话会互相覆盖。
   */
  private async runTaskBatch(ctx: SubCtx, calls: ToolCall[]): Promise<string[]> {
    const touched: string[] = []
    for (const call of calls) {
      this.emit(ctx.sessionId, { type: 'tool_start', callId: call.id, tool: 'task', args: call.args })
    }

    const prepare = (call: ToolCall): SubAgentTask => ({
      id: store.newId(),
      callId: call.id,
      description: String(call.args.description ?? '').trim().slice(0, 40) || '子任务',
      prompt: String(call.args.prompt ?? call.args.task ?? '').trim(),
      status: 'running',
      steps: 0,
      startedAt: Date.now(),
      summary: '',
      tools: []
    })

    // 整批只判断一次：workerPlan 要查本地实例状态，每个子任务都查一遍纯属浪费
    const plan = await workerPlan(ctx.provider, ctx.config)
    const runner = plan.provider
    /**
     * 子代理的上下文预算要按它自己要用的模型算，不能沿用主模型的。
     * 主模型 32K、工人模型 8K 时，沿用主模型的预算会让子代理第一步就超窗报 400；
     * 反过来主模型 8K、工人 32K 时又会白白浪费上下文。
     */
    const budgetFor = (p: ProviderConfig): number => {
      const own = Math.round(Number(p.contextWindow) || 0)
      if (own <= 0) return ctx.budget
      // 子代理有自己的一套工具说明，留 40% 给输出和工具定义
      return Math.max(1500, Math.min(Math.floor(own * 0.6), 24000))
    }

    const one = async (call: ToolCall) => {
      const started = Date.now()
      const task = prepare(call)
      task.model = runner?.model || ctx.provider.model
      // 把「为什么用/没用工人模型」写进卡片：并行没生效时用户能立刻看到原因，
      // 而不是看到两个子任务都卡在一个模型后面还不知道为什么
      task.note = plan.reason
      const refuse = (why: string) => {
        const t: SubAgentTask = { ...task, status: 'fail', error: why, summary: why, endedAt: Date.now() }
        this.emit(ctx.sessionId, { type: 'subagent_start', task: t })
        this.emit(ctx.sessionId, { type: 'subagent_end', task: t })
        return { call, output: why, ok: false, durationMs: Date.now() - started }
      }

      if (!task.prompt) {
        return refuse('task 缺少 prompt：要给子 agent 一段完整、自包含的任务说明，它看不到我们的对话。')
      }
      // 只有「退回主模型」时才拦小模型：配了工人模型就说明用户已经安排了更合适的执行者
      if (!runner && isSmallModel(ctx.provider.model)) {
        return refuse(`当前模型（${ctx.provider.model}）太小，派子 agent 效果更差，请自己用工具直接完成。`)
      }

      this.emit(ctx.sessionId, { type: 'subagent_start', task })
      const opts = {
        id: task.id,
        callId: call.id,
        sessionId: ctx.sessionId,
        description: task.description,
        prompt: task.prompt,
        startedAt: task.startedAt,
        workspace: ctx.workspace,
        // 子 agent 步数上限压到 30：再多就是在原地打转，没意义还烧时间
        maxSteps: Math.max(6, Math.min(ctx.config.maxSteps, 30)),
        tools: ctx.tools,
        signal: ctx.signal,
        web: ctx.web,
        note: plan.reason,
        instructions: ctx.instructions,
        approve: (tool: string, args: Record<string, unknown>, risk: RiskInfo, preview?: ApprovalRequest['preview']) => {
          const decision = decideApproval({
            mode: ctx.mode ?? ctx.config.approvalMode,
            hasRisk: true,
            high: risk.high === true,
            denied: risk.denied === true,
            alwaysApprove: this.alwaysApprove.has(ctx.sessionId),
            alwaysApproveHigh: this.alwaysApproveHigh.has(ctx.sessionId),
            granted: this.grantedIn(ctx.workspace, tool)
          })
          if (decision === 'allow') return Promise.resolve(true)
          if (decision === 'deny') return Promise.resolve(false)
          if (ctx.nonInteractive) {
            // 高危永不自动放行；普通操作按策略
            return Promise.resolve(risk.high === true ? false : ctx.approvalPolicy === 'allow')
          }
          return this.askApproval(ctx.sessionId, tool, args, risk, preview, ctx.signal)
        },
        onChange: (change: FileChange) => {
          touched.push(change.path)
          this.emit(ctx.sessionId, { type: 'file_change', change })
        },
        onUpdate: (t: SubAgentTask) => this.emit(ctx.sessionId, { type: 'subagent_update', task: t })
      }

      let done = await runSubAgent({
        ...opts,
        provider: runner ?? ctx.provider,
        budget: budgetFor(runner ?? ctx.provider)
      })

      /**
       * 工人模型白跑一趟时兜底：一个工具都没调用就失败，说明是请求本身没通
       * （实例没起来、key 失效、端口错），重跑没有副作用 ——
       * 已经改过文件的情况绝不重跑，否则会把同一处改动做两遍。
       */
      if (done.status === 'fail' && runner && done.tools.length === 0 && !ctx.signal.aborted) {
        const why = done.error ?? '请求失败'
        const retry: SubAgentTask = { ...task, status: 'running', steps: 0, summary: '', tools: [], error: undefined }
        retry.note = `工作模型不可用（${why}），已改用主模型重跑`
        this.emit(ctx.sessionId, { type: 'subagent_update', task: retry })
        done = await runSubAgent({
          ...opts,
          provider: ctx.provider,
          budget: budgetFor(ctx.provider),
          note: retry.note
        })
        done.note = retry.note
      }

      this.emit(ctx.sessionId, { type: 'subagent_end', task: done })
      return {
        call,
        output: formatTaskResult(done),
        ok: done.status === 'ok',
        durationMs: Date.now() - started
      }
    }

    // 一次最多并行 3 个：再多会把本地模型的推理服务压住，审批也会连着弹
    const MAX = 3
    for (let i = 0; i < calls.length; i += MAX) {
      const settled = await Promise.all(calls.slice(i, i + MAX).map(one))
      for (const r of settled) {
        await this.pushToolResult(ctx, r.call, r.output, r.ok, r.durationMs)
      }
    }
    return touched
  }

  /** 子任务的结果按普通工具结果落库，下一轮模型就能读到它的结论 */
  private async pushToolResult(
    ctx: SubCtx,
    call: ToolCall,
    output: string,
    ok: boolean,
    durationMs: number
  ): Promise<void> {
    const toolMessage: ChatMessage = {
      id: store.newId(),
      role: 'tool',
      content: output,
      toolCallId: call.id,
      toolName: 'task',
      toolArgs: call.args,
      createdAt: Date.now()
    }
    ctx.session.messages.push(toolMessage)
    await store.appendMessages(ctx.sessionId, [toolMessage])
    this.emit(ctx.sessionId, {
      type: 'tool_result',
      callId: call.id,
      tool: 'task',
      result: output,
      ok,
      durationMs
    })
  }
}
