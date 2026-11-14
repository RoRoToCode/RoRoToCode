/**
 * 编译诊断的归一化与回灌文案。
 *
 * 为什么要单独一层：tsserver 吐的是它自己的形状（start/end 用 1-based line + 1-based offset、
 * category 是字符串），而回灌给模型的必须是稳定、克制、可解析的文本。
 * 这一层不碰进程，纯函数，好测。
 *
 * 一条硬规矩：**只报 error，不报 warning / suggestion**。
 * 「未使用的变量」在这类项目里满地都是，混进来会把真正让构建失败的那条淹掉，
 * 模型还会开始修一堆用户根本不在意的风格问题。
 */

export type DiagSeverity = 'error' | 'warning' | 'suggestion'

export interface Diag {
  /** 绝对路径 */
  file: string
  /** 1-based */
  line: number
  /** 1-based */
  col: number
  code: number
  message: string
  severity: DiagSeverity
  source?: string
}

/** tsserver 的 Diagnostic 形状（只取用得到的字段） */
export interface RawTsDiagnostic {
  start?: { line?: number; offset?: number } | null
  end?: { line?: number; offset?: number } | null
  text?: string
  code?: number
  category?: string
  source?: string
}

const SEVERITY: Record<string, DiagSeverity> = {
  error: 'error',
  warning: 'warning',
  suggestion: 'suggestion',
  message: 'suggestion'
}

/** 把 tsserver 的一条诊断转成我们的形状；认不出来返回 null */
export function normalizeDiag(file: string, raw: RawTsDiagnostic): Diag | null {
  if (!raw || typeof raw.text !== 'string') return null
  const line = Math.max(1, Math.round(Number(raw.start?.line) || 1))
  const col = Math.max(1, Math.round(Number(raw.start?.offset) || 1))
  const code = Math.round(Number(raw.code) || 0)
  return {
    file,
    line,
    col,
    code,
    // 诊断文本可能带换行（多行类型展开），压成一行，否则列表读起来是断的
    message: raw.text.replace(/\s*\r?\n\s*/g, ' ').trim(),
    severity: SEVERITY[String(raw.category ?? '').toLowerCase()] ?? 'error',
    source: raw.source
  }
}

