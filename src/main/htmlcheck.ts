/**
 * HTML 内联脚本的语法校验。
 *
 * 为什么需要单独一层：内置诊断（lsp/index.ts）要求工作区里有 tsconfig / jsconfig
 * **并且**装了本地 typescript 才会真正跑。像「一个 index.html 装下整个游戏」这种
 * 任务，工作区里只有一个 .html，诊断直接返回 skipped:'no-config' —— 于是十几处
 * 语法错误一次都没被报出来，全靠模型自己用眼睛看，看完还改不动。
 *
 * 这里不依赖任何项目配置：把 <script> 的内容抽出来交给 `node --check`，
 * 报错按脚本块起始行折算回 .html 里的真实行号，模型拿到就能定位修改。
 *
 * 边界：只做**语法**校验，不做类型检查、不看运行时错误。外部 <script src> 跳过
 * （那是别的文件的责任），type 不是 JS 的块也跳过（json / 模板会误报）。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface HtmlScriptIssue {
  file: string
  /** 折算回 .html 里的行号（1 基） */
  line: number
  message: string
  /**
   * 这一条是「修掉上面那处之后才会暴露的下一处」。
   *
   * node --check 遇到第一个语法错误就停，一次只报一条 —— 一整份重写的游戏有十几处
   * 错误时，模型要来回十几轮才改得完，每一轮都要重新读文件、重新生成。
   * 这里靠「把出错行挖空再查一遍」把后面的错误也挖出来，标注清楚来源，
   * 免得模型以为这些是同时存在的独立问题（挖空本身会改变语法结构）。
   */
  cascaded?: boolean
}

/** 每个文件最多报几条：满屏错误会把上下文挤爆，模型反而抓不住重点 */
const MAX_ISSUES_PER_FILE = 6
/**
 * 同一段脚本最多往下挖几条。
 *
 * 挖空一行的代价是「后面的语法结构可能变了」，挖得越深越不可信；
 * 三条足够把「一份重写里有好几处错」这种情况一次说清。
 */
const MAX_ISSUES_PER_BLOCK = 3
/** 整个检查的硬超时：node 起不来宁可放过，也不能把一轮卡死 */
const DEFAULT_TIMEOUT_MS = 15000

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
/** 不是 JS 的 type：交给 node --check 只会得到假错误 */
const NON_JS_TYPE = /^(application\/(ld\+)?json|text\/(template|html|x-template|plain)|importmap|speculationrules)$/i

function attrOf(attrs: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim()
}

/**
 * 从 node --check 的 stderr 里抠出「第几行 + 错误摘要」。
 * 输出形如：
 *   /tmp/x.js:12
 *     const a =
 *               ^
 *   SyntaxError: Unexpected end of input
 * 行号取第一处 `:<数字>`，错误摘要取第一条 SyntaxError / Error 行。
 */
export function parseNodeCheckError(stderr: string): { line: number; message: string } | null {
  const lines = stderr.split(/\r?\n/)
  let line = 0
  for (const l of lines) {
    const m = /^(?:.*?):(\d+)$/.exec(l.trim())
    if (m) {
      line = Number(m[1])
      break
    }
  }
  const errIdx = lines.findIndex((l) => /^\s*[A-Za-z]*Error\b/.test(l))
  if (errIdx < 0) return null
  // 错误摘要可能折行（"Unexpected token '}'" 后面还跟着具体位置），取到第一个非空续行为止
  const message = lines[errIdx].trim()
  return { line, message }
}

function runNodeCheck(file: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (text: string): void => {
      if (done) return
      done = true
      resolve(text)
    }
    let child
    try {
      child = spawn(process.env.ROROTO_NODE || 'node', ['--check', file], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      return finish('')
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退了 */
      }
      finish('')
    }, timeoutMs)
    child.stderr.on('data', (d: Buffer) => {
      if (out.length < 8000) out += d.toString('utf8')
    })
    // stdout 一般是空的；读掉防止管道堵住
    child.stdout.on('data', () => undefined)
    child.on('error', () => {
      clearTimeout(timer)
      finish('')
    })
    child.on('close', () => {
      clearTimeout(timer)
      finish(out)
    })
  })
}

/**
 * 把第 n 行（1 基）的内容挖空，保留换行。
 *
 * 用来做「错误恢复」：node --check 只会停在第 N 行，把这一行挖掉再查一次，
 * 就能看到第 N+1 处。行数不变，所以第二次报的行号仍然对应原文件 ——
 * 这是整段能成立的前提，绝不能删行。
 */
export function blankLine(code: string, line: number): string {
  const lines = code.split('\n')
  const idx = line - 1
  if (idx < 0 || idx >= lines.length) return code
  lines[idx] = ''
  return lines.join('\n')
}

/**
 * 一次挖出某段脚本里的多处语法错误。
 *
 * 只有一条是「确定的」：第一条。后面几条来自挖空恢复，语法结构已被改动，
 * 所以标 cascaded，措辞上也让模型先修第一条 —— 很多时候第一条修好，后面自然消失。
 */
