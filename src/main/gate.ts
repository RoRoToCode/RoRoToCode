import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 本机模型请求闸门。
 *
 * 为什么需要：agent 会并行发请求（子代理、工具并行）。而本机 llama-server 的槽位
 * 是有限的，超出的请求会**静默排队**——界面上就是「生成中」一动不动，直到
 * OpenAI 客户端 10 分钟总超时才报一个和真实原因无关的网络错误。
 *
 * 这里做的不是「限流」，是把队列变成可见、可预期的东西：
 * - 有槽位就直接跑，没有就排队，排队位置和总数都能查
 * - 排队超过上限立刻拒绝（不再无限堆积）
 * - 排队超时明确告诉调用方「等太久了」
 * - 状态通过 statusLlama() / 控制面 /status 暴露给界面与外部 agent
 *
 * 槽位数不拍脑袋：llama.cpp 自己的 /props 会回报 total_slots，这个构建还会
 * 按可用显存自动适配（common_fit_params）。探不到就不闸——宁可保持原行为，
 * 也不要因为猜错把本来能并行的请求串起来。
 */

export interface QueueInfo {
  /** 正在跑的数量 */
  active: number
  /** 等待中的数量 */
  queued: number
  /** 并发上限（= 服务端槽位数） */
  limit: number
}

/** 排队相关的失败。刻意不使用 HTTP 429 的措辞：agent 的自动切供应商逻辑会把
 *  429 当成「这家额度不够」直接换到付费远端，而这里只是本机忙，换家是错的。 */
export class BusyError extends Error {
  readonly code: 'QUEUE_FULL' | 'QUEUE_TIMEOUT'
  readonly retryAfterMs: number
  readonly queue: QueueInfo

  constructor(code: 'QUEUE_FULL' | 'QUEUE_TIMEOUT', message: string, retryAfterMs: number, queue: QueueInfo) {
    super(message)
    this.name = 'BusyError'
    this.code = code
    this.retryAfterMs = retryAfterMs
    this.queue = queue
  }
}

/** 排队上限：再多就不是「等一下」而是「这台机器接不住」了，早点拒绝好过一起变慢 */
const MAX_QUEUE = 24
/**
 * 单次最长等待。
 *
 * 不能设太短：单槽模型上三个子代理并行时，第二个往往要等前一个跑完，那是几分钟
 * 而不是几秒钟 —— 设 2 分钟会把本来能成功的长任务判死。
 * 也不该无限等：这里跟请求总超时同量级（15 分钟），超过就说明真的排不上，
 * 该让调用方拿到明确错误去做别的事。期间用户随时可以中止，中止会立刻退出队列。
 */
const MAX_WAIT_MS = 15 * 60_000
/** /props 槽位信息的缓存时长：服务重启换槽位数时最多滞后这么久 */
const SLOT_TTL_MS = 30_000

/** 同一个异步调用链里已经有槽位了就不再重复申请，否则限流 1 时会自我死锁 */
const holding = new AsyncLocalStorage<boolean>()

interface Waiter {
  signal: AbortSignal
  timer: NodeJS.Timeout | null
  onAbort: () => void
  resolve: (release: () => void) => void
  reject: (err: unknown) => void
}

class Gate {
  limit: number
  private active = 0
  private waiters: Waiter[] = []

  constructor(limit: number) {
    this.limit = Math.max(1, Math.round(limit))
  }

  state(): QueueInfo {
    return { active: this.active, queued: this.waiters.length, limit: this.limit }
  }

