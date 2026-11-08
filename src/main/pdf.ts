import zlib from 'node:zlib'

/**
 * 轻量 PDF 文本提取：不依赖 Python / poppler。
 *
 * 中文 PDF 的文字通常是「子集字体 + 自定义编码」，字节 0x20 可能是「主」。
 * 必须读字体里的 /ToUnicode CMap 才能还原，只抓 (...) 里的字符只会得到乱码。
 * 这里做的是：解析对象 → 每页字体表 → CMap → 内容流里的 Tj/TJ。
 */

interface PdfObject {
  dict: string
  stream: Buffer | null
}

interface CMap {
  map: Map<number, string>
  /** 一个字符码占几个字节 */
  codeBytes: number
}

interface FontInfo {
  cmap: CMap | null
  twoByte: boolean
}

function readableRatio(text: string): number {
  const chars = Array.from(text.replace(/\s/g, ''))
  if (!chars.length) return 1
  let ok = 0
  for (const ch of chars) {
    const code = ch.codePointAt(0) ?? 0
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0x20 && code <= 0x7e)
    ) {
      ok++
    }
  }
  return ok / chars.length
}

/* ------------------------------------------------------------- 对象解析 */

function inflate(raw: Buffer): Buffer | null {
  for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) {
    try {
      return fn(raw)
    } catch {
      /* 换下一个 */
    }
  }
  return null
}

function parseObjects(src: string): Map<number, PdfObject> {
  const objs = new Map<number, PdfObject>()
  const re = /(?:^|[\r\n\s])(\d+)\s+\d+\s+obj\b/g
  let m: RegExpExecArray | null
  const marks: Array<{ num: number; start: number; bodyStart: number }> = []
  while ((m = re.exec(src))) {
    marks.push({ num: Number(m[1]), start: m.index, bodyStart: m.index + m[0].length })
  }
  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i]
    const hardEnd = i + 1 < marks.length ? marks[i + 1].start : src.length
    const chunk = src.slice(cur.bodyStart, hardEnd)
    const endObj = chunk.indexOf('endobj')
    const body = endObj >= 0 ? chunk.slice(0, endObj) : chunk

    const sIdx = body.indexOf('stream')
    if (sIdx < 0) {
      objs.set(cur.num, { dict: body.trim(), stream: null })
      continue
    }

    let dict = body.slice(0, sIdx).trim()
    let dataStart = cur.bodyStart + sIdx + 6
    if (src[dataStart] === '\r') dataStart++
    if (src[dataStart] === '\n') dataStart++

    const lenMatch = /\/Length\s+(\d+)(?!\s+0\s+R)/.exec(dict)
    let dataEnd = -1
    if (lenMatch) {
      const len = Number(lenMatch[1])
      if (len > 0 && dataStart + len <= src.length) dataEnd = dataStart + len
    }
    if (dataEnd < 0) {
      const e = src.indexOf('endstream', dataStart)
      dataEnd = e < 0 ? body.length : e
    }

    const bytes = Buffer.from(src.slice(dataStart, Math.min(dataEnd, src.length)), 'latin1')
    const compressed = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)
    const needsInflate = compressed ? /FlateDecode/.test(compressed[1]) : false
    objs.set(cur.num, {
      dict,
      stream: needsInflate ? inflate(bytes) ?? bytes : bytes
    })
  }
  return objs
}

/** PDF 1.5+ 会把小对象塞进对象流，这里补上，否则读不到字体表 */
function expandObjectStreams(objs: Map<number, PdfObject>): void {
  for (const obj of [...objs.values()]) {
    if (!obj.stream || !/\/Type\s*\/ObjStm/.test(obj.dict)) continue
    const first = Number(/\/First\s+(\d+)/.exec(obj.dict)?.[1] ?? 0)
    const count = Number(/\/N\s+(\d+)/.exec(obj.dict)?.[1] ?? 0)
    if (!first || !count) continue
    const head = obj.stream.subarray(0, first).toString('latin1').trim().split(/\s+/)
    for (let i = 0; i < count; i++) {
      const num = Number(head[i * 2])
      const off = Number(head[i * 2 + 1])
      if (!Number.isFinite(num) || !Number.isFinite(off)) continue
      const nextOff = i + 1 < count ? Number(head[(i + 1) * 2 + 1]) : obj.stream.length - first
      const body = obj.stream
        .subarray(first + off, first + (Number.isFinite(nextOff) ? nextOff : obj.stream.length))
        .toString('latin1')
      if (!objs.has(num)) objs.set(num, { dict: body.trim(), stream: null })
    }
  }
}

