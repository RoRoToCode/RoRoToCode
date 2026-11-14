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
import { settleToolArgs } from '../shared/toolargs'
import { diagnoseReport } from './lsp'
import { formatDiagGap, formatDiagnostics } from '../shared/diagnostics'
import { createToolCallGuard } from '../shared/toolguard'
import { chat } from './providers'
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

function childPrompt(workspace: string, web: boolean, instructions?: string | null): string {
  const tools = web
    ? 'read_file / list_dir / glob / grep 看现状，write_file / edit_file / patch 改文件，run_shell 跑命令，web_search / web_fetch 查资料'
    : 'read_file / list_dir / glob / grep 看现状，write_file / edit_file / patch 改文件，run_shell 跑命令'
  const rules = [
    '你是子 agent，只负责完成被指派的这一件子任务。你看不到用户的原始对话，也不要向用户提问。',
    `当前工作区：${workspace}`,
    `可用工具：${tools}。`,
    '',
    '规则：',
    '1. 先看清现状再动手，不要假设文件内容或路径存在。',
    '2. 只做被指派的事，不要顺手改别的地方、不要扩大范围。',
    '3. 做完用 3-6 句话总结：完成了什么、改了哪些文件（写完整相对路径）、关键结论、还有什么没解决。',
    '4. 信息不足或做不到就如实说明，不要编造。',
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
  /** 「该查却没查」只提示一次 */
  let gapNoted = false

  const messages: ChatMessage[] = [
    { id: 'child-system', role: 'system', content: childPrompt(opts.workspace, opts.web, opts.instructions), createdAt: Date.now() },
    { id: 'child-user', role: 'user', content: opts.prompt, createdAt: Date.now() }
  ]

  try {
    for (let step = 0; step < opts.maxSteps; step++) {
      if (opts.signal.aborted) throw new Error('已取消')
      task.steps = step + 1

      const result = await chat({
        provider: opts.provider,
        messages: trim(messages, opts.budget),
        tools: opts.provider.noTools ? [] : opts.tools,
        signal: opts.signal,
        // 子 agent 的文字不流到主界面，只留最后那句总结
        onText: () => undefined
      })

      const parsed = parseTextToolCalls(result.text)
      const calls = result.toolCalls.length ? result.toolCalls : parsed.calls
      const content = result.toolCalls.length ? result.text : parsed.cleanText

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
        if (repeat.verdict === 'block') {
          messages.push({
            id: `child-t-${step}-${call.id}`,
            role: 'tool',
            content: clip(repeat.note),
            toolCallId: call.id,
            toolName: call.name,
            toolArgs: call.args,
            createdAt: Date.now()
          })
          task.tools.push({
            tool: call.name,
            ok: false,
            durationMs: Date.now() - started,
            note: '重复调用，已拦截'
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
              allowOutside: risk?.kind === 'outside'
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
