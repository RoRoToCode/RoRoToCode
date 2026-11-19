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
import { defaultShellKind, isWin } from './platform'
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
import { classifyRisk, classifyMcpRisk, executeTool, previewWrite, previewPatch, patchTargets, summarize, toolTargetPath, resolveToolPath, MAX_SINGLE_WRITE_CHARS, type RiskInfo } from './tools'
import { decideApproval } from './approval'
import { TOOLBOX_SPEC, toolSpecs, type ToolSpec } from './tools/spec'
import { WRITE_TEXT_KEYS, partialString, settleToolArgs, RAW_ARG_KEY } from '../shared/toolargs'
import { clipSafe, clipTailSafe, splitHeadTail } from '../shared/text'
import { estimateTokens, messagesTokens, toolsTokens as toolSpecsTokens } from '../shared/tokens'
import { createLoopGuard } from '../shared/degenerate'
import { createToolCallGuard, createScratchGuard, createErrorStreakGuard, isTruncatedWrite } from '../shared/toolguard'
import { healTruncatedWrites, type HealResult } from './heal'
import { saveSpill } from './spill'
import { escalationRoom } from './providers/budget'
import { isLocalProvider } from './providers/budget'
import { isSilentStall } from '../shared/autoresume'
import { extractAttachment, renderAttachmentBody } from './extract'
import { isImagePath, providerSupportsVision } from '../shared/vision'
import { fallbackCandidates, isLlamaProvider } from '../shared/providers'
import { createSubAgentDispatcher, laneCount, subAgentProviders } from '../shared/agentpool'
import { setLlamaVision, llamaVisionLoaded, touchIdle } from './llama'
import { formatTodos, normalizeTodos, todoGate } from '../shared/todos'
import { memoryForPrompt } from './memory'
import { boardForPrompt } from './board'
import { diagnoseReport } from './lsp'
import { checkHtmlScripts, formatHtmlIssues } from './htmlcheck'
import { checkJsSyntax, formatJsIssues } from './jssyntax'
import { checkWebPages, formatWebCheck, hasBlockingFailure } from './webcheck'
import { changedSources, formatShellChangeNote, snapshotSources } from './shellguard'
import { formatSweep, sweepWorkspace } from './hygiene'
import { formatFiles } from './format'
import { formatDiagGap, formatDiagnostics } from '../shared/diagnostics'
import { grantKey, grantTool, loadGrantSet } from './grants'
import { scratchForPrompt } from './scratch'
import { runHooks } from './hooks'
import { findInstructions, instructionsBlock, type InstructionsResult } from './instructions'
import { loadProjectPermissions } from './permissions'
import { detectVerifyPlan, runVerify, assertSmoke, resolveTestTarget, stateCoverageGap } from './verify'
import { asCalls, balancedEnd, parseTextToolCalls, type RawCall } from './parse'
import { runSubAgent, withExploreNav } from './subagent'
import { recordChange } from './changes'
import { diffLines, diffStats } from './diff'
import { callMcpTool, isMcpTool, mcpToolSpecs } from './mcp'
import { coreFallbackProvider, ensureCoreReady, CORE_PROVIDER_ID } from './core'
import { enabledSkills } from './skills'
import { snapshotResults, diffResults, mayProduceFiles } from './artifacts'
import { snapshotBeforeWrite } from './snapshot'
import { clearSnapshots } from './snapshot'
import { warmWorker, parallelLanes, workerPlan } from './worker'
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
  /**
   * 指定这条用户消息写入会话时的 id。仅给程序注入的续跑消息用：
   * 传 'continue' 后 lastUserText() 会把它当注入消息跳过，回溯到用户真正说的那句。
   * 否则 resume 的「继续。上次执行被中断了…」会被当成用户意图，里面没有代码语境词，
   * delegateHint() 就判不出审查/摸底信号 —— 表现为「断点续跑后再也不派子 agent」。
   */
  userMessageId?: string
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

/**
 * 「一个字都没拿到」就挂掉的超时。
 *
 * 和「生成到一半断了」必须分开处理：前者重发同一份请求，只会让服务端再从头 prefill
 * 一遍，然后同样超时 —— 现场观察到的「十几分钟一声不响、服务端 decoded 一直停在几十、
 * 请求反复重启」就是这么来的。这类失败只能靠**缩小这次的提示**来解决，或者干脆停下说清楚。
 */
