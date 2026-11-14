import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'

/**
 * 断点续传下载器（一键安装 / 模型下载共用）。
 *
 * 为什么需要它：安装包和模型动辄几百 MB 到几个 GB，内地直连 GitHub / HF 经常传到一半断流。
 * 原来的逻辑是「换源 = 删掉已下载文件、从 0 重来」，于是每换一次源进度就归零，
 * 反复几轮永远下不完——用户看到的就是「一直在自动换源、每次从头下载」。
 *
 * 这里的做法：
 *  1. 已下载的字节一律保留，换源时用 `Range` 从断点继续；
 *  2. 服务器若忽略 Range 返回 200，先写临时文件、校验通过后再覆盖，绝不让一次坏响应毁掉已有进度；
 *  3. 用 `content-range` 总长 + 同目录元数据文件判断「远端文件是否换了版本」（latest 直链会变），
 *     只有确实换了才从 0 重来，避免拼出个坏包；
 *  4. 连续多次没有任何进展才放弃，不会无限换源，也不会空转。
 */

export interface DownloadSource {
  label: string
  url: string
  /**
   * 同一份文件的多个镜像填相同值，才允许它们「同时」分段下载同一个文件。
   * 不同内容的源（例如魔搭上与 HF 同名但字节不同的 GGUF）必须用不同 family，
   * 否则并发拼接会得到一个坏文件。留空时按 host 分组，等于只对该源开多连接。
   */
  family?: string
}

export interface ResumeTick {
  /** 已落盘字节（含续传前已下载的部分） */
  received: number
  /** 文件总长；未知时为 0 */
  total: number
  speed: number
  source: string
  /** 这次是从断点接着下的 */
  resumed: boolean
}

export interface ResumeOptions {
  signal?: AbortSignal
  onTick?: (t: ResumeTick) => void
  /** 等响应头的上限 */
  headerMs?: number
  /** 传输中无新字节的上限 */
  idleMs?: number
  /** 单个文件的总时长上限 */
  totalMs?: number
  /** 期望的最终字节数（0 = 未知）；给了就在结束时校验 */
  expectedBytes?: number
  /** 允许的相对误差，默认 0（按整包校验时用 0.02 放过 CDN 头误差） */
  tolerance?: number
  /** 小于这个体积视为被拦截 */
  minBytes?: number
  /** 每个源最多尝试几次（有进展会额外续命） */
  triesPerSource?: number
  /**
   * 单个源最少待多久才允许换线（默认 15 秒）。
   *
   * 不设这个下限时，某个镜像瞬间返回 429 / 403，循环会在几秒内把
   * 直连 + 三个镜像全部试一遍并宣布失败 —— 用户看到的就是「一直在换线、
   * 一直下不完」。给每个源一个 15 秒窗口，短暂的抖动就有机会自己缓过来。
   */
  switchMs?: number
  /** 分段并发下载的连接数；0 或 1 表示禁用并发、只走串行换源 */
  segments?: number
  /** 小于这个体积不下并发（默认 16MB），避免多连接握手比下载本身还贵 */
  minParallelBytes?: number
  /** 显式指定分片大小（字节）；不传则按文件体积自动选 4~64MB */
  chunkBytes?: number
}

export interface ResumeResult {
  /** 最终成功的源名 */
  label: string
  bytes: number
  /** 开始下载时已有的字节数（>0 说明是续传） */
  resumedFrom: number
  /** 本地已是完整文件，没重新下载 */
  reused: boolean
}

interface Meta {
  total: number
  etag: string
  /** 并发分片的进度。没有这个字段说明是旧版「从头连续写」的 .part */
  parts?: Array<{ start: number; end: number; pos: number }>
  /** parts 覆盖的起始偏移（兼容旧 .part：前 base 字节已连续下载完） */
  base?: number
}

/** 断点信息：记录上次拿到的远端总长，用来识别「latest 直链换了版本」 */
const metaPath = (dest: string) => `${dest}.meta.json`

