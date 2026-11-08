import { promises as fs, readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ToolSpec } from './spec'
import { toolSpecs } from './spec'
import { rememberFact } from '../memory'
import { formatTodos, normalizeTodos } from '../../shared/todos'
import { webFetchTool, webSearchTool } from './web'
import { parseApplyPatch } from './applypatch'

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
}

// 风险判定与命令拦截都在 risk.ts（纯函数，可单测），这里只做转出，保持既有 import 路径不变
export { classifyRisk, classifyMcpRisk, hardBlockReason, isOutside, applyCustomRules, tokenizeCommand, resourceCandidates, type RiskInfo, type PermissionRule } from '../risk'
import { classifyRisk, hardBlockReason, isOutside, type RiskInfo } from '../risk'
import { safeEnv } from './env'
import { getJob, killJob, listJobs, startBackground, tailLog } from './shellbg'

export function isDangerous(tool: string): boolean {
  return tool === 'write_file' || tool === 'edit_file' || tool === 'patch' || tool === 'run_shell'
}

export function summarize(tool: string, args: Record<string, unknown>): string {
  if (tool === 'run_shell') return String(args.command ?? '')
  if (tool === 'write_file' || tool === 'edit_file') return String(args.path ?? '')
  if (tool === 'patch') {
    const edits = Array.isArray(args.edits) ? args.edits.length : 0
    const fromText = typeof args.patch === 'string' && args.patch.trim() ? 'patch 文本' : ''
    return edits > 0 ? `patch ${edits} 处改动` : fromText || 'patch'
  }
  if (tool === 'web_fetch') return String(args.url ?? '')
  if (tool === 'web_search') return String(args.query ?? '')
  if (tool === 'remember') return String(args.note ?? '').slice(0, 120)
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

function trim(text: string, limit = MAX_READ): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n\n…（内容过长已截断，共 ${text.length} 字符）`
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
    return trim(lines.slice(start, end).join('\n'))
  }
  return trim(text)
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
  const updated = args.replace_all ? original.split(oldText).join(newText) : original.replace(oldText, newText)
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
        : original.replace(oldText, String(edit.new_string ?? ''))
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
  const after = args.replace_all ? before.split(oldText).join(newText) : before.replace(oldText, newText)
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
        out.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
        if (out.length >= MAX_GREP_MATCHES) break
      }
    }
  }
  return out.join('\n') || '（没有匹配结果）'
}

function runShellTool(root: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const command = String(args.command ?? '').trim()
  if (!command) throw new Error('command 不能为空')
  if (!existsSync(root)) {
    throw new Error(`工作区目录不存在或不可访问：${root}。请重新选择工作区后再执行命令。`)
  }
  const shell = String(args.shell ?? 'cmd')
  const timeout = Math.min(Math.max(Number(args.timeout_ms ?? 120000), 1000), 600000)

  // 极少数不可逆命令直接拒，不弹确认框：这类操作不该交给助手代跑
  const blocked = hardBlockReason(command)
  if (blocked) {
    throw new Error(
      `已拒绝执行：这条命令属于「${blocked}」。它是不可逆操作，请你自己确认后在终端里手动执行。`
    )
  }

  // 后台模式：立刻返回任务 id，长任务不会再把工具调用拖到超时
  if (args.background === true) {
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
    const finish = (text: string) => {
      if (done) return
      done = true
      resolve(trim(text, MAX_OUTPUT))
    }
    const timer = setTimeout(() => {
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
    case 'web_search':
      return webSearchTool(args, ctx.signal)
    case 'web_fetch':
      return webFetchTool(args, ctx.signal)
    case 'update_todos': {
      // 真正的状态存在引擎里（agent.ts 会先拦截），这里只兜底给个回执
      return formatTodos(normalizeTodos(args.items))
    }
    case 'remember': {
      const r = await rememberFact(root, String(args.note ?? ''))
      return r.added
        ? `已写入项目长期记忆，当前共 ${r.count} 条。下次对话会自动带上。`
        : `这条记忆已经存在（共 ${r.count} 条），没有重复写入。`
    }
    default:
      throw new Error(`未知工具：${name}`)
  }
}

export { toolSpecs }
export type { ToolSpec }
