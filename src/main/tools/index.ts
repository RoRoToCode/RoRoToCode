import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ToolSpec } from './spec'
import { toolSpecs } from './spec'
import { rememberFact } from '../memory'
import { formatTodos, normalizeTodos } from '../../shared/todos'
import { webFetchTool, webSearchTool } from './web'

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
export { classifyRisk, hardBlockReason, isOutside, type RiskInfo } from '../risk'
import { classifyRisk, hardBlockReason, isOutside, type RiskInfo } from '../risk'
import { safeEnv } from './env'
import { getJob, killJob, listJobs, startBackground, tailLog } from './shellbg'

export function isDangerous(tool: string): boolean {
  return tool === 'write_file' || tool === 'edit_file' || tool === 'run_shell'
}

export function summarize(tool: string, args: Record<string, unknown>): string {
  if (tool === 'run_shell') return String(args.command ?? '')
  if (tool === 'write_file' || tool === 'edit_file') return String(args.path ?? '')
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