/** 同一位置同一条错误可能被重复推送（syntax 和 semantic 各来一次），按 文件+行列+码 去重 */
export function dedupe(list: Diag[]): Diag[] {
  const seen = new Set<string>()
  const out: Diag[] = []
  for (const d of list) {
    const key = `${d.file}|${d.line}|${d.col}|${d.code}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(d)
  }
  return out
}

/** 只留 error。warning 一律不回灌，理由见文件头 */
export function errorsOnly(list: Diag[]): Diag[] {
  return dedupe(list.filter((d) => d.severity === 'error'))
}

/** 把绝对路径变成相对工作区的写法：模型看到的越短，越不会照抄一长串盘符 */
export function relPath(file: string, workspace?: string | null): string {
  if (!workspace) return file
  const ws = workspace.replace(/[\\/]+$/, '')
  const norm = (s: string) => s.replace(/\\/g, '/')
  const f = norm(file)
  const w = norm(ws)
  // Windows 盘符大小写可能不一致
  if (f.toLowerCase().startsWith(w.toLowerCase() + '/')) return f.slice(w.length + 1)
  return file
}

/**
 * 回灌给模型的那段文字。空数组返回空串 —— 调用方据此决定「不追加任何东西」。
 *
 * 措辞上刻意写「刚刚改完就检查」而不是「构建失败」：这是编辑器级的增量检查，
 * 不是跑了一遍完整构建。说成构建会让模型以为已经验过测试了，直接收工。
 */
export function formatDiagnostics(
  list: Diag[],
  opts: { workspace?: string | null; max?: number; filesWritten?: number } = {}
): string {
  const errors = errorsOnly(list)
  if (errors.length === 0) return ''

  const max = opts.max ?? 8
  const shown = errors.slice(0, max)
  const lines = shown.map((d) => {
    const where = `${relPath(d.file, opts.workspace)}:${d.line}:${d.col}`
    const code = d.code ? ` TS${d.code}` : ''
    return `- ${where}${code} ${d.message}`
  })

  const head =
    opts.filesWritten && opts.filesWritten > 1
      ? `[编译诊断] 刚改的 ${opts.filesWritten} 个文件里现在有 ${errors.length} 个编译错误（保存后立刻检查，没有跑构建）：`
      : `[编译诊断] 刚改的文件里现在有 ${errors.length} 个编译错误（保存后立刻检查，没有跑构建）：`

  const tail =
    errors.length > shown.length
      ? [`…还有 ${errors.length - shown.length} 个同类错误没列出。`, '请先把上面这些修好，再继续做后面的事。']
      : ['请现在就修掉，不要让用户去发现。']

  return [head, ...lines, ...tail].join('\n')
}

/**
 * 「该检查却没检查成」的说明。
 *
 * 这段存在的原因很具体：项目有 tsconfig、但 node_modules 里没有 typescript 时，
 * 旧代码静默返回空数组，调用方看到「没有错误」就当检查通过了 ——
 * 模型改坏一片类型，一句提示都不会拿到，最后把坏代码交出去。
 * 宁可明确说「这次没查」，也不要给一个假的绿勾。
 */
export function formatDiagGap(reason: 'no-typescript' | 'unavailable'): string {
  if (reason === 'unavailable') {
    return (
      '[编译诊断] 类型检查服务这次没起来（可能还在加载、或已连续失败被关掉），' +
      '所以**这一轮没有做类型检查**。不要把「没有报错」当成检查通过：' +
      '继续之前请用项目自己的构建 / 测试命令确认一遍。'
    )
  }
  return (
    '[编译诊断] 这个项目有 tsconfig，但没装 typescript（node_modules 里找不到 tsserver），' +
    '所以**这次没有做类型检查**。不要把「没有报错」当成检查通过：' +
    '改完请用项目自己的构建 / 测试命令验证，或者先装依赖（npm install）。'
  )
}

/** 判断一个路径值不值得送去做类型检查：只看 TS/JS 家族 */
export function isTypeScriptFile(file: string): boolean {
  return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(file)
}

/**
 * 从一条 tsc 风格的输出行里抠出诊断。
 *
 * 有些项目没有 typescript 依赖（比如只装了 @types），tsserver 起不来，
 * 这种情况下退化成「跑一次 tsc 把输出按文件过滤」也能拿到同样的信息。
 * 支持 5.x 的 `file(line,col): error TS1234: msg` 和旧式 `file:line:col - error TS1234: msg`。
 */
export function parseTscLine(line: string, workspace?: string | null): Diag | null {
  const text = line.trim()
  if (!text) return null

  const modern = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.*)$/.exec(text)
  const legacy = /^(.+?):(\d+):(\d+)\s*-\s*(error|warning)\s+(TS\d+):\s*(.*)$/.exec(text)
  const m = modern ?? legacy
  if (!m) return null

  const [, file, lineNo, colNo, kind, code, msg] = m
  const abs = /^[a-zA-Z]:[\\/]/.test(file) || file.startsWith('/') ? file : joinLoose(workspace, file)
  return {
    file: abs,
    line: Number(lineNo) || 1,
    col: Number(colNo) || 1,
    code: Number(code.replace(/^TS/, '')) || 0,
    message: msg.trim(),
    severity: kind === 'error' ? 'error' : 'warning',
    source: 'tsc'
  }
}

function joinLoose(workspace: string | null | undefined, file: string): string {
  if (!workspace) return file
  const sep = workspace.includes('\\') ? '\\' : '/'
  return `${workspace.replace(/[\\/]+$/, '')}${sep}${file.replace(/^[\\/]+/, '')}`
}

/** 把 tsc 全量输出切成诊断列表（只为 fallback 路径服务） */
export function parseTscOutput(output: string, workspace?: string | null): Diag[] {
  const out: Diag[] = []
  for (const line of output.split(/\r?\n/)) {
    const d = parseTscLine(line, workspace)
    if (d) out.push(d)
  }
  return dedupe(out)
}
