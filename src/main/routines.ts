/**
 * 定时任务（routines）：到点把某个 Agent 档案唤醒一次。
 *
 * 设计上刻意做得很窄 —— 只有「一句交代 + 一个时间」，没有分支、没有节点图。
 * 原因：本地模型跑长链路的稳定性撑不起工作流编排，一条任务做三件小事就开始丢上下文。
 * 想要复杂流程，就让那条 prompt 自己写清楚步骤，让 agent 用 update_todos 去管。
 *
 * 并发：全局只跑一条。本地一份模型服务同时被两个长任务抢，结果是两个都变慢、
 * 上下文互相挤，还不如排队。忙的时候没跑上的任务会在 WAIT_MS 内重试，
 * 超过就记一条 skipped —— 宁可少跑一次，也不要开机后突然补跑一堆。
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { Routine, RoutineStatus, RoutineTrigger } from '../shared/types'
import { nextRunFor } from '../shared/cron'

const FILE = 'routines.json'
/** 每 30 秒看一次表：cron 精度是分钟，这个频率足够且几乎不耗电 */
const TICK_MS = 30_000
/** 迟到超过 6 小时就不再补跑 */
const STALE_MS = 6 * 60 * 60 * 1000
/** 忙的时候最多等 30 分钟，再久就跳过这一轮 */
const WAIT_MS = 30 * 60 * 1000
/** 自动调度失败后隔多久重试：多数失败是模型没起来 / 断网，两分钟后再试一次就够了 */
export const RETRY_MS = 2 * 60 * 1000
/** 连续失败到这个次数就自动停用 —— 半夜反复失败的定时任务只会白烧电，还会刷屏 */
export const MAX_AUTO_FAILS = 3

let cache: Routine[] | null = null
let timer: NodeJS.Timeout | null = null
let ticking = false

export function routinesPath(): string {
  return path.join(app.getPath('userData'), FILE)
}

function clampPolicy(v: unknown): 'deny' | 'allow' {
  return v === 'allow' ? 'allow' : 'deny'
}

function normalizeTrigger(input: unknown): RoutineTrigger {
  const raw = (input ?? {}) as Record<string, unknown>
  if (raw.kind === 'interval') {
    const minutes = Math.max(1, Math.min(1440, Math.floor(Number(raw.minutes) || 60)))
    return { kind: 'interval', minutes }
  }
  const expr = String(raw.expr ?? '0 9 * * *').trim()
  return { kind: 'cron', expr }
}

function normalize(input: Partial<Routine>): Routine {
  const now = Date.now()
  const name = String(input.name ?? '').trim().slice(0, 60)
  const prompt = String(input.prompt ?? '').trim().slice(0, 8000)
  if (!name) throw new Error('任务需要名字')
  if (!prompt) throw new Error('任务需要一句要它做的事')
  const trigger = normalizeTrigger(input.trigger)
  return {
    id: String(input.id ?? '').trim() || `routine_${randomBytes(4).toString('hex')}`,
    name,
    agentId: String(input.agentId ?? '').trim(),
    prompt,
    trigger,
    enabled: input.enabled !== false,
    approvalPolicy: clampPolicy(input.approvalPolicy),
    createdAt: Number(input.createdAt) || now,
    updatedAt: now,
    ...(Number(input.nextRunAt) ? { nextRunAt: Number(input.nextRunAt) } : {}),
    ...(Number(input.lastRunAt) ? { lastRunAt: Number(input.lastRunAt) } : {}),
    ...(input.lastSessionId ? { lastSessionId: String(input.lastSessionId) } : {}),
    ...(input.lastStatus ? { lastStatus: input.lastStatus as RoutineStatus } : {}),
    ...(input.lastError ? { lastError: String(input.lastError) } : {}),
    // 0 也要写进去：重新启用时要能把「连续失败次数」清零，不能让旧值留着
    ...(input.consecutiveFails === undefined
      ? {}
      : { consecutiveFails: Math.max(0, Math.floor(Number(input.consecutiveFails) || 0)) })
  }
}

