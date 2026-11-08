import path from 'node:path'
import type { RiskKind } from '../shared/types'

/**
 * 风险判定与命令拦截。
 *
 * 单独成模块的原因：这里全是纯函数，不碰 electron / fs，能直接跑单测。
 * 之前它藏在 tools/index.ts 里，而那个文件一路 import 到 electron.app，
 * 导致这类最容易出错、最该被测的判断逻辑反而没法测。
 */

export interface RiskInfo {
  kind: RiskKind
  reason: string
  /** 高风险操作（网络/删除/越界/外部工具）：不受「之后全允许」影响，必须单独确认 */
  high: boolean
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
  workspace: string
): RiskInfo | null {
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
