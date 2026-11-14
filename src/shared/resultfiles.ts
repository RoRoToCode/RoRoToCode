/**
 * 「成果文件」判定规则：主进程扫盘与渲染层成果面板共用同一份。
 *
 * 以前这份规则只活在 OutputPanel.tsx 里，而成果面板只认 write_file / edit_file / patch
 * 三个工具的参数 —— 技能通过 run_shell 跑 Python 生成的 docx / xlsx / pdf 一个都收不到，
 * 用户看到的就是「文件明明生成了，面板里没有」。把规则抽出来共用之后，
 * 主进程可以在命令执行前后各扫一次盘，把新落盘的成果也送进同一个面板。
 *
 * 两处刻意不判定的东西：
 * - 源码与脚本是 agent 的执行手段，不是交付物，一次任务写十几个临时脚本很常见；
 * - 依赖 / 缓存 / 虚拟环境目录里不会有用户要的成果，全量扫盘也不该进去。
 */

/** 文档、表格、演示、图片、音视频、压缩包、网页成品 —— 用户能直接拿走的东西 */
export const RESULT_EXT = new Set([
  'txt', 'md', 'markdown', 'rst', 'pdf', 'doc', 'docx', 'odt', 'rtf', 'tex', 'epub', 'mobi', 'azw3',
  'csv', 'tsv', 'xlsx', 'xls', 'ods', 'json', 'yaml', 'yml', 'xml',
  'pptx', 'ppt', 'odp', 'key',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'avif', 'psd',
  'mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'mp4', 'mov', 'mkv', 'webm', 'avi',
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz',
  'html', 'htm'
])

/** 源码与脚本：不算成果，完整改动仍然在「变更」标签里 */
export const CODE_EXT = new Set([
  'py', 'pyw', 'ipynb', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'astro',
  'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'psm1', 'vbs',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'java', 'kt', 'kts', 'scala',
  'go', 'rs', 'rb', 'php', 'lua', 'pl', 'pm', 'r', 'swift', 'dart', 'ex', 'exs', 'erl',
  'clj', 'cljs', 'hs', 'ml', 'mli', 'fs', 'fsx', 'jl', 'sql', 'asm', 's', 'vb', 'groovy'
])

export const NOISE_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', '.next', '.cache', '.idea', '.vscode'
])

/** 成果面板里的一行；主进程扫描出的新文件也用这个形状 */
export interface ResultFile {
  /** 相对工作区的路径（主进程扫描与工具参数统一用相对路径） */
  path: string
  action: 'created' | 'edited'
  at: number
  writes: number
}

export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || p
}

export function extOf(p: string): string {
  const name = baseName(p)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 临时文件、编辑器残留、隐藏文件、依赖目录：任何情况下都不算成果 */
export function isNoisePath(p: string): boolean {
  const name = baseName(p)
  const lower = name.toLowerCase()
  if (!name || name.startsWith('.')) return true
  if (lower === 'thumbs.db' || lower === 'desktop.ini') return true
  if (/^(tmp[_-]|temp[_-]|~\$)/i.test(name)) return true
  if (/\.(tmp|temp|bak|swp|swo|log|lock)$/.test(lower)) return true
  const dirs = p.split(/[\\/]/).slice(0, -1).map((d) => d.toLowerCase())
  return dirs.some((d) => NOISE_DIRS.has(d))
}

export function isResultFile(p: string): boolean {
  const ext = extOf(p)
  return Boolean(ext) && !CODE_EXT.has(ext) && RESULT_EXT.has(ext)
}

/** 只做「去噪 + 只留成果」，不做纯编码会话的兜底 —— 兜底是成果面板的展示策略，扫盘不能用 */
export function filterResultFiles(items: ResultFile[]): ResultFile[] {
  return [...items].sort((a, b) => b.at - a.at).filter((f) => isResultFile(f.path) && !isNoisePath(f.path))
}
