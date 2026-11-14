/**
 * 把多个中断信号合并成一个：任意一个触发，结果就触发。
 *
 * 用途是「运行中插话」：整轮运行有自己的信号（点停止才断），
 * 每一步又有自己的信号（用户插话就断这一步）。工具执行时同时听这两个，
 * 所以点停止和插话走的是同一条中断路径，只是范围不同。
 *
 * 不直接用 AbortSignal.any：那要求较新的运行时，而这里只要一个对象就够。
 *
 * 监听器必须能显式摘掉。之前只在「合并信号自己 abort」时摘，而正常跑完的一步
 * 永远不会 abort —— 于是每多跑一步就往整轮 signal 上再挂一对监听。600 步的任务
 * 会挂 600 个，Node 从第 11 个起打 MaxListenersExceededWarning，闭包还会把每步的
 * controller 拖到整轮结束。调用方每一步结束时必须 dispose()。
 */
export interface CombinedSignal {
  signal: AbortSignal
  /** 摘掉挂在两个源信号上的监听。可重复调用 */
  dispose(): void
}

export function combineSignals(first: AbortSignal, second: AbortSignal): CombinedSignal {
  const out = new AbortController()
  let disposed = false

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    first.removeEventListener('abort', onAbort)
    second.removeEventListener('abort', onAbort)
  }

  const onAbort = (): void => {
    // 带上先断的那个信号的原因，上层据此区分「用户取消」和「用户插话」
    dispose()
    out.abort((first.aborted ? first : second).reason)
  }

  if (first.aborted || second.aborted) {
    onAbort()
    return { signal: out.signal, dispose }
  }

  first.addEventListener('abort', onAbort)
  second.addEventListener('abort', onAbort)
  return { signal: out.signal, dispose }
}
