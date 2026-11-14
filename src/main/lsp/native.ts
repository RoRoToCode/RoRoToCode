/**
 * 非 TS/JS 语言的诊断后端：不启动语言服务器，直接跑项目自带的检查命令。
 *
 * 为什么这么做：
 * - tsserver 只认 TypeScript/JavaScript；Python/Rust/Go/Java 项目写完文件后
 *   目前拿不到任何编译反馈，模型只能靠自己「看」，改坏了要等收尾才发现。
 * - 起一套真 LSP（pyright / rust-analyzer / gopls / jdtls）要额外进程、额外内存、
 *   额外协议实现，而这里真正需要的只是「改完这个文件，它现在还编不编得过」。
 * - 项目自带的检查命令（ruff / go vet / cargo check / javac）本来就是作者认可的
 *   判定标准，比外挂一个可能和项目配置不一致的 LSP 更准。
 *
 * 设计约束：
 * - **永不抛错**。诊断是锦上添花，工具没装、超时、项目没配置，一律返回空。
 * - **有冷却**。go vet / cargo check 是项目级命令，比 tsserver 慢一个量级；
 *   同一个工作区 20 秒内不重复跑，避免连续写文件时反复全量检查。
 * - **只报 error**。和 TS 那条链路保持一致，warning 混进来会把真正的错误淹掉。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Diag } from '../../shared/diagnostics'
import { safeEnv } from '../tools/env'

type Lang = 'python' | 'go' | 'rust' | 'java'

interface RunOut {
  /** 0 = 成功；127 = 命令不存在；其它 = 命令失败 */
  code: number
  stdout: string
  stderr: string
}

function run(cmd: string, args: string[], cwd: string, timeout: number): Promise<RunOut> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout, windowsHide: true, env: safeEnv(), maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ code: 127, stdout: '', stderr: '' })
          return
        }
        resolve({ code: err ? 1 : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })
}

export function langOf(file: string): Lang | null {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.py' || ext === '.pyi') return 'python'
  if (ext === '.go') return 'go'
  if (ext === '.rs') return 'rust'
  if (ext === '.java') return 'java'
  return null
}

/** 从 file 所在目录向上找工作区标记文件（go.mod / Cargo.toml） */
function findUp(start: string, marker: string): string | null {
  let dir = path.resolve(start)
  for (let i = 0; i < 16; i++) {
    if (existsSync(path.join(dir, marker))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function toAbs(file: string, root: string): string {
  if (path.isAbsolute(file)) return path.normalize(file)
  return path.resolve(root, file)
}

/**
 * 通用的 `文件:行:列: 信息` 解析。ruff / go vet / cargo short / javac 都是这个形状。
 * 有些工具会在信息前带 `error:` 或 `error[E0308]:`，统一剥掉。
 */
function parseColonDiags(text: string, root: string, source: string): Diag[] {
  const out: Diag[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^(.+?):(\d+):(\d+):\s*(?:error(?:\[[^\]]+\])?:?\s*)?(.+)$/.exec(line.trim())
    if (!m) continue
    const [, file, lineNo, colNo, msg] = m
    // 只收看起来像源码路径的行，避免把命令行回显当成诊断
    if (!/\.(py|pyi|go|rs|java)$/i.test(file)) continue
    out.push({
      file: toAbs(file, root),
      line: Math.max(1, Number(lineNo) || 1),
      col: Math.max(1, Number(colNo) || 1),
      code: 0,
      message: msg.trim(),
      severity: 'error',
      source
    })
  }
  return out
}

/** py_compile 的输出：File "x.py", line 3 / SyntaxError: msg */
function parsePyCompile(text: string, file: string): Diag[] {
  const out: Diag[] = []
  const fileRe = /File "([^"]+)", line (\d+)/g
  let m: RegExpExecArray | null
  while ((m = fileRe.exec(text))) {
    const rest = text.slice(m.index + m[0].length)
    const err = /^\s*\n?[^\n]*\n?\s*(SyntaxError|IndentationError|TabError):\s*(.+)$/m.exec(rest)
    out.push({
      file: path.normalize(m[1] || file),
      line: Math.max(1, Number(m[2]) || 1),
      col: 1,
      code: 0,
      message: err ? `${err[1]}: ${err[2].trim()}` : 'Python 语法错误',
      severity: 'error',
      source: 'py_compile'
    })
  }
  return out
}

