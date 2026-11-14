/**
 * 一个最小的 tsserver 客户端。
 *
 * 为什么用 tsserver 而不是起一个 LSP 服务器：
 * - TypeScript 项目里 `node_modules/typescript/lib/tsserver.js` 本来就在，不需要用户装任何东西；
 * - 它是编辑器级的增量语义，打开一个文件几百毫秒就能拿到诊断，
 *   而 `tsc --noEmit` 全量在大项目里要几十秒，不可能每改一个文件跑一次。
 *
 * 协议有两个坑，都必须照着它的实际行为来（不是文档写的那样）：
 * 1. **收发不对称**：我们发过去的必须是一行一个 JSON（行分隔）；
 *    tsserver 回给我们的却带 `Content-Length: N\r\n\r\n` 头。发错一字节它会回
 *   `Unexpected token 'C', "Content-Length..."`，且 request_seq 归零 —— 表现为「静默无结果」。
 * 2. **open 不会自动推诊断**。open 只加载项目（能看到 projectLoadingFinish），
 *    必须再发一条 `geterr` 才会推 syntaxDiag / semanticDiag，
 *    然后以 `requestCompleted`（body.request_seq 对得上）作为「这一批查完了」的信号。
 *
 * 局限说清楚：只覆盖 TS/JS。别的语言要接真 LSP，那是另一件事。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { normalizeDiag, type Diag, type RawTsDiagnostic } from '../../shared/diagnostics'
import type { LspLocation, LspReferences } from './types'

interface TsOutbound {
  seq: number
  type: 'request'
  command: string
  arguments?: unknown
}

interface TsInbound {
  type?: string
  event?: string
  command?: string
  request_seq?: number
  success?: boolean
  message?: string
  body?: {
    file?: string
    diagnostics?: RawTsDiagnostic[]
    request_seq?: number
    symbolDisplayString?: string
    symbolName?: string
    symbolStartOffset?: number
    symbolKind?: string
  } | null
}

/** tsserver 的 definition 结果：file + start 的 1-based 行/列 */
interface RawDefinition {
  file?: string
  start?: { line?: number; offset?: number } | null
}

/** tsserver 的 references 结果：file + start + lineText */
interface RawReference {
  file?: string
  start?: { line?: number; offset?: number } | null
  lineText?: string
}

/** 首轮要加载整个 tsconfig 和 lib.d.ts，给足时间；之后都是增量 */
const FIRST_TIMEOUT = 9000
const TIMEOUT = 4000
/** 引用查找最多回这么多条，多了会撑爆上下文 */
const MAX_REFS = 60

/** 路径归一：tsserver 回来的路径大小写、斜杠都可能和我们传的不一样 */
function key(file: string): string {
  return path.resolve(file).replace(/\\/g, '/').toLowerCase()
}

export class TsServer {
  private child: ChildProcessWithoutNullStreams | null = null
  private seq = 1
  private chunks: Buffer[] = []
  private buffered = 0
  /** 已 open 的文件（key 归一），决定下一步发 open 还是 reload */
  private opened = new Set<string>()
  /** 正在收集的文件 → 是否见过诊断事件（只用于调试与防御，不靠它判完成） */
  private collecting = new Set<string>()
  private diags: Diag[] = []
  /** geterr 的 request_seq → 放行函数 */
  private waiting = new Map<number, () => void>()
  /**
   * definition / references 是「发命令 → 同步收 response」，结果直接带在 response body 里。
   * 等 response 的 request_seq 对上就交出去。
   */
  private navWaiting = new Map<number, (body: unknown) => void>()
  private dead = false

  constructor(
    private readonly workspace: string,
    private readonly tsServerPath: string
  ) {}

  /** 从一个工作区里找 tsserver；找不到返回 null（项目没装 typescript） */
  static locate(workspace: string): string | null {
    const candidates = [
      path.join(workspace, 'node_modules', 'typescript', 'lib', 'tsserver.js'),
      // monorepo：包管理器把依赖提在上一层
      path.join(workspace, '..', 'node_modules', 'typescript', 'lib', 'tsserver.js'),
      path.join(workspace, '..', '..', 'node_modules', 'typescript', 'lib', 'tsserver.js')
    ]
    for (const c of candidates) {
      if (existsSync(c)) return path.resolve(c)
    }
    return null
  }