function sliceDict(s: string, from: number): string {
  let depth = 0
  let i = from
  while (i < s.length - 1) {
    if (s[i] === '<' && s[i + 1] === '<') {
      depth++
      i += 2
      continue
    }
    if (s[i] === '>' && s[i + 1] === '>') {
      depth--
      i += 2
      if (depth === 0) return s.slice(from, i)
      continue
    }
    i++
  }
  return s.slice(from)
}

function subDict(dict: string, key: string, objs: Map<number, PdfObject>): string {
  const i = dict.indexOf(`/${key}`)
  if (i < 0) return ''
  let j = i + key.length + 1
  while (j < dict.length && /\s/.test(dict[j])) j++
  if (dict.startsWith('<<', j)) return sliceDict(dict, j)
  const ref = /^(\d+)\s+\d+\s+R/.exec(dict.slice(j))
  if (ref) return objs.get(Number(ref[1]))?.dict ?? ''
  return ''
}

/* --------------------------------------------------------------- CMap */

function hexToText(hex: string): string {
  let out = ''
  for (let i = 0; i + 3 < hex.length; i += 4) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
  }
  if (hex.length % 4 === 2) out += String.fromCharCode(parseInt(hex.slice(-2), 16))
  return out
}

function parseCMap(text: string): CMap {
  const map = new Map<number, string>()
  let codeBytes = 0

  const space = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text)
  if (space) {
    const first = /<([0-9A-Fa-f]+)>/.exec(space[1])
    if (first) codeBytes = Math.max(1, Math.round(first[1].length / 2))
  }
  if (!codeBytes && /Identity-[HV]/.test(text)) codeBytes = 2
  if (!codeBytes) codeBytes = 1

  for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(block))) {
      map.set(parseInt(m[1], 16), hexToText(m[2]))
    }
  }

  for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g
    let m: RegExpExecArray | null
    while ((m = re.exec(block))) {
      const lo = parseInt(m[1], 16)
      const hi = parseInt(m[2], 16)
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) continue
      const span = Math.min(hi - lo, 65535)
      if (m[4] !== undefined) {
        const start = m[4]
        const base = parseInt(start.slice(-4) || '0', 16)
        const prefix = start.length > 4 ? hexToText(start.slice(0, -4)) : ''
        for (let k = 0; k <= span; k++) {
          map.set(lo + k, prefix + String.fromCharCode(base + k))
        }
      } else if (m[5] !== undefined) {
        const items = m[5].match(/<([0-9A-Fa-f]+)>/g) ?? []
        items.forEach((item, k) => {
          map.set(lo + k, hexToText(item.replace(/[<>]/g, '')))
        })
      }
    }
  }

  return { map, codeBytes }
}

/* ------------------------------------------------------------- 字体解码 */

function buildFont(num: number, objs: Map<number, PdfObject>): FontInfo {
  const obj = objs.get(num)
  const dict = obj?.dict ?? ''
  let cmap: CMap | null = null
  const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(dict)
  if (tu) {
    const cm = objs.get(Number(tu[1]))
    if (cm?.stream) {
      const parsed = parseCMap(cm.stream.toString('latin1'))
      if (parsed.map.size) cmap = parsed
    }
  }
  const subtype = /\/Subtype\s*\/([A-Za-z0-9]+)/.exec(dict)?.[1] ?? ''
  const encoding = /\/Encoding\s*\/?([A-Za-z0-9-]+)?/.exec(dict)?.[1] ?? ''
  const twoByte = subtype === 'Type0' || /Identity-[HV]/.test(encoding) || cmap?.codeBytes === 2
  return { cmap, twoByte }
}

function unescapeBytes(s: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '\\') {
      bytes.push(s.charCodeAt(i) & 0xff)
      continue
    }
    const n = s[++i]
    if (n === undefined) break
    if (n === 'n') bytes.push(10)
    else if (n === 'r') bytes.push(13)
    else if (n === 't') bytes.push(9)
    else if (n === 'b') bytes.push(8)
    else if (n === 'f') bytes.push(12)
    else if (n === '\n') {
      /* 续行，忽略 */
    } else if (n >= '0' && n <= '7') {
      let oct = n
      while (oct.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') oct += s[++i]
      bytes.push(parseInt(oct, 8) & 0xff)
    } else bytes.push(n.charCodeAt(0) & 0xff)
  }
  return bytes
}