async function persist(list: Routine[]): Promise<void> {
  await fs.mkdir(path.dirname(routinesPath()), { recursive: true })
  await fs.writeFile(routinesPath(), JSON.stringify(list, null, 2), 'utf8')
}

export async function listRoutines(): Promise<Routine[]> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(routinesPath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const list = Array.isArray(parsed) ? parsed : []
    cache = list
      .map((item) => {
        try {
          return normalize(item as Partial<Routine>)
        } catch {
          return null
        }
      })
      .filter((r): r is Routine => r !== null)
  } catch {
    cache = []
  }
  return cache
}

export async function getRoutine(id: string): Promise<Routine | null> {
  return (await listRoutines()).find((r) => r.id === id) ?? null
}

export async function upsertRoutine(input: Partial<Routine>): Promise<Routine> {
  const list = await listRoutines()
  const next = normalize(input)
  const idx = list.findIndex((r) => r.id === next.id)
  // 改了触发方式就一定要重算下一次，否则旧时间戳会留着，任务永远不跑
  const nextRunAt = next.enabled ? (nextRunFor(next.trigger, Date.now()) ?? undefined) : undefined
  const merged: Routine =
    idx >= 0
      ? { ...list[idx], ...next, createdAt: list[idx].createdAt, nextRunAt }
      : { ...next, nextRunAt }
  const out = idx >= 0 ? list.map((r) => (r.id === merged.id ? merged : r)) : [...list, merged]
  cache = out
  await persist(out)
  return merged
}

export async function removeRoutine(id: string): Promise<boolean> {
  const list = await listRoutines()
  const next = list.filter((r) => r.id !== id)
  if (next.length === list.length) return false
  cache = next
  await persist(next)
  return true
}

export async function setEnabled(id: string, enabled: boolean): Promise<Routine | null> {
  const list = await listRoutines()
  const target = list.find((r) => r.id === id)
  if (!target) return null
  // 重新启用等于「换个时间再试一次」：把连续失败清零，否则启用后第一次失败就又到上限
  return await upsertRoutine(enabled ? { ...target, enabled, consecutiveFails: 0 } : { ...target, enabled })
}

async function patch(id: string, changes: Partial<Routine>): Promise<void> {
  const list = await listRoutines()
  if (!list.some((r) => r.id === id)) return
  // 先算出新数组再赋值：直接读 cache 会撞上「可能是 null」的窄化失效
  const next = list.map((r) => (r.id === id ? { ...r, ...changes, updatedAt: Date.now() } : r))
  cache = next
  await persist(next)
}

export interface RoutineRunner {
  /** 真去跑一次，返回会话 id。抛异常表示没跑成 */
  fire: (routine: Routine) => Promise<string>
  /** 现在有没有别的任务在跑；本地模型一次只该有一个 */
  busy?: () => boolean
  /**
   * 连续失败太多次、任务被自动停用时的通知。
   * 界面上会把任务标红，但那条通知常常是用户唯一会看到的东西 —— 得说清楚「它已经停了」，
   * 否则只看到三次「失败」，第二天以为还在正常跑。
   */
  disabled?: (routine: Routine) => void
}

let runner: RoutineRunner | null = null

/**
 * 手动跑一次（界面的「立即运行」和调度器共用同一条路径，
 * 避免出现「定时能跑、手动跑不了」这种两套逻辑）。
 *
 * auto=true 表示是调度器叫起来的：只有这种情况才累计连续失败、才安排重试。
 * 人点「运行」多半在调试配置，失败一次就停用会让人莫名其妙。
 */
