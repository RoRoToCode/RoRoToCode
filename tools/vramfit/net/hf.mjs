/**
 * 远端 GGUF 读取。只用 HTTP Range 读需要的那几段，不下载整个模型。
 *
 * 这里没有一行 node: 的代码 —— fetch / AbortSignal / TextDecoder 在 Node 18
 * 和所有现代浏览器里都是全局的。命令行的 readGguf 和网页的 fetchGguf 共用它。
 *
 * 国内镜像经常抖动（实测同一个 8 MB 区间，快时 3 秒、慢时直接超时），
 * 所以每段都做重试；否则一次网络抖动就会让整次体检失败。
 */

import { parseGguf, getMirror, OFFICIAL, isShardTail } from '../core/index.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 这些错误换源或重试都没意义，直接停 */
const isFatalFetch = (e) => /限流|不是文件直链|不支持 Range|HTTP 40[134]/.test(String(e?.message ?? e))

/** 把 undici 的错误翻译成人能看懂的话 */
function friendlyFetchError(e) {
  const m = String(e?.message ?? e)
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|Failed to fetch|Load failed/i.test(m)) return '网络连不上'
  if (/aborted|timeout/i.test(m)) return '请求超时'
  return m
}

const NO_RANGE_MSG = '这个地址不支持 Range 分段读取（服务器返回整份文件而不是片段）。' +
  '只能先下载到本地再查，否则会把整个模型都拉下来'

/**
 * 把 ReadableStream 读成 Uint8Array，超过上限就掐断。
 *
 * 浏览器里 r.body 一定是 ReadableStream，Node 18+ 也是（undici）。
 * 上限这一层是必需的：有的服务器回 206 却推整份文件，20 GB 会把标签页搞崩，
 * 而且报错会写成「magic 不匹配」，把人引到完全错误的方向上。
 */
async function readStreamCapped(body, limit) {
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      if (received > limit) {
        throw new Error('服务器返回的数据比请求的多（不支持 Range？），已中止以免下载整个模型')
      }
      chunks.push(value)
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  if (chunks.length === 1) return chunks[0]
  const out = new Uint8Array(received)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out
}

/** 超时信号：AbortSignal.timeout 在 Safari 16 以下没有，退化成不超时 */
function timeoutSignal(ms) {
  try { return AbortSignal.timeout(ms) } catch { return undefined }
}

/**
 * 系统代理提示。
 *
 * 这是个很隐蔽的坑：机器上开着 Clash / v2ray 一类代理时，curl 和浏览器都正常，
 * 唯独 Node 的 fetch **默认不读** HTTP_PROXY，于是整个工具报「网络连不上」，
 * 用户会以为是站挂了，而真正的原因是他自己的代理没被用上。
 * 只在请求已经失败时才提示，正常网络下不会出现。
 */
function proxyHint() {
  const proc = globalThis.process
  if (!proc?.env) return ''            // 浏览器：走系统代理，不需要这句
  const proxy = proc.env.HTTPS_PROXY || proc.env.https_proxy ||
    proc.env.HTTP_PROXY || proc.env.http_proxy
  if (!proxy) return ''
  if (proc.execArgv?.includes('--use-env-proxy')) return ''
  if (proc.env.NODE_USE_ENV_PROXY === '1') return ''
  return '\n  检测到系统代理，但 Node 的 fetch 默认不走代理。加上 --use-env-proxy 再试：' +
    '\n    node --use-env-proxy check.mjs <目标>'
}

export class RemoteFile {
  #url
  #alt
  #size = 0

  constructor(url) {
    this.#url = url
    // 主镜像不通时退回官方源：国内直连官方通常不通，但海外用户正好反过来
    this.#alt = /hf-mirror\.com/.test(url) ? url.replace('hf-mirror.com', 'huggingface.co') : null
  }

  static async open(url) {
    const f = new RemoteFile(url)
    const candidates = [f.#url, f.#alt].filter(Boolean)
    let lastErr = null

    for (const [ci, cand] of candidates.entries()) {
      const attempts = ci === 0 ? 2 : 1
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const r = await fetch(cand, {
            headers: { Range: 'bytes=0-0' },
            redirect: 'follow',
            signal: timeoutSignal(45000)
          })
          if (r.status === 429) throw new Error('镜像限流（HTTP 429）')
          if (!r.ok && r.status !== 206) throw new Error(`无法访问（HTTP ${r.status}）`)

          const cr = r.headers.get('content-range')
          // 只要一个字节却拿到 200 = 服务器忽略了 Range，会把整份文件推过来。
          // 20 GB 的 Q8 模型这样读两次就是 40 GB 下载，进程直接 OOM。
          if (r.status === 200 && !cr) {
            await r.body?.cancel().catch(() => {})
            throw new Error(NO_RANGE_MSG)
          }

          const total = cr ? Number(cr.split('/')[1]) : Number(r.headers.get('content-length'))
          if (!Number.isFinite(total) || total <= 0) {
            await r.body?.cancel().catch(() => {})
            throw new Error('拿不到文件大小：这个地址不是文件直链（多半是把模型主页链接贴上来了）')
          }
          f.#size = total
          f.#url = cand
          f.#alt = candidates.find((x) => x !== cand) ?? null
          // 只需要 1 个字节，剩下的立刻掐掉，别让服务器继续往这里推
          await r.body?.cancel().catch(() => {})
          return f
        } catch (e) {
          lastErr = e
          if (isFatalFetch(e)) break
          if (attempt === attempts - 1) break
          await sleep(1000)
        }
      }
    }

