import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * 工作区卫生：收工时把「模型为了自己验证而临时写的脚本」从交付目录里挪走。
 *
 * 为什么需要它：实测里交付目录最后长这样 —— `index.html`、`snake.html`（成果）
 * 旁边躺着 `gen.py`、`validate_about.py`、`_check.py`、`verify_ttt.js`、`tmp/`、
 * `__pycache__/`。用户打开文件夹看到的是这些，成果反而要找半天。
 *
 * 三条原则，全部为了「宁可少清，也不能误删」：
 *   1. **只清名字一眼就是一次性脚本的**（fix_/check_/validate_/verify_/gen 之类），
 *      正常的 `app.py`、`runtime.ts`、`main.js` 不在判据里；
 *   2. **只清本轮跑出来的**（mtime 晚于本轮开始时间），用户早就在的文件一律不碰；
 *   3. **只搬不删**：一律移到 `<工作区>/.roroto/trash/<时间戳>/` 下保留原相对路径，
 *      万一判错，文件还在，用户自己能拿回来。
 *
 * 唯一的例外是 `__pycache__` / `.pytest_cache` 这类纯缓存目录：它们是「跑一次就会
 * 重新生成」的字节码缓存，直接删——留着只会污染目录，还可能被当成交付物列出来。
 */

/**
 * 一次性脚本的判据。
 *
 * 关键词后面必须是 `-`/`_`/`.`/数字/直接接扩展名，不能是任意字母：
 * 否则 `gen` 会吃掉 `general.ts`、`run` 会吃掉 `runtime.ts`，把用户真正的源码搬走。
 */
const SCRATCH_STEM =
  /^(?:[_~.]?)(?:fix|check|validate|verify|probe|debug|gen|tmp|temp|scratch|try|convert|patch|inspect|dump)(?:[-_.][\w.-]*|\d[\w.-]*)?$/

const SCRIPT_EXT = new Set(['.py', '.js', '.cjs', '.mjs', '.ts', '.sh', '.ps1', '.bat', '.cmd'])

/** 纯缓存目录：可再生成，直接删 */
const CACHE_DIRS = new Set(['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache'])

/** 这些目录绝不进入：依赖、版本库、程序自己的元数据、构建产物 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.roroto',
  'dist',
  'build',
  'out',
  'release',
  '.next',
  'coverage',
  'target',
  'vendor',
  'venv',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache'
])

/** 交付文件：用来判断某个脚本是否被成果引用（被引用就不搬） */
const DELIVERY_EXT = new Set([
  '.html',
  '.htm',
  '.js',
  '.cjs',
  '.mjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.css',
  '.json',
  '.md',
  '.py',
  '.txt',
  '.sh'
])

/** 临时脚本都很小；超过这个体积的更像真正的程序 */
const MAX_SCRATCH_BYTES = 512 * 1024
/** 最多走三层：再深就是别人的项目结构了，不该动 */
const MAX_DEPTH = 3
/** 引用检查的读取预算 */
const MAX_REF_FILES = 80
const MAX_REF_BYTES = 128 * 1024

export function isScratchScript(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase()
  if (!SCRIPT_EXT.has(ext)) return false
  const stem = path.basename(fileName, path.extname(fileName))
  return SCRATCH_STEM.test(stem)
}

/** 名字一眼就是临时目录的：里面的脚本不用再看名字，本来就是一次性的 */
const SCRATCH_DIRS = new Set(['tmp', 'temp', 'scratch', '.tmp', '.temp'])

/**
 * 判一个相对路径是不是「一次性产物」。
 *
 * 除了名字特征，还认「放在 tmp/ 这类目录里」——实测模型会把 `test_ttt_logic.js`
 * 这种名字不规整的脚本丢进 `tmp/`，光看名字会漏。目录里的东西本身就是临时的，
 * 再叠上 mtime / 体积 / 引用三条判据，误伤面很小。
 */
export function isScratchPath(relPath: string): boolean {
  const parts = relPath.split('/')
  const name = parts[parts.length - 1]
  if (SCRATCH_DIRS.has(parts[0].toLowerCase()) && SCRIPT_EXT.has(path.extname(name).toLowerCase())) {
    return true
  }
  return isScratchScript(name)
}

export interface SweepResult {
  /** 被搬走的一次性脚本：相对工作区的路径 */
  moved: string[]
  /** 被删掉的缓存目录：相对工作区的路径 */
  removedDirs: string[]
  /** 搬去哪个子目录（相对工作区），没搬东西时为 null */
  trashDir: string | null
}

const EMPTY: SweepResult = { moved: [], removedDirs: [], trashDir: null }

interface Candidate {
  abs: string
  rel: string
  name: string
  mtimeMs: number
  size: number
}

interface Walk {
  files: Array<{ abs: string; rel: string; name: string; depth: number }>
  dirs: Array<{ abs: string; rel: string }>
}

async function walk(workspace: string): Promise<Walk> {
  const out: Walk = { files: [], dirs: [] }
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.files.length > 4000) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      const rel = path.relative(workspace, abs).split(path.sep).join('/')
      if (e.isDirectory()) {
        if (CACHE_DIRS.has(e.name)) {
          out.dirs.push({ abs, rel })
          continue
        }
        if (SKIP_DIRS.has(e.name)) continue
        // 隐藏目录（.vscode / .idea 之类）不看：里面的脚本不是本轮产物
        if (e.name.startsWith('.')) continue
        await visit(abs, depth + 1)
        continue
      }
      if (!e.isFile()) continue
      out.files.push({ abs, rel, name: e.name, depth })
    }
  }
  await visit(workspace, 0)
  return out
}

