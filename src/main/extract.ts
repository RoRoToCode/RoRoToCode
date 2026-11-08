import { execFile } from 'node:child_process'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pdfToText } from './pdf'

/**
 * 把附件里的文字抽出来，直接塞进消息。
 *
 * 为什么不在提示里让模型自己去读？
 * 小模型的工具调用意识很弱，看到路径也会回「请把内容发给我」。所以正文由程序先抽好，
 * 模型只需要分析文字，不依赖它是否会调工具、也不依赖它是否愿意调工具。
 */

export interface ExtractInput {
  /** 真实磁盘路径 */
  absPath: string
  /** 给模型看的路径，如 inbox/x.pdf */
  display: string
  kindLabel: string
  size: number
  /** 最多保留多少字符 */
  budget: number
}

export interface ExtractOutcome {
  ok: boolean
  text: string
  /** 一句话说明，会跟在标题里 */
  note: string
}

/** 超过这个体积就不读了，读进来也放不进上下文 */
const MAX_READ = 64 * 1024 * 1024

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'log', 'ini', 'env', 'rst', 'csv', 'tsv',
  'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'css', 'scss',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'c', 'h', 'cpp',
  'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'sh', 'bat', 'ps1',
  'sql', 'vue', 'srt', 'vtt', 'tex', 'm'
])

function extOf(p: string): string {
  return path.extname(p).replace(/^\./, '').toLowerCase()
}

/* ------------------------------------------------------------------ 编码 */

/** 带 BOM 就按 BOM，否则先 UTF-8，坏字节多就试 GBK */
function decodeText(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8')
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le')
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2))
    body.swap16()
    return body.toString('utf16le')
  }
  const utf8 = buf.toString('utf8')
  let bad = 0
  for (let i = 0; i < utf8.length; i++) if (utf8.charCodeAt(i) === 0xfffd) bad++
  if (bad > Math.max(2, utf8.length * 0.002)) {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return utf8
    }
  }
  return utf8
}

/** 一眼能看出「这是人话」的比例，用来判断要不要换一种解码方式 */
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

/** PDF 常把 GBK/UTF-8 字节当 latin1 存，抽出来是乱码，这里试几种还原挑最像人话的 */
function fixMojibake(text: string): string {
  if (!text || readableRatio(text) > 0.9) return text
  const bytes = Buffer.from(text, 'latin1')
  const candidates = [text, bytes.toString('utf8')]
  try {
    candidates.push(new TextDecoder('gbk').decode(bytes))
  } catch {
    /* 没 GBK 支持就算了 */
  }
  let best = text
  let bestRatio = readableRatio(text)
  for (const c of candidates) {
    const r = readableRatio(c)
    if (r > bestRatio + 0.05) {
      best = c
      bestRatio = r
    }
  }
  return best
}

/* ------------------------------------------------------------------- zip */

/** 迷你 zip 读取，只认 stored / deflate，够读 docx / xlsx / pptx / odt */
function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let eocd = -1
  const floor = Math.max(0, buf.length - 66000)
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return out

  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')
    off += 46 + nameLen + extraLen + commentLen
    if (!name || name.endsWith('/')) continue
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue
    const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28)
    const raw = buf.subarray(start, start + compSize)
    try {
      out.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw))
    } catch {
      /* 坏条目跳过，别的条目还能用 */
    }
  }
  return out
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
}

function stripTags(s: string): string {
  return xmlUnescape(s.replace(/<[^>]+>/g, ''))
}

/* ----------------------------------------------------------- Office 文档 */

function docxText(zip: Map<string, Buffer>): string {
  const xml = zip.get('word/document.xml')?.toString('utf8') ?? ''
  if (!xml) return ''
  const lines: string[] = []
  for (const block of xml.split(/<\/w:p>/)) {
    let line = ''
    const tokens = block.match(/<w:t[^>]*>[\s\S]*?<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g) ?? []
    for (const t of tokens) {
      if (t.startsWith('<w:tab')) line += '\t'
      else if (t.startsWith('<w:br') || t.startsWith('<w:cr')) line += '\n'
      else line += stripTags(t)
    }
    if (line.trim()) lines.push(line)
  }
  return lines.join('\n')
}

function sheetIndex(name: string): number {
  const m = /(\d+)\.xml$/.exec(name)
  return m ? Number(m[1]) : 0
}

