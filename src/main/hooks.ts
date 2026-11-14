/**
 * Hooks：在关键节点跑用户自己的命令。
 *
 * 为什么要有它：程序内置的「写完自动格式化 / 收工前跑验证」只能覆盖通用情况，
 * 真实项目总有自己的规矩 —— 改完 .proto 要重新生成、动 SQL 要先跑一遍迁移检查、
 * 提交前要过一遍公司内部的 lint。这些没法预先写进产品，只能让用户挂脚本。
 *
 * 配置位置（后读的覆盖前面的同名规则，项目优先）：
 *   ~/.roroto/hooks.json        全局
 *   <工作区>/.roroto/hooks.json  项目（随仓库走，团队共享）
 *
 * 文件格式（两种写法都认，事件名大小写/下划线不敏感）：
 *   {
 *     "preToolUse":  [{ "matcher": "write_file|patch", "command": "node .roroto/hooks/gen.js" }],
 *     "postToolUse": [{ "matcher": "*", "command": "npm run lint --silent" }],
 *     "sessionStart": [...], "userPromptSubmit": [...], "preCommit": [...]
 *   }
 *
 * 退出码语义（沿用 Claude Code 的习惯，用户不用再学一套）：
 *   0  = 通过，stdout 作为「补充上下文」追加给模型
 *   2  = 阻断，stderr 就是理由，会原样回给模型（preToolUse / preCommit / userPromptSubmit）
 *   其它 = 不阻断，只把 stderr 当警告记一笔（脚本自己崩了不该让整个任务卡死）
 *
 * 输入：事件 JSON 从 stdin 进来，同时给一组 ROROTO_* 环境变量，脚本二选一即可。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homeDir } from './paths'
import { safeEnv } from './tools/env'
import { loadConfig } from './config'

export type HookEvent =
  | 'sessionStart'
  | 'userPromptSubmit'
  | 'preToolUse'
  | 'postToolUse'
  | 'preCommit'

export interface HookRule {
  event: HookEvent
  /** 工具名匹配：省略或 * = 全部；支持 a|b、逗号分隔、/正则/ */
  matcher?: string
  command: string
  /** 超时后杀掉，默认 15 秒。挂住的钩子比没有钩子更糟 */
  timeoutMs: number
  name?: string
  /**
   * 规则来自哪里。工作区里的 `.roroto/hooks.json` 是随仓库走的 ——
   * 也就是说，克隆一个别人的仓库就等于让仓库作者在本机执行任意命令。
   * 所以工作区规则默认不跑，必须用户在设置里显式打开「信任工作区钩子」。
   */
  from?: 'home' | 'workspace'
}

export interface HookOutcome {
  /** 被阻断时的理由（非空即可直接回给模型） */
  blocked?: string
  /** 追加给模型的上下文（stdout） */
  context?: string
  /** 给人看的提醒（非阻断的失败） */
  warning?: string
  /** 实际跑了几条 */
  ran: number
  /** 因为「工作区钩子未受信任」而被跳过的条数（用来提示用户去哪打开） */
  skippedWorkspace?: number
}

const EVENTS: HookEvent[] = [
  'sessionStart',
  'userPromptSubmit',
  'preToolUse',
  'postToolUse',
  'preCommit'
]

/** 阻断型事件：退出码 2 有意义；postToolUse 已经改完了，阻断没有意义 */
const BLOCKING = new Set<HookEvent>(['preToolUse', 'preCommit', 'userPromptSubmit'])

const DEFAULT_TIMEOUT = 15_000
const MAX_CONTEXT = 8000

/** 事件名归一：PreToolUse / pre_tool_use / pretooluse 都指向同一件事 */
function normalizeEvent(raw: string): HookEvent | null {
  const key = raw.toLowerCase().replace(/[^a-z]/g, '')
  for (const e of EVENTS) {
    if (e.toLowerCase() === key) return e
  }
  return null
}

function configFiles(workspace: string | null): string[] {
  const home = path.join(homeDir(), '.roroto', 'hooks.json')
  if (!workspace) return [home]
  return [home, path.join(workspace, '.roroto', 'hooks.json')]
}

interface CacheEntry {
  mtimeMs: number
  rules: HookRule[]
}

const cache = new Map<string, CacheEntry>()
/** 文件没变就不重复解析；1 秒内的重复调用直接用结果 */
let lastCheck = 0
const CHECK_INTERVAL = 1000

