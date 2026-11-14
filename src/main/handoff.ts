/**
 * 交接（handoff）的落盘与调度。
 *
 * 和 routines 是同一套打法的第二个入口：
 * **一条交接 = 建一个普通会话 + 排队发一条消息**。所以它同样有历史、有 diff、
 * 有 checkpoint、能重跑能删 —— 用户点进去看到的是现场，不是一个后台黑盒。
 *
 * 为什么要排队而不是立刻跑：
 * 1. 交接是在一次运行的工具调用里发生的，此刻模型正被占着；再起一条就是两个长任务抢同一份服务。
 * 2. 交出去之后父 agent 还没说完话，立刻并发会让两边同时改同一片文件。
 * 所以这里只入队，由 pump 在引擎空闲时按先后顺序放行，一次一条。
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { Handoff, HandoffResult } from '../shared/types'
import { MAX_HANDOFF_DEPTH, MAX_PER_SESSION, buildHandoffPrompt, handoffTitle } from '../shared/handoff'
import { getAgent } from './agents'
import * as store from './store'

const FILE = 'handoffs.json'
/** 15 秒看一次队列：交接不像 cron 有分钟级精度要求，但这个延迟要让人察觉不到 */
const PUMP_MS = 15_000
/** 只留最近这么多条记录，避免文件无限长；未完成的不会被裁掉 */
const KEEP = 120

export interface HandoffRunner {
  /** 引擎是否还有会话在跑：本地一份模型服务，不让两条交接抢 */
  busy(): boolean
  /**
   * 真正去发那条消息。抛错表示这次交接失败。
   * 返回回执（结论 / token / 改了哪些文件）；拿不到就返回 undefined，
   * 只是面板上少一行字，不影响交接本身算成功。
   */
  launch(handoff: Handoff, sessionId: string): Promise<HandoffResult | undefined>
}

let runner: HandoffRunner | null = null
let timer: NodeJS.Timeout | null = null
let cache: Handoff[] | null = null
let pumping = false
/** 所有落盘都排在同一条链上：交接和 pump 会同时改这个文件，交叉写会把记录冲掉 */
let chain: Promise<unknown> = Promise.resolve()

export function handoffsPath(): string {
  return path.join(app.getPath('userData'), FILE)
}

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  // 前一次失败不能污染后面的队列，所以这里吞掉异常，只把真实结果往上传
  chain = next.catch(() => undefined)
  return next
}

function normalizeResult(raw: unknown): HandoffResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const t = (r.tokens ?? {}) as Record<string, unknown>
  const files = Array.isArray(r.files) ? r.files.map((f) => String(f)).filter(Boolean).slice(0, 20) : []
  return {
    status: r.status === 'fail' ? 'fail' : 'ok',
    summary: String(r.summary ?? '').slice(0, 300),
    tokens: {
      prompt: Math.max(0, Math.floor(Number(t.prompt) || 0)),
      completion: Math.max(0, Math.floor(Number(t.completion) || 0))
    },
    ...(files.length ? { files } : {}),
    at: Number(r.at) || Date.now()
  }
}

function normalize(raw: unknown): Handoff | null {
  const r = (raw ?? {}) as Record<string, unknown>
  const id = String(r.id ?? '').trim()
  const toAgentId = String(r.toAgentId ?? '').trim()
  const task = String(r.task ?? '').trim()
  if (!id || !toAgentId || !task) return null
  const status = r.status
  const ok: Handoff['status'][] = ['pending', 'running', 'ok', 'fail', 'canceled']
  const result = normalizeResult(r.result)
  return {
    id,
    createdAt: Number(r.createdAt) || Date.now(),
    fromAgentId: r.fromAgentId ? String(r.fromAgentId) : null,
    fromName: r.fromName ? String(r.fromName) : null,
    fromSessionId: r.fromSessionId ? String(r.fromSessionId) : null,
    toAgentId,
    toName: r.toName ? String(r.toName) : null,
    task: task.slice(0, 2000),
    context: r.context ? String(r.context).slice(0, 6000) : undefined,
    files: Array.isArray(r.files) ? r.files.map((f) => String(f)).filter(Boolean).slice(0, 30) : undefined,
    depth: Math.max(0, Math.floor(Number(r.depth) || 0)),
    approvalPolicy: r.approvalPolicy === 'allow' ? 'allow' : 'deny',
    workspace: r.workspace ? String(r.workspace) : null,
    sessionId: r.sessionId ? String(r.sessionId) : null,
    status: ok.includes(status as Handoff['status']) ? (status as Handoff['status']) : 'pending',
    startedAt: r.startedAt ? Number(r.startedAt) : undefined,
    finishedAt: r.finishedAt ? Number(r.finishedAt) : undefined,
    error: r.error ? String(r.error).slice(0, 500) : undefined,
    ...(result ? { result } : {})
  }
}

