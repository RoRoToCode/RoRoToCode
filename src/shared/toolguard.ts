import { cutInsideString } from './toolargs'

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

/**
 * 这条写类工具调用，是不是「输出被 max_tokens 切断之后、由容错层补出来的半截参数」。
 *
 * 截断的后果不只是「代码没写完」：挂在回复里的工具调用参数也只生成到一半，
 * 非法 JSON 被容错层补成合法对象之后，半截内容照样会执行。
 * 真实复现：6580 字符的 `flappy_bird.js` 被一次 **137 字符**的截断写入覆盖成残废，
 * 模型读回来发现内容没了只能从头重写 —— 89 次写盘只落下 8 个文件，全卡在这。
 *
 * 判据分两条，优先级不同：
 * 1. 服务端明说 `finish_reason=length` + `argRepair` 有值（原文不是合法 JSON，是被补出来的）
 *    + 写类工具 —— 只读工具拿到半截参数最多查不到，不会毁文件；
 * 2. 服务端没说 length 也要能兜住：中转网关、部分 Ollama 版本、某些 chat template 会返回
 *    `stop` 甚至不给这个字段，那时的半截参数一样会被容错层补成合法对象然后覆盖文件。
 *    这种情况只认「断在字符串中间」这个硬证据，语法类修复（尾逗号、单引号）是完整的，
 *    不该拦 —— 拦了只会白让模型重写一遍。
 */
export function isTruncatedWrite(
  finishReason: string | undefined,
  name: string,
  argRepair: string | undefined,
  raw?: string
): boolean {
  if (!argRepair) return false
  if (toolKind(name) !== 'write') return false
  if (finishReason === 'length') return true
  return typeof raw === 'string' && cutInsideString(raw)
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

/**
 * 临时脚本护栏，和上面的签名护栏分工不同。
 *
 * 签名护栏判的是「同一个调用重放」：参数一改就是新签名，永远拦不到。
 * 真实复现：9B 模型做一个 HTML 小游戏，89 次写盘里 47 次是 `_tmp_fix.js`（23 次）、
 * `_tmp_inspect.js`（12 次）、`_tmp_check.py`（9 次）——每次换个名字、内容改几行，
 * 签名次次不同，护栏一次都没触发；真实文件却只动了 8 个。
 *
 * 所以这里按**目录**计数而不是按文件名：换名字正是它绕过护栏的方式。
 * 同一目录允许写一个临时脚本（真要验证时确实需要一个），第二个直接拦，
 * 并把「已有的那一个」写进说明里，让它去改那一个或直接改真实文件。
 */

/** 脚本类扩展名：只有这类文件才值得当「临时调试脚本」管 */
const SCRIPT_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|py|sh|ps1|bat|cmd|rb|lua)$/i

/**
 * 名字像临时脚本：`_tmp_fix.js`、`tmp.py`、`temp_check.sh`、`scratch.js`。
 * 刻意不把 `debug.js` 这类常见正名算进来 —— 项目里本来就可能有，误拦比漏拦更烦人。
 */
const SCRATCH_NAME = /^(?:[._-]?tmp|temp|scratch)(?:[._-]|$)/i

/** 只有单文件写工具才有「这条路径」可判；patch 可能一次改多个文件，不在此列 */
const SINGLE_WRITE_TOOLS = new Set(['write_file', 'edit_file'])

function baseName(file: string): string {
  const norm = String(file || '').replace(/\\/g, '/')
  return norm.slice(norm.lastIndexOf('/') + 1)
}

/** 目录键：同一目录下不同写法（`a\b` 与 `a/b`）必须算同一处 */
export function dirKey(file: string): string {
  const norm = String(file || '').replace(/\\/g, '/').toLowerCase()
  const at = norm.lastIndexOf('/')
  return at < 0 ? '' : norm.slice(0, at)
}

export function isScratchScript(file: string): boolean {
  const base = baseName(file)
  return SCRIPT_EXT.test(base) && SCRATCH_NAME.test(base)
}

export interface ScratchDecision {  verdict: 'ok' | 'block'
  /** 该目录下先前写过、且名字不同的那个临时脚本 */
  previous: string
  note: string
}

export interface ScratchGuard {
  /** 执行前问一句：这次还要不要新建脚本 */
  check(tool: string, args: Record<string, unknown>): ScratchDecision
  /** 执行后记一笔 */
  record(tool: string, args: Record<string, unknown>): void
  /** 已记住的目录数（测试用） */
  size(): number
  reset(): void
}

