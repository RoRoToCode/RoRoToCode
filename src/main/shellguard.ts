/**
 * run_shell 的写源码护栏 + 变更检测。
 *
 * 为什么需要这一层：所有「写文件」的门禁（单次写入上限、HTML 语法校验、浏览器打开
 * 验收、变更快照、投入产出比熔断）都挂在 write_file / edit_file / patch 上。
 * 但模型完全可以绕开它们：
 *
 *     sed -i 's/xxx/yyy/' index.html
 *     python -c "open('index.html','a').write(...)"
 *     echo ... > index.html
 *
 * 实测里这三条一次都没被拦过 —— 因为从工具层看，它们只是「跑了一条命令」。
 * 于是十几行坏代码直接落盘，验收门禁毫不知情，模型还以为自己改对了。
 *
 * 分两层解决，缺一不可：
 *  1. `detectShellWrite` 在**执行前**拦掉那些明确的「一行命令改源码」，
 *     并把「用 write_file / edit_file」这条正路直接写进报错里；
 *  2. `snapshotSources` / `changedSources` 在**执行后**按文件系统事实（mtime+size）
 *     找出被改动的源码，让调用方把同一套门禁补跑一遍 —— 脚本生成、构建产物改写
 *     这些拦不干净的情况，靠这一层兜住。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * 会被当成「源码」的扩展名。
 *
 * 只认这些：日志、临时文件、构建产物不应该触发写入门禁，
 * 否则 `npm run build > build.log` 这种正常操作都会被拦。
 */
const SOURCE_EXT = new Set([
  '.html', '.htm', '.xhtml',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte',
  '.css', '.scss', '.sass', '.less',
  '.json', '.jsonc', '.md', '.mdx',
  '.py', '.sh', '.ps1', '.bat', '.cmd', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp'
])

/** 这些目录里的东西不算用户源码：依赖、版本库、构建输出、缓存 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'release', 'coverage',
  '__pycache__', '.venv', 'venv', '.next', '.nuxt', '.cache', 'target', '.turbo',
  '.workbuddy', '.idea', '.vscode'
])

/** 快照上限：宁可漏掉超大工作区里的改动，也不能让每次 run_shell 都付出一次全盘遍历 */
const MAX_SNAPSHOT_FILES = 4000
const MAX_SNAPSHOT_DEPTH = 8
/** 超过这个大小的文件不存内容：只记 mtime/size，用于判定「变了」，不用于生成 diff */
const MAX_SNAPSHOT_BYTES = 512 * 1024
const MAX_SNAPSHOT_TOTAL_BYTES = 8 * 1024 * 1024

export interface ShellWriteVerdict {
  /** 这条命令是否要写源码文件 */
  mutating: boolean
  /** 命中的写法（给用户/模型看的原话） */
  reason?: string
  /** 涉及的文件（能静态确定才有） */
  targets?: string[]
}

const NOT_WRITING: ShellWriteVerdict = { mutating: false }

