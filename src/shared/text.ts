/**
 * 文本截断的小工具。
 *
 * 为什么单独成文件：`str.slice(0, n)` 是按 UTF-16 code unit 切的，切点落在代理对中间时
 * 会留下一个孤立的高位代理（`\uD83D`）。这个字符串进 JSON 会变成非法转义，
 * 模型看到的是乱码，而估算 token 时还会把它算成一个字符。
 * 读大文件、grep 长行、压缩历史都会碰到，所以统一走这里。
 */

/** 截断到 max 个 code unit，但不切断代理对；超出时补一个省略标记 */
export function clipSafe(text: string, max: number, ellipsis = '…'): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  let cut = max
  // 切点前一个字符如果是高位代理，说明这一对 emoji 被劈开了：少切一个
  const ch = text.charCodeAt(cut - 1)
  if (ch >= 0xd800 && ch <= 0xdbff) cut -= 1
  return text.slice(0, Math.max(0, cut)) + ellipsis
}

/** 同上，但不追加省略标记（用于按行/按字节限长的场景） */
export function clipSafePlain(text: string, max: number): string {
  return clipSafe(text, max, '')
}

/**
 * 只替换第一处，用切片实现而不是 String.replace。
 *
 * String.replace 的替换值是字符串时会展开 `$&` `$'` `` $` `` `$$` ——
 * 写入的代码里只要有这些（正则替换、PowerShell 变量、模板里的 `$$`），
 * 落盘内容就被就地改写，而工具还回报「已修改」。
 */
export function replaceOnce(text: string, find: string, replacement: string): string {
  if (!find) return text
  const at = text.indexOf(find)
  if (at < 0) return text
  return text.slice(0, at) + replacement + text.slice(at + find.length)
}