async function readMeta(dest: string): Promise<Meta | null> {
  try {
    const raw = await fs.readFile(metaPath(dest), 'utf8')
    const m = JSON.parse(raw) as Meta
    return m && typeof m.total === 'number' ? m : null
  } catch {
    return null
  }
}

async function writeMeta(dest: string, meta: Meta): Promise<void> {
  try {
    await fs.writeFile(metaPath(dest), JSON.stringify(meta), 'utf8')
  } catch {
    // 元数据写不进去只影响「换版本识别」，不影响下载本身
  }
}

async function dropMeta(dest: string): Promise<void> {
  await fs.unlink(metaPath(dest)).catch(() => undefined)
}

/** 本地已下载字节数；文件不存在就是 0 */
async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size
  } catch {
    return 0
  }
}

async function truncateFile(file: string): Promise<void> {
  try {
    await fs.truncate(file, 0)
  } catch {
    // 文件不存在，无需处理
  }
}

/** `bytes 123-456/789` → { start: 123, total: 789 } */
function parseContentRange(value: string | null): { start: number; total: number } | null {
  const m = value?.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i)
  if (!m) return null
  return { start: Number(m[1]), total: m[3] === '*' ? 0 : Number(m[3]) }
}

/** 416 时服务器会说 `bytes *\/789`，据此确认是不是「已经下完了」 */
function parseUnsatisfiedRange(value: string | null): number {
  const m = value?.match(/bytes\s+\*\/(\d+)/i)
  return m ? Number(m[1]) : 0
}

/** 平滑速度计（自带一份，避免和 dl.ts 循环依赖） */
function makeMeter(): (received: number) => number {
  let lastT = Date.now()
  let lastBytes = -1
  let ema = 0
  return (received) => {
    const now = Date.now()
    if (lastBytes < 0) {
      lastBytes = received
      lastT = now
      return 0
    }
    const dt = now - lastT
    if (dt >= 250) {
      const inst = ((received - lastBytes) * 1000) / dt
      ema = ema > 0 ? ema * 0.6 + inst * 0.4 : inst
      lastT = now
      lastBytes = received
    }
    return Math.max(0, ema)
  }
}

/** 判断两个总长是否算「同一个文件」 */
function sameRemote(metaTotal: number, remoteTotal: number): boolean {
  if (!metaTotal || !remoteTotal) return true
  return Math.abs(metaTotal - remoteTotal) <= Math.max(1024, remoteTotal * 0.001)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 可被取消打断的等待：取消下载时不该还傻等 15 秒 */
async function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  let left = ms
  while (left > 0) {
    if (signal?.aborted) throw new Error('已取消下载')
    const step = Math.min(250, left)
    await sleep(step)
    left -= step
  }
  if (signal?.aborted) throw new Error('已取消下载')
}

/**
 * 串行实现：一条连接从断点往后写，断了就换源续传。
 * 它同时是并发路径的兜底 —— 源不支持 Range / 内容不一致 / 并发连续失败时退回这里。
 * 失败时**保留**已下载部分（连元数据一起），下次调用会从断点继续。
 */