function xlsxText(zip: Map<string, Buffer>): string {
  const shared: string[] = []
  const ss = zip.get('xl/sharedStrings.xml')?.toString('utf8') ?? ''
  for (const si of ss.split(/<\/si>/)) {
    const ts = si.match(/<t[^>]*>[\s\S]*?<\/t>/g) ?? []
    shared.push(ts.map(stripTags).join(''))
  }

  const sheets = [...zip.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => sheetIndex(a) - sheetIndex(b))
  const out: string[] = []
  sheets.forEach((name, idx) => {
    const xml = zip.get(name)?.toString('utf8') ?? ''
    const rows: string[] = []
    for (const row of xml.split(/<\/row>/)) {
      const cells: string[] = []
      const re = /<c\b([^>]*)>([\s\S]*?)<\/c>/g
      let m: RegExpExecArray | null
      while ((m = re.exec(row))) {
        const type = /t="([^"]+)"/.exec(m[1])?.[1] ?? ''
        const body = m[2]
        if (type === 'inlineStr') {
          const ts = body.match(/<t[^>]*>[\s\S]*?<\/t>/g) ?? []
          cells.push(ts.map(stripTags).join(''))
          continue
        }
        const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''
        if (type === 's') cells.push(shared[Number(v)] ?? '')
        else cells.push(xmlUnescape(v))
      }
      while (cells.length && !cells[cells.length - 1].trim()) cells.pop()
      if (cells.some((c) => c.trim())) rows.push(cells.join('\t'))
      if (rows.length >= 4000) break
    }
    if (rows.length) out.push(`【工作表 ${idx + 1}】\n${rows.join('\n')}`)
  })
  return out.join('\n\n')
}

function pptxText(zip: Map<string, Buffer>): string {
  const slides = [...zip.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => sheetIndex(a) - sheetIndex(b))
  const out: string[] = []
  slides.forEach((name, idx) => {
    const xml = zip.get(name)?.toString('utf8') ?? ''
    const lines = xml
      .split(/<\/a:p>/)
      .map((p) => (p.match(/<a:t[^>]*>[\s\S]*?<\/a:t>/g) ?? []).map(stripTags).join(''))
      .filter((s) => s.trim())
    if (lines.length) out.push(`【第 ${idx + 1} 页】\n${lines.join('\n')}`)
  })
  return out.join('\n\n')
}

/** odt / ods：content.xml 里按段落抽 */
function odfText(zip: Map<string, Buffer>): string {
  const xml = zip.get('content.xml')?.toString('utf8') ?? ''
  if (!xml) return ''
  const lines: string[] = []
  for (const block of xml.split(/<\/text:p>|<\/text:h>/)) {
    const line = (block.match(/<text:[a-z]+[^>]*>[\s\S]*?<\/text:[a-z]+>/g) ?? [])
      .map(stripTags)
      .join('')
    const plain = stripTags(block).trim() || line.trim()
    if (plain) lines.push(plain)
  }
  return lines.join('\n')
}

function rtfText(src: string): string {
  let s = src.replace(/\{\\\*[\s\S]*?\}/g, ' ')
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, h: string) => {
    try {
      return new TextDecoder('gbk').decode(Buffer.from([parseInt(h, 16)]))
    } catch {
      return ''
    }
  })
  s = s.replace(/\\par[d]?/g, '\n').replace(/\\tab/g, '\t').replace(/\\line/g, '\n')
  s = s.replace(/\\u(-?\d+)\??/g, (_, d: string) => String.fromCharCode((Number(d) + 65536) % 65536))
  s = s.replace(/\\[a-zA-Z]+-?\d* ?/g, '').replace(/[{}]/g, '')
  return s
}

/** 老 .doc / .xls / .ppt：没有结构可解，只能从二进制里捞连续可读串 */
function legacyText(buf: Buffer): string {
  const chunks: string[] = []

  // 1) UTF-16LE：Word 97 之后的正文多为此形态
  let cur: string[] = []
  const flush = () => {
    if (cur.length >= 6) chunks.push(cur.join(''))
    cur = []
  }
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const code = buf.readUInt16LE(i)
    const printable =
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0x20 && code <= 0x7e) ||
      code === 0x0d ||
      code === 0x0a ||
      code === 0x09
    if (printable) {
      cur.push(code === 0x0d ? '\n' : String.fromCharCode(code))
    } else {
      flush()
    }
  }
  flush()

  // 2) 8 位页（cp936）：整段按 GBK 解，只留长一点的汉字串，避免把二进制当字
  const gbk = fixMojibake(buf.toString('latin1'))
  const runs = gbk.match(/[\u4e00-\u9fff][\u4e00-\u9fff\u3000-\u303f\uff00-\uffef0-9A-Za-z，。、；：？！（）《》“”‘’—…\s]{5,}/g) ?? []
  for (const run of runs) {
    if (run.replace(/\s/g, '').length >= 6) chunks.push(run)
  }

  // 去重、去纯符号
  const seen = new Set<string>()
  const kept: string[] = []
  for (const c of chunks) {
    const t = c.replace(/[ \t]+/g, ' ').trim()
    if (!t || t.length < 4) continue
    if (readableRatio(t) < 0.6) continue
    const key = t.slice(0, 40)
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(t)
  }
  return kept.join('\n')
}

