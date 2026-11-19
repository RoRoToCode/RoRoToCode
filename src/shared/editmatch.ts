/**
 * old_string 的宽松匹配。
 *
 * 为什么需要它：模型（尤其是 9B 级本地模型）复述原文时经常差一个缩进、
 * 把行尾空格吃掉、或多带一个空行。以前的实现是 `original.split(old).length - 1`，
 * 差一个字符就直接抛「未找到 old_string」，模型只能重读一遍再猜一次 ——
 * 真实会话里同一份 30 行的文件能反复失败七八轮，最后干脆整份重写。
 *
 * 策略从严到宽，命中即停：
 *   1. exact                  逐字节相同（绝大多数情况走这条）
 *   2. line-trimmed           每行去掉首尾空白后相同
 *   3. indentation-flexible   两段各自去掉公共缩进后相同（保留相对缩进）
 *   4. whitespace-normalized  连续空白归一成单空格后相同
 *   5. block-anchor           首尾行相同、中间行 ≥50% 相同（原文被局部改动过）
 *
 * 放宽匹配会带来误伤，所以同时有三道护栏：
 *   - 命中多处 → 拒绝（除非 replace_all），并报出每一处的行号
 *   - 命中范围远大于 old_string → 拒绝（模糊匹配吞掉整个函数是最坏的结果）
 *   - 完全没命中 → 返回「最接近的一段」和相似度，让模型知道差在哪，而不是干猜
 *
 * 另外两个容易踩的坑一并处理：换行符（模型给 \n、原文是 \r\n）与 BOM，
 * 替换后保持原文件的风格，否则整个文件的 diff 会炸。
 */

export type MatchStrategy =
  | 'exact'
  | 'line-trimmed'
  | 'indentation-flexible'
  | 'whitespace-normalized'
  | 'block-anchor'

export interface EditRange {
  /** 命中片段在原文中的起止偏移（不含结束） */
  start: number
  end: number
  /** 1 基行号，闭区间 */
  lineStart: number
  lineEnd: number
}

export interface EditSuccess {
  ok: true
  text: string
  strategy: MatchStrategy
  /** 实际替换处数（replace_all 时可能 > 1） */
  count: number
  /** 每一处命中的位置 */
  ranges: EditRange[]
}

export interface EditFailure {
  ok: false
  reason: 'empty' | 'same' | 'not-found' | 'ambiguous' | 'disproportionate'
  message: string
}

export type EditResult = EditSuccess | EditFailure

/** 按行切分，同时记住每行的起止偏移与它后面的换行符 */
interface Parsed {
  lines: string[]
  starts: number[]
  ends: number[]
  eols: string[]
  /** 出现最多的换行符；替换时用它，保证不改动文件的换行风格 */
  eol: string
}

function split(text: string): Parsed {
  const lines: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  const eols: string[] = []
  const re = /\r\n|\n|\r/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    lines.push(text.slice(last, m.index))
    starts.push(last)
    ends.push(m.index)
    eols.push(m[0])
    last = re.lastIndex
  }
  lines.push(text.slice(last))
  starts.push(last)
  ends.push(text.length)
  eols.push('')

  const count = new Map<string, number>()
  for (const e of eols) if (e) count.set(e, (count.get(e) ?? 0) + 1)
  let eol = '\n'
  let best = 0
  for (const [k, v] of count) {
    if (v > best) {
      best = v
      eol = k
    }
  }
  return { lines, starts, ends, eols, eol }
}

