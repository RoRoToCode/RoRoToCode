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
import { parseApplyPatch } from './applypatch'
import { gotoDefinition, findReferences } from '../lsp'
import { relPath } from '../lsp/types'
import { formatFiles, lintFiles } from '../format'
import { gitAction } from '../git'
import { closeTerminal, listTerminals, openTerminal, readTerminal, writeTerminal } from '../terminal'
import { runHooks } from '../hooks'
import { clipSafe, replaceOnce } from '../../shared/text'
import { buildIndex, loadIndex, renderMap } from '../repoindex'
import { semanticMap } from '../embed'
import { saveSessionPlan } from '../store'
import { readSkillBody } from '../skills'

const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'target',
  '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'coverage', '.cache', '.turbo'
])

const MAX_READ = 40000
const MAX_OUTPUT = 20000
const MAX_GREP_MATCHES = 200
const MAX_FILES = 20000

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
export { classifyRisk, classifyMcpRisk, hardBlockReason, isOutside, applyCustomRules, tokenizeCommand, resourceCandidates, type RiskInfo, type PermissionRule } from '../risk'
import { hardBlockReason } from '../risk'
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
  const raw = String(p || '.').trim()
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw)
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
 * 读文件被截断时的指引。
 *
 * 以前这里只说「内容过长已截断」，模型不知道该怎样接着读，于是绕道去写
 * dump.py / gs.py 这类一次性脚本把文件切块打印 —— 一个任务能刷出十几个脚本，
 * 还经常因为路径转义写错而反复重试。把它该用的两个手段直接写在结果里。
 */
const READ_CUT_HINT =
  '要看后面的内容，用 read_file 的 offset/limit 分段读（offset 是起始行号），或用 grep 定位关键词；' +
  '不要为了看文件去写临时脚本'

function trim(text: string, limit = MAX_READ, hint = ''): string {
  if (text.length <= limit) return text
  // 别切在 emoji 的代理对中间：孤立高位代理会让这次工具结果变成非法字符
  return `${clipSafe(text, limit, '')}\n\n…（内容过长已截断，共 ${text.length} 字符${hint ? `。${hint}` : ''}）`
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

async function readFileTool(root: string, args: Record<string, unknown>, allowOutside = false): Promise<string> {
  const target = safePath(root, String(args.path ?? ''), allowOutside)
  const stat = await fs.stat(target)
  if (stat.isDirectory()) throw new Error('目标是目录，请用 list_dir')
  const buf = await fs.readFile(target)
  if (looksBinary(buf)) throw new Error('二进制文件，拒绝读取')
  const text = buf.toString('utf8')
  const offset = Number(args.offset ?? 0)
  const limit = Number(args.limit ?? 0)
  if (offset > 0 || limit > 0) {
    const lines = text.split(/\r?\n/)
    const start = Math.max(offset - 1, 0)
    const end = limit > 0 ? start + limit : lines.length
    return trim(lines.slice(start, end).join('\n'), MAX_READ, READ_CUT_HINT)
  }
  return trim(text, MAX_READ, READ_CUT_HINT)
}

async function writeFileTool(root: string, args: Record<string, unknown>, allowOutside = false): Promise<string> {
  const target = safePath(root, String(args.path ?? ''), allowOutside)
  const content = String(args.content ?? '')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content, 'utf8')
  return `已写入 ${path.relative(root, target)}（${content.length} 字符）`
}

