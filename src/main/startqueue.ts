/**
 * 串行队列：同一时刻只跑一个任务，其余按到达顺序排队。
 *
 * 为什么需要它：启动一个本地模型不是「一个函数调用」，而是一长串带 `await`
 * 的检查（找二进制、体检显存、探端口、清旧实例），中间任何一步让出事件循环，
 * 另一个启动请求就能挤进来，两个都以为「还没有实例在跑」，于是各起一个进程。
 *
 * 会话那边有 RunQueue，但它管的是「同时能跑几个会话」、还带优先级插队，
 * 语义不一样；这里要的是纯排序：先到先跑，不多不少一个。
 *
 * 失败不会卡住队列：前一个任务抛错时，后一个照常开始（错误由各自的调用方处理）。
 */
export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>

export function createSerialQueue(): SerialQueue {
  /** 队尾。恒为 resolved —— 无论任务成败，队尾都只用来表示「轮到我了」 */
  let tail: Promise<void> = Promise.resolve()

  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task)
    tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}