async function downloadSerial(
  sources: DownloadSource[],
  dest: string,
  opts: ResumeOptions = {}
): Promise<ResumeResult> {
  if (!sources.length) throw new Error('没有可用的下载源')

  const signal = opts.signal
  const onTick = opts.onTick
  const headerMs = opts.headerMs ?? 25000
  const idleMs = opts.idleMs ?? 45000
  const totalMs = opts.totalMs ?? 6 * 60 * 60 * 1000
  const minBytes = opts.minBytes ?? 0
  const expected = opts.expectedBytes ?? 0
  const tolerance = opts.tolerance ?? 0
  const triesPerSource = Math.max(1, opts.triesPerSource ?? 2)
  /** 换线间隔下限：15 秒。见 ResumeOptions.switchMs 的说明 */
  const switchMs = Math.max(0, opts.switchMs ?? 15_000)
  const deadline = Date.now() + totalMs

  await fs.mkdir(path.dirname(dest), { recursive: true }).catch(() => undefined)

  let size = await fileSize(dest)
  let meta = await readMeta(dest)

  // 本地已经是完整文件：一次请求都不用发（重装 / 重试时最常走这条路）
  if (expected > 0 && size === expected) {
    return { label: '本地已有完整文件', bytes: size, resumedFrom: size, reused: true }
  }
  if (expected > 0 && size > expected) {
    // 比目标还大，肯定是别的版本/坏文件
    await truncateFile(dest)
    await dropMeta(dest)
    size = 0
    meta = null
  }
  if (size === 0) {
    await dropMeta(dest)
    meta = null
  }

  /**
   * 进度回调必须「只读」：界面报进度时抛的错绝不能穿透到下载循环里。
   * （渲染层换了面板、窗口被刷新、监听器已销毁，都可能让回调抛异常；
   *  一旦抛到 attempt 里就会被当成「这个源坏了」→ 换源 → 甚至直接判失败。
   *  下载是主进程的事，界面出什么状况都不该影响它。）
   */
  const tick = (t: ResumeTick): void => {
    if (!onTick) return
    try {
      onTick(t)
    } catch {
      // 忽略：进度只是展示，不影响字节流
    }
  }

  const resumedFrom = size
  const meter = makeMeter()
  const errors: string[] = []
  let attempts = 0
  let wasted = 0
  let total = expected
  let cursor = 0

  /** 连续「零进展」的尝试次数上限：达到就收手，别无限换源 */
  const wastedLimit = sources.length * triesPerSource
  /** 硬上限，防止「每次都只进一点点」把循环拖死 */
  const attemptLimit = 60

  tick({
    received: size,
    total: total || 0,
    speed: 0,
    source: size > 0 ? '从断点继续…' : '准备下载…',
    resumed: size > 0
  })

  const attempt = async (src: DownloadSource): Promise<number> => {
    const offset = await fileSize(dest)
    const headers: Record<string, string> = { 'user-agent': 'roroto-code' }
    if (offset > 0) headers.range = `bytes=${offset}-`

    const ctl = new AbortController()
    const onAbort = (): void => ctl.abort()
    if (signal) {
      if (signal.aborted) ctl.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => ctl.abort(), headerMs)
    const bump = (ms: number): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => ctl.abort(), ms)
    }

    let fh: FileHandle | null = null
    // 服务器忽略 Range（返回 200）时先写 .restart，成功了再覆盖，避免把已有进度冲掉
    const target = dest
    let scratch = ''
    let pos = offset
    try {
      const res = await fetch(src.url, { redirect: 'follow', signal: ctl.signal, headers })

      if (res.status === 416) {
        const t = parseUnsatisfiedRange(res.headers.get('content-range'))
        await res.body?.cancel().catch(() => undefined)
        if (t > 0 && offset >= t) {
          total = t
          pos = t
          return t // 已经下完
        }
        // 断点位置服务器不认（文件被换过），从 0 重新开始
        await truncateFile(dest)
        await dropMeta(dest)
        throw new Error('断点位置已失效，重新开始')
      }

      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => undefined)
        throw new Error(`HTTP ${res.status}`)
      }

      const range = parseContentRange(res.headers.get('content-range'))
      const len = Number(res.headers.get('content-length') ?? 0) || 0
      const etag = res.headers.get('etag') ?? ''

      let restart = false
      if (res.status === 206 && range) {
        if (offset > 0 && range.start !== offset) {
          // 服务器给的起点和本地对不上，这份响应不能用
          await res.body.cancel().catch(() => undefined)
          await truncateFile(dest)
          await dropMeta(dest)
          throw new Error(`断点不匹配（服务器从 ${range.start} 开始），重新开始`)
        }
        if (range.total > 0) {
          // latest 直链 / 镜像上的包换了版本：旧的半截文件不能接着用
          const known = meta?.total || expected
          if (offset > 0 && known > 0 && !sameRemote(known, range.total)) {
            await res.body.cancel().catch(() => undefined)
            await truncateFile(dest)
            await dropMeta(dest)
            throw new Error('下载源上的文件已更新，从头开始')
          }
          total = range.total
        }
      } else if (res.status === 200) {
        // 服务器不支持 / 忽略了 Range，返回的是整个文件
        if (offset > 0) {
          // 先确认这不是一个「被拦截的错误页」，否则会把半天的进度冲掉
          const plausible = len === 0 || len >= Math.max(offset, minBytes || 1)
          if (!plausible) {
            await res.body.cancel().catch(() => undefined)
            throw new Error(`返回内容异常（${len} 字节），可能被拦截`)
          }
          restart = true
          scratch = `${dest}.restart`
          pos = 0
        }
        if (len > 0) total = len
        total = total || expected
        await dropMeta(dest)
      }

      if (total > 0) {
        await writeMeta(dest, { total, etag })
        meta = { total, etag }
      }

      const writePath = restart ? scratch : target
      fh = await fs.open(writePath, pos > 0 ? 'r+' : 'w')
      bump(idleMs)
      if (total > 0 || pos > 0) {
        tick({ received: pos, total, speed: 0, source: src.label, resumed: pos > 0 })
      }

      const reader = res.body.getReader()
      let lastEmit = 0
      for (;;) {
        if (signal?.aborted) throw new Error('已取消下载')
        if (Date.now() > deadline) throw new Error('下载超时')
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue

        const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        let written = 0
        // write 可能只写进去一部分，必须写满
        while (written < buf.length) {
          const { bytesWritten } = await fh.write(buf, written, buf.length - written, pos + written)
          if (bytesWritten <= 0) throw new Error('写入磁盘失败')
          written += bytesWritten
        }
        pos += buf.length
        bump(idleMs)

        const now = Date.now()
        if (now - lastEmit > 250) {
          lastEmit = now
          tick({ received: pos, total: total || expected, speed: meter(pos), source: src.label, resumed: restart === false && offset > 0 })
        }
      }

      if (total > 0 && pos !== total) {
        throw new Error(`只收到 ${pos}/${total} 字节，连接中断`)
      }
      if (minBytes > 0 && pos < minBytes) {
        throw new Error('下载内容过小，可能被拦截')
      }

      if (restart) {
        // 整份新文件下完了，覆盖旧的半截文件
        await fh.close()
        fh = null
        await fs.rename(scratch, dest).catch(async (err) => {
          await fs.unlink(scratch).catch(() => undefined)
          throw err
        })
      }

      const want = expected || total
      if (want > 0 && Math.abs(pos - want) > Math.max(0, tolerance * want)) {
        throw new Error(`文件大小异常：${pos} / 期望 ${want}`)
      }

      tick({ received: pos, total: pos, speed: meter(pos), source: src.label, resumed: false })
      return pos
    } catch (err) {
      if (scratch) await fs.unlink(scratch).catch(() => undefined)
      throw err
    } finally {
      if (fh) await fh.close().catch(() => undefined)
      if (timer) clearTimeout(timer)
      timer = null
      signal?.removeEventListener('abort', onAbort)
    }
  }

  while (attempts < attemptLimit) {
    if (signal?.aborted) throw new Error('已取消下载')
    if (Date.now() > deadline) throw new Error('下载超时')
    if (wasted >= wastedLimit) break

    const src = sources[cursor % sources.length]
    cursor++
    attempts++
    const before = await fileSize(dest)
    const startedAt = Date.now()

    try {
      const bytes = await attempt(src)
      await dropMeta(dest)
      return { label: src.label, bytes, resumedFrom, reused: false }
    } catch (err) {
      if (signal?.aborted) throw new Error('已取消下载')
      const msg = (err as Error).message
      errors.push(`${src.label}：${msg}`)
      const after = await fileSize(dest)
      const grown = after - before
      size = after
      // 这个源一点都没下进来：记一次「白跑」，攒够了就停
      if (grown < 1024 * 1024) wasted++
      else wasted = 0

      // 还会继续换线才值得等；已经要收手了就别再耗 15 秒
      const more = attempts < attemptLimit && wasted < wastedLimit
      const left = switchMs - (Date.now() - startedAt)
      const waiting = more && left > 0
      tick({
        received: after,
        total: total || expected,
        speed: 0,
        source: waiting
          ? `${src.label} 中断，${Math.ceil(left / 1000)} 秒后换源…`
          : `${src.label} 中断，换源续传…`,
        resumed: true
      })
      if (waiting) await sleepAbortable(left, signal)
      else await sleep(grown > 0 ? 200 : 800)
    }
  }

  // 失败才走到这里：保留已下载部分和元数据，下次点安装直接从断点继续
  const kept = await fileSize(dest)
  const keptHint = kept > 0 ? `已保留已下载的 ${(kept / 1024 / 1024).toFixed(0)} MB，重新点安装会从断点继续。` : ''
  throw new Error(`下载失败（已尝试 ${attempts} 次）：${errors.slice(-4).join('；')}${keptHint ? `\n${keptHint}` : ''}`)
}

