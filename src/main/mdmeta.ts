/**
 * 极简 YAML frontmatter 解析。
 *
 * 只认 `key: value` 和 `key: a, b`，不引第三方 YAML 库：
 * 命令 / 档案 / 技能这三种文件用到的就这么多，引一个解析器反而要处理
 * 锚点、多行块、类型推断一堆用不上的语义。
 */
export interface MdFile {
  meta: Record<string, string>
  body: string
}

export function parseFrontmatter(text: string): MdFile {
  const src = text.replace(/^\uFEFF/, '')
  const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(src)
  if (!fm) return { meta: {}, body: src.trim() }

  const meta: Record<string, string> = {}
  for (const raw of fm[1].split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    meta[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return { meta, body: src.slice(fm[0].length).trim() }
}

/** 把 `a, b c` 这类值拆成数组 */
export function splitList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .replace(/^\[|\]$/g, '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}
