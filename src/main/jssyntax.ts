/**
 * 独立 JS 文件的语法校验（.js / .mjs / .cjs）。
 *
 * 为什么 htmlcheck 还不够：htmlcheck 只负责**内联在 .html 里的 <script>**，
 * 外部脚本（`<script src="game.js">`）它明确跳过 —— 因为那是「别的文件的责任」。
 * 而内置诊断（lsp/index.ts）要求工作区里有 tsconfig / jsconfig **并且**装了本地
 * typescript 才会跑；一个「index.html + game.js」的网页游戏，工作区里没有 tsconfig，
 * tsserver 直接返回 skipped:no-config。于是 game.js 写坏了**没有任何门禁拦**，
 * 模型一路写下去，浏览器打开白屏才发现。
 *
 * 这里和 htmlcheck 同源：不依赖任何项目配置，直接把整个文件交给 `node --check`。
 * 报错按行号折回原文件，模型拿到就能定位修改。只做**语法**校验，不做类型检查、
 * 不看运行时错误。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { promises as fsp } from 'node:fs'
import { parseNodeCheckError, blankLine } from './htmlcheck'

export interface JsSyntaxIssue {
  file: string
  /** 原文件里的行号（1 基） */
  line: number
  message: string
  /** 挖空恢复出来的后续错误：修掉第一条后才会暴露，语法结构已被改动过 */
  cascaded?: boolean
}

/** 每个文件最多报几条：满屏错误会把上下文挤爆，模型反而抓不住重点 */
const MAX_ISSUES_PER_FILE = 6
/** 同一个文件最多往下挖几条（和 htmlcheck 的 MAX_ISSUES_PER_BLOCK 对齐） */
const MAX_ISSUES_PER_BLOCK = 3
/** 整个检查的硬超时：node 起不来宁可放过，也不能把一轮卡死 */
const DEFAULT_TIMEOUT_MS = 15000

/** 只认纯 JS 文件；.ts/.tsx 交给 tsserver 诊断，这里是它的兜底，不是替代 */
const JS_RE = /\.(?:m?js|cjs)$/i

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
 * 一次挖出一个 .js 文件里的多处语法错误。
 *
 * 和 htmlcheck.scanBlock 同一套思路：node --check 一次只报第一条，
 * 靠「把出错行挖空再查一遍」把后面的也挖出来。行数不变，所以后续报的行号
 * 仍然对应原文件。只有第一条是确定的，后面的标 cascaded。
 */
async function scanFile(
  tmp: string,
  code: string,
  timeoutMs: number,
  budget: number
): Promise<Array<{ line: number; message: string; cascaded: boolean }>> {
  const out: Array<{ line: number; message: string; cascaded: boolean }> = []
  const seen = new Set<number>()
  let current = code
  for (let pass = 0; pass < MAX_ISSUES_PER_BLOCK && out.length < budget; pass++) {
    /**
     * 每一遍都写临时文件再查，第一遍也不例外 —— 关键是临时文件必须带 .js/.mjs
     * 后缀：node --check 依赖扩展名判断模块类型，无扩展名（如 x.js.roro-check-abc）
     * 会抛 ERR_UNKNOWN_FILE_EXTENSION，堆栈里的行号（几十~几百）被 parseNodeCheckError
     * 当成源码行号回灌给模型 —— 那是彻底误导的假坐标。
     */
    try {
      await fsp.writeFile(tmp, current, 'utf8')
    } catch {
      break
    }
    const stderr = await runNodeCheck(tmp, timeoutMs)
    if (!stderr.trim()) break
    const parsed = parseNodeCheckError(stderr)
    if (!parsed) break
    if (!seen.has(parsed.line)) {
      seen.add(parsed.line)
      out.push({ line: parsed.line, message: parsed.message, cascaded: pass > 0 })
    }
    // 行号缺失 / 报的是「文件突然结束」：再挖下去只会制造假错误
    if (parsed.line <= 0) break
    if (/Unexpected end of input|Unexpected end of string|Unterminated template/i.test(parsed.message)) break
    current = blankLine(current, parsed.line)
  }
  return out
}

/**
 * 检查一批独立 JS 文件的语法。
 *
 * @returns 只在**确实有语法错误**时返回条目；没有 node、超时、读不到都返回空数组
 */
export async function checkJsSyntax(files: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<JsSyntaxIssue[]> {
  const targets = files.filter((f) => JS_RE.test(f))
  if (!targets.length) return []
  const issues: JsSyntaxIssue[] = []
  let dir: string | null = null
  try {
    for (const file of targets) {
      let code: string
      try {
        code = await fsp.readFile(file, 'utf8')
      } catch {
        continue
      }
      if (!code.trim()) continue
      /**
       * 临时文件放系统临时目录、沿用原扩展名（.mjs 必须是 .mjs，否则顶层 await /
       * import 会被 node 当 CJS 误报）。和 htmlcheck.checkHtmlScripts 同一套做法。
       */
      if (!dir) dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'roroto-js-'))
      const ext = /\.mjs$/i.test(file) ? 'mjs' : 'js'
      const tmp = path.join(dir, `s${issues.length}.${ext}`)
      const found = await scanFile(tmp, code, timeoutMs, MAX_ISSUES_PER_FILE)
      for (const f of found) {
        issues.push({ file, line: f.line, message: f.message, cascaded: f.cascaded })
      }
    }
  } finally {
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
  return issues
}

/**
 * 把检查结果变成能直接塞进 tool result 的一段话。
 *
 * 措辞和 formatHtmlIssues 对齐：必须有「这是语法错误、不是建议」和「改哪一行」
 * 两件事。独立 JS 文件坏掉时，浏览器 / node 跑起来是直接的 SyntaxError，
 * 模型需要精确坐标，不是一句「有错误」。
 */
export function formatJsIssues(issues: JsSyntaxIssue[], workspace: string): string {
  const rel = (f: string): string => path.relative(workspace, f).split(path.sep).join('/') || path.basename(f)
  const head = `刚写入的 JS 文件有 ${issues.length} 处**语法错误**，运行时会直接抛 SyntaxError（node --check 的结论，不是风格建议）：`
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