/** 文本 → 行数组；trailing 表示原文是否以换行结尾 */
function toLines(text: string): { lines: string[]; trailing: boolean } {
  const p = split(text)
  const lines = p.lines.slice()
  const trailing = p.eols[p.eols.length - 1] !== ''
  // split 对「以换行结尾」会多给一个空行，去掉它，改由 trailing 表达
  if (trailing && lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return { lines, trailing }
}

function joinLines(lines: string[], eol: string, trailing: boolean): string {
  const out = lines.join(eol)
  return trailing ? out + eol : out
}

function isBlank(line: string): boolean {
  return line.trim() === ''
}

/** 去掉块首尾的空行，返回剥掉的数量；全空则返回 null */
function trimBlankEdges(lines: string[]): { lines: string[]; lead: number; trail: number } | null {
  let lead = 0
  let trail = 0
  while (lead < lines.length && isBlank(lines[lead])) lead++
  while (trail < lines.length - lead && isBlank(lines[lines.length - 1 - trail])) trail++
  if (lead + trail >= lines.length) return null
  return { lines: lines.slice(lead, lines.length - trail), lead, trail }
}

/** 一段代码的公共缩进（以字符数计，tab 也算 1） */
function minIndent(lines: string[]): number {
  let min = Number.POSITIVE_INFINITY
  for (const l of lines) {
    if (isBlank(l)) continue
    const m = /^[ \t]*/.exec(l)
    min = Math.min(min, m ? m[0].length : 0)
  }
  return Number.isFinite(min) ? min : 0
}

function stripIndent(line: string, n: number): string {
  let i = 0
  while (i < n && (line[i] === ' ' || line[i] === '\t')) i++
  return line.slice(i)
}

const normTrim = (l: string): string => l.trim()
const normWs = (l: string): string => l.replace(/\s+/g, ' ').trim()

/** 在原文行数组里滑窗找出所有满足 eq 的起始行号 */
function findStarts(
  srcLines: string[],
  count: number,
  eq: (start: number) => boolean
): number[] {
  const out: number[] = []
  if (count <= 0 || count > srcLines.length) return out
  for (let s = 0; s + count <= srcLines.length; s++) if (eq(s)) out.push(s)
  return out
}

/** 把若干 hunk 应用到原文（按偏移从后往前，避免前面的替换移动后面的位置） */
function spliceAll(
  body: string,
  hunks: Array<{ start: number; end: number; seg: string }>
): string {
  const sorted = hunks.slice().sort((a, b) => b.start - a.start)
  let out = body
  for (const h of sorted) out = out.slice(0, h.start) + h.seg + out.slice(h.end)
  return out
}

interface Candidate {
  strategy: MatchStrategy
  /** 用来比对的原文行（可能已剥掉首尾空行） */
  old: string[]
  /** 命中的行数 */
  count: number
  /** 用于行级替换的新行数组 */
  newLines: string[]
  newTrailing: boolean
}

/** 一次行级替换的结果；bad 表示命中了但范围异常，应当拒绝 */
interface LineHunk {
  bad?: EditRange
  start?: number
  end?: number
  seg?: string
  range?: EditRange
}

/**
 * 主入口。
 *
 * `original` 是文件当前内容，`oldText` 是模型想替换的片段，`newText` 是替换后的内容。
 * 返回失败时 `message` 是给模型看的：要么说清「为什么不能改」，要么给出最接近的一段。
 */
export function applyEdit(
  original: string,
  oldText: string,
  newText: string,
  replaceAll = false
): EditResult {
  if (!oldText) return { ok: false, reason: 'empty', message: 'old_string 不能为空' }
  if (oldText === newText) {
    return {
      ok: false,
      reason: 'same',
      message: 'old_string 与 new_string 完全相同，这次调用不会产生任何改动。请确认是不是漏了要改的内容。'
    }
  }

  const bom = original.startsWith('\uFEFF')
  const body = bom ? original.slice(1) : original
  const src = split(body)
  const result = match(body, src, oldText, newText, replaceAll)
  if (!result.ok) return result
  return { ...result, text: bom ? `\uFEFF${result.text}` : result.text }
}

function match(
  body: string,
  src: Parsed,
  oldText: string,
  newText: string,
  replaceAll: boolean
): EditResult {
  const eol = src.eol

  // ---------- 1. exact：逐字节相同 ----------
  if (body.includes(oldText)) {
    const hits: number[] = []
    let at = body.indexOf(oldText)
    while (at >= 0) {
      hits.push(at)
      at = body.indexOf(oldText, at + oldText.length)
    }
    const ranges = hits.map((start) => {
      const end = start + oldText.length
      return { start, end, lineStart: lineAt(src, start), lineEnd: lineAt(src, end) }
    })
    if (hits.length > 1 && !replaceAll) {
      return {
        ok: false,
        reason: 'ambiguous',
        message:
          `old_string 在文件里出现了 ${hits.length} 次（第 ${ranges
            .slice(0, 5)
            .map((r) => r.lineStart)
            .join('、')} 行），无法确定改哪一处。\n` +
          '请多带几行上下文让匹配唯一，或设置 replace_all: true 一次全改。'
      }
    }
    const { lines: newLines, trailing } = toLines(newText)
    const seg = joinLines(newLines, eol, trailing)
    const use = replaceAll ? hits : hits.slice(0, 1)
    const hunks = use.map((start) => ({ start, end: start + oldText.length, seg }))
    return {
      ok: true,
      text: spliceAll(body, hunks),
      strategy: 'exact',
      count: use.length,
      ranges: use.length === 1 ? ranges.slice(0, 1) : ranges
    }
  }

  // ---------- 行级策略 ----------
  const oldSrc = toLines(oldText)
  const newSrc = toLines(newText)
  // 只有原文里真的存在换行，行级匹配才有意义
  const multiLine = oldSrc.lines.length > 1

  if (multiLine) {
    for (const cand of buildCandidates(oldSrc, newSrc, src.lines.length)) {
      const found = candidateStarts(src.lines, cand)
      if (!found.length) continue
      if (found.length > 1 && !replaceAll) {
        return {
          ok: false,
          reason: 'ambiguous',
          message:
            `old_string 按「${cand.strategy}」宽松匹配到 ${found.length} 处（第 ${found
              .slice(0, 5)
              .map((s) => s + 1)
              .join('、')} 行），无法确定改哪一处。\n` +
            '请多带几行上下文让匹配唯一，或设置 replace_all: true 一次全改。'
        }
      }
      const use = replaceAll ? found : found.slice(0, 1)
      const hunks: LineHunk[] = use.map((start) => {
        const endLine = start + cand.count - 1
        const startOff = src.starts[start]
        const endOff = src.eols[endLine]
          ? src.ends[endLine] + src.eols[endLine].length
          : src.ends[endLine]
        const range: EditRange = { start: startOff, end: endOff, lineStart: start + 1, lineEnd: endLine + 1 }
        // 命中范围远大于 old_string：模糊匹配吞掉了不该动的内容，宁可失败
        if (endOff - startOff > oldText.length * 2.5 + 400) return { bad: range }
        const seg = joinLines(cand.newLines, eol, Boolean(cand.newTrailing))
        // 原文末行后面带换行时，替换文本也要留住它，否则会把下一行粘上来
        const keepEol = Boolean(src.eols[endLine]) && !cand.newTrailing
        return { start: startOff, end: endOff, seg: keepEol ? `${seg}${eol}` : seg, range }
      })
      const bad = hunks.find((h) => h.bad)
      if (bad?.bad) {
        return {
          ok: false,
          reason: 'disproportionate',
          message:
            `「${cand.strategy}」匹配到的范围（第 ${bad.bad.lineStart}-${bad.bad.lineEnd} 行）比 old_string 大得多，` +
            '很可能连带吞掉了不该改的内容，已拒绝。请 read_file 看清原文后缩小 old_string，或改用 patch 的 unified diff。'
        }
      }
      return {
        ok: true,
        text: spliceAll(
          body,
          hunks.map((h) => ({ start: h.start!, end: h.end!, seg: h.seg! }))
        ),
        strategy: cand.strategy,
        count: use.length,
        ranges: hunks.map((h) => h.range!)
      }
    }
  }

  // ---------- 单行兜底：只有一行时也允许空白放宽 ----------
  // 多行的 old_string 绝不能走这里：拿它第一行去命中，会把后面几十行原样丢掉
  // （实测过：`function a() {\n}` 会把整个函数体换成两行）。
  const oldOne = multiLine ? '' : (oldSrc.lines[0] ?? '')
  const newLines = newSrc.lines.length ? newSrc.lines : ['']
  if (oldOne.trim()) {
    const hits: number[] = []
    for (let i = 0; i < src.lines.length; i++) {
      if (normWs(src.lines[i]) === normWs(oldOne)) hits.push(i)
    }
    if (hits.length === 1) {
      const line = hits[0]
      const start = src.starts[line]
      const end = src.eols[line] ? src.ends[line] + src.eols[line].length : src.ends[line]
      const seg = joinLines(newLines, eol, newSrc.trailing || Boolean(src.eols[line]))
      return {
        ok: true,
        text: spliceAll(body, [{ start, end, seg }]),
        strategy: 'whitespace-normalized',
        count: 1,
        ranges: [{ start, end, lineStart: line + 1, lineEnd: line + 1 }]
      }
    }
    if (hits.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        message:
          `old_string 按空白归一后匹配到 ${hits.length} 行（第 ${hits
            .slice(0, 5)
            .map((s) => s + 1)
            .join('、')} 行），无法确定改哪一处。请多带几行上下文。`
      }
    }
  }

  return {
    ok: false,
    reason: 'not-found',
    message: notFoundMessage(src, oldSrc.lines)
  }
}

