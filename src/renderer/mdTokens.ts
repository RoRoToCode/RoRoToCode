/**
 * 回答正文的行内 Markdown 解析。
 *
 * 只认四样东西：行内代码、**粗体**、[文字](链接)、裸 http(s) 网址。
 * 故意不做 `_斜体_` / `__粗体__`：这是编程助手，`foo_bar_baz` 之类标识符里
 * 下划线满天飞，按 Markdown 的强调规则解析会把变量名切得七零八落。
 *
 * 链接只放行 http/https —— 模型输出的文本不可信，javascript: / file: 一律不当链接。
 */

export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: InlineToken[] }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'image'; alt: string; src: string }

/**
 * 每个分支都要给一个新正则：递归解析粗体内部时不能共用 lastIndex，否则外层扫描会错乱。
 *
 * 图片排在链接前面 —— `![说明](path)` 里包含 `[说明](path)`，先认链接就会把图片
 * 拆成一个「感叹号 + 链接」，屏幕上只剩一个孤零零的 `!`。
 * 地址允许包在 `<…>` 里（本地路径带空格时只能这么写）。
 */
function inlineRe(): RegExp {
  return /(`[^`\n]+`)|(?:!\[([^\]\n]*)\]\(\s*<?([^)>\n]+?)>?\s*\))|(\*\*([^*\n]+?)\*\*)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>"']+)/g
}

export function safeHref(raw: string): string | null {
  const url = raw.trim()
  return /^https?:\/\/[^\s<>"']+$/i.test(url) ? url : null
}

/**
 * 图片地址放行规则。
 *
 * 模型输出的文本不可信，`<img src>` 能做的事比 `<a href>` 多（自动发请求），
 * 所以只认三种：http(s) 网址、data:image 内联图、本地路径（相对工作区或用
 * file:// / `C:\` 开头的绝对路径）。其它协议（javascript:、vbscript: …）直接
 * 当普通文字，连解析都不解析。
 *
 * 本地路径不在渲染层读文件 —— 交给主进程按白名单校验后转成 data URL，
 * 见 vision.ts 的 imagePreview()。
 */
export function safeImageSrc(raw: string): string | null {
  const url = raw.trim().replace(/^</, '').replace(/>$/, '')
  if (!url) return null
  if (/^https?:\/\//i.test(url)) return url
  if (/^data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i.test(url)) return url
  if (/^file:\/\//i.test(url)) return url
  // Windows 盘符不能被当成协议（`C:` 会命中下面那条协议判断）
  if (/^[a-z]:[\\/]/i.test(url)) return url
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null
  return url
}

/**
 * 网址末尾常常跟着句号、逗号或右括号，那些不是 URL 的一部分。
 * 但维基百科式 `.../Foo_(bar)` 的右括号是配对的，必须留下 —— 所以按配对数判断。
 */
function trimUrlTail(raw: string): { url: string; tail: string } {
  let url = raw
  for (;;) {
    if (!url) break
    const last = url.slice(-1)
    if (/[.,;:!?，。；：！？"']/u.test(last)) {
      url = url.slice(0, -1)
      continue
    }
    if (last === ')' && (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0)) {
      url = url.slice(0, -1)
      continue
    }
    if (last === ']' && !url.includes('[')) {
      url = url.slice(0, -1)
      continue
    }
    break
  }
  return { url, tail: raw.slice(url.length) }
}

export function tokenizeInline(text: string, depth = 0): InlineToken[] {
  if (depth > 3) return [{ kind: 'text', text }]
  const out: InlineToken[] = []
  const pushText = (v: string) => {
    if (v) out.push({ kind: 'text', text: v })
  }
  const re = inlineRe()
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    pushText(text.slice(last, m.index))
    if (m[1]) {
      out.push({ kind: 'code', text: m[1].slice(1, -1) })
    } else if (m[2] !== undefined && m[3] !== undefined) {
      const src = safeImageSrc(m[3])
      if (src) out.push({ kind: 'image', alt: m[2].trim(), src })
      else pushText(m[0])
    } else if (m[4]) {
      // 粗体里还能套链接 / 行内代码，例如 **[文档](https://…)** 或 **`--port`**
      out.push({ kind: 'strong', children: tokenizeInline(m[5] ?? '', depth + 1) })
    } else if (m[6]) {
      const href = safeHref(m[8] ?? '')
      if (href) out.push({ kind: 'link', text: m[7] ?? '', href })
      else pushText(m[6])
    } else if (m[9]) {
      const { url, tail } = trimUrlTail(m[9])
      const href = safeHref(url)
      if (href) {
        out.push({ kind: 'link', text: url, href })
        pushText(tail)
      } else {
        pushText(m[9])
      }
    }
    last = m.index + m[0].length
  }
  pushText(text.slice(last))
  return out
}
