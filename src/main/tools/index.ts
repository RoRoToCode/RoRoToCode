import { promises as fs, readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ToolSpec } from './spec'
import { toolSpecs } from './spec'
import { rememberFact } from '../memory'
import { addBoardNote } from '../board'
import { clearScratch, readScratch, writeScratch } from '../scratch'
import { SECTION_LABEL, type BoardSection } from '../../shared/board'
import { formatTodos, normalizeTodos } from '../../shared/todos'
import { webFetchTool, webSearchTool } from './web'
import { defaultShellKind, isWin, killTree, shellArgs, shellBin, shellNeedsVerbatim } from '../platform'
import { parseApplyPatch } from './applypatch'
import { gotoDefinition, findReferences } from '../lsp'
import { relPath } from '../lsp/types'
import { formatFiles, lintFiles } from '../format'
import { gitAction } from '../git'
import { closeTerminal, listTerminals, openTerminal, readTerminal, writeTerminal } from '../terminal'
import { runHooks } from '../hooks'
import { clipSafe } from '../../shared/text'
import { applyEdit, type EditSuccess } from '../../shared/editmatch'
import { checkEditable, rememberRead, rememberWritten, unreadOverwriteNote } from '../filestate'
import { buildIndex, loadIndex, renderMap } from '../repoindex'
import { semanticMap } from '../embed'
import { saveSessionPlan } from '../store'
import { readSkillBody } from '../skills'
import { HEALED_ARGS } from '../../shared/toolargs'
import { detectShellWrite, shellWriteRefusal } from '../shellguard'
import { isImagePath } from '../../shared/vision'
import { listSnapshots, rollbackSnapshot } from '../snapshot'

const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'target',
  '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'coverage', '.cache', '.turbo'
])

const MAX_READ = 40000
const MAX_OUTPUT = 20000
const MAX_GREP_MATCHES = 200
const MAX_FILES = 20000

/**
 * 单次写入的字符上限。
 *
 * 依据是本机的输出预算（providers/budget.ts: DEFAULT_OUTPUT_TOKENS = 8192）：
 * 代码大约 3-4 字符/token，中英混排的 HTML 只有 1.5-2 字符/token，16000 字符
 * 已经贴着天花板。再往上就是**必然**截断 —— 而截断的后果不是「少写一点」，
 * 是整份文件变残片、模型再整份重写一遍，然后在新一轮里继续被截断。
 * 实测就是这么烧掉 6 万 token 只换来 693 字节的。
 *
 * 所以这里不放行：宁可当场拒绝并教它分段，也不让它把大文件一次性吐出去。
 */
export const MAX_SINGLE_WRITE_CHARS = 16000

/** 超限时给模型的说明：必须包含「为什么」和「具体怎么分」两件事，否则它只会原样重试 */
function oversizeWriteMessage(chars: number, rel: string, append: boolean): string {
  const name = rel.split(path.sep).join('/')
  return (
    `这次要写 ${chars} 字符，超过单次写入上限 ${MAX_SINGLE_WRITE_CHARS} 字符，已拒绝执行（文件没有被修改）。\n` +
    '原因：一次输出这么多内容必定被输出上限切断在半句，写下去文件就是残片，然后你只能整份重写 —— 反复重写就是这么来的。\n' +
    '改成分段写，一次只放一段（先骨架、后填肉）：\n' +
    `  1) write_file({path:"${name}", content:"<第一段骨架>"})            // 第一段不超过 ${MAX_SINGLE_WRITE_CHARS} 字符\n` +
    `  2) write_file({path:"${name}", append:true, content:"<第二段>"}) // 往后接，需要几段就写几次\n` +
    `  3) 收尾用 edit_file 补最后几行（闭合标签、结束括号）\n` +
    (append
      ? '注意：append 模式下每段也要同样分段，别把整份文件塞进一次追加。\n'
      : '') +
    '切段位置按「结构 / 样式 / 逻辑」这种天然边界切，不要切在字符串、注释或函数中间。'
  )
}

export interface ToolContext {
  workspace: string
  signal: AbortSignal
  /** 用户已批准“工作区之外”的操作时置为 true，放行路径越界检查 */
  allowOutside?: boolean
  /** 当前会话属于哪个 agent 档案：remember 要写进它自己那份记忆 */
  agentId?: string | null
  /** 当前会话 ID：会话级便签（scratch）按它落盘 */
  sessionId?: string | null
  /**
   * 本轮没有直接下发的工具（上下文紧张时的工具网关）。
   * agent.ts 会在执行前把「带 tool 参数的 toolbox 调用」展开成真工具，
   * 走到这里的只有两种情况：不带参数（要清单）、或者要了一个不存在的名字。
   */
  hiddenTools?: Array<{ name: string; description: string }>
  /**
   * 单次 read_file 的字符上限，由 agent.ts 按当前上下文窗口折算后传进来。
   * 写死 40000 在 16K 窗口的本地模型上一次就能把历史挤空。
   */
  readCap?: number
  /**
   * 把活交给另一个档案。由 agent.ts 注入 —— 它知道当前会话、当前档案和审批策略；
   * 没有别的档案可交给时不注入，这个工具也就不会出现在工具表里。
   */
  handoff?: (req: {
    to: string
    task: string
    context?: string
    files?: string[]
  }) => Promise<string>
}

// 风险判定与命令拦截都在 risk.ts（纯函数，可单测），这里只做转出，保持既有 import 路径不变
export { classifyRisk, classifyMcpRisk, hardBlockReason, isOutside, resolveToolPath, applyCustomRules, tokenizeCommand, resourceCandidates, type RiskInfo, type PermissionRule } from '../risk'
import { hardBlockReason, resolveToolPath } from '../risk'
import { safeEnv } from './env'
import { getJob, killJob, listJobs, startBackground, tailLog } from './shellbg'

export function isDangerous(tool: string): boolean {
  return (
    tool === 'write_file' ||
    tool === 'edit_file' ||
    tool === 'patch' ||
    tool === 'run_shell' ||
    tool === 'terminal' ||
    tool === 'git' ||
    tool === 'format'
  )
}

export function summarize(tool: string, args: Record<string, unknown>): string {
  if (tool === 'run_shell') return String(args.command ?? '')
  if (tool === 'terminal') {
    const action = String(args.action ?? '')
    return action === 'write' ? `终端输入 ${String(args.data ?? '').slice(0, 60)}` : `终端 ${action}`
  }
  if (tool === 'git') {
    const action = String(args.action ?? '')
    return `git ${action}${args.branch ? ` ${String(args.branch)}` : ''}${args.message ? `：${String(args.message).slice(0, 50)}` : ''}`
  }
  if (tool === 'format') return `${Array.isArray(args.paths) ? args.paths.length : 0} 个文件`
  if (tool === 'write_file' || tool === 'edit_file') return String(args.path ?? '')
  if (tool === 'patch') {
    const edits = Array.isArray(args.edits) ? args.edits.length : 0
    const fromText = typeof args.patch === 'string' && args.patch.trim() ? 'patch 文本' : ''
    return edits > 0 ? `patch ${edits} 处改动` : fromText || 'patch'
  }
  if (tool === 'web_fetch') return String(args.url ?? '')
  if (tool === 'web_search') return String(args.query ?? '')
  if (tool === 'remember') return String(args.note ?? '').slice(0, 120)
  if (tool === 'use_skill') return String(args.name ?? '')
  if (tool === 'board') return `[${String(args.section ?? 'fact')}] ${String(args.note ?? '')}`.slice(0, 120)
  if (tool === 'handoff') return `${String(args.to ?? '')}：${String(args.task ?? '').slice(0, 80)}`
  if (tool === 'update_todos') return `${normalizeTodos(args.items).length} 项`
  return JSON.stringify(args).slice(0, 160)
}

function safePath(root: string, p: string, allowOutside = false): string {
  const abs = resolveToolPath(root, String(p || '.'))
  const rel = path.relative(root, abs)
  if (!allowOutside && (rel.startsWith('..') || path.isAbsolute(rel))) {
    throw new Error(`路径超出工作区范围，已拒绝：${p}`)
  }
  return abs
}

