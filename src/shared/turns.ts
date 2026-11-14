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

/**
 * 把尾部「配不上对」的消息剪掉。
 *
 * 用在分叉上：用户可能从任意一条消息切开，切点正好落在「助手已经喊了工具、
 * 结果还没回来」的位置时，新会话就带着一组没有结果的 tool_calls。
 * OpenAI / Anthropic 收到这种历史会直接 400，整个分叉出来的会话从此打不开。
 *
 * 只从尾部往前剪，不碰中间：中间的不配对属于数据损坏，那是另一回事，
 * 悄悄重排反而会把现场破坏掉。
 */
export function trimDanglingTail(messages: ChatMessage[]): ChatMessage[] {
  const out = [...messages]
  while (out.length > 0 && !toolPairsIntact(out)) out.pop()
  return out
}

/**
 * 历史装不下时，从最早的「整轮」开始丢。
 *
 * 关键约束：只能切在 user 消息前面。一条轮次 = 提问 + 助手回复 + 它触发的全部工具结果，
 * 切在 user 前面就意味着这些内容整组留下或整组丢掉 —— 不会出现「助手喊了 3 个工具、
 * 只回来 2 个结果」这种历史（服务端一定 400，而且这个会话之后每次发送都会 400）。
 *
 * 以前 compact() 是 `tail.shift()` 一条一条从头丢，完全不看角色，所以第一次 shift
 * 就可能正好丢到某条 tool 结果。overBudget 由调用方传入（它才知道 token 怎么算）。
 */
export function dropOldestTurns(
  messages: ChatMessage[],
  overBudget: (next: ChatMessage[]) => boolean
): ChatMessage[] {
  if (!overBudget(messages)) return messages

  // 第一条提问留着当「任务背景」，它本身不带 tool_calls，单独留是安全的
  const head = messages.length > 0 && messages[0].role === 'user' ? [messages[0]] : []
  const rest = messages.slice(head.length)
  let cut = 0
  while (cut < rest.length && overBudget([...head, ...rest.slice(cut)])) {
    let next = cut + 1
    while (next < rest.length && rest[next].role !== 'user') next++
    // 后面已经没有提问了：再切就把最后一轮也切没，直接停
    if (next >= rest.length) break
    cut = next
  }
  const out = cut === 0 ? messages : [...head, ...rest.slice(cut)]
  // 兜底：宁可超预算，也不发一份配不上对的历史
  return toolPairsIntact(out) ? out : messages
}
