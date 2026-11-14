import type { ProviderConfig } from './types'

/**
 * 采样与输出格式参数。
 *
 * 单独抽出来有两个原因：一是这段逻辑有「留空 ≠ 填 0」的细节，放在请求组装
 * 那一大坨里没人看得见；二是它不碰网络也不碰 electron，可以直接单测 ——
 * 这种「看起来无害、错起来很难查」的参数尤其值得钉住。
 *
 * 三条规则：
 * - 用户没填就一个键都不发。默认值因程序而异（llama.cpp 的 repeat_penalty
 *   是 1.0，不少网关是 1.1），替服务端做主反而会改变用户已经调好的手感。
 * - `jsonMode` 只在**没有工具**时生效。tools 与 response_format 同时给，
 *   模型会倾向于把 tool_calls 写成普通 JSON 文本，agent 那边一步都走不下去。
 * - 非法数值直接丢弃，不带着一个会让模型胡言乱语的数去请求。
 */
export function samplingBody(
  provider: ProviderConfig,
  hasTools: boolean
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof provider.topP === 'number' && Number.isFinite(provider.topP)) {
    out.top_p = provider.topP
  }
  if (typeof provider.repeatPenalty === 'number' && Number.isFinite(provider.repeatPenalty)) {
    out.repeat_penalty = provider.repeatPenalty
  }
  if (!hasTools && provider.jsonMode === true) {
    out.response_format = { type: 'json_object' }
  }
  return out
}