/* ──────────────────────────────────────────────────────────────────────────
 * 分段并发下载
 *
 * 不能让「任意多个源」一起下同一个文件：实测魔搭上与 HF 同名的 Q4_K_M.gguf
 * 是 1,117,320,768 字节，HF 上是 986,048,800 字节 —— 拼起来必然是坏文件。
 * 所以只有 family 相同（调用方保证同一份文件）且远端总长一致的源才进并发池，
 * 其余源留在串行换源列表里当兜底。
 *
 * 用「分片队列」而不是固定 N 段：谁下完谁取下一片，快源自然多领，慢源不拖尾。
 * 每片独立记进 .meta.json，断电 / 取消后重新点下载能按片续传；旧版连续写入的
 * .part 也兼容（前 size 字节视为已完成，只对剩余部分分片）。
 * ────────────────────────────────────────────────────────────────────────── */

const DEFAULT_SEGMENTS = 8
const MIN_PARALLEL_BYTES = 16 * 1024 * 1024
const MIN_CHUNK_BYTES = 4 * 1024 * 1024
const MAX_CHUNK_BYTES = 64 * 1024 * 1024
const PROBE_BYTES = 64 * 1024
const PARALLEL_FAIL_LIMIT = 12

interface Chunk {
  start: number
  end: number
  /** 下一个要写的字节；> end 表示这一片已完成 */
  pos: number
}

