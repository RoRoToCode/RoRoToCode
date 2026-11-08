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

/** 每次给一个新正则：递归解析粗体内部时不能共用 lastIndex，否则外层扫描会错乱 */
function inlineRe(): RegExp {
  return /(`[^`\n]+`)|(\*\*([^*\n]+?)\*\*)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>"']+)/g
}

export function safeHref(raw: string): string | null {
  const url = raw.trim()
  return /^https?:\/\/[^\s<>"']+$/i.test(url) ? url : null
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
    } else if (m[2]) {
      // 粗体里还能套链接 / 行内代码，例如 **[文档](https://…)** 或 **`--port`**
      out.push({ kind: 'strong', children: tokenizeInline(m[3] ?? '', depth + 1) })
    } else if (m[4]) {
      const href = safeHref(m[6] ?? '')
      if (href) out.push({ kind: 'link', text: m[5] ?? '', href })
      else pushText(m[4])
    } else if (m[7]) {
      const { url, tail } = trimUrlTail(m[7])
      const href = safeHref(url)
      if (href) {
        out.push({ kind: 'link', text: url, href })
        pushText(tail)
      } else {
        pushText(m[7])
      }
    }
    last = m.index + m[0].length
  }
  pushText(text.slice(last))
  return out
}
