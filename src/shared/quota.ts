/**
 * 用量闸门：按 token 计量，不涉及钱。
 *
 * 只回答一个问题：**这一轮还能不能再发一次模型请求**。判断放在发请求之前，
 * 而不是拿到结果之后 —— 结果里的 usage 已经花出去了，事后拦没有意义。
 *
 * 两个上限独立生效：
 * - 单次运行（perRun）：一次提问/一次定时任务，防止一个任务无限烧下去；
 * - 每日累计（perDay）：防止定时任务一晚上跑几十轮把你今天的额度吃光。
 *
 * 0 或不填 = 不限。默认就是 0：不配置的人行为完全不变。
 */
import { fmtTokens } from './pricing'

export interface QuotaLimits {
  /** 单次运行上限（token），0 = 不限 */
  perRun: number
  /** 每日累计上限（token），0 = 不限 */
  perDay: number
}

export interface QuotaUsage {
  /** 本次运行已经用掉的 token */
  run: number
  /** 今天累计用掉的 token（含本次） */
  day: number
}

export type QuotaScope = 'run' | 'day'

export interface QuotaHit {
  level: 'warn' | 'stop'
  scope: QuotaScope
  used: number
  limit: number
}

export type QuotaVerdict = { level: 'ok' } | QuotaHit

/** 到 80% 就先提醒一次，让人有机会在真撞墙前收手 */
export const QUOTA_WARN_RATIO = 0.8

/**
 * 归一化上限值。负数、NaN、空都当「不限」；小数四舍五入。
 * 刻意不接受「0 = 立刻停」：那样一次手滑保存配置就会让所有会话跑不动。
 */
export function parseLimit(n: unknown): number {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v) || v <= 0) return 0
  return v
}

/** 单次优先于每日：撞了单次就先按单次说，不必让用户去算今天还剩多少 */
export function checkQuota(limits: QuotaLimits, usage: QuotaUsage): QuotaVerdict {
  const perRun = parseLimit(limits.perRun)
  const perDay = parseLimit(limits.perDay)
  const run = Math.max(0, Number(usage.run) || 0)
  const day = Math.max(0, Number(usage.day) || 0)

  if (perRun > 0 && run >= perRun) return { level: 'stop', scope: 'run', used: run, limit: perRun }
  if (perDay > 0 && day >= perDay) return { level: 'stop', scope: 'day', used: day, limit: perDay }
  if (perRun > 0 && run >= perRun * QUOTA_WARN_RATIO) {
    return { level: 'warn', scope: 'run', used: run, limit: perRun }
  }
  if (perDay > 0 && day >= perDay * QUOTA_WARN_RATIO) {
    return { level: 'warn', scope: 'day', used: day, limit: perDay }
  }
  return { level: 'ok' }
}

const SCOPE_LABEL: Record<QuotaScope, string> = {
  run: '本次运行',
  day: '今日累计'
}

/** 弹窗里的一句话：说清是哪条线、用了多少、上限多少 */
export function quotaText(hit: QuotaHit): string {
  return `${SCOPE_LABEL[hit.scope]}已用 ${fmtTokens(hit.used)} token，达到上限 ${fmtTokens(hit.limit)}`
}

/** 停止后的说明：为什么停、怎么接着干 */
export function quotaStopNote(hit: QuotaHit): string {
  return `${quotaText(hit)}，已停在这里。任务没做完可以直接发「继续」，或到「软件设置 → 审批与执行」把这个上限调大。`
}

/**
 * 自动调度（定时任务 / 交接）没有人在旁边点确认，撞上限只能停。
 * 这条文案会留在会话里，用户第二天打开能看懂为什么没干完。
 */
export function quotaAutoStopNote(hit: QuotaHit): string {
  return `${quotaText(hit)}。这一轮是自动跑的，没人能确认是否继续，所以停在这里；剩下的事下次触发时会从头再来。`
}
