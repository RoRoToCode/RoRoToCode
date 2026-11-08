import net from 'node:net'

/**
 * 真·端口探测。
 *
 * 之前的 pickPort() 只看自己维护的实例表，等于「我觉得这个端口空着」：
 * 别的软件（或用户手动起的 llama-server）占了 8081，它照样把 --port 8081
 * 传给 llama-server，进程随即因端口冲突退出，界面却一直显示「加载中」。
 *
 * 这里直接尝试在 127.0.0.1 上独占监听一次 —— 和 llama-server --host 127.0.0.1
 * 要的是同一件事，所以能 bind 就一定能用。
 */

/** 端口能否在 127.0.0.1 上独占监听（true = 空闲） */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      resolve(false)
      return
    }
    let settled = false
    const finish = (free: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(free)
    }
    const srv = net.createServer()
    // 有些环境下 listen 既不成功也不报错，别让它把启动流程吊住
    const timer = setTimeout(() => {
      try {
        srv.close()
      } catch {
        // 可能还没进入 listening
      }
      finish(false)
    }, 1200)
    srv.once('error', () => finish(false))
    srv.once('listening', () => srv.close(() => finish(true)))
    try {
      // exclusive: 不让 Node 用 SO_REUSEADDR 和占用者「共享」这个端口
      srv.listen({ host, port, exclusive: true })
    } catch {
      finish(false)
    }
  })
}

/**
 * 首选端口给几次重试。
 * taskkill /f 之后端口常常要过几十到几百毫秒才真正释放，
 * 第一次探到「被占」就换端口的话，切个模型端口就漂到 8081 去了。
 */
export async function waitPortFree(port: number, tries = 3, delayMs = 180): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await isPortFree(port)) return true
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs))
  }
  return false
}

/**
 * 从 start 起往后找第一个真正能 bind 的端口。
 * exclude 里放本程序已占用的实例端口，避免双实例撞到同一个。
 * 全被占了返回 null，让调用方给明确错误，而不是硬起一个注定失败的进程。
 */
export async function findFreePort(
  start: number,
  exclude: Set<number> = new Set(),
  maxScan = 64
): Promise<number | null> {
  const first = Math.max(1024, Math.min(65535, Math.round(start) || 1024))
  for (let i = 0; i < maxScan; i++) {
    const port = first + i
    if (port > 65535) break
    if (exclude.has(port)) continue
    if (await isPortFree(port)) return port
  }
  return null
}