/**
 * 找出「被成果引用」的文件名。
 *
 * 判据分两种，因为「提及」和「依赖」不是一回事：
 * - 代码与文档（.md / .json / .js / .ts / .py …）里只要写到这个名字就算数：
 *   README 写着「跑 `python gen_site.py` 重新生成」，那这个脚本就是项目的一部分。
 * - 纯页面（.html / .css）里则必须是真正的引用（src= / href= / import / require）。
 *   实测里 about.html 正文写着「本合集由 gen.py 生成」——那只是句文案，
 *   生成器本身依然是垃圾，不该因为被夸了一句就留下来。
 *
 * 一次误搬的代价（用户找不到自己的脚本）远大于漏搬，所以只要命中就保留。
 */
const HTML_EXT = new Set(['.html', '.htm', '.css'])

function countsAsReference(text: string, name: string, ext: string): boolean {
  if (!text.includes(name)) return false
  if (!HTML_EXT.has(ext)) return true
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:src|href)\\s*=\\s*["'][^"']*${escaped}|(?:import|require)\\s*\\(?\\s*["'][^"']*${escaped}`, 'i').test(
    text
  )
}

async function referencedNames(scanned: Walk, candidates: Set<string>): Promise<Set<string>> {
  const found = new Set<string>()
  let budget = MAX_REF_FILES
  for (const f of scanned.files) {
    if (budget <= 0) break
    if (candidates.has(f.name)) continue
    const ext = path.extname(f.name).toLowerCase()
    if (!DELIVERY_EXT.has(ext)) continue
    let text = ''
    try {
      const stat = await fs.stat(f.abs)
      if (stat.size > MAX_REF_BYTES) continue
      text = await fs.readFile(f.abs, 'utf8')
    } catch {
      continue
    }
    budget--
    for (const name of candidates) {
      if (countsAsReference(text, name, ext)) found.add(name)
    }
  }
  return found
}

/**
 * 清一轮。
 *
 * @param workspace 工作区绝对路径
 * @param since 本轮开始的时间戳；早于它的文件一律不动
 */
export async function sweepWorkspace(workspace: string, since: number): Promise<SweepResult> {
  const root = path.resolve(workspace)
  const now = Date.now()
  // 时钟漂移 / 文件系统精度：留一分钟余量，别把「刚好在本轮开始前写好」的成果算进来
  const cutoff = since - 60_000

  let scanned: Walk
  try {
    scanned = await walk(root)
  } catch {
    return EMPTY
  }
  if (!scanned.files.length && !scanned.dirs.length) return EMPTY

  const candidates: Candidate[] = []
  for (const f of scanned.files) {
    if (!isScratchPath(f.rel)) continue
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(f.abs)
    } catch {
      continue
    }
    if (stat.size > MAX_SCRATCH_BYTES) continue
    if (stat.mtimeMs < cutoff) continue
    candidates.push({ abs: f.abs, rel: f.rel, name: f.name, mtimeMs: stat.mtimeMs, size: stat.size })
  }

  const removedDirs: string[] = []
  for (const d of scanned.dirs) {
    try {
      await fs.rm(d.abs, { recursive: true, force: true })
      removedDirs.push(d.rel)
    } catch {
      // 被占用 / 没权限：跳过，不影响交付
    }
  }

  if (!candidates.length) {
    return { moved: [], removedDirs, trashDir: null }
  }

  const referenced = await referencedNames(scanned, new Set(candidates.map((c) => c.name)))
  const movable = candidates.filter((c) => !referenced.has(c.name))
  if (!movable.length) {
    return { moved: [], removedDirs, trashDir: null }
  }

  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const trashRel = `.roroto/trash/${stamp}`
  const trashAbs = path.join(root, ...trashRel.split('/'))
  const moved: string[] = []
  for (const c of movable) {
    const to = path.join(trashAbs, ...c.rel.split('/'))
    try {
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.rename(c.abs, to)
      moved.push(c.rel)
    } catch {
      // 跨设备 / 被占用：退回复制再删，实在不行就留着
      try {
        await fs.copyFile(c.abs, to)
        await fs.rm(c.abs, { force: true })
        moved.push(c.rel)
      } catch {
        continue
      }
    }
  }

  /**
   * 脚本搬走之后可能留下空目录（实测里 `tmp/` 就是这么来的）。
   * 只删「确实空了」的目录，且逐层往上直到工作区根为止，不碰根目录本身。
   */
  for (const rel of moved) {
    let dir = path.dirname(path.join(root, ...rel.split('/')))
    while (dir.startsWith(root + path.sep)) {
      try {
        const left = await fs.readdir(dir)
        if (left.length) break
        await fs.rmdir(dir)
      } catch {
        break
      }
      dir = path.dirname(dir)
    }
  }

  return { moved, removedDirs, trashDir: moved.length ? trashRel : null }
}

/** 收工提示：让用户知道「那些文件去哪了」 */
export function formatSweep(r: SweepResult): string {
  const bits: string[] = []
  if (r.moved.length) {
    const list = r.moved.length <= 6 ? r.moved.join('、') : `${r.moved.slice(0, 6).join('、')} 等 ${r.moved.length} 个`
    bits.push(`已把本轮的一次性脚本挪到 ${r.trashDir}/（${list}），交付目录里只留成果文件`)
  }
  if (r.removedDirs.length) {
    bits.push(`清掉了 ${r.removedDirs.join('、')} 这类缓存目录`)
  }
  if (!bits.length) return ''
  return `${bits.join('；')}。需要找回的话，文件都在 .roroto/trash 里，没有删除。`
}
