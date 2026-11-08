import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  AgentEvent,
  ApprovalRequest,
  AppConfig,
  ChatMessage,
  FileChange,
  ProviderConfig,
  QuestionRequest,
  SendAttachment,
  Session,
  SubAgentTask,
  TodoItem,
  TokenUsage,
  ToolCall
} from '../shared/types'
import { effectiveWorkspace, loadConfig, providerForSession, saveConfig } from './config'
import * as store from './store'
import { chat, effectiveContextWindow } from './providers'
import type { StreamResult } from './providers/base'
import { classifyRisk, classifyMcpRisk, executeTool, previewWrite, previewPatch, patchTargets, summarize, toolTargetPath, type RiskInfo } from './tools'
import { decideApproval } from './approval'
import { toolSpecs, type ToolSpec } from './tools/spec'
import { extractAttachment, renderAttachmentBody } from './extract'
import { isImagePath, providerSupportsVision } from '../shared/vision'
import { formatTodos, normalizeTodos } from '../shared/todos'
import { memoryForPrompt } from './memory'
import { findInstructions, instructionsBlock, type InstructionsResult } from './instructions'
import { loadProjectPermissions } from './permissions'
import { detectVerifyPlan, runVerify } from './verify'
import { asCalls, balancedEnd, parseTextToolCalls, type RawCall } from './parse'
import { runSubAgent } from './subagent'
import { recordChange } from './changes'
import { diffLines, diffStats } from './diff'
import { callMcpTool, isMcpTool, mcpToolSpecs } from './mcp'
import { CORE_PROVIDER_ID, coreFallbackProvider, ensureCoreReady } from './core'
import { workerPlan } from './worker'
import { estimateCost } from '../shared/pricing'
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
  'web_fetch'
])

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
    nudge?: string | null
    cont?: string | null
  }
): string {
  const ws = workspace || '（未选择工作区）'
  const instructions = opts.instructions ? instructionsBlock(opts.instructions) : ''
  return [
    '你是 RoRoTo Code，Windows 上的编程助手，用中文回答。回答要具体，不要客套。',
    `当前工作区：${ws}`,
    '规则：',
    opts.web === false
      ? '1. 联网已关闭，无法搜索网页；需要最新资料时直接说明。'
      : '1. 需要新闻、最新版本、报错原因、官方文档时，先调 web_search，再按需 web_fetch。不要只说「我正在搜索」，必须真的调用工具。',
    '2. 回答要给真实结果（标题、网址、摘要、代码），不要编造，也不要说「请稍等」。',
    '3. 改代码前用 list_dir / grep / read_file 看清现状，修改用 edit_file。',
    '4. 需要命令时用 run_shell；工具报错先读错误再换方案。',
    '5. 用户消息里的附件正文直接使用，不要让用户再粘贴。',
    ...(opts.remember === false ? [] : ['6. 值得下次知道的事实用 remember 记一条。']),
    ...(instructions ? ['', instructions] : []),
    '如果无法原生调用工具，就输出一行 JSON：{"name":"web_search","args":{"query":"关键词"}}',
    '程序会执行并把结果回传给你。',
    ...(opts.nudge ? ['', '【重做】', opts.nudge] : []),
    ...(opts.cont ? ['', '【继续执行】没做完就不要停：', opts.cont] : []),
    ...(opts.summary ? ['', '【更早对话的摘要】', opts.summary] : []),
    ...(opts.verify ? ['', '【自动验证结果】据此修正：', opts.verify] : [])
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
  const head = trimmed.slice(0, 2)
  const tail = trimmed.slice(2)
  let result = trimmed
  while (tail.length > 2 && messagesTokens([...head, ...tail]) > budget) {
    tail.shift()
    result = [...head, ...tail]
  }
  return result
}

/** 把当前时间写进提示，避免模型为了「今天几号」去跑命令 */
function nowText(): string {
  const d = new Date()
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${week} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function systemPrompt(
  workspace: string | null,
  provider: ProviderConfig,
  opts: {
    memory?: string | null
    instructions?: InstructionsResult | null
    summary?: string | null
    verify?: string | null
    /** 联网 / 记忆开关，关掉后提示里不再教它用这些工具 */
    web?: boolean
    remember?: boolean
    /** 上一轮「只说不做」的原文，用来逼它真的调工具 */
    nudge?: string | null
    /** 自动续跑：上一轮为什么没算完，逼它接着做 */
    cont?: string | null
  } = {}
): string {
  const ws = workspace || '（未选择工作区）'
  const webOn = opts.web !== false
  const rememberOn = opts.remember !== false
  const instructions = opts.instructions ? instructionsBlock(opts.instructions) : ''

  const rules = [
    '闲聊、常识、日期时间这类问题直接用文字回答：上面已经给了当前时间，不要为了「今天几号／星期几」去执行命令。',
    '改代码前先看清现状：用 list_dir / glob / grep / read_file 获取真实内容，绝不凭空假设文件存在或内容如何。',
    '修改用 edit_file 做精确替换，保持最小改动；只有新建文件或整体重写才用 write_file。',
    '需要验证时用 run_shell。默认 shell 是 cmd.exe，需要 unix 命令时把 shell 参数设为 bash。改完代码程序会自动跑测试或构建，你只要按结果继续修。',
    '工具返回错误时先读错误信息再换方案，不要重复同一次失败调用。',
    '不要一次读取大量无关文件，按需逐步获取。',
    '任务完成后用一两句话说明改了什么，不要长篇总结。',
    '一次任务要一直做到完：计划里还有没勾掉的项、或还有文件 / 命令没处理时，不要收工，也不要只说「接下来我会…」就结束。全部做完再给结论。',
    '有附件正文时，先通读再回答；不要只凭文件名猜内容。'
  ]
  rules.push(
    webOn
      ? '需要外部信息（不熟的库、报错含义、最新版本、官方文档）时先 web_search，再用 web_fetch 读最相关的一两个页面；引用结论时要给出网址，不要凭记忆编 API。'
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

  return [
    '你是 RoRoTo Code，一个运行在 Windows 上的编程助手，用中文回答。',
    `当前时间：${nowText()}（系统本地时区）`,
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
    '',
    '工作原则：',
    ...rules.map((r, i) => `${i + 1}. ${r}`),
    '',
    '输出格式（界面按 Markdown 渲染，只认 **粗体**、`行内代码`、[文字](网址)、代码块）：',
    '把结论、关键数字、文件路径、命令、风险和注意事项用 **粗体** 标出来，让人扫一眼就抓到重点；不要整段加粗，也不要用 # 标题或表格（界面显示不出来，会露出原始符号）。',
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
    ...(instructions
      ? ['', instructions]
      : []),
    ...(opts.summary
      ? [
          '',
          '【更早对话的摘要】以下是本次会话前段内容的压缩记录，事实以它为准，不要向用户复述这段话：',
          opts.summary
        ]
      : []),
    ...(opts.verify
      ? [
          '',
          '【自动验证结果】你刚才说做完了，程序跑了项目的验证命令，结果如下。请据此修正，不要无视：',
          opts.verify
        ]
      : []),
    ...(opts.nudge
      ? ['', '【需要你重做】', opts.nudge]
      : []),
    ...(opts.cont
      ? [
          '',
          '【继续执行】上一轮你没有调用工具，但任务还没结束。别停下来等用户催，直接接着做：',
          opts.cont
        ]
      : [])
  ].join('\n')
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
  private approvals = new Map<string, { resolve: (ok: boolean) => void; sessionId: string; high: boolean }>()
  // question 工具：模型暂停问用户，等应答后继续。value 的 resolve 传回用户答案
  private questions = new Map<string, { resolve: (answer: string) => void; sessionId: string }>()
  // 用户在本次运行中选择「之后全允许」的会话
  private alwaysApprove = new Set<string>()
  /** 用户显式选择「始终允许高危操作」的会话（不随普通放行一起生效） */
  private alwaysApproveHigh = new Set<string>()
  /** 会话级摘要：早期对话压成一段文字，避免每一步都重新压缩 */
  private summaries = new Map<string, { upTo: number; text: string; tokens: number }>()
  /** 各会话当前的执行计划（update_todos 维护，只用于界面展示） */
  private todos = new Map<string, TodoItem[]>()
  /** resume 时从 checkpoint 还原的「上次改过的文件」，接入本轮 touched 判断 */
  private resumeTouched = new Map<string, Set<string>>()

  constructor(private emit: Emit) {}

  isRunning(sessionId: string): boolean {
    return this.controllers.has(sessionId)
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
    if (controller) controller.abort(new Error('已取消'))
    // 挂起的 question 也一起清掉，否则弹窗残留、Promise 永不 resolve、会话卡死
    // entry.resolve 即 finish，会统一清理并 emit question_dismiss
    for (const [id, entry] of this.questions) {
      if (entry.sessionId === sessionId) entry.resolve('')
    }
  }

  respondApproval(id: string, approved: boolean, always = false): void {
    const entry = this.approvals.get(id)
    if (!entry) return
    this.approvals.delete(id)
    // 放行范围以主进程记录的 risk.high 为准，不信渲染层传上来的标记
    if (approved && always) {
      if (entry.high) this.alwaysApproveHigh.add(entry.sessionId)
      else this.alwaysApprove.add(entry.sessionId)
    }
    entry.resolve(approved)
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
      const timer = setTimeout(() => finish(''), 10 * 60 * 1000)
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
    preview?: ApprovalRequest['preview']
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
      this.approvals.set(request.id, { resolve, sessionId, high: request.high === true })
    })
  }

  async send(sessionId: string, text: string, files?: SendAttachment[], options?: RunOptions): Promise<void> {
    if (this.controllers.has(sessionId)) throw new Error('这个会话正在运行中')

    const config = await loadConfig()
    const existing = await store.loadSession(sessionId).catch(() => null)
    const provider = providerForSession(config, existing?.modelId)
    if (!provider) throw new Error('还没有配置模型')

    const controller = new AbortController()
    this.controllers.set(sessionId, controller)

    try {
      const { body, images } = await this.withAttachments(sessionId, text, files, provider)
      const session = await store.appendMessages(sessionId, [
        {
          id: store.newId(),
          role: 'user',
          content: body,
          ...(images.length ? { images } : {}),
          createdAt: Date.now()
        }
      ])
      await this.runLoop(session, config, provider, controller.signal, options)
    } finally {
      this.controllers.delete(sessionId)
      this.alwaysApprove.delete(sessionId)
      this.alwaysApproveHigh.delete(sessionId)
      this.emit(sessionId, { type: 'done' })
    }
  }

  /** 共用的「准备一次运行」：抢锁、读配置、取供应商 */
  private async begin(sessionId: string): Promise<{ config: AppConfig; provider: ProviderConfig; signal: AbortSignal }> {
    if (this.controllers.has(sessionId)) throw new Error('这个会话正在运行中')
    const config = await loadConfig()
    const existing = await store.loadSession(sessionId).catch(() => null)
    const provider = providerForSession(config, existing?.modelId)
    if (!provider) throw new Error('还没有配置模型')
    const controller = new AbortController()
    this.controllers.set(sessionId, controller)
    return { config, provider, signal: controller.signal }
  }

  private end(sessionId: string): void {
    this.controllers.delete(sessionId)
    this.alwaysApprove.delete(sessionId)
      this.alwaysApproveHigh.delete(sessionId)
    this.emit(sessionId, { type: 'done' })
  }

  /** 重新生成：退回到最后一条用户消息之前，把这一轮重跑 */
  async regenerate(sessionId: string): Promise<void> {
    const { config, provider, signal } = await this.begin(sessionId)
    try {
      const before = await store.loadSession(sessionId)
      const lastUser = [...before.messages].reverse().find((m) => m.role === 'user')
      if (!lastUser) throw new Error('这个会话还没有提问，没法重新生成')
      const session = await store.truncateFrom(sessionId, lastUser.id)
      await this.runLoop(session, config, provider, signal)
    } finally {
      this.end(sessionId)
    }
  }

  /** 改掉某条用户消息，从那里重新跑（后面的回答和工具结果都丢掉） */
  async editAndResend(sessionId: string, messageId: string, text: string): Promise<void> {
    const { config, provider, signal } = await this.begin(sessionId)
    try {
      const before = await store.loadSession(sessionId)
      const target = before.messages.find((m) => m.id === messageId)
      if (!target || target.role !== 'user') throw new Error('只能修改自己的提问')
      await store.truncateFrom(sessionId, messageId)
      const session = await store.appendMessages(sessionId, [
        { ...target, content: text, createdAt: Date.now() }
      ])
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
      `继续。上次执行被中断了，请从断点接着做完，不要重复已经完成的部分。${brief}`
    )
  }

  /**
   * 附件处理分两条路：
   * - 图片：交给视觉模型直接看（随消息附带 base64），模型看不了就明确告知，别让它反问「你想识别什么」。
   * - 其他：正文由程序抽取后拼进消息，模型拿到的是文字而不是路径。
   */
  private async withAttachments(
    sessionId: string,
    text: string,
    files: SendAttachment[] | undefined,
    provider: ProviderConfig
  ): Promise<{ body: string; images: string[] }> {
    const list = (files ?? []).filter((f) => f && f.absPath)
    if (!list.length) return { body: text, images: [] }

    const canSee = providerSupportsVision(provider)
    const imageFiles = list.filter((f) => isImagePath(f.absPath) && f.size <= 40 * 1024 * 1024)
    const docFiles = list.filter((f) => !imageFiles.includes(f))
    const images = canSee ? imageFiles.slice(0, 6).map((f) => f.absPath) : []

    // 给附件正文留出上下文预算，剩下的留对话历史
    const total = Math.max(2000, Math.min(30000, Math.floor(provider.contextWindow * 0.35)))
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
          `【图片看不了】用户发了 ${imageFiles.length} 张图片，但当前模型（${provider.model}）没有视觉能力，你确实看不到画面。`,
          '必须直接说明这一点，并给出可行做法：在「模型设置 → 模型 API」里换成支持看图的模型（如 qwen2.5-vl、llava、gemma3、mistral-small-3.1、gpt-4o），',
          '或者让用户把图里的文字/关键数据打字发过来。绝对不要反问「你想让我识别什么」，那等于没读消息。'
        ].join('\n')
      )
      this.emit(sessionId, { type: 'attach_no_vision', model: provider.model })
    }

    const rendered = renderAttachmentBody(items, notes)
    return { body: rendered ? `${text}\n\n${rendered}` : text, images }
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
      let spoke = false
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
        const reason = switchReason(err)
        const next = chain[i + 1]
        if (!reason || !next) throw err
        this.emit(sessionId, {
          type: 'failover',
          from: `${use.name} · ${use.model || '未选模型'}`,
          to: `${next.name} · ${next.model}`,
          reason
        })
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
    // 非交互模式下的审批决策：不弹框，按策略确定性返回 allow/deny
    const nonInteractive = options?.nonInteractive === true
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
    const workspace = await effectiveWorkspace(config)

    // 软件设置里的两个能力开关：关掉后工具不发给模型，提示词里也不再教它用
    const webOn = config.webSearch !== false
    const memoryOn = config.memory !== false
    // 小模型走精简提示 + 精简工具集，否则它会只顾着说「好的，我正在搜索」
    const small = isSmallModel(provider.model)
    const mcpOn = config.mcpEnabled !== false
    const disabled = (name: string): boolean =>
      (name === 'web_search' || name === 'web_fetch')
        ? !webOn
        : name === 'remember'
          ? !memoryOn
          : false
    // MCP 工具是运行时从外部服务读的：没有配置就是空数组，不会占上下文
    const extra = small || !mcpOn ? [] : await mcpToolSpecs().catch(() => [])
    // 全量工具留着，自动切换到更大的模型时用得上
    const fullTools = [...toolSpecs, ...extra].filter((t) => !disabled(t.name))
    const tools = fullTools.filter((t) => !small || LITE_TOOLS.has(t.name) || isMcpTool(t.name))

    // 跨会话记忆：每个工作区一份，整段注入系统提示（内部有长度上限）
    let memory = memoryOn ? await memoryForPrompt(workspace) : null
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
    /** 「只说不做」的纠正次数，最多两次，避免死循环 */
    let nudges = 0
    /** 空回复的纠正次数，最多一次 */
    let blanks = 0
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

    for (let step = 0; step < stepBudget; step++) {
      if (signal.aborted) throw new Error('已取消')

      // 切换过供应商后，提示词和「小模型」判断都要按新模型来
      const smallNow = isSmallModel(runProvider.model)
      const stepTools = smallNow ? tools : fullTools
      // 输出也要留位置：窗口是「提示 + 生成」共用的，全给历史会把回答挤断
      const outputReserve = Math.min(4096, Math.max(512, Math.floor(ctxWindow * 0.25)))

      const promptFor = (summaryText: string | null | undefined): string =>
        smallNow
          ? litePrompt(workspace, {
              web: webOn,
              remember: memoryOn,
              instructions,
              summary: summaryText,
              verify: verifyNote,
              nudge: nudgeNote,
              cont: continueNote
            })
          : systemPrompt(workspace, runProvider, {
              memory,
              instructions,
              summary: summaryText,
              verify: verifyNote,
              web: webOn,
              remember: memoryOn,
              nudge: nudgeNote,
              cont: continueNote
            })

      /**
       * 系统提示和工具定义同样占窗口，但以前它们不算进预算：
       * 16K 的本地模型，光「11 个工具的 JSON Schema + 系统提示」就吃掉三四千，
       * 于是历史明明按 70% 裁过，整个请求还是超了服务端上限，直接 400。
       */
      const overheadOf = (prompt: string): number =>
        Math.ceil((estimateTokens(prompt) + toolSpecsTokens(stepTools)) * 1.1) + 256

      /** 在这个窗口下，历史最多还能放多少 token */
      const capOf = (ctx: number, prompt: string, summarized: number): number => {
        const usable = Math.floor((ctx - overheadOf(prompt) - outputReserve) * 0.95)
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
      const overhead = overheadOf(promptText)

      const historyCap = (ctx: number): number =>
        Math.max(600, Math.min(Math.floor(ctx * 0.7), Math.floor((ctx - overhead - outputReserve) * 0.95)) - summarized)

      const buildMessages = (cap: number): ChatMessage[] => {
        const history = compact(rest, cap)
        const list: ChatMessage[] = [
          { id: 'system', role: 'system', content: promptText, createdAt: Date.now() },
          ...history.filter((m) => m.role !== 'system')
        ]
        // Ollama 不接受连续两条 assistant；nudge / 自动验证重试时历史末尾可能正好是它
        const tail = list[list.length - 1]
        if (tail && tail.role === 'assistant') {
          list.push({ id: 'continue', role: 'user', content: '（继续）', createdAt: Date.now() })
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
              gate.push(t)
            }
          )
          break
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err ?? '')
          if (signal.aborted || spoke || retry >= 2 || !isContextOverflow(msg)) throw err

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
          costUsd: estimateCost(attempt.provider.model, result.usage)
        }
        try {
          const total = await store.bumpUsage(session.id, delta)
          const cost = (total.costUsd ?? 0) > 0 ? total.costUsd : undefined
          this.emit(session.id, { type: 'usage', usage: { ...total, costUsd: cost }, last: delta })
        } catch {
          // 统计失败不能影响对话本身
        }
      }

      const parsed = parseTextToolCalls(result.text)
      const toolCalls = result.toolCalls.length ? result.toolCalls : parsed.calls
      const content = result.toolCalls.length ? result.text : parsed.cleanText

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

        // 空回复：一个字都没给，重跑一次让它把结果说出来
        if (blank && blanks < 1) {
          blanks += 1
          nudgeNote =
            '你上一轮什么都没输出。请直接给出结果：用两三句话总结上面的工具结果；如果还没拿到结果，就现在调用工具去做。'
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

        // 模型认为做完了：如果本轮动过代码，先自己跑一遍测试/构建再交差
        const canVerify =
          config.autoVerify !== false &&
          config.approvalMode !== 'readonly' &&
          touched.size > 0 &&
          verifyRounds < 2
        if (canVerify) {
          const plan = await detectVerifyPlan(workspace)
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
          (t) => t.name !== 'task' && t.name !== 'update_todos' && t.name !== 'question'
        ),
        budget: stepCap,
        web: webOn,
        signal,
        instructions: instructionsBlock(instructions) || null,
        nonInteractive,
        approvalPolicy: options?.approvalPolicy
      }

      for (let ci = 0; ci < toolCalls.length; ci++) {
        const call = toolCalls[ci]
        if (signal.aborted) throw new Error('已取消')

        // task：模型连着写的几个子任务一起并行跑，回来再按原顺序落库
        if (call.name === 'task') {
          const batch: ToolCall[] = [call]
          while (ci + 1 < toolCalls.length && toolCalls[ci + 1].name === 'task') {
            batch.push(toolCalls[++ci])
          }
          for (const f of await this.runTaskBatch(subCtx, batch)) touched.add(f)
          continue
        }

        // 小模型：把抓取量和搜索条数压小，别让它一次吃掉整个上下文
        const args = isSmallModel(runProvider.model) ? shrinkArgsForSmall(call.name, call.args) : call.args
        this.emit(session.id, { type: 'tool_start', callId: call.id, tool: call.name, args })

        // 关掉的能力不参与风险评估，否则会先弹一个毫无意义的确认框
        const risk = disabled(call.name)
          ? null
          : isMcpTool(call.name)
            ? classifyMcpRisk(call.name, permRules)
            : classifyRisk(call.name, args, workspace, permRules)
        const decision = decideApproval({
          mode: config.approvalMode,
          hasRisk: !!risk,
          high: risk?.high === true,
          denied: risk?.denied === true,
          alwaysApprove: this.alwaysApprove.has(session.id),
          alwaysApproveHigh: this.alwaysApproveHigh.has(session.id)
        })
        let approved = decision !== 'deny'
        if (decision === 'ask' && risk) {
          if (nonInteractive) {
            // 无头模式：不弹框，按策略确定性收口（approveDecision 里 ask 分支已处理）
            approved = approveDecision({
              mode: config.approvalMode,
              hasRisk: true,
              high: risk.high === true,
              denied: risk.denied === true,
              alwaysApprove: this.alwaysApprove.has(session.id),
              alwaysApproveHigh: this.alwaysApproveHigh.has(session.id)
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
            approved = await this.askApproval(session.id, call.name, args, risk, preview)
          }
        }

        const started = Date.now()
        // 写文件的：先留一份改前内容，执行完再记一条可撤销的改动
        // patch 是多文件，用 patchTargets 取全部目标；单个文件仍用 toolTargetPath
        const writeTargets: string[] = []
        if (call.name === 'patch') {
          writeTargets.push(...patchTargets(workspace, args, risk?.kind === 'outside'))
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
        if (!approved) {
          ok = false
          output =
            config.approvalMode === 'readonly'
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
            output = `执行失败：${(err as Error).message}`
          }
        } else {
          try {
            output = await executeTool(call.name, args, {
              workspace,
              signal,
              allowOutside: risk?.kind === 'outside'
            })
            if (call.name === 'write_file' || call.name === 'edit_file') {
              touched.add(String(args.path ?? ''))
            } else if (call.name === 'patch') {
              for (const t of writeTargets) touched.add(t)
            }
            if (call.name === 'remember') {
              // 刚记下的内容立刻生效，不用等下一轮对话
              memory = await memoryForPrompt(workspace)
            }
          } catch (err) {
            ok = false
            output = `执行失败：${(err as Error).message}`
          }
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

      // 这一轮真的动过手：下次模型再停下时，才值得再推它一轮
      sinceContinue += toolCalls.length

      // 同一条命令被反复轮询（「下载还没完，再等三分钟」）时，对话会被几十条一模一样的记录刷屏，
      // 而进度并没有往前。抓到就提醒一次，让它换成一次长等待或直接查进度，别继续空转。
      for (const call of toolCalls) recentCalls.push(`${call.name}:${JSON.stringify(call.args ?? {})}`)
      while (recentCalls.length > 40) recentCalls.shift()
      if (!pollWarned) {
        const lastSig = recentCalls[recentCalls.length - 1]
        const repeat = recentCalls.filter((s) => s === lastSig).length
        if (repeat >= 5) {
          pollWarned = true
          continueNote =
            `同一个调用已经原样重复了 ${repeat} 次，结果看起来没有变化：${lastSig.slice(0, 120)}\n` +
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
    }

    // 步数预算用完了还没收工：这里是真的要交给用户了（不是崩溃，标 done 清除）
    persistCheckpoint('done')
    await clearCheckpoint(session.id)
    this.emit(session.id, { type: 'step_limit', maxSteps: stepBudget })
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
            mode: ctx.config.approvalMode,
            hasRisk: true,
            high: risk.high === true,
            denied: risk.denied === true,
            alwaysApprove: this.alwaysApprove.has(ctx.sessionId),
            alwaysApproveHigh: this.alwaysApproveHigh.has(ctx.sessionId)
          })
          if (decision === 'allow') return Promise.resolve(true)
          if (decision === 'deny') return Promise.resolve(false)
          if (ctx.nonInteractive) {
            // 高危永不自动放行；普通操作按策略
            return Promise.resolve(risk.high === true ? false : ctx.approvalPolicy === 'allow')
          }
          return this.askApproval(ctx.sessionId, tool, args, risk, preview)
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
