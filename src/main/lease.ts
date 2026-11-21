import path from 'node:path'

/**
 * 并行子任务的文件写租约。
 *
 * 一批 task 按 `laneCount` 并行跑，每个子 agent 都能改文件。提示里那句
 * 「不要让两个 task 改同一个文件」只是建议 —— 模型看不到别的子任务在干什么。
 * 两路真写到同一个文件时，后果不是「慢一点」：
 *
 * - 后写的那份把前一份覆盖掉，一方的改动凭空消失；
 * - `recordChange` 的「改前快照」会串味：两路几乎同时读到同一份 before，
 *   用户点撤销，撤回来的可能是另一个任务的半成品。
 *
 * 所以按**绝对路径**发租约：谁先拿到谁写，另一个排队等（不是失败）。
 * 只锁写路径、不锁整个工作区 —— 各改各的文件仍然真并行，这正是并行的意义。
 *
 * 三个刻意的边界：
 * - **纯内存、不落盘**：租约只活在一次任务运行里，进程退出就该全部失效；
 * - **等不到会说清是谁占着**，而不是让子 agent 无声挂死；
 * - **按排序后的路径顺序获取**：两路都要 [a,b] 和 [b,a] 时不会互相等成死锁。
 */

/** 路径 → 当前持有者 */
const held = new Map<string, string>()
/** 路径 → 等待队列（FIFO，先到先得） */
const waiting = new Map<string, Array<{ owner: string; grant: () => void }>>()

/**
 * 等锁上限。子 agent 的单次写入本该在几秒内完成，等两分钟还不放手只能说明
 * 对方那一路卡住了（模型在长思考、或者进程被杀没走到释放）。
 * 超时明确报错，比让整批任务静默挂死好排查得多。
 */
const DEFAULT_WAIT_MS = 120_000

/** Windows 的盘符与目录名不区分大小写，两个子 agent 可能用不同大小写指向同一个文件 */
function keyOf(p: string): string {
  const abs = path.resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/**
 * 拿一个 key。返回「这次是不是真的拿到了新锁」——
 * 同一个 owner 重复拿同一个文件时是重入（true/ false 的区别决定了释放时要
 * 不要把它算进自己名下，算错了会把外层那次的锁提前放掉）。
 */
function acquireOne(
  key: string,
  owner: string,
  signal: AbortSignal | undefined,
  waitMs: number
): Promise<boolean> {
  const cur = held.get(key)
  // 没人占：真的拿到了新锁
  if (!cur) {
    held.set(key, owner)
    return Promise.resolve(true)
  }
  // 本来就是自己：重入，不算新锁
  if (cur === owner) return Promise.resolve(false)

  return new Promise<boolean>((resolve, reject) => {
    const queue = waiting.get(key) ?? []
    waiting.set(key, queue)
    let timer: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const q = waiting.get(key)
      if (!q) return
      const i = q.indexOf(entry)
      if (i >= 0) q.splice(i, 1)
      if (!q.length) waiting.delete(key)
    }
    const fail = (err: Error): void => {
      cleanup()
      reject(err)
    }
    const onAbort = (): void => fail(new Error('已取消'))

    const entry = {
      owner,
      grant: (): void => {
        cleanup()
        held.set(key, owner)
        resolve(true)
      }
    }

    queue.push(entry)
    timer = setTimeout(() => {
      const who = held.get(key)
      fail(
        new Error(
          `另一个子任务（${who ?? '未知'}）正在修改 ${path.basename(key)}，` +
            `等了 ${Math.round(waitMs / 1000)} 秒仍未释放`
        )
      )
    }, waitMs)
    /**
     * 刻意**不** unref：这个定时器就是「还在等锁」这个状态的唯一凭据，
     * unref 掉之后如果进程里正好没有别的句柄（无头运行、测试），事件循环会
     * 直接空转退出，而等锁的 promise 永远不 settle。它一定会被
     * grant / 取消 / 超时三处之一清掉，不构成泄漏。
     */
    if (signal?.aborted) {
      fail(new Error('已取消'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 释放这些 key（只释放确实属于 owner 的那些，避免误放别人的锁） */
function release(keys: string[], owner: string): void {
  for (const key of keys) {
    if (held.get(key) !== owner) continue
    const q = waiting.get(key)
    const next = q?.shift()
    if (!q?.length) waiting.delete(key)
    if (next) {
      held.set(key, next.owner)
      next.grant()
    } else {
      held.delete(key)
    }
  }
}

/**
 * 拿一组文件的写租约，返回释放函数（幂等，重复调用无副作用）。
 *
 * 调用方负责在写完（含快照落库）之后调用它；抛错时内部已经回滚已拿到的那些，
 * 不会留下半组锁把后面的任务全卡住。
 */
export async function acquireFileLeases(
  paths: string[],
  opts: { owner: string; signal?: AbortSignal; waitMs?: number }
): Promise<() => void> {
  // 排序：两个任务要同一组文件但顺序不同时，固定顺序才不会互相等成死锁
  const keys = [...new Set(paths.filter(Boolean).map(keyOf))].sort()
  const taken: string[] = []
  try {
    for (const key of keys) {
      const fresh = await acquireOne(key, opts.owner, opts.signal, opts.waitMs ?? DEFAULT_WAIT_MS)
      // 重入（这层本来就被自己占着）不记进 taken：否则释放时会把外层那次的锁一起放掉
      if (fresh) taken.push(key)
    }
  } catch (err) {
    release(taken, opts.owner)
    throw err
  }
  let done = false
  return () => {
    if (done) return
    done = true
    release(taken, opts.owner)
  }
}

/** 测试 / 诊断：这个路径现在归谁 */
export function leaseHolder(p: string): string | undefined {
  return held.get(keyOf(p))
}

/** 测试用：清空状态，免得用例之间互相污染 */
export function resetFileLeases(): void {
  held.clear()
  waiting.clear()
}
