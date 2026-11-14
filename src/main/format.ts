/**
 * 格式化与 lint：写文件之后顺手把格式对齐，把 lint 错误当场还回去。
 *
 * 原则：
 * - **只用项目里已经装好的工具**。没装 prettier 就不装，退到下一个候选；
 *   一个都没有就静默跳过，绝不为格式化去联网下载东西。
 * - **只动刚写过的文件**。不跑 `prettier .`、不碰用户没改的文件。
 * - **永不抛错**。格式化失败不应该让一次成功的写入变成失败。
 *
 * 工具选择：
 *   js/ts/json/css/html/md → prettier（node_modules/.bin）
 *   go                    → gofmt
 *   py                    → ruff format → black
 *   rs                    → rustfmt
 *   java                  → 不做（没有通用的、无争议的格式化器）
 */
import { execFile } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { safeEnv } from './tools/env'

export interface FormatResult {
  ok: boolean
  /** 内容真的变了的文件（相对工作区） */
  formatted: string[]
  /** 一行结论，给模型/界面看 */
  message: string
}

export interface LintResult {
  ok: boolean
  /** 问题条数 */
  count: number
  /** 已经压成短文本的结果，空表示没问题 */
  text: string
}

interface RunOut {
  ok: boolean
  missing: boolean
  out: string
  err: string
}

function run(cmd: string, args: string[], cwd: string, timeout: number): Promise<RunOut> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout, windowsHide: true, env: safeEnv(), maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ ok: false, missing: true, out: '', err: '' })
          return
        }
        resolve({ ok: !error, missing: false, out: String(stdout ?? ''), err: String(stderr ?? '') })
      }
    )
  })
}

/** node_modules/.bin 下的可执行文件（Windows 是 .cmd） */
function localBin(workspace: string, name: string): string | null {
  const file = process.platform === 'win32' ? `${name}.cmd` : name
  const p = path.join(workspace, 'node_modules', '.bin', file)
  return existsSync(p) ? p : null
}

function extOf(file: string): string {
  return path.extname(file).toLowerCase()
}

const PRETTIER_EXT = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonc', '.css', '.scss', '.less', '.vue', '.svelte'
])
const PRETTIER_DOC_EXT = new Set(['.md', '.mdx', '.html', '.htm', '.yml', '.yaml'])

function prettierTouches(file: string): boolean {
  const ext = extOf(file)
  return PRETTIER_EXT.has(ext) || PRETTIER_DOC_EXT.has(ext)
}