export async function runRoutine(
  id: string,
  opts: { auto?: boolean } = {}
): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const routine = await getRoutine(id)
  if (!routine) return { ok: false, error: '没有这个任务' }
  // 局部捕获：模块级 let 在 await 之后窄化会失效
  const run = runner
  if (!run) return { ok: false, error: '调度器还没启动' }

  await patch(id, { lastStatus: 'running', lastRunAt: Date.now() })
  try {
    const sessionId = await run.fire(routine)
    await patch(id, {
      lastStatus: 'ok',
      lastSessionId: sessionId,
      consecutiveFails: 0,
      lastError: undefined,
      nextRunAt: nextRunFor(routine.trigger, Date.now()) ?? undefined
    })
    return { ok: true, sessionId }
  } catch (err) {
    const message = (err as Error).message || '运行失败'
    // 执行体失败时可能已经建了会话（模型没起来、断网）：能拿到 id 就记下来，
    // 让用户点得进去看现场，而不是只知道「失败了」
    const failedSession = (err as Error & { sessionId?: string }).sessionId
    const fails = opts.auto ? (routine.consecutiveFails ?? 0) + 1 : (routine.consecutiveFails ?? 0)

    if (opts.auto && fails >= MAX_AUTO_FAILS) {
      // 停用而不是继续重试：连续失败通常意味着配置坏了（模型没了、key 过期），
      // 再排下去只会每隔两分钟失败一次，第二天早上你看到一堆红字还没有一次是成功的
      await patch(id, {
        lastStatus: 'fail',
        lastError: `连续 ${fails} 次失败，已自动停用：${message}`,
        consecutiveFails: fails,
        enabled: false,
        nextRunAt: undefined,
        ...(failedSession ? { lastSessionId: failedSession } : {})
      })
      // 通知只在这条路径上发一次：前两次失败各自有失败通知，第三次要明确「已经停了」
      try {
        run.disabled?.({ ...routine, enabled: false, consecutiveFails: fails, lastError: message })
      } catch {
        // 通知失败不该影响调度器
      }
      return { ok: false, error: message, ...(failedSession ? { sessionId: failedSession } : {}) }
    }

    await patch(id, {
      lastStatus: 'fail',
      lastError: message,
      consecutiveFails: fails,
      ...(failedSession ? { lastSessionId: failedSession } : {}),
      // 自动调度失败：两分钟后再试一次，而不是等到下一个排期（可能是明天）
      nextRunAt: opts.auto
        ? Date.now() + RETRY_MS
        : (nextRunFor(routine.trigger, Date.now()) ?? undefined)
    })
    return { ok: false, error: message, ...(failedSession ? { sessionId: failedSession } : {}) }
  }
}

/** 走一遍表：到期就跑，没到期就跳过。返回这一轮跑了哪几个，方便测试和日志 */
export async function tick(now = Date.now()): Promise<string[]> {
  const run = runner
  if (ticking || !run) return []
  ticking = true
  const ran: string[] = []
  try {
    const list = await listRoutines()
    for (const routine of list) {
      if (!routine.enabled) continue
      // 第一次见到这条任务（刚建 / 刚升级）：只记时间，不补跑
      if (!routine.nextRunAt) {
        await patch(routine.id, { nextRunAt: nextRunFor(routine.trigger, now) ?? undefined })
        continue
      }
      if (routine.nextRunAt > now) continue

      const late = now - routine.nextRunAt
      if (late > STALE_MS) {
        await patch(routine.id, {
          nextRunAt: nextRunFor(routine.trigger, now) ?? undefined,
          lastStatus: 'skipped',
          lastError: '错过太久，已跳过这一轮'
        })
        continue
      }
      if (run.busy?.()) {
        // 还在等：留着 nextRunAt，下个 tick 再看
        if (late < WAIT_MS) continue
        await patch(routine.id, {
          nextRunAt: nextRunFor(routine.trigger, now) ?? undefined,
          lastStatus: 'skipped',
          lastError: '上一条任务一直占着，已跳过这一轮'
        })
        continue
      }
      await runRoutine(routine.id, { auto: true })
      ran.push(routine.id)
    }
  } catch {
    // 调度器自己不能把主进程搞崩：这一轮失败，下一轮接着看
  } finally {
    ticking = false
  }
  return ran
}

export function startScheduler(r: RoutineRunner): void {
  runner = r
  if (timer) return
  // 启动 10 秒后再看第一次：把开机时的模型加载、配置读取让过去
  setTimeout(() => void tick(), 10_000).unref?.()
  timer = setInterval(() => void tick(), TICK_MS)
  timer.unref?.()
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
  runner = null
}

/** 供测试/诊断：调度器现在是否已接上 */
export function schedulerAttached(): boolean {
  return runner !== null
}