async function scanBlock(
  code: string,
  tmp: string,
  startLine: number,
  timeoutMs: number,
  budget: number
): Promise<Array<{ line: number; message: string; cascaded: boolean }>> {
  const out: Array<{ line: number; message: string; cascaded: boolean }> = []
  const seen = new Set<number>()
  let current = code
  for (let pass = 0; pass < MAX_ISSUES_PER_BLOCK && out.length < budget; pass++) {
    await fs.writeFile(tmp, current, 'utf8')
    const stderr = await runNodeCheck(tmp, timeoutMs)
    if (!stderr.trim()) break
    const parsed = parseNodeCheckError(stderr)
    if (!parsed) break
    // node 报的是**脚本块内部**的行号，加上块起始偏移才是 .html 里的行号
    const line = startLine + Math.max(0, parsed.line - 1)
    if (!seen.has(line)) {
      seen.add(line)
      out.push({ line, message: parsed.message, cascaded: pass > 0 })
    }
    // 行号缺失 / 已经挖空到底 / 报的是「文件突然结束」：再挖下去只会制造假错误
    if (parsed.line <= 0) break
    if (/Unexpected end of input|Unexpected end of string|Unterminated template/i.test(parsed.message)) break
    current = blankLine(current, parsed.line)
  }
  return out
}

/** 抽出一个 html 文件里所有值得检查的内联脚本块 */
export function extractInlineScripts(html: string): Array<{ code: string; startLine: number; module: boolean }> {
  const out: Array<{ code: string; startLine: number; module: boolean }> = []
  SCRIPT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SCRIPT_RE.exec(html))) {
    const attrs = m[1] ?? ''
    // 外部脚本：语法由那个 .js 自己负责
    if (attrOf(attrs, 'src')) continue
    const type = attrOf(attrs, 'type')
    if (type && NON_JS_TYPE.test(type)) continue
    const body = m[2] ?? ''
    if (!body.trim()) continue
    // 脚本内容从 `<script ...>` 的 `>` 之后开始，折算行号要把这段前缀算进去。
    // 紧跟一个换行时（最常见的写法），第一行其实是 `<script>` 那一行的残余空行，
    // 把它剥掉并把起始行 +1，行号才是「第一行代码在第几行」这种直觉语义。
    const lead = /^\r?\n/.exec(body)
    const code = lead ? body.slice(lead[0].length) : body
    const bodyStart = m.index + m[0].indexOf('>') + 1
    const startLine = html.slice(0, bodyStart).split('\n').length + (lead ? 1 : 0)
    const isModule = /^module$/i.test(type) || /(^|\n)\s*(import|export)\s/.test(code)
    out.push({ code, startLine, module: isModule })
  }
  return out
}

/**
 * 检查一批 .html 里的内联脚本语法。
 *
 * @returns 只在**确实有语法错误**时返回条目；没有 node、没有 html、超时都返回空数组
 */
export async function checkHtmlScripts(files: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HtmlScriptIssue[]> {
  const targets = files.filter((f) => /\.html?$/i.test(f))
  if (!targets.length) return []
  const issues: HtmlScriptIssue[] = []
  let dir: string | null = null
  try {
    for (const file of targets) {
      let html: string
      try {
        html = await fs.readFile(file, 'utf8')
      } catch {
        continue
      }
      // 大文件才值得抽出脚本，但太小的也可能藏错误 —— 不设下限
      const blocks = extractInlineScripts(html)
      if (!blocks.length) continue
      if (!dir) dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roroto-html-'))
      let reported = 0
      for (let i = 0; i < blocks.length && reported < MAX_ISSUES_PER_FILE; i++) {
        const block = blocks[i]
        const tmp = path.join(dir, `s${i}.${block.module ? 'mjs' : 'js'}`)
        const found = await scanBlock(block.code, tmp, block.startLine, timeoutMs, MAX_ISSUES_PER_FILE - reported)
        for (const f of found) {
          issues.push({ file, line: f.line, message: f.message, cascaded: f.cascaded })
          reported += 1
        }
      }
    }
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
  return issues
}

/**
 * 把检查结果变成能直接塞进 tool result 的一段话。
 *
 * 措辞上必须有「这是语法错误、不是建议」和「改哪一行」两件事：
 * 上一版的文件写了一个坏掉的 IIFE，模型读回自己的代码时看不出问题，
 * 于是又整份重写了一遍 —— 它需要的是精确的坐标，不是一句「有错误」。
 */
export function formatHtmlIssues(issues: HtmlScriptIssue[], workspace: string): string {
  const rel = (f: string): string => path.relative(workspace, f).split(path.sep).join('/') || path.basename(f)
  const head = `刚写入的 HTML 内联脚本有 ${issues.length} 处**语法错误**，浏览器打开会直接白屏（node --check 的结论，不是风格建议）：`
  // 第一条是确定的；后面几条是「挖掉出错行再查」得到的，语法结构已经被改动过
  const body = issues.map((it, i) =>
    i === 0 || !it.cascaded
      ? `- ${rel(it.file)}:${it.line}  ${it.message}`
      : `- ${rel(it.file)}:${it.line}  ${it.message}   ← 修掉上面那处后才会暴露，先修上面的`
  )
  const cascaded = issues.some((it) => it.cascaded)
  return [
    head,
    ...body,
    '',
    '改法：用 read_file 看这几行附近，再 edit_file 精确替换。不要整份重写 —— 重写会引入新的错误，也可能再次被输出上限截断。',
    cascaded
      ? '注意：只有第一条是「一次就能确定」的；后面几条是把出错行挖空后继续查出来的，位置准确但可能随第一处一起消失。一次修一条，改完再跑。'
      : ''
  ]
    .filter((l) => l !== '')
    .join('\n')
}