function decodeBytes(bytes: number[], font: FontInfo | null): string {
  if (!bytes.length) return ''
  const cmap = font?.cmap
  const step = cmap?.codeBytes ?? (font?.twoByte ? 2 : 1)

  if (cmap) {
    let out = ''
    for (let i = 0; i + step <= bytes.length; i += step) {
      let code = 0
      for (let k = 0; k < step; k++) code = (code << 8) | bytes[i + k]
      const ch = cmap.map.get(code)
      if (ch !== undefined) out += ch
      else if (step === 1 && code >= 32 && code < 127) out += String.fromCharCode(code)
    }
    return out
  }

  if (font?.twoByte) return ''

  const buf = Buffer.from(bytes)
  const latin = buf.toString('latin1')
  if (bytes.some((b) => b > 0x7f)) {
    try {
      const gbk = new TextDecoder('gbk').decode(buf)
      if (readableRatio(gbk) > readableRatio(latin) + 0.05) return gbk
    } catch {
      /* 没 GBK 就用 latin1 */
    }
  }
  return latin
}

/* ----------------------------------------------------------- 内容流执行 */

type Tok =
  | { kind: 'str'; text: string }
  | { kind: 'hex'; text: string }
  | { kind: 'num'; num: number }
  | { kind: 'name'; text: string }
  | { kind: 'arr'; items: Tok[] }
  | { kind: 'op'; text: string }

function tokenize(src: string): Tok[] {
  const root: Tok[] = []
  const stack: Tok[][] = [root]
  const push = (t: Tok) => stack[stack.length - 1].push(t)
  let i = 0

  while (i < src.length) {
    const ch = src[i]
    if (ch === '%') {
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++
      continue
    }
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\0') {
      i++
      continue
    }
    if (ch === '(') {
      i++
      let depth = 1
      let s = ''
      while (i < src.length && depth > 0) {
        const c = src[i]
        if (c === '\\') {
          s += c + (src[i + 1] ?? '')
          i += 2
          continue
        }
        if (c === '(') depth++
        else if (c === ')') {
          depth--
          if (depth === 0) {
            i++
            break
          }
        }
        s += c
        i++
      }
      push({ kind: 'str', text: s })
      continue
    }
    if (ch === '<' && src[i + 1] !== '<') {
      const end = src.indexOf('>', i)
      if (end < 0) break
      push({ kind: 'hex', text: src.slice(i + 1, end).replace(/\s+/g, '') })
      i = end + 1
      continue
    }
    if (ch === '<' && src[i + 1] === '<') {
      i += 2
      continue
    }
    if (ch === '>' && src[i + 1] === '>') {
      i += 2
      continue
    }
    if (ch === '[') {
      const arr: Tok[] = []
      stack.push(arr)
      i++
      continue
    }
    if (ch === ']') {
      const arr = stack.pop() ?? []
      if (stack.length) push({ kind: 'arr', items: arr })
      i++
      continue
    }
    if (ch === '/') {
      let j = i + 1
      while (j < src.length && !/[\s[\]<>()/%{}]/.test(src[j])) j++
      push({ kind: 'name', text: src.slice(i + 1, j) })
      i = j
      continue
    }
    if (/[0-9+\-.]/.test(ch)) {
      let j = i
      while (j < src.length && /[0-9+\-.eE]/.test(src[j])) j++
      const v = Number(src.slice(i, j))
      push({ kind: 'num', num: Number.isFinite(v) ? v : 0 })
      i = j
      continue
    }
    let j = i
    while (j < src.length && /[A-Za-z*'"]/.test(src[j])) j++
    if (j === i) {
      i++
      continue
    }
    push({ kind: 'op', text: src.slice(i, j) })
    i = j
  }
  return root
}

function runContent(tokens: Tok[], fonts: Map<string, FontInfo>): string {
  let font: FontInfo | null = null
  let out = ''
  let pendingBreak = false
  const operands: Tok[] = []

  const emit = (s: string, brk: boolean) => {
    if (!s) return
    if (brk && out && !out.endsWith('\n')) out += '\n'
    out += s
  }

  for (const tok of tokens) {
    if (tok.kind !== 'op') {
      operands.push(tok)
      continue
    }
    const op = tok.text

    if (op === 'Tf') {
      const name = operands[operands.length - 2]
      if (name && name.kind === 'name') font = fonts.get(name.text) ?? null
    } else if (op === 'Tj' || op === "'" || op === '"') {
      const s = operands[operands.length - 1]
      if (s?.kind === 'str') emit(decodeBytes(unescapeBytes(s.text), font), pendingBreak || op !== 'Tj')
      else if (s?.kind === 'hex') emit(decodeBytes(hexBytes(s.text), font), pendingBreak || op !== 'Tj')
      pendingBreak = false
    } else if (op === 'TJ') {
      const arr = operands[operands.length - 1]
      if (arr?.kind === 'arr') {
        let line = ''
        for (const el of arr.items) {
          if (el.kind === 'str') line += decodeBytes(unescapeBytes(el.text), font)
          else if (el.kind === 'hex') line += decodeBytes(hexBytes(el.text), font)
          else if (el.kind === 'num' && (el.num ?? 0) < -180) line += ' '
        }
        emit(line, pendingBreak)
        pendingBreak = false
      }
    } else if (op === 'Td' || op === 'TD') {
      const last = operands[operands.length - 1]
      const ty = last && last.kind === 'num' ? last.num : 0
      if (Math.abs(ty) > 0.5) pendingBreak = true
    } else if (op === 'T*' || op === 'ET') {
      pendingBreak = true
    }
    operands.length = 0
  }
  return out
}

function hexBytes(hex: string): number[] {
  const out: number[] = []
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16))
  return out
}

