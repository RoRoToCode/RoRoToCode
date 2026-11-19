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
 * 从**尾部**取 max 个 code unit，同样不切断代理对。
 *
 * `slice(-n)` 的坑和头部相反：切点落在低代理之前时，留下的开头是个孤立低代理
 * （`\uDE00`），JSON 里同样是非法字符。折叠工具输出时「留结尾」用得很频繁，
 * 以前每处都写 `slice(-320)`，遇到 emoji 就悄悄坏一次。
 */
export function clipTailSafe(text: string, max: number, ellipsis = ''): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  let start = text.length - max
  const ch = text.charCodeAt(start)
  // 起点正好是低代理：说明它属于切点前那个高位代理，整体往后挪一个
  if (ch >= 0xdc00 && ch <= 0xdfff) start += 1
  return ellipsis + text.slice(start)
}

/**
 * 掐头留尾：返回 head / tail 两段与被省略的字符数。
 *
 * 单独抽出来是因为「中间省略」的文案要精确知道少了多少 —— 以前各处用
 * `content.length - 1120` 反推，改了 head/tail 长度就得同步改这个数，
 * 漏改一次提示里的数字就是错的。
 */
export function splitHeadTail(
  text: string,
  head: number,
  tail: number
): { head: string; tail: string; omitted: number } {
  if (text.length <= head + tail) return { head: text, tail: '', omitted: 0 }
  const h = clipSafePlain(text, head)
  const t = clipTailSafe(text, tail)
  return { head: h, tail: t, omitted: Math.max(0, text.length - h.length - t.length) }
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
