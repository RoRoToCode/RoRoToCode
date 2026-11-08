import path from 'node:path'
import type { PermissionRule, RiskKind } from '../shared/types'

/**
 * 风险判定与命令拦截。
 *
 * 单独成模块的原因：这里全是纯函数，不碰 electron / fs，能直接跑单测。
 * 之前它藏在 tools/index.ts 里，而那个文件一路 import 到 electron.app，
 * 导致这类最容易出错、最该被测的判断逻辑反而没法测。
 */

export type { PermissionRule }

export interface RiskInfo {
  kind: RiskKind
  reason: string
  /** 高风险操作（网络/删除/越界/外部工具）：不受「之后全允许」影响，必须单独确认 */
  high: boolean
  /** 被项目规则明确拒绝：decideApproval 直接 deny，不弹确认框 */
  denied?: boolean
}

/** 把通配符规则转成正则：* → .*，其余转义 */
function globToRe(glob: string): RegExp {
  let out = ''
  for (const ch of glob) {
    if (ch === '*') out += '.*'
    else if (ch === '?') out += '.'
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/** 轻量命令分词：把命令切成「可执行词 + 参数」，供规则按命令名或完整串匹配 */
export function tokenizeCommand(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (const c of command) {
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c as '"' | "'"
      continue
    }
    if (/\s/.test(c)) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
      continue
    }
    if (c === ';' || c === '|' || c === '&' || c === '>' || c === '<') {
      if (cur) out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

/**
 * 从工具参数里提取「资源」候选串，供规则匹配。
 * 返回一个数组：规则只要命中其中任意一个即算命中。
 * - run_shell：完整命令串 + 分词后的第一个可执行词（这样能按 `npm`、`rm` 之类命令名匹配）；
 * - 文件工具：单个路径；
 * - patch：逐条 edit 的 path / new_path；
 * - 其它：空数组（不参与资源匹配，只有 resource 为 '*' 的规则能命中）。
 */
export function resourceCandidates(tool: string, args: Record<string, unknown>): string[] {
  if (tool === 'run_shell') {
    const cmd = String(args.command ?? '')
    const tokens = tokenizeCommand(cmd)
    return tokens.length ? [cmd, tokens[0]] : [cmd]
  }
  if (tool === 'write_file' || tool === 'edit_file' || tool === 'read_file' || tool === 'list_dir' || tool === 'grep') {
    return [String(args.path ?? '')]
  }
  if (tool === 'patch') {
    const out: string[] = []
    if (Array.isArray(args.edits)) {
      for (const e of args.edits as Array<{ path?: unknown; new_path?: unknown }>) {
        if (e?.path != null) out.push(String(e.path))
        if (e?.new_path != null) out.push(String(e.new_path))
      }
    }
    return out
  }
  return []
}

/** 应用用户规则：返回 'allow' | 'deny' | null（null = 不命中，走内置判定） */
export function applyCustomRules(
  tool: string,
  args: Record<string, unknown>,
  rules: PermissionRule[] | undefined
): 'allow' | 'deny' | null {
  if (!rules || rules.length === 0) return null
  const resources = resourceCandidates(tool, args)

  let result: 'allow' | 'deny' | null = null
  for (const rule of rules) {
    const actionMatch = rule.action === '*' || rule.action === tool
    if (!actionMatch) continue
    // resource 通配：* 匹配所有；否则只要命中任一候选资源即可
    const resMatch =
      rule.resource === '*' ||
      resources.some((r) => {
        // 命令串也尝试前缀匹配：规则写 `npm test*` 能命中 `npm test --watch`
        return globToRe(rule.resource).test(r) || r.startsWith(rule.resource.replace(/\*$/, ''))
      })
    if (!resMatch) continue
    result = rule.effect
  }
  return result
}

// 访问网络的命令特征
const NETWORK_RE =
  /(\bcurl\b|\bwget\b|\biwr\b|\birm\b|\bInvoke-WebRequest\b|\bInvoke-RestMethod\b|\bftp\b|\bscp\b|\bssh\b|\btelnet\b|\bping\b|https?:\/\/|git\s+(clone|fetch|pull|push|remote)|npm\s+(install|i|publish)|pnpm\s+(add|install)|yarn\s+(add|install)|pip\s+install|docker\s+(pull|push)|winget\s+install|choco\s+install)/i

// 删除文件的命令特征
const DELETE_RE =
  /(\brm\b|\brmdir\b|\bdel\b|\berase\b|\brd\b|\bRemove-Item\b|\bgit\s+clean\b|\bgit\s+reset\s+--hard\b|shutil\.rmtree|\btruncate\b)/i

// 纯读取命令（只读模式下允许执行）
const READONLY_RE =
  /^\s*(date|time|echo|dir|type|cd|pwd|whoami|hostname|ver|systeminfo|ipconfig|tasklist|where|which|node\s+-v|npm\s+-v|git\s+(status|log|diff|show|branch|remote|--version)|python\s+--version)\b/i

// 命令串联 / 重定向，出现时不再视为纯读取
const CHAIN_RE = /(&&|\|\||[;|<>])/

/**
 * 不可逆、几乎不可能出现在正常开发流程里的命令：直接拒绝，连确认框都不弹。
 * 这里刻意只收极少数几条 —— 黑名单越长越容易被绕过，也越容易误伤，
 * 真正的防线是「高危操作强制确认」，不是这个列表。
 */
const HARD_BLOCK: Array<{ re: RegExp; why: string }> = [
  { re: /(^|[\s;&|])format(\.com)?\s+[a-z]:/i, why: '格式化磁盘' },
  { re: /\bdiskpart\b/i, why: '磁盘分区操作' },
  { re: /\bbcdedit\b/i, why: '修改启动配置' },
  { re: /(^|[\s;&|])shutdown\b/i, why: '关机 / 重启系统' },
  { re: /\breg(\.exe)?\s+delete\b/i, why: '删除注册表项' },
  { re: /\bvssadmin\s+delete\b/i, why: '删除卷影副本' },
  { re: /\bcipher(\.exe)?\s+\/w/i, why: '擦除磁盘空闲空间' },
  { re: /rm\s+-[a-z]*[rf][a-z]*\s+(\/|~|\/\*|\.\s*$|[a-z]:[\\/]\s*$)/i, why: '删除根目录或用户目录' },
  { re: /\bgit\s+push\s+.*--force\b/i, why: '强制推送远端仓库' },
  { re: /\bgit\s+clean\s+-[a-z]*[xdf]/i, why: '清空未跟踪文件' }
]

/** 命中则返回拒绝理由，否则 null */
export function hardBlockReason(command: string): string | null {
  for (const rule of HARD_BLOCK) {
    if (rule.re.test(command)) return rule.why
  }
  return null
}

/** 对删除/移动类命令里出现的路径做提取，用来判断是否越界（正则黑名单永远会漏） */
const PATH_CMDS: Array<{ re: RegExp; group: number }> = [
  { re: /\b(?:rm|del|erase|rd|rmdir)\s+(?:-[a-z]+\s+)*([^\s;&|]+(?:\s+[^\s;&|]+)*)/i, group: 1 },
  { re: /\b(?:Remove-Item)\s+(?:-[A-Za-z]+\s+\S+\s+)*([^\s;&|]+)/i, group: 1 }
]

/** 按 shell 习惯切参数：引号内的空格算路径的一部分，遇到 && / | 就停 */
function splitArgs(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (const c of input) {
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c as '"' | "'"
      continue
    }
    if (/\s/.test(c)) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
      continue
    }
    // 后面是另一条命令，不再往这条命令的路径里算
    if (c === ';' || c === '|' || c === '&') break
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

export function commandPaths(command: string): string[] {
  const out: string[] = []
  for (const { re, group } of PATH_CMDS) {
    const m = command.match(re)
    if (!m) continue
    for (const p of splitArgs(m[group])) {
      // 去掉 -rf / /s 这类开关，剩下的才是路径
      if (!p || p.startsWith('-')) continue
      out.push(p)
    }
  }
  return out
}

export function isOutside(root: string, p: string): boolean {
  if (!p) return false
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p)
  const rel = path.relative(root, abs)
  return rel.startsWith('..') || path.isAbsolute(rel)
}

/** 判断一次工具调用是否需要用户确认，以及风险类别 */
export function classifyRisk(
  tool: string,
  args: Record<string, unknown>,
  workspace: string,
  rules?: PermissionRule[]
): RiskInfo | null {
  // 用户项目规则优先：deny 直接拒绝（不可被「之后全允许」覆盖）。
  // allow 的语义是「明确信任这条原本需要确认的普通操作」：它只放行非高危操作
  // （普通命令、普通写文件），删除/越界/网络等内置高危仍按原判定走，HARD_BLOCK 更是永远不可绕过。
  const custom = applyCustomRules(tool, args, rules)
  if (custom === 'deny') {
    return { kind: 'shell', reason: '被项目规则拒绝', high: true, denied: true }
  }
  if (tool === 'run_shell') {
    const cmd = String(args.command ?? '')
    // 删除类优先：即使命令里还包含网络或只读片段，也按最重的判
    if (DELETE_RE.test(cmd)) {
      // 删除命令里带了工作区之外的绝对路径，风险再升一级
      const outside = commandPaths(cmd).find((p) => path.isAbsolute(p) && isOutside(workspace, p))
      if (outside) {
        return { kind: 'outside', reason: `删除工作区之外的路径 ${outside}`, high: true }
      }
      return { kind: 'delete', reason: '删除文件或目录', high: true }
    }
    if (NETWORK_RE.test(cmd)) return { kind: 'network', reason: '访问网络 / 下载依赖', high: true }
    // 纯读取命令（无串联/重定向）不算风险，只读模式也允许
    if (READONLY_RE.test(cmd) && !CHAIN_RE.test(cmd)) return null
    // 普通命令：若被 allow 显式信任则放行，否则按普通命令确认
    if (custom === 'allow') return null
    return { kind: 'shell', reason: '执行命令', high: false }
  }
  if (tool === 'shell_bg') {
    const action = String(args.action ?? 'log')
    // 读日志是纯读取；结束进程算普通命令级风险
    if (action === 'kill') return { kind: 'shell', reason: '结束后台命令', high: false }
    return null
  }
  if (tool === 'write_file' || tool === 'edit_file') {
    const p = String(args.path ?? '')
    if (isOutside(workspace, p)) return { kind: 'outside', reason: '写入工作区之外的文件', high: true }
    // 普通写文件：allow 显式信任则放行
    if (custom === 'allow') return null
    return { kind: 'write', reason: '修改文件', high: false }
  }
  if (tool === 'patch') {
    // 多文件改动：只要有任一路径越界，就整体判为越界（高风险，必须单独确认）
    const edits = Array.isArray(args.edits) ? (args.edits as Array<{ path?: unknown; new_path?: unknown }>) : []
    for (const e of edits) {
      const p = String(e?.path ?? '')
      if (isOutside(workspace, p)) return { kind: 'outside', reason: `写入工作区之外的文件 ${p}`, high: true }
      if (e?.new_path != null && isOutside(workspace, String(e.new_path))) {
        return { kind: 'outside', reason: `移动目标在工作区之外 ${String(e.new_path)}`, high: true }
      }
    }
    // 普通多文件写：allow 显式信任则放行
    if (custom === 'allow') return null
    return { kind: 'write', reason: '修改文件', high: false }
  }
  if (tool === 'read_file' || tool === 'list_dir' || tool === 'grep') {
    const p = String(args.path ?? '.')
    if (isOutside(workspace, p)) return { kind: 'outside', reason: '访问工作区之外的内容', high: true }
    return null
  }
  // 联网工具只发 GET、不改本机文件，算只读；抓取历史里也会留卡片，用户可随时取消
  if (tool === 'web_search' || tool === 'web_fetch' || tool === 'update_todos' || tool === 'remember') {
    return null
  }
  return null
}

/**
 * 外部 MCP 工具的风险判定：默认都算高危（需要确认），但项目规则可以明确 deny。
 * 规则匹配时 resource 用 MCP 工具的完整名（mcp__服务__工具名）。
 */
export function classifyMcpRisk(toolName: string, rules?: PermissionRule[]): RiskInfo | null {
  const custom = applyCustomRules(toolName, {}, rules)
  if (custom === 'deny') {
    return { kind: 'shell', reason: '被项目规则拒绝', high: true, denied: true }
  }
  return { kind: 'shell', reason: `调用外部 MCP 工具 ${toolName}`, high: true }
}
