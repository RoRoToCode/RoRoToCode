import type { ChatMessage } from './types'

export interface TurnRange {
  /** 含 */
  start: number
  /** 不含 */
  end: number
}

/**
 * 定位某条消息所在的「一轮对话」，返回 [start, end) 的下标范围。
 *
 * 一轮 = 一条用户提问 + 由它引发的所有助手回答 / 工具调用 / 工具结果，直到下一条用户提问。
 * 之所以整轮一起删，而不是只删点中的那一条：
 * - assistant 的 toolCalls 与 tool 结果靠 toolCallId 严格配对，少一条 OpenAI / Anthropic 就 400；
 * - 只删提问会留下「没有问题的回答」，模型看到的历史会变得莫名其妙；
 * - 真正占上下文的往往正是这一轮里的大段工具输出，整轮删才省得干净。
 *
 * 会话开头如果没有 user（历史被删过或异常数据），就一直删到第一条 user 之前。
 */
export function turnRangeOf(messages: ChatMessage[], messageId: string): TurnRange | null {
  const idx = messages.findIndex((m) => m.id === messageId)
  if (idx < 0) return null

  let start = idx
  while (start > 0 && messages[start].role !== 'user') start--
  if (messages[start].role !== 'user') start = 0

  let end = idx + 1
  while (end < messages.length && messages[end].role !== 'user') end++

  return { start, end }
}

/**
 * 删掉的正好是给会话取名的第一条提问时，把标题改成剩下最早的提问。
 * 只在标题确实是自动生成的（等于那条提问的前 40 字）时才动，用户手动改过的不碰。
 */
export function titleAfterTurnDelete(
  title: string,
  removed: ChatMessage[],
  remaining: ChatMessage[]
): string {
  if (removed[0]?.role !== 'user') return title
  const old = removed[0].content.replace(/\s+/g, ' ').slice(0, 40)
  if (!old || title !== old) return title
  const next = remaining.find((m) => m.role === 'user')
  return next ? next.content.replace(/\s+/g, ' ').slice(0, 40) || '新会话' : '新会话'
}

/** 检查一轮删除后是否还有孤儿 tool 结果 / 没收到结果的 tool_calls（单测与防御性校验用） */
export function toolPairsIntact(messages: ChatMessage[]): boolean {
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const m of messages) {
    for (const c of m.toolCalls ?? []) calls.add(c.id)
    if (m.role === 'tool' && m.toolCallId) results.add(m.toolCallId)
  }
  if (calls.size !== results.size) return false
  for (const id of calls) if (!results.has(id)) return false
  return true
}