function isSourcePath(p: string): boolean {
  const clean = p.replace(/^["']|["']$/g, '').trim()
  if (!clean) return false
  if (/[*?]/.test(clean)) return true // 通配符一律按「可能命中源码」处理
  const ext = path.extname(clean).toLowerCase()
  return SOURCE_EXT.has(ext)
}

/** 从命令里提取「被写入的路径」：重定向、sed -i、tee、cp/mv 目标等 */
function writtenPaths(command: string): string[] {
  const out: string[] = []
  const push = (p?: string): void => {
    if (!p) return
    const clean = p.replace(/^["']|["']$/g, '').trim()
    if (clean && clean !== '/dev/null' && clean !== 'NUL') out.push(clean)
  }
  // > file / >> file。排除 2>&1 / &> 这类 fd 复制（否则每条安静命令都会被当成写文件）
  for (const m of command.matchAll(/(^|[^0-9&])>>?\s*("[^"]*"|'[^']*'|[^\s;&|>]+)/g)) push(m[2])
  // sed -i / perl -pi 后面的文件名
  const sed = /\b(?:sed|perl)\b[^;&|]*\s-i\S*[^;&|]*?\s("?[^\s;&|]+"?)\s*$/i.exec(command)
  if (sed) push(sed[1])
  for (const m of command.matchAll(/\bsed\s+-i\S*\s+(?:-\S+\s+)*'[^']*'\s+("?[^\s;&|]+"?)/gi)) push(m[1])
  for (const m of command.matchAll(/\bsed\s+-i\S*\s+(?:-\S+\s+)*"[^"]*"\s+("?[^\s;&|]+"?)/gi)) push(m[1])
  // tee file
  for (const m of command.matchAll(/\btee\b(?:\s+-\S+)*\s+("?[^\s;&|]+"?)/gi)) push(m[1])
  // cp / mv / copy / move 的目标（第二个路径参数）
  for (const m of command.matchAll(/\b(?:cp|mv|copy|move|install)\b\s+(?:-\S+\s+)*("?[^\s;&|]+"?)\s+("?[^\s;&|]+"?)/gi)) push(m[2])
  // PowerShell 的写文件 cmdlet
  for (const m of command.matchAll(/\b(?:set-content|add-content|out-file|new-item)\b[^;&|]*-path\s+("?[^\s;&|]+"?)/gi)) push(m[1])
  for (const m of command.matchAll(/\b(?:set-content|add-content|out-file)\b\s+("?[^\s;&|]+"?)/gi)) push(m[1])
  return out
}

/** python / node 内联脚本里直接写文件的痕迹 */
function inlineWriteTargets(command: string): string[] {
  const out: string[] = []
  const isInline = /\b(?:python|python3|py|node)\b[^;&|]*\s-(?:c|e)\b/i.test(command)
  if (!isInline) return out
  // open('x.html','w') / open("x", "a") / Path('x').write_text(...) / writeFileSync('x', ...)
  const re = /\bopen\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][wax]b?['"]|\bPath\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*write|writeFileSync\s*\(\s*['"]([^'"]+)['"]/g
  for (const m of command.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3])
  return out.filter(Boolean)
}

/**
 * 判断一条 shell 命令是否在**改源码文件**。
 *
 * 只拦「明确写某个源码文件」的写法。这里刻意不去猜 `npm run build`、`python gen.py`
 * 这类间接路径 —— 猜错了会把正常开发流程堵死。间接路径由 changedSources 事后兜。
 */
export function detectShellWrite(command: string): ShellWriteVerdict {
  const cmd = command.trim()
  if (!cmd) return NOT_WRITING

  const targets = [...writtenPaths(cmd), ...inlineWriteTargets(cmd)]
  const hits = targets.filter(isSourcePath)
  if (hits.length) {
    return {
      mutating: true,
      reason: hits[0] === targets[0] ? '重定向/命令直接写入' : '内联脚本写入',
      targets: [...new Set(hits)]
    }
  }
  return NOT_WRITING
}

/** 拦下时回给模型的话：必须给出替代写法，否则它只会换个命令再试一次 */
export function shellWriteRefusal(verdict: ShellWriteVerdict): string {
  const list = (verdict.targets ?? []).map((t) => `  - ${t}`).join('\n')
  return [
    '已拒绝执行：这条命令要直接改写源码文件，绕过了写入门禁（单次写入上限、HTML 语法校验、浏览器打开验收）。',
    list ? `涉及：\n${list}` : '',
    '改源码请用工具，不要用 shell：',
    '  1) 小改动：read_file 看清原文 → edit_file 精确替换 old_string',
    '  2) 新建 / 整份重写：write_file（内容超过 16000 字符就分段：先骨架，再 append 追加）',
    '  3) 确实要批量替换多个文件时：一次一个文件地 edit_file，别用 sed -i 一把梭',
    '为什么不能通融：shell 写完不经过任何校验，坏代码直接落盘；而 edit_file 会当场把语法错误、',
    '浏览器报错还给你。绕过它省的那一步，后面要用十几轮重写来还。'
  ]
    .filter(Boolean)
    .join('\n')
}

/** 一个源码文件的快照条目 */
interface SnapshotEntry {
  mtimeMs: number
  size: number
  /** 小文件才存内容，用来生成「改了哪几行」的快照；大文件为 null */
  content: string | null
}

export type SourceSnapshot = Map<string, SnapshotEntry>

/**
 * 给工作区里的源码拍一张快照（绝对路径 → mtime/size/内容）。
 *
 * 只走源码扩展名、跳过依赖与构建目录，并设了文件数上限：
 * 目标是「几百毫秒内完成」，因为每次 run_shell 前后各要拍一次。
 */
export async function snapshotSources(root: string): Promise<SourceSnapshot> {
  const snap: SourceSnapshot = new Map()
  let totalBytes = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_SNAPSHOT_DEPTH || snap.size >= MAX_SNAPSHOT_FILES) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (snap.size >= MAX_SNAPSHOT_FILES) return
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        await walk(abs, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!isSourcePath(entry.name)) continue
      let st
      try {
        st = await fs.stat(abs)
      } catch {
        continue
      }
      let content: string | null = null
      if (st.size <= MAX_SNAPSHOT_BYTES && totalBytes + st.size <= MAX_SNAPSHOT_TOTAL_BYTES) {
        try {
          content = await fs.readFile(abs, 'utf8')
          totalBytes += st.size
        } catch {
          content = null
        }
      }
      snap.set(abs, { mtimeMs: st.mtimeMs, size: st.size, content })
    }
  }
  await walk(root, 0)
  return snap
}

/**
 * 对比快照，返回「这条命令改过的源码文件」以及它们改前的内容。
 *
 * 判据同时看 mtime 和 size：只看 mtime 会被「写入但内容相同」误报（无害），
 * 只看 size 会漏掉等长替换（致命）。两者任一变化都算改过。
 */
export async function changedSources(
  root: string,
  before: SourceSnapshot
): Promise<Array<{ file: string; before: string | null }>> {
  const after = await snapshotSources(root)
  const out: Array<{ file: string; before: string | null }> = []
  for (const [file, now] of after) {
    const old = before.get(file)
    if (old && old.mtimeMs === now.mtimeMs && old.size === now.size) continue
    out.push({ file, before: old ? old.content : null })
  }
  return out
}

/** 这些工具是「跑命令」：执行前后要拍快照 */
export const SHELL_TOOLS = new Set(['run_shell', 'terminal'])

/**
 * 把「shell 改了源码」这件事讲清楚，附在工具结果后面。
 * 语气要像提醒而不是指责：模型下一步就会照这个改。
 */
export function formatShellChangeNote(files: string[], root: string): string {
  const list = files
    .map((f) => `  - ${path.relative(root, f).split(path.sep).join('/')}`)
    .slice(0, 8)
  return [
    `【门禁】这条命令改动了 ${files.length} 个源码文件（不是通过 write_file/edit_file，所以写入门禁没能在事前生效）。`,
    '已按写文件的流程补跑格式化、语法校验和浏览器打开验收，结果见下。',
    '下次请直接用 write_file / edit_file：它们会当场拦住超大写入和语法错误，不用等跑完才发现。',
    ...list
  ].join('\n')
}
