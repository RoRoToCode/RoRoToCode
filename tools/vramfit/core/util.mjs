/**
 * 跨平台小工具。core 里不许出现 node: 内置模块 —— 这个文件同时跑在
 * Node 和浏览器里，用 path.basename 会让浏览器直接崩在 import 阶段。
 */

export const GB = 1024 ** 3

/**
 * 取路径最后一段。比 path.basename 宽容：
 * 同时认 / 和 \，也能处理结尾带斜杠、URL 带查询串的情况。
 */
export function baseName(p) {
  const s = String(p ?? '').trim()
  if (!s) return ''
  const noQuery = s.replace(/[?#].*$/, '')
  const seg = noQuery.split(/[\\/]/).filter(Boolean).pop() ?? ''
  return seg
}

/** UTF-8 字节数。Browser 和 Node 都有 TextEncoder，不必依赖 Buffer */
export function utf8Length(s) {
  return new TextEncoder().encode(String(s ?? '')).length
}

/**
 * 人类可读体积。小于 1 GB 走 MiB —— 运行时开销只有 200 MiB，
 * 印成「0.20 GB」既不容易读，也和「200 MiB」的说法对不上。
 */
export function fmtSize(bytes) {
  const b = Number(bytes) || 0
  return b < GB ? `${Math.round(b / (1024 * 1024))} MiB` : `${(b / GB).toFixed(2)} GB`
}
