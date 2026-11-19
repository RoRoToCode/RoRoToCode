import type { ChatMessage } from './types'

/**
 * 请求体 token 粗估。
 *
 * 放在 shared 里是因为有三个使用方要算同一笔账：引擎裁历史、供应商算输出预算、
 * 子 agent 裁自己的上下文。以前这份实现只长在 agent.ts 里，供应商那侧压根不知道
 * prompt 有多大，于是「历史按 25% 预留输出」和「请求里许出去 16384 输出」各算各的。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk++
    else other++
  }
  /**
   * 3.5 → 3：HTML / JSON / 代码里符号密集，llama.cpp 的 tokenizer 切得比 3.5 字符/token 更碎。
   * 以前按 3.5 估出来的值总是偏乐观，于是「明明按 70% 裁过」仍然只差几十个 token 就撞上限：
   * 日志里的 16431 vs 16384 就是这么来的 —— 三次重试都发同一份，谁也没发现估算骗了人。
   * 宁可高估一点（多压几百 token 历史），也不要再让一整轮任务卡在 400 上重来。
   */
  return Math.ceil(cjk + other / 3)
}

export function messagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => {
    const calls = m.toolCalls ? JSON.stringify(m.toolCalls).length : 0
    return sum + estimateTokens(m.content) + Math.ceil(calls / 3) + 8
  }, 0)
}

/** 工具定义（名字 + 说明 + JSON Schema）也要算进请求体，本地小窗口模型上这笔开销不小 */
export function toolsTokens(tools: { name: string; description?: string; parameters?: unknown }[]): number {
  return tools.reduce(
    (n, t) =>
      n +
      estimateTokens(t.name) +
      estimateTokens(t.description || '') +
      Math.ceil(JSON.stringify(t.parameters ?? {}).length / 3) +
      12,
    0
  )
}

/** 一次请求真正会占掉的输入量：历史 + 工具定义。用来算「还剩多少能留给输出」 */
export function requestTokens(
  messages: ChatMessage[],
  tools: { name: string; description?: string; parameters?: unknown }[]
): number {
  return messagesTokens(messages) + toolsTokens(tools)
}