export function quietTimeout(err: unknown): boolean {
  return isSilentStall(err)
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

/**
 * 计划门禁连续拒绝几次后强制放行。
 *
 * 3 次是个折中：一次是它没看清提示，两次是它理解偏了，三次还没改对基本就是
 * 9B 能力到顶了 —— 再拒下去只会把预算烧在重发计划上，不如放行并让用户知道。
 */
const MAX_PLAN_GATE_STRIKES = 3

/**
 * 产出比熔断的阈值。
 *
 * 同一个文件整份重写 4 次、其中最大的那次还不到 2000 字符 —— 这不可能是「写完了」，
 * 只可能是在「生成 → 被截断 → 重写」里绕圈。真实账单：77 次消息、6 万 token、
 * 20 分钟，产出 693 字节残片。继续放任它转，只会把上下文和额度一起烧光。
 *
 * 2000 字符这个值不是拍的：一份能跑的小游戏/小页面至少也有几千字符，
 * 反复停在几百字符就是被切断的铁证。
 */
const WRITE_BREAKER_ATTEMPTS = 4
const WRITE_BREAKER_MAX_SIZE = 2000

/**
 * 护栏收工（重复动作 / 连续同类错误）时给用户的结论。
 *
 * 以前 halt 走 break 跳出 step 循环，既不发 step_limit 也不写 finishNotes，
 * 于是 end() 只 emit 一条裸 done：界面把「正在运行」复位了，却不说为什么停，
 * 用户看到的就是「执行不知道什么时候断了」。这里把结论补上，并说清可以「继续」。
 */
function guardHaltNote(): { note: string; ok: boolean } {
  return {
    note: '已停止：助手反复做同一个动作或连续犯同一类错误，为避免空转提前收工。' +
      '任务未做完，补一句明确的方向再发消息（或点「继续」接着跑），换更强的模型通常更好。',
    ok: false
  }
}

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
 * 可以并发的只读工具。
 *
 * 只收「纯读本地文件、没有任何副作用」的四个。repo_map 会写索引缓存、
 * LSP 那对跳转要跟共享的 tsserver 打交道、web_* 走网络（有限流），
 * 它们看起来也是「读」，但并发起来副作用和限流都不好控，留给串行。
 */
const PARALLEL_READ = new Set(['read_file', 'list_dir', 'glob', 'grep'])
/** 一批最多并发几个：再多对本地磁盘没有收益，出错时也更难定位 */
const MAX_PARALLEL_READ = 6

/**
 * 从 from 开始收集「连续、可并发」的只读调用。
 *
 * 只收这一段是硬要求：中间夹着一个 write_file 或 run_shell，就必须断开 ——
 * 后面的读可能依赖前面写入的结果（写完再读回来校验是常见套路），
 * 抢跑会让它读到旧内容。
 */
export function collectParallelReadRun(
  calls: ToolCall[],
  from: number,
  max = MAX_PARALLEL_READ
): ToolCall[] {
  const run: ToolCall[] = []
  for (let j = from; j < calls.length && run.length < max; j++) {
    const c = calls[j]
    if (!PARALLEL_READ.has(c.name) || c.truncRejected) break
    run.push(c)
  }
  return run.length >= 2 ? run : []
}

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
 * 子代理能开工的最低上下文预算。
 *
 * 子代理的请求里必须带整套工具说明（约 4900 tokens）和它自己的系统提示，
 * 预算低于这个数就连工具表都装不下，发出去必然 400。显存不足时 llama.cpp 会
 * 自动把 `-c` 降下来（实测 7.4G 卡跑 12B 只拿到 4096），所以这个判断不能只在配置里做。
 */
const MIN_SUBAGENT_BUDGET = 6000

/**
 * 本地 worker 跑「要改文件」的子任务时，最多给多久。
 *
 * 现场：本地 9B worker 接了一个「改 ui.py」的子任务，993 秒、27 步、108 次工具调用，
 * 最后 llama 进程崩了，文件还被改坏 —— 父 agent 只拿到一句「连接已中断」，
 * 既不知道为什么，也不知道它动过哪些文件。
 *
 * 步数上限拦不住这种情况：27 步还没到 30，时间全耗在一次次读写里。
 * 所以按墙上时钟兜底：到了就中止，并把「它改过哪些文件」一起交回去，
 * 让父 agent 能立刻核对（写前有快照），而不是等它崩。
 *
 * 只对**本地** worker 的**写型**任务生效：只读 explore 没有破坏性，
 * 云端 worker 有各自的超时与重试策略，不该被这条墙钟卡住。
 * 10 分钟的依据：本地 9B 在这个时长里通常能完成 20～40 次工具调用，
 * 超过还没收尾，多半是在原地打转。
 */
const LOCAL_WORKER_WRITE_MS = 10 * 60_000

/**
 * 这个子任务该不该套墙钟护栏，套多久。0 = 不套。
 *
 * 单独提出来是为了能直接断言「哪些组合不套」—— 只读 explore 和云端 worker
 * 一旦被误套，长任务会被无缘无故掐断，而这种错误在界面上表现为「莫名失败」。
 */
export function writeCapMs(provider: ProviderConfig | null, explore: boolean): number {
  return provider && isLlamaProvider(provider) && !explore ? LOCAL_WORKER_WRITE_MS : 0
}

/**
 * 墙钟到点后回给父 agent 的那段话。
 *
 * 只说「失败了」没用 —— 父 agent 需要知道**还能不能接着干**：跑多久、烧了多少步、
 * 动过哪些文件。改过文件就不能盲目重派（会把同一处改动做两遍），没改过就可以。
 */
export function localCapVerdict(
  capMs: number,
  steps: number,
  toolCalls: number,
  files: string[]
): { error: string; summary: string; note: string } {
  const min = Math.round(capMs / 60_000)
  const where = files.length
    ? `它改过的文件：${files.join('、')}。先核对这几处（写前有快照），再决定接着改还是重来。`
    : '它没有写入任何文件，拆小重派一次是安全的。'
  return {
    error: `本地工作模型跑了 ${min} 分钟仍未收尾（${steps} 步 · ${toolCalls} 次工具调用），已中止。${where}`,
    summary: `（子任务超时中止：本地模型单次任务不宜超过 ${min} 分钟，把任务拆小再派。）`,
    note: `墙钟上限 ${min} 分钟已到`
  }
}

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

/**
 * token 估算与工具定义开销都搬到了 shared/tokens.ts：供应商那侧也要算同一笔账
 * （输出预算 = 窗口 - 这次请求实际占了多少），两边各写一份必然会漂。
 */
export { messagesTokens } from '../shared/tokens'

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
    '3. 改代码前用 list_dir / grep / read_file 看清现状，修改用 edit_file。文件读不全时分段读（offset/limit）或 grep，不要写临时脚本去打印文件。read_file 每行前面的「行号→」是位置标记，old_string 里不要带它；没读过的文件不能改。',
    '4. 要改的代码必须写进文件（edit_file / write_file），不要把整段代码贴在回复里；一次性的校验脚本写到 `.roroto/tmp/` 下，别丢在交付目录里。',
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

/**
 * 工具参数里「一塞就是整份文件」的字段。
 *
 * 这些内容留在历史里只为了让模型回忆「我写过什么」，翻全文没有价值 ——
 * 文件本体就在工作区，真需要细节它会重新 read_file。
 */
const BULKY_ARG_KEYS = new Set([
  'content',
  'old_string',
  'new_string',
  'oldText',
  'newText',
  'patch',
  'diff',
  'text',
  'body'
])

/**
 * 截断一个工具调用里的大字段。
 * 没有可截的返回 null —— 调用方据此少建对象，避免无意义地改动历史（前缀缓存会因此失效）。
 */
function shrinkArgs(
  args: Record<string, unknown>,
  maxChars: number
): Record<string, unknown> | null {
  let changed = false
  const out: Record<string, unknown> = { ...args }
  for (const [key, value] of Object.entries(out)) {
    if (!BULKY_ARG_KEYS.has(key) || typeof value !== 'string' || value.length <= maxChars) continue
    // 二次压缩（shrinkTail 逐级收紧）时别再叠一层标记，直接截短即可
    if (value.includes('（历史参数已压缩')) {
      out[key] = value.slice(0, maxChars)
      changed = true
      continue
    }
    out[key] = `${value.slice(0, maxChars)}\n…（历史参数已压缩：原 ${value.length} 字符，完整内容见工作区文件）`
    changed = true
  }
  return changed ? out : null
}

/**
 * 折叠时的可选旁路：把被丢掉的原文存到磁盘，并把路径写进折叠说明。
 *
 * 这是「模型永远拿不回中间那段」的解药。以前折叠只留 800 + 320 字符，
 * 模型想确认自己写过什么只能重新 read_file —— 而重读又占上下文，
 * 下一轮折得更狠，形成正反馈。
 *
 * 没有传 spill（单测、无工作区的纯聊天）时行为完全不变。
 */
export interface CompactOptions {
  /** 返回给模型看的路径；返回 null 表示没存下，折叠说明里就不带路径 */
  spill?: (text: string, meta: { toolName?: string; index: number }) => string | null
}

/**
 * 最后一道闸：整轮丢无可丢时，就地截断超大的工具参数 / 工具输出。
 *
 * 以前只靠 dropOldestTurns，而它「保底不切最后一轮」—— 当最后一轮自己就装不下
 * （典型：一次 write_file 写了整份 HTML），预算砍到 600 也没用：三次重试发出的是
 * 一模一样的 16431 tokens，服务端每次都回 400。
 *
 * 只改内容、不删消息：assistant.toolCalls 与 tool 结果的配对始终完整，
 * 不会因为「瘦身」造出一份服务端不认的历史。
 */
export function shrinkTail(list: ChatMessage[], budget: number, opts?: CompactOptions): ChatMessage[] {
  let out = list
  for (const limit of [600, 300, 150, 80, 40]) {
    out = out.map((m) => {
      if (m.role === 'tool' && m.content.length > limit) {
        const where = opts?.spill?.(m.content, { toolName: m.toolName, index: -1 })
        const tail = where ? `…（历史工具输出已压缩，全文见 ${where}）` : '…（历史工具输出已压缩）'
        return { ...m, content: `${clipSafe(m.content, limit, '')}\n${tail}` }
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        let changed = false
        const calls = m.toolCalls.map((c) => {
          const shrunk = shrinkArgs(c.args, limit)
          if (!shrunk) return c
          changed = true
          return { ...c, args: shrunk }
        })
        return changed ? { ...m, toolCalls: calls } : m
      }
      return m
    })
    if (messagesTokens(out) <= budget) break
  }
  return out
}

export function compact(messages: ChatMessage[], budget: number, opts?: CompactOptions): ChatMessage[] {
  if (messagesTokens(messages) <= budget) return messages
  const last = messages.length - 1
  /**
   * 最新的这几条不许折叠。
   *
   * 它们就是模型这一步正在推理的东西：刚调用的工具、刚读到的文件内容。
   * 以前无差别地把所有 tool 输出砍到 1200 字符，模型读回自己刚写的 6.5KB 文件时
   * 只看到前 1200 字符，于是认定「写入被截断了」，接着重写一遍再被砍 —— 真实会话里
   * 整整 92 次 write_file 就是这么转出来的（模型原话：the tool outputs are being truncated in my view）。
   * 预算真装不下时还有 shrinkTail 兜底，那里才允许动最新的内容。
   */
  const protectFrom = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].toolCalls?.length) return i + 1
    }
    return messages.length
  })()
  const trimmed = messages.map((m, idx) => {
    if (m.role === 'tool' && idx < protectFrom && m.content.length > 1200) {
      // 掐头去尾都留：工具输出的**结尾**往往是结论或文件的收尾，只留开头会让模型误判「内容没了」
      const { head, tail, omitted } = splitHeadTail(m.content, 800, 320)
      const where = opts?.spill?.(m.content, { toolName: m.toolName, index: idx })
      const note = where
        ? `…（较早的工具输出已折叠，中间 ${omitted} 字符省略；完整原文可用 read_file 读 ${where}）…`
        : `…（较早的工具输出已折叠，中间 ${omitted} 字符省略）…`
      return { ...m, content: `${head}\n${note}\n${tail}` }
    }
    /**
     * assistant 的 toolCalls 以前完全没被折叠 —— 写入类工具把整份文件塞在参数里，
     * 一段 HTML 就上万字符。只压 tool 输出、不压这块，等于把最占地方的部分留到最后。
     */
    if (m.role === 'assistant' && m.toolCalls?.length) {
      let changed = false
      const calls = m.toolCalls.map((c) => {
        const shrunk = shrinkArgs(c.args, 800)
        if (!shrunk) return c
        changed = true
        return { ...c, args: shrunk }
      })
      if (changed) return { ...m, toolCalls: calls }
      return m
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
   *
   * 而「轮」也切不动时（最后一轮自己就超），再走 shrinkTail 就地瘦身：
   * 只截内容、不删消息，配对关系不会坏。
   */
  const dropped = dropOldestTurns(trimmed, (next) => messagesTokens(next) > budget)
  return messagesTokens(dropped) <= budget ? dropped : shrinkTail(dropped, budget, opts)
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
export function maskObservations(list: ChatMessage[], cap: number, opts?: CompactOptions): ChatMessage[] {
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
    const head = clipSafe(m.content, 600, '').trimEnd()
    const where = opts?.spill?.(m.content, { toolName: m.toolName, index: i })
    // 存下来了就指路（模型可以直接 read_file 那一段），没存下才让它重新调用工具
    const how = where ? `完整原文可用 read_file 读 ${where}` : `需要细节请重新调用 ${m.toolName ?? '该工具'}`
    return {
      ...m,
      content: `${head}\n${MASK_MARK}：原输出 ${m.content.length} 字符，${how}）`
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
    /**
     * 标了「子」的模型数。只用来告诉模型「有没有子智能体可用」，
     * **不再用来判断能不能并行** —— 配了 1 个也是串行（见 lanes）。
     */
    subAgents?: number
    /**
     * 本次真能同时跑几路子任务（`worker.ts` 的 `parallelLanes`，算式见
     * `shared/agentpool.ts` 的 `laneCount`）。
     *
     * 以前这里按「配了几个子智能体」猜：配了 1 个也教模型「连写 2～3 个」，
     * 而执行层的并发上限是「池里几个就绪就几路」，两边对不上 ——
     * 几路只读审查排成队、还全撞在同一家限流上。
     * 不传时按「没配 worker」估（本地 1、远端 3），直接调 systemPrompt 的场景都是这种。
     */
    lanes?: number
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
    `需要验证时用 run_shell。默认 shell 是本机默认 shell（${
      defaultShellKind() === 'cmd' ? 'Windows cmd.exe' : 'macOS/Linux 的 $SHELL'
    }），可把 shell 参数设为 bash / powershell 切换。改完代码程序会自动跑测试或构建，你只要按结果继续修。`,
    /**
     * GUI / 长驻程序的验证方式必须点明。
     *
     * 实测里模型连着三次用前台 run_shell 跑 tkinter，分别被 15s/5s/5s 超时杀掉，
     * 白烧三轮；最后它自己绕过验证，用「exe 已启动」当通过。这类程序不会自己退出，
     * 前台等它 = 必然超时，所以得把「后台起 + 判存活 + 回收」这条路写进规则。
     */
    'GUI / 长驻程序（tkinter、pygame、服务、dev server、浏览器常驻页）不要用前台 run_shell 等它退出——它不会自己结束，只会被超时杀掉。' +
      '正确做法：run_shell 设 background:true 启动，等几秒用 shell_bg {"action":"log","id":"…"} 看日志；' +
      '进程还活着、日志里没有 Traceback 就算启动通过；验完用 shell_bg {"action":"kill"} 回收，别留后台进程。',
    ...(isWin
      ? [
          'Windows 上不要用 `python -c "..."` / `node -e "..."` 这种内联多语句跑验证：cmd.exe 对引号的二次解析容易把它截断成半句。把脚本用 write_file 写成 .py / .js 文件，再 run_shell 执行；确实要内联时，把 shell 设成 powershell。',
          'tail / head / grep / sed / awk 这类 unix 命令在 cmd 和 powershell 里默认跑不了：要么把 shell 显式设成 bash（需 Git Bash），要么换成本机等价命令（type / dir / findstr、PowerShell 的 Get-Content -Tail、Select-String）。ls / cat / rm 在 PowerShell 里虽然有别名，但参数语义不一样，别照抄 unix 写法。'
        ]
      : []),
    '工具返回错误时先读错误信息再换方案，不要重复同一次失败调用。',
    '不要一次读取大量无关文件，按需逐步获取。',
    '读文件被截断时用 offset/limit 分段读、用 grep 定位关键词；不要为了看内容写 .py / .sh 临时脚本。',
    'read_file 返回的每行前面有「行号→」，那是位置标记、不是文件内容：old_string 里不要带它。改文件前必须先 read_file 读过它，old_string 照原文复制（缩进、空格、标点都要一致）；文件在你读过之后被改过，会被要求重读。同一个文件没改动时再读只会得到一句「未变化」的提示——那就直接用上文的内容改，实在要再看一遍传 force:true。',
    '改代码必须落到文件里：新建用 write_file、改动用 edit_file，不要把整段代码贴在回复里当交付。',
    '一次性脚本（生成 / 校验 / 探针用）一律写到 `.roroto/tmp/` 下，用 run_shell 时也带这个前缀（如 `python .roroto/tmp/gen.py`）。交付目录里只留最终成果；写到根目录的临时脚本会在收工时被挪走，届时你会找不到它。',
    '任务完成后用一两句话说明改了什么，不要长篇总结。',
    '一次任务要一直做到完：计划里还有没勾掉的项、或还有文件 / 命令没处理时，不要收工，也不要只说「接下来我会…」就结束。全部做完再给结论。',
    '有附件正文时，先通读再回答；不要只凭文件名猜内容。'
  ]
  /**
   * 能力边界：本地中小模型接复杂多文件项目会空转（工具表 + 提示就吃掉大半个窗口）。
   * 只在「本地 + 参数量中等」时注入 —— 在线强模型和极简小模型各有自己的路径，
   * 这里专门把「3B~14B 本地模型」这条最容易被误用的区间点出来。
   */
  const localSize = modelSizeB(provider.model)
  if (isLocalProvider(provider) && localSize !== null && localSize > 3 && localSize <= 14) {
    rules.push(
      `你是本地 ${localSize}B 模型，上下文和输出都有限：复杂多文件项目（一次要写十几个文件、带前后端和数据库的那种）尽量小步快跑，` +
        '一次只做「能打开、能验证」的一小步，别试图一口气产出整个项目。' +
        '如果用户要的是大工程，可以如实说明「当前模型更适合拆成多轮小步完成」，建议换更强的在线模型会更顺。'
    )
  }
  rules.push(
    webOn
      ? '需要外部事实（开源项目与仓库名、链接、版本、不熟的库、报错含义、官方文档）时先 web_search，再用 web_fetch 读最相关的一两个页面；引用结论要给出网址。不许凭记忆编造仓库名、项目名或链接——没查到就直说「不确定」。'
      : '联网已在「软件设置」里关闭：你不能搜索或打开网页。遇到必须查最新资料的问题，用已有知识回答并说明可能不是最新，同时提醒用户可以打开联网开关。'
  )
  /**
   * 计划怎么切，比计划有多长重要得多。
   *
   * 同一个游戏，按「代码层次」切（骨架→函数→事件→样式）会有三个中间态都跑不起来，
   * 于是验收只能等到最后，错误也就在最后一起爆 —— 这正是之前反复重写的成因。
   * 按「能跑的状态」切，每一步都有可看的结果，坏了只回退一步。
   */
  rules.push(
    '三步以上的任务先调 update_todos 列出计划，之后每完成一步就更新状态（同一时间只留一项 in_progress），做完把全部标为 completed。' +
      '计划必须按「能跑起来的状态」切，不能按「代码的层次」切：每一步结束时，产物都要能打开、能看到东西。' +
      '反例（最容易犯的）：1 写 HTML 骨架 2 写全部函数 3 接事件 4 调样式 —— 前三步页面都是死的，一步都验不了。' +
      '正例：1 打开是一块能左右移动的方块 2 能跳起来 3 有障碍物会撞 4 有分数会涨。' +
      '每一项后面用一句话写清「怎么算做完了」，例如「打开无报错」「按空格会跳起来」。'
  )
  /**
   * 写入粒度硬约束必须写进提示，不能只靠工具层拒绝。
   *
   * 工具层拒绝是「事后」的：模型已经烧掉一次完整生成才被拦下。提示里先立规矩，
   * 它第一笔就按分段来，省掉一整轮重试。两者缺一不可 —— 只写提示不拦，它照样
   * 一次吐两万字符；只拦不写提示，它会把拒绝当成工具坏了，原样再试一遍。
   */
  rules.push(
    `单次写入有硬上限：一次 write_file 的 content 不超过 ${MAX_SINGLE_WRITE_CHARS} 字符（约 300~400 行），edit_file 的 new_string 同理。` +
      '本地模型的单次输出上限只有一万多 token，超过这个量必定被切断在半句，文件就成了残片，然后你只能整份重写 —— ' +
      '反复重写、越写越小，就是这么来的。' +
      '大文件一律分段：先 write_file 只写骨架（结构 + 空函数 + 结尾留一行标记注释），' +
      '再用 write_file({append:true, content:"…"}) 一段一段往后接，每段都短到能一次写完。' +
      '切在「结构 / 样式 / 逻辑」这种天然边界上，不要切在字符串、注释或函数中间。'
  )
  /**
   * 「本次能并行几路」只有一个来源：`laneCount`（执行层的并发上限用的就是它）。
   * 不传就按「没配 worker」估 —— 本地单槽 1 路、远端 API 3 路，和以前的行为一致。
   */
  const lanes = opts.lanes ?? (isLlamaProvider(provider) ? 1 : 3)
  const canParallel = lanes >= 2
  const workers = opts.subAgents ?? 0
  /**
   * 拆分范例无条件注入。
   *
   * 以前这段只在配置了多个模型时才出现，于是单模型的会话里，模型对「怎么拆」
   * 完全没有具体样板 —— 它只知道「要列计划」，列出来还是「1. 写 HTML 2. 写 JS」，
   * 粒度和没列一样。范例本身几乎不占字数，但它是把「列计划」和「拆到能执行」
   * 区别开来的唯一东西。
   *
   * 所以「拆」的话照说，但「能同时开」这句要看 lanes —— 只有 1 路时还说「一起派出去」，
   * 模型会以为派 3 个就是并行，实际在闸门里排队、各自重付一次 prefill。
   */
  rules.push(
    '大任务要拆到「一次只产出一个能跑的小块」，而不是「列三条大纲」。需要 3 步以上、且步骤之间互不依赖（各自读写的文件不同）时，' +
      (canParallel
        ? '就在同一轮连写多个 task 一起派出去 —— '
        : '就拆成几个 task 派出去（本次只能一路一路跑，拆开的好处是每个 task 有自己的上下文，父会话不被中间过程占满）—— ') +
      '比如「搭页面骨架」「写游戏/业务逻辑」「调样式与资源」「跑本地自测」这几件事互不依赖，适合拆开派。' +
      '每个 task 的 prompt 必须自包含：涉及哪些路径、要交付什么、验收标准是什么；不要让两个 task 改同一个文件。等全部结果回来再汇总作答。' +
      '真的 1～2 步就能做完的，自己做，别为了拆而拆。'
  )
  /**
   * 「不干活的并行」必须单独教一次。
   *
   * 上面那条范例只举了写代码的活（骨架 / 逻辑 / 样式 / 自测），于是模型学到的
   * 拆分方式就只有「写」，遇到「帮我看看有没有问题」这类请求时，它默认自己
   * 一边 grep 一边读，把上下文塞满还只查了一个角度 —— 而 explore 通道本来就是
   * 为这件事准备的：只读、不写盘、多路之间不可能冲突。
   *
   * 但也不能无条件鼓励：能不能真并发取决于 runTaskBatch 的 MAX —— 有工人池按池子
   * 大小，没有时本地 llama 是 1（单槽，多派只会在闸门里排队、各自重付一次 prefill，
   * 比串行更慢），远端 API 是 3。所以这里按 canParallel 分两版说法，
   * 避免教出一个「什么都拆、拆了还更慢」的模型。
   */
  /**
   * 「不干活的并行」必须单独教一次。
   *
   * 上面那条范例只举了写代码的活（骨架 / 逻辑 / 样式 / 自测），于是模型学到的
   * 拆分方式就只有「写」，遇到「帮我看看有没有问题」这类请求时，它默认自己
   * 一边 grep 一边读，把上下文塞满还只查了一个角度 —— 而 explore 通道本来就是
   * 为这件事准备的：只读、不写盘、多路之间不可能冲突。
   *
   * 但不能无条件鼓励：能开几路由 `lanes` 说了算（和执行层同一个算式），
   * 只有 1 路时就得说「派 1 个依次查」，否则教出一个「什么都拆、拆完排队更慢」的模型。
   */
  rules.push(
    '除了写代码，**只读的检查也值得派出去**：改完一批代码、用户让你「看看有没有问题」、或者交工前自查时，' +
      '把审查拆成彼此独立的角度 —— 比如「逻辑与边界条件」「异常处理与资源释放（句柄、监听、定时器、订阅有没有收）」「需求点核对与遗漏」。' +
      (canParallel
        ? `同一轮连写 ${Math.min(3, lanes)} 个 \`task(mode=explore)\`，一个盯一个角度。它们只能读、不能写，所以互不干扰，也不会把你正在改的文件搅坏；几份结论由你合成一份再答用户，不要原样转述。`
        : '派 1 个 `task(mode=explore)`，让它依次查这几个角度（' +
          (workers > 0 ? '本次只放得下 1 路，理由见下一条）' : '本机只能串行，理由见下一条）') +
          '。它只能读不能写，改不坏你正在动的文件；结论由你核对后合成一份再答用户。') +
      '需要动手修的地方自己改，或另派完整模式的 task —— 别把「改」派给 explore。'
  )
  if (workers > 0 && canParallel) {
    rules.push(
      `已经配好 ${workers} 个子智能体，本次能真正并行 ${lanes} 路，上面那种「同一轮连写多个 task」现在就能用。`
    )
  } else if (workers > 0) {
    /**
     * 配了子智能体、但这次只放得下 1 路（只配了 1 个，或那 1 个正在冷却/没就绪）。
     * 这时必须点明「会排队」，否则模型照样连写 3 个 —— 排队跑完的时间和串行做一遍
     * 差不多，还要多付几次上下文。
     */
    rules.push(
      `配了 ${workers} 个子智能体，但本次同时只放得下 ${lanes} 路：多写的 task 会一个个排队跑。` +
        '要多角度检查就派 1 个，让它在同一个 prompt 里依次过一遍；真正互不依赖的活再拆成多条。'
    )
  } else {
    rules.push(
      '（当前没配子智能体时 task 照样可用：它有独立上下文，自己读写文件，只把结论交回来，中间过程不占你的上下文。要查很多文件才答得上来的问题，优先派出去。）'
    )
    if (!canParallel) {
      rules.push(
        '但这条路在本机是**串行**的：本地 llama.cpp 只有一个槽位，多路 task 会排队，一个跑完才轮到下一个（每个还要重付一次 prefill）。' +
          '所以真正互不依赖、各自能独立跑完的活再拆成多条，否则一条里连着做更省时间。'
      )
    }
  }
  if (rememberOn) {
    rules.push(
      '遇到值得下次知道的事实（构建/测试命令、目录约定、用户偏好、踩过的坑）就调 remember 记一条，不要重复记同一件事。'
    )
  }
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
/** 自动派发的两种场景：检查型（要的是审查，不是改）、摸底型（要翻很多文件才看得清现状） */
export type DelegateHint = 'review' | 'survey'

/** 寒暄 / 应答：这类消息一个字都不该触发派发 */
const CHITCHAT_RE =
  /^\s*(?:你好|您好|hi|hello|hey|在吗|在不在|谢谢|感谢|辛苦了|ok|okay|嗯|好的|收到|早|晚安)\s*[!！。.~～?？]*\s*$/i
/**
 * 代码语境：派发的价值在「有现成的代码要读」，没这个信号就不派。
 * 从零写一个演示页时派子 agent 只是把一句话拆成一句话 —— 那种活自己写更快。
 */
const CODE_CTX_RE =
  /代码|文件|模块|项目|仓库|目录|函数|接口|脚本|配置|报错|异常|测试|依赖|调用|实现|逻辑|src\/|\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|json|ya?ml|toml|md)\b|`[^`]+`/i
/** 审查意图：要的是「检查」，不是「改」 */
const REVIEW_RE =
  /审查|复查|自查|体检|核对|检查|有没有.{0,6}(?:问题|毛病|bug|漏洞)|看看.{0,8}(?:有没有|是否|问题|毛病|bug|漏洞)|找.{0,6}(?:bug|问题)|对不对|合不合|代码质量|review/i
/**
 * 故障报障：用户最常这样开口 —— 「打开 sgf文件后棋子数量不对」「这个功能坏了」。
 * 这批词单独看很泛（「不对」「错了」日常也用），所以**绝不单独判定**：
 * delegateHint 里仍要求 CODE_CTX_RE 先命中（有代码语境），才把它当审查信号。
 * 这样「今天心情不对」「这个想法错了」之类不会被误派去查代码。
 */
const BROKEN_RE =
  /不对|不正确|不对劲|错了|坏了|坏掉|出问题|有问题|故障|失效|崩了|崩溃|挂了|用不了|不能用|对不上|不一致|对不齐|显示错误|算错|数量错/i
/** 规模信号：这类活往往要翻很多文件，正是子 agent 擅长的 */
const SCALE_RE =
  /整个|全部|所有|逐个|每个|全量|跨|多处|多个文件|模块|架构|链路|调用链|流程|全项目|全局|项目里|重构|迁移|梳理|排查/i

/**
 * 这一轮要不要提醒模型「先派个只读子 agent」。
 *
 * 为什么要有它：派不派活过去完全由模型自己判断，而系统提示里的「3 步以上才拆」
 * 和「1～2 步自己做」是两道劝退闸 —— 实测连开几个会话，task 调用恒为 0，
 * 用户得手打一句「你有员工，派活给他」才破冰。能力早就在，缺的是触发信号。
 *
 * 判据刻意保守，宁可漏派也不要误派：
 * - 只看用户这一轮的原话（被注入的续跑 / 验证文字不算）；
 * - 只在第一步判一次，且 task 得真在工具表里（小模型、档案白名单里没有就不提）；
 * - 寒暄、没有代码语境的纯问答一律不触发；
 * - 计划模式不触发：那一轮本来就不许动手。
 */
export function delegateHint(input: {
  text: string
  step: number
  hasTask: boolean
  enabled: boolean
  planMode?: boolean
  nonInteractive?: boolean
}): DelegateHint | null {
  // 非交互（定时任务 / 交接）不提醒：没人盯着，多开一个子 agent 只是白烧 token
  if (!input.enabled || !input.hasTask || input.nonInteractive || input.planMode) return null
  // 只在第一步：后面每步都念一遍，模型会以为「一直没派成功」而反复派
  if (input.step > 0) return null
  const raw = (input.text ?? '').trim()
  if (raw.length < 6) return null
  if (CHITCHAT_RE.test(raw)) return null
  if (!CODE_CTX_RE.test(raw)) return null
  // 审查词优先级最高：明确要「检查」的，一律 review
  if (REVIEW_RE.test(raw)) return 'review'
  if (SCALE_RE.test(raw)) return 'survey'
  // 长需求通常就是多文件的活：本地小模型一口气读下去必然吃满窗口
  if (raw.length >= 80) return 'survey'
  /**
   * 故障报障词放最后 —— 它和上面两者会抢：
   * - 短报障（「打开 sgf文件后棋子数量不对」）才是单点 review；
   * - 又长又带「出问题」的多文件需求，上面已被长度兜底成 survey（派多路摸底更合适）。
   * 且 BROKEN_RE 始终在 CODE_CTX_RE 之后，「不对/坏了」这类泛词只在代码语境里才算数。
   */
  if (BROKEN_RE.test(raw)) return 'review'
  return null
}

/**
 * 提醒文案。
 *
 * 按能不能真并发分两版：本地单槽 llama 上多派几路只会在闸门里排队、
 * 各自重付一次 prefill（见 runTaskBatch 的 MAX），硬劝「派 3 个」只会更慢。
 * 无论哪一版都只说 mode=explore —— 写文件的子任务不在这条自动通道上。
 */
export function delegateNoteText(kind: DelegateHint, parallel: boolean): string {
  const how = parallel ? '2～3 个' : '1 个'
  // 单路时不能写「它们」：模型会以为暗示它该派多个，和上一句「派 1 个」矛盾
  const it = parallel ? '它们' : '它'
  const split = parallel
    ? '，按「逻辑与边界」「异常与资源释放」「需求核对」各盯一个角度'
    : '，让它把逻辑与边界、异常与资源释放、需求核对依次过一遍'
  if (kind === 'review') {
    return (
      `【自动派发】用户这轮要的是「检查」，不是「改」：先派 ${how} task(mode=explore) 做只读审查${split}，` +
      `拿到结论再决定改不改。${it}改不了文件，所以不会和你正在改的东西打架。` +
      '别自己一路 grep 到底 —— 那会把上下文吃满，还只看了一个角度。这次派完就继续干活，不要反复派。'
    )
  }
  return (
    `【自动派发】这件事要翻的文件不止一两个：先派 ${how} task(mode=explore) 摸清现状（相关文件在哪、调用链怎么走、现有实现长什么样），` +
    '拿到结论再动手改。不要凭假设直接写 —— 改错一处要回滚的代价比派这一趟高得多。这次派完就继续干活，不要反复派。'
  )
}

/**
 * 这一轮用户真正说的话。
 *
 * 跳过程序注入的 runtime / continue / compact 消息（它们不是用户意图），
 * 并切掉附件正文 —— 附件里可能是整份源码，拿它去匹配「代码语境」等于永远命中。
 */
export function lastUserText(session: Session): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i]
    if (m.role !== 'user') continue
    if (m.id === 'runtime' || m.id === 'continue' || m.id === 'compact-user') continue
    const at = m.content.indexOf(ATTACH_BODY_MARK)
    return (at >= 0 ? m.content.slice(0, at) : m.content).slice(0, 2000)
  }
  return ''
}

export function runtimeBlock(opts: {
  clock: string
  hook?: string | null
  verify?: string | null
  diag?: string | null
  nudge?: string | null
  cont?: string | null
  /** 自动派发提醒：由 delegateHint / delegateNoteText 生成，不传就没有这一段 */
  delegate?: string | null
}): string {
  const parts = [`【本轮环境】当前时间：${opts.clock}（系统本地时区）`]
  /**
   * 派发提醒放在最前面：它是「开工前该做的第一步」，压在最后会被
   * 验证失败 / 编译诊断那几段挤掉注意力。
   */
  if (opts.delegate) parts.push('', opts.delegate)
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
  /**
   * 每条会话此刻有几个子 agent 在跑。侧栏的「第二枚机器人」看的就是它。
   * 单独存而不塞进 live：live 是「谁占着会话锁」的快照，子 agent 并不额外占锁。
   */
  private subagents = new Map<string, number>()
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
  /** 各会话当前的执行计划（update_todos 维护；同时驱动界面与「按步推进」门禁） */
  private todos = new Map<string, TodoItem[]>()
  /**
   * 打开验收没通过的文件：sessionId → 相对路径 → 错误摘要。
   *
   * 清空的条件只有一个：这个文件重新写完之后，在浏览器里真的打开无报错。
   * 它挡的是「页面还是白屏，模型却把计划项标成完成」—— 这是整个流程里最容易
   * 骗过使用者的一个动作，因为它不需要任何证据。
   */
  private verifyFails = new Map<string, Map<string, string>>()
  /**
   * 门禁连续拒绝次数：sessionId → 次数。
   *
   * 需要上限，否则一个改不动的 9B 会在「提交计划 → 被拒 → 再提交」里空转，
   * 把一步的预算全烧在重发计划上。到顶就放行，但要让用户看见是强推过去的。
   */
  private planGateStrikes = new Map<string, number>()
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
   * 每个会话当前实际在用的供应商 id。
   * 等审批 / 等回答时用它给本地实例续命 —— 那段时间没有任何在途请求，空闲卸载会误判成闲置。
   */
  private liveProviders = new Map<string, string>()
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
          position: running ? 0 : this.queue.position(r.sessionId),
          subagents: this.subagents.get(r.sessionId) ?? 0
        }
      })
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  /**
   * 子 agent 开始/结束时加减计数。try/finally 在调用处包住整段执行，
   * 用户点「停止」抛 AbortError 也不会把机器人永远留在侧栏上。
   */
  private markSubagent(sessionId: string, delta: 1 | -1): void {
    const next = Math.max(0, (this.subagents.get(sessionId) ?? 0) + delta)
    if (next === 0) this.subagents.delete(sessionId)
    else this.subagents.set(sessionId, next)
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
      startedAt: Date.now(),
      subagents: 0
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

  /**
   * 折叠历史时的落盘旁路。
   *
   * 位置选在工作区的 `.roroto/spill/<会话>/`，不是 userData：工具的 safePath 把读写
   * 限定在工作区内，存到别处的文件模型根本 read_file 不了，那就只剩「用户能看」这点价值，
   * 而这条改动的全部意义就是让模型能**按需取回**被折叠的原文。
   * `.roroto` 本来就是这个项目的内部目录（已进 artifacts 的忽略列表），不污染源码树。
   *
   * 没有工作区的会话（纯聊天）不落盘：给了路径它也读不到，不如保持原来的折叠文案。
   */
  private spillOptionsFor(session: Session): CompactOptions {
    return session.workspace ? { spill: (text, meta) => this.spillTo(session, text, meta.toolName) } : {}
  }

  /** 把一段输出存进工作区的 spill 目录，返回模型能 read_file 的相对路径 */
  private spillTo(session: Session, text: string, toolName?: string): string | null {
    const workspace = session.workspace
    if (!workspace) return null
    const abs = saveSpill(path.join(workspace, '.roroto', 'spill'), session.id, text, { toolName })
    if (!abs) return null
    return path.relative(workspace, abs).split(path.sep).join('/')
  }

  /**
   * 输出被截断、工具参数只写了一半时，接着写而不是重来。
   *
   * 以前撞墙只有一条路：拦下这次写入，告诉模型「大文件分两步走」。
   * 可模型已经把 21574 字符的 HTML 写出来了，可能只差最后十几行 ——
   * 全部丢掉重写，等于白烧一次 8192 tokens 和三分半钟（本地 9B 的真实账单，
   * 而且下一轮大概率还会撞）。
   *
   * 实现放在 heal.ts：子 agent 也要用同一套（它只有 30 步，更经不起重写），
   * 而子 agent 不是这个类的实例，逻辑长在这里它就拿不到。
   *
   * @returns 补全成功的条数。0 说明这一轮确实没写完 —— 调用方可以退回升档重试
   */
  private async healTruncatedWrite(
    session: Session,
    provider: ProviderConfig,
    messages: ChatMessage[],
    signal: AbortSignal,
    result: StreamResult,
    ctxWindow: number
  ): Promise<HealResult> {
    const out = await healTruncatedWrites({
      provider,
      messages,
      calls: result.toolCalls,
      signal,
      /**
       * 续写请求要能真的发出去：原请求就是因为 prompt 太大才被挤断的，
       * 拿同一份满窗 prompt 再发一次，多半直接失败，然后安静退回「拦下」。
       * 折到 60% 窗口并不是精确值，只是给续写留出落笔的地方。
       */
      shrink: (list) => compact(list, Math.max(1200, Math.floor(ctxWindow * 0.6)), this.spillOptionsFor(session)),
      onUsage: (u) => {
        const cur = result.usage
        result.usage = {
          prompt: (cur?.prompt ?? 0) + u.prompt,
          completion: (cur?.completion ?? 0) + u.completion,
          cached: (cur?.cached ?? 0) + (u.cached ?? 0) || undefined,
          promptN: cur?.promptN,
          promptMs: cur?.promptMs
        }
      },
      /**
       * 续写拼完但结构仍不完整时，把半成品留在工作区。
       * 让模型 read_file 接着补，而不是把两万字符再吐一遍。
       */
      onSalvage: (text) => this.spillTo(session, text, 'partial'),
      onHint: (message) => this.emit(session.id, { type: 'hint', message })
    })
    return out
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

  /**
   * 等用户期间给本地实例续命。
   *
   * 审批 / 提问弹窗最长会挂 10 分钟，这段时间没有在途 HTTP 请求、`/slots` 也是空闲的，
   * 空闲卸载只认这两条信号 —— 于是模型被停掉，用户点完「允许」，下一句就是
   * 「进程不在了」。每 45 秒打一次点，成本可忽略，换来的是等待期间模型不被回收。
   *
   * 返回 stop，由等待方在收尾时调用（正常回答 / 中止 / 超时都要清）。
   */
  private keepLocalWarm(sessionId: string): () => void {
    const timer = setInterval(() => {
      const key = this.liveProviders.get(sessionId)
      if (key) touchIdle(key)
    }, 45_000)
    timer.unref?.()
    return () => clearInterval(timer)
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
      const stopWarm = this.keepLocalWarm(sessionId)
      // 同 askApproval：signal 已断时会在建 timer 之前就 finish，用 const 会踩 TDZ
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (answer: string) => {
        if (settled) return
        settled = true
        this.questions.delete(request.id)
        if (signal) signal.removeEventListener('abort', onAbort)
        if (timer) clearTimeout(timer)
        stopWarm()
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
      const stopWarm = this.keepLocalWarm(sessionId)
      // 先声明再赋值：signal 已经断了的分支会在下面立刻 finish，
      // 那时 timer 还没建立，用 const 会踩进 TDZ 直接抛 ReferenceError
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (approved: boolean): void => {
        if (settled) return
        settled = true
        this.approvals.delete(request.id)
        if (signal) signal.removeEventListener('abort', onAbort)
        if (timer) clearTimeout(timer)
        stopWarm()
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
          id: options?.userMessageId ?? store.newId(),
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
    // 一轮收工时子 agent 必然已经结束，顺手清掉计数，别留到下一轮
    this.subagents.delete(sessionId)
    this.alwaysApprove.delete(sessionId)
    this.alwaysApproveHigh.delete(sessionId)
    // 插话只属于这一轮：不清掉的话，下次提问会莫名带上上一轮没说完的那句话
    this.steers.delete(sessionId)
    this.stepCut.delete(sessionId)
    this.liveProviders.delete(sessionId)
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
    try {
      await this.send(
        sessionId,
        `继续。上次执行被中断了，请从断点接着做完，不要重复已经完成的部分。${brief}`,
        undefined,
        // id 标成 continue：让 lastUserText() 跳过这句注入文字、回溯到用户原始意图，
        // 否则续跑这一轮的自动派发判定会落在这句没有代码语境的话上，子 agent 再也不启动。
        { reason: 'resume', userMessageId: 'continue' }
      )
    } catch (err) {
      /**
       * 恢复本身失败（典型：历史已经压不下去，服务端一直 400）：
       * 把状态从 running 改成 interrupted，别让启动横幅无限次把用户骗回同一个死循环。
       *
       * 文件不删：计划、改过的文件都还在，用户想再试直接发一句「继续」即可；
       * 只是它不再被 listInterruptedCheckpoints 当成「还能自动恢复」的任务。
       */
      if (cp) {
        await saveCheckpoint({ ...cp, status: 'interrupted', updatedAt: Date.now() }).catch(
          () => undefined
        )
      }
      throw err
    }
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
          '必须直接说明这一点，并给出可行做法：在「模型设置 → 线上模型」里换成支持看图的模型（如 qwen2.5-vl、llava、gemma3、mistral-small-3.1、gpt-4o），',
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
      if (body.length > 600) body = clipSafe(body, 600)
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
    onText: (text: string) => void,
    opts?: {
      escalate?: boolean
      onProgress?: (generated: number) => void
      onWait?: (info: { waitedMs: number; promptTokens: number }) => void
    }
  ): Promise<{ provider: ProviderConfig; result: StreamResult }> {
    const chain: ProviderConfig[] = [primary]
    if (config.autoFallback !== false) {
      // 设置页不再提供备用勾选：本地供应商自动成链，显式勾过的老配置优先
      chain.push(...fallbackCandidates(config.providers, primary.id))
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
            escalate: opts?.escalate,
            onProgress: opts?.onProgress,
            onWait: opts?.onWait,
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
          if (retryable(err) && !quietTimeout(err) && attempt < RETRY_TIMES) {
            const wait = RETRY_BASE_MS * (attempt + 1)
            const reason = (err as Error).message.slice(0, 80)
            this.emit(sessionId, {
              type: 'hint',
              message: `${use.name} 这次没成功（${reason}），${Math.round(wait / 1000)} 秒后重试（第 ${attempt + 1}/${RETRY_TIMES} 次）。`
            })
            await waitAbortable(wait, signal)
            continue
          }
          /**
           * 首字前的超时不要「换一家」也不要原地重试：换一家等于悄悄换模型，
           * 重试等于让服务端再 prefill 一遍同样长的提示。统一抛回上层，
           * 由它决定「缩一半提示再试」还是「停下来说清楚」。
           */
          if (quietTimeout(err)) throw err
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
   * 这个模型不吃原生工具调用：记进配置里的 noTools 字段（设置页已不提供该勾选）。
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
    // 记下来：等审批 / 等回答时按它给本地实例续命（见 keepLocalWarm）
    this.liveProviders.set(session.id, runProvider.id)
    // 未选择工作区时，默认使用软件根目录下的 workspace/
    // 定时任务可以钉死一个工作区：档案是给某个仓库用的，不该跟着界面当前选择跑
    const forcedWs = options?.workspace ? path.resolve(options.workspace) : null
    if (forcedWs) await fs.mkdir(forcedWs, { recursive: true }).catch(() => undefined)
    const workspace = forcedWs ?? (await effectiveWorkspace(config))
    /** 本轮开始时刻：收工清理只动这之后出现的临时脚本 */
    const runStartedAt = Date.now()

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
    /** 覆盖度提示只回灌一次：它是建议，不是门禁，反复推只会拖长任务 */
    let stateHintRounds = 0
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
     * 写入账本：同一个文件在一轮里被整份重写了多少次、最大写到多大。
     *
     * 为什么需要它：重复动作护栏比的是「调用参数是否一模一样」，而实测里模型每次
     * 重写的参数都略有差别（换个变量名、多一句注释），护栏一次都没触发 —— 结果同一个
     * 文件被写了十几次，每次都在几百字符处被截断，六万 token 只换来 693 字节。
     * 这里换一个与「参数像不像」无关的口径：**这个文件到底有没有长大**。
     *
     * 只记整份 write_file（append 与 edit_file 不算）：它们在正常迭代里本来就会
     * 反复出现，算进去会把「小步修改」误判成空转。
     */
    const writeLedger = new Map<string, { attempts: number; maxSize: number }>()
    /** 触发产出比熔断时的结论；非空即收工 */
    let writeBreaker: string | null = null

    /**
     * 自动续跑。
     *
     * 模型经常「早退」：写完一两个文件就说「接下来我会…」，或者计划里还留着没勾掉的项，
     * 这一轮就结束了 —— 引擎把这当成「它认为做完了」，直接把控制权交回用户，
     * 用户只能一次次手点「继续」。下面这些状态就是用来把这一轮自己接上去的。
     */
    const autoContinue = config.autoContinue !== false
    /**
     * 用户这一轮的原话：自动派发只按它判断意图。
     * 取一次就够 —— 循环中途注入的续跑 / 验证文字不是用户意图，不能拿来当触发依据。
     */
    const turnText = lastUserText(session)
    /** 一次提问最多连跑多少步：开着自动续跑时放宽到 4 倍，但仍有硬上限，防止真死循环 */
    const stepBudget = autoContinue
      ? Math.min(600, Math.max(config.maxSteps, config.maxSteps * 4))
      : config.maxSteps
    /** 已自动续跑次数上限（每次续跑之间必须真的有产出，见下面的 sinceContinue 判断） */
    const MAX_CONTINUE = 12
    /**
     * 软预警阈值：一次运行累计超过这个 token 数（用户没设硬上限时）就提示一次。
     * 150 万是实测里「正常多文件任务 vs 空转」的分界附近：一个单页游戏烧到 282 万
     * 明显是模型在反复读文件试错，早该有人提醒它或提醒用户换方向。
     */
    const SOFT_TOKEN_WARN = 1_500_000    /** 一轮里重复动作被拦下这么多次，就不再让它自己折腾了 */
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
    /**
     * 临时脚本护栏：和签名护栏一起用，但判据是「同一目录第几个脚本」。
     * 模型绕过签名护栏的方式就是换文件名（`_tmp_fix.js` → `_tmp_inspect.js`），
     * 参数每次都不同，只有按目录计数才拦得到。
     */
    const scratchGuard = createScratchGuard()
    /**
     * 连续同类错误护栏：上面两道都盯「调用动作」，模型换脚本名/换参数就能绕过。
     * 这道只盯结果里的错误类别——换皮重试时错的始终是同一类（如一直 ENOENT），
     * 连续几次就把「工作目录在哪、别再写外部临时脚本」直接回灌给它。
     */
    const errorStreak = createErrorStreakGuard({ workspace })
    /** 本批次被护栏拦下的次数：连着拦说明它自己走不出去，该停了 */
    let repeatBlocked = 0
    let repeatHinted = false
    let scratchHinted = false
    /** 护栏判定「这一轮已经不会自己走出去了」：跳出 step 循环，而不是继续空转 */
    let repeatHalted = false
    /** 连续同类错误护栏判定要收工（本批次工具跑完再生效，结果要先落库给模型看） */
    let errorHalted = false

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
    // 没设上限时的软预警：默认不限额是为了「行为不变」，但一次任务烧掉上百万
    // token 还没做完，几乎可以肯定是模型在空转 —— 这时主动提醒一次，不打断。
    let softWarned = false

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
        // 只留签名：完整 args 里可能是整份文件（单条上万字符），落盘没意义，还会让 checkpoint 越滚越大
        lastCalls: recentCalls.slice(-10).map((s) => (s.length > 300 ? clipSafe(s, 300) : s)),
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

      // 软预警：用户没设单次上限、但这一轮已经烧掉异常多的 token，主动提醒一次。
      // 不打断（默认不限是刻意的），只是把「可能该收手/拆小/换模型」这条信息交出去。
      if (!quotaWaived && !softWarned && parseLimit(config.tokenLimitPerRun) === 0 && runTokens >= SOFT_TOKEN_WARN) {
        softWarned = true
        this.emit(session.id, {
          type: 'hint',
          message:
            `这一轮已经用了 ${Math.round(runTokens / 1000)}k token 还没结束。` +
            '如果是本地小模型在反复空转，建议拆小任务或换更强模型；' +
            '要设硬上限，到「软件设置 → 审批与执行」里给「单次运行 token 上限」填一个数字。'
        })
      }

      // 切换过供应商后，提示词和「小模型」判断都要按新模型来
      const smallNow = isSmallModel(runProvider.model)
      // 小模型走极简工具表；窗口紧张的本地模型走「精简 + toolbox 网关」；其余全量
      const pick = smallNow ? { list: tools, hidden: [] as ToolSpec[] } : pickTools(fullTools, ctxWindow)
      const stepTools = pick.list
      const hiddenSpecs = pick.hidden
      // 输出也要留位置：窗口是「提示 + 生成」共用的，全给历史会把回答挤断
      const outputReserve = Math.min(4096, Math.max(512, Math.floor(ctxWindow * 0.25)))

      /**
       * 配了几个「子」模型（只用于措辞：「配了几个」）。
       * 判断能不能并行**不用它** —— 配了 1 个也是串行，得看真正就绪的路数。
       */
      const workerCount = subAgentProviders(config.providers, config.activeId ?? runProvider.id).length
      /**
       * 本次真能并行几路。系统提示和自动派发文案都从这里取，执行层的并发上限
       * （runTaskBatch 的 MAX）用的也是同一个算式 —— 三处一个口径。
       *
       * 这里必须 await：`workerPool` 要查本地实例状态，而 `promptFor` 是同步的，
       * 在它里面 await 会把提示构建变成异步，影响所有调用点。
       */
      const lanes = await parallelLanes(runProvider, config)

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
              toolbox: hiddenSpecs.length > 0,
              // 「能不能连派多个」只看本次真能并行几路，不看配了几个
              subAgents: workerCount,
              lanes
            })
        return mode === 'plan' ? `${base}\n\n${PLAN_MODE_NOTE}` : base
      }
      /**
       * 自动派发：任务像「要翻很多文件」或「要的是检查」时，程序在当轮提醒一句。
       *
       * 为什么不能只靠系统提示：派不派活过去完全由模型自己判断，实测连开几个会话
       * task 调用恒为 0，用户手打「你有员工，派活给他」才破冰 —— 能力早就在，
       * 缺的是每轮都成立的触发信号。这里只提醒，派几个、派什么仍由模型决定。
       */
      const delegateTip =
        delegateHint({
          text: turnText,
          step,
          hasTask: stepTools.some((t) => t.name === 'task'),
          enabled: config.autoDelegate !== false,
          planMode: mode === 'plan',
          nonInteractive
        }) ?? null
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
        cont: continueNote,
        // 能不能真并发只看 lanes：有 worker 池按池子，没有时本地单槽 1、远端 3
        delegate: delegateTip ? delegateNoteText(delegateTip, lanes >= 2) : null
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
        // 留 10% 余量（原来 5%）：tokenizer 与估算总有偏差，本地模型上几十个 token 就足以让整轮 400
        const usable = Math.floor((ctx - overheadOf(prompt, tailNote) - outputReserve) * 0.9)
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
        Math.max(
          600,
          Math.min(Math.floor(ctx * 0.7), Math.floor((ctx - overhead - outputReserve) * 0.9)) -
            summarized
        )

      /**
       * 折叠旁路只建一次：里面要拼工作区路径，而 buildMessages 在一次请求里会被
       * 反复调用（预算逐级收紧时会重试三次），没必要每次都算。
       */
      const compactOpts = this.spillOptionsFor(session)

      const buildMessages = (cap: number): ChatMessage[] => {
        // 先折叠较早的工具输出，再按预算裁剪：这样 compact 丢掉的是整轮对话，
        // 而不是「把宝贵的轮次换成几屏早就没用的 grep 结果」
        const history = compact(maskObservations(rest, cap, compactOpts), cap, compactOpts)
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
      let loopGuard = createLoopGuard()
      // 升档重试只做一次：第二次还撞就该让用户看到「换更大输出的模型」这条建议了
      let escalated = false

      let attempt: { provider: ProviderConfig; result: StreamResult } | null = null
      /**
       * 实时生成量：模型写大文件时一次调用能吐七八千 token、跑几分钟，这期间
       * 既没有正文 delta 也没有 usage，界面上除了计时器什么都没有，用户会以为卡死。
       * 把已生成量节流上报（~300ms 一次），界面就能显示「正在生成 · 约 3.2K」。
       * 一帧一报太密，数字会一直闪。
       */
      let lastProgressAt = 0
      let reportedGen = 0
      const onProgress = (n: number): void => {
        if (n <= reportedGen) return
        reportedGen = n
        const now = Date.now()
        if (now - lastProgressAt < 300) return
        lastProgressAt = now
        this.emit(session.id, { type: 'gen_progress', completion: n })
      }
      let spoke = false
      /**
       * 首字之前的静默期。
       *
       * 本地模型收到 1.5 万 token 的提示后，要先整段 prefill 才吐第一个字；弱卡上几分钟是常态。
       * 这段以前是**完全静默**的：界面只有计时器在走，用户以为死了，实际上服务端正在满负荷算。
       * 这里把「已等多久、这次要读多少」定期说出去 —— 只报到 90 秒，之后每分钟一条，
       * 避免大任务刷屏。
       */
      let waitEmittedAt = 0
      const onWait = (info: { waitedMs: number; promptTokens: number }): void => {
        const s = Math.round(info.waitedMs / 1000)
        const due = waitEmittedAt === 0 ? s >= 30 : s - waitEmittedAt >= 60
        if (!due) return
        waitEmittedAt = s
        const k = info.promptTokens >= 1000 ? `${(info.promptTokens / 1000).toFixed(1)}K` : String(info.promptTokens)
        this.emit(session.id, {
          type: 'hint',
          message:
            `还在等第一个字：这次请求约 ${k} tokens，已等 ${s} 秒。` +
            '本地模型要先把整段提示读完才开始生成，上下文越长这一步越慢，属于正常。' +
            '超过 10 分钟仍无输出会自动停下并说明原因。'
        })
      }
      /** 首字超时后缩小提示重试的次数：一次就够，再缩也过不去就是模型 / 显存的问题 */
      let shrunkForTimeout = 0
      // 撞上「超出上下文」时自动压缩历史重试：这类错误换供应商没用，但压小历史就能过，
      // 不该把一句 400 甩给用户（尤其是「继续」这种什么都没干就失败的情况）
      for (let retry = 0; ; retry++) {
        /**
         * 发送前先按「历史 + 工具定义」估一遍（system 与 tailNote 已经算在 messages 里，别重复加）。
         * 超了就再瘦一次，别等 400 回来 —— 一次 400 要等服务端把 prompt eval 跑到报错点，
         * 本地卡上白白烧几十秒，还得多一轮重试。
         */
        const requestEstimate = messagesTokens(messages) + toolSpecsTokens(stepTools)
        if (requestEstimate > ctxWindow * 0.98) {
          stepCap = Math.max(600, Math.floor(stepCap * 0.7))
          messages = buildMessages(stepCap)
        }
        // 让界面知道这一轮真实吃了多少上下文（估算值，中文≈1 字 1 token，代码≈3 字符 1 token）
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
            },
            { onProgress, onWait }
          )
          break
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err ?? '')
          /**
           * 首字之前的超时：唯一的出路是把这次要读的东西变少。
           *
           * 不这么做的话，「超时 → 原样重发 → 再从头 prefill → 再超时」会无限循环，
           * 用户看到的就是十几分钟没有任何动静。缩一半历史再试一次，还不行就停。
           */
          if (!signal.aborted && !spoke && quietTimeout(msg)) {
            if (shrunkForTimeout >= 1) throw err
            shrunkForTimeout += 1
            stepCap = Math.max(600, Math.floor(stepCap * 0.5))
            messages = buildMessages(stepCap)
            waitEmittedAt = 0
            this.emit(session.id, {
              type: 'hint',
              message:
                '这次请求在吐出第一个字之前就超时了：多半是提示太长、预填充跑不完（也可能是显存不足在反复换页）。' +
                '已把历史压缩一半重试一次；如果仍然不行，请缩小任务范围、或把「软件设置 → 上下文」调小一档再试。'
            })
            continue
          }
          if (signal.aborted || spoke || !isContextOverflow(msg)) throw err
          /**
           * 已经砍过两次历史还是超窗：别再甩一句「HTTP 400」了事。
           * 用户看到的应该是一个能动手的下一步，而不是一串服务端原文。
           */
          if (retry >= 2) {
            /**
             * 提示必须按当前配置分支：`contextLimit` 关掉时，`ctxWindowFor` 根本不读「上下文」里那个值，
             * 让用户「调到 8192」是句空话 —— 他调完还会以同样的 400 回来。
             */
            const advice =
              config.contextLimit === true
                ? '① 到「软件设置 → 上下文」把上限调得更小（引擎会按更小的预算压缩历史）；② 换上下文更大的模型；③ 新开一个会话重说需求。'
                : '① 到「软件设置 → 上下文」打开「限制上下文」并填一个更小的值（只填数字、开关不打开是不生效的）；② 换上下文更大的模型；③ 新开一个会话重说需求。'
            throw new Error(`${msg}\n这轮对话的历史已经压到极限。可以：${advice}`)
          }

          const proved = contextLimitOf(msg)
          // 服务端报的上限比我们以为的小：以后都按它的来
          if (proved > 0 && proved < ctxWindow) {
            ctxWindow = Math.max(2048, proved)
            void this.rememberCtx(runProvider.id, ctxWindow)
          }
          /**
           * 必须在上一次的基础上继续砍。
           * 以前每次都从 historyCap(ctxWindow) 重算 0.5，只要 ctxWindow 没变，两次算出来一模一样，
           * 于是三次重试发出的是同一份历史 —— 日志里 task 24031/24034/24037 全是 16431 tokens，
           * 服务端也三次都回同样的 400。递减才是真的递减。
           */
          stepCap = Math.max(600, Math.floor(Math.min(stepCap, historyCap(ctxWindow)) * 0.5))
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
      let result = attempt.result
      // 真的换了供应商：后面的步骤直接用新的，避免每轮都先撞一次墙
      if (attempt.provider.id !== runProvider.id) {
        runProvider = attempt.provider
        this.liveProviders.set(session.id, runProvider.id)
        const real = await effectiveContextWindow(runProvider)
        ctxWindow = this.ctxWindowFor(runProvider, config, real)
      }

      /**
       * 撞到输出上限、工具参数只写了一半：先试着把剩下的续出来。
       * 必须在「落库 + 执行工具」之前 —— 参数补全后这一条就是个正常调用，
       * 后面的截断拦截、参数容错都按正常流程走。
       */
      const healOut = await this.healTruncatedWrite(
        session,
        this.fitted(runProvider, config),
        messages,
        signal,
        result,
        ctxWindow
      )

      /**
       * 升档重试：撞到输出上限、又没有可续写的写入时，换更大的输出预算重发一次。
       *
       * 为什么不一上来就给最大：云端网关按 max_tokens 预扣额度（OpenRouter 尤其明显），
       * 每句话都冻结 32K，余额不足的用户会直接 402。绝大多数回复 8K 就够，所以首轮小、
       * 撞墙才升 —— 和 Claude Code 的 8K→64K 同一个思路。本地模型反过来：不占预扣，
       * 首轮直接给足（见 providers/budget.ts），这里根本不会触发。
       *
       * 只升一次，且只在「续写也救不了」时升：已经写出 20K 字符的写入应该接着写，
       * 而不是整份丢掉重来。
       */
      if (healOut.healed === 0 && result.finishReason === 'length' && !escalated && healOut.oversize === 0) {
        const promptNow = messagesTokens(messages) + toolSpecsTokens(stepTools)
        if (escalationRoom(runProvider, promptNow) > 0) {
          escalated = true
          this.emit(session.id, {
            type: 'hint',
            message: '回答撞到输出上限，正在用更大的输出预算重发一次…'
          })
          // 界面上那半截正文必须清掉，否则重发的答案会接在半句后面
          this.emit(session.id, { type: 'assistant_reset', messageId })
          loopGuard = createLoopGuard()
          try {
            const again = await this.chatWithFallback(
              session.id,
              config,
              attempt.provider,
              messages,
              stepTools,
              signal,
              (t) => {
                if (loopGuard.push(t)) gate.push(t)
              },
              { escalate: true, onProgress }
            )
            // 第一次烧掉的 token 是真花的，不能因为结果被替换就不计
            const before = result.usage
            const after = again.result.usage
            if (before) {
              again.result.usage = after
                ? {
                    prompt: after.prompt + before.prompt,
                    completion: after.completion + before.completion,
                    cached: (after.cached ?? 0) + (before.cached ?? 0) || undefined,
                    promptN: after.promptN ?? before.promptN,
                    promptMs: after.promptMs ?? before.promptMs
                  }
                : before
            }
            attempt = again
            result = again.result
            if (again.provider.id !== runProvider.id) {
              runProvider = again.provider
              this.liveProviders.set(session.id, runProvider.id)
            }
          } catch {
            // 升档失败就按第一次的结果继续：已经拿到的内容不能再丢一次
          }
        }
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

            // 独立 smoke 断言：验证落到「模型自己写的 npm test」时，检查这套测试
            // 是不是只做了字符串存在性检查而根本没运行代码。是的话，即使 exit 0
            // 也不能算通过 —— 那正是「26 项 includes 全过但一行游戏没跑」的造假形态。
            if (result.ok && plan.smoke) {
              // 真正要查的是测试脚本本体；Python 计划会直接把测试文件带上来，
              // 否则 resolveTestTarget 只认 package.json，Python 项目的这条检查会一直空转
              const testTarget = plan.testFile
                ? path.resolve(workspace, plan.testFile)
                : await resolveTestTarget(workspace).catch(() => null)
              const s = testTarget ? await assertSmoke(testTarget).catch(() => null) : null
              if (s && s.existenceOnly) {
                const detail = s.suspicious.slice(0, 3).join('\n  ')
                const smokeNote =
                  `【独立 smoke 断言】这条「测试」没有真正运行程序，只是检查文件里有没有某些字符串，` +
                  `不能证明功能正常（${s.suspicious.length} 处存在性检查）。\n  ${detail}\n` +
                  `这种检查抓不到「键按了没反应」「画布没渲染」这类运行时问题。请换成真正启动/运行代码的验证，或说明为什么现有测试足够。`
                this.emit(session.id, { type: 'verify_result', command: plan.command, label: '独立 smoke 断言', ok: false, output: smokeNote, durationMs: 0 })
                verifyNote = smokeNote
                touched.clear()
                continue
              }
            }

            if (!result.ok) {
              // 失败就带着结论再走一轮，最多两次，避免修不好时无限循环
              verifyNote = `命令：${plan.command}（${plan.label}）\n${result.output}`
              // 验证失败也要记进 verifyFails：让「验收失败不得标完成」这条门禁能拦住
              // 模型在下一轮直接把 todo 标 completed 的偷跑（此前测试失败只影响 verifyNote，
              // 不进 todoGate 的 blocking，等于「验收失败不得标完成」对测试失败失效）。
              const fails = this.verifyFails.get(session.id) ?? new Map<string, string>()
              fails.set('<verify>', `${plan.label}未通过`)
              this.verifyFails.set(session.id, fails)
              touched.clear()
              continue
            }
            /**
             * 测试过了 ≠ 核心交互验过了。
             *
             * 围棋程序那次的教训：验证是 `import ui` + 几条字符串检查，全过，
             * 而轮次错乱、AI 卡死两个 bug 全漏。这里在「看起来通过」之后再问一次
             * 「测试里到底断言了什么」，没有状态断言就回灌一条提示让它补。
             * 只推一次、且不记失败 —— 这是建议，不是新的门禁。
             */
            if (stateHintRounds < 1) {
              const gap = await stateCoverageGap(workspace, [...touched]).catch(() => null)
              if (gap) {
                stateHintRounds += 1
                this.emit(session.id, {
                  type: 'verify_result',
                  command: plan.command,
                  label: '覆盖度提示',
                  ok: true,
                  output: gap,
                  durationMs: 0
                })
                verifyNote = gap
                touched.clear()
                continue
              }
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

        // 正常收工前最后一道：还有文件卡在验收失败，不能静默标完成。
        // verifyFails 里非空说明这一轮里 webcheck / 语法检查 / 独立验证还有未通过项，
        // 但模型既没继续修、计划也没能推进 —— 此时若直接收工会把「没跑起来」当成交付。
        // 再给模型一次机会：把失败项摆给它，让它回去修，而不是让用户拿到一个坏产物。
        const stillFailing = this.verifyFails.get(session.id)
        if (stillFailing && stillFailing.size > 0 && continues < MAX_CONTINUE) {
          const detail = [...stillFailing.entries()]
            .slice(0, 3)
            .map(([f, e]) => `${f}（${e}）`)
            .join('；')
          continues += 1
          sinceContinue = 0
          continueNote =
            `你宣布做完了，但下面这些验收项仍然未通过，还不能算完成：\n${detail}\n` +
            `按验收给出的提示修掉它们，重新打开验证通过后，再用 update_todos 把对应项标 completed。`
          this.emit(session.id, { type: 'auto_continue', round: continues, reason: '还有验收项未通过' })
          continue
        }

        // 正常收工：任务完成，清除 checkpoint（不是中断，下次启动不该提示恢复）
        persistCheckpoint('done')
        await clearCheckpoint(session.id)
        // 任务真正收工后清掉写前快照：回滚是「运行中改坏了」的兜底，交付后不再需要
        await clearSnapshots(workspace, session.id).catch(() => {})
        // 交付目录的卫生在「真正收工」这条路上也要做一次 —— 这里是主循环里最常见的一条出口
        await this.tidyWorkspace(session, workspace, runStartedAt)
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
          // handoff 不给子 agent：它没有身份、没法承担责任，要交接让父 agent 自己判断；
          // task 保留一层：子 agent 可以再派一层孙 agent（孙 agent 不能再派，见 subagent 的 depth 封顶）
          (t) =>
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
      /** 这一批里拦下了几条「截断写入」：只提示一次，别每拦一条弹一次 */
      let truncWriteSkipped = 0
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
        /**
         * 续写救回来了、但拼完结构仍不完整：同样不执行。
         *
         * 这是「正确性」而不是「效率」问题：一份缺收尾的文件写下去，会覆盖掉
         * 用户原本能用的版本，而且界面上看起来一切正常。拦下的文案由 heal 生成 ——
         * 它知道半成品存在哪、缺的是什么闭合标记，这里再拼一次只会拼错。
         */
        if (call.truncRejected) {
          truncWriteSkipped += 1
          if (truncWriteSkipped === 1) {
            this.emit(session.id, {
              type: 'hint',
              message: '续写后的内容仍不完整，已拦下这次写入，正在让模型接着补。'
            })
          }
          await this.skipTools(session, [call], call.truncRejected, announced)
          continue
        }
        // 工具网关：展开成真名后再走风险 / 审批 / 钩子，网关不是绕过检查的后门
        const unwrapped = unwrapToolbox(call, fullTools)
        if (unwrapped) call = unwrapped
        /**
         * 半截参数不执行。
         *
         * `argRepair` 有值说明模型给的原文不是合法 JSON，是容错层把没闭合的字符串补上的；
         * 反过来 JSON 完整的调用说明这条已经写完了，即使它后面的输出被切也照常执行。
         * 除了 `finish_reason=length`，还要兜住「服务端根本不报 length」的网关（中转站、
         * 部分 Ollama 版本）：那时只认「原文断在字符串中间」这个硬证据，尾逗号这类
         * 语法修复内容是完整的，不能误伤。
         */
        const rawArg = typeof call.args?.[RAW_ARG_KEY] === 'string' ? String(call.args[RAW_ARG_KEY]) : ''
        if (isTruncatedWrite(result.finishReason, call.name, call.argRepair, rawArg)) {
          truncWriteSkipped += 1
          const target = String(call.args?.path ?? call.args?.file_path ?? '目标文件')
          /**
           * 报「已生成多少字符、最后停在哪」而不是解析后的 content 长度。
           * 截断时 content 根本不存在（参数挂在 _raw 上），以前这里恒等于 0，
           * 模型读到「约 0 字符」完全不知道断在哪，只能整份重写。
           */
          const part = rawArg
            ? partialString(rawArg, WRITE_TEXT_KEYS)
            : null
          const wrote =
            part?.text.length ?? (typeof call.args?.content === 'string' ? call.args.content.length : rawArg.length)
          const tail = clipTailSafe(part?.text ?? '', 60).replace(/\s+/g, ' ').trim()
          if (truncWriteSkipped === 1) {
            this.emit(session.id, {
              type: 'hint',
              message: '上一条回复的输出被截断，半截的文件写入已拦下，文件保持原样。'
            })
          }
          // 没说 length 的网关要讲清判断依据，否则模型会去质疑「我明明写完了」
          const cutWhy =
            result.finishReason === 'length'
              ? '上一条回复撞到输出上限被切断'
              : '上一条回复在字符串中间就断了（这个服务端没有报 finish_reason，但内容确实没写完）'
          await this.skipTools(
            session,
            [call],
            `[已拦下·输出被截断] ${cutWhy}，这次「${call.name}」的参数只生成到一半` +
              `（已生成 ${wrote} 字符${tail ? `，最后停在「…${tail}」` : ''}），所以没有执行，${target} 保持原样。\n` +
              '半截内容写下去会把已经写好的文件覆盖成残废，然后你又得从头重写一遍 —— 这正是反复重写的原因。\n' +
              (truncWriteSkipped >= 2
                ? /**
                   * 第二次以上还撞墙，说明「它自己一次写完」这条路已经证明走不通了。
                   * 只劝一次是不够的：实测它会把同一句话读三遍然后照样重来，
                   * 所以这里点名换手段 —— 要么用 append 分段，要么派子 agent 分担。
                   */
                  '这已经是本次任务里第 ' +
                  truncWriteSkipped +
                  ' 次撞到输出上限了，说明「你一个人一口气写完」这条路走不通，别再试同一件事。\n' +
                  '两条可走的路，选一条，立刻做：\n' +
                  `  A) 用分段写：先 write_file 只写骨架（结构 + 空函数 + 结尾标记），再 write_file({append:true, content:"…"}) 一段一段往后接，每段控制在几千字符；\n` +
                  `  B) 派子 agent 分担：用 task 把「${target}」拆成互不依赖的几块（比如 HTML 结构 / CSS 样式 / JS 逻辑），每个 task 只写自己那一块，最后由你或其中一个 task 拼起来。\n` +
                  '不管走哪条，都不要再一次生成整份文件 + 长篇解释。'
                : '接下来这样做：大文件分两步走，先 write_file 只写骨架（函数签名和结构），' +
                  '再用 write_file({append:true}) 或 edit_file 一段一段填实现；' +
                  '一条回复里不要同时装「整份文件 + 长篇解释」。'),
            announced
          )
          continue
        }
        /**
         * 插话就停手：这一批里还没轮到的都不做了。
         * 断的是「动作」，所以已经在跑的那个由它自己响应 stepSignal 停下。
         */
        if (this.steered(session.id)) {
          notRun.push(...toolCalls.slice(ci))
          break
        }

        // 连续只读工具并发跑（读 5 个文件不该排 5 次队）；不适合并发就退回串行
        {
          const batch = await this.tryParallelReads({
            session,
            calls: toolCalls,
            from: ci,
            workspace,
            signal: stepSignal,
            cut: cut.signal,
            rootAborted: signal.aborted,
            permRules,
            agentId: memNs,
            readCap: Math.min(40000, Math.max(4000, Math.round(ctxWindow * 1.2))),
            hiddenSpecs: hiddenSpecs.map((t) => ({ name: t.name, description: t.description })),
            announced,
            callGuard,
            scratchGuard,
            errGuard: errorStreak
          })
          if (batch.consumed > 0) {
            /**
             * 这几笔账必须在这里补上：并发路径用 continue 跳过了循环尾部，
             * 而「上一轮到底有没有干活」直接决定自动续跑会不会误判空转 ——
             * 读文件也是干活，漏记会让模型刚查完资料就被判定「没动作」。
             */
            const start = ci
            for (let k = start; k < start + batch.consumed; k++) {
              recentCalls.push(`${toolCalls[k].name}:${JSON.stringify(toolCalls[k].args ?? {})}`)
            }
            while (recentCalls.length > 40) recentCalls.shift()
            sinceContinue += batch.consumed
            toolsRun += batch.consumed
            ci = start + batch.consumed - 1
            if (batch.halted) errorHalted = true
            continue
          }
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
        /**
         * 临时脚本护栏：换名字新建脚本时签名次次不同，上面那道拦不住，
         * 这里按「同一目录第几个脚本」判。两者共用同一份「连续被拦就收工」的计数。
         */
        const scratch = repeat.verdict === 'block' ? null : scratchGuard.check(call.name, args)
        if (repeat.verdict === 'block' || scratch?.verdict === 'block') {
          const note = repeat.verdict === 'block' ? repeat.note : scratch!.note
          repeatBlocked += 1
          if (scratch?.verdict === 'block' && !scratchHinted) {
            scratchHinted = true
            this.emit(session.id, {
              type: 'hint',
              message: '助手又在新建临时脚本，已拦下这次执行，让它直接改真实文件。'
            })
          } else if (repeat.verdict === 'block' && !repeatHinted) {
            repeatHinted = true
            this.emit(session.id, {
              type: 'hint',
              message: `助手在重复同一个动作（${call.name}），已拦下这次执行并让它换个做法。`
            })
          }
          await this.skipTools(session, [call], note, announced)
          /**
           * 拦一次它换参数再试是正常的；连着被拦三次说明它已经不会自己走出这个坑，
           * 再转下去只会把上下文和步数烧光，停在这里把话交给用户。
           */
          if (repeatBlocked >= MAX_REPEAT_BLOCKS) {
            repeatHalted = true
            notRun.push(...toolCalls.slice(ci + 1))
            this.finishNotes.set(session.id, guardHaltNote())
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
        // 写前快照：非 git 工作区也能回到上一版。只备份「已存在的文件」，
        // 新建文件不备份（回滚=删除）。失败静默 —— 快照是兜底，不阻断写入。
        if (writeTargets.length) {
          for (const t of writeTargets) {
            if ((beforeByTarget.get(t) ?? null) !== null) {
              await snapshotBeforeWrite(workspace, session.id, t).catch(() => null)
            }
          }
        }
        /**
         * 跑命令前给源码拍一张快照。
         *
         * 门禁全挂在 write_file / edit_file 上，而 `python gen.py`、`node build.js`、
         * `npx prettier --write` 这类间接写入从工具层看只是「跑了条命令」——
         * 文件被改了，语法校验没跑、变更快照没记、验收门禁一无所知。
         * 这里不猜命令会写什么，直接用文件系统事实兜住：跑完对比快照，
         * 改过的源码一律补进 writeTargets，后面那套门禁就自动生效了。
         *
         * 只在确实要执行时拍：被拒绝 / 被钩子拦下的命令不会改文件，白算一次。
         */
        const shellSnap =
          approved && !settled.blocked && !disabled(call.name) && call.name === 'run_shell'
            ? await snapshotSources(workspace).catch(() => null)
            : null
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
          /**
           * 计划不只是给人看的那排勾。
           *
           * 它现在参与控制流：跳项推进、以及「页面根本打不开却宣布做完」都会被
           * 挡回来。挡回来时**不改动现有计划**，把原因和下一步一起说清楚，
           * 让模型下一轮能照着改 —— 单纯说「不允许」它只会原样再发一遍。
           *
           * 注意这里不把 ok 置 false：那会喂给「连续同类错误」护栏，
           * 三次拒绝就可能把整轮叫停，而我们要的是让它改，不是停。
           */
          const items = normalizeTodos(args.items)
          const prev = this.todos.get(session.id) ?? []
          const verdict = todoGate(prev, items, this.verifyFails.get(session.id))
          const strikes = this.planGateStrikes.get(session.id) ?? 0

          if (!verdict.ok && strikes < MAX_PLAN_GATE_STRIKES) {
            this.planGateStrikes.set(session.id, strikes + 1)
            output =
              `这次计划更新没有生效。${verdict.reason}\n${verdict.hint}` +
              (prev.length ? `\n\n当前仍然是上一版计划，按它继续：\n${formatTodos(prev)}` : '')
          } else if (!verdict.ok) {
            // 连续拒绝到顶：不再静默放行，转人工确认。
            // 以前这里直接放行——模型重复几轮同一套坏计划，护栏就把它「硬推过去」，
            // 于是「验收没过却标完成」在最该拦的场景失守。现在把决定权交还用户：
            // 用户明确点头才放行，否则继续拦，绝不悄悄把未过验收的活算作完成。
            this.planGateStrikes.delete(session.id)
            if (nonInteractive) {
              // 无头模式没有用户可问：保持拦截，把原因讲清楚让模型自己换方向
              output =
                `这次计划更新仍然没有生效（已连续拒绝 ${strikes} 次）。${verdict.reason}\n${verdict.hint}` +
                (prev.length ? `\n\n当前仍然是上一版计划，按它继续：\n${formatTodos(prev)}` : '')
            } else {
              const answer = await this.askQuestion(
                session.id,
                `计划门禁已经连续拒绝 ${strikes} 次，模型提交的计划仍未通过：${verdict.reason}\n\n` +
                  `是否允许这次强行推进？如果选「否」，我会让它继续按当前计划修正。`,
                ['强行放行', '不放行，继续修正'],
                signal,
                false
              )
              if (answer && answer.includes('放行')) {
                this.todos.set(session.id, items)
                planTouched = true
                this.emit(session.id, { type: 'todos', items })
                output = `（用户已确认强行放行）${formatTodos(items)}`
              } else {
                // 用户不放行：拦截，让模型回去改
                this.planGateStrikes.set(session.id, 0)
                output =
                  `这次计划更新仍然没有生效（用户未同意强行推进）。${verdict.reason}\n${verdict.hint}` +
                  (prev.length ? `\n\n当前仍然是上一版计划，按它继续：\n${formatTodos(prev)}` : '')
              }
            }
          } else {
            this.planGateStrikes.delete(session.id)
            // 计划只在引擎内存里维护 + 推给界面；历史里留着本次调用的参数，重开会话能还原
            this.todos.set(session.id, items)
            planTouched = true
            this.emit(session.id, { type: 'todos', items })
            output = formatTodos(items)
          }
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
              /**
               * 单次读文件的字符上限按窗口折算。
               * 写死 40000 在 16K 窗口上等于一次读就吃掉三分之二历史：
               * 读完立刻触发压缩，模型忘了刚读的内容再去读一遍，来回抖。
               * 1.2 字符/token 是保守估计（代码约 3，中文约 1）。
               */
              readCap: Math.min(40000, Math.max(4000, Math.round(ctxWindow * 1.2))),
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
              touched.add(resolveToolPath(workspace, String(args.path ?? '')))
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
              /**
               * HTML 内联脚本单独查一遍。
               *
               * 上面的 tsserver 诊断对「工作区里只有一个 index.html」完全不生效
               * （没有 tsconfig 就直接 skipped:no-config），而「一个文件装下整个游戏」
               * 恰好是本地小模型最常接的任务 —— 十几处语法错误一次都不报，
               * 模型只能靠自己看，看完还改不动，最后演成反复重写。
               *
               * 这里不依赖任何项目配置，直接把 <script> 交给 node --check。
               * 和诊断一样：出错才追加，没错一个字都不加。
               */
              const htmlFiles = writeTargets.filter((t) => /\.html?$/i.test(t))
              if (htmlFiles.length) {
                const issues = await checkHtmlScripts(htmlFiles)
                const relOf = (f: string) => path.relative(workspace, f).split(path.sep).join('/')
                if (issues.length) {
                  output += `\n\n${formatHtmlIssues(issues, workspace)}`
                  this.emit(session.id, {
                    type: 'diagnostics',
                    errors: issues.length,
                    files: new Set(issues.map((d) => d.file)).size
                  })
                  // 语法都过不了，页面必然打不开：直接记成验收未通过，省掉一次八秒的白等
                  const fails = this.verifyFails.get(session.id) ?? new Map<string, string>()
                  for (const d of issues) fails.set(relOf(d.file), `内联脚本语法错误（第 ${d.line} 行）`)
                  this.verifyFails.set(session.id, fails)
                } else {
                  /**
                   * 语法过了再开浏览器真跑一遍。
                   *
                   * 这一步才回答「能不能用」：白屏、未定义变量、资源路径写错，
                   * 全都只在这里暴露。本程序自带 Chromium，不需要额外依赖。
                   */
                  const pages = await checkWebPages(htmlFiles, workspace)
                  const real = pages.filter((p) => !p.skipped)
                  if (real.length) {
                    output += `\n\n${formatWebCheck(pages, workspace)}`
                    const fails = this.verifyFails.get(session.id) ?? new Map<string, string>()
                    for (const p of real) {
                      const rel = relOf(p.file)
                      if (p.ok) fails.delete(rel)
                      else fails.set(rel, p.errors[0] ?? '打开时报错')
                    }
                    if (fails.size) this.verifyFails.set(session.id, fails)
                    else this.verifyFails.delete(session.id)
                    if (hasBlockingFailure(pages)) {
                      this.emit(session.id, {
                        type: 'diagnostics',
                        errors: pages.reduce((n, p) => n + p.errors.length, 0),
                        files: pages.filter((p) => !p.ok).length
                      })
                    }
                  }
                }
              }

              /**
               * 独立 JS 文件（.js/.mjs/.cjs）单独查一遍。
               *
               * htmlcheck 只覆盖内联在 .html 里的 <script>，外部脚本（<script src>）
               * 它明确跳过；tsserver 又要求工作区有 tsconfig + 本地 typescript。
               * 「index.html + game.js」的网页游戏里，game.js 写坏了一路写下去、
               * 浏览器打开才白屏 —— 这里补上这一环，把坏掉的独立 JS 当场还回去。
               *
               * 和诊断/HTML 检查一样：出错才追加，没错一个字都不加。
               */
              const jsFiles = writeTargets.filter((t) => /\.(?:m?js|cjs)$/i.test(t))
              if (jsFiles.length) {
                const jsIssues = await checkJsSyntax(jsFiles)
                if (jsIssues.length) {
                  output += `\n\n${formatJsIssues(jsIssues, workspace)}`
                  this.emit(session.id, {
                    type: 'diagnostics',
                    errors: jsIssues.length,
                    files: new Set(jsIssues.map((d) => d.file)).size
                  })
                  // 语法都过不了，运行必然抛 SyntaxError：记成验收未通过
                  const fails = this.verifyFails.get(session.id) ?? new Map<string, string>()
                  for (const d of jsIssues) {
                    fails.set(
                      path.relative(workspace, d.file).split(path.sep).join('/'),
                      `JS 语法错误（第 ${d.line} 行）`
                    )
                  }
                  this.verifyFails.set(session.id, fails)
                }
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
         * 命令跑完，按文件系统事实找出「被 shell 改过的源码」，补进门禁流程。
         *
         * 这一步让「绕过 write_file」不再意味着「绕过所有检查」：新出现的源码文件
         * 会被当成 writeTargets，后面的格式化、tsserver 诊断、HTML 语法校验、
         * 浏览器打开验收、变更快照全部照跑，模型拿到的结果和有门禁时一模一样。
         *
         * 上限 20 个：`git checkout` 之类的命令可能一次改上百个文件，全塞进去
         * 会让这一轮变成一次全量编译，反而卡死。超出部分只在提示里报个数。
         */
        if (ok && shellSnap) {
          const changed = await changedSources(workspace, shellSnap).catch(() => [])
          const fresh = changed.filter((c) => !writeTargets.includes(c.file))
          if (fresh.length) {
            const take = fresh.slice(0, 20)
            for (const c of take) {
              writeTargets.push(c.file)
              beforeByTarget.set(c.file, c.before)
            }
            output += `\n\n${formatShellChangeNote(take.map((c) => c.file), workspace)}`
            if (fresh.length > take.length) {
              output += `\n（另有 ${fresh.length - take.length} 个文件未纳入本次校验）`
            }
            this.emit(session.id, {
              type: 'hint',
              message: `这条命令直接改了 ${fresh.length} 个源码文件，已补跑写入门禁`
            })
          }
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
        // 临时脚本按「目录」记账：下一次在同目录新建第二个脚本才会被拦
        scratchGuard.record(call.name, args)
        // 到警告线但还没到拦截线：这次照跑，只是提醒它别再原样重发
        if (repeat.verdict === 'warn') output += `\n\n${repeat.note}`

        /**
         * 连续同类错误护栏：用原始结果判类别（上面的 repeat/scratch 提示不该干扰判断）。
         * 换脚本名、换扩展名的重试在签名护栏眼里次次不同，但这里按错误类别聚合，
         * 连续几次「文件找不到」就会把「工作目录在哪、别写外部临时脚本」回灌给模型。
         */
        const errGuard = errorStreak.observe(output)
        if (errGuard.verdict !== 'ok') {
          output += `\n\n${errGuard.note}`
          this.emit(session.id, {
            type: 'hint',
            message:
              errGuard.verdict === 'halt'
                ? `助手连续 ${errGuard.streak} 次犯同一类错误（${errGuard.kind}），已提醒并收工。`
                : `助手连续 ${errGuard.streak} 次犯同一类错误（${errGuard.kind}），已回灌工作目录提示。`
          })
          if (errGuard.verdict === 'halt') errorHalted = true
        }

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
          /**
           * 记账：整份重写同一个文件，却一次都没写大。
           *
           * 判据刻意不依赖「参数长得像不像」——实测里模型每次重写的写法都有细微差别，
           * 所以按签名去重的护栏完全拦不住它；但「这个文件最大只写到过 693 字符」
           * 是骗不了人的事实。
           */
          if (call.name === 'write_file' && args.append !== true) {
            for (const target of writeTargets) {
              const size = (await readTextOrNull(target))?.length ?? 0
              const rec = writeLedger.get(target) ?? { attempts: 0, maxSize: 0 }
              rec.attempts += 1
              rec.maxSize = Math.max(rec.maxSize, size)
              writeLedger.set(target, rec)
              if (!writeBreaker && rec.attempts >= WRITE_BREAKER_ATTEMPTS && rec.maxSize < WRITE_BREAKER_MAX_SIZE) {
                const name = path.relative(workspace, target).split(path.sep).join('/') || path.basename(target)
                writeBreaker =
                  `已停止：${name} 在这一轮里被整份重写了 ${rec.attempts} 次，最大的一次也只有 ${rec.maxSize} 字符。` +
                  '这不是「快写完了」，而是每次都在半路被截断、然后从头再来 —— 继续下去只会把时间和额度烧光。' +
                  '留下的可能是一份残片。建议：换更强的模型、把任务拆成更小的几块分别做，或者手工把骨架定下来再让它填。'
                this.emit(session.id, {
                  type: 'hint',
                  message: `检测到 ${name} 被反复重写却一直没有变大（${rec.attempts} 次，最大 ${rec.maxSize} 字符），已停止这一轮。`
                })
              }
            }
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
        /**
         * read_file 读到图片时，把画面作为图片消息喂给视觉模型。
         *
         * readFileTool 已不再对图片抛「二进制拒绝」，而是返回一句带【图片】标记的话；
         * 但光有那句话模型还是看不到画面 —— 图片必须进 message.images，provider 构造
         * 请求时才转成 base64 真正发出去（imageTurnIndex 只认最近一条带 images 的 user 消息）。
         *
         * 所以这里补一条紧随其后的 user 消息：content 是说明，images 是绝对路径。
         * 序列 assistant(tool_calls) → tool → user(images) 对 OpenAI 协议合法。
         * 模型看不了图时（纯文本模型 / vision 关掉），这条消息会被 provider 降级成纯文本，
         * 并在正文里明确告诉模型「看不了」，不会静默失败。
         */
        if (call.name === 'read_file') {
          const readTarget = resolveToolPath(workspace, String(args.path ?? ''))
          if (readTarget && isImagePath(readTarget)) {
            const imgMsg: ChatMessage = {
              id: store.newId(),
              role: 'user',
              content:
                `你刚才用 read_file 读取的图片（${String(args.path ?? '')}）画面如下，已经直接传给你了（不是路径，你看得见）。` +
                '直接描述你看到的内容，据此判断并继续。',
              images: [readTarget],
              createdAt: Date.now()
            }
            session.messages.push(imgMsg)
            await store.appendMessages(session.id, [imgMsg])
          }
        }
        this.emit(session.id, {
          type: 'tool_result',
          callId: call.id,
          tool: call.name,
          result: output,
          ok,
          durationMs
        })
      }

      // 连续同类错误护栏判定收工：并入 repeatHalted，复用同一条收工路径
      if (errorHalted) repeatHalted = true
      /**
       * 产出比熔断同样走收工路径，但结论要说清「为什么停」——
       * 给用户的话必须能指路（换模型 / 拆小 / 手搭骨架），而不是一句「已停止」。
       */
      if (writeBreaker) {
        if (!this.finishNotes.has(session.id)) this.finishNotes.set(session.id, { note: writeBreaker, ok: false })
        repeatHalted = true
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
      if (repeatHalted) {
        // 和循环中途那次 halt（重复动作拦到上限）一样，补上收工结论。
        // errorStreak 判定的 halt 走到这里 —— 以前没有任何 note，done 是裸的。
        if (!this.finishNotes.has(session.id)) this.finishNotes.set(session.id, guardHaltNote())
        break
      }
    }

    /**
     * 收工前的最后一步：把本轮的一次性脚本从交付目录里挪走。
     *
     * 实测里交付目录会变成 `index.html` 旁边躺着 `gen.py`、`_check.py`、`verify_ttt.js`、
     * `__pycache__/`。用户打开文件夹看到的是这些。清理规则见 hygiene.ts：
     * 只动「名字一眼是临时脚本 + 本轮才出现 + 没有被成果引用」的文件，且只搬不删。
     * 清不动（被占用 / 没权限）不算错误，绝不因此让一轮任务失败。
     */
    await this.tidyWorkspace(session, workspace, runStartedAt)

    // 步数预算用完了还没收工：这不是「做完了」，是「这一轮到点了」。
    // 所以保留 checkpoint（running）—— 否则重启后既不出恢复横幅，「继续」也带不上
    // 计划 / 改过的文件 / 验证结论，用户只能自己重述做到哪了。真正收工才标 done 并清除。
    persistCheckpoint('running')
    if (!repeatHalted) {
      // 真正跑到步数上限才发 step_limit；护栏叫停的终止信号是 done.note，
      // 不能拿「达到最大步数」误导用户（它的文案和围栏场景对不上）。
      this.emit(session.id, { type: 'step_limit', maxSteps: stepBudget })
    }
  }

  /**
   * 交付目录卫生：把本轮的一次性脚本挪进 `.roroto/trash/`。
   *
   * 必须在**每一条收工路径**上调用。「正常结束」是从主循环里 `return` 出去的，
   * 不是走到方法末尾 —— 第一版只写在末尾，结果实测里 gen.py 一个都没被清掉。
   * 清理失败只当没做，绝不能把一轮已经成功的任务变成异常。
   */
  private async tidyWorkspace(session: Session, workspace: string, since: number): Promise<void> {
    try {
      const swept = await sweepWorkspace(workspace, since)
      const note = formatSweep(swept)
      if (note) this.emit(session.id, { type: 'hint', message: note })
    } catch {
      // 附加动作，失败忽略
    }
  }

  /**
   * 连续只读工具的并发执行。
   *
   * 模型一次发五个 read_file 是最常见的形态（先读五个文件再动手）。以前串行跑：
   * 五次「请求 → 等盘 → 回包」全排队，本地模型上白等十几秒，还多烧步数预算。
   * 写工具与命令仍然串行 —— 它们的顺序和副作用必须确定。
   *
   * 语义和串行完全一致：审批、护栏、钩子、结果落库都按原顺序走一遍，
   * 只是把 executeTool 那一段的等待重叠起来。任何一条需要人管（坏参数、越界路径、
   * 命中重复护栏、用户刚插话）就整段退回串行，由原来的路径处理。
   */
  private async tryParallelReads(o: {
    session: Session
    calls: ToolCall[]
    from: number
    workspace: string
    signal: AbortSignal
    cut: AbortSignal
    rootAborted: boolean
    permRules: Awaited<ReturnType<typeof loadProjectPermissions>>
    agentId: string | null
    readCap: number
    hiddenSpecs: Array<{ name: string; description: string }>
    announced: Set<string>
    callGuard: ReturnType<typeof createToolCallGuard>
    scratchGuard: ReturnType<typeof createScratchGuard>
    errGuard: ReturnType<typeof createErrorStreakGuard>
  }): Promise<{ consumed: number; halted: boolean }> {
    const none = { consumed: 0, halted: false }
    if (o.cut.aborted || o.rootAborted) return none

    // 1. 收集连续的一段（中间夹着写工具/命令就到此为止，绝不越过它们并行）
    const run = collectParallelReadRun(o.calls, o.from)
    if (!run.length) return none

    // 2. 参数先落到确定形态；任何一条需要人管，就整段退回串行
    const prepared: Array<{
      call: ToolCall
      args: Record<string, unknown>
      warn: string
      note: string
    }> = []
    for (const c of run) {
      const settled = settleToolArgs(
        c,
        toolSpecs.find((t) => t.name === c.name)
      )
      if (settled.blocked) return none
      // 越界路径 / 项目规则：这类要弹审批或直接拒绝，交给串行路径才有完整语义
      if (classifyRisk(c.name, settled.args, o.workspace, o.permRules)) return none
      const repeat = o.callGuard.check(c.name, settled.args)
      if (repeat.verdict === 'block') return none
      if (o.scratchGuard.check(c.name, settled.args).verdict === 'block') return none
      prepared.push({
        call: c,
        args: settled.args,
        warn: repeat.verdict === 'warn' ? repeat.note : '',
        // 参数被容错层修过（尾逗号、单引号）：要告诉模型，否则它一直以为自己的 JSON 是合法的
        note: settled.note ?? ''
      })
    }
    if (this.steered(o.session.id)) return none

    // 3. 卡片先全部亮出来，用户看到的是「同时在读这五个文件」
    for (const p of prepared) {
      o.announced.add(p.call.id)
      this.emit(o.session.id, { type: 'tool_start', callId: p.call.id, tool: p.call.name, args: p.args })
    }

    // 4. preToolUse 仍按顺序跑：钩子脚本可能互相依赖，并发执行没人能保证顺序
    const pre: Array<{ blocked?: string }> = []
    for (const p of prepared) {
      pre.push(
        await runHooks('preToolUse', {
          workspace: o.workspace,
          sessionId: o.session.id,
          agentId: o.agentId,
          tool: p.call.name,
          args: p.args
        })
      )
    }

    // 5. 真正并发的一段
    const results = await Promise.all(
      prepared.map(async (p, i) => {
        if (pre[i]?.blocked) return { ok: false, output: `钩子拒绝了这个操作：${pre[i].blocked}`, ms: 0 }
        const started = Date.now()
        try {
          const output = await executeTool(p.call.name, p.args, {
            workspace: o.workspace,
            signal: o.signal,
            allowOutside: false,
            agentId: o.agentId,
            sessionId: o.session.id,
            readCap: o.readCap,
            hiddenTools: o.hiddenSpecs
          })
          return { ok: true, output, ms: Date.now() - started }
        } catch (err) {
          return { ok: false, output: `执行失败：${(err as Error).message}`, ms: Date.now() - started }
        }
      })
    )

    // 6. 收尾严格按原顺序：护栏记账、钩子、落库、推界面，顺序一乱护栏就判错
    let halted = false
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i]
      const r = results[i]
      let output = r.output
      let ok = r.ok
      if (ok && o.cut.aborted && !o.rootAborted) {
        ok = false
        output = STEER_CUT_NOTE
      }
      const post = await runHooks('postToolUse', {
        workspace: o.workspace,
        sessionId: o.session.id,
        agentId: o.agentId,
        tool: p.call.name,
        args: p.args,
        result: output
      })
      if (post.context) output += `\n\n【钩子】\n${post.context}`
      if (post.warning) this.emit(o.session.id, { type: 'hint', message: post.warning })
      if (p.note) output = `${p.note}\n\n${output}`

      // 记的是「还没追加护栏提示」的原始输出，否则自己写的话会污染「结果有没有变」
      o.callGuard.record(p.call.name, p.args, output)
      o.scratchGuard.record(p.call.name, p.args)
      if (p.warn) output += `\n\n${p.warn}`
      const guard = o.errGuard.observe(output)
      if (guard.verdict !== 'ok') {
        output += `\n\n${guard.note}`
        this.emit(o.session.id, {
          type: 'hint',
          message:
            guard.verdict === 'halt'
              ? `助手连续 ${guard.streak} 次犯同一类错误（${guard.kind}），已提醒并收工。`
              : `助手连续 ${guard.streak} 次犯同一类错误（${guard.kind}），已回灌工作目录提示。`
        })
        if (guard.verdict === 'halt') halted = true
      }

      const toolMessage: ChatMessage = {
        id: store.newId(),
        role: 'tool',
        content: output,
        toolCallId: p.call.id,
        toolName: p.call.name,
        toolArgs: p.args,
        createdAt: Date.now()
      }
      o.session.messages.push(toolMessage)
      await store.appendMessages(o.session.id, [toolMessage])
      this.emit(o.session.id, {
        type: 'tool_result',
        callId: p.call.id,
        tool: p.call.name,
        result: output,
        ok,
        durationMs: r.ms
      })
    }

    return { consumed: run.length, halted }
  }

  /**
   * 上次因为「子智能体还没就绪」而等过预热的时刻。
   * 冷启动时第一次派活给后台加载留一小段窗口，但 60 秒内只等一次，
   * 免得实例起不来的机器每次派活都白等。
   */
  private lastWorkerWarmWait = 0

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

    // 整批只判断一次：workerPlan 要逐个查本地实例状态，每个子任务都查一遍纯属浪费
    let plan = await workerPlan(ctx.provider, ctx.config)
    /**
     * 组里一个都不能用：后台把整组拉起来。
     *
     * 以前这里「绝不 await」，结果第一次派活必定回落主模型 —— 用户刚配好子智能体、
     * 第一次让它干活却完全看不到子模型，很容易以为功能没生效。现在给刚触发的
     * 预热留最多 8 秒：加载快的实例当场就能接活，加载慢的仍照旧回落、不阻塞对话。
     * 60 秒内只等一次，实例起不来的机器不会每次派活都白等。
     *
     * 但「在冷却」不算「没起来」（远端 worker 本来就不用预热）：那种情况下等 8 秒
     * 一点用都没有，只会白拖一轮对话，所以直接跳过。
     */
    const allCooling = plan.skipped.length > 0 && plan.skipped.every((s) => s.cooling)
    if (plan.pool.length === 0 && plan.configuredCount > 0 && !allCooling) {
      const warm = warmWorker(ctx.provider, ctx.config).catch(() => ({ ok: false, message: '' }))
      if (Date.now() - this.lastWorkerWarmWait > 60_000 && !ctx.signal.aborted) {
        this.lastWorkerWarmWait = Date.now()
        await Promise.race([warm, new Promise((r) => setTimeout(r, 8_000))])
        if (!ctx.signal.aborted) plan = await workerPlan(ctx.provider, ctx.config)
      }
      void warm
    }
    const pool = plan.pool
    /** 按忙闲把子任务分派到不同实例（纯函数见 shared/agentpool.ts） */
    const pickWorker = createSubAgentDispatcher(pool)
    /**
     * 子代理的上下文预算要按它自己那个模型算，而且要按**服务端真实的**窗口算。
     *
     * 配置里的 contextWindow 只是「启动它时想开多大」：8081 配 16384、`/props` 实际报
     * 8192 的时候，按配置算出来的 9830 预算会让子代理第一步就超窗 400 ——
     * 和主流程上一轮修掉的是同一个坑，这里当时漏了。
     *
     * 探测结果按 provider 缓存：一批子任务不必每个都去问一遍 /props。
     */
    const budgetCache = new Map<string, number>()
    const budgetFor = async (p: ProviderConfig): Promise<number> => {
      const hit = budgetCache.get(p.id)
      if (hit !== undefined) return hit
      const real = await effectiveContextWindow(p).catch(() => 0)
      const own = real > 0 ? real : Math.round(Number(p.contextWindow) || 0)
      // 子代理有自己的一套工具说明，留 40% 给输出和工具定义
      const budget = own <= 0 ? ctx.budget : Math.max(1500, Math.min(Math.floor(own * 0.6), 24000))
      budgetCache.set(p.id, budget)
      return budget
    }

    const one = async (call: ToolCall) => {
      const started = Date.now()
      const task = prepare(call)
      /**
       * 只读探查：调用方显式写了 mode=explore 才生效。
       * 单独取出来是因为下面「交付为空要说实话」也要用它 —— 这个模式下
       * 子 agent 根本没有写文件的工具，没产出不是它的错，是任务派错了。
       */
      const exploreMode = call.args.mode === 'explore'
      const member = pickWorker()
      let runner = member?.provider ?? null
      task.model = runner?.model || ctx.provider.model
      // 把「为什么用/没用工人模型」和「这一条派给了哪张卡」写进卡片：
      // 并行没生效时用户能立刻看到原因，而不是看到两个子任务都卡在一个模型后面
      task.note = member
        ? `${plan.reason} · 本任务 → ${member.provider.device?.trim() || member.provider.name || member.provider.model}`
        : plan.reason
      if (call.args.mode === 'explore') {
        task.note = `只读探查 · ${task.note}`
      }
      /**
       * 工作模型窗口太小就别派给它了。
       *
       * 子代理一上来就要带整套工具说明（约 4900 tokens，见 LEAN_TOOLS 那段注释），
       * 显存不够时 llama.cpp 会把 `-c` 自动降下来 —— 实测 7.4G 卡上跑 12B 只拿到 4096，
       * 连工具表都装不下，派过去必然 400，然后走「失败重跑主模型」白等一轮。
       * 与其让它先烧一次失败，不如当场改用主模型，并在卡片上写清楚为什么。
       */
      if (runner) {
        const workerBudget = await budgetFor(runner)
        /**
         * 只读探查的工具表更短（9 个只读工具，约 1500 tokens），门槛可以放低：
         * 全量模式 6000 都装不下的小窗口模型，explore 还能派过去做只读梳理。
         * 这正是「小模型窗口不够」这个痛点的解法 —— 与其一刀切拒派，不如让它只读。
         */
        const isExplore = call.args.mode === 'explore'
        const minBudget = isExplore ? 2500 : MIN_SUBAGENT_BUDGET
        if (workerBudget < minBudget) {
          task.note = `工作模型窗口太小（预算 ${workerBudget} tokens${
            isExplore ? '' : '，工具说明就要约 4900'
          }），本任务改用主模型`
          task.model = ctx.provider.model
          runner = null
        }
      }
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

      // 从这里起才算「真有一个子 agent 在跑」：上面 refuse 的失败占位
      // start/end 在同一瞬间发完，不该让侧栏多出第二枚机器人。
      this.markSubagent(ctx.sessionId, 1)
      /**
       * 本地 worker 的写型任务加一道墙钟护栏（见 LOCAL_WORKER_WRITE_MS）。
       * 用独立的 controller 转发父 signal：这样「用户点停止」和「护栏到点」
       * 走同一条中止路径，不需要在两个地方各判一次。
       */
      const capMs = writeCapMs(runner, exploreMode)
      let capHit = false
      let capTimer: ReturnType<typeof setTimeout> | null = null
      let detach: (() => void) | null = null
      let runSignal = ctx.signal
      /** 这个子任务自己改过的文件：护栏中止时要说清楚动过哪儿 */
      const mine = new Set<string>()
      if (capMs > 0) {
        const ctl = new AbortController()
        const forward = () => ctl.abort(new Error('已取消'))
        ctx.signal.addEventListener('abort', forward, { once: true })
        detach = () => ctx.signal.removeEventListener('abort', forward)
        capTimer = setTimeout(() => {
          capHit = true
          ctl.abort(new Error(`本地工作模型跑了 ${Math.round(capMs / 60_000)} 分钟仍未收尾`))
        }, capMs)
        capTimer.unref?.()
        runSignal = ctl.signal
      }
      this.emit(ctx.sessionId, { type: 'subagent_start', task })
      let done: SubAgentTask | undefined
      try {
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
          // lean 模式下 LSP 导航工具在父表里被收进 toolbox，而 toolbox 不在只读白名单里：
          // 不补的话，小窗口机器上的 explore 子 agent 只能 grep，查不了定义和引用（见 withExploreNav）
          tools: exploreMode ? withExploreNav(ctx.tools) : ctx.tools,
          mode: (call.args.mode === 'explore' ? 'explore' : null) as 'explore' | null,
          signal: runSignal,
          web: ctx.web,
          note: task.note,
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
            mine.add(change.path)
            this.emit(ctx.sessionId, { type: 'file_change', change })
          },
          onUpdate: (t: SubAgentTask) => this.emit(ctx.sessionId, { type: 'subagent_update', task: t })
        }

        done = await runSubAgent({
          ...opts,
          provider: runner ?? ctx.provider,
          budget: await budgetFor(runner ?? ctx.provider)
        })

        /**
         * 护栏中止：结果要能直接指导下一步，而不只是「失败了」。
         *
         * 写清楚三件事 —— 跑多久、烧了多少步、动过哪些文件。父 agent 据此决定
         * 是接着修（改动都还在，写前有快照）还是拆小重派；比等进程自己崩掉好得多。
         */
        if (capHit) {
          const v = localCapVerdict(capMs, done.steps, done.tools.length, [...mine])
          done.status = 'fail'
          done.error = v.error
          done.summary = v.summary
          done.note = `${task.note} · ${v.note}`
        }

        /**
         * 工人模型白跑一趟时兜底：一个工具都没调用就失败，说明是请求本身没通
         * （实例没起来、key 失效、端口错），重跑没有副作用 ——
         * 已经改过文件的情况绝不重跑，否则会把同一处改动做两遍。
         */
        if (done.status === 'fail' && runner && done.tools.length === 0 && !ctx.signal.aborted && !capHit) {
          const why = done.error ?? '请求失败'
          const retry: SubAgentTask = { ...task, status: 'running', steps: 0, summary: '', tools: [], error: undefined }
          retry.note = `工作模型不可用（${why}），已改用主模型重跑`
          this.emit(ctx.sessionId, { type: 'subagent_update', task: retry })
          done = await runSubAgent({
            ...opts,
            provider: ctx.provider,
            budget: await budgetFor(ctx.provider),
            note: retry.note
          })
          done.note = retry.note
        }

        /**
         * 空交付不许报「已完成」。
         *
         * 实测（9B + gemma-4-E4B 两卡并行）：父 agent 让它「新建 snake.html」，
         * 它却在 task 里顺手带了 mode=explore —— 子 agent 拿的是只读工具表，
         * 读了两个文件、回了句「接下来的步骤请你执行」，而结果照样写成「已完成」。
         * 父 agent 据此以为文件已经在磁盘上，回头 read_file 读了个空，只能从头再做。
         *
         * 判据不用猜语义，就看文件系统事实上有没有变化（touched 由 onChange 收集）：
         * 一次工具调用都没改文件，就不是「做完了」。explore 模式下额外说清
         * 「它没有写权限」，否则父 agent 会以为子 agent 偷懒。
         */
        if (done.status === 'ok' && !touched.length) {
          const wantsWrite = /新建|创建|写入|写到|改成|修改|保存|落地|write|create|生成.{0,6}文件/i.test(task.prompt)
          const head = exploreMode
            ? `这次子任务是只读探查（mode=explore）：子 agent 只有读工具，不能写文件，所以磁盘上没有任何变化。`
            : `子 agent 跑完了，但**没有改动任何文件**（${done.tools.length} 次工具调用全是只读），交付是空的。`
          const tail = wantsWrite
            ? exploreMode
              ? '你给它的任务看起来要新建/修改文件 —— 去掉 mode 重新派一次（不填 mode 就是完整模式），或者自己用 write_file 写。'
              : '别把它当成做完了：自己用 write_file 把那几个文件写出来，或者重新派一次，并在 prompt 里写明「必须用 write_file 落到磁盘」。'
            : ''
          done.summary = [head, tail, '', '它的回报：', done.summary].filter((x) => x !== '').join('\n')
          done.note = `${done.note ?? ''}${done.note ? ' · ' : ''}${exploreMode ? '只读模式，未改文件' : '未改文件'}`
          this.emit(ctx.sessionId, { type: 'subagent_update', task: done })
        }

        /**
         * 子 agent 写出来的网页也要过同一道验收。
         *
         * 语法校验和浏览器打开验收挂在**父 agent 的循环**里（见上面的 writeTargets 那段），
         * 子 agent 跑的是另一套循环，它调 write_file 只经过工具层的写入上限 ——
         * 实测就是这么漏的：子 agent 交付了 ttt.html，父 agent 只 list_dir 看了一眼
         * 就宣布完成，一次浏览器都没打开过。同一份代码，谁写的都该接受同样的检查。
         */
        if (done.status === 'ok' && touched.length && !ctx.signal.aborted) {
          const abs = [...new Set(touched)].map((f) => path.resolve(ctx.workspace, f))
          const htmls = abs.filter((f) => /\.html?$/i.test(f))
          const jsFiles = abs.filter((f) => /\.(?:m?js|cjs)$/i.test(f))
          const notes: string[] = []
          if (htmls.length) {
            const issues = await checkHtmlScripts(htmls).catch(() => [])
            if (issues.length) {
              notes.push(formatHtmlIssues(issues, ctx.workspace))
              const fails = this.verifyFails.get(ctx.sessionId) ?? new Map<string, string>()
              for (const d of issues) {
                fails.set(path.relative(ctx.workspace, d.file).split(path.sep).join('/'), `内联脚本语法错误（第 ${d.line} 行）`)
              }
              this.verifyFails.set(ctx.sessionId, fails)
            } else {
              const pages = await checkWebPages(htmls, ctx.workspace).catch(() => [])
              const bad = pages.filter((p) => !p.skipped && !p.ok)
              if (bad.length) {
                notes.push(formatWebCheck(pages, ctx.workspace))
                const fails = this.verifyFails.get(ctx.sessionId) ?? new Map<string, string>()
                for (const p of bad) {
                  fails.set(
                    path.relative(ctx.workspace, p.file).split(path.sep).join('/'),
                    p.errors[0] ?? '打开后没有真正跑起来'
                  )
                }
                this.verifyFails.set(ctx.sessionId, fails)
              } else {
                // 用统一报告而不是手写一句「无报错」：现在验收还看画面有没有画出来、
                // 首屏是不是已经结算、对输入有没有反应，这些结论必须一起带给父 agent
                const okReport = formatWebCheck(pages, ctx.workspace)
                notes.push(
                  okReport ||
                    `【子 agent 产物验收】${htmls
                      .map((f) => path.relative(ctx.workspace, f).split(path.sep).join('/'))
                      .join('、')} 已实际打开。`
                )
              }
            }
          }
          if (jsFiles.length) {
            const jsIssues = await checkJsSyntax(jsFiles).catch(() => [])
            if (jsIssues.length) {
              notes.push(formatJsIssues(jsIssues, ctx.workspace))
              const fails = this.verifyFails.get(ctx.sessionId) ?? new Map<string, string>()
              for (const d of jsIssues) {
                fails.set(path.relative(ctx.workspace, d.file).split(path.sep).join('/'), `JS 语法错误（第 ${d.line} 行）`)
              }
              this.verifyFails.set(ctx.sessionId, fails)
            }
          }
          if (notes.length) {
            done.summary = `${done.summary}\n\n${notes.join('\n\n')}`
            this.emit(ctx.sessionId, { type: 'subagent_update', task: done })
          }
        }

        return {
          call,
          output: formatTaskResult(done),
          ok: done.status === 'ok',
          durationMs: Date.now() - started
        }
      } finally {
        // 护栏的定时器和父 signal 的监听都必须拆掉：一批子任务跑下来，
        // 每个都留一个 10 分钟的 unref 定时器听着，纯属白占资源。
        if (capTimer) clearTimeout(capTimer)
        detach?.()
        // 正常收工、失败重跑、用户点停止抛异常，计数都必须归位。
        // 先减计数再发 end：侧栏收到 end 会立刻复查一次，此时查到的必须是「已经结束了」。
        this.markSubagent(ctx.sessionId, -1)
        if (done) this.emit(ctx.sessionId, { type: 'subagent_end', task: done })
      }
    }

    /**
     * 一批最多并行几个：跟着「真能接活的实例数」走。
     *
     * 算式只有一份（`laneCount`），系统提示和自动派发文案用的是同一个 ——
     * 以前提示按「配了几个子智能体」说、这里按「池里几个就绪」跑，配了 1 个时
     * 提示教它连写 3 个、这里一次只放 1 个，几路审查排队串行外带全撞限流。
     *
     * 池里有几个就并行几个；池子空时本地 llama 只有 1 个槽位（多放只会排队 +
     * 各自重付 prefill），远端 API 保持 3 个。每个实例自己的槽位仍由 gate.ts
     * 按 baseUrl 单独排队。
     */
    const MAX = laneCount(pool.length, isLlamaProvider(ctx.provider))
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
