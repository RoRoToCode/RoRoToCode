/**
 * Markdown 的块级解析（纯函数，不碰 React）。
 *
 * 为什么要自己写：这个界面里显示的一切都来自模型输出，流式输出时每帧都可能是
 * 半截文本（表格只写了表头、代码块还没闭合）。真正的 Markdown 库遇到半截语法
 * 会整段吃掉或者退化成原文，屏幕上就是一堆 `|` 和 `|---|` 在闪。
 *
 * 所以这里的取舍是「宁可少认，不要乱吞」：
 * - 代码块没闭合就一路吃到结尾（流式时本来就是这样，闭合后才算完）；
 * - 表格必须「表头 + 分隔行 + 列数对得上」才认，否则当普通段落；
 * - 段落之间靠空行切分，任何块都从「行首」开始判断，不做花式回溯。
 *
 * 认的东西：代码块、表格、列表（含嵌套与勾选项）、标题、引用、分隔线、段落。
 * 不认的东西：缩进代码块（保留原文反而更安全）、HTML、脚注、定义列表。
 */

export type MdAlign = 'left' | 'center' | 'right' | null

export interface MdListItem {
  /** 缩进层级，从 0 开始 */
  depth: number
  ordered: boolean
  /** 有序列表的起始编号（`3.` → 3），无序列表为 1 */
  start: number
  /** 勾选框：null 表示不是任务项 */
  checked: boolean | null
  text: string
}

export type MdBlock =
  | { kind: 'code'; lang: string; value: string; open: boolean }
  | { kind: 'table'; head: string[]; align: MdAlign[]; rows: string[][] }
  | { kind: 'list'; items: MdListItem[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' }
  | { kind: 'para'; text: string }

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+.#-]*)/
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/
const HR_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/
const LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/
const TASK_RE = /^\[([ xX])\][ \t]+(.*)$/

/** 表格分隔行：`| --- | :--: |` */
function isDelimRow(line: string): boolean {
  const s = line.trim()
  if (!s || !s.includes('-')) return false
  if (s.includes('|')) {
    return /^\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?$/.test(s)
  }
  // 单列表格允许不带竖线，但必须整行只有一个 `---`
  return /^:?-+:?$/.test(s)
}

/** 拆一行表格。要绕开 `\|` 转义和 `a|b` 这种行内代码里的竖线 */
export function splitTableRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  let tick = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
      continue
    }
    if (ch === '`') tick = !tick
    if (ch === '|' && !tick) {
      cells.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  cells.push(cur.trim())
  return cells
}

function alignOf(cell: string): MdAlign {
  const s = cell.trim()
  const left = s.startsWith(':')
  const right = s.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

function indentOf(prefix: string): number {
  let n = 0
  for (const ch of prefix) n += ch === '\t' ? 4 : 1
  return n
}

export function parseMarkdownBlocks(input: string): MdBlock[] {
  const text = String(input ?? '').replace(/\r\n?/g, '\n')
  if (!text.trim()) return []
  const lines = text.split('\n')
  const blocks: MdBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }

    // ── 代码块：没闭合就一直吃到结尾（流式输出时必然如此）
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const ch = fence[1][0]
      const len = fence[1].length
      const closer = new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{${len},}[ \\t]*$`)
      const body: string[] = []
      let j = i + 1
      let closed = false
      for (; j < lines.length; j++) {
        if (closer.test(lines[j])) {
          closed = true
          break
        }
        body.push(lines[j])
      }
      blocks.push({ kind: 'code', lang: fence[2] ?? '', value: body.join('\n'), open: !closed })
      i = closed ? j + 1 : lines.length
      continue
    }

    // ── 标题
    const head = HEADING_RE.exec(line)
    if (head) {
      const body = (head[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim()
      blocks.push({ kind: 'heading', level: head[1].length, text: body })
      i++
      continue
    }

    // ── 分隔线（必须先于列表判断，`- - -` 两者都像）
    if (HR_RE.test(line)) {
      blocks.push({ kind: 'hr' })
      i++
      continue
    }

    // ── 表格：当前行像表头，下一行是分隔行，且列数一致
    if (line.includes('|') && i + 1 < lines.length && isDelimRow(lines[i + 1])) {
      const head = splitTableRow(line)
      const delim = splitTableRow(lines[i + 1])
      if (head.length > 0 && delim.length === head.length) {
        const rows: string[][] = []
        let j = i + 2
        for (; j < lines.length; j++) {
          const row = lines[j]
          if (!row.trim() || !row.includes('|')) break
          const cells = splitTableRow(row)
          // 多出来的列直接丢（和 GFM 一致），少的补空，保证表格不会错位
          while (cells.length < head.length) cells.push('')
          rows.push(cells.slice(0, head.length))
        }
        blocks.push({ kind: 'table', head, align: delim.map(alignOf), rows })
        i = j
        continue
      }
    }

    // ── 引用
    const quote = QUOTE_RE.exec(line)
    if (quote) {
      const body: string[] = [quote[1] ?? '']
      let j = i + 1
      for (; j < lines.length; j++) {
        const q = QUOTE_RE.exec(lines[j])
        if (!q) break
        body.push(q[1] ?? '')
      }
      blocks.push({ kind: 'quote', text: body.join('\n').trim() })
      i = j
      continue
    }

    // ── 列表
    const item = LIST_RE.exec(line)
    if (item) {
      const items: MdListItem[] = []
      const indents: number[] = []
      let j = i
      for (; j < lines.length; j++) {
        const raw = lines[j]
        if (!raw.trim()) break
        const m = LIST_RE.exec(raw)
        if (m) {
          const ind = indentOf(m[1] ?? '')
          while (indents.length > 1 && ind < indents[indents.length - 1]) indents.pop()
          if (!indents.length) indents.push(ind)
          else if (ind > indents[indents.length - 1]) indents.push(ind)
          const depth = indents.length - 1
          const ordered = /\d/.test(m[2])
          const start = ordered ? Number.parseInt(m[2], 10) || 1 : 1
          let body = m[3] ?? ''
          let checked: boolean | null = null
          const task = TASK_RE.exec(body)
          if (task) {
            checked = task[1].toLowerCase() === 'x'
            body = task[2]
          }
          items.push({ depth, ordered, start, checked, text: body.trim() })
          continue
        }
        // 换行续写：不是新条目、也不是别的块的起点，就接到上一条后面
        if (!FENCE_RE.test(raw) && !HEADING_RE.test(raw) && !QUOTE_RE.test(raw) && !HR_RE.test(raw)) {
          const last = items[items.length - 1]
          if (last) last.text = `${last.text}\n${raw.trim()}`
          continue
        }
        break
      }
      blocks.push({ kind: 'list', items })
      i = j
      continue
    }

    // ── 段落：一直吃到空行或下一个块的起点
    const para: string[] = [line]
    let j = i + 1
    for (; j < lines.length; j++) {
      const cur = lines[j]
      if (!cur.trim()) break
      if (FENCE_RE.test(cur) || HEADING_RE.test(cur) || HR_RE.test(cur) || QUOTE_RE.test(cur)) break
      if (LIST_RE.test(cur)) break
      if (cur.includes('|') && j + 1 < lines.length && isDelimRow(lines[j + 1])) {
        const head = splitTableRow(cur)
        if (head.length === splitTableRow(lines[j + 1]).length) break
      }
      para.push(cur)
    }
    blocks.push({ kind: 'para', text: para.join('\n') })
    i = j
  }

  return blocks
}