  /** 拿一个槽位。返回的释放函数是幂等的，调用两次不会多放一个槽。 */
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error('已取消'))
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve(this.makeRelease())
    }
    if (this.waiters.length >= MAX_QUEUE) {
      return Promise.reject(
        new BusyError(
          'QUEUE_FULL',
          `本机模型忙不过来：${this.active} 个请求在进行，${this.waiters.length} 个在排队（上限 ${MAX_QUEUE}）。` +
            '等前面的任务结束后重试，或在「本地模型」里换一个更小的模型。',
          5_000,
          this.state()
        )
      )
    }

    const position = this.waiters.length + 1
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        timer: null,
        onAbort: () => {
          this.drop(waiter)
          reject(new Error('已取消'))
        },
        resolve,
        reject
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      waiter.timer = setTimeout(() => {
        this.drop(waiter)
        reject(
          new BusyError(
            'QUEUE_TIMEOUT',
            `本机模型排队超过 ${Math.round(MAX_WAIT_MS / 1000)} 秒还没轮到这个请求（当时排在第 ${position} 位）。` +
              '前面的任务可能卡住了：到「本地模型」看状态，必要时停掉后重试。',
            10_000,
            this.state()
          )
        )
      }, MAX_WAIT_MS)
      waiter.timer.unref?.()
      this.waiters.push(waiter)
    })
  }

  /** 调大/调小上限（服务重启后槽位数可能变） */
  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.round(limit))
    while (this.active < this.limit && this.waiters.length) {
      const next = this.waiters.shift() as Waiter
      this.cleanup(next)
      this.active++
      next.resolve(this.makeRelease())
    }
  }

  private cleanup(w: Waiter): void {
    if (w.timer) clearTimeout(w.timer)
    w.signal.removeEventListener('abort', w.onAbort)
  }

  private drop(w: Waiter): void {
    const i = this.waiters.indexOf(w)
    if (i >= 0) this.waiters.splice(i, 1)
    this.cleanup(w)
  }

  private makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      // 直接把手里的槽转交给下一位：active 不减，避免中间被人插队
      if (next) {
        this.cleanup(next)
        next.resolve(this.makeRelease())
      } else {
        this.active = Math.max(0, this.active - 1)
      }
    }
  }
}

const gates = new Map<string, Gate>()
const slots = new Map<string, { at: number; limit: number }>()

/** 把各种写法的 baseUrl 归一成「协议 + 主机 + 端口」，/v1 之类的路径差异不该分成两个闸门 */
export function gateKey(baseUrl: string): string {
  const raw = (baseUrl || '').trim()
  if (!raw) return ''
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}`
  } catch {
    return raw.replace(/\/+$/, '').replace(/\/v\d+$/i, '')
  }
}

/**
 * 问服务端「你有几个槽位」。
 * llama.cpp 的 /props 里有 total_slots；探不到就返回 0，表示「不知道，别闸」。
 */
async function probeSlots(key: string): Promise<number> {
  const hit = slots.get(key)
  if (hit && Date.now() - hit.at < SLOT_TTL_MS) return hit.limit
  let limit = 0
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 1500)
  try {
    const res = await fetch(`${key}/props`, { signal: ctl.signal })
    if (res.ok) {
      const json = (await res.json()) as {
        total_slots?: number
        default_generation_settings?: { n_parallel?: number }
      }
      const n = Math.round(Number(json.total_slots ?? json.default_generation_settings?.n_parallel ?? 0))
      // 上限 8：再多也不是本机显卡能干的事，配错了不该把队列算错
      if (Number.isFinite(n) && n >= 1) limit = Math.min(n, 8)
    }
    await res.body?.cancel().catch(() => undefined)
  } catch {
    // 不是 llama.cpp（Ollama / LM Studio / 中转站）就会 404 或超时：不闸
  } finally {
    clearTimeout(timer)
  }
  slots.set(key, { at: Date.now(), limit })
  return limit
}

/**
 * 申请一个槽位。返回释放函数；`null` 表示这个服务探不到槽位信息，不需要闸。
 *
 * 调用方必须在 finally 里释放，否则队列会永久卡住。
 */
export async function acquireSlot(baseUrl: string, signal: AbortSignal): Promise<(() => void) | null> {
  // 同一调用链里已经持有槽位：可能是压缩 / 规划这类内部再请求，不能再排一次队
  if (holding.getStore()) return null

  const key = gateKey(baseUrl)
  if (!key) return null
  const limit = await probeSlots(key)
  if (limit <= 0) return null

  let gate = gates.get(key)
  if (!gate) {
    gate = new Gate(limit)
    gates.set(key, gate)
  } else if (gate.limit !== limit) {
    gate.setLimit(limit)
  }

  const release = await gate.acquire(signal)
  return () => {
    release()
  }
}

/** 在持有槽位期间打标记，避免嵌套请求重复排队 */
export function markHolding<T>(fn: () => Promise<T>): Promise<T> {
  return holding.run(true, fn)
}

/** 给状态查询用：这个服务当前的队列情况，没在排队就返回空 */
export function queueInfoOf(baseUrl: string): QueueInfo | null {
  const gate = gates.get(gateKey(baseUrl))
  if (!gate) return null
  const st = gate.state()
  return st.active || st.queued ? st : null
}

/** 只用于测试与「停掉模型后重置」：把某个地址的队列记录清空 */
export function resetGate(baseUrl: string): void {
  gates.delete(gateKey(baseUrl))
  slots.delete(gateKey(baseUrl))
}
