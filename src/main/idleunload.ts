/**
 * 空闲卸载：本地服务闲着就把显存还回去。
 *
 * 桌面程序不像服务器那样「一直在用」——用户问一句、走开两小时，llama-server
 * 仍稳稳占着 5~7 GB。开个游戏、剪个视频、跑个本地绘图，立刻就是「显存不足」。
 * 以前的答案是「去本地模型页手动停掉」，但没人记得回来再启动。
 *
 * 这里的取舍：
 * - 只卸载「真的没人用」的实例。判据是双重的 —— 本地闸门里有没有在跑的请求，
 *   以及服务端 `/slots` 有没有 `is_processing`。任一为「忙」就重置计时；
 *   探不到 `/slots`（404 / 超时）按「不确定」处理，**不卸载**。
 *   宁可多占一会儿显存，也不要卸载正在生成的那一个。
 * - 卸载后不是「关掉就没了」：`wakeLlama()` 会在下一次请求进来时用同样的参数
 *   重新拉起（见 llama.ts）。所以这里只负责「放开」，不负责「恢复」。
 * - 刚启动的一分钟内不卸载。加载完成到第一次请求之间往往就是几十秒，
 *   这时候卸掉等于让用户白等一次加载。
 *
 * 模块本身不碰 electron，也不 import llama.ts —— 全部依赖注入，
 * 这样 tests/idleunload.test.cjs 能直接跑逻辑，不用起真进程。
 */

export interface IdleTarget {
  /** 实例 key（= provider id） */
  key: string
  port: number
  /** 模型文件名，用于日志与界面说明 */
  model: string
  /** 进程拉起时刻（ms） */
  startedAt: number
  /** 是否是「部分层在 CPU」的降级实例 */
  partial: boolean
}

export interface IdleDeps {
  /** 当前所有实例 */
  list: () => IdleTarget[]
  /**
   * 服务端是否在处理请求。
   * `true` 忙 / `false` 空闲 / `null` 探不到（不是 llama.cpp、端口没人听、超时）。
   * null 不能被当成空闲，否则正在跑长任务时刚好赶上一次探测超时就会被杀。
   */
  busy: (port: number) => Promise<boolean | null>
  /** 本地闸门里的活跃请求数：比 `/slots` 早几毫秒知道有请求进来 */
  pending: (port: number) => number
  /** 真正停掉一个实例（会释放显存） */
  stop: (key: string) => Promise<boolean>
  /** 当前的空闲阈值（ms）；每次 tick 现取，改设置立刻生效。<= 0 表示关闭 */
  ttlMs: () => number | Promise<number>
  now?: () => number
}

/** 起进程后多久之内不考虑卸载：加载完到第一次请求之间本来就有空档 */
export const MIN_ALIVE_MS = 60_000

export interface IdleRecord {
  lastBusyAt: number
  /** 卸载时刻；有值表示这个实例是被空闲回收的，唤醒时要说明 */
  unloadedAt?: number
  model?: string
}

/**
 * 单个实例此刻该不该卸载。抽出来是因为它有 5 个分支，混在循环里很难读，
 * 也难测（要模拟时钟）。纯函数，无副作用。
 */
export function shouldUnload(input: {
  now: number
  startedAt: number
  lastBusyAt: number
  ttlMs: number
  busy: boolean | null
  pending: number
}): boolean {
  if (!(input.ttlMs > 0)) return false
  if (input.busy !== false) return false
  if (input.pending > 0) return false
  if (input.now - input.startedAt < MIN_ALIVE_MS) return false
  return input.now - input.lastBusyAt >= input.ttlMs
}

export function createIdleWatcher(
  deps: IdleDeps,
  opts: { intervalMs?: number } = {}
): {
  /** 跑一轮判定，返回这一轮被卸载的 key（测试直接调它） */
  tick: () => Promise<string[]>
  start: () => void
  stop: () => void
  /** 已卸载实例的说明，供界面显示「已空闲卸载」 */
  unloaded: () => Array<{ key: string; model: string; at: number; idleMin: number }>
  /** 手动清掉记录（用户重新启动后调用） */
  forget: (key?: string) => void
} {
  const now = deps.now ?? (() => Date.now())
  const intervalMs = Math.max(5_000, opts.intervalMs ?? 30_000)
  /** 每个实例最后一次「确认在忙 / 刚启动」的时刻 */
  const lastBusy = new Map<string, number>()
  const unloadedAt = new Map<string, { model: string; at: number; idleMin: number }>()
  let timer: NodeJS.Timeout | null = null
  let running = false

  async function tick(): Promise<string[]> {
    // 上一轮还没跑完（探测可能卡在超时）就跳过：两轮叠在一起会重复发 stop
    if (running) return []
    running = true
    const t = now()
    const ttl = await deps.ttlMs()
    const gone: string[] = []
    try {
      for (const inst of deps.list()) {
        const seen = lastBusy.get(inst.key)
        if (seen === undefined) {
          // 第一次见到它：以「现在」为起点，从此刻开始算空闲
          lastBusy.set(inst.key, Math.max(t, inst.startedAt))
          continue
        }
        const pending = deps.pending(inst.port)
        let busy: boolean | null = null
        if (pending > 0) busy = true
        else busy = await deps.busy(inst.port).catch(() => null)

        if (busy !== false || pending > 0) {
          lastBusy.set(inst.key, t)
          continue
        }
        const last = lastBusy.get(inst.key) ?? t
        if (!shouldUnload({ now: t, startedAt: inst.startedAt, lastBusyAt: last, ttlMs: ttl, busy, pending })) {
          continue
        }
        const ok = await deps.stop(inst.key).catch(() => false)
        if (!ok) {
          // 没停掉（权限 / 卡住）就别反复重试，留到下一轮；重置计时避免每 30 秒撞一次
          lastBusy.set(inst.key, t)
          continue
        }
        lastBusy.delete(inst.key)
        unloadedAt.set(inst.key, { model: inst.model, at: t, idleMin: Math.round(ttl / 60_000) })
        gone.push(inst.key)
      }
      // 实例已经不在的，记录也清掉，避免无限增长
      const alive = new Set(deps.list().map((i) => i.key))
      for (const key of [...lastBusy.keys()]) if (!alive.has(key)) lastBusy.delete(key)
      return gone
    } finally {
      running = false
    }
  }

  return {
    tick,
    start() {
      if (timer) return
      timer = setInterval(() => {
        void tick()
      }, intervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    unloaded() {
      return [...unloadedAt.entries()].map(([key, v]) => ({ key, ...v }))
    },
    forget(key?: string) {
      if (key) unloadedAt.delete(key)
      else unloadedAt.clear()
    }
  }
}
