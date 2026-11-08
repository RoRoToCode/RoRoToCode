import type { TokenUsage } from './types'

/**
 * 模型单价表（美元 / 100 万 tokens）。
 *
 * 这些数字会过时，所以只用来「大概心里有数」，不做账。
 * 表里没有的模型（尤其本地模型、中转站自定义名）一律不算钱，只显示 token 数 ——
 * 猜一个假单价，比不显示更糟。
 */
const PRICES: Array<{ match: RegExp; in: number; out: number }> = [
  { match: /gpt-4o-mini/i, in: 0.15, out: 0.6 },
  { match: /gpt-4o(?!-mini)/i, in: 2.5, out: 10 },
  { match: /gpt-4\.1-mini/i, in: 0.4, out: 1.6 },
  { match: /gpt-4\.1/i, in: 2, out: 8 },
  { match: /o4-mini/i, in: 1.1, out: 4.4 },
  { match: /deepseek-reasoner/i, in: 0.55, out: 2.19 },
  { match: /deepseek-chat|deepseek-v\d/i, in: 0.27, out: 1.1 },
  { match: /claude-3-5-haiku|claude-haiku/i, in: 0.8, out: 4 },
  { match: /claude-sonnet/i, in: 3, out: 15 },
  { match: /claude-opus/i, in: 15, out: 75 },
  { match: /qwen-max/i, in: 1.6, out: 6.4 },
  { match: /gemini-2\.5-pro/i, in: 1.25, out: 10 },
  { match: /gemini-2\.5-flash/i, in: 0.3, out: 2.5 }
]

export function unitPrice(model: string): { in: number; out: number } | null {
  const name = (model || '').trim()
  if (!name) return null
  for (const p of PRICES) if (p.match.test(name)) return { in: p.in, out: p.out }
  return null
}

/** 按 token 数估一个花费；模型不认识就返回 undefined */
export function estimateCost(model: string, usage: TokenUsage): number | undefined {
  const price = unitPrice(model)
  if (!price) return undefined
  const cached = Math.max(0, Math.min(usage.cached ?? 0, usage.prompt))
  // 缓存命中部分按 1/10 计（各家折扣不同，取个保守值）
  const fresh = usage.prompt - cached
  const cost = (fresh / 1e6) * price.in + (cached / 1e6) * price.in * 0.1 + (usage.completion / 1e6) * price.out
  return Math.round(cost * 1e6) / 1e6
}

/** 界面用的紧凑写法：12400 → 12.4k */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 2 : 1)}k`
  return `${(n / 1e6).toFixed(2)}m`
}
