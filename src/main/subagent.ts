import { promises as fs } from 'node:fs'
import type {
  ApprovalRequest,
  ChatMessage,
  FileChange,
  ProviderConfig,
  SubAgentTask,
  ToolCall
} from '../shared/types'
import type { ToolSpec } from './tools/spec'
import { toolSpecs } from './tools/spec'
import { RAW_ARG_KEY, settleToolArgs } from '../shared/toolargs'
import { diagnoseReport } from './lsp'
import { formatDiagGap, formatDiagnostics } from '../shared/diagnostics'
import { createToolCallGuard, createScratchGuard, isTruncatedWrite } from '../shared/toolguard'
import { chat } from './providers'
import { healTruncatedWrites } from './heal'
import { classifyRisk, executeTool, previewWrite, previewPatch, patchTargets, toolTargetPath } from './tools'
import type { RiskInfo } from './tools'
import { loadProjectPermissions } from './permissions'
import { parseTextToolCalls } from './parse'
import { recordChange } from './changes'
import { diffLines, diffStats } from './diff'
import { runHooks } from './hooks'

/** 子 agent 写过的文件类型：只有这些需要留可撤销的快照 */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'patch'])

/** 子 agent 自己的 token 粗估（与 agent.ts 保持同一口径） */
function est(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length
  return Math.ceil(cjk * 1.05 + (text.length - cjk) / 3.6)
}

async function readOrNull(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, 'utf8')
  } catch {
    return null
  }
}

/** 单个工具结果进上下文前先砍一刀，别让一次 cat 大文件把子 agent 撑爆 */
function clip(text: string, max = 8000): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.7)
  return `${text.slice(0, head)}\n\n…（中间省略 ${text.length - max} 字）…\n\n${text.slice(-Math.floor(max * 0.3))}`
}

/**
 * 裁上下文：只压缩较早的工具结果，不删消息。
 * 删消息会破坏 assistant.toolCalls 与 tool 消息的配对，OpenAI 和 Ollama 都会直接报 400。
 */
function trim(messages: ChatMessage[], budget: number): ChatMessage[] {
  let total = messages.reduce((n, m) => n + est(m.content || ''), 0)
  if (total <= budget) return messages
  const out = messages.map((m) => ({ ...m }))
  // 最近 6 条保持原样，再往前的工具结果压到 800 字
  for (let i = 0; i < out.length - 6 && total > budget; i++) {
    const m = out[i]
    if (m.role !== 'tool' || m.content.length <= 800) continue
    const short = `${m.content.slice(0, 800)}\n…（较早的工具结果已省略）`
    total -= est(m.content) - est(short)
    m.content = short
  }
  return out
}

/**
 * 只读探查模式（task 工具 mode=explore）下，子 agent 能用的工具。
 *
 * 全是「读 / 查 / 搜」，没有 write_file / edit_file / patch / run_shell ——
 * 从工具层面就保证它改不了文件、跑不了命令，比「提示里劝它别改」可靠得多。
 * 白名单更短，等于子代理的请求体更小，窗口紧张的小模型也能装下。
 */
const EXPLORE_TOOLS = new Set([
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'goto_definition',
  'find_references',
  'repo_map',
  'web_search',
  'web_fetch'
])

/** 只读探查模式可用的工具名集合（导出给测试断言「改文件/跑命令的工具一个都不在里面」） */
export function exploreTools(): Set<string> {
  return EXPLORE_TOOLS
}

/**
 * 只读探查子 agent 该补回去的导航工具。
 *
 * 小窗口（父会话走 LEAN_TOOLS 精简表）时，goto_definition / find_references 会被
 * 收进 toolbox 网关；而 toolbox 本身**不能**放进 EXPLORE_TOOLS —— 它能展开出
 * git / terminal 这类会改东西的工具，等于给只读通道开后门。结果是 explore 子 agent
 * 连「这个函数在哪定义、被谁引用」都查不了，而这两件事恰恰是审查最需要的
 * （改签名前确认影响面、判断一处改动有没有漏掉的调用点）。
 *
 * 所以这里按需补回去，而不是放开 toolbox：两条工具说明合计约 160 tokens，
 * 仍在 explore 那道 2500 门槛的余量里；换回来的是类型系统级的定位，
 * 比让子 agent 拿 grep 猜文本准确得多。
 */