function globToRegExp(glob: string): RegExp {
  let out = ''
  const src = glob.replace(/\\/g, '/')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '*') {
      if (src[i + 1] === '*') {
        if (src[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += `\\${c}`
    } else {
      out += c
    }
  }
  return new RegExp(`^${out}$`, 'i')
}

async function walkFiles(root: string, dir = root, acc: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 12 || acc.length >= MAX_FILES) return acc
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    if (acc.length >= MAX_FILES) break
    if (entry.name.startsWith('.') && entry.name !== '.env') continue
    if (IGNORED.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkFiles(root, full, acc, depth + 1)
    } else if (entry.isFile()) {
      acc.push(full)
    }
  }
  return acc
}

/**
 * 读文件被截断时的指引，已经并入 readFileTool 的行号输出尾巴。
 * 以前这里只说「内容过长已截断」，模型不知道怎样接着读，于是绕道写
 * dump.py / gs.py 这类一次性脚本把文件切块打印 —— 一个任务能刷出十几个脚本。
 */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/**
 * 「读过了、内容没变」的短路表。
 *
 * 实测里一个 437 行的 ui.py 被反复整份读取注入，单场会话 prompt 到 308 万。
 * 缓存让重复前缀不花钱，但上下文窗口是白占的 —— 窗口一满就要压缩历史，压缩就会丢细节。
 * 所以同一份内容只在上一次「完整返回」之后的一次重复读取上短路，且只短路一次：
 *   读全文 → 再读（只给一句提示）→ 还想读就必须是全量内容。
 * 只短路一次是刻意的：模型如果真的要逐行核对，第三次必须拿得到原文，
 * 否则 edit_file 的 old_string 就只能靠记忆拼。
 */
interface ReadMemo {
  /** mtime + size：文件被改过就失效，不需要读内容算哈希 */
  sig: string
  offset: number
  limit: number
  lines: number
  chars: number
  /** 已经用提示打发过几次（最多 1 次） */
  repeats: number
}
const readMemo = new Map<string, ReadMemo>()
const READ_MEMO_MAX = 300
/** 小文件不做去重：省下的 token 还没提示本身长，反而多一次困惑 */
const READ_MEMO_MIN_CHARS = 4000

function memoKeyOf(abs: string): string {
  const p = path.resolve(abs)
  return process.platform === 'win32' ? p.toLowerCase() : p
}

async function readFileTool(
  root: string,
  args: Record<string, unknown>,
  allowOutside = false,
  capChars = MAX_READ
): Promise<string> {
  const given = String(args.path ?? '')
  const target = safePath(root, given, allowOutside)
  let stat
  try {
    stat = await fs.stat(target)
  } catch {
    // 路径写错时只抛 ENOENT，模型只会换个错路径再试。把「工作区里有哪些相近文件」
    // 直接告诉它，一次就能改对。
    throw new Error(await notFoundHint(root, target, given))
  }
  if (stat.isDirectory()) throw new Error('目标是目录，请用 list_dir')
  /**
   * 图片不走文本读取：PNG/JPG 是二进制，照旧逻辑会落到下面的「二进制拒绝」。
   * 但「打开验收」的截图就靠这一步看画面（webcheck 落盘的 .roroto/shots/*.png），
   * 让模型 read_file 够到却被告知「拒绝读取」，视觉闭环在这里断了。
   * 所以图片单独返回一个标记，上层 agent 据它把画面作为图片消息喂给视觉模型。
   */
  if (isImagePath(target)) return `【图片】${given} 是一张图片，画面已经随这条结果一并传给你了（不是路径，你看得见）。直接描述你看到的内容。`

  const offset = Math.max(1, Number(args.offset ?? 1) || 1)
  const limit = Number(args.limit ?? 0)

  /**
   * 上一次已经把这段内容原样返回过、文件也没变 → 只回一句提示，连文件都不读。
   * 判据用 mtime+size，不读内容算哈希：本来就 stat 过了，零额外成本。
   * force:true 直接跳过 —— 模型说「我就想再看一遍」时必须给得到。
   */
  const key = memoKeyOf(target)
  const sig = `${Math.floor(stat.mtimeMs)}:${stat.size}`
  const memo = readMemo.get(key)
  if (
    args.force !== true &&
    memo &&
    memo.sig === sig &&
    memo.offset === offset &&
    memo.limit === limit &&
    memo.repeats < 1
  ) {
    memo.repeats += 1
    // 仍然算「读过」：否则 edit_file 会以「没读过原文」把它拦住
    rememberRead(target, stat)
    return (
      `${given} 自上次读取后没有变化（共 ${memo.lines} 行 / ${memo.chars} 字符），内容与上文完全相同，` +
      '这里不再重复返回，省下的上下文留给真正要看的东西。\n' +
      '要改它就用上文的行号直接 edit_file；确实需要再看一遍原文，传 {"force":true} 或指定 offset/limit 分段读。'
    )
  }

  const buf = await fs.readFile(target)
  if (looksBinary(buf)) throw new Error('二进制文件，拒绝读取')
  const text = buf.toString('utf8')
  // 读过的文件记一笔：之后 edit/write 才能校验「它确实看过原文」
  rememberRead(target, stat)

  const all = text.split(/\r?\n/)
  const start = offset - 1
  if (start >= all.length) {
    return `第 ${offset} 行已经超出文件末尾（共 ${all.length} 行）。用 offset=1 从头读，或直接读全文。`
  }
  const end = limit > 0 ? Math.min(start + limit, all.length) : all.length

  /**
   * 带行号输出。
   *
   * 三家同类工具（opencode / Claude Code / Codex）都带行号，不是为了好看：
   * 模型要靠它说清「改哪几行」、靠它算 offset 续读、靠它给 goto_definition 传 line。
   * 不带行号时它只能数换行，长文件必错。
   */
  const width = String(end).length
  let out = ''
  let last = start
  for (let i = start; i < end; i++) {
    const piece = `${String(i + 1).padStart(width)}→${all[i]}\n`
    if (out.length + piece.length > capChars) {
      // 单行就超上限（压缩过的 JS）：这一行也必须给，否则模型一个字都看不到
      if (i === start) out += `${String(i + 1).padStart(width)}→${clipSafe(all[i], capChars, '')}\n`
      break
    }
    out += piece
    last = i + 1
  }
  const shownTo = last
  if (shownTo < all.length) {
    out +=
      `\n…（已显示第 ${start + 1}-${shownTo} 行，共 ${all.length} 行。` +
      `继续读用 offset=${shownTo + 1}；找关键词用 grep，不要为了看文件去写临时脚本）`
  }
  if (!out) return '（空文件）'

  // 只有「内容确实够长」才记进短路表：短文件每次都该原样给出
  if (out.length >= READ_MEMO_MIN_CHARS) {
    readMemo.set(key, { sig, offset, limit, lines: all.length, chars: text.length, repeats: 0 })
    if (readMemo.size > READ_MEMO_MAX) {
      const oldest = readMemo.keys().next()
      if (!oldest.done) readMemo.delete(oldest.value)
    }
  } else {
    readMemo.delete(key)
  }
  return out
}

/**
 * 路径不存在时给「工作区里到底有什么」。
 *
 * 真实踩过的坑：模型把 `22_33\run_game.py` 写成 `22 33\run_game.py`（下划线变空格），
 * 拿到一句裸 ENOENT 之后它又猜了三个更离谱的路径。把同名文件的真实位置列出来，
 * 这一次调用就能收敛。
 */