interface ProbedSource extends DownloadSource {
  total: number
  fingerprint: string
  speed: number
}

/** ROROTO_DL_SEGMENTS=0 可一键退回纯串行，方便排障 */
function resolveSegments(opts: ResumeOptions): number {
  const raw = (process.env.ROROTO_DL_SEGMENTS ?? '').trim()
  if (raw) {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) return Math.floor(n)
  }
  return Math.max(1, opts.segments ?? DEFAULT_SEGMENTS)
}

function sourceFamily(s: DownloadSource): string {
  if (s.family) return s.family
  try {
    return new URL(s.url).host
  } catch {
    return s.url
  }
}

function sameTotal(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1024, b * 0.001)
}

/** 片数约为连接数的 4 倍，快源才有机会多领几片 */
function buildChunks(base: number, total: number, segments: number, chunkBytes = 0): Chunk[] {
  const span = total - base
  if (span <= 0) return []
  const raw = Math.ceil(span / (segments * 4)) / (1024 * 1024)
  const auto = Math.min(MAX_CHUNK_BYTES, Math.max(MIN_CHUNK_BYTES, Math.ceil(raw) * 1024 * 1024))
  const size = chunkBytes > 0 ? Math.max(1024, Math.min(MAX_CHUNK_BYTES, chunkBytes)) : auto
  const out: Chunk[] = []
  for (let start = base; start < total; start += size) {
    out.push({ start, end: Math.min(total - 1, start + size - 1), pos: start })
  }
  return out
}

/** 只保留「从头连续已完成」的长度；交给串行续传前必须截断到这里，否则会跳过空洞 */
function contiguousEnd(chunks: Chunk[], base: number): number {
  let end = base
  for (const c of chunks) {
    if (c.pos <= c.end) break
    end = Math.max(end, c.end + 1)
  }
  return end
}