export function createScratchGuard(opts: { perDir?: number } = {}): ScratchGuard {
  const limit = Math.max(1, opts.perDir ?? 1)
  const byDir = new Map<string, string[]>()
  const ok: ScratchDecision = { verdict: 'ok', previous: '', note: '' }

  const target = (tool: string, args: Record<string, unknown>): string => {
    if (!SINGLE_WRITE_TOOLS.has(String(tool || '').toLowerCase())) return ''
    const file = String(args.path ?? args.file_path ?? '').trim()
    return isScratchScript(file) ? file : ''
  }

  return {
    check(tool, args) {
      const file = target(tool, args)
      if (!file) return ok
      const list = byDir.get(dirKey(file)) ?? []
      // 同名再写是「改自己刚写的那个」，不是又新建一个：这条交给签名护栏判更有意义
      if (!list.length || list.includes(baseName(file).toLowerCase())) return ok
      if (list.length < limit) return ok
      const prev = list[0]
      return {
        verdict: 'block',
        previous: prev,
        note:
          `[临时脚本·已拦截] 这个目录里已经有临时脚本「${prev}」，不再新建「${baseName(file)}」。\n` +
          '新建脚本解决不了问题：真实文件一个都没动，时间全花在脚本之间来回改。\n' +
          `要往前推进只有两条路：① 直接用 edit_file 改真实文件；② 确实需要跑脚本，就 edit_file 改已有的「${prev}」，不要再起新的。`
      }
    },

    record(tool, args) {
      const file = target(tool, args)
      if (!file) return
      const dir = dirKey(file)
      const list = byDir.get(dir) ?? []
      const base = baseName(file).toLowerCase()
      if (!list.includes(base)) list.push(base)
      byDir.set(dir, list)
    },

    size() {
      return byDir.size
    },

    reset() {
      byDir.clear()
    }
  }
}

/**
 * 工具结果的「错误类别」——按类别而不是精确文本聚合。
 *
 * 真实的死循环长这样：模型写 `check.py` → ENOENT → 改名 `check.js` →
 * MODULE_NOT_FOUND → 换 `find.py` → 又是找不到文件……脚本名、参数、错误文本每次都不
 * 一样，签名护栏（按调用参数）和临时脚本护栏（按 tmp 前缀命名）全都漏掉，
 * 但**错误类别始终是「文件/模块找不到」**。按类别计数才拦得住这种换皮重试。
 */
export type ErrorKind =
  | 'missing' // ENOENT / No such file / Cannot find module / 找不到文件
  | 'syntax' // SyntaxError / 语法错误
  | 'outside' // 工作区越界
  | 'other'

/** 从工具结果里认出错误类别；认不出来返回 null（成功或普通输出） */
export function classifyToolError(result: string): ErrorKind | null {
  const t = String(result ?? '')
  if (/路径超出工作区|outside workspace/i.test(t)) return 'outside'
  if (
    /ENOENT|No such file or directory|Cannot find module|MODULE_NOT_FOUND|FileNotFoundError|找不到文件|没有那个文件或目录|can't open file|Could not open|is not recognized|command not found/i.test(
      t
    )
  ) {
    return 'missing'
  }
  if (/SyntaxError|语法错误|unexpected token|invalid syntax/i.test(t)) return 'syntax'
  return null
}

export interface ErrorStreakDecision {
  /** ok=不处理；hint=追加提醒；halt=建议收工（连续多次提醒仍不停） */
  verdict: 'ok' | 'hint' | 'halt'
  kind: ErrorKind | null
  streak: number
  note: string
}

export interface ErrorStreakGuard {
  observe(result: string): ErrorStreakDecision
  reset(): void
}

const ERROR_LABEL: Record<ErrorKind, string> = {
  missing: '文件/模块找不到（ENOENT）',
  syntax: '语法错误',
  outside: '路径越界',
  other: '执行失败'
}

/**
 * 连续同类错误护栏。和 createToolCallGuard 互补：
 * 后者盯「同一个调用重放」，这里盯「换了名字/参数但一直在犯同一类错」。
 *
 * 命中时返回给模型的提示会点破两件事：① 换脚本名重试无效；② 用相对路径、直接
 * 操作真实文件。workspace 由调用方塞进提示，让模型明确工作目录在哪。
 */
export function createErrorStreakGuard(
  opts: { warnAt?: number; haltAt?: number; workspace?: string } = {}
): ErrorStreakGuard {
  const warnAt = Math.max(2, opts.warnAt ?? 3)
  const haltAt = Math.max(warnAt + 1, opts.haltAt ?? 5)
  const ws = opts.workspace ?? ''
  let last: ErrorKind | null = null
  let streak = 0
  let hinted = false

  const note = (kind: ErrorKind, times: number, halt: boolean): string => {
    const lead = halt
      ? `[连续失败·请停止] 已经连续 ${times} 次「${ERROR_LABEL[kind]}」。`
      : `[连续失败] 已经连续 ${times} 次「${ERROR_LABEL[kind]}」。`
    return (
      lead +
      '换脚本名、换扩展名、重写检查脚本都解决不了——错的一直是同一件事。\n' +
      (ws ? `工作目录是 ${ws}，所有相对路径都以它为基准。\n` : '') +
      '请停止重试：① 不要再把脚本写到工作区之外（如 /tmp、F:\\tmp），那不是工作目录；' +
      '② 直接用相对路径操作真实文件（如 index.html）；' +
      '③ 若确实卡住，把当前报错原样告诉用户，不要自己反复试。'
    )
  }

  return {
    observe(result) {
      const kind = classifyToolError(result)
      if (!kind) {
        last = null
        streak = 0
        hinted = false
        return { verdict: 'ok', kind: null, streak: 0, note: '' }
      }
      streak = kind === last ? streak + 1 : 1
      last = kind
      if (streak >= haltAt) {
        return { verdict: 'halt', kind, streak, note: note(kind, streak, true) }
      }
      if (streak >= warnAt && !hinted) {
        hinted = true
        return { verdict: 'hint', kind, streak, note: note(kind, streak, false) }
      }
      return { verdict: 'ok', kind, streak, note: '' }
    },
    reset() {
      last = null
      streak = 0
      hinted = false
    }
  }
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