async function notFoundHint(root: string, abs: string, given: string): Promise<string> {
  const base = path.basename(abs).toLowerCase()
  const head = `路径不存在：${given}（解析为 ${abs}）`
  let files: string[] = []
  try {
    files = await walkFiles(root)
  } catch {
    files = []
  }
  const rel = (f: string): string => path.relative(root, f).split(path.sep).join('/') || path.basename(f)
  const named = files.filter((f) => path.basename(f).toLowerCase() === base).slice(0, 5)
  const near = files
    .filter((f) => {
      const n = path.basename(f).toLowerCase()
      if (n === base) return false
      // 归一掉空格/下划线/连字符后再比：`22 33` 与 `22_33` 属于同一个东西
      const norm = (s: string): string => s.replace(/[\s_-]+/g, '')
      return norm(n).includes(norm(base)) || norm(base).includes(norm(n))
    })
    .slice(0, 5)
  const lines = [...new Set([...named, ...near])].map((f) => `  - ${rel(f)}`)
  if (!lines.length) {
    return (
      `${head}\n工作区里没有同名或相近的文件。先用 list_dir 看一眼目录里到底有什么，或用 glob 搜 *.py / **/名字*。`
    )
  }
  return (
    `${head}\n工作区里这些文件名字最接近，挑正确的那个重新调用（注意空格、下划线、连字符）：\n` +
    lines.join('\n')
  )
}

/**
 * 原子写盘：先写同目录临时文件，成功后 rename 替换目标。
 *
 * 直接 fs.writeFile(target) 在写到一半断电 / 崩溃时，目标文件会停在半个内容上；
 * rename 在同一文件系统上是原子的，目标要么是旧内容、要么是完整新内容，绝无残片。
 * 临时文件用随机后缀避免并发冲突；任何一步失败都清理临时文件、目标保持原样。
 */