function formatterFor(file: string): 'prettier' | 'gofmt' | 'ruff' | 'black' | 'rustfmt' | null {
  const ext = extOf(file)
  if (prettierTouches(file)) return 'prettier'
  if (ext === '.go') return 'gofmt'
  if (ext === '.py' || ext === '.pyi') return 'ruff'
  if (ext === '.rs') return 'rustfmt'
  return null
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * 格式化一批文件。返回真正发生变化的文件列表。
 * includeDocs=false 时不碰 md/html/yaml（自动路径用，避免改用户文档的排版）。
 */
export async function formatFiles(
  workspace: string,
  files: string[],
  opts: { includeDocs?: boolean } = {}
): Promise<FormatResult> {
  const includeDocs = opts.includeDocs === true
  const targets = files.filter((f) => existsSync(f) && formatterFor(f) !== null)
  const docs = (f: string): boolean => PRETTIER_DOC_EXT.has(extOf(f))
  const usable = targets.filter((f) => includeDocs || !docs(f))
  if (usable.length === 0) return { ok: true, formatted: [], message: '' }

  const before = new Map<string, string | null>()
  for (const f of usable) before.set(f, await readOrNull(f))

  const groups = new Map<string, string[]>()
  for (const f of usable) {
    const tool = formatterFor(f)!
    const list = groups.get(tool) ?? []
    list.push(f)
    groups.set(tool, list)
  }

  const notes: string[] = []
  let failed = false
  for (const [tool, list] of groups) {
    if (tool === 'prettier') {
      const bin = localBin(workspace, 'prettier')
      if (!bin) {
        notes.push('没有找到本地 prettier，跳过')
        continue
      }
      const r = await run(bin, ['--write', ...list], workspace, 60_000)
      if (!r.ok && r.err.trim()) {
        failed = true
        notes.push(`prettier：${r.err.trim().split(/\r?\n/)[0]}`)
      }
    } else if (tool === 'gofmt') {
      const r = await run('gofmt', ['-w', ...list], workspace, 60_000)
      if (r.missing) notes.push('没有安装 gofmt，跳过')
      else if (!r.ok && r.err.trim()) {
        failed = true
        notes.push(`gofmt：${r.err.trim().split(/\r?\n/)[0]}`)
      }
    } else if (tool === 'ruff') {
      const r = await run('ruff', ['format', ...list], workspace, 60_000)
      if (r.missing) {
        const blackBin = localBin(workspace, 'black')
        const b = blackBin
          ? await run(blackBin, ['-q', ...list], workspace, 60_000)
          : await run('black', ['-q', ...list], workspace, 60_000)
        if (b.missing) notes.push('没有安装 ruff / black，跳过')
        else if (!b.ok && b.err.trim()) {
          failed = true
          notes.push(`black：${b.err.trim().split(/\r?\n/)[0]}`)
        }
      } else if (!r.ok && r.err.trim()) {
        failed = true
        notes.push(`ruff format：${r.err.trim().split(/\r?\n/)[0]}`)
      }
    } else if (tool === 'rustfmt') {
      const r = await run('rustfmt', list, workspace, 60_000)
      if (r.missing) notes.push('没有安装 rustfmt，跳过')
      else if (!r.ok && r.err.trim()) {
        failed = true
        notes.push(`rustfmt：${r.err.trim().split(/\r?\n/)[0]}`)
      }
    }
  }

  const formatted: string[] = []
  for (const f of usable) {
    const after = await readOrNull(f)
    if (after !== before.get(f)) formatted.push(path.relative(workspace, f).split(path.sep).join('/'))
  }

  const ok = !failed
  const message =
    formatted.length > 0
      ? `[格式化] ${formatted.length} 个文件已按项目格式化器对齐：${formatted.slice(0, 6).join('、')}${formatted.length > 6 ? ' …' : ''}`
      : notes.length
        ? `[格式化] ${notes.join('；')}`
        : ''
  return { ok, formatted, message }
}

/**
 * 跑 lint（不自动修）。只回问题，不回「通过」——和诊断回灌保持同样的克制。
 * eslint / ruff 都是项目里装了才跑，没装就跳过。
 */
export async function lintFiles(workspace: string, files: string[]): Promise<LintResult> {
  const targets = files.filter((f) => existsSync(f))
  if (targets.length === 0) return { ok: true, count: 0, text: '' }

  const tsish = targets.filter((f) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte)$/i.test(f))
  const pyish = targets.filter((f) => /\.(py|pyi)$/i.test(f))
  const chunks: string[] = []
  let count = 0

  if (tsish.length) {
    const bin = localBin(workspace, 'eslint')
    if (bin) {
      const r = await run(bin, ['--no-color', '--format=compact', ...tsish], workspace, 60_000)
      const text = `${r.out}\n${r.err}`.trim()
      if (text) {
        chunks.push(text.split(/\r?\n/).slice(0, 20).join('\n'))
        count += text.split(/\r?\n/).filter((l) => /\berror\b/i.test(l)).length
      }
    }
  }

  if (pyish.length) {
    const r = await run('ruff', ['check', '--output-format=concise', '--quiet', ...pyish], workspace, 30_000)
    const text = `${r.out}\n${r.err}`.trim()
    if (!r.missing && text) {
      chunks.push(text.split(/\r?\n/).slice(0, 20).join('\n'))
      count += text.split(/\r?\n/).filter(Boolean).length
    }
  }

  return { ok: count === 0, count, text: chunks.join('\n\n') }
}
