import { downloadResumable } from './resume'

/**
 * GitHub 资源下载（带镜像回退 + 断点续传）。
 * llama.cpp / Ollama 这类装包都从这里下：并发测速选源 → 流式落盘 → 卡住就换下一个源。
 *
 * 注意：换源**不会**丢进度。已下载的字节会保留，下一个源用 Range 从断点接着下。
 */

export interface Mirror {
  label: string
  /** 前缀拼接完整地址；空串表示直连 */
  prefix: string
}

export const MIRRORS: Mirror[] = [
  { label: 'GitHub 直连', prefix: '' },
  { label: 'gh-proxy 镜像', prefix: 'https://gh-proxy.com/' },
  { label: 'ghproxy.net 镜像', prefix: 'https://ghproxy.net/' },
  { label: 'ghfast.top 镜像', prefix: 'https://ghfast.top/' }
]

export interface DlTick {
  received: number
  total: number
  /** 平滑后的每秒字节数 */
  speed: number
  source: string
  file?: string
  /** 这次是从断点续传的 */
  resumed?: boolean
}

export interface DownloadOptions {
  onTick?: (t: DlTick) => void
  signal?: AbortSignal
  mirrors?: Mirror[]
  /** 小于这个体积视为被拦截（默认 1MB） */
  minBytes?: number
  /** 等响应头的上限，默认 25 秒 */
  headerMs?: number
  /** 传输中无数据的上限，默认 60 秒 */
  idleMs?: number
  /** 期望总字节数（0/不传 = 未知） */
  expectedBytes?: number
}

async function head(url: string, ms: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'roroto-code' }
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 并发探一遍所有源，按「能通 + 响应快」排序。
 * 内地连 GitHub 时 HEAD 会很快失败，于是镜像自然排到前面，不用干等。
 * 这只决定「先试谁」，排在后面的源仍然是有效的续传备选。
 */
export async function rankSources(url: string, mirrors: Mirror[] = MIRRORS, probeMs = 4000): Promise<Mirror[]> {
  const results = await Promise.all(
    mirrors.map(async (m) => {
      const started = Date.now()
      const ok = await head(m.prefix ? `${m.prefix}${url}` : url, probeMs)
      return { m, ok, ms: ok ? Date.now() - started : Number.MAX_SAFE_INTEGER }
    })
  )
  results.sort((a, b) => (a.ok === b.ok ? a.ms - b.ms : a.ok ? -1 : 1))
  return results.map((r) => r.m)
}

/**
 * 下载并返回真正成功的源名。
 * 任何源中断都不会丢进度：换源后用 Range 从断点继续，只有远端文件换版本才从 0 重来。
 */
export async function downloadFromGithub(
  url: string,
  dest: string,
  opts: DownloadOptions = {}
): Promise<string> {
  const { onTick, signal, mirrors = MIRRORS, minBytes = 1024 * 1024 } = opts
  // 测速这几秒也要有反馈，否则界面看着像卡住
  onTick?.({ received: 0, total: 0, speed: 0, source: '正在并发测速，选择最快的源…' })
  const order = await rankSources(url, mirrors)

  const sources = order.map((m) => ({
    label: m.label,
    url: m.prefix ? `${m.prefix}${url}` : url
  }))

  const r = await downloadResumable(sources, dest, {
    signal,
    minBytes,
    headerMs: opts.headerMs ?? 25000,
    idleMs: opts.idleMs ?? 60000,
    expectedBytes: opts.expectedBytes ?? 0,
    onTick: (t) =>
      onTick?.({
        received: t.received,
        total: t.total,
        speed: t.speed,
        source: t.source,
        resumed: t.resumed
      })
  })
  return r.label
}