/** 行级候选：同一段 old 用不同严格度各生成一份，按从严到宽排 */
function buildCandidates(
  oldSrc: { lines: string[]; trailing: boolean },
  newSrc: { lines: string[]; trailing: boolean },
  srcCount: number
): Candidate[] {
  const out: Candidate[] = []
  const push = (strategy: MatchStrategy, oldLines: string[], newLines: string[]): void => {
    if (!oldLines.length || oldLines.length > srcCount) return
    out.push({
      strategy,
      old: oldLines,
      count: oldLines.length,
      newLines,
      newTrailing: newSrc.trailing
    })
  }

  // 变体 A：原样；变体 B：剥掉块首尾空行（模型常多带一个空行）
  const variants: Array<{ old: string[]; neu: string[] }> = [{ old: oldSrc.lines, neu: newSrc.lines }]
  const trimmed = trimBlankEdges(oldSrc.lines)
  if (trimmed && (trimmed.lead || trimmed.trail)) {
    const neuTrim = trimBlankEdges(newSrc.lines)
    variants.push({ old: trimmed.lines, neu: neuTrim ? neuTrim.lines : newSrc.lines })
  }

  // 先跑完严格的那一级（A 的全部策略），再退到剥空行的版本：
  // 否则「多一个空行」的容错会盖掉本该精确命中的情况。
  for (const v of variants) {
    push('line-trimmed', v.old, v.neu)
    push('indentation-flexible', v.old, v.neu)
    push('whitespace-normalized', v.old, v.neu)
    if (v.old.length >= 3) push('block-anchor', v.old, v.neu)
  }
  return out
}

