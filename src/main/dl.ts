import { downloadResumable } from './resume'

/** 只问体积，不下内容；拿不到就返回 0 */
export async function headSize(url: string, timeoutMs = 20 * 1000): Promise<number> {
  try {
    const r = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    })
    const n = Number(r.headers.get('content-length') ?? 0) || 0
    if (n > 0) return n
  } catch {
    // HEAD 被 CDN 拒了，往下用 Range 探
  }
  try {
    // 有的 CDN 对 HEAD 不返回长度，但 GET + Range: 0-0 会带 content-range: bytes 0-0/总长
    const r = await fetch(url, {
      redirect: 'follow',
      headers: { range: 'bytes=0-0' },
      signal: AbortSignal.timeout(timeoutMs)
    })
    const range = r.headers.get('content-range') ?? ''
    const total = Number(range.split('/')[1] ?? 0) || 0
    await r.body?.cancel().catch(() => undefined)
    if (total > 0) return total
    return Number(r.headers.get('content-length') ?? 0) || 0
  } catch {
    return 0
  }
}

/**
 * 带进度的下载：跟随跳转，边下边报字节数。
 * 安装包动辄上百 MB，不能一次性塞内存，所以流式落盘。
 *
 * 卡住判定：等响应头超过 `headerMs`、或传输中超过 `idleMs` 没收到任何字节就中断，
 * 让上层（多镜像回退）能及时换下一个源，而不是干等一小时。
 * 中断不会丢进度——文件保留，重试时用 Range 从断点继续。
 */
export async function downloadToFile(
  url: string,
  target: string,
  onBytes: (received: number, total: number) => void,
  opts?: { headerMs?: number; idleMs?: number; totalMs?: number; signal?: AbortSignal; expectedBytes?: number }
): Promise<void> {
  await downloadResumable([{ label: '直连', url }], target, {
    signal: opts?.signal,
    headerMs: opts?.headerMs,
    idleMs: opts?.idleMs,
    totalMs: opts?.totalMs,
    expectedBytes: opts?.expectedBytes,
    onTick: (t) => onBytes(t.received, t.total)
  })
}

/** 把字节数说成人话 */
export function humanSize(bytes: number): string {
  if (!bytes) return '未知大小'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * 实时速度计：传入累计字节数，返回平滑后的「字节/秒」。
 * 用指数滑动平均，避免界面上的数字来回跳。
 */
export function speedMeter(): (received: number) => number {
  let lastT = Date.now()
  let lastBytes = -1
  let ema = 0
  return (received: number) => {
    const now = Date.now()
    if (lastBytes < 0) {
      lastBytes = received
      lastT = now
      return 0
    }
    const dt = now - lastT
    // 窗口开小一点，首秒内就能显示出速度
    if (dt >= 250) {
      const inst = ((received - lastBytes) * 1000) / dt
      ema = ema > 0 ? ema * 0.6 + inst * 0.4 : inst
      lastT = now
      lastBytes = received
    }
    return Math.max(0, ema)
  }
}

/** 速度格式化：3.4 MB/s */
export function humanSpeed(bytesPerSec: number): string {
  if (!bytesPerSec) return '—'
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`
}