  start(): void {
    if (this.child || this.dead) return
    /**
     * 打包后没有独立的 node，用 Electron 自己的二进制 + ELECTRON_RUN_AS_NODE 跑。
     * 注意这里是**主动设置**这个变量：verify.ts 里要删掉它（跑构建时行为会错），
     * 而这里恰恰相反 —— 我们把 electron 当 node 用。
     */
    const child = spawn(
      process.execPath,
      [this.tsServerPath, '--disableAutomaticTypingAcquisition', '--logVerbosity', 'terse'],
      {
        cwd: this.workspace,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      }
    ) as ChildProcessWithoutNullStreams

    // 二进制帧：Content-Length 是字节数，按 utf8 解码前必须按字节切
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    // stderr 里是 tsserver 自己的抱怨，不往界面上抛
    child.stderr.on('data', () => undefined)
    child.on('exit', () => this.reset())
    child.on('error', () => {
      this.reset()
      this.dead = true
    })
    this.child = child
  }

  private reset(): void {
    this.child = null
    this.opened.clear()
    this.collecting.clear()
    // 有人还在等结果：立刻放行，别让主循环卡满超时
    for (const resolve of this.waiting.values()) resolve()
    this.waiting.clear()
  }

  private send(command: string, args?: unknown): number {
    const msg: TsOutbound = { seq: this.seq++, type: 'request', command }
    if (args !== undefined) msg.arguments = args
    try {
      // 行分隔（见文件头第 1 条）
      this.child?.stdin.write(`${JSON.stringify(msg)}\n`)
    } catch {
      // 进程没了：让等待方自己超时，不在这里抛
    }
    return msg.seq
  }

  private onData(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.buffered += chunk.length
    this.drain()
    // 防御：上游吐出没有头也没有换行的巨大垃圾，别让缓冲无限涨
    if (this.buffered > 16 * 1024 * 1024) {
      this.chunks = []
      this.buffered = 0
    }
  }