async function readAll(): Promise<Handoff[]> {
  if (!cache) {
    try {
      const text = await fs.readFile(handoffsPath(), 'utf8')
      const parsed = JSON.parse(text)
      const list = Array.isArray(parsed) ? parsed : (parsed?.items ?? [])
      cache = (Array.isArray(list) ? list : []).map(normalize).filter((h): h is Handoff => h !== null)
    } catch {
      cache = []
    }
    // 上次退出时还在跑的，一定没跑完：标成失败，否则界面上会挂一条永远转圈的记录
    let dirty = false
    cache = cache.map((h) => {
      if (h.status !== 'running') return h
      dirty = true
      const why = h.error ?? '程序退出时还没跑完'
      return {
        ...h,
        status: 'fail' as const,
        finishedAt: Date.now(),
        error: why,
        result: { status: 'fail' as const, summary: why, tokens: { prompt: 0, completion: 0 }, at: Date.now() }
      }
    })
    if (dirty) await writeAll(cache)
  }
  return cache
}

async function writeAll(list: Handoff[]): Promise<void> {
  const finished = list
    .filter((h) => h.status === 'ok' || h.status === 'fail' || h.status === 'canceled')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, KEEP)
  const unfinished = list.filter((h) => h.status === 'pending' || h.status === 'running')
  const keep = [...unfinished, ...finished].sort((a, b) => b.createdAt - a.createdAt)
  cache = keep
  const file = handoffsPath()
  await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => undefined)
  // 先写临时文件再改名：写到一半断电不会留下半个 JSON，把整份历史弄丢
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(keep, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

async function patch(id: string, changes: Partial<Handoff>): Promise<Handoff | null> {
  const list = await readAll()
  let updated: Handoff | null = null
  const next = list.map((h) => {
    if (h.id !== id) return h
    updated = { ...h, ...changes }
    return updated
  })
  if (updated) await writeAll(next)
  return updated
}

export async function listHandoffs(): Promise<Handoff[]> {
  const list = await readAll()
  return [...list].sort((a, b) => b.createdAt - a.createdAt)
}

export interface HandoffRequest {
  fromAgentId?: string | null
  fromName?: string | null
  fromSessionId?: string | null
  toAgentId: string
  task: string
  context?: string
  files?: string[]
  workspace?: string | null
  approvalPolicy?: 'deny' | 'allow'
}

/**
 * 入队一条交接，并把承载它的会话先建出来。
 *
 * 会话立刻建而不是等 pump：用户要在侧栏马上看见「哦，它把活交出去了」，
 * 而不是等几十秒后突然冒出一条会话。
 */
export async function enqueueHandoff(req: HandoffRequest): Promise<Handoff> {
  const task = String(req.task ?? '').replace(/\r\n/g, '\n').trim().slice(0, 2000)
  if (!task) throw new Error('交接要说清让对方做什么')

  const target = await getAgent(String(req.toAgentId ?? '').trim())
  if (!target) throw new Error('没有这个档案')

  const fromAgentId = req.fromAgentId || null
  if (fromAgentId && fromAgentId === target.id) {
    // 同一份提示词、同一份记忆、同一套工具，交给它自己等于开一个普通子任务
    throw new Error('交给同一个档案没有意义：改用 task 派子 agent')
  }

  return await serialize(async () => {
    const list = await readAll()
    const from = req.fromSessionId ?? null
    const mine = list.filter((h) => h.fromSessionId === from && h.status !== 'canceled')
    // 校验在开会话之前：被拒的交接不该在侧栏留下一条空壳，也不该占回收站
    if (mine.length >= MAX_PER_SESSION) {
      throw new Error(`同一个会话最多交出去 ${MAX_PER_SESSION} 件，先等它们跑完`)
    }
    const parent = from ? list.find((h) => h.sessionId === from) : undefined
    // 用户自己开的会话交出去算第一手（0）；从一条交接会话继续往下传才算加一手
    const depth = parent ? parent.depth + 1 : 0
    if (depth >= MAX_HANDOFF_DEPTH) {
      throw new Error('交接链路太长了：这件活就地做完，不要再往下传')
    }

    const created = await store.createSession(
      target.workspace ?? req.workspace ?? null,
      target.id,
      target.modelId ?? null
    )
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
    await store
      .renameSession(created.id, `${handoffTitle(target.name, task)} · ${stamp}`)
      .catch(() => undefined)

    const rec: Handoff = {
      id: `handoff_${randomBytes(4).toString('hex')}`,
      createdAt: Date.now(),
      fromAgentId,
      fromName: req.fromName ?? null,
      fromSessionId: from,
      toAgentId: target.id,
      toName: target.name,
      task,
      context: req.context?.trim() ? req.context.trim().slice(0, 6000) : undefined,
      files: req.files?.length ? req.files.slice(0, 30) : undefined,
      depth,
      // 权限只往下传，不往上加：普通会话（没有明确 allow）交出去的活一律只读
      approvalPolicy: req.approvalPolicy === 'allow' ? 'allow' : 'deny',
      workspace: target.workspace ?? req.workspace ?? null,
      sessionId: created.id,
      status: 'pending'
    }
    await writeAll([rec, ...list])
    return rec
  })
}

/** 接手方看到的提示词：把档案的岗位说明一并带上，让它按自己的职责开工 */
export async function handoffPrompt(h: Handoff): Promise<string> {
  const agent = await getAgent(h.toAgentId)
  return buildHandoffPrompt({
    fromName: h.fromName,
    toName: agent?.name ?? h.toName ?? '接手方',
    toRole: agent?.role ?? null,
    task: h.task,
    context: h.context ?? null,
    files: h.files ?? null,
    canWrite: h.approvalPolicy === 'allow'
  })
}

/**
 * 放行一条交接。空闲才跑，一次一条。
 * 返回本次真正启动的交接 id，便于测试与日志。
 */
export async function pumpHandoffs(): Promise<string[]> {
  if (pumping || !runner) return []
  pumping = true
  const started: string[] = []
  try {
    if (runner.busy()) return started
    const next = (await readAll())
      .filter((h) => h.status === 'pending' && h.sessionId)
      .sort((a, b) => a.createdAt - b.createdAt)[0]
    if (!next || !next.sessionId) return started

    await patch(next.id, { status: 'running', startedAt: Date.now(), error: undefined, result: undefined })
    started.push(next.id)
    try {
      const result = await runner.launch(next, next.sessionId)
      await patch(next.id, {
        status: 'ok',
        finishedAt: Date.now(),
        // 拿不到回执也要标 ok：会话跑完了就是跑完了，不能因为统计不到 token 说它失败
        ...(result ? { result } : {})
      })
    } catch (err) {
      const message = (err as Error).message || '交接没跑起来'
      await patch(next.id, {
        status: 'fail',
        finishedAt: Date.now(),
        error: message,
        // 失败也要有回执：接手方挂在哪一步，比「失败了」三个字有用得多
        result: { status: 'fail', summary: message, tokens: { prompt: 0, completion: 0 }, at: Date.now() }
      })
    }
  } catch {
    // pump 自己不能把主进程搞崩：这一轮失败，下一轮接着看
  } finally {
    pumping = false
  }
  return started
}

/** 手动跑一条：失败/取消的重新排队，然后立刻返回，不阻塞调用方 */
export async function runHandoff(id: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const list = await readAll()
  const target = list.find((h) => h.id === id)
  if (!target) return { ok: false, error: '没有这条交接' }
  if (!target.sessionId) return { ok: false, error: '这条交接没有承载会话' }
  if (!runner) return { ok: false, error: '调度器还没启动' }
  if (target.status === 'running') return { ok: false, error: '它正在跑' }

  await patch(id, { status: 'pending', error: undefined, finishedAt: undefined })
  // 一次真实交接可能跑几分钟，IPC/HTTP 不能等它跑完才返回；
  // 状态变化会通过 handoffs:changed 推回界面
  if (!runner.busy()) void pumpHandoffs()
  return { ok: true, sessionId: target.sessionId }
}

export async function cancelHandoff(id: string): Promise<{ ok: boolean }> {
  const list = await readAll()
  const target = list.find((h) => h.id === id)
  // 只取消还在排队的：跑起来的那条已经在改文件了，中途掐掉会留下半成品
  if (!target || target.status !== 'pending') return { ok: false }
  await patch(id, { status: 'canceled', finishedAt: Date.now() })
  // 取消掉的交接不该在侧栏留一条空会话：直接进回收站，用户还能恢复
  if (target.sessionId) await store.removeSession(target.sessionId).catch(() => undefined)
  return { ok: true }
}

export function startHandoffPump(r: HandoffRunner): void {
  runner = r
  if (timer) return
  // 起晚一点：开机时模型还在加载，这时候放行只会失败一次
  setTimeout(() => void pumpHandoffs(), 8_000).unref?.()
  timer = setInterval(() => void pumpHandoffs(), PUMP_MS)
  timer.unref?.()
}

export function stopHandoffPump(): void {
  if (timer) clearInterval(timer)
  timer = null
  runner = null
}

/** 供测试/诊断 */
export function pumpAttached(): boolean {
  return runner !== null
}