/* ---------------------------------------------------------------- 页面 */

function pageFonts(
  pageDict: string,
  objs: Map<number, PdfObject>,
  global: Map<string, FontInfo>
): Map<string, FontInfo> {
  const res = subDict(pageDict, 'Resources', objs)
  const fontDict = res ? subDict(res, 'Font', objs) : ''
  const fonts = new Map<string, FontInfo>()
  if (fontDict) {
    const re = /\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g
    let m: RegExpExecArray | null
    while ((m = re.exec(fontDict))) {
      fonts.set(m[1], buildFont(Number(m[2]), objs))
    }
  }
  if (!fonts.size) {
    for (const [k, v] of global) fonts.set(k, v)
  }
  return fonts
}

function pageContents(pageDict: string, objs: Map<number, PdfObject>): string {
  const c = /\/Contents\s*(\[[\s\S]*?\]|\d+\s+\d+\s+R)/.exec(pageDict)?.[1] ?? ''
  const parts: Buffer[] = []
  for (const ref of c.match(/\d+\s+\d+\s+R/g) ?? []) {
    const num = Number(ref.split(/\s+/)[0])
    const obj = objs.get(num)
    if (obj?.stream) parts.push(obj.stream)
  }
  return Buffer.concat(parts).toString('latin1')
}

export interface PdfTextResult {
  text: string
  pages: number
  /** 抽到的可读字符数，用来判断是不是扫描件 */
  chars: number
}

export function pdfToText(buf: Buffer): PdfTextResult {
  const src = buf.toString('latin1')
  const objs = parseObjects(src)
  expandObjectStreams(objs)

  // 全局字体表兜底：页面没写 /Resources 时用
  const global = new Map<string, FontInfo>()
  for (const [num, obj] of objs) {
    if (!/\/Type\s*\/Font/.test(obj.dict)) continue
    const name = /\/BaseFont\s*\/([^\s/<>[\]()]+)/.exec(obj.dict)?.[1] ?? `F${num}`
    global.set(name, buildFont(num, objs))
  }

  const pageNums = [...objs.entries()]
    .filter(([, o]) => /\/Type\s*\/Page(?![s])/.test(o.dict))
    .map(([n]) => n)
    .sort((a, b) => a - b)

  const blocks: string[] = []
  for (const num of pageNums) {
    const dict = objs.get(num)?.dict ?? ''
    const fonts = pageFonts(dict, objs, global)
    const content = pageContents(dict, objs)
    if (!content) continue
    const text = runContent(tokenize(content), fonts)
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (text) blocks.push(text)
    if (blocks.length >= 300) break
  }

  const joined = blocks.join('\n\n')
  return {
    text: joined,
    pages: pageNums.length,
    chars: joined.replace(/\s/g, '').length
  }
}
