/**
 * 仓库地图：把工作区扫成一张「有哪些文件、各自导出什么」的索引。
 *
 * 为什么需要：本地模型的上下文只有 8k~32k，靠 grep 一个个词试，很难建立
 * 「这个仓库分几块、入口在哪」的整体认识。索引把这件事变成一次查询：
 * 先看地图定位到几个文件，再精确读内容。
 *
 * 刻意不上 tree-sitter：那是几十 MB 的原生依赖，而这里只需要「顶层符号名」。
 * 用按语言分组的正则提取，够用、零依赖、单文件解析在毫秒级。
 *
 * 纯 Node，不依赖 Electron —— 测试可以直接跑。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface FileNode {
  /** 相对路径，统一用 / 分隔 */
  path: string
  size: number
  mtime: number
  /** 顶层符号（函数 / 类 / 接口 / 导出名），已去重、已截断 */
  symbols: string[]
  /** 一句话说明：优先取文件头注释，其次取第一条有意义的代码 */
  summary: string
}

export interface RepoIndex {
  version: number
  generatedAt: number
  files: FileNode[]
}

const VERSION = 2

/** 这些目录永远不扫：装了依赖的仓库里，node_modules 能占九成文件 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'release',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.idea',
  '.vscode',
  '.roroto',
  'bin',
  'obj',
  'Pods',
  '.gradle'
])

/** 只索引这些扩展名：二进制、图片、锁文件没有符号可提 */
const LANGS: Record<string, 'ts' | 'py' | 'go' | 'rust' | 'java' | 'c' | 'other'> = {
  '.ts': 'ts',
  '.tsx': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.js': 'ts',
  '.jsx': 'ts',
  '.mjs': 'ts',
  '.cjs': 'ts',
  '.py': 'py',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'java',
  '.cs': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'c',
  '.cpp': 'c',
  '.hpp': 'c',
  '.md': 'other',
  '.json': 'other'
}

const MAX_FILES = 8000
const MAX_FILE_BYTES = 400_000
const MAX_DEPTH = 12
const MAX_SYMBOLS = 12
/** 索引本身别长成一个新问题：单文件摘要最多这么多字 */
const MAX_SUMMARY = 100

const IGNORE_FILE_NAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'go.sum',
  'poetry.lock'
])

function langOf(file: string): 'ts' | 'py' | 'go' | 'rust' | 'java' | 'c' | 'other' | null {
  const base = path.basename(file)
  if (IGNORE_FILE_NAMES.has(base)) return null
  return LANGS[path.extname(file).toLowerCase()] ?? null
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]

  while (queue.length && out.length < MAX_FILES) {
    const { dir, depth } = queue.shift()!
    if (depth > MAX_DEPTH) continue
    let entries: Array<import('node:fs').Dirent>
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) break
      if (e.name.startsWith('.') && e.name !== '.github') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        queue.push({ dir: full, depth: depth + 1 })
      } else if (e.isFile()) {
        if (langOf(full)) out.push(full)
      }
    }
  }
  return out
}

/** 从 TS/JS 源码里挑出顶层导出名 */
function tsSymbols(src: string): string[] {
  const out = new Set<string>()
  const res: RegExp[] = [
    /export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /export\s*\{([^}]*)\}/g
  ]
  for (const re of res) {
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      if (m[1] == null) continue
      for (const piece of m[1].split(',')) {
        // `a as b` 取原名；`type X` 去掉 type 前缀
        const name = piece
          .replace(/\btype\b\s*/g, '')
          .split(/\s+as\s+/)[0]
          .trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name) && !out.has(name)) out.add(name)
      }
    }
  }
  return [...out]
}