const EXPLORE_NAV = ['goto_definition', 'find_references']

/**
 * 给只读探查的工具表补上导航工具：已有就不重复加，spec 找不到就跳过。
 * 非只读模式不走这里（完整模式本来就带着整套工具）。
 */
export function withExploreNav(tools: ToolSpec[]): ToolSpec[] {
  const have = new Set(tools.map((t) => t.name))
  const missing = EXPLORE_NAV.filter((n) => !have.has(n))
    .map((n) => toolSpecs.find((t) => t.name === n))
    .filter((t): t is ToolSpec => Boolean(t))
  return missing.length ? [...tools, ...missing] : tools
}

/**
 * 按 mode 过滤子 agent 的工具表：explore 只留只读白名单，其余原样返回。
 *
 * 嵌套封顶也在这里：孙 agent（depth >= 1）不再拿到 task 工具，从工具层面就
 * 保证「最多往下派一层」，不会让一个 30 步的子 agent 无限递归出更多子 agent。
 */
export function filterSubagentTools(tools: ToolSpec[], mode?: 'explore' | null, depth = 0): ToolSpec[] {
  const base = mode === 'explore' ? tools.filter((t) => EXPLORE_TOOLS.has(t.name)) : tools
  if (depth >= 1) return base.filter((t) => t.name !== 'task')
  return base
}

export function childPrompt(
  workspace: string,
  web: boolean,
  instructions?: string | null,
  mode?: 'explore' | null
): string {
  const readOnly = mode === 'explore'
  const tools = readOnly
    ? web
      ? 'read_file / list_dir / glob / grep / goto_definition / find_references / repo_map 看现状，web_search / web_fetch 查资料'
      : 'read_file / list_dir / glob / grep / goto_definition / find_references / repo_map 看现状'
    : web
      ? 'read_file / list_dir / glob / grep 看现状，write_file / edit_file / patch 改文件，run_shell 跑命令，web_search / web_fetch 查资料'
      : 'read_file / list_dir / glob / grep 看现状，write_file / edit_file / patch 改文件，run_shell 跑命令'
  /**
   * 规则正文分开写、编号由 count 生成：只读和完整两套分支条数不同，
   * 手写编号一旦错位，模型会把它当成「少了一条规则」而反复猜。
   */
  const body: string[] = [
    readOnly
      ? '你是只读探查：只能读文件、搜索、查资料，不能改任何文件、不能跑任何命令，改动的建议写进总结即可。'
      : '只做被指派的事，不要顺手改别的地方、不要扩大范围。'
  ]
  if (readOnly) {
    /**
     * 审查类子任务的输出必须可拼装。
     *
     * 父 agent 可能同时派了三路 explore 分头查（逻辑/异常/需求），回来后要
     * 合成一份给用户。三份格式各异的散文没法合，也没法排序取前几条 ——
     * 所以格式钉在「结论 → 问题 → 位置 → 影响 → 建议」，且限 5 条
     * （和内置「审查」档案的上限一致，两条通道的结论能直接对比）。
     * 梳理链路这类任务不受影响：它不是「找问题」，照常写 3-6 句总结。
     */
    body.push(
      '如果派给你的是「审查 / 找问题 / 核对需求」这类检查任务：先给一句结论（可以合 / 需要改 / 必须改），' +
        '再按「问题 → 位置（文件:行）→ 影响 → 建议」逐条列，最多 5 条、按严重程度排序；' +
        '没发现问题就直接说没问题，不要为了显得认真而挑刺。'
    )
    body.push('做完用 3-6 句话总结：查了哪些地方（写完整相对路径）、关键结论、还有什么没查清。')
  } else {
    body.push('做完用 3-6 句话总结：完成了什么、改了哪些文件（写完整相对路径）、关键结论、还有什么没解决。')
  }
  body.push('信息不足或做不到就如实说明，不要编造。')

  // 第 1 条已固定写在下面，这里从 2 开始接
  let no = 1
  const numbered = body.map((line) => `${++no}. ${line}`)
  const rules = [
    '你是子 agent，只负责完成被指派的这一件子任务。你看不到用户的原始对话，也不要向用户提问。',
    `当前工作区：${workspace}`,
    `可用工具：${tools}。`,
    '',
    '规则：',
    `1. 先看清现状再动手，不要假设文件内容或路径存在。`,
    ...numbered,
    '',
    '你的这段总结会被原样回传给主 agent，所以要写成能独立读懂的样子。'
  ]
  if (instructions) {
    rules.splice(rules.length - 1, 0, '', '【项目规则】以下约定必须遵守：', instructions)
  }
  return rules.join('\n')
}

