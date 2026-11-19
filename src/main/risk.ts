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
  if (tool === 'git' || tool === 'format') {
    return Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : []
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

/**
 * 从命令里提取「要连到哪个主机」的提示，供审批弹窗展示。
 *
 * 这不是安全边界（正则永远猜不干净，真正的防线仍是「网络命令强制单独确认」），
 * 只是让用户在点「允许」前能一眼看到目标：一条裸的 `curl xxx` 和 `curl api.example.com`
 * 给人的警觉度完全不同。提取不到（比如 `npm install` 这种没有显式主机的）就返回空串。
 *
 * 覆盖两类：
 *  - 显式 URL（https?://、git@、scp/ssh 的 host、curl 的裸域名）；
 *  - 包管理器/远程命令里的仓库前缀（`git clone https://github.com/...` 已经命中 URL，
 *    但 `pip install -i https://...`、`npm --registry=...` 也值得抓）。
 */
export function networkTargetHint(command: string): string {
  const cmd = String(command ?? '')
  const found = new Set<string>()
  // 显式 URL：https?://host(:port)/。带 user:pass@ 时去掉前面那截，只留主机
  for (const m of cmd.matchAll(/https?:\/\/([^\s"'`<>\\/]+)/gi)) {
    const h = m[1].replace(/^[^@]*@/, '').replace(/:(\d+)$/, '')
    if (h && !/^\d+$/.test(h)) found.add(h)
  }
  for (const m of cmd.matchAll(/(?:git|ssh|scp|rsync)@([^\s"'`<>\\/:]+)/gi)) found.add(m[1])
  // ssh/scp/rsync 的目标主机：`ssh user@host`（可无命令）、`scp a b host:path`
  const ssh = /\b(?:ssh|scp|rsync)\b[^;&|]*?(?:@([a-zA-Z0-9.-]+)|([a-zA-Z0-9.-]+):[^\s"'`]+)/.exec(cmd)
  if (ssh) {
    const host = ssh[1] ?? ssh[2]
    if (host && !/^(http|https)$/i.test(host)) found.add(host)
  }
  // 包管理器里的镜像/源：--registry= 后面跟 URL 时已在上面抓到，这里补 host 裸写
  const reg = /--registry\s*=\s*https?:\/\/([^\s"'`<>\\/]+)/i.exec(cmd)
  if (reg) found.add(reg[1].replace(/:(\d+)$/, ''))

  const hosts = [...found].slice(0, 3)
  return hosts.length ? hosts.join('、') : ''
}

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

/**
 * 从任意命令里提取「看起来是绝对路径」的片段，供越界判定。
 *
 * 为什么这里比 commandPaths 更宽：删除/移动命令有专门的提取逻辑（它们只对
 * 路径型命令负责），但一条普通命令也能动到工作区之外 —— `copy C:\secret.txt D:\out\`、
 * `type C:\Users\admin\id_rsa`、`python C:\outside\script.py`。这些以前都只判
 * `high:false`（普通确认），和「写文件工具越界会判高危」完全不一致。
 *
 * 判据只认「明确的盘符绝对路径」（C:\... / C:/...）和 UNC（\\host\...），
 * 不认 POSIX 根风格（/tmp/x）——那类按 resolveToolPath 的约定算工作区内相对路径。
 */
function absolutePathFragments(command: string): string[] {
  const out: string[] = []
  // C:\... 或 C:/...（Windows 盘符），以及 \\host\share（UNC）
  const re = /(?:[A-Za-z]:[\\/][^\s"'`;&|<>]*|\\\\(?:[^\s"'`;&|<>]+)\\(?:[^\s"'`;&|<>]*))/g
  for (const m of command.matchAll(re)) {
    const p = m[0]
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

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

/**
 * POSIX 根目录风格的伪绝对路径：`/tmp/x`、`/var/y`、或反斜杠写法 `\tmp\x`。
 *
 * Windows 的 `path.isAbsolute('/tmp/check.py')` 返回 **true**，于是 `path.resolve`
 * 把它接到「当前盘符的根」——进程在 F 盘启动就变成 `F:\tmp\check.py`。模型（尤其
 * 本地小模型）写临时脚本时极易带出这种 Linux 习惯，结果脚本落在工作区外，读取
 * 工作区内的文件时全线 ENOENT，还会反向误导它「工作区是 F:\tmp」。
 *
 * 判据：以 `/` 或 `\` 开头，但不是 Windows 盘符（`C:\...`）也不是 UNC（`\\host\...`）。
 * 这类一律按「相对工作区」处理，把前导斜杠去掉后接到 root 下。
 */
function isPosixRootStyle(raw: string): boolean {
  if (!/^[\\/]/.test(raw)) return false
  // C:\... / C:/...：盘符路径，保持原样
  if (/^[A-Za-z]:[\\/]/.test(raw)) return false
  // \\host\share：UNC，保持原样
  if (/^[\\/]{2}/.test(raw)) return false
  return true
}

/** 把工具参数里的路径解析成绝对路径；POSIX 根风格按相对工作区处理 */
export function resolveToolPath(root: string, p: string): string {
  let raw = String(p ?? '').trim()
  if (isPosixRootStyle(raw)) raw = raw.replace(/^[\\/]+/, '')
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw)
}

export function isOutside(root: string, p: string): boolean {
  if (!p) return false
  const abs = resolveToolPath(root, p)
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
    if (NETWORK_RE.test(cmd)) {
      const host = networkTargetHint(cmd)
      return {
        kind: 'network',
        reason: host ? `访问网络 / 下载依赖 · 目标主机：${host}` : '访问网络 / 下载依赖',
        high: true
      }
    }
    // 路径越界：命令里出现了指向工作区之外的明确绝对路径（盘符/UNC）。
    // 与写文件工具的 isOutside 检查对齐 —— 读写工作区外文件都该单独确认，
    // 否则「沙箱」对 run_shell 形同虚设（copy / move / type / python 都能越界）。
    // 放在纯读取判断之前：`type C:\Users\...\id_rsa` 这种读工作区外文件的命令，
    // 只读≠安全，仍要单独确认。
    const outsidePath = absolutePathFragments(cmd).find((p) => isOutside(workspace, p))
    if (outsidePath) {
      return { kind: 'outside', reason: `命令访问了工作区之外的路径 ${outsidePath}`, high: true }
    }
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
  if (tool === 'read_file' || tool === 'list_dir' || tool === 'grep' || tool === 'goto_definition' || tool === 'find_references' || tool === 'repo_map') {
    const p = String(args.path ?? '.')
    if (isOutside(workspace, p)) return { kind: 'outside', reason: '访问工作区之外的内容', high: true }
    return null
  }
  if (tool === 'terminal') {
    const action = String(args.action ?? '')
    // open 是这次交互的唯一同意点：终端里后续输入不会逐条弹窗（否则没法用），
    // 所以开终端本身必须让人看到一次。read/list/close 无副作用。
    if (action === 'open') {
      return { kind: 'shell', reason: '打开交互式终端（终端内输入的命令不再逐条确认）', high: true }
    }
    if (action === 'write') return { kind: 'shell', reason: '向终端发送输入', high: false }
    return null
  }
  if (tool === 'git') {
    const action = String(args.action ?? '')
    if (action === 'push' || action === 'pull' || action === 'pr') {
      return { kind: 'network', reason: `git ${action} 需要访问网络`, high: true }
    }
    if (action === 'status' || action === 'diff' || action === 'log' || action === 'branches') return null
    if (action === 'undo') return { kind: 'write', reason: '撤销最近提交（soft，改动保留）', high: false }
    if (custom === 'allow') return null
    return { kind: 'write', reason: `git ${action} 修改仓库`, high: false }
  }
  if (tool === 'format') {
    const paths = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : []
    for (const p of paths) {
      if (isOutside(workspace, p)) {
        return { kind: 'outside', reason: `格式化工作区之外的文件 ${p}`, high: true }
      }
    }
    if (custom === 'allow') return null
    return { kind: 'write', reason: '格式化文件', high: false }
  }
  // 联网工具只发 GET、不改本机文件，算只读；抓取历史里也会留卡片，用户可随时取消
  // board / scratch 只写 userData 下的一页便签，不碰工作区文件
  // task 只是起子 agent，它调的每个工具各自还要过一遍这里
  // handoff / question / use_skill / write_plan 都只改本程序的会话数据，不碰工作区
  if (
    tool === 'web_search' ||
    tool === 'web_fetch' ||
    tool === 'update_todos' ||
    tool === 'remember' ||
    tool === 'board' ||
    tool === 'scratch' ||
    tool === 'task' ||
    tool === 'handoff' ||
    tool === 'question' ||
    tool === 'use_skill' ||
    tool === 'write_plan'
  ) {
    return null
  }
  /**
   * 没登记过的工具一律按高危处理。
   *
   * 这里以前是 `return null`（默认放行）：新加一个工具、忘了在上面补风险判定，
   * 它就会绕过审批直接执行 —— 而这种遗漏是静默的，谁也不会发现。
   * 默认收紧之后，漏登记的代价只是多弹一次确认框，而不是「悄悄执行了」。
   */
  return { kind: 'shell', reason: `未登记风险等级的工具 ${tool}`, high: true }
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