/* ------------------------------------------------------------------- PDF */

const PY_PDF = [
  'import sys',
  'try:',
  '    from pypdf import PdfReader',
  'except Exception:',
  '    try:',
  '        from PyPDF2 import PdfReader',
  '    except Exception:',
  '        sys.exit(3)',
  'try:',
  '    reader = PdfReader(sys.argv[1])',
  'except Exception:',
  '    sys.exit(4)',
  'parts = []',
  'for i, page in enumerate(reader.pages):',
  '    if i >= 300: break',
  '    try:',
  '        t = page.extract_text() or ""',
  '    except Exception:',
  '        t = ""',
  '    if t.strip(): parts.append(t)',
  'sys.stdout.buffer.write(("\\n".join(parts)).encode("utf-8"))'
].join('\n')

/** 装了 pypdf 的话用它当第二意见（版式复杂的 PDF 效果更好） */
function pdfViaPython(absPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'python',
      ['-c', PY_PDF, absPath],
      { windowsHide: true, timeout: 25000, maxBuffer: 48 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null)
        const text = String(stdout ?? '').trim()
        resolve(text.length > 0 ? text : null)
      }
    )
  })
}

async function pdfOutcome(absPath: string, buf: Buffer): Promise<ExtractOutcome> {
  // 内置解析优先：不依赖 Python，也不会因为没装库就整段读不出来
  try {
    const builtin = pdfToText(buf)
    if (builtin.chars >= 10 && readableRatio(builtin.text) >= 0.6) {
      const pages = builtin.pages > 1 ? `，共 ${builtin.pages} 页` : ''
      return { ok: true, text: builtin.text, note: `PDF 文字已抽取${pages}` }
    }
  } catch {
    /* 落到 python */
  }

  const viaPy = await pdfViaPython(absPath)
  if (viaPy && readableRatio(viaPy) >= 0.6) {
    return { ok: true, text: viaPy, note: 'PDF 文字已抽取' }
  }

  return {
    ok: false,
    text: '',
    note: '这个 PDF 里没有可提取的文字层（多半是扫描件 / 图片版），要说清想从里面找什么'
  }
}

/* ------------------------------------------------------- 老版 Office 转换 */

/**
 * .doc / .wps 是二进制复合文档，自己解几乎不可能完整。
 * 机器上装了 Word 或 WPS 时，用 COM 打开再取 Content.Text 最省事、也最准。
 * 没有 Office 就退回二进制捞字，并提示另存新格式。
 */
const WORD_COM = `
$ErrorActionPreference = 'Stop'
$src = $env:ROROTO_IN
$out = $env:ROROTO_OUT
$app = $null
$doc = $null
try {
  $app = New-Object -ComObject Word.Application
  $app.Visible = $false
  $app.DisplayAlerts = 0
  try { $app.AutomationSecurity = 3 } catch {}
  $doc = $app.Documents.Open($src, $false, $true)
  $text = $doc.Content.Text
  [IO.File]::WriteAllText($out, $text, (New-Object Text.UTF8Encoding($false)))
  Write-Output 'OK'
} catch {
  Write-Output ('ERR ' + $_.Exception.Message)
} finally {
  if ($doc) { try { $doc.Close(0) } catch {} }
  if ($app) { try { $app.Quit() } catch {} }
}
`

function wordComText(absPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const out = path.join(
      os.tmpdir(),
      `roroto-doc-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`
    )
    const encoded = Buffer.from(WORD_COM, 'utf16le').toString('base64')
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        timeout: 60000,
        env: { ...process.env, ROROTO_IN: absPath, ROROTO_OUT: out }
      },
      (err, stdout) => {
        const cleanup = () => void fs.unlink(out).catch(() => undefined)
        if (err || !/OK/.test(String(stdout))) {
          cleanup()
          return resolve(null)
        }
        fs.readFile(out, 'utf8')
          .then((text) => {
            cleanup()
            resolve(text.trim() ? text : null)
          })
          .catch(() => {
            cleanup()
            resolve(null)
          })
      }
    )
  })
}

/* ---------------------------------------------------------------- 主入口 */

function clip(text: string, budget: number): { text: string; cut: number } {
  const clean = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (clean.length <= budget) return { text: clean, cut: 0 }
  let head = clean.slice(0, budget)
  const nl = head.lastIndexOf('\n')
  if (nl > budget * 0.6) head = head.slice(0, nl)
  return { text: head, cut: clean.length - head.length }
}