  private drain(): void {
    for (;;) {
      const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered)
      this.chunks = [buf]
      const headEnd = buf.indexOf('\r\n\r\n')
      if (headEnd < 0) return

      const head = buf.slice(0, headEnd).toString('latin1')
      const m = /Content-Length:\s*(\d+)/i.exec(head)
      if (!m) {
        // 不是标准帧：丢掉这一段的头，继续找下一个
        this.consume(headEnd + 4)
        continue
      }
      const len = Number(m[1])
      const start = headEnd + 4
      if (buf.length < start + len) return // 还没收全

      const body = buf.slice(start, start + len).toString('utf8')
      this.consume(start + len)
      try {
        this.onMessage(JSON.parse(body) as TsInbound)
      } catch {
        // 单条坏消息不该拖垮整条流
      }
    }
  }

  private consume(n: number): void {
    const rest = this.chunks[0].slice(n)
    this.chunks = rest.length ? [rest] : []
    this.buffered = rest.length
  }

  private onMessage(msg: TsInbound): void {
    if (msg.type === 'response') {
      // definition / references 的结果带在 response body 里，直接交出去
      if (typeof msg.request_seq === 'number' && this.navWaiting.has(msg.request_seq)) {
        const resolve = this.navWaiting.get(msg.request_seq)
        this.navWaiting.delete(msg.request_seq)
        resolve?.(msg.success === false ? null : msg.body)
        return
      }
      // 命令出错（文件不在项目里等）也要放行，否则白等满超时
      if (msg.success === false && typeof msg.request_seq === 'number') {
        this.waiting.get(msg.request_seq)?.()
      }
      return
    }
    if (msg.type !== 'event') return

    if (msg.event === 'requestCompleted') {
      const seq = Number(msg.body?.request_seq)
      const resolve = this.waiting.get(seq)
      if (resolve) {
        this.waiting.delete(seq)
        resolve()
      }
      return
    }

    if (msg.event !== 'syntaxDiag' && msg.event !== 'semanticDiag') return
    const file = msg.body?.file
    if (!file || !Array.isArray(msg.body?.diagnostics)) return
    if (!this.collecting.has(key(file))) return
    for (const raw of msg.body.diagnostics) {
      const d = normalizeDiag(file, raw)
      if (d) this.diags.push(d)
    }
  }

  /**
   * 批量取诊断。files 会先同步给 tsserver（没开过的 open、开过的 reload），
   * 再发一条 geterr 让它们真的算一遍，等 requestCompleted。
   *
   * 一次问多个文件是刻意的：一个 patch 可能同时动五个文件，
   * 一个个问要五个超时窗口，批量只花一个。
   */
  async diagnose(files: string[]): Promise<Diag[]> {
    if (this.dead) return []
    this.start()
    if (!this.child) return []

    const first = this.opened.size === 0
    this.diags = []
    this.collecting = new Set()
    for (const file of files) {
      const k = key(file)
      this.collecting.add(k)
      if (this.opened.has(k)) {
        /**
         * 已经开着：用 reload 而不是 change。
         * change 做全文替换要先知道旧内容有几行；reload 就是为「磁盘上的文件变了」
         * 设计的，重读一遍再算诊断，行为确定。
         */
        this.send('reload', { file, tmpfile: file })
      } else {
        this.send('open', { file })
        this.opened.add(k)
      }
    }

    // open/reload 只是把文件交给它；不补这一条是不会推诊断的（见文件头第 2 条）
    const seq = this.send('geterr', { delay: 0, files })

    await new Promise<void>((resolve) => {
      this.waiting.set(seq, resolve)
      setTimeout(() => {
        // 超时也要把 waiting 清掉，否则同一个 seq 永远挂着
        if (this.waiting.delete(seq)) resolve()
      }, first ? FIRST_TIMEOUT : TIMEOUT)
    })

    const out = this.diags
    this.diags = []
    this.collecting.clear()
    return out
  }

  /**
   * 发一条命令，等它的 response body 返回（definition / references 是同步 response，
   * 不像 geterr 走事件推送）。
   */
  private askFor(command: string, args: unknown): Promise<unknown | null> {
    if (this.dead || !this.child) return Promise.resolve(null)
    const seq = this.send(command, args)
    return new Promise((resolve) => {
      this.navWaiting.set(seq, resolve)
      setTimeout(() => {
        if (this.navWaiting.delete(seq)) resolve(null)
      }, TIMEOUT)
    })
  }

  /** 定义跳转。文件不在项目里 / 找不到定义时返回空数组 */
  async definition(file: string, line: number, col: number): Promise<LspLocation[]> {
    if (this.dead) return []
    this.start()
    if (!this.child) return []
    await this.ensureOpen(file)
    const body = await this.askFor('definition', { file, line, offset: col })
    if (!Array.isArray(body)) return []
    const out: LspLocation[] = []
    for (const d of body as RawDefinition[]) {
      if (!d.file || !d.start) continue
      out.push({
        file: d.file,
        line: Math.max(1, Math.round(Number(d.start.line) || 1)),
        col: Math.max(1, Math.round(Number(d.start.offset) || 1))
      })
    }
    return out
  }

  /** 引用查找。结果被截断到 MAX_REFS 条 */
  async references(file: string, line: number, col: number): Promise<LspReferences> {
    if (this.dead) return { refs: [], truncated: false, fileCount: 0 }
    this.start()
    if (!this.child) return { refs: [], truncated: false, fileCount: 0 }
    await this.ensureOpen(file)
    const body = await this.askFor('references', { file, line, offset: col })
    const refsRaw = body && typeof body === 'object' ? (body as { refs?: RawReference[] }).refs : undefined
    if (!Array.isArray(refsRaw)) return { refs: [], truncated: false, fileCount: 0 }
    const refs: LspLocation[] = []
    for (const r of refsRaw) {
      if (!r.file || !r.start) continue
      refs.push({
        file: r.file,
        line: Math.max(1, Math.round(Number(r.start.line) || 1)),
        col: Math.max(1, Math.round(Number(r.start.offset) || 1)),
        snippet: (r.lineText ?? '').trim() || undefined
      })
    }
    const files = new Set(refs.map((r) => r.file))
    return { refs: refs.slice(0, MAX_REFS), truncated: refs.length > MAX_REFS, fileCount: files.size }
  }

  /** 确保文件已 open（没开过就 open，开过就跳过；不 reload，读当前位置用磁盘上已有的即可） */
  private async ensureOpen(file: string): Promise<void> {
    const k = key(file)
    if (this.opened.has(k)) return
    this.opened.add(k)
    // open 是异步加载，等它完成，否则立刻问 definition 可能拿不到
    await new Promise<void>((resolve) => {
      const seq = this.send('open', { file, projectRootPath: this.workspace })
      this.waiting.set(seq, resolve)
      setTimeout(() => {
        if (this.waiting.delete(seq)) resolve()
      }, FIRST_TIMEOUT)
    })
  }

  dispose(): void {
    this.dead = true
    const child = this.child
    this.reset()
    if (!child) return
    try {
      child.stdin.write(`${JSON.stringify({ seq: this.seq++, type: 'request', command: 'exit' })}\n`)
    } catch {
      // ignore
    }
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
      } else {
        child.kill()
      }
    } catch {
      try {
        child.kill()
      } catch {
        // ignore
      }
    }
  }
}