function candidateStarts(srcLines: string[], cand: Candidate): number[] {
  const n = cand.count
  const lines = cand.old

  switch (cand.strategy) {
    case 'line-trimmed':
      return findStarts(srcLines, n, (s) => {
        for (let i = 0; i < n; i++) if (normTrim(srcLines[s + i]) !== normTrim(lines[i])) return false
        return true
      })
    case 'indentation-flexible': {
      const io = minIndent(lines)
      return findStarts(srcLines, n, (s) => {
        const block = srcLines.slice(s, s + n)
        const ib = minIndent(block)
        for (let i = 0; i < n; i++) {
          if (stripIndent(block[i], ib) !== stripIndent(lines[i], io)) return false
        }
        return true
      })
    }
    case 'whitespace-normalized':
      return findStarts(srcLines, n, (s) => {
        for (let i = 0; i < n; i++) if (normWs(srcLines[s + i]) !== normWs(lines[i])) return false
        return true
      })
    case 'block-anchor':
      // 首尾行必须一致，中间行至少一半一致：容忍原文被局部改过几行
      return findStarts(srcLines, n, (s) => {
        if (normWs(srcLines[s]) !== normWs(lines[0])) return false
        if (normWs(srcLines[s + n - 1]) !== normWs(lines[n - 1])) return false
        let same = 0
        for (let i = 0; i < n; i++) if (normWs(srcLines[s + i]) === normWs(lines[i])) same++
        return same / n >= 0.5
      })
    default:
      return []
  }
}