    if (isFatalFetch(lastErr)) throw lastErr
    const msg = friendlyFetchError(lastErr)
    throw new Error(`${msg}：主镜像与官方源都没通，检查网络或先下载到本地再查${proxyHint()}`)
  }

  get size() { return this.#size }

  async stat() { return { size: this.#size } }

  /** 与 Node 的 FileHandle.read 同签名，所以 Cursor 完全不用区分数据来自哪里 */
  async read(buffer, offset, length, position) {
    const end = Math.min(position + length, this.#size) - 1
    if (end < position) return { bytesRead: 0 }
    const candidates = [this.#url, this.#alt].filter(Boolean)
    let lastErr = null

    for (const url of candidates) {
      try {
        const r = await fetch(url, {
          headers: { Range: `bytes=${position}-${end}` },
          redirect: 'follow',
          signal: timeoutSignal(20000)
        })
        if (r.status === 429) throw new Error('镜像限流（HTTP 429）')
        if (r.status !== 206) {
          await r.body?.cancel().catch(() => {})
          if (r.status === 200) throw new Error(NO_RANGE_MSG)
          throw new Error(`读取失败（HTTP ${r.status}）`)
        }

        const buf = await readStreamCapped(r.body, length + 1)
        this.#url = url                 // 记住哪个源能用
        this.#alt = candidates.find((x) => x !== url) ?? null
        const n = Math.min(buf.length, length)
        buffer.set(buf.subarray(0, n), offset)
        return { bytesRead: n }
      } catch (e) {
        lastErr = e
        // 限流 / 不支持 Range 时换源也是干等 —— 立刻停下把原因说清楚
        if (isFatalFetch(e)) break
      }
    }

    if (/限流/.test(String(lastErr?.message))) {
      throw new Error('镜像限流（HTTP 429）：hf-mirror 按出口 IP 计配额，等 1–2 分钟再试，或先下载到本地')
    }
    if (/不支持 Range|比请求的多/.test(String(lastErr?.message))) throw lastErr
    throw new Error(`${friendlyFetchError(lastErr)}（镜像可能限流或抖动：等 1–2 分钟重试，或先下载到本地再查）`)
  }

  async close() { /* 无需清理 */ }
}

/**
 * 从远端地址读取并解析 GGUF 元数据。命令行和网页的唯一入口。
 */
export async function fetchGguf(url) {
  const fh = await RemoteFile.open(url)
  try {
    return await parseGguf(fh, fh.size, url)
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/**
 * 列出一个 HF 仓库里所有可独立运行的 .gguf。
 *
 * 网页端的「量化对比」模式直接调它 —— HF 的 API 响应带 CORS 头，浏览器能直连，
 * 不需要任何代理服务。mmproj 是多模态投影文件，单独跑不起来，排除。
 * 分片模型只有第一片带完整元数据，后面的片子单独读没有意义，也排除。
 */
export async function listRepoGgufs(repo) {
  let j = null
  let base = null
  let lastErr = null
  // 先试当前站点，失败再退回官方源。两者相同时不重复请求。
  const sources = [...new Set([getMirror(), OFFICIAL])]
  for (const src of sources) {
    try {
      const r = await fetch(`${src}/api/models/${repo}`, { signal: timeoutSignal(20000) })
      if (r.status === 429) throw new Error('镜像限流了（按出口 IP 计配额），等 1–2 分钟再试')
      if (!r.ok) throw new Error(`拿不到仓库信息（HTTP ${r.status}）`)
      j = await r.json()
      base = src
      break
    } catch (e) { lastErr = e }
  }
  if (!j) throw new Error(`${lastErr?.message ?? '拿不到仓库信息'}；镜像与官方源都没通${proxyHint()}`)

  const all = (j.siblings ?? [])
    .map((s) => s.rfilename)
    .filter((f) => typeof f === 'string')
    .filter((f) => /\.gguf$/i.test(f))
    .filter((f) => !/mmproj/i.test(f))
  const files = all.filter((f) => !isShardTail(f))
  if (!files.length) throw new Error('这个仓库里没有 .gguf 文件')
  return {
    // 用 base 而不是写死镜像：仓库信息是从哪个站点拿到的，文件就从这个站点取，
    // 否则镜像挂了、官方源成功了，后面解析仍会去撞那个挂掉的镜像。
    urls: files.map((f) => `${base}/${repo}/resolve/main/${f}`),
    sharded: files.filter((f) => /-\d{5}-of-\d{5}\.gguf$/i.test(f)).length,
    source: base
  }
}
