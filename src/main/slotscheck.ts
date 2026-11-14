/**
 * 多槽并行的实测探针。
 *
 * 要回答的是一个一直没被验证过的问题：开了 `-np 2` 之后，一个 30K 的 agent prompt
 * 还能不能用满？两个并发请求会不会互相挤掉？
 *
 * 关键不在「能不能并发」，而在 **KV 池是共享还是按槽切分**：
 * - 共享池（`-kvu`）：`-c 30000` 是总量，单个请求可以用满 30K，两个并发之和不能超 30K。
 * - 按槽切分（不加 `-kvu`，llama.cpp 在显式给 `-np` 后的默认行为）：
 *   每个槽只有 30K/2 = 15K，一个 24K 的 prompt 直接超窗。
 *
 * 所以探测分两步，缺一不可：
 * 1. **单个长请求**（0.8 × 测试窗口）—— 过了说明 KV 是共享的，`-kvu` 生效了。
 * 2. **两个中长请求并发**（各 0.4 × 窗口）—— 都过且耗时接近单个，说明是真并行，
 *    不是「排队假装并行」。
 *
 * 为什么不在这一步用全局闸门：那道闸门会按槽位排队，把并发变成串行，
 * 测出来的东西正好是我们要否定的。这里直接打服务端。
 */

import type { SlotsProbeResult, SlotsVerdict } from '../shared/types'

export interface SlotsProbeInput {
  /** 形如 http://127.0.0.1:8080/v1 */
  baseUrl: string
  apiKey?: string
  model: string
  /** 模型配置里的上下文窗口 */
  contextWindow: number
  signal?: AbortSignal
}

export type { SlotsProbeResult, SlotsVerdict }

const MAX_TEST_CTX = 16384
const REQUEST_TIMEOUT = 180_000

/** baseUrl 去掉 /v1 之类的后缀，拿到服务根，/props 在根路径上 */
function rootOf(baseUrl: string): string {
  try {
    const u = new URL(baseUrl)
    return `${u.protocol}//${u.host}`
  } catch {
    return baseUrl.trim().replace(/\/+$/, '').replace(/\/v\d+$/i, '')
  }
}

/** 造一段大约 tokens 个 token 的填充文本。中文 1 字≈1 token，用来做占位最直接 */
function filler(tokens: number): string {
  const unit = '这是一段用来占满上下文窗口的测试文本。'
  const perUnit = unit.length
  const times = Math.max(1, Math.ceil(tokens / perUnit))
  return unit.repeat(times)
}

interface ChatOutcome {
  ok: boolean
  ms: number
  status: number
  /** 起止时间戳：判断「真并行 vs 排队」只能靠区间重不重叠，
      用总耗时比较会失效 —— 两个 0.4 窗口串行跑，总时长正好等于一个 0.8 窗口 */
  startedAt: number
  endedAt: number
  /** llama.cpp 的 timings.prompt_n / usage.prompt_tokens */
  promptTokens: number | null
  error: string
}

async function oneChat(input: SlotsProbeInput, promptTokens: number, signal: AbortSignal): Promise<ChatOutcome> {
  const startedAt = Date.now()
  const url = input.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model: input.model,
        // max_tokens=1：只测 prefill 和并发，生成一个字就够，
        // 否则下面的耗时里混进生成速度，读不出「有没有被挤」
        max_tokens: 1,
        stream: false,
        messages: [
          { role: 'system', content: filler(promptTokens) },
          { role: 'user', content: '只回复 ok' }
        ]
      })
    })

    const raw = await res.text()
    const endedAt = Date.now()
    if (!res.ok) {
      return {
        ok: false,
        ms: endedAt - startedAt,
        startedAt,
        endedAt,
        status: res.status,
        promptTokens: null,
        error: raw.slice(0, 600)
      }
    }
    let parsed: {
      usage?: { prompt_tokens?: number }
      timings?: { prompt_n?: number }
    } = {}
    try {
      parsed = JSON.parse(raw)
    } catch {
      // 有些服务回的不是标准 JSON，只要能 200 就算成功
    }
    const pt = Number(parsed.usage?.prompt_tokens ?? parsed.timings?.prompt_n ?? 0) || null
    return { ok: true, ms: endedAt - startedAt, startedAt, endedAt, status: 200, promptTokens: pt, error: '' }
  } catch (err) {
    const endedAt = Date.now()
    return {
      ok: false,
      ms: endedAt - startedAt,
      startedAt,
      endedAt,
      status: 0,
      promptTokens: null,
      error: (err as Error).message
    }
  }
}

/** 问服务端要槽位数。/props 不是 llama.cpp 就没有，返回 0 */
async function probeSlots(base: string, signal: AbortSignal): Promise<number> {
  try {
    const res = await fetch(`${base}/props`, { signal })
    if (!res.ok) return 0
    const json = (await res.json()) as {
      total_slots?: number
      default_generation_settings?: { n_parallel?: number }
    }
    const n = Math.round(Number(json.total_slots ?? json.default_generation_settings?.n_parallel ?? 0))
    return Number.isFinite(n) && n > 0 ? Math.min(n, 8) : 0
  } catch {
    return 0
  }
}