/** 探一个源：Range 取 64KB，同时拿到远端总长、内容指纹和实测吞吐 */
async function probeSource(src: DownloadSource, timeoutMs: number): Promise<ProbedSource | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  const started = Date.now()
  try {
    const res = await fetch(src.url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'user-agent': 'roroto-code', range: `bytes=0-${PROBE_BYTES - 1}` }
    })
    const cr = parseContentRange(res.headers.get('content-range'))
    if (!res.ok || res.status !== 206 || !res.body || !cr || cr.total <= 0) {
      await res.body?.cancel().catch(() => undefined)
      return null
    }
    let got = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) got += value.byteLength
      if (got >= PROBE_BYTES) break
    }
    await reader.cancel().catch(() => undefined)
    const fp =
      res.headers.get('x-linked-etag') ??
      res.headers.get('etag') ??
      res.headers.get('x-xet-hash') ??
      res.headers.get('last-modified') ??
      ''
    return {
      ...src,
      total: cr.total,
      fingerprint: fp.replace(/^W\//, ''),
      speed: (got * 1000) / Math.max(1, Date.now() - started)
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 下载一个分片，用 pwrite 写到 .part 的对应偏移；进度实时写回 chunk.pos */
async function fetchChunk(
  src: ProbedSource,
  chunk: Chunk,
  total: number,
  dest: string,
  headerMs: number,
  idleMs: number,
  outer: AbortSignal,
  onBytes: () => void
): Promise<void> {
  if (outer.aborted) throw new Error('并发已中止')
  const ctl = new AbortController()
  const onAbort = (): void => ctl.abort()
  outer.addEventListener('abort', onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => ctl.abort(), headerMs)
  const bump = (ms: number): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => ctl.abort(), ms)
  }
  let fh: FileHandle | null = null
  try {
    const start = chunk.pos
    const res = await fetch(src.url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'user-agent': 'roroto-code', range: `bytes=${start}-${chunk.end}` }
    })
    const cr = parseContentRange(res.headers.get('content-range'))
    if (!res.ok || res.status !== 206 || !res.body || !cr || cr.start !== start || !sameTotal(cr.total, total)) {
      await res.body?.cancel().catch(() => undefined)
      throw new Error(`分片响应异常（HTTP ${res.status}）`)
    }
    fh = await fs.open(dest, 'r+')
    bump(idleMs)
    const reader = res.body.getReader()
    let pos = start
    for (;;) {
      if (outer.aborted) throw new Error('并发已中止')
      const { done, value } = await reader.read()
      if (done) break
      if (!value || pos + value.byteLength > chunk.end + 1) throw new Error('分片返回数据越界')
      const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      let written = 0
      while (written < buf.length) {
        const { bytesWritten } = await fh.write(buf, written, buf.length - written, pos + written)
        if (bytesWritten <= 0) throw new Error('写入磁盘失败')
        written += bytesWritten
      }
      pos += buf.length
      chunk.pos = pos
      bump(idleMs)
      onBytes()
    }
    if (pos !== chunk.end + 1) throw new Error(`分片只收到 ${pos - start}/${chunk.end - start + 1} 字节`)
    chunk.pos = chunk.end + 1
  } finally {
    if (fh) await fh.close().catch(() => undefined)
    if (timer) clearTimeout(timer)
    outer.removeEventListener('abort', onAbort)
  }
}

/**
 * 并发路径。返回 null 表示「不适用 / 没下完，请回退串行」。
 * 任何非正常退出都会把 .part 截断到连续前缀并清掉分片元数据，
 * 保证串行接手时 Range 起点不会跳过任何空洞。
 */
