/**
 * Cron 表达式解析与「下一次该跑的时间」计算。
 *
 * 放在 shared 而不是 main：这两件事是纯函数，不该拖一个 electron 依赖进单测。
 * 只支持标准 5 段（分 时 日 月 周），不支持秒级和 @daily 这类宏 —— 定时唤醒 agent
 * 不需要秒级精度，多一套语法就多一处出错的地方。
 *
 * 没有引入任何 cron 库：需求就这么点，多一个依赖就多一份「它到底怎么算」的不确定性。
 */
import type { RoutineTrigger } from './types'

const MINUTE = 60_000
/** 往后最多找 400 天：再远说明表达式本身不可能命中（比如 2 月 30 日） */
const HORIZON_DAYS = 400

/** 五段的合法范围，顺序同 cron：分 时 日 月 周（周允许 7，含义同 0） */
const RANGES: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7]
]

function parseField(text: string, min: number, max: number): number[] | null {
  const out = new Set<number>()
  for (const rawPart of text.split(',')) {
    const part = rawPart.trim()
    if (!part) return null
    const [rangeText, stepText] = part.split('/')
    if (stepText !== undefined && !/^\d+$/.test(stepText)) return null
    const step = stepText === undefined ? 1 : Number(stepText)
    if (step <= 0) return null

    let lo = min
    let hi = max
    if (rangeText !== '*') {
      const m = rangeText.match(/^(\d+)(?:-(\d+))?$/)
      if (!m) return null
      lo = Number(m[1])
      // `5/10` 这种写法在 cron 里的意思是「从 5 开始，每 10 个一次」，一直到上限
      hi = m[2] !== undefined ? Number(m[2]) : stepText !== undefined ? max : lo
      if (hi < lo) return null
      if (lo < min || hi > max) return null
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out.size ? [...out].sort((a, b) => a - b) : null
}

export interface CronSpec {
  minutes: number[]
  hours: number[]
  days: number[]
  months: number[]
  weekdays: number[]
}

/** 解析失败返回 null，调用方据此把这条任务标成配置错误，而不是静默不跑 */
export function parseCron(expr: string): CronSpec | null {
  const parts = String(expr ?? '').trim().split(/\s+/)
  if (parts.length !== 5) return null
  const fields: number[][] = []
  for (let i = 0; i < 5; i++) {
    const parsed = parseField(parts[i], RANGES[i][0], RANGES[i][1])
    if (!parsed) return null
    fields.push(parsed)
  }
  // 周日既接受 0 也接受 7：两种写法都很常见，认死一种会让人白等一天。
  // 解析阶段允许 7，这里统一折成 0，后面就只剩一种表示。
  const weekdays = new Set(fields[4].map((d) => (d === 7 ? 0 : d)))
  return {
    minutes: fields[0],
    hours: fields[1],
    days: fields[2],
    months: fields[3],
    weekdays: [...weekdays].sort((a, b) => a - b)
  }
}

function isFull(list: number[], min: number, max: number): boolean {
  return list.length === max - min + 1
}

/**
 * 从 from 之后（不含 from 所在那一分钟）找下一个命中时间。
 * 逐分钟试是笨办法，但按「月 → 日 → 时 → 分」跳着走，实际循环次数很少。
 */
export function nextRun(expr: string, from: number): number | null {
  const spec = parseCron(expr)
  if (!spec) return null

  const domRestricted = !isFull(spec.days, 1, 31)
  const dowRestricted = !isFull(spec.weekdays, 0, 6)
  const limit = from + HORIZON_DAYS * 86_400_000

  const start = new Date(from)
  start.setSeconds(0, 0)
  let t = start.getTime() + MINUTE

  while (t <= limit) {
    const d = new Date(t)
    if (!spec.months.includes(d.getMonth() + 1)) {
      t = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0).getTime()
      continue
    }
    // 标准 cron 的语义：日和周都被限定时是「或」，只有一个被限定就用那一个
    const domOk = spec.days.includes(d.getDate())
    const dowOk = spec.weekdays.includes(d.getDay())
    const dayOk =
      domRestricted && dowRestricted ? domOk || dowOk : domRestricted ? domOk : dowRestricted ? dowOk : true
    if (!dayOk) {
      t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime()
      continue
    }
    if (!spec.hours.includes(d.getHours())) {
      t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1, 0, 0, 0).getTime()
      continue
    }
    if (!spec.minutes.includes(d.getMinutes())) {
      t += MINUTE
      continue
    }
    return t
  }
  return null
}

/** 按触发方式算下一次。间隔任务从「现在」起算，不用管历史 */
export function nextRunFor(trigger: RoutineTrigger, from: number): number | null {
  if (trigger.kind === 'interval') {
    const minutes = Math.max(1, Math.min(1440, Math.floor(Number(trigger.minutes) || 0)))
    return from + minutes * MINUTE
  }
  return nextRun(trigger.expr, from)
}

/** 给界面用的人话说明，避免让用户直接读 cron */
export function describeTrigger(trigger: RoutineTrigger): string {
  if (trigger.kind === 'interval') {
    const m = Math.max(1, Math.floor(Number(trigger.minutes) || 1))
    return m % 60 === 0 ? `每 ${m / 60} 小时` : `每 ${m} 分钟`
  }
  const spec = parseCron(trigger.expr)
  if (!spec) return `无效表达式：${trigger.expr}`
  const hh = String(spec.hours[0]).padStart(2, '0')
  const mm = String(spec.minutes[0]).padStart(2, '0')
  if (isFull(spec.minutes, 0, 59) && spec.minutes.length === 60 && spec.hours.length === 1) {
    return `每天 ${hh}:00 起每分钟` // 极少见的写法，说清楚总比装作看得懂好
  }
  const everyMinute = spec.hours.length * spec.minutes.length > 24
  if (everyMinute) return `每天 ${spec.hours.length} 个时段，共 ${spec.hours.length * spec.minutes.length} 次`
  const time = `${hh}:${mm}`
  if (isFull(spec.days, 1, 31) && isFull(spec.weekdays, 0, 6)) return `每天 ${time}`
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  if (!isFull(spec.weekdays, 0, 6) && isFull(spec.days, 1, 31)) {
    return `每${spec.weekdays.map((d) => names[d]).join('、')} ${time}`
  }
  if (!isFull(spec.days, 1, 31) && isFull(spec.weekdays, 0, 6)) {
    return `每月 ${spec.days.join('、')} 日 ${time}`
  }
  return `自定义：${trigger.expr}`
}