async function editFileTool(root: string, args: Record<string, unknown>, allowOutside = false): Promise<string> {
  const target = safePath(root, String(args.path ?? ''), allowOutside)
  const oldText = String(args.old_string ?? '')
  const newText = String(args.new_string ?? '')
  if (!oldText) throw new Error('old_string 不能为空')
  const original = await fs.readFile(target, 'utf8')
  const count = original.split(oldText).length - 1
  if (count === 0) throw new Error('未找到 old_string，请先读取文件确认原文')
  if (count > 1 && !args.replace_all) {
    throw new Error(`old_string 出现 ${count} 次，请提供更长的上下文或设置 replace_all`)
  }
  const updated = args.replace_all ? original.split(oldText).join(newText) : replaceOnce(original, oldText, newText)
  await fs.writeFile(target, updated, 'utf8')
  return `已修改 ${path.relative(root, target)}（替换 ${args.replace_all ? count : 1} 处）`
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
      const count = original.split(oldText).length - 1
      if (count === 0) throw new Error(`patch：在 ${edit.path} 未找到 old_string，请先 read_file 确认原文`)
      if (count > 1 && !edit.replace_all) {
        throw new Error(`patch：${edit.path} 的 old_string 出现 ${count} 次，请提供更长上下文或设 replace_all`)
      }
      const updated = edit.replace_all
        ? original.split(oldText).join(String(edit.new_string ?? ''))
        : replaceOnce(original, oldText, String(edit.new_string ?? ''))
      results.set(abs, updated)
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
    return {
      absPath: target,
      path: rel,
      kind: before === null ? 'create' : 'modify',
      before,
      after: String(args.content ?? '')
    }
  }

  if (before === null) throw new Error('文件不存在，无法修改')
  const oldText = String(args.old_string ?? '')
  const newText = String(args.new_string ?? '')
  if (!oldText) throw new Error('old_string 不能为空')
  const count = before.split(oldText).length - 1
  if (count === 0) throw new Error('未找到 old_string')
  // 预览必须和真正落盘用同一套替换逻辑：否则审批里看到的 diff 都是错的
  const after = args.replace_all ? before.split(oldText).join(newText) : replaceOnce(before, oldText, newText)
  return { absPath: target, path: rel, kind: 'modify', before, after }
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
  const files = await walkFiles(root, base)
  for (const file of files) {
    if (out.length >= MAX_GREP_MATCHES) break
    const rel = path.relative(root, file).replace(/\\/g, '/')
    if (includeRe && !includeRe.test(rel)) continue
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
  return out.join('\n') || '（没有匹配结果）'
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
  const shell = String(args.shell ?? 'cmd')
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

  const bin =
    shell === 'powershell'
      ? 'powershell.exe'
      : shell === 'bash'
        ? 'bash.exe'
        : process.env.ComSpec || 'cmd.exe'
  const argv = shell === 'powershell' ? ['-NoProfile', '-Command', command] : ['/d', '/s', '/c', command]
  const finalArgv = shell === 'bash' ? ['-lc', command] : argv

  return new Promise((resolve, reject) => {
    const child = spawn(bin, finalArgv, {
      cwd: root,
      windowsHide: true,
      // 白名单：不把用户 shell 里的密钥 / token 交给模型生成的命令
      env: safeEnv()
    })
    let stdout = ''
    let stderr = ''
    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (text: string) => {
      if (done) return
      done = true
      // 收尾时把定时器和 abort 监听一起摘掉：否则一次取消会在后台留下一个空转的定时器
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(trim(text, MAX_OUTPUT))
    }
    timer = setTimeout(() => {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
      } catch {
        child.kill()
      }
      finish(`${stdout}\n[超时 ${timeout}ms，进程已终止]`)
    }, timeout)

    const onAbort = () => {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
      } catch {
        child.kill()
      }
      finish(`${stdout}\n[已取消]`)
    }
    signal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT * 2) stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`无法启动命令（${bin}，工作目录 ${root}）：${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      const parts = [stdout.trim()]
      if (stderr.trim()) parts.push(`[stderr]\n${stderr.trim()}`)
      parts.push(`[exit code: ${code ?? 'null'}]`)
      finish(parts.filter(Boolean).join('\n'))
    })
  })
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
      return readFileTool(root, args, allowOutside)
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
      const file = path.resolve(root, String(args.path ?? ''))
      const line = Number(args.line) || 0
      const col = Number(args.col) || 1
      if (!file || !line) throw new Error('goto_definition 需要 path 和 line')
      const defs = await gotoDefinition(root, file, line, col)
      if (!defs.length) return '没找到定义（该位置可能不是符号，或超出 TS/JS 项目范围）。'
      return defs
        .map((d, i) => `${i + 1}. ${relPath(d.file, root)}:${d.line}:${d.col}${d.snippet ? `\n   ${d.snippet}` : ''}`)
        .join('\n')
    }
    case 'find_references': {
      const file = path.resolve(root, String(args.path ?? ''))
      const line = Number(args.line) || 0
      const col = Number(args.col) || 1
      if (!file || !line) throw new Error('find_references 需要 path 和 line')
      const r = await findReferences(root, file, line, col)
      if (!r.refs.length) return '没找到引用。'
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
      const files = paths.map((p) => path.resolve(root, p)).filter((f) => existsSync(f))
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