function parseMatcher(raw: unknown): string | undefined {
  const text = String(raw ?? '').trim()
  return text ? text : undefined
}

function parseRule(item: unknown, event: HookEvent): HookRule | null {
  if (typeof item === 'string') {
    // 简写：直接给命令字符串
    return { event, command: item, timeoutMs: DEFAULT_TIMEOUT }
  }
  const obj = (item ?? {}) as Record<string, unknown>
  const command = String(obj.command ?? obj.cmd ?? '').trim()
  if (!command) return null
  const timeout = Number(obj.timeoutMs ?? obj.timeout)
  return {
    event,
    command,
    matcher: parseMatcher(obj.matcher),
    // 上限压到 5 分钟：钩子挂住会把整轮对话一起拖死
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 300_000) : DEFAULT_TIMEOUT,
    name: obj.name ? String(obj.name) : undefined
  }
}

function parseFile(text: string, eventFallback?: HookEvent): HookRule[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (Array.isArray(parsed)) {
    return parsed
      .map((item) => (eventFallback ? parseRule(item, eventFallback) : null))
      .filter((r): r is HookRule => r !== null)
  }
  const root = (parsed ?? {}) as Record<string, unknown>
  // 允许把事件表放在 hooks 字段里（和 Claude Code 的 settings.json 对齐）
  const table = (root.hooks ?? root) as Record<string, unknown>
  const out: HookRule[] = []
  for (const [key, value] of Object.entries(table)) {
    if (!Array.isArray(value)) continue
    const event = normalizeEvent(key)
    if (!event) continue
    for (const item of value) {
      const rule = parseRule(item, event)
      if (rule) out.push(rule)
    }
  }
  return out
}

/** 读两个位置的钩子并合并。文件不存在 = 没配，不是错误 */
export async function loadHooks(workspace: string | null): Promise<HookRule[]> {
  const now = Date.now()
  const files = configFiles(workspace)
  const stale = now - lastCheck > CHECK_INTERVAL
  if (stale) lastCheck = now

  const out: HookRule[] = []
  for (const file of files) {
    let stat: import('node:fs').Stats
    try {
      stat = await fs.stat(file)
    } catch {
      cache.delete(file)
      continue
    }
    const hit = cache.get(file)
    if (hit && hit.mtimeMs === stat.mtimeMs && !stale) {
      out.push(...hit.rules)
      continue
    }
    let text = ''
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    const rules = parseFile(text).map((r) => ({ ...r, from: file === files[0] ? 'home' : 'workspace' } as HookRule))
    cache.set(file, { mtimeMs: stat.mtimeMs, rules })
    out.push(...rules)
  }
  return out
}

export function matcherHit(matcher: string | undefined, tool: string | undefined): boolean {
  if (!matcher || matcher === '*') return true
  const target = tool ?? ''
  // /regex/ 形式
  const re = /^\/(.*)\/([gimsuy]*)$/.exec(matcher)
  if (re) {
    try {
      return new RegExp(re[1], re[2]).test(target)
    } catch {
      return false
    }
  }
  return matcher
    .split(/[|,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .some((s) => s === '*' || s === target)
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function runOne(rule: HookRule, workspace: string | null, payload: unknown): Promise<RunResult> {
  return new Promise((resolve) => {
    const cwd = workspace || homeDir()
    const child = spawn(rule.command, {
      cwd,
      shell: true,
      windowsHide: true,
      /**
       * 环境变量走白名单，和 run_shell 保持一致。
       *
       * 以前是 `{...process.env}`：钩子脚本（尤其是随仓库来的那一份）能直接读到
       * 用户 shell 里的 *_API_KEY / *_TOKEN。工具侧费了半天劲收窄的环境，
       * 从钩子这条路上全漏回去了。
       */
      env: {
        ...safeEnv(),
        ROROTO_HOOK_EVENT: rule.event,
        ROROTO_WORKSPACE: workspace ?? '',
        ROROTO_HOOK_NAME: rule.name ?? ''
      }
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      resolve({ code, stdout, stderr, timedOut })
    }

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        // 已经退出了
      }
      // Windows 上 shell 的子进程不会被 kill 带走，补一刀
      if (process.platform === 'win32' && child.pid) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
        } catch {
          // 忽略
        }
      }
      finish(null)
    }, rule.timeoutMs)

    child.stdout?.on('data', (d: Buffer) => {
      // 上限保护：钩子往 stdout 打日志时不能把上下文撑爆
      if (stdout.length < MAX_CONTEXT * 2) stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_CONTEXT) stderr += d.toString('utf8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      stderr += (err as Error).message
      finish(-1)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(code)
    })

    try {
      child.stdin?.end(JSON.stringify(payload ?? {}))
    } catch {
      // 脚本不读 stdin 也无所谓
    }
  })
}

