/**
 * 全局并发闸门。
 *
 * 为什么要它：会话锁只保证「同一个会话不会被打两遍」，管不住「同时开五个会话」。
 * 本地只有一份模型服务，五个请求一起挤进去，结果是五个都变慢，
 * 用户看到的是「全都卡住」，而不是「两个在跑、三个在等」。
 *
 * 规则只有两条：
 *   1. 最多 max 个会话真正在跑，其余排队；
 *   2. 排队不完全是先来后到 —— 用户手打的话排在最前，其次别的档案交过来的活，
 *      最后才是定时任务。
 *
 * 为什么第 2 条要单独写：定时任务和交接都是「后台自己冒出来的」，
 * 用户并不知道有它们，只知道「我打完字，半天没反应」。
 * 用户在键盘前的时候，他的那句话必须插到所有后台活前面；
 * 优先级相同才按先来后到，同一个优先级里不会被打乱。
 *
 * 排队中的会话仍然占着会话锁（不能往里发第二条消息），但一次模型请求都不发。
 */

/** 同时真正在跑的会话上限。本地推理服务基本是单实例串行，2 已经是给远端的余量 */
export const MAX_CONCURRENT_RUNS = 2

/**
 * 排队优先级。名字即理由：
 * - manual：用户自己发起的（提问、重跑、改问）。
 * - handoff：另一个 agent 转交的活，用户间接参与过，给它让一档。
 * - routine：定时任务，纯粹按表跑，让到最后。
 */
export type RunPriority = 'manual' | 'handoff' | 'routine'

/** 数小的先跑。写成表而不是三元表达式，加档位时不用到处改比较逻辑 */
const RANK: Record<RunPriority, number> = { manual: 0, handoff: 1, routine: 2 }

/** 把「这次运行因何而起」翻译成排队优先级。未知原因一律当用户发起（宁可占先，也别让用户白等） */
export function priorityOf(reason?: string | null): RunPriority {
  if (reason === 'handoff') return 'handoff'
  if (reason === 'routine') return 'routine'
  return 'manual'
}

export interface QueueNotice {
  sessionId: string
  /** 0 = 已拿到槽位开始跑；>0 = 排队位置，1 表示下一个就轮到它 */
  position: number
  /** 当前真正在跑的会话数 */
  active: number
  /** 上限，界面用来解释「为什么在等」 */
  limit: number
  /** 这条为什么排在这儿：界面可以据此说「定时任务在让路」 */
  priority: RunPriority
}

interface Waiter {
  sessionId: string
  priority: RunPriority
  grant: () => void
}

export class RunQueue {
  private active = 0
  private waiting: Waiter[] = []
  /** 已经拿到槽位的会话。release 只认这个集合，避免调用方多释放一次把别人的位置顶掉 */
  private holds = new Set<string>()

  constructor(
    private readonly max: number = MAX_CONCURRENT_RUNS,
    private readonly notify: (notice: QueueNotice) => void = () => undefined
  ) {}

  get limit(): number {
    return this.max
  }

  get activeCount(): number {
    return this.active
  }

  get waitingCount(): number {
    return this.waiting.length
  }

  /** 这个会话是不是已经拿到槽位了 */
  holding(sessionId: string): boolean {
    return this.holds.has(sessionId)
  }

  /** 排队位置；0 表示没在排队（在跑或根本没提交） */
  position(sessionId: string): number {
    const i = this.waiting.findIndex((w) => w.sessionId === sessionId)
    return i < 0 ? 0 : i + 1
  }

  /**
   * 申请一个槽位。有空位立刻返回，没有就按优先级插队等 release 放行。
   *
   * signal 中止时排队中的请求直接以「已取消」拒绝，并把它从队列里摘掉 ——
   * 否则用户点了停止，队列还留着一个永远不会被消费的位置，
   * 后面所有人都会看到「前面还有 1 个」却没人动。
   */
  async acquire(sessionId: string, signal?: AbortSignal, priority: RunPriority = 'manual'): Promise<void> {
    if (this.holds.has(sessionId)) return
    if (signal?.aborted) throw new Error('已取消')
    if (this.active < this.max) {
      this.active++
      this.holds.add(sessionId)
      return
    }

    let onAbort: (() => void) | null = null
    try {
      await new Promise<void>((resolve, reject) => {
        const entry: Waiter = {
          sessionId,
          priority,
          grant: () => {
            this.active++
            this.holds.add(sessionId)
            this.notify({ sessionId, position: 0, active: this.active, limit: this.max, priority })
            resolve()
          }
        }
        onAbort = () => {
          const i = this.waiting.indexOf(entry)
          if (i >= 0) {
            this.waiting.splice(i, 1)
            // 走了一个人，后面的人整体前移，界面上的数字得跟着变
            this.announce()
          }
          reject(new Error('已取消'))
        }
        // 插到第一个「比我更不急」的人前面。用 splice 而不是排序整个数组：
        // 排序会打乱同优先级里的先后，用户连发两条时执行顺序就随机了。
        const at = this.waiting.findIndex((w) => RANK[w.priority] > RANK[priority])
        this.waiting.splice(at < 0 ? this.waiting.length : at, 0, entry)
        signal?.addEventListener('abort', onAbort, { once: true })
        this.announce()
      })
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
  }

  /** 归还槽位：先放行队列里的第一个人，再通知剩下的人位置前移 */
  release(sessionId: string): void {
    if (!this.holds.delete(sessionId)) return
    this.active = Math.max(0, this.active - 1)
    const next = this.waiting.shift()
    if (next) next.grant()
    this.announce()
  }

  /** 把所有排队者的位置推一遍。拿到槽位的人由 grant 自己通知，这里跳过 */
  private announce(): void {
    this.waiting.forEach((w, i) =>
      this.notify({
        sessionId: w.sessionId,
        position: i + 1,
        active: this.active,
        limit: this.max,
        priority: w.priority
      })
    )
  }
}