async function atomicWrite(target: string, content: string): Promise<void> {
  const tmp = `${target}.roro-tmp-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  try {
    await fs.writeFile(tmp, content, 'utf8')
    await fs.rename(tmp, target)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

async function writeFileTool(root: string, args: Record<string, unknown>, allowOutside = false): Promise<string> {
  const target = safePath(root, String(args.path ?? ''), allowOutside)
  const content = String(args.content ?? '')
  const rel = path.relative(root, target)
  const append = args.append === true
  // 续写拼好的内容已经生成完了，不适用「单次生成上限」（见 shared/toolargs 的 HEALED_ARGS）
  const healed = Boolean((args as Record<symbol, unknown>)[HEALED_ARGS])
  if (content.length > MAX_SINGLE_WRITE_CHARS && !healed) {
    throw new Error(oversizeWriteMessage(content.length, rel, append))
  }
  if (append) {
    /**
     * 追加模式：大文件分段的低成本入口。
     *
     * 没有它的时候，模型分段只能靠 edit_file 找一个锚点 —— 那要求它记住自己
     * 上一段最后一行是什么，9B 模型基本做不到，于是退回「整份重写」。
     * append 让它只要接着往下写，不需要任何锚点。
     *
     * 文件不存在时按新建处理（第一次就用 append 也不会报错）。
     */
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.appendFile(target, content, 'utf8')
    await rememberWritten(target)
    const size = (await fs.readFile(target, 'utf8')).length
    return `已追加到 ${rel}（+${content.length} 字符，现共 ${size} 字符）`
  }
  // 覆盖已有文件但没读过：不拦（整份重写是明确意图），但要让它知道自己手里没有原文
  const note = await unreadOverwriteNote(target, rel.split(path.sep).join('/'))
  await fs.mkdir(path.dirname(target), { recursive: true })
  // 原子写：先落临时文件，再 rename 原子替换。直接 fs.writeFile(target) 一旦中途
  // 断电 / 崩溃，目标文件会停在半个内容上；rename 同盘是原子的，目标要么是旧内容、
  // 要么是新内容，绝不会是残片。和 patch 的落盘方式对齐。
  await atomicWrite(target, content)
  await rememberWritten(target)
  return `已写入 ${rel}（${content.length} 字符）${note}`
}

async function editFileTool(root: string, args: Record<string, unknown>, allowOutside = false): Promise<string> {
  const given = String(args.path ?? '')
  const target = safePath(root, given, allowOutside)
  const rel = path.relative(root, target)
  /**
   * 改之前先确认「它读过」。
   *
   * 不是流程洁癖：没读过就写 old_string，本质是让模型凭记忆猜原文，
   * 猜错一次的代价是「重读 + 重写 + 再错」，实测比老老实实读一遍贵得多。
   */
  const verdict = await checkEditable(target, rel.split(path.sep).join('/'))
  if (verdict.missing) throw new Error(await notFoundHint(root, target, given))
  if (!verdict.ok) throw new Error(verdict.message)

  const oldText = String(args.old_string ?? '')
  const newText = String(args.new_string ?? '')
  if (!oldText) throw new Error('old_string 不能为空')
  if (newText.length > MAX_SINGLE_WRITE_CHARS && !(args as Record<symbol, unknown>)[HEALED_ARGS]) {
    throw new Error(
      `这次 new_string 有 ${newText.length} 字符，超过单次写入上限 ${MAX_SINGLE_WRITE_CHARS} 字符，已拒绝执行（文件没有被修改）。\n` +
        '一次输出这么多内容会被截断在半句。拆成几次 edit_file：每次只替换一小段，' +
        '或者先把要填的位置写成一句占位注释，再逐条替换掉那些注释。'
    )
  }
  const original = await fs.readFile(target, 'utf8')
  const res = applyEdit(original, oldText, newText, Boolean(args.replace_all))
  if (!res.ok) throw new Error(res.message)
  // 原子写：和 write_file 一致，编辑后的内容先落临时文件再 rename 替换
  await atomicWrite(target, res.text)
  await rememberWritten(target)
  return `已修改 ${rel}（${describeEdit(res)}）`
}

/**
 * 把一次成功编辑说清楚：改了哪几行、用的是不是宽松匹配。
 *
 * 宽松匹配必须说出来 —— 模型以为自己是「精确替换」时，下次还会照旧写不准；
 * 告诉它「这次是靠缩进无关才命中的」，它下一轮就会多核对一遍缩进。
 */
function describeEdit(res: EditSuccess): string {
  const lines =
    res.count > 1
      ? `${res.count} 处（第 ${res.ranges
          .slice(0, 5)
          .map((r) => r.lineStart)
          .join('、')} 行起）`
      : `第 ${res.ranges[0].lineStart}-${res.ranges[0].lineEnd} 行`
  if (res.strategy === 'exact') return lines
  return `${lines}；精确匹配没命中，按「${res.strategy}」宽松匹配成功，请核对改的是不是这一段`
}

interface PatchEdit {
  path: string
  op: 'create' | 'update' | 'delete' | 'move'
  content?: string
  old_string?: string
  new_string?: string
  replace_all?: boolean
  new_path?: string
}

/** 一次 patch 允许的最大编辑数：防止模型把几十上百个改动塞进一次调用，也不好回滚 */
const MAX_PATCH_EDITS = 50

/**
 * 把 patch 的 args 解析成统一的 PatchEdit 列表，兼容两种输入：
 *   - args.patch 为字符串（标准 apply_patch / unified diff 文本）
 *   - args.edits 为数组（本程序 JSON 格式）
 * 返回空数组表示没有可解析的编辑。三处共用：patchTool / patchTargets / previewPatch。
 */
function resolvePatchEdits(args: Record<string, unknown>): PatchEdit[] {
  const patchText = args.patch
  if (typeof patchText === 'string' && patchText.trim()) {
    return parseApplyPatch(patchText)
  }
  if (!Array.isArray(args.edits)) return []
  return args.edits.map((e) => e as PatchEdit)
}

/**
 * 计算一次 patch 的所有落盘结果，但不写盘。
 * 返回 { [绝对路径]: 新内容或 null（表示删除） }，供执行与预览共用，保证两处逻辑一致。
 */
function computePatch(
  root: string,
  edits: PatchEdit[],
  allowOutside: boolean
): Map<string, string | null> {
  const results = new Map<string, string | null>()
  // 先解析出每个 edit 的绝对路径与 op，再统一校验，最后一次性返回写盘计划
  const planned: Array<{ abs: string; edit: PatchEdit }> = []

  for (const edit of edits) {
    const abs = safePath(root, edit.path, allowOutside)
    if (!edit.op || !['create', 'update', 'delete', 'move'].includes(edit.op)) {
      throw new Error(`patch：未知操作 ${edit.op}（应为 create/update/delete/move）`)
    }
    planned.push({ abs, edit })
  }

  // 校验阶段：全部通过才进入写盘，任一失败抛错、整体不落盘
  for (const { abs, edit } of planned) {
    if (edit.op === 'create') {
      const content = String(edit.content ?? '')
      results.set(abs, content)
    } else if (edit.op === 'delete') {
      results.set(abs, null)
    } else if (edit.op === 'move') {
      const dest = safePath(root, String(edit.new_path ?? ''), allowOutside)
      results.set(dest, null) // 先占位，下面读源内容填进去
      results.set(abs, null) // 源文件删除
    } else {
      // update
      const original = readFileSync(abs, 'utf8')
      const oldText = String(edit.old_string ?? '')
      if (!oldText) throw new Error(`patch：${edit.path} 的 update 缺少 old_string`)
      // 和 edit_file 共用同一套宽松匹配：patch 走的是同一种「照原文复制」的心智负担，
      // 没理由一个能容忍缩进差异、另一个不能
      const res = applyEdit(original, oldText, String(edit.new_string ?? ''), Boolean(edit.replace_all))
      if (!res.ok) throw new Error(`patch：${edit.path}\n${res.message}`)
      results.set(abs, res.text)
    }
  }

  // move 需要源内容：在第二次遍历里处理，避免顺序依赖
  for (const { abs, edit } of planned) {
    if (edit.op !== 'move') continue
    const dest = safePath(root, String(edit.new_path ?? ''), allowOutside)
    let content: string
    try {
      content = readFileSync(abs, 'utf8')
    } catch {
      throw new Error(`patch：移动源文件不存在 ${edit.path}`)
    }
    results.set(dest, content)
  }

  return results
}

async function patchTool(root: string, args: Record<string, unknown>, allowOutside = false): Promise<string> {
  // 兼容两种输入：
  //   1) 标准 apply_patch 文本：args.patch 是一个 unified diff 字符串
  //   2) 本程序 JSON 格式：args.edits 是一个编辑数组
  const dryRun = Boolean(args.dry_run ?? args.dryRun)
  const patchText = args.patch
  let edits: PatchEdit[]
  if (typeof patchText === 'string' && patchText.trim()) {
    // 标准 diff 文本 → 解析成 edits
    const parsed = parseApplyPatch(patchText)
    if (!parsed.length) {
      throw new Error('patch：无法从这段 diff 文本解析出任何改动。请确认包含 @@ hunk 与 ---/+++ 文件头，或改用 edits 数组格式。')
    }
    edits = parsed
  } else {
    const rawEdits = args.edits
    if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
      throw new Error('patch 需要 edits 数组或 patch 文本（标准 apply_patch 格式），且至少一项')
    }
    edits = rawEdits.map((e) => e as PatchEdit)
  }
  if (edits.length > MAX_PATCH_EDITS) {
    throw new Error(`patch 一次最多 ${MAX_PATCH_EDITS} 处改动，请拆成多次调用`)
  }

  // 校验阶段：所有路径 / op / old_string 唯一性都通过才进入写盘；任一失败抛错、整体不落盘。
  // 「读过没」也放在这一阶段：整批任何一处没过就一个文件都别动。
  for (const e of edits) {
    if (e.op !== 'update') continue
    let abs: string
    try {
      abs = safePath(root, e.path, allowOutside)
    } catch {
      continue // 越界路径交给下面的 computePatch 报错
    }
    const verdict = await checkEditable(abs, e.path)
    if (verdict.missing) throw new Error(`patch：${e.path} 不存在\n${await notFoundHint(root, abs, e.path)}`)
    if (!verdict.ok) throw new Error(`patch：${verdict.message}`)
  }
  const results = computePatch(root, edits, allowOutside)

  // dry_run：只校验 + 返回将要发生的改动清单，不写盘
  if (dryRun) {
    const rel = (p: string) => path.relative(root, p).split(path.sep).join('/') || path.basename(p)
    const plan = edits.map((e) => {
      const extra = e.op === 'move' ? ` → ${e.new_path ?? ''}` : e.op === 'update' ? `（替换 ${String(e.old_string ?? '').split('\n').length} 行片段）` : ''
      return `  ${e.op} ${rel(e.path)}${extra}`
    })
    return `[dry-run] 校验通过，将发生 ${edits.length} 处改动（未写盘）：\n${plan.join('\n')}`
  }

  // 写盘阶段：先全部写入同目录下的临时文件，全部成功后再统一 rename（写）或 unlink（删）。
  // 这样「内容准备」与「原子替换」分离——若准备阶段中途失败，目标文件一个都没被动过，
  // 不会留下半套状态。rename 同盘是原子的，真正落盘只在最后一小步。
  const staged: Array<{ tmp: string | null; abs: string; delete: boolean }> = []
  try {
    for (const [abs, content] of results) {
      if (content === null) {
        staged.push({ tmp: null, abs, delete: true })
        continue
      }
      await fs.mkdir(path.dirname(abs), { recursive: true })
      const tmp = `${abs}.roro-tmp-${cryptoRandom()}`
      await fs.writeFile(tmp, content, 'utf8')
      staged.push({ tmp, abs, delete: false })
    }
    // 全部临时文件就绪，统一替换
    for (const s of staged) {
      if (s.delete) {
        await fs.unlink(s.abs).catch(() => undefined)
      } else {
        await fs.rename(s.tmp!, s.abs)
      }
    }
  } catch (err) {
    // 清理已写入的临时文件，避免留垃圾；目标文件保持原样
    for (const s of staged) {
      if (s.tmp) await fs.unlink(s.tmp).catch(() => undefined)
    }
    throw err
  }

  const rel = (p: string) => path.relative(root, p).split(path.sep).join('/') || path.basename(p)
  // 自己刚写完的文件不需要再读一遍：下次改它时不该被「没读过」拦住
  for (const abs of results.keys()) await rememberWritten(abs)
  const summary = edits.map((e) => `${e.op} ${rel(e.path)}`).join('；')
  return `已完成 ${edits.length} 处改动：${summary}`
}

/** 生成本次 patch 的临时文件后缀，避免并发冲突 */
function cryptoRandom(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/** patch 涉及的所有目标绝对路径（引擎记快照、统计 touched 用） */
export function patchTargets(root: string, args: Record<string, unknown>, allowOutside = false): string[] {
  const edits = resolvePatchEdits(args)
  if (!edits.length) return []
  const out = new Set<string>()
  for (const e of edits) {
    try {
      out.add(safePath(root, e.path, allowOutside))
      if (e.op === 'move' && e.new_path) out.add(safePath(root, String(e.new_path), allowOutside))
    } catch {
      // 越界路径跳过，执行时工具会自己报错
    }
  }
  return [...out]
}

/**
 * patch 的多文件预览：不写盘，算出每个受影响文件改前/改后内容，
 * 供审批弹窗逐个展示 diff。与 patchTool 共用 computePatch，保证预览=实际执行。
 */
export function previewPatch(
  args: Record<string, unknown>,
  root: string,
  allowOutside = false
): Array<{ absPath: string; path: string; kind: 'create' | 'modify' | 'delete'; before: string | null; after: string | null }> {
  const edits = resolvePatchEdits(args)
  if (!edits.length) return []
  const results = computePatch(root, edits, allowOutside)
  const rel = (p: string) => path.relative(root, p).split(path.sep).join('/') || path.basename(p)
  const out: Array<{ absPath: string; path: string; kind: 'create' | 'modify' | 'delete'; before: string | null; after: string | null }> = []

  // 先收集所有可能涉及的路径（源 + move 目标），再逐个算 before
  const involved = new Set<string>()
  for (const e of edits) {
    try {
      involved.add(safePath(root, e.path, allowOutside))
      if (e.op === 'move' && e.new_path) involved.add(safePath(root, String(e.new_path), allowOutside))
    } catch {
      // 越界，预览阶段跳过
    }
  }

  for (const abs of involved) {
    let before: string | null = null
    try {
      before = readFileSync(abs, 'utf8')
    } catch {
      before = null
    }
    const after = results.has(abs) ? results.get(abs)! : before
    let kind: 'create' | 'modify' | 'delete' = 'modify'
    if (after === null) kind = 'delete'
    else if (before === null) kind = 'create'
    out.push({ absPath: abs, path: rel(abs), kind, before, after })
  }
  return out
}

/** 把工具参数里的路径解析成绝对路径（引擎记快照时用） */
export function toolTargetPath(root: string, p: string, allowOutside = false): string {
  return safePath(root, p, allowOutside)
}

/**
 * 不写盘，模拟一次写入的结果：审批弹窗要先把 diff 给用户看，
 * 所以这里必须和真正的执行逻辑保持一模一样。
 */
export async function previewWrite(
  tool: string,
  args: Record<string, unknown>,
  root: string,
  allowOutside = false
): Promise<{
  absPath: string
  path: string
  kind: 'create' | 'modify'
  before: string | null
  after: string
} | null> {
  if (tool !== 'write_file' && tool !== 'edit_file') return null
  const target = safePath(root, String(args.path ?? ''), allowOutside)
  let before: string | null = null
  try {
    before = await fs.readFile(target, 'utf8')
  } catch {
    before = null
  }
  const rel = path.relative(root, target).split(path.sep).join('/') || path.basename(target)

  if (tool === 'write_file') {
    const content = String(args.content ?? '')
    // 追加模式：审批弹窗里的 diff 必须是「原文 + 新片段」，否则用户看到的和落盘的不一致
    const after = args.append === true ? (before ?? '') + content : content
    return {
      absPath: target,
      path: rel,
      kind: before === null ? 'create' : 'modify',
      before,
      after
    }
  }

  if (before === null) throw new Error('文件不存在，无法修改')
  const oldText = String(args.old_string ?? '')
  const newText = String(args.new_string ?? '')
  if (!oldText) throw new Error('old_string 不能为空')
  // 预览必须和真正落盘用同一套替换逻辑：否则审批里看到的 diff 都是错的
  const res = applyEdit(before, oldText, newText, Boolean(args.replace_all))
  if (!res.ok) throw new Error(res.message)
  return { absPath: target, path: rel, kind: 'modify', before, after: res.text }
}

async function listDirTool(root: string, args: Record<string, unknown>, allowOutside = false): Promise<string> {  const target = safePath(root, String(args.path ?? '.'), allowOutside)
  const entries = await fs.readdir(target, { withFileTypes: true })
  const lines = entries
    .filter((e) => !IGNORED.has(e.name))
    .slice(0, 300)
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
  return lines.join('\n') || '（空目录）'
}

async function globTool(root: string, args: Record<string, unknown>): Promise<string> {
  const pattern = String(args.pattern ?? '**/*')
  const re = globToRegExp(pattern)
  const files = await walkFiles(root)
  const hits = files
    .map((f) => path.relative(root, f).replace(/\\/g, '/'))
    .filter((f) => re.test(f))
    .slice(0, 200)
  return hits.join('\n') || '（没有匹配的文件）'
}

async function grepTool(root: string, args: Record<string, unknown>, allowOutside = false): Promise<string> {
  const pattern = String(args.pattern ?? '')
  if (!pattern) throw new Error('pattern 不能为空')
  const re = new RegExp(pattern, 'i')
  const base = safePath(root, String(args.path ?? '.'), allowOutside)
  const includeRe = args.include ? globToRegExp(String(args.include)) : null
  const out: string[] = []
  /**
   * path 可能指向**单个文件**（模型最常用的写法：grep 一个文件确认原文再改）。
   * 以前一律交给 walkFiles 去 readdir，对文件会抛 ENOTDIR 被吞掉，于是永远返回
   * 「没有匹配结果」—— 模型据此断定原文不存在，不停换 pattern 重试，白烧几十轮。
   * 这里先判类型：文件就直接搜它；目录才递归；不存在就明确报错，
   * 让模型知道是路径写错了，而不是"关键字没匹配到"。
   */
  let files: string[]
  let singleFile = false
  try {
    const st = await fs.stat(base)
    if (st.isFile()) {
      files = [base]
      singleFile = true
    } else {
      files = await walkFiles(root, base)
    }
  } catch {
    throw new Error(`路径不存在：${String(args.path ?? '.')}（先确认目录/文件名，或用 list_dir 看一眼）`)
  }
  for (const file of files) {
    if (out.length >= MAX_GREP_MATCHES) break
    const rel = path.relative(root, file).replace(/\\/g, '/')
    // 点名搜单个文件时，include 不该再把它筛掉
    if (!singleFile && includeRe && !includeRe.test(rel)) continue
    let stat
    try {
      stat = await fs.stat(file)
    } catch {
      continue
    }
    if (stat.size > 1_500_000) continue
    let text: string
    try {
      const buf = await fs.readFile(file)
      if (looksBinary(buf)) continue
      text = buf.toString('utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        out.push(`${rel}:${i + 1}: ${clipSafe(lines[i].trim(), 200, '')}`)
        if (out.length >= MAX_GREP_MATCHES) break
      }
    }
  }
  if (!out.length) return '（没有匹配结果）'
  // 到上限就明说「还有更多」：静默截断会让模型以为搜全了，据此得出错误结论
  if (out.length >= MAX_GREP_MATCHES) {
    out.push(
      `…（已到 ${MAX_GREP_MATCHES} 条上限，后面可能还有匹配。缩小 path、加 include、或用更精确的 pattern 再看）`
    )
  }
  return out.join('\n')
}

/**
 * cmd.exe 把引号吃掉时，报错和「Python 代码写错」一模一样（`SyntaxError: unterminated
 * string literal`），模型会以为是自己写错、反复重写同一段代码。这里补一条明确提示，
 * 告诉它换执行方式。只在确实像引号/语法被截断时给，正常报错不挂这句废话。
 */
function shellFailureHint(kind: string, command: string, output: string): string {
  if (!isWin || kind !== 'cmd') return ''
  if (!command.includes('"')) return ''
  if (!/unterminated string literal|SyntaxError|命令语法不正确|系统找不到指定的路径/i.test(output)) return ''
  return [
    '[提示] 这多半是 Windows cmd.exe 处理双引号的坑，不是你代码写错了：',
    'cmd 会对命令里的引号做二次解析，`python -c "..."` / `node -e "..."` 这类内联多语句很容易被截断。',
    '建议改用：',
    '1) write_file 把脚本写成 .py / .js 文件，再 run_shell 跑 `python xxx.py`；或',
    '2) 给 run_shell 传 {"shell":"powershell"} 用 PowerShell 执行。'
  ].join('\n')
}

/**
 * 命令和 shell 不匹配时的纠正提示。
 *
 * 同一场会话里出现过 cmd 的 `set PYTHONPATH=.` 和 PowerShell 的 `Get-Process` 混用，
 * 还有人在 PowerShell 里跑 `tail -3` 拿到一句 CommandNotFound —— 原始报错只有一行
 * 「无法将 tail 项识别为 cmdlet」，模型往往理解成「命令不存在，换个写法再来一次」，
 * 于是继续在同一条错路上试。这里把「换成 bash」或「换成等价命令」直接说清楚。
 *
 * 只加提示、不改命令：模型可能是在故意探测某个命令是否存在。
 */
const ALWAYS_UNIX = new Set([
  'tail', 'head', 'grep', 'sed', 'awk', 'chmod', 'chown', 'touch', 'wc', 'tee',
  'xargs', 'source', 'export', 'env', 'sudo', 'tr', 'uniq', 'basename', 'dirname'
])
/** cmd 没有、但 PowerShell 有别名（ls/cat/rm/cp/mv）的命令 */
const CMD_MISSING = new Set(['ls', 'cat', 'rm', 'cp', 'mv', 'which', 'pwd', 'clear'])

export function shellMismatchHint(kind: string, command: string, output: string): string {
  if (!isWin || kind === 'bash') return ''
  // 只看每一段的第一个词：路径或参数里出现 grep / tail 字样不该被当成命令
  const segments = command
    .split(/\|\||&&|[|;&\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const hit = segments
    .map((s) => s.split(/\s+/)[0]?.toLowerCase() ?? '')
    .find((w) => ALWAYS_UNIX.has(w) || (kind === 'cmd' && CMD_MISSING.has(w)))
  // PowerShell 5.1 连 `&&` / `||` 都不认，报的是 ParserError 而不是「命令不存在」
  const andAnd = kind === 'powershell' && /&&|\|\|/.test(command)
  if (!hit && !andAnd) return ''

  /**
   * 报错里必须有「不认识这个命令 / 语法不合法」的迹象。
   * 不能只看非零退出码：`grep x missing.txt` 在装了 Git 的机器上能跑，只是文件不存在，
   * 那种情况给「换 bash」的建议纯粹是误导。
   */
  const unrecognized = /not recognized|CommandNotFound|command not found|不是内部或外部命令|无法将.*识别|not a valid statement separator/i
  const parseErr = /ParserError|缺少表达式|Missing expression|Unexpected token/i
  if (!unrecognized.test(output) && !(andAnd && parseErr.test(output))) return ''

  const lines = hit
    ? [
        `[提示] 命令里的 \`${hit}\` 是 unix 命令，当前 shell 是 ${kind === 'cmd' ? 'cmd.exe' : 'PowerShell'}，本机没有它，所以这行报错和你的代码无关。`,
        '两种改法，任选其一：',
        '1) 给 run_shell 加上 "shell":"bash" 用 Git Bash 执行（需已安装 Git Bash）；',
        '2) 换成本机等价命令：',
        '   tail -n 3 f  →  powershell: Get-Content f -Tail 3',
        '   head -n 3 f  →  powershell: Get-Content f -TotalCount 3',
        '   grep x f     →  findstr x f（cmd）/ Select-String x f（powershell）',
        '   ls / cat / rm → dir / type / del（cmd）或 Get-ChildItem / Get-Content / Remove-Item'
      ]
    : [
        '[提示] Windows PowerShell 5.1 不支持 `&&` / `||` 这种链式写法，所以这行报错和你的代码无关。',
        '改法：拆成两条 run_shell 依次执行，或用 `;` 顺序执行（不短路）；确实要用 `&&` 就给 shell 设 bash。'
      ]
  if (kind === 'powershell' && hit && /&&|\|\|/.test(command)) {
    lines.push('   另外：这条命令里还有 `&&` / `||`，Windows PowerShell 5.1 同样不支持，请一并拆开。')
  }
  return lines.join('\n')
}