async function downloadParallel(
  sources: DownloadSource[],
  dest: string,
  opts: ResumeOptions,
  total: number,
  /** 回填：按实测吞吐排好序的源，并发走不下去时让串行也按这个顺序试 */
  ranked: DownloadSource[]
): Promise<ResumeResult | null> {
  const segments = resolveSegments(opts)
  const signal = opts.signal
  const headerMs = opts.headerMs ?? 25000
  const idleMs = opts.idleMs ?? 45000
  const deadline = Date.now() + (opts.totalMs ?? 6 * 60 * 60 * 1000)
  const expected = opts.expectedBytes ?? 0
  const tolerance = opts.tolerance ?? 0
  const minBytes = opts.minBytes ?? 0
  const resumedFrom = await fileSize(dest)

  const tickSafe = (t: ResumeTick): void => {
    try {
      opts.onTick?.(t)
    } catch {
      // 进度只是展示，界面抛错不能影响字节流
    }
  }

  tickSafe({ received: resumedFrom, total, speed: 0, source: '正在并发探测下载源…', resumed: resumedFrom > 0 })
  const probeMs = Math.min(headerMs, 12000)
  const probed = (await Promise.all(sources.map((s) => probeSource(s, probeMs)))).filter(
    (x): x is ProbedSource => x !== null
  )
  if (!probed.length) return null
  const usable = probed.filter((s) => sameTotal(s.total, total))
  if (!usable.length) return null

  // 同 family + 同总长才允许混下；选吞吐总和最高的一组
  const groups = new Map<string, ProbedSource[]>()
  for (const s of usable) {
    const key = sourceFamily(s)
    const arr = groups.get(key) ?? []
    arr.push(s)
    groups.set(key, arr)
  }
  const throughput = (arr: ProbedSource[]): number => arr.reduce((n, s) => n + s.speed, 0)
  const pool = [...groups.values()].sort((a, b) => throughput(b) - throughput(a))[0].sort((a, b) => b.speed - a.speed)
  // 把探测结果回填给调用方：并发失败要退回串行时，照样从最快的源开始试
  ranked.push(...pool, ...usable.filter((s) => !pool.some((p) => p.url === s.url)))
  // 按实测吞吐加权：快源被分到更多分片，慢源不会拖住整个队列的尾巴。
  // 交错填充（A,B,A,B,A,A…）而不是把快源全排在前面，保证每个可用源一开始就参与并发。
  const slowest = Math.max(1, pool[pool.length - 1].speed)
  const weights = pool.map((s) => Math.min(8, Math.max(1, Math.round(s.speed / slowest))))
  const weightedPool: ProbedSource[] = []
  for (let i = 0; i < Math.max(...weights); i++) {
    for (let j = 0; j < pool.length; j++) if (i < weights[j]) weightedPool.push(pool[j])
  }

  const meta = await readMeta(dest)
  const size = await fileSize(dest)
  if (size > total) return null // 交给串行去截断重来

  let base = 0
  let chunks: Chunk[]
  if (meta?.parts?.length && meta.total === total) {
    base = meta.base ?? 0
    chunks = meta.parts.map((c) => ({
      start: c.start,
      end: c.end,
      pos: Math.max(c.start, Math.min(c.end + 1, c.pos))
    }))
  } else if (size > 0) {
    // 旧版串行留下的连续 .part：前 size 字节有效，只对剩余部分分片
    base = size
    chunks = buildChunks(base, total, segments, opts.chunkBytes)
  } else {
    chunks = buildChunks(0, total, segments, opts.chunkBytes)
  }

  const receivedNow = (): number => base + chunks.reduce((n, c) => n + Math.max(0, c.pos - c.start), 0)
  const meter = makeMeter()
  const usedLabels = new Set<string>()
  let lastEmit = 0
  let saving: Promise<void> = Promise.resolve()
  const saveMeta = (): void => {
    const snapshot: Meta = {
      total,
      etag: pool[0].fingerprint,
      base,
      parts: chunks.map((c) => ({ start: c.start, end: c.end, pos: c.pos }))
    }
    saving = saving.then(() => writeMeta(dest, snapshot)).catch(() => undefined)
  }
  const emit = (label: string, force = false): void => {
    const now = Date.now()
    if (!force && now - lastEmit < 250) return
    lastEmit = now
    const received = receivedNow()
    const active = [...new Set([label, ...usedLabels])].slice(0, 3).join(' + ')
    tickSafe({ received, total, speed: meter(received), source: `${segments} 并发 · ${active}`, resumed: resumedFrom > 0 })
  }

  const inner = new AbortController()
  const onAbort = (): void => inner.abort()
  if (signal) {
    if (signal.aborted) throw new Error('已取消下载')
    signal.addEventListener('abort', onAbort, { once: true })
  }

  let completed = false
  try {
    await fs.open(dest, 'a').then((f) => f.close())
    const queue = chunks.filter((c) => c.pos <= c.end)
    let cursor = 0
    let failures = 0

    const worker = async (): Promise<void> => {
      for (;;) {
        if (signal?.aborted) throw new Error('已取消下载')
        if (Date.now() > deadline) throw new Error('下载超时')
        if (inner.signal.aborted || failures >= PARALLEL_FAIL_LIMIT) return
        const chunk = queue[cursor++]
        if (!chunk) return
        let ok = false
        for (let i = 0; i < Math.min(3, pool.length + 1) && !ok; i++) {
          if (inner.signal.aborted) return
          const src = weightedPool[(cursor + i) % weightedPool.length]
          try {
            await fetchChunk(src, chunk, total, dest, headerMs, idleMs, inner.signal, () => emit(src.label))
            ok = true
            usedLabels.add(src.label)
            saveMeta()
          } catch (err) {
            if (signal?.aborted) throw new Error('已取消下载')
            failures++
            if (err instanceof Error && /下载超时/.test(err.message)) throw err
          }
        }
        if (!ok) inner.abort()
      }
    }

    await Promise.all(Array.from({ length: Math.min(segments, Math.max(1, queue.length)) }, () => worker()))
    await saving
    if (signal?.aborted) throw new Error('已取消下载')

    if (!chunks.every((c) => c.pos > c.end)) return null

    const bytes = await fileSize(dest)
    if (bytes !== total) return null
    if (minBytes > 0 && bytes < minBytes) return null
    const want = expected || total
    if (want > 0 && Math.abs(bytes - want) > Math.max(0, tolerance * want)) return null

    emit([...usedLabels].join(' + '), true)
    await dropMeta(dest)
    completed = true
    return {
      label: `${[...usedLabels].join(' + ')}（${segments} 并发）`,
      bytes,
      resumedFrom,
      reused: false
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (!completed) {
      if (signal?.aborted) {
        // 用户取消：文件与分片进度原样保留，重新点下载时按片续传，不丢已下字节
        await saving
        saveMeta()
        await saving
      } else {
        // 要回退串行：截断到连续前缀，否则串行会把 fileSize 当断点、跳过中间没下完的空洞
        await fs.truncate(dest, contiguousEnd(chunks, base)).catch(() => undefined)
        await dropMeta(dest)
      }
    }
  }
}

/**
 * 下载入口：优先分段并发，源不支持 Range / 内容不一致 / 并发失败时自动回退串行换源。
 * 串行模式下仍保留跨源断点续传的全部语义。
 */
export async function downloadResumable(
  sources: DownloadSource[],
  dest: string,
  opts: ResumeOptions = {}
): Promise<ResumeResult> {
  if (!sources.length) throw new Error('没有可用的下载源')
  await fs.mkdir(path.dirname(dest), { recursive: true }).catch(() => undefined)

  const segments = resolveSegments(opts)
  const minParallel = opts.minParallelBytes ?? MIN_PARALLEL_BYTES
  let total = opts.expectedBytes ?? 0
  if (total === 0 && segments > 1) {
    const probe = await probeSource(sources[0], Math.min(opts.headerMs ?? 25000, 12000))
    total = probe?.total ?? 0
  }

  let ordered = sources
  if (segments > 1 && total >= minParallel && (await fileSize(dest)) <= total) {
    const ranked: DownloadSource[] = []
    try {
      const r = await downloadParallel(sources, dest, opts, total, ranked)
      if (r) return r
    } catch (err) {
      if (opts.signal?.aborted) throw new Error('已取消下载')
      // 并发走不下去（超时 / 磁盘异常）就交给串行，别直接判失败
      void err
    }
    if (ranked.length) {
      const seen = new Set(ranked.map((s) => s.url))
      ordered = [...ranked, ...sources.filter((s) => !seen.has(s.url))]
    }
  }
  return downloadSerial(ordered, dest, opts)
}