export interface SubAgentOptions {
  id: string
  /** 父 agent 里那次 task 调用的 id */
  callId: string
  /** 归属的父会话，改动快照记在它名下 */
  sessionId: string
  description: string
  prompt: string
  /** 开始时间，父 agent 已经在 subagent_start 事件里发过同一个值 */
  startedAt?: number
  workspace: string
  provider: ProviderConfig
  /** token 预算，超了压前面的工具结果 */
  budget: number
  maxSteps: number
  /** 已经过滤好的工具（不含 task / update_todos） */
  tools: ToolSpec[]
  /** 只读探查模式：额外把工具收窄到只读白名单，见 EXPLORE_TOOLS */
  mode?: 'explore' | null
  /** 嵌套深度：0 = 父派子，1 = 子派孙。孙 agent（depth>=1）不再拿到 task 工具，最多往下派一层 */
  depth?: number
  signal: AbortSignal
  web: boolean
  /** 项目级规则（AGENTS.md），注入子 agent 的系统提示 */
  instructions?: string | null
  /** 这次为什么用/没用工作模型（并行是否生效），随任务一起带给界面 */
  note?: string
  /** 需要用户批准时回调；父 agent 用自己的审批弹窗 */
  approve: (
    tool: string,
    args: Record<string, unknown>,
    risk: RiskInfo,
    preview?: ApprovalRequest['preview']
  ) => Promise<boolean>
  /** 子 agent 改了文件，父负责发事件 */
  onChange: (change: FileChange) => void
  /** 进度回调：开始、每步、结束都调一次 */
  onUpdate: (task: SubAgentTask) => void
}

/**
 * 跑一个子 agent。
 * 它有独立的对话历史（不碰父会话的 messages），只把最后的总结回传给父，
 * 所以中间几十次读文件的噪声不会占用主对话的上下文。
 */