function runShellTool(root: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const command = String(args.command ?? '').trim()
  if (!command) throw new Error('command 不能为空')
  /**
   * 已经停了就别再起进程。审批弹窗开着的时候用户点了停止，等他再点「允许」，
   * 信号早就断了 —— AbortSignal 不会补发事件，spawn 之后注册的监听永远不会触发，
   * 命令会照跑到超时（最长 10 分钟），界面上却写着「已停止」。
   */
  if (signal.aborted) throw new Error('已取消：这一轮已经停止，命令没有执行')
  if (!existsSync(root)) {
    throw new Error(`工作区目录不存在或不可访问：${root}。请重新选择工作区后再执行命令。`)
  }
  const shell = String(args.shell ?? defaultShellKind())
  /**
   * 超时必须是有限正数。模型常按人类习惯写 `"30s"` / `"5 min"` / `null`，
   * Number() 之后是 NaN；Math.max/min 全都是 NaN，而 setTimeout(fn, NaN) 等价于 0 ——
   * 命令刚起就被 taskkill，返回的却是「超时，进程已终止」，模型会以为命令跑太慢。
   */
  const rawTimeout = Number(args.timeout_ms)
  const timeout = Number.isFinite(rawTimeout)
    ? Math.min(Math.max(rawTimeout, 1000), 600000)
    : 120000

  // 极少数不可逆命令直接拒，不弹确认框：这类操作不该交给助手代跑
  const blocked = hardBlockReason(command)
  if (blocked) {
    throw new Error(
      `已拒绝执行：这条命令属于「${blocked}」。它是不可逆操作，请你自己确认后在终端里手动执行。`
    )
  }

  /**
   * 用 shell 直接改源码：拦掉，并把正路写进报错里。
   *
   * 所有写入门禁（写入上限、HTML 语法校验、浏览器打开验收、变更快照）都挂在
   * write_file / edit_file 上，而 `sed -i`、`echo > index.html`、`python -c "open(...,'w')"`
   * 从工具层看只是「跑了条命令」，一次都不经过它们 —— 实测里坏代码就是这么落盘的。
   * 明确写某个源码文件的写法没有正当用途，当场拒绝比事后补校验便宜。
   * （`python gen.py` 这种间接路径不猜，交给 agent.ts 的变更检测兜底。）
   */
  const shellWrite = detectShellWrite(command)
  if (shellWrite.mutating) throw new Error(shellWriteRefusal(shellWrite))

  // 后台模式：立刻返回任务 id，长任务不会再把工具调用拖到超时
  if (args.background === true) {
    if (signal.aborted) throw new Error('已取消')
    return startBackground(root, command, shell).then(
      (job) =>
        `已在后台启动（任务 id：${job.id}，pid：${job.pid ?? '—'}）。\n` +
        `用 shell_bg 查看进度：{"action":"log","id":"${job.id}"}\n` +
        `日志文件：${job.logPath}`
    )
  }

  const bin = shellBin(shell)
  const finalArgv = shellArgs(shell, command)

  return new Promise((resolve, reject) => {
    const child = spawn(bin, finalArgv, {
      cwd: root,
      windowsHide: true,
      // cmd.exe 不认 Node 的 Windows 参数转义（会把内层双引号吃掉，见 platform.shellNeedsVerbatim）；
      // powershell / bash 自己会解析，不能开。只对 cmd 生效，其他平台该选项被忽略。
      windowsVerbatimArguments: shellNeedsVerbatim(shell),
      // 白名单：不把用户 shell 里的密钥 / token 交给模型生成的命令
      env: safeEnv()
    })
    let stdout = ''
    let stderr = ''
    /** 缓冲区装不下时从头丢掉的字符数：只说「已省略」，模型才知道日志不全 */
    let droppedOut = 0
    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (text: string) => {
      if (done) return
      done = true
      // 收尾时把定时器和 abort 监听一起摘掉：否则一次取消会在后台留下一个空转的定时器
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(clipCommandOutput(text, MAX_OUTPUT + 1200))
    }
    timer = setTimeout(() => {
      killTree(child.pid)
      finish(`${stdout}\n[超时 ${timeout}ms，进程已终止]`)
    }, timeout)

    const onAbort = () => {
      killTree(child.pid)
      finish(`${stdout}\n[已取消]`)
    }
    signal.addEventListener('abort', onAbort, { once: true })

    /**
     * 只保留「最近的一段」。
     *
     * 以前是 `if (stdout.length < MAX_OUTPUT * 2) stdout += …` —— 满了就不再追加，
     * 等于只留开头。而 `npm run build` / `pytest` / `cargo build` 的错误全在**末尾**，
     * 模型看到的是前 40000 字符的编译进度 + 一句 exit code 1，只能盲改重跑。
     */
    const KEEP = MAX_OUTPUT * 6
    const pushOut = (chunk: string): void => {
      stdout += chunk
      if (stdout.length <= KEEP) return
      const cut = stdout.length - KEEP
      // 从整行开始保留，别把半行留在开头
      const nl = stdout.indexOf('\n', cut)
      const trimAt = nl >= 0 && nl - cut < 400 ? nl + 1 : cut
      stdout = stdout.slice(trimAt)
      droppedOut += trimAt
    }
    child.stdout?.on('data', (d: Buffer) => pushOut(d.toString('utf8')))
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
      if (stderr.length > KEEP) stderr = stderr.slice(stderr.length - KEEP)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`无法启动命令（${bin}，工作目录 ${root}）：${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      /**
       * stdout 和 stderr 各给一份预算。
       * 以前是「拼起来整体截断」：stdout 一长，stderr 里的真正错误就被整段切掉。
       */
      const hasErr = Boolean(stderr.trim())
      const outBudget = hasErr ? Math.floor(MAX_OUTPUT * 0.72) : MAX_OUTPUT
      const parts: string[] = []
      if (droppedOut > 0) parts.push(`[前面还有约 ${droppedOut} 字符输出没有保留，已从中间截断]`)
      parts.push(clipCommandOutput(stdout.trim(), outBudget))
      if (hasErr) parts.push(`[stderr]\n${clipCommandOutput(stderr.trim(), MAX_OUTPUT - outBudget)}`)
      // 失败了才可能给提示：成功时 hint 内部会直接返回空
      if (code !== 0) {
        const merged = `${stdout}\n${stderr}`
        const hint = shellFailureHint(shell, command, merged) || shellMismatchHint(shell, command, merged)
        if (hint) parts.push(hint)
      }
      parts.push(`[exit code: ${code ?? 'null'}]`)
      finish(parts.filter(Boolean).join('\n'))
    })
  })
}

/**
 * 命令输出的截断策略：留头（命令回显、配置摘要）+ 留尾（真正的报错）。
 *
 * 尾部的预算远大于头部 —— 编译/测试的结论永远在最后几屏。
 * 和文件读取的「只留头」是相反的策略，因为两者的信息分布正好相反。
 */
export function clipCommandOutput(text: string, limit = MAX_OUTPUT): string {
  if (text.length <= limit) return text
  const headLen = Math.min(1200, Math.floor(limit * 0.15))
  const head = clipSafe(text, headLen, '')
  const tailLen = limit - head.length
  const rawTail = text.slice(Math.max(0, text.length - tailLen))
  // 从整行开始，别把半行留在开头
  const nl = rawTail.indexOf('\n')
  const tail = nl >= 0 && nl < 400 ? rawTail.slice(nl + 1) : rawTail
  const omitted = text.length - head.length - tail.length
  return `${head}\n…（中间省略约 ${omitted} 字符；构建/测试的报错通常在末尾，这里保留尾部）\n${tail}`
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const root = ctx.workspace
  const allowOutside = Boolean(ctx.allowOutside)
  switch (name) {
    case 'toolbox': {
      const want = String(args.tool ?? '').trim()
      const list = ctx.hiddenTools ?? []
      if (!want) {
        if (!list.length) return '本轮所有工具都已经直接下发，不需要 toolbox。'
        return [
          '本轮没有直接下发、但可以通过 toolbox 调用的工具（把 tool 设成名字，args 填它的参数）：',
          ...list.map((t) => `- ${t.name}：${(t.description || '').replace(/\s+/g, ' ').slice(0, 90)}`),
          '',
          '例：{"tool":"git","args":{"action":"status"}}'
        ].join('\n')
      }
      return `本轮没有名为「${want}」的工具。可以调用的有：${list.map((t) => t.name).join('、') || '（无）'}`
    }
    case 'read_file':
      return readFileTool(root, args, allowOutside, ctx.readCap ?? MAX_READ)
    case 'write_file':
      return writeFileTool(root, args, allowOutside)
    case 'edit_file':
      return editFileTool(root, args, allowOutside)
    case 'patch':
      return patchTool(root, args, allowOutside)
    case 'list_dir':
      return listDirTool(root, args, allowOutside)
    case 'glob':
      return globTool(root, args)
    case 'grep':
      return grepTool(root, args, allowOutside)
    case 'goto_definition': {
      const file = resolveToolPath(root, String(args.path ?? ''))
      const line = Number(args.line) || 0
      const col = Number(args.col) || 1
      if (!file || !line) throw new Error('goto_definition 需要 path 和 line')
      const defs = await gotoDefinition(root, file, line, col)
      if (!defs.length) {
        const ext = path.extname(file).toLowerCase()
        if (['.py', '.pyi', '.go', '.rs', '.java'].includes(ext)) {
          return (
            '定义跳转目前只支持 TypeScript / JavaScript。' +
            `${path.basename(file)} 是 ${ext.slice(1)} 文件，用 grep 搜符号名更可靠；` +
            '编译/类型反馈则由写文件后的自动诊断提供。'
          )
        }
        return '没找到定义（该位置可能不是符号，或超出 TS/JS 项目范围）。'
      }
      return defs
        .map((d, i) => `${i + 1}. ${relPath(d.file, root)}:${d.line}:${d.col}${d.snippet ? `\n   ${d.snippet}` : ''}`)
        .join('\n')
    }
    case 'find_references': {
      const file = resolveToolPath(root, String(args.path ?? ''))
      const line = Number(args.line) || 0
      const col = Number(args.col) || 1
      if (!file || !line) throw new Error('find_references 需要 path 和 line')
      const r = await findReferences(root, file, line, col)
      if (!r.refs.length) {
        const ext = path.extname(file).toLowerCase()
        if (['.py', '.pyi', '.go', '.rs', '.java'].includes(ext)) {
          return (
            '引用查找目前只支持 TypeScript / JavaScript。' +
            `${path.basename(file)} 是 ${ext.slice(1)} 文件，用 grep 搜符号名更可靠。`
          )
        }
        return '没找到引用。'
      }
      const lines = r.refs.map(
        (ref) => `${relPath(ref.file, root)}:${ref.line}:${ref.col}${ref.snippet ? `  ${ref.snippet}` : ''}`
      )
      const head = `共 ${r.refs.length} 处引用，分布在 ${r.fileCount} 个文件${r.truncated ? `（已截断到前 ${r.refs.length} 条）` : ''}：`
      return [head, ...lines].join('\n')
    }
    case 'run_shell':
      return runShellTool(root, args, ctx.signal)
    case 'shell_bg': {
      const action = String(args.action ?? 'log')
      if (action === 'list') {
        const list = listJobs()
        if (!list.length) return '没有后台任务。用 run_shell 的 background=true 启动。'
        return list
          .map(
            (j) =>
              `${j.id} · ${j.status === 'running' ? '运行中' : `已结束(${j.exitCode ?? 'null'})`} · ${new Date(j.startedAt).toLocaleTimeString()} · ${j.command.slice(0, 80)}`
          )
          .join('\n')
      }
      const id = String(args.id ?? '')
      if (!id) throw new Error('需要 id：先 shell_bg({action:"list"}) 看任务列表')
      if (action === 'kill') return killJob(id)
      if (!getJob(id)) throw new Error(`没有这个后台任务：${id}`)
      return tailLog(id, Number(args.tail ?? 80))
    }
    case 'rollback': {
      if (!ctx.sessionId) throw new Error('这个环境没有会话级快照')
      const action = String(args.action ?? 'list')
      if (action === 'list') {
        const snaps = listSnapshots(root, ctx.sessionId)
        if (!snaps.length) return '本会话还没有可回滚的快照。快照只在写文件前自动生成（覆盖已存在的文件时）。'
        return [
          `本会话共 ${snaps.length} 个可回滚快照（新到旧）：`,
          ...snaps.map(
            (s) =>
              `${s.seq}. ${s.rel}（${s.size} 字节 · ${new Date(s.at).toLocaleTimeString()}）`
          )
        ].join('\n')
      }
      const seq = Number(args.seq)
      if (!seq) throw new Error('restore 需要 seq：先 rollback({action:"list"}) 看快照序号')
      const restored = await rollbackSnapshot(root, ctx.sessionId, seq)
      if (!restored) throw new Error(`没有序号 ${seq} 的快照，或该文件已不在工作区内。先 rollback({action:"list"}) 确认。`)
      return `已回滚 ${restored} 到快照 #${seq} 的内容。建议重新打开验收确认。`
    }
    case 'board': {
      const section = String(args.section ?? 'fact') as BoardSection
      const r = await addBoardNote(root, section, String(args.note ?? ''))
      return r.added
        ? `已写进共享黑板「${SECTION_LABEL[section] ?? section}」，这一页现在共 ${r.items} 条。同一个工作区的其他档案下一轮就能看到。`
        : `黑板上已经有这条了（共 ${r.items} 条），没有重复写。`
    }
    case 'scratch': {
      if (!ctx.sessionId) throw new Error('这个环境没有会话级便签')
      if (args.clear === true) {
        await clearScratch(ctx.sessionId)
        return '会话便签已清空。'
      }
      const text = typeof args.text === 'string' ? args.text.trim() : ''
      if (!text) {
        const current = (await readScratch(ctx.sessionId)).trim()
        return current ? `当前会话便签（${current.length} 字）：\n${current}` : '会话便签还是空的。'
      }
      const mode = args.mode === 'replace' ? 'replace' : 'append'
      const r = await writeScratch(ctx.sessionId, text, mode)
      return `${mode === 'replace' ? '已覆盖' : '已追加一条'}，便签现在 ${r.chars} 字。下几步就会看到它（只在这个会话里）。`
    }
    case 'web_search':
      return webSearchTool(args, ctx.signal)
    case 'web_fetch':
      return webFetchTool(args, ctx.signal)
    case 'terminal': {
      const action = String(args.action ?? '')
      if (action === 'open') {
        const info = openTerminal(root, args.shell ? String(args.shell) : undefined)
        return (
          `终端已打开：session_id=${info.id}（${info.shell}，${info.cwd}）。` +
          `\n发送输入：terminal({action:"write", session_id:"${info.id}", data:"命令\\n"})` +
          `\n读输出：terminal({action:"read", session_id:"${info.id}", wait_ms:1000})`
        )
      }
      if (action === 'list') {
        const list = listTerminals()
        if (!list.length) return '还没有终端会话。用 terminal({action:"open"}) 打开一个。'
        return list
          .map((t) => `${t.id} · ${t.shell} · ${t.status}${t.exitCode !== null ? `(${t.exitCode})` : ''} · ${t.cwd}`)
          .join('\n')
      }
      const id = String(args.session_id ?? '')
      if (!id) throw new Error('需要 session_id：先用 terminal({action:"open"})')
      if (action === 'write') {
        const data = String(args.data ?? '')
        if (!data) throw new Error('write 需要 data（要回车就带 \\n）')
        const t = writeTerminal(id, data)
        return `已发送 ${data.length} 字符（当前 seq=${t.seq}）。用 read 读输出。`
      }
      if (action === 'read') {
        const r = await readTerminal(id, args.seq !== undefined ? Number(args.seq) : undefined, {
          tail: Number(args.tail ?? 8000),
          waitMs: Number(args.wait_ms ?? 0)
        })
        const head = `[seq=${r.seq} · ${r.status}${r.exitCode !== null ? ` · exit ${r.exitCode}` : ''}]`
        return `${head}\n${r.text || '（暂时没有新输出）'}`
      }
      if (action === 'close') {
        const t = closeTerminal(id)
        return t ? `终端 ${id} 已关闭。` : `没有这个终端：${id}`
      }
      throw new Error(`未知 terminal action：${action}`)
    }
    case 'git': {
      const paths = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : undefined
      const action = String(args.action ?? '')
      /**
       * preCommit：提交前的最后一道闸。
       * 放在工具层而不是 git.ts：钩子要知道 sessionId / agentId，
       * 而 git.ts 是纯 git 封装，不该反过来依赖 agent 的运行时。
       */
      if (action === 'commit') {
        const hook = await runHooks('preCommit', {
          workspace: root,
          sessionId: ctx.sessionId ?? null,
          agentId: ctx.agentId ?? null,
          tool: 'git',
          args,
          text: args.message !== undefined ? String(args.message) : undefined
        })
        if (hook.blocked) return `提交被 preCommit 钩子拦下：${hook.blocked}`
      }
      return await gitAction(root, action, {
        message: args.message !== undefined ? String(args.message) : undefined,
        paths,
        branch: args.branch !== undefined ? String(args.branch) : undefined,
        remote: args.remote !== undefined ? String(args.remote) : undefined,
        create: args.create !== undefined ? Boolean(args.create) : undefined,
        steps: args.steps !== undefined ? Number(args.steps) : undefined,
        dir: args.dir !== undefined ? String(args.dir) : undefined,
        title: args.title !== undefined ? String(args.title) : undefined,
        body: args.body !== undefined ? String(args.body) : undefined,
        limit: args.limit !== undefined ? Number(args.limit) : undefined,
        stashAction: args.stash_action as 'push' | 'pop' | 'list' | 'drop' | undefined,
        worktreeAction: args.worktree_action as 'list' | 'add' | 'remove' | undefined
      })
    }
    case 'format': {
      const paths = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : []
      if (!paths.length) throw new Error('format 需要 paths')
      const files = paths.map((p) => resolveToolPath(root, p)).filter((f) => existsSync(f))
      if (!files.length) throw new Error('这些文件都不存在')
      const fmt = await formatFiles(root, files, { includeDocs: args.docs === true })
      let out = fmt.message || '[格式化] 没有需要改的地方'
      if (args.lint === true) {
        const lint = await lintFiles(root, files)
        out += lint.count
          ? `\n\n[lint] ${lint.count} 个问题：\n${lint.text}`
          : '\n\n[lint] 没有报错'
      }
      return out
    }
    case 'repo_map': {
      const index = args.refresh === true ? await buildIndex(root, { force: true }) : await loadIndex(root)
      const query = args.query ? String(args.query).trim() : ''
      const limit = typeof args.limit === 'number' ? args.limit : undefined
      /**
       * 带 query 时先试语义检索：本地 embedding 能听懂「登录怎么校验的」这种问法，
       * 词面匹配只能靠用户先猜对关键词。服务没开 / 模型不支持就静默回落，不影响功能。
       */
      if (query) {
        const semantic = await semanticMap(
          root,
          index,
          query,
          limit ?? 20,
          args.path ? String(args.path) : undefined
        ).catch(() => null)
        if (semantic) return semantic
      }
      return renderMap(index, {
        path: args.path ? String(args.path) : undefined,
        query: query || undefined,
        limit,
        summary: args.summary !== false
      })
    }
    case 'write_plan': {
      const text = String(args.plan ?? '').trim()
      if (!text) throw new Error('write_plan 需要 plan：把方案写完整')
      const steps = Array.isArray(args.steps) ? args.steps.map(String).map((s) => s.trim()).filter(Boolean) : []
      const dir = path.join(root, '.roroto')
      await fs.mkdir(dir, { recursive: true })
      const body = steps.length ? `${text}\n\n## 步骤\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : text
      await fs.writeFile(path.join(dir, 'plan.md'), `${body}\n`, 'utf8')
      if (ctx.sessionId) await saveSessionPlan(ctx.sessionId, text, steps)
      return [
        '计划已保存到 .roroto/plan.md，界面上已弹出批准按钮。',
        '',
        body,
        '',
        '现在停下等用户批准，不要继续调用任何会改动文件的工具。'
      ].join('\n')
    }
    case 'update_todos': {
      // 真正的状态存在引擎里（agent.ts 会先拦截），这里只兜底给个回执
      return formatTodos(normalizeTodos(args.items))
    }
    case 'remember': {
      const r = await rememberFact(root, String(args.note ?? ''), ctx.agentId)
      return r.added
        ? `已写入项目长期记忆，当前共 ${r.count} 条。下次对话会自动带上。`
        : `这条记忆已经存在（共 ${r.count} 条），没有重复写入。`
    }
    case 'use_skill': {
      // 只认打开开关的技能：开关本身就是「允许模型自己取这份说明」的授权
      return await readSkillBody(String(args.name ?? args.skill ?? ''))
    }
    case 'handoff': {
      if (!ctx.handoff) throw new Error('当前没有别的档案可以交接：先在 Agent 面板里建一个')
      const to = String(args.to ?? '').trim()
      const task = String(args.task ?? '').trim()
      if (!to) throw new Error('handoff 需要 to：要交给谁')
      if (!task) throw new Error('handoff 需要 task：让对方做什么')
      const files = Array.isArray(args.files) ? args.files.map((f) => String(f)).filter(Boolean) : []
      return await ctx.handoff({
        to,
        task,
        context: args.context ? String(args.context) : '',
        files
      })
    }
    default:
      throw new Error(`未知工具：${name}`)
  }
}

export { toolSpecs }
export type { ToolSpec }