/** 错误信息里出现这些词，说明是上下文装不下，而不是网络/鉴权问题 */
function looksLikeContextOverflow(text: string): boolean {
  return /context|n_ctx|too long|exceeds|窗口|长度|token/i.test(text)
}

export async function probeSlotsConcurrency(input: SlotsProbeInput): Promise<SlotsProbeResult> {
  const base = rootOf(input.baseUrl)
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  input.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT * 2)

  const slots = await probeSlots(base, ctl.signal)
  const testCtx = Math.min(MAX_TEST_CTX, Math.max(2048, input.contextWindow || MAX_TEST_CTX))

  const baseResult = {
    slots,
    testCtx,
    singleMs: null as number | null,
    concurrentMs: null as [number, number] | null,
    promptTokens: null as number | null
  }

  try {
    if (slots === 0) {
      return {
        ...baseResult,
        verdict: 'unsupported',
        message:
          '这个服务不返回槽位信息（不是 llama.cpp）。并发能力取决于服务自己的实现，这里测不了，也不该凭空猜。'
      }
    }

    // ---- 第一步：一个 0.8 窗口的长请求 ----
    const longTokens = Math.round(testCtx * 0.8)
    const single = await oneChat(input, longTokens, ctl.signal)
    if (!single.ok) {
      if (looksLikeContextOverflow(single.error)) {
        return {
          ...baseResult,
          verdict: 'slot-split',
          singleMs: single.ms,
          message: `开了 ${slots} 个槽，但上下文被切成了每槽约 ${Math.round(testCtx / slots)} —— 一个 ${longTokens} 的请求就超窗了。` +
            '这说明启动参数里少了 -kvu（不配它，llama.cpp 会按槽切分上下文）。',
          detail: single.error
        }
      }
      return {
        ...baseResult,
        verdict: 'error',
        singleMs: single.ms,
        message: `单个长请求就失败了（HTTP ${single.status || '网络错误'}）。可能是服务没起、模型名不对，或显存不够。`,
        detail: single.error
      }
    }

    // ---- 第二步：两个各 0.4 窗口的请求同时发 ----
    const pairTokens = Math.round(testCtx * 0.4)
    const [a, b] = await Promise.all([
      oneChat(input, pairTokens, ctl.signal),
      oneChat(input, pairTokens, ctl.signal)
    ])
    // 墙钟只用于文案展示，判定看区间重叠
    const wall = Math.max(a.endedAt, b.endedAt) - Math.min(a.startedAt, b.startedAt)

    if (!a.ok || !b.ok) {
      const failed = !a.ok ? a : b
      return {
        ...baseResult,
        verdict: 'serialized',
        singleMs: single.ms,
        concurrentMs: [a.ms, b.ms],
        promptTokens: single.promptTokens,
        message:
          `槽位报的是 ${slots}，但两个并发请求里有一个失败了（HTTP ${failed.status || '网络错误'}）。` +
          '常见原因是实际只有一个槽在跑：并发请求被服务端拒绝或排队到超时。',
        detail: failed.error
      }
    }

    const timings: [number, number] = [a.ms, b.ms]
    const slowest = Math.max(a.ms, b.ms)
    /**
     * 判定「真并行」：看两个请求的**耗时比值**。
     *
     * 走过的两条弯路，都记在这里免得再踩：
     * 1. 用总耗时比不行 —— prefill 时间与 token 数成正比，两个 0.4 窗口串行跑的
     *    总时长正好等于一个 0.8 窗口的，比值恒为 1，并行串行一个样。
     * 2. 用「客户端测的起止区间是否重叠」不行 —— 两个请求是同时发出去的，
     *    服务端内部排队与否，客户端看不到，区间永远重叠。
     *
     * 唯一可靠的信号在**每个请求各自的耗时**里：串行时第二个请求要等前一个跑完，
     * 它的耗时接近第一个的两倍（等 0.4 + 自己 0.4）；并行时两者接近。
     * 阈值 1.6 留给调度抖动和 prefill 的轻微竞争。
     */
    const ratio = Math.max(a.ms, b.ms) / Math.max(1, Math.min(a.ms, b.ms))
    const parallel = ratio <= 1.6

    return {
      ...baseResult,
      verdict: parallel ? 'parallel' : 'serialized',
      singleMs: single.ms,
      concurrentMs: timings,
      promptTokens: single.promptTokens,
      message: parallel
        ? `多槽是真的：单个 ${longTokens} 上下文能用满（说明 KV 是共享池、-kvu 生效），` +
          `两个并发同时跑完只花了 ${(wall / 1000).toFixed(1)}s（单个要 ${(single.ms / 1000).toFixed(1)}s）。`
        : `能开 ${slots} 个槽，但两个请求是排队跑的：一起跑花了 ${(wall / 1000).toFixed(1)}s，` +
          `单个却只要 ${(single.ms / 1000).toFixed(1)}s。并发没带来收益，把槽位调回 1 更省显存。`,
      detail: slowest > single.ms * 3 ? `最慢的一个请求耗时 ${(slowest / 1000).toFixed(1)}s，可能有别的负载在抢资源。` : undefined
    }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', onAbort)
  }
}
