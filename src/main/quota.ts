/**
 * 今天的 token 用量。只在主进程读写，界面拿不到写入口。
 *
 * 落盘而不是只放内存：定时任务跑一晚上，中间重启一次就忘了今天已经花掉多少，
 * 那这个上限等于没有。
 *
 * 跨天自动清零：每次读文件先比日期，不是今天就从 0 开始（不做「按小时折算」，
 * 那对「别把今天的额度用完」这个诉求没有帮助，只会让人看不懂）。
 */
import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { TokenUsage } from '../shared/types'

interface DayUsage {
  /** 本地日期 YYYY-MM-DD */
  date: string
  prompt: number
  completion: number
}

const FILE = 'quota.json'

function filePath(): string {
  return path.join(app.getPath('userData'), FILE)
}

/** 本地日期，不用 toISOString（那是 UTC，东八区到晚上 8 点就跨天了） */
export function todayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

let cache: DayUsage | null = null
/** 串行队列：并发写同一个文件会互相覆盖 */
let tail: Promise<unknown> = Promise.resolve()

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = tail.then(fn, fn)
  tail = next.catch(() => undefined)
  return next
}

function empty(): DayUsage {
  return { date: todayKey(), prompt: 0, completion: 0 }
}

async function read(): Promise<DayUsage> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(filePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<DayUsage>
    const date = typeof parsed.date === 'string' ? parsed.date : ''
    if (date !== todayKey()) {
      cache = empty()
      return cache
    }
    cache = {
      date,
      prompt: Math.max(0, Math.round(Number(parsed.prompt) || 0)),
      completion: Math.max(0, Math.round(Number(parsed.completion) || 0))
    }
  } catch {
    // 没有文件 / 文件坏了：从 0 开始，不因为统计文件坏了就挡住对话
    cache = empty()
  }
  return cache
}

async function write(next: DayUsage): Promise<void> {
  cache = next
  try {
    await fs.mkdir(path.dirname(filePath()), { recursive: true })
    await fs.writeFile(filePath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    // 统计落盘失败不能影响对话本身：内存里的值仍然有效
  }
}

/** 今天累计用了多少 token */
export async function dayUsage(): Promise<number> {
  const cur = await serialize(read)
  return cur.prompt + cur.completion
}

/** 记一笔，返回记完之后的今日累计 */
export async function bumpDayUsage(delta: Pick<TokenUsage, 'prompt' | 'completion'>): Promise<number> {
  const prompt = Math.max(0, Math.round(Number(delta.prompt) || 0))
  const completion = Math.max(0, Math.round(Number(delta.completion) || 0))
  if (!prompt && !completion) return await dayUsage()
  const next = await serialize(async () => {
    const cur = await read()
    // 跨天了就从头记：这一笔属于今天
    const base = cur.date === todayKey() ? cur : empty()
    const merged: DayUsage = {
      date: base.date,
      prompt: base.prompt + prompt,
      completion: base.completion + completion
    }
    await write(merged)
    return merged
  })
  return next.prompt + next.completion
}

/** 自检与「重置今日用量」用 */
export async function resetDayUsage(): Promise<void> {
  await serialize(async () => {
    cache = null
    await write(empty())
  })
}
