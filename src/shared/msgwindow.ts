/**
 * 消息列表的窗口化。
 *
 * 为什么要它：长会话里几百条消息全量挂到 DOM 上，每次流式输出一个字都要重排整棵树，
 * 越到后面越卡。这里只控制「画多少」，数据仍然全在内存里 ——
 * 搜索、导出、上下文计算、token 统计都不受影响。
 *
 * 80 行大约覆盖 20–40 轮对话，绝大多数会话触发不到，行为与全量渲染完全一致。
 */
export const MSG_WINDOW = 80
export const MSG_WINDOW_STEP = 80

export interface RowWindow<T> {
  /** 这次要渲染的行（从尾部取） */
  shown: T[]
  /** 被藏起来多少行；0 表示全部显示，调用方不需要渲染「显示更早」入口 */
  hidden: number
}

/**
 * 从尾部取窗口。
 * extra 是用户已经点开过几次「显示更早」，每次加 MSG_WINDOW_STEP。
 */
export function windowRows<T>(rows: T[], extra: number): RowWindow<T> {
  const limit = Math.max(1, MSG_WINDOW + Math.max(0, Math.floor(extra)))
  const hidden = Math.max(0, rows.length - limit)
  return { shown: hidden > 0 ? rows.slice(hidden) : rows, hidden }
}
