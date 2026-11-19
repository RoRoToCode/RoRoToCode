import type { ProviderConfig } from '../../shared/types'

/**
 * 单次输出的预算。
 *
 * 以前这里只有一个写死的数（先是 8192，后来 16384），和另一处「历史裁剪给输出留多少」
 * 各算各的：裁剪时按 `ctx * 25%（最多 4096）` 预留，请求却敢许出去 16384。
 * 64K 窗口、历史写到 55K 时，`prompt + 16384` 直接超过窗口，服务端要么截要么 400，
 * 而返回的 `finish_reason=length` 会被引擎读成「输出上限不够」，其实该做的是压历史。
 *
 * 现在按「这个请求实际还剩多少」算：`ctx - prompt - 512`，再和「愿意给多少」取小。
 */

/** 云端默认：一次能给出 8K 就足够大多数回答，预扣额度只按这个数算 */
export const DEFAULT_OUTPUT_TOKENS = 8192
/** 本地模型默认给足：不占预扣，给少了只会白跑一轮续写 */
export const LOCAL_OUTPUT_TOKENS = 16384
/** 云端撞墙后升一档（Claude Code 是 8K→64K，这里取模型普遍能吃下的 32K） */
export const ESCALATED_OUTPUT_TOKENS = 32768
/** 硬上限：再大就不是「回答被截断」而是「模型不该这么干活」了 */
export const HARD_MAX_OUTPUT = 32768
/** 给 tokenizer 偏差与模板开销留的余量 */
export const PROMPT_RESERVE = 512

/**
 * 是不是本地推理。
 *
 * 只影响「首轮给多少」：本地没有预扣额度这回事，首轮直接给足；
 * 云端首轮 8K，撞墙再升档 —— 这是 Claude Code 的做法，代价是多一次重生成。
 */
export function isLocalProvider(provider: ProviderConfig): boolean {
  if (provider.kind === 'ollama') return true
  const url = String(provider.baseUrl || '')
  return /(^|\/\/)(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|::1)(:|\/|$)/i.test(url)
}

/**
 * 这一轮该许出去多少输出 token。
 *
 * @param promptTokens 本次请求的输入估算；不知道就传 0（退回旧行为：只看窗口比例）
 * @param escalate 撞到上限之后的重试：换更大的预算，而不是让模型「自己压一压」
 */
export function outputBudget(provider: ProviderConfig, promptTokens = 0, escalate = false): number {
  const ctx = Math.floor(Number(provider.contextWindow) || 0)
  const configured = Math.floor(Number(provider.maxOutputTokens) || 0)
  const local = isLocalProvider(provider)

  // 用户显式配了就以它为准，升档也不越过它
  const want = configured
    ? configured
    : escalate
      ? local
        ? LOCAL_OUTPUT_TOKENS
        : ESCALATED_OUTPUT_TOKENS
      : local
        ? LOCAL_OUTPUT_TOKENS
        : DEFAULT_OUTPUT_TOKENS

  if (!ctx) return Math.min(want, HARD_MAX_OUTPUT)

  /**
   * 窗口够大时也别一次许太多：老代码按 1/4 留，这里保留同样的手感，
   * 免得一个 128K 窗口的模型被许出去 32K 输出、结果写得又慢又跑偏。
   */
  const share = Math.max(512, Math.floor(ctx / 4))
  const room = ctx - Math.max(0, promptTokens) - PROMPT_RESERVE
  // 历史已经吃满窗口时不再压预算 —— 那是该压缩上下文，压输出只会让它更早被截断
  const cap = room > 512 ? Math.min(share, room) : share
  return Math.max(512, Math.min(want, cap, HARD_MAX_OUTPUT))
}

/** 这一轮还有没有升档空间：没有就不必重发一次请求 */
export function escalationRoom(provider: ProviderConfig, promptTokens: number): number {
  if (Number(provider.maxOutputTokens) > 0) return 0
  const now = outputBudget(provider, promptTokens, false)
  const next = outputBudget(provider, promptTokens, true)
  return next > now ? next : 0
}

/**
 * 总超时跟着输出量走。
 *
 * 抬了上限却不抬超时，等于换了个地方失败：40 t/s 的卡跑满 16384 要 7 分钟，
 * 原来那个写死的 10 分钟会把「正在正常生成的长文件」当成卡死掐掉，
 * 用户看到的是「生成中断」，比截断更难理解。每多 1 个 token 补 40ms。
 */
export function timeoutForOutput(outTokens: number): number {
  return 10 * 60 * 1000 + Math.max(0, outTokens - 8192) * 40
}
