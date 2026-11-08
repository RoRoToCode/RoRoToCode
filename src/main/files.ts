import { BrowserWindow, dialog } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config'
import { mt } from './i18n'
import type { FileAttachment, FileKind } from '../shared/types'

/** 附件落在工作区的哪个子目录 */
const INBOX = 'inbox'
/** 超过这个体积就不再复制，直接把原路径交给模型（复制会长时间卡住界面） */
const MAX_COPY = 1.5 * 1024 * 1024 * 1024

const KIND_BY_EXT: Record<string, FileKind> = {}
const put = (kind: FileKind, exts: string[]) => exts.forEach((e) => (KIND_BY_EXT[e] = kind))

put('image', ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'ico', 'heic', 'tif', 'tiff'])
put('pdf', ['pdf'])
put('doc', ['doc', 'docx', 'rtf', 'odt', 'wps', 'pages'])
put('sheet', ['xls', 'xlsx', 'csv', 'tsv', 'ods', 'et'])
put('slide', ['ppt', 'pptx', 'odp', 'key', 'dps'])
put('text', ['txt', 'md', 'markdown', 'log', 'ini', 'env', 'rst'])
put('code', [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs',
  'go', 'rs', 'rb', 'php', 'swift', 'kt', 'sh', 'bat', 'ps1', 'sql', 'json', 'yaml',
  'yml', 'toml', 'xml', 'html', 'css', 'scss', 'vue'
])
put('archive', ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'])
put('audio', ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac'])
put('video', ['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'wmv'])

const LABEL: Record<FileKind, string> = {
  image: '图片',
  pdf: 'PDF',
  doc: '文档',
  sheet: '表格',
  slide: '幻灯片',
  text: '文本',
  code: '代码',
  archive: '压缩包',
  audio: '音频',
  video: '视频',
  other: '文件'
}

export function kindOf(name: string): FileKind {
  const ext = path.extname(name).replace(/^\./, '').toLowerCase()
  return KIND_BY_EXT[ext] ?? 'other'
}

function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p)
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 同名文件加 -1 / -2，避免把上一次拖进来的同名文件悄悄覆盖 */
async function freeName(dir: string, name: string): Promise<string> {
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length) || 'file'
  let candidate = name
  for (let i = 1; i < 200; i++) {
    const exists = await fs
      .access(path.join(dir, candidate))
      .then(() => true)
      .catch(() => false)
    if (!exists) return candidate
    candidate = `${base}-${i}${ext}`
  }
  return `${base}-${Date.now()}${ext}`
}

async function describe(absPath: string, workspace: string | null): Promise<FileAttachment | { error: string }> {
  let stat
  try {
    stat = await fs.stat(absPath)
  } catch {
    return { error: `${path.basename(absPath)}：文件不存在或没有权限` }
  }
  if (!stat.isFile()) return { error: `${path.basename(absPath)}：不是文件（文件夹暂不支持）` }

  const name = path.basename(absPath)
  const kind = kindOf(name)
  let finalAbs = absPath
  let modelPath = absPath
  let copied = false

  if (workspace) {
    if (isInside(workspace, absPath)) {
      modelPath = path.relative(workspace, absPath).split(path.sep).join('/')
    } else if (stat.size <= MAX_COPY) {
      try {
        const dir = path.join(workspace, INBOX)
        await fs.mkdir(dir, { recursive: true })
        const dest = path.join(dir, await freeName(dir, name))
        await fs.copyFile(absPath, dest)
        finalAbs = dest
        modelPath = `${INBOX}/${path.basename(dest)}`
        copied = true
      } catch {
        // 复制失败就退回原路径，至少还能用
        modelPath = absPath
      }
    }
  }

  return {
    id: `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: copied ? path.basename(finalAbs) : name,
    path: modelPath,
    absPath: finalAbs,
    size: stat.size,
    kind,
    kindLabel: LABEL[kind],
    copied
  }
}

export async function attachFiles(paths: string[]): Promise<{
  items: FileAttachment[]
  errors: string[]
}> {
  const list = (paths ?? []).map((p) => String(p || '').trim()).filter(Boolean)
  if (!list.length) return { items: [], errors: [] }

  const cfg = await loadConfig()
  const workspace = cfg.workspace && cfg.workspace.trim() ? cfg.workspace : null

  const items: FileAttachment[] = []
  const errors: string[] = []
  for (const p of list) {
    const res = await describe(path.resolve(p), workspace)
    if ('error' in res) errors.push(res.error)
    else items.push(res)
  }
  return { items, errors }
}

export async function pickFiles(parent: BrowserWindow | null): Promise<{
  items: FileAttachment[]
  errors: string[]
}> {
  const options = {
    title: mt('选择要发给模型的文件'),
    buttonLabel: mt('添加'),
    properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
    filters: [
      {
        name: mt('常用文件'),
        extensions: [
          'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx',
          'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg',
          'txt', 'md', 'json', 'yaml', 'log', 'zip', 'mp3', 'mp4'
        ]
      },
      { name: mt('所有文件'), extensions: ['*'] }
    ]
  }
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return { items: [], errors: [] }
  return await attachFiles(result.filePaths)
}

/* ---------- 工作区文件清单：输入框里 @ 引用时用 ---------- */

const SKIP_DIR = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'target',
  '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'coverage', '.cache',
  '.turbo', 'release', 'dist-build1', 'models'
])

interface WalkHit {
  path: string
  name: string
  dir: string
}

/**
 * 列出工作区里的文件（相对路径），按关键词过滤。
 * 只走到第 6 层、最多 6000 个文件，避免在超大仓库里卡住输入。
 */
export async function searchWorkspaceFiles(
  root: string,
  query = ''
): Promise<Array<{ path: string; name: string; dir: string }>> {
  const q = query.trim().toLowerCase().replace(/\\/g, '/')
  const out: WalkHit[] = []
  let seen = 0

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6 || seen > 6000 || out.length >= 400) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (seen++ > 6000) return
      if (e.name.startsWith('.') && e.name !== '.gitignore') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name) || /^dist-build\d+$/.test(e.name)) continue
        await walk(full, depth + 1)
        continue
      }
      const rel = path.relative(root, full).replace(/\\/g, '/')
      if (q && !rel.toLowerCase().includes(q)) continue
      out.push({ path: rel, name: e.name, dir: path.dirname(rel).replace(/\.$/, '') })
    }
  }

  await walk(root, 0)
  // 前缀命中排前面，其次是短路径（更好点）
  out.sort((a, b) => {
    const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1
    const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1
    return ap - bp || a.path.length - b.path.length
  })
  return out.slice(0, 40)
}