export async function runSubAgent(opts: SubAgentOptions): Promise<SubAgentTask> {
  const task: SubAgentTask = {
    id: opts.id,
    callId: opts.callId,
    description: opts.description,
    prompt: opts.prompt,
    status: 'running',
    // 记下实际用的模型：配了「工人模型」时它和主对话不是同一个，
    // 界面要能看出这个子任务到底是谁在干
    model: opts.provider.model,
    note: opts.note,
    steps: 0,
    startedAt: opts.startedAt ?? Date.now(),
    summary: '',
    tools: []
  }

  // 项目级权限规则：子代理和主 agent 用同一套边界，安全不能因为「子」就放开
  const permRules = await loadProjectPermissions(opts.workspace)
  /**
   * 子 agent 只有 30 步，比父会话更经不起空转：同一个 grep / 同一个 patch
   * 来回发几遍，步数就没了，交回去的还是一句「我还在看」。
   * 护栏和主链路共用一套判据（同参数 + 结果没变才算空转）。
   */
  const callGuard = createToolCallGuard()
  /** 临时脚本按目录记账，和签名护栏互补（见 shared/toolguard 里那段说明） */
  const scratchGuard = createScratchGuard()
  /** 「该查却没查」只提示一次 */
  let gapNoted = false

  const messages: ChatMessage[] = [
    { id: 'child-system', role: 'system', content: childPrompt(opts.workspace, opts.web, opts.instructions, opts.mode), createdAt: Date.now() },
    { id: 'child-user', role: 'user', content: opts.prompt, createdAt: Date.now() }
  ]

  // 只读探查：工具收窄到 EXPLORE_TOOLS，请求体更小，且从工具层就拦死「改文件 / 跑命令」
  // 嵌套封顶：depth >= 1 的孙 agent 不再拿到 task，最多往下派一层
  const tools = filterSubagentTools(opts.tools, opts.mode, opts.depth ?? 0)

  try {
    for (let step = 0; step < opts.maxSteps; step++) {
      if (opts.signal.aborted) throw new Error('已取消')
      task.steps = step + 1

      const result = await chat({
        provider: opts.provider,
        messages: trim(messages, opts.budget),
        tools: opts.provider.noTools ? [] : tools,
        signal: opts.signal,
        // 子 agent 的文字不流到主界面，只留最后那句总结
        onText: () => undefined
      })

      const parsed = parseTextToolCalls(result.text)
      const calls = result.toolCalls.length ? result.toolCalls : parsed.calls
      const content = result.toolCalls.length ? result.text : parsed.cleanText

      /**
       * 和执行顺序有关：续写必须在「把这条 assistant 消息塞进历史」之前，
       * 否则补全的只是本地这个对象，历史里留给下一轮的还是半截参数。
       * 子 agent 只有 30 步，一次整份重写就能吃掉十几步，所以它比主链路更该续。
       */
      if (calls.length) {
        await healTruncatedWrites({
          provider: opts.provider,
          messages,
          calls,
          signal: opts.signal
        })
      }

      // 不再调工具 = 它认为做完了，这句话就是总结
      if (!calls.length) {
        task.summary = content.trim()
        break
      }

      messages.push({
        id: `child-a-${step}`,
        role: 'assistant',
        content,
        toolCalls: calls,
        createdAt: Date.now()
      })

      for (const rawCall of calls) {
        if (opts.signal.aborted) throw new Error('已取消')
        const started = Date.now()

        /**
         * 和主 agent 走同一套参数容错。子 agent 烧的是同一份上下文，
         * 一个坏 JSON 在它这里同样会变成「缺少 path → 我用法不对 → 再试一遍」的死循环。
         */
        const settled = settleToolArgs(rawCall, toolSpecs.find((t) => t.name === rawCall.name))
        const call: ToolCall = { ...rawCall, args: settled.args }

        /**
         * 子 agent 派孙 agent（一层嵌套）。
         *
         * 子 agent 只有 30 步，遇到「要翻阅大量文件才能回答」这类活时，它也可以
         * 像父 agent 一样再派一层孙 agent 去并行梳理，把结论收回来继续 —— 而不是
         * 自己一趟趟读文件把步数烧光。depth 封顶保证孙 agent 不再拿到 task 工具，
         * 不会无限递归。
         */
        if (call.name === 'task' && (opts.depth ?? 0) < 1) {
          const description = String(call.args.description ?? '').trim().slice(0, 40) || '子任务'
          const prompt = String(call.args.prompt ?? call.args.task ?? '').trim()
          if (!prompt) {
            messages.push({
              id: `child-t-${step}-${call.id}`,
              role: 'tool',
              content: clip('task 缺少 prompt：要给子 agent 一段完整、自包含的任务说明。'),
              toolCallId: call.id,
              toolName: call.name,
              toolArgs: call.args,
              createdAt: Date.now()
            })
            task.tools.push({ tool: call.name, ok: false, durationMs: Date.now() - started, note: '缺少 prompt' })
            continue
          }
          const grand: SubAgentTask = {
            id: `grand-${call.id}`,
            callId: call.id,
            description,
            prompt,
            status: 'running',
            steps: 0,
            startedAt: Date.now(),
            summary: '',
            tools: []
          }
          // 孙 agent 复用父给的审批/变更/进度回调，provider 不切换（子 agent 已经在某个 provider 上）
          const done = await runSubAgent({
            id: grand.id,
            callId: call.id,
            sessionId: opts.sessionId,
            description,
            prompt,
            startedAt: grand.startedAt,
            workspace: opts.workspace,
            provider: opts.provider,
            budget: opts.budget,
            maxSteps: Math.max(6, Math.min(opts.maxSteps, 30)),
            tools: opts.tools,
            mode: call.args.mode === 'explore' ? 'explore' : null,
            depth: (opts.depth ?? 0) + 1,
            signal: opts.signal,
            web: opts.web,
            instructions: opts.instructions,
            approve: opts.approve,
            onChange: opts.onChange,
            onUpdate: opts.onUpdate
          })
          const head = `子任务「${description}」${done.status === 'ok' ? '已完成' : '失败'}（${done.steps} 步 · ${done.tools.length} 次工具调用）`
          const summary = done.status === 'fail' ? `失败原因：${done.error ?? '未知'}` : done.summary
          messages.push({
            id: `child-t-${step}-${call.id}`,
            role: 'tool',
            content: clip(`${head}\n\n${summary}`),
            toolCallId: call.id,
            toolName: call.name,
            toolArgs: call.args,
            createdAt: Date.now()
          })
          task.tools.push({
            tool: call.name,
            ok: done.status === 'ok',
            durationMs: Date.now() - started,
            note: description
          })
          continue
        }

        /**
         * 只读探查的硬护栏：即使子 agent 幻觉出一个白名单外的工具（比如 write_file），
         * 也在这里拦下，而不是靠「工具表里没有它就不会被调」去赌。
         * 文本解析路径（parseTextToolCalls）可能拼出一个不在下发清单里的工具名，
         * 不拦的话它会真的执行 —— 只读承诺就被打破了。
         */
        if (opts.mode === 'explore' && !EXPLORE_TOOLS.has(call.name)) {
          messages.push({
            id: `child-t-${step}-${call.id}`,
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            toolArgs: call.args,
            content: clip(
              `[已拦下·只读探查] 你没有 ${call.name} 这个工具。当前是只读模式，只能用读文件、搜索、查资料的工具；改文件 / 跑命令请把结论写进总结，交回主 agent 去做。`
            ),
            createdAt: Date.now()
          })
          task.tools.push({
            tool: call.name,
            ok: false,
            durationMs: Date.now() - started,
            note: '只读模式，已拦截'
          })
          continue
        }

        /**
         * 续写救回来了但拼完仍不完整：不执行。
         * 子 agent 没有界面，写坏了没人能及时发现 —— 到主 agent 那儿只剩一句「任务失败」。
         */
        if (call.truncRejected) {
          messages.push({
            id: `child-t-${step}-${call.id}`,
            role: 'tool',
            content: clip(call.truncRejected),
            toolCallId: call.id,
            toolName: call.name,
            toolArgs: call.args,
            createdAt: Date.now()
          })
          task.tools.push({
            tool: call.name,
            ok: false,
            durationMs: Date.now() - started,
            note: '续写后仍不完整，写入已拦下'
          })
          continue
        }

        /**
         * 截断写入同样要拦：子 agent 只有 30 步，一次半截写入把文件覆盖成残废，
         * 后面十几步就全花在「读回来 → 发现没了 → 重写一遍」上了。
         * 和主循环同一判据：服务端不报 finish_reason 时，看参数是不是断在字符串中间。
         */
        const childRaw =
          typeof call.args?.[RAW_ARG_KEY] === 'string' ? String((call.args as Record<string, unknown>)[RAW_ARG_KEY]) : ''
        if (isTruncatedWrite(result.finishReason, call.name, call.argRepair, childRaw)) {
          messages.push({
            id: `child-t-${step}-${call.id}`,
            role: 'tool',
            content: clip(
              '[已拦下·输出被截断] 上一条回复撞到输出上限，这次写入的参数只生成到一半，没有执行，文件保持原样。' +
                '大文件分两步：先 write_file 写骨架，再用 edit_file 一段段填实现。'
            ),
            toolCallId: call.id,
            toolName: call.name,
            toolArgs: call.args,
            createdAt: Date.now()
          })
          task.tools.push({
            tool: call.name,
            ok: false,
            durationMs: Date.now() - started,
            note: '输出被截断，写入已拦下'
          })
          continue
        }

        if (settled.blocked) {
          messages.push({
            id: `child-t-${step}-${call.id}`,
            role: 'tool',
            content: clip(settled.blocked),
            toolCallId: call.id,
            toolName: call.name,
            toolArgs: call.args,
            createdAt: Date.now()
          })
          task.tools.push({
            tool: call.name,
            ok: false,
            durationMs: Date.now() - started,
            note: '参数不合法，未执行'
          })
          continue
        }

        // 子 agent 干的是真活：改文件、跑命令一样要过审批，安全边界不能因为「子」就放开
        const repeat = callGuard.check(call.name, call.args)
        /**
         * 临时脚本护栏：子 agent 只有 30 步，在 `_tmp_*.js` 之间来回改的代价比父会话更高 ——
         * 步数烧光后交回去的总结通常只有一句「还在试」。换名字新建的脚本签名次次不同，
         * 只有按「同一目录第几个脚本」才拦得住。
         */
        const scratch = repeat.verdict === 'block' ? null : scratchGuard.check(call.name, call.args)
        if (repeat.verdict === 'block' || scratch?.verdict === 'block') {
          messages.push({
            id: `child-t-${step}-${call.id}`,
            role: 'tool',
            content: clip(repeat.verdict === 'block' ? repeat.note : scratch!.note),
            toolCallId: call.id,
            toolName: call.name,
            toolArgs: call.args,
            createdAt: Date.now()
          })
          task.tools.push({
            tool: call.name,
            ok: false,
            durationMs: Date.now() - started,
            note: repeat.verdict === 'block' ? '重复调用，已拦截' : '临时脚本，已拦截'
          })
          continue
        }

        const risk = classifyRisk(call.name, call.args, opts.workspace, permRules)
        let approved = true
        if (risk) {
          let preview: ApprovalRequest['preview'] | undefined
          if (call.name === 'patch') {
            const files = previewPatch(call.args, opts.workspace, risk.kind === 'outside').map((f) => {
              const lines = diffLines(f.before ?? '', f.after ?? '')
              const st = diffStats(lines)
              return { path: f.path, kind: f.kind, added: st.added, removed: st.removed, lines }
            })
            if (files.length) {
              const first = files[0]
              preview = { ...first, files }
            }
          } else if (WRITE_TOOLS.has(call.name)) {
            const pv = await previewWrite(call.name, call.args, opts.workspace).catch(() => null)
            if (pv) {
              const lines = diffLines(pv.before ?? '', pv.after)
              const st = diffStats(lines)
              preview = { path: pv.path, kind: pv.kind, added: st.added, removed: st.removed, lines }
            }
          }
          approved = await opts.approve(call.name, call.args, risk, preview)
        }

        // 目标文件：patch 是多文件，单个写工具是单文件
        const targets: string[] = []
        if (call.name === 'patch') {
          targets.push(...patchTargets(opts.workspace, call.args, risk?.kind === 'outside'))
        } else if (call.name === 'format') {
          const list = Array.isArray(call.args.paths) ? (call.args.paths as unknown[]).map(String) : []
          for (const p of list) {
            try {
              targets.push(toolTargetPath(opts.workspace, p, risk?.kind === 'outside'))
            } catch {
              // 越界路径交给工具自己报错
            }
          }
        } else if (WRITE_TOOLS.has(call.name)) {
          try {
            targets.push(toolTargetPath(opts.workspace, String(call.args.path ?? ''), risk?.kind === 'outside'))
          } catch {
            // 路径非法：不记快照
          }
        }
        const beforeByTarget = new Map<string, string | null>()
        for (const t of targets) beforeByTarget.set(t, await readOrNull(t))

        let output: string
        let ok = true
        /**
         * 钩子对子 agent 同样生效：一个「不许改 generated/」的钩子
         * 不该因为改动是子 agent 做的就绕过去。
         */
        const preHook = approved
          ? await runHooks('preToolUse', {
              workspace: opts.workspace,
              sessionId: opts.sessionId,
              tool: call.name,
              args: call.args
            })
          : { ran: 0 }
        if (preHook.blocked) {
          ok = false
          output = `钩子拒绝了这个操作：${preHook.blocked}`
        } else if (!approved) {
          ok = false
          output = '用户拒绝执行该操作。请换一种方式，或直接说明这件事没做成。'
        } else {
          try {
            output = await executeTool(call.name, call.args, {
              workspace: opts.workspace,
              signal: opts.signal,
              allowOutside: risk?.kind === 'outside',
              // 和主 agent 同一套折算：子 agent 的窗口只会更小，不该读得更狠
              readCap: Math.min(40000, Math.max(4000, Math.round(opts.budget * 1.2)))
            })
          } catch (err) {
            ok = false
            output = `执行失败：${(err as Error).message}`
          }
          if (approved) {
            const postHook = await runHooks('postToolUse', {
              workspace: opts.workspace,
              sessionId: opts.sessionId,
              tool: call.name,
              args: call.args,
              result: output
            })
            if (postHook.context) output += `\n\n【钩子】\n${postHook.context}`
          }
        }

        // 改动同样进父会话的「变更」列表，用户在右侧面板能撤销子 agent 的修改
        if (ok && targets.length) {
          for (const target of targets) {
            const after = await readOrNull(target)
            const before = beforeByTarget.get(target) ?? null
            if (after === null && before === null) continue
            const change = await recordChange({
              sessionId: opts.sessionId,
              root: opts.workspace,
              absPath: target,
              before,
              after,
              tool: call.name
            })
            if (change) opts.onChange(change)
          }
          /**
           * 子 agent 同一条规矩：改完立刻查一次编译，错误当场还给它。
           * 子 agent 的步数被压到 30，比父会话更经不起「改坏了还往下改」——
           * 错在这里被发现，能就地修；等到父会话收尾才发现，这 30 步已经全白跑。
           */
          const report = await diagnoseReport(opts.workspace, targets)
          if (report.diags.length) {
            output += `\n\n${formatDiagnostics(report.diags, {
              workspace: opts.workspace,
              filesWritten: targets.length
            })}`
          } else if (report.skipped === 'no-typescript' || report.skipped === 'unavailable') {
            // 子 agent 的生命更短：说一次就够，别每改一个文件重复一遍
            if (!gapNoted) {
              gapNoted = true
              output += `\n\n${formatDiagGap(report.skipped)}`
            }
          }
        }

        const durationMs = Date.now() - started
        if (settled.note) output = `${settled.note}\n\n${output}`
        callGuard.record(call.name, call.args, output)
        // 临时脚本按目录记账：同目录再新建第二个才会被拦
        scratchGuard.record(call.name, call.args)
        if (repeat.verdict === 'warn') output += `\n\n${repeat.note}`
        const text = clip(output)
        messages.push({
          id: `child-t-${step}-${call.id}`,
          role: 'tool',
          content: text,
          toolCallId: call.id,
          toolName: call.name,
          toolArgs: call.args,
          createdAt: Date.now()
        })

        task.tools.push({
          tool: call.name,
          ok,
          durationMs,
          note: `${String(call.args.path ?? call.args.query ?? call.args.command ?? '').slice(0, 60)}`.trim()
        })
      }

      // 每步推一次，卡片上能看到它走到第几步、在干什么
      opts.onUpdate({ ...task, tools: [...task.tools] })
    }

    if (!task.summary) {
      task.status = 'fail'
      task.error = `子 agent 走了 ${opts.maxSteps} 步仍未给出结论`
      task.summary = `（子任务「${opts.description}」没有产出总结）`
    } else {
      task.status = 'ok'
    }
  } catch (err) {
    task.status = 'fail'
    task.error = (err as Error).message
    task.summary = `（子任务「${opts.description}」执行失败：${task.error}）`
  }

  task.endedAt = Date.now()
  return task
}
