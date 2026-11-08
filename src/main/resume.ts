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

/**
 * 从多个源下载同一个文件到 dest，支持跨源断点续传。
 * 失败时**保留**已下载部分（连元数据一起），下次调用会从断点继续。
 */
export async function downloadResumable(
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

  onTick?.({
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
        onTick?.({ received: pos, total, speed: 0, source: src.label, resumed: pos > 0 })
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
          onTick?.({ received: pos, total: total || expected, speed: meter(pos), source: src.label, resumed: restart === false && offset > 0 })
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

      onTick?.({ received: pos, total: pos, speed: meter(pos), source: src.label, resumed: false })
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
      if (after > 0) {
        onTick?.({
          received: after,
          total: total || expected,
          speed: 0,
          source: `${src.label} 中断，换源续传…`,
          resumed: true
        })
      }
      await sleep(grown > 0 ? 200 : 800)
    }
  }

  // 失败才走到这里：保留已下载部分和元数据，下次点安装直接从断点继续
  const kept = await fileSize(dest)
  const keptHint = kept > 0 ? `已保留已下载的 ${(kept / 1024 / 1024).toFixed(0)} MB，重新点安装会从断点继续。` : ''
  throw new Error(`下载失败（已尝试 ${attempts} 次）：${errors.slice(-4).join('；')}${keptHint ? `\n${keptHint}` : ''}`)
}

