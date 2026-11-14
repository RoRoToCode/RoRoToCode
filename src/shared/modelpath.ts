/**
 * 路径归属判断。
 *
 * 不用 `node:path`：这个文件被主进程和渲染层共用，渲染层的 tsconfig 里没有
 * node 类型。手写这几个函数反而更稳 —— 逻辑只有「拆段 + 比前缀」，
 * 没有平台分支要处理。
 */

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/')
}

/** 拆成路径段，顺带消掉 `.` 和 `..` */
function segments(p: string): string[] {
  const out: string[] = []
  for (const part of normalizeSlashes(p).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return out
}

/** 只有盘符路径（Windows）才忽略大小写；POSIX 上大小写敏感，混为一谈会越权 */
function caseInsensitive(p: string): boolean {
  return /^[a-zA-Z]:/.test(normalizeSlashes(p))
}

/**
 * 这个绝对路径是否落在给定的任一目录之内。
 *
 * 用来挡「界面传来一个 ../.. 路径，主进程照删」这类事故。界面传来的路径
 * 属于不可信输入，判断必须放在真正执行删除的那一侧，不能指望前端自觉。
 *
 * 两条细节：
 * - 目录本身不算「在里面」（段数必须严格更多），否则整个 models/ 都能被删掉；
 * - `..` 在拆段时就已经消掉，所以 `models/../../secret` 骗不过去。
 */
export function isInsideAnyRoot(roots: string[], abs: string): boolean {
  if (!abs) return false
  const target = segments(abs)
  if (!target.length) return false
  const ci = caseInsensitive(abs)

  for (const root of roots) {
    if (!root) continue
    const base = segments(root)
    if (!base.length) continue
    if (target.length <= base.length) continue

    let same = true
    for (let i = 0; i < base.length; i++) {
      const a = ci ? target[i].toLowerCase() : target[i]
      const b = ci ? base[i].toLowerCase() : base[i]
      if (a !== b) {
        same = false
        break
      }
    }
    if (same) return true
  }
  return false
}

/** 只认 .gguf：模型目录里还有配置和投影器，别让删除接口变成通用删文件 */
export function isModelFileName(abs: string): boolean {
  return /\.gguf$/i.test(abs)
}