async function pythonDiags(workspace: string, files: string[]): Promise<Diag[]> {
  // 优先 ruff：一次调用检查多个文件，快且带列号
  const r = await run(
    'ruff',
    ['check', '--output-format=concise', '--no-fix', '--quiet', ...files],
    workspace,
    20_000
  )
  if (r.code !== 127) {
    if (r.code === 0) return []
    return parseColonDiags(`${r.stdout}\n${r.stderr}`, workspace, 'ruff')
  }

  // 没装 ruff 就退到 py_compile：只抓语法错误，但零额外依赖
  const out: Diag[] = []
  for (const f of files) {
    const c = await run('python', ['-m', 'py_compile', f], workspace, 15_000)
    if (c.code === 127) break
    if (c.code !== 0) out.push(...parsePyCompile(c.stderr || c.stdout, f))
  }
  return out
}

async function goDiags(workspace: string, files: string[]): Promise<Diag[]> {
  const modRoot = findUp(path.dirname(files[0]), 'go.mod') ?? workspace
  const dirs = new Set<string>()
  for (const f of files) dirs.add(path.dirname(f))

  const out: Diag[] = []
  for (const dir of dirs) {
    const rel = path.relative(modRoot, dir)
    const pkg = rel ? `./${rel.split(path.sep).join('/')}` : '.'
    const r = await run('go', ['vet', pkg], modRoot, 30_000)
    if (r.code === 127) return []
    if (r.code === 0) continue
    out.push(...parseColonDiags(`${r.stdout}\n${r.stderr}`, modRoot, 'go vet'))
  }
  return out
}

async function rustDiags(workspace: string, files: string[]): Promise<Diag[]> {
  const crate = findUp(path.dirname(files[0]), 'Cargo.toml')
  if (!crate) return []
  const r = await run('cargo', ['check', '--message-format=short', '--quiet'], crate, 90_000)
  if (r.code === 127) return []
  if (r.code === 0) return []
  // cargo 的 short 格式：src/main.rs:10:5: error: msg / error[E0308]: msg
  return parseColonDiags(r.stderr, crate, 'cargo check').filter((d) => d.file.startsWith(crate))
}

/**
 * Java 没有「单文件就能给出干净结果」的检查器：javac 编译单文件会对每个 import
 * 报 cannot find symbol。这里只留语法级错误（缺分号、括号不闭合、非法语句等），
 * 依赖缺失类的一律丢掉，宁可少报也不刷屏。
 */
const JAVA_SYNTAX = /(illegal|reached end of file|expected|not a statement|unclosed|invalid method|class, interface|malformed)/i

async function javaDiags(workspace: string, files: string[]): Promise<Diag[]> {
  const out: Diag[] = []
  for (const f of files) {
    const r = await run(
      'javac',
      ['-encoding', 'UTF-8', '-proc:none', '-d', path.join(workspace, '.roro-javac'), f],
      path.dirname(f),
      20_000
    )
    if (r.code === 127) return []
    if (r.code === 0) continue
    for (const d of parseColonDiags(r.stderr, path.dirname(f), 'javac')) {
      if (!JAVA_SYNTAX.test(d.message)) continue
      out.push(d)
    }
  }
  return out
}

/** 项目级检查有冷却：同一工作区 20 秒内不重复跑 */
const lastRun = new Map<string, number>()
const COOLDOWN_MS = 20_000

function cooled(workspace: string, lang: Lang): boolean {
  const key = `${workspace.toLowerCase()}|${lang}`
  const now = Date.now()
  const prev = lastRun.get(key) ?? 0
  if (now - prev < COOLDOWN_MS) return true
  lastRun.set(key, now)
  return false
}

/**
 * 给一批非 TS 文件做诊断。返回空数组 = 没错误 / 工具不可用 / 超时，三者调用方都不用区分。
 */
export async function nativeDiagnose(workspace: string | null, files: string[]): Promise<Diag[]> {
  if (!workspace || files.length === 0) return []
  const groups: Partial<Record<Lang, string[]>> = {}
  for (const f of files) {
    if (!existsSync(f)) continue
    const lang = langOf(f)
    if (!lang) continue
    ;(groups[lang] ??= []).push(f)
  }

  const out: Diag[] = []
  for (const lang of Object.keys(groups) as Lang[]) {
    const targets = groups[lang]!
    // Python 的 ruff/py_compile 很快，不值得冷却；其余是项目级检查
    if (lang !== 'python' && cooled(workspace, lang)) continue
    try {
      if (lang === 'python') out.push(...(await pythonDiags(workspace, targets)))
      else if (lang === 'go') out.push(...(await goDiags(workspace, targets)))
      else if (lang === 'rust') out.push(...(await rustDiags(workspace, targets)))
      else out.push(...(await javaDiags(workspace, targets)))
    } catch {
      // 单种语言挂了不影响其它语言
    }
  }
  return out
}

/** 只用于测试：清掉冷却状态 */
export function resetNativeDiagnostics(): void {
  lastRun.clear()
}
