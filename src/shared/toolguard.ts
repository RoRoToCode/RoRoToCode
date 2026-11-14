/**
 * 工具调用护栏：模型卡在「同一个动作反复做」上时，光靠提示词是劝不住的。
 *
 * 和 degenerate.ts 的分工要说清楚：
 * - 那边管**文本**在流里复读（解码层面的故障，贪心解码走进高概率重复路径）；
 * - 这边管**动作**在原地打转（策略层面的故障，模型认定「再来一次就好了」）。
 * 真实复现里两种都会发生：同一个 query 调了 47 次 web_search、同一个 patch 提交 16 次，
 * 全程零产出，最后还把上下文烧穿。
 *
 * 判据不是「调用了几次」，而是「调了几次**且结果没变**」：
 * 轮询下载进度时同一个命令会返回不同输出，那是在推进，不该拦；
 * 同一个参数每次都吐回一模一样的错误/结果，才是空转。
 *
 * 阈值按副作用分级：写文件和改代码重复两次就已经很可疑（第二次几乎必然白做），
 * 只读/联网给到 3 次（换汤不换药地重查一遍仍有微弱意义），
 * 命令类卡在中间（轮询是合理用法，但 4 次以上就是不会等）。
 */

export type ToolKind = 'read' | 'shell' | 'write'

export type GuardVerdict = 'ok' | 'warn' | 'block'

export interface GuardDecision {
  verdict: GuardVerdict
  /** 同一签名此前已经执行过的次数 */
  times: number
  /** 回灌给模型的说明；verdict 为 ok 时是空串 */
  note: string
  /** 上次同签名调用的结果（已截断），block 时让模型不必再跑一遍 */
  lastResult: string
}

export interface GuardLimits {
  warnAt: number
  blockAt: number
}

/** 写工具的阈值故意压得很低：同一份 patch 成功过一次，第二次就是空转 */
const LIMITS: Record<ToolKind, GuardLimits> = {
  write: { warnAt: 2, blockAt: 3 },
  shell: { warnAt: 4, blockAt: 6 },
  read: { warnAt: 3, blockAt: 5 }
}

const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'patch',
  'apply_patch',
  'format',
  'board',
  'scratch',
  'remember',
  'update_todos',
  'write_plan'
])

const SHELL_TOOLS = new Set(['run_shell', 'terminal', 'shell_bg', 'git'])

/**
 * 名字 → 副作用等级。
 * 认不出来的（mcp__ 开头的第三方工具、以后新加的）一律当只读：
 * 它们的副作用我们看不清，拦早了会挡住正常流程，所以给更宽的门槛。
 */
export function toolKind(name: string): ToolKind {
  const n = String(name || '').toLowerCase()
  if (WRITE_TOOLS.has(n)) return 'write'
  if (SHELL_TOOLS.has(n)) return 'shell'
  return 'read'
}

/** FNV-1a：只用来做等值比较，不要求抗碰撞强度 */
function fnv(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/**
 * 键序稳定的 JSON：`{a:1,b:2}` 和 `{b:2,a:1}` 必须算出同一个签名，
 * 否则模型换个键序就能绕过护栏（小模型真的会这么干）。
 */
function stable(value: unknown, depth = 0): string {
  if (depth > 8) return '…'
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') {
    const text = JSON.stringify(value)
    return text === undefined ? 'null' : text
  }
  if (Array.isArray(value)) return `[${value.map((v) => stable(v, depth + 1)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(obj[k], depth + 1)}`).join(',')}}`
}

/** 工具名 + 参数指纹。参数里的空白差异不算不同调用 */
export function callSignature(name: string, args: unknown): string {
  return `${String(name || '').toLowerCase()}|${fnv(stable(args ?? {}))}`
}

function clip(text: string, max = 500): string {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function warnNote(name: string, times: number): string {
  return (
    `[重复调用] 「${name}」用完全相同的参数已经跑过 ${times} 次，返回内容没有变化。` +
    '如果是在等某个状态就绪，改成一次等更久、或直接检查状态；' +
    '需要别的信息就换参数、换工具——原样再发一次不会得到不同的结果。'
  )
}

function blockNote(name: string, times: number, last: string): string {
  const tail = last.trim() ? `\n上次的结果（节选）：${clip(last)}` : '\n（上次没有任何输出）'
  return (
    `[重复调用·已拦截] 「${name}」用完全相同的参数已经跑了 ${times} 次，每次结果都一样，` +
    `所以这一次没有再执行，免得继续空转。${tail}\n` +
    '要往前推进只能换做法：改参数、换工具、或者直接说明卡在哪里。照原样再发一次不会有不同结果。'
  )
}

interface Entry {
  times: number
  /** 最近两次结果的指纹，用来判断「结果已经冻结」 */
  last: string
  prev: string
  lastResult: string
  warned: boolean
}

export interface ToolCallGuard {
  /** 执行前问一句：这次还要不要跑 */
  check(name: string, args: unknown): GuardDecision
  /** 执行后记一笔（result 用工具的原始输出，不含后加的提示） */
  record(name: string, args: unknown, result: string): void
  /** 已记住的签名数（测试用） */
  size(): number
  reset(): void
}

export function createToolCallGuard(opts: { maxEntries?: number } = {}): ToolCallGuard {
  const seen = new Map<string, Entry>()
  const max = Math.max(20, opts.maxEntries ?? 200)

  const blank = (): GuardDecision => ({ verdict: 'ok', times: 0, note: '', lastResult: '' })

  return {
    check(name, args) {
      const entry = seen.get(callSignature(name, args))
      if (!entry || entry.times === 0) return blank()

      const limits = LIMITS[toolKind(name)]
      // 两次结果完全一样才算「冻结」：只有调过一次时没有对比样本，宁可放过
      const frozen = entry.times >= 2 && entry.last === entry.prev

      if (entry.times >= limits.blockAt && frozen) {
        return {
          verdict: 'block',
          times: entry.times,
          note: blockNote(name, entry.times, entry.lastResult),
          lastResult: entry.lastResult
        }
      }
      if (entry.times >= limits.warnAt && !entry.warned) {
        entry.warned = true
        return {
          verdict: 'warn',
          times: entry.times,
          note: warnNote(name, entry.times),
          lastResult: entry.lastResult
        }
      }
      return { verdict: 'ok', times: entry.times, note: '', lastResult: entry.lastResult }
    },

    record(name, args, result) {
      const sig = callSignature(name, args)
      const hash = fnv(String(result ?? ''))
      let entry = seen.get(sig)
      if (!entry) {
        entry = { times: 0, last: '', prev: '', lastResult: '', warned: false }
        seen.set(sig, entry)
        // 插入序就是「最早见到」的顺序，超上限从最旧的开始丢
        while (seen.size > max) {
          const oldest = seen.keys().next()
          if (oldest.done) break
          seen.delete(oldest.value)
        }
      }
      entry.prev = entry.last
      entry.last = hash
      entry.lastResult = clip(String(result ?? ''), 1200)
      entry.times += 1
    },

    size() {
      return seen.size
    },

    reset() {
      seen.clear()
    }
  }
}