export interface HookInput {
  workspace: string | null
  sessionId?: string | null
  tool?: string
  args?: Record<string, unknown>
  /** userPromptSubmit 的原话；postToolUse 的工具输出 */
  text?: string
  result?: string
  agentId?: string | null
}

function clipped(text: string): string {
  const t = text.trim()
  return t.length > MAX_CONTEXT ? `${t.slice(0, MAX_CONTEXT)}\n…（钩子输出已截断）` : t
}

/**
 * 跑某个事件的所有钩子。串行执行：钩子之间常常有先后依赖
 * （先生成代码再格式化），并行会让顺序不可预期。
 */
export async function runHooks(event: HookEvent, input: HookInput): Promise<HookOutcome> {
  // 测试与「钩子自己又调起一份 agent」时用来断开递归
  if (process.env.ROROTO_NO_HOOKS === '1') return { ran: 0 }

  const matched = (await loadHooks(input.workspace)).filter(
    (r) => r.event === event && matcherHit(r.matcher, input.tool)
  )
  /**
   * 工作区钩子必须显式信任过才跑。
   *
   * 这是唯一一条「打开一个仓库就会执行代码」的路径：`.roroto/hooks.json` 随仓库走，
   * 克隆下来点开就中招。工具本身都要过审批，钩子却不用 —— 所以默认关掉，
   * 由用户在「软件设置 → 审批与执行」里打开。~/.roroto 那份是用户自己写的，不受影响。
   */
  const trustWorkspace = (await loadConfig().catch(() => null))?.trustWorkspaceHooks === true
  const rules = trustWorkspace ? matched : matched.filter((r) => r.from !== 'workspace')
  const skippedWorkspace = matched.length - rules.length
  if (rules.length === 0) {
    return skippedWorkspace > 0 ? { ran: 0, skippedWorkspace } : { ran: 0 }
  }

  const payload = {
    event,
    tool: input.tool,
    args: input.args,
    text: input.text,
    result: input.result,
    sessionId: input.sessionId ?? null,
    agentId: input.agentId ?? null,
    workspace: input.workspace,
    cwd: input.workspace || homeDir(),
    at: new Date().toISOString()
  }

  const contexts: string[] = []
  const warnings: string[] = []
  let blocked: string | undefined

  for (const rule of rules) {
    const r = await runOne(rule, input.workspace, payload)
    const label = rule.name || rule.command.slice(0, 40)

    if (r.timedOut) {
      warnings.push(`钩子「${label}」超过 ${Math.round(rule.timeoutMs / 1000)} 秒，已终止`)
      continue
    }
    if (r.code === 2 && BLOCKING.has(event)) {
      blocked = clipped(r.stderr) || `钩子「${label}」阻断了这次操作，但没有给出原因`
      // 一条阻断就够：后面的钩子没必要再跑
      break
    }
    if (r.code !== 0 && r.code !== null) {
      warnings.push(`钩子「${label}」退出码 ${r.code}：${clipped(r.stderr).split('\n')[0] || '无输出'}`)
      continue
    }
    const out = clipped(r.stdout)
    if (out) contexts.push(rule.name ? `【${rule.name}】\n${out}` : out)
  }

  return {
    blocked,
    context: contexts.length ? contexts.join('\n\n') : undefined,
    warning: warnings.length ? warnings.join('；') : undefined,
    ran: rules.length,
    ...(skippedWorkspace > 0 ? { skippedWorkspace } : {})
  }
}

/** 给设置页/自检用：当前工作区到底挂了哪些钩子 */
export async function describeHooks(workspace: string | null): Promise<{
  files: string[]
  rules: Array<HookRule & { exists: boolean }>
}> {
  const files = configFiles(workspace)
  const rules = await loadHooks(workspace)
  const present: string[] = []
  for (const f of files) {
    try {
      await fs.access(f)
      present.push(f)
    } catch {
      // 不存在
    }
  }
  return { files: present, rules: rules.map((r) => ({ ...r, exists: true })) }
}

/** 测试用：清掉解析缓存，逼下一次重新读盘 */
export function forgetHookCache(): void {
  cache.clear()
  lastCheck = 0
}