function lineAt(src: Parsed, offset: number): number {
  // 二分找「包含该偏移的行」
  let lo = 0
  let hi = src.starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (src.starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/**
 * 逐行相似度（Dice 系数，按字符二元组算）。
 *
 * 这里不能用「是否完全相等」：模型给错的那一行往往只差一个字母
 * （`const valu = compute()` vs `const value = compute()`），
 * 严格比较会把最该被指出来的那一段算成 0 相似度，于是又回到「未找到」三个字。
 */
function dice(a: string, b: string): number {
  if (a === b) return 1
  if (!a || !b) return 0
  if (a.length < 2 || b.length < 2) return 0
  const grams = new Map<string, number>()
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2)
    grams.set(g, (grams.get(g) ?? 0) + 1)
  }
  let hit = 0
  let total = 0
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2)
    total++
    const n = grams.get(g) ?? 0
    if (n > 0) {
      hit++
      grams.set(g, n - 1)
    }
  }
  return total ? (2 * hit) / (a.length - 1 + total) : 0
}

/**
 * 完全没命中时给的线索：找最相似的一段，把行号和相似度报给模型。
 * 只说「未找到」等于什么都没说 —— 小模型只会把同一段原样再发一次。
 */
function notFoundMessage(src: Parsed, oldLines: string[]): string {
  const total = src.lines.length
  const n = Math.max(1, oldLines.length)
  let bestStart = -1
  let bestRatio = 0
  if (n <= total) {
    for (let s = 0; s + n <= total; s++) {
      let sum = 0
      for (let i = 0; i < n; i++) sum += dice(normWs(src.lines[s + i]), normWs(oldLines[i]))
      const ratio = sum / n
      if (ratio > bestRatio) {
        bestRatio = ratio
        bestStart = s
      }
    }
  }
  const head =
    `未找到 old_string（已按 精确 / 行空白 / 缩进 / 空白归一 / 首尾锚点 五级宽松匹配尝试过）。` +
    `文件共 ${total} 行。`
  if (bestStart >= 0 && bestRatio >= 0.34) {
    const snippet = src.lines
      .slice(bestStart, Math.min(bestStart + n, bestStart + 6))
      .map((l, i) => `  ${bestStart + i + 1}→${l.slice(0, 120)}`)
      .join('\n')
    return (
      `${head}\n最接近的是第 ${bestStart + 1}-${Math.min(bestStart + n, total)} 行（行相似度 ${Math.round(
        bestRatio * 100
      )}%）：\n${snippet}\n` +
      '请照这几行的原文重写 old_string（缩进、空格、标点都要一致），或直接用 patch 传 unified diff。'
    )
  }
  return (
    `${head}没有任何位置接近你给的片段。` +
    '请先用 read_file 读这个文件确认原文存在（注意大小写、全角半角、以及是否在别的文件里），再重试；' +
    '不确定要改哪几行时，用 grep 搜关键词定位。'
  )
}