function genericSymbols(src: string, lang: string): string[] {
  const out = new Set<string>()
  const patterns: RegExp[] =
    lang === 'py'
      ? [/^\s{0,4}(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^\s{0,4}class\s+([A-Za-z_]\w*)/gm]
      : lang === 'go'
        ? [/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm, /^type\s+([A-Z]\w*)/gm]
        : lang === 'rust'
          ? [/^\s*pub\s+(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm, /^\s*pub\s+(?:struct|enum|trait)\s+([A-Za-z_]\w*)/gm]
          : lang === 'java'
            ? [/\b(?:class|interface|enum|record)\s+([A-Z]\w*)/g]
            : [/\b(?:class|struct)\s+([A-Z]\w*)/g, /^[A-Za-z_][\w<>:\s*]*\s+([a-z_]\w*)\s*\(/gm]

  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const name = m[1]
      if (name && !out.has(name)) out.add(name)
    }
  }
  return [...out]
}

/** 文件头注释 → 一句话说明；没有注释就退回第一条有意义的代码 */
function summarize(src: string, lang: string): string {
  const head = src.slice(0, 4000)
  const block = /^\s*\/\*\*?([\s\S]*?)\*\//.exec(head)
  const lines = (block ? block[1] : '').split(/\r?\n/)
  const comment = lang === 'py' ? /^\s*#\s?(.*)$/ : /^\s*(?:\*|\/\/)\s?(.*)$/

  const picked: string[] = []
  const source = block ? lines : head.split(/\r?\n/).slice(0, 25)
  for (const raw of source) {
    const m = comment.exec(raw)
    const text = (m ? m[1] : block ? raw : '').trim()
    if (!text) {
      if (picked.length) break
      continue
    }
    // `@param`、`@returns` 这类不是描述
    if (text.startsWith('@')) continue
    if (block && /^(eslint|ts-|prettier)/.test(text)) continue
    picked.push(text)
    if (!block && picked.length >= 1) break
    if (picked.join(' ').length > MAX_SUMMARY) break
  }

  let text = picked.join(' ').replace(/\s+/g, ' ').trim()
  if (!text) {
    // 没有文件头注释：优先找第一条「声明」行（比第一行 import 有用得多）
    const body = head.split(/\r?\n/)
    const decl = body.find((l) =>
      /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:public\s+|private\s+|static\s+)*(?:class|function|interface|type|enum|const|let|def|func|struct|impl|trait|record)\b/.test(
        l
      )
    )
    const first = decl ?? body.find((l) => l.trim() && !/^\s*(?:import|from|#!|"use |'use )/.test(l))
    text = (first ?? '').trim()
  }
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY)}…` : text
}

export function extractSymbols(src: string, file: string): { symbols: string[]; summary: string } {
  const lang = langOf(file)
  if (!lang || lang === 'other') return { symbols: [], summary: '' }
  const symbols = (lang === 'ts' ? tsSymbols(src) : genericSymbols(src, lang)).slice(0, MAX_SYMBOLS)
  return { symbols, summary: summarize(src, lang) }
}

function toRel(root: string, full: string): string {
  return path.relative(root, full).split(path.sep).join('/')
}

export function indexPath(root: string): string {
  return path.join(root, '.roroto', 'index.json')
}

/** 读缓存；文件已变的部分在这里被替换，不必整仓重扫 */
async function loadCache(root: string): Promise<Map<string, FileNode>> {
  const map = new Map<string, FileNode>()
  try {
    const raw = JSON.parse(await fs.readFile(indexPath(root), 'utf8')) as RepoIndex
    if (raw.version !== VERSION) return map
    for (const f of raw.files) map.set(f.path, f)
  } catch {
    // 没有缓存 / 缓存坏了：当空的处理，全量重建
  }
  return map
}

/**
 * 建/更新索引。
 *
 * 增量策略：按 size + mtime 判断文件是否变过，没变就复用旧条目。
 * 3000 个文件的全量解析约 1~3 秒，增量通常只有几十毫秒。
 */
export async function buildIndex(root: string, opts: { force?: boolean } = {}): Promise<RepoIndex> {
  if (!root) return { version: VERSION, generatedAt: Date.now(), files: [] }
  const previous = opts.force ? new Map<string, FileNode>() : await loadCache(root)
  const abs = await walk(root)
  const files: FileNode[] = []

  for (const full of abs) {
    const rel = toRel(root, full)
    let st: import('node:fs').Stats
    try {
      st = await fs.stat(full)
    } catch {
      continue
    }
    if (st.size > MAX_FILE_BYTES) continue

    const old = previous.get(rel)
    if (old && old.size === st.size && old.mtime === st.mtimeMs) {
      files.push(old)
      continue
    }

    try {
      const src = await fs.readFile(full, 'utf8')
      const { symbols, summary } = extractSymbols(src, rel)
      files.push({ path: rel, size: st.size, mtime: st.mtimeMs, symbols, summary })
    } catch {
      files.push({ path: rel, size: st.size, mtime: st.mtimeMs, symbols: [], summary: '' })
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  const index: RepoIndex = { version: VERSION, generatedAt: Date.now(), files }

  try {
    await fs.mkdir(path.dirname(indexPath(root)), { recursive: true })
    await fs.writeFile(indexPath(root), JSON.stringify(index), 'utf8')
  } catch {
    // 写不进去（只读目录）不影响本次查询，只是下次还得重扫
  }
  return index
}

/** 缓存多久算「还新鲜」：太短会反复 stat 全仓，太长会看不到新文件 */
const FRESH_MS = 90_000

export async function loadIndex(root: string): Promise<RepoIndex> {
  try {
    const raw = JSON.parse(await fs.readFile(indexPath(root), 'utf8')) as RepoIndex
    if (raw.version === VERSION && Array.isArray(raw.files) && Date.now() - raw.generatedAt < FRESH_MS) {
      return raw
    }
  } catch {
    // 落到重建
  }
  return buildIndex(root)
}

export interface MapOptions {
  /** 只看这个子路径下（相对路径前缀） */
  path?: string
  /** 关键词：匹配路径或符号名，可空格分隔多个词（全部命中） */
  query?: string
  /** 最多列多少个文件 */
  limit?: number
  /** 是否带上每个文件的一句话说明 */
  summary?: boolean
}

/** 把索引渲染成模型能直接读的紧凑文本 */
export function renderMap(index: RepoIndex, opts: MapOptions = {}): string {
  const limit = Math.max(1, Math.min(400, opts.limit ?? 120))
  const terms = (opts.query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  let files = index.files
  if (opts.path) {
    const prefix = opts.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
    files = files.filter((f) => f.path === prefix || f.path.startsWith(`${prefix}/`))
  }
  if (terms.length) {
    files = files.filter((f) => {
      const hay = `${f.path} ${f.symbols.join(' ')} ${f.summary}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }

  if (!files.length) {
    return opts.query || opts.path
      ? `（索引里没有匹配 ${[opts.path, opts.query].filter(Boolean).join(' / ')} 的文件）`
      : '（这个工作区还没建索引，或里面没有可索引的源码文件）'
  }

  // 按目录分组，省掉每行重复的路径前缀
  const groups = new Map<string, FileNode[]>()
  for (const f of files.slice(0, limit)) {
    const dir = path.posix.dirname(f.path)
    const list = groups.get(dir) ?? []
    list.push(f)
    groups.set(dir, list)
  }

  const lines: string[] = []
  for (const [dir, list] of groups) {
    lines.push(`${dir === '.' ? '(根目录)' : dir}`)
    for (const f of list) {
      const name = path.posix.basename(f.path)
      const syms = f.symbols.length ? `  ${f.symbols.join('、')}` : ''
      const note = opts.summary === false ? '' : f.summary ? `  — ${f.summary}` : ''
      lines.push(`  ${name}${syms}${note}`)
    }
  }

  const head =
    files.length > limit
      ? `共 ${files.length} 个文件，下面只列前 ${limit} 个（用 path / query 缩小范围）`
      : `共 ${files.length} 个文件`
  return `${head}\n\n${lines.join('\n')}`
}