export async function extractAttachment(input: ExtractInput): Promise<ExtractOutcome> {
  const ext = extOf(input.absPath)
  if (input.size > MAX_READ) {
    return { ok: false, text: '', note: `文件 ${Math.round(input.size / 1024 / 1024)} MB，太大没有读取` }
  }

  let buf: Buffer
  try {
    buf = await fs.readFile(input.absPath)
  } catch (err) {
    return { ok: false, text: '', note: `读不到文件：${(err as Error).message}` }
  }

  try {
    if (ext === 'pdf') {
      const res = await pdfOutcome(input.absPath, buf)
      return finish(res, input.budget)
    }

    // zip 家族：先看魔数，防止 .doc 其实是 docx
    const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b
    if (isZip) {
      const zip = readZip(buf)
      let text = ''
      let label = ''
      if (zip.has('word/document.xml')) {
        text = docxText(zip)
        label = 'Word 正文'
      } else if (zip.has('xl/workbook.xml') || zip.has('xl/sharedStrings.xml')) {
        text = xlsxText(zip)
        label = '表格内容'
      } else if (zip.has('ppt/presentation.xml')) {
        text = pptxText(zip)
        label = '幻灯片文字'
      } else if (zip.has('content.xml')) {
        text = odfText(zip)
        label = '文档正文'
      }
      if (label) {
        if (!text.trim()) {
          return { ok: false, text: '', note: `${label}是空的，或者全是图片` }
        }
        return finish({ ok: true, text, note: `${label}已抽取` }, input.budget)
      }
    }

    if (ext === 'doc' || ext === 'wps') {
      const viaWord = await wordComText(input.absPath)
      if (viaWord && viaWord.replace(/\s/g, '').length >= 10) {
        return finish({ ok: true, text: viaWord, note: 'Word 正文已抽取' }, input.budget)
      }
      const text = legacyText(buf)
      if (text.trim().length < 10) {
        return {
          ok: false,
          text: '',
          note: '这个 .doc 读不出正文（本机没装 Word/WPS，二进制里也没找到文字），另存为 .docx 再发一次'
        }
      }
      return finish({ ok: true, text, note: '旧版格式只能粗略抽取，可能有少量乱码' }, input.budget)
    }

    if (ext === 'xls' || ext === 'ppt' || ext === 'et' || ext === 'dps') {
      return {
        ok: false,
        text: '',
        note: `老版 .${ext} 不支持自动读取，用 Office/WPS 另存为 .xlsx / .pptx 后再发一次`
      }
    }

    if (ext === 'rtf') {
      return finish({ ok: true, text: rtfText(buf.toString('latin1')), note: 'RTF 正文已抽取' }, input.budget)
    }

    if (TEXT_EXT.has(ext) || ext === '') {
      const text = decodeText(buf)
      if (!text.trim()) return { ok: false, text: '', note: '文件是空的' }
      return finish({ ok: true, text, note: '文本内容已读取' }, input.budget)
    }

    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'svg'].includes(ext)) {
      return {
        ok: false,
        text: '',
        note: '这是图片，当前模型不能直接看图；需要画面内容的话，先说清楚要识别什么'
      }
    }

    return { ok: false, text: '', note: `暂不支持自动读取 .${ext} 文件` }
  } catch (err) {
    return { ok: false, text: '', note: `解析失败：${(err as Error).message}` }
  }
}

function finish(res: ExtractOutcome, budget: number): ExtractOutcome {
  if (!res.ok) return res
  const total = res.text.replace(/\s/g, '').length
  const { text, cut } = clip(res.text, budget)
  if (cut <= 0) return { ok: true, text, note: res.note }
  const kept = text.replace(/\s/g, '').length
  return {
    ok: true,
    text,
    note: `${res.note}；原文约 ${total} 字，这里只带了前 ${kept} 字，需要后面的内容请让用户说明看哪段`
  }
}

/** 把抽取结果拼成喂给模型的一段，紧跟在【附件】清单后面 */
export function renderAttachmentBody(
  items: Array<{ display: string; kindLabel: string; size: number; outcome: ExtractOutcome }>,
  /** 图片之类的补充说明，同样放在标记之内，界面只显示「附件正文已读取」 */
  extraNotes: string[] = []
): string {
  if (!items.length && !extraNotes.length) return ''
  const blocks = items.map((it, i) => {
    const title = `【附件${i + 1}】${it.display}（${it.kindLabel}，${sizeText(it.size)}）`
    if (!it.outcome.ok) return `${title}\n（程序没能抽取正文：${it.outcome.note}）`
    return `${title}\n（${it.outcome.note}）\n${it.outcome.text}\n【附件${i + 1} 结束】`
  })
  return [
    '----- 以下正文由程序自动从附件中抽取，可以直接据此回答，不要让用户再粘贴一遍 -----',
    ...extraNotes,
    blocks.join('\n\n'),
    '----- 附件正文结束 -----'
  ]
    .filter((part) => part && part.trim())
    .join('\n\n')
}

function sizeText(bytes: number): string {
  if (!bytes) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
