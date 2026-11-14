import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ChatMessage, Session, SessionHit, SessionMeta, TokenUsage, TrashEntry } from '../shared/types'
import { titleAfterTurnDelete, trimDanglingTail, turnRangeOf } from '../shared/turns'
import { searchHit } from '../shared/sessionhit'

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

function dir(): string {
  return path.join(app.getPath('userData'), 'sessions')
}

function fileOf(id: string): string {
  if (!/^[a-z0-9-]{6,64}$/i.test(id)) throw new Error('非法的会话 ID')
  return path.join(dir(), `${id}.json`)
}

export function newId(): string {
  return crypto.randomUUID()
}

export async function listSessions(): Promise<SessionMeta[]> {
  await fs.mkdir(dir(), { recursive: true })
  const names = await fs.readdir(dir())
  const out: SessionMeta[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(path.join(dir(), name), 'utf8')
      const s = JSON.parse(raw) as Session
      // 没有 id 的文件定位不到、点开也是空白，直接跳过；title 缺失给个占位
      if (!s || typeof s.id !== 'string' || !s.id) continue
      out.push({
        id: s.id,
        title: typeof s.title === 'string' && s.title ? s.title : '未命名会话',
        workspace: s.workspace ?? null,
        modelId: s.modelId ?? null,
        modelOverride: s.modelOverride ?? null,
        agentId: s.agentId ?? null,
        modeOverride: s.modeOverride ?? null,
        plan: s.plan ?? null,
        ...(s.forkedFrom ? { forkedFrom: s.forkedFrom } : {}),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt
      })
    } catch {
      // 损坏的会话文件直接跳过，不影响其他会话
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 新建会话。agentId 一旦写入就不再变：记忆命名空间和工具白名单都跟着它走，
 * 中途换档案等于换人，历史会变得没法解释。
 */
export async function createSession(
  workspace: string | null = null,
  agentId: string | null = null,
  modelId: string | null = null
): Promise<Session> {
  const now = Date.now()
  const session: Session = {
    id: newId(),
    title: '新会话',
    workspace,
    ...(agentId ? { agentId } : {}),
    ...(modelId ? { modelId } : {}),
    createdAt: now,
    updatedAt: now,
    messages: []
  }
  await persist(session)
  return session
}

/**
 * 从某个会话分叉出一条新会话：把切点之前的历史原样带过去，原会话一个字不动。
 *
 * 用它的场景和「编辑重发」不一样：重发是把当前这条路改掉（后面的回答全丢），
 * 分叉是「这条路先留着，我从这儿试着走另一条」。所以两条会话之后完全独立，
 * 删哪边都不影响另一边。
 *
 * messageId 省略表示复制整段历史。切点落在「助手喊了工具、结果还没回来」的位置时，
 * 尾部那几条会被剪掉 —— 带着没有结果的 tool_calls 的会话，下次请求必然 400。
 */
export async function forkSession(id: string, messageId?: string | null): Promise<Session> {
  const src = await loadSession(id)
  let cut = src.messages.length
  if (messageId) {
    const i = src.messages.findIndex((m) => m.id === messageId)
    if (i < 0) throw new Error('这条消息不在会话里，可能刚被删掉')
    cut = i + 1
  }
  const messages = trimDanglingTail(src.messages.slice(0, cut))
  if (messages.length === 0) throw new Error('这条消息之前没有内容，分不出新会话')

  const now = Date.now()
  const fork: Session = {
    id: newId(),
    title: `${src.title.replace(/\s+/g, ' ').trim() || '新会话'} · 分叉`,
    workspace: src.workspace ?? null,
    ...(src.agentId ? { agentId: src.agentId } : {}),
    ...(src.modelId ? { modelId: src.modelId } : {}),
    ...(src.modelOverride ? { modelOverride: src.modelOverride } : {}),
    forkedFrom: src.id,
    createdAt: now,
    updatedAt: now,
    // 消息 id 原样保留：它只在会话内部用于定位（删除某一轮、编辑重发），
    // 换新 id 反而会让「分叉后立刻删某一轮」这类操作的引用对不上
    messages
  }
  await persist(fork)
  return fork
}

export async function setSessionWorkspace(id: string, workspace: string | null): Promise<void> {
  const session = await loadSession(id)
  if ((session.workspace ?? null) === workspace) return
  session.workspace = workspace
  session.updatedAt = Date.now()
  await persist(session)
}

/** 给会话绑定一个模型（providerId）。传 null 表示跟随全局 activeId */
export async function setSessionModel(id: string, modelId: string | null): Promise<void> {
  const session = await loadSession(id)
  session.modelId = modelId
  session.updatedAt = Date.now()
  await persist(session)
}

/**
 * 在同一家供应商里换具体模型名。
 * 和 setSessionModel 分开：切供应商要顺带重启本地服务，
 * 只换模型名不用动进程（llama-server 支持按请求切已加载的模型时更省事）。
 */
export async function setSessionModelOverride(id: string, model: string | null): Promise<void> {
  const session = await loadSession(id)
  const next = (model ?? '').trim()
  session.modelOverride = next || null
  session.updatedAt = Date.now()
  await persist(session)
}

/** 切换会话模式：plan 只读出方案，build 正常执行，null 跟随全局 */
export async function setSessionMode(id: string, mode: 'plan' | 'build' | null): Promise<void> {
  const session = await loadSession(id)
  session.modeOverride = mode
  session.updatedAt = Date.now()
  await persist(session)
}

/** 记下计划模式下产出的方案（批准前不影响权限） */
export async function saveSessionPlan(id: string, text: string, steps: string[]): Promise<void> {
  const session = await loadSession(id)
  session.plan = { text, steps, at: Date.now(), approved: false }
  session.updatedAt = Date.now()
  await persist(session)
}

/**
 * 批准计划：把会话切成 build，并记下批准时间。
 * 返回更新后的会话，调用方据此接着跑一轮「按计划执行」。
 */
export async function approveSessionPlan(id: string): Promise<Session> {
  const session = await loadSession(id)
  if (!session.plan) throw new Error('这个会话还没有计划')
  session.plan = { ...session.plan, approved: true, approvedAt: Date.now() }
  session.modeOverride = 'build'
  session.updatedAt = Date.now()
  await persist(session)
  return session
}

/** 旧版本会话没有 workspace 字段，统一归入当前工作区，避免全部落进“未指定”分组 */export async function adoptOrphanSessions(workspace: string | null): Promise<void> {
  if (!workspace) return
  await fs.mkdir(dir(), { recursive: true })
  const names = await fs.readdir(dir())
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const file = path.join(dir(), name)
      const s = JSON.parse(await fs.readFile(file, 'utf8')) as Session
      if (s.workspace) continue
      s.workspace = workspace
      await fs.writeFile(file, JSON.stringify(s, null, 2), 'utf8')
    } catch {
      // 损坏文件跳过
    }
  }
}

export async function loadSession(id: string): Promise<Session> {
  const raw = await fs.readFile(fileOf(id), 'utf8')
  const session = JSON.parse(raw) as Session
  /**
   * 老版本写下的会话文件、或被手工改坏的文件可能没有 messages / title。
   * 后面到处是 `session.messages.push(...)`、`session.title.slice(...)`，
   * 一个 undefined 就让整个操作炸掉，而用户看到的只是「这个会话打不开」。
   * 在读入口补齐一次，比在每个调用点做防御便宜得多。
   */
  if (!Array.isArray(session.messages)) session.messages = []
  if (typeof session.title !== 'string') session.title = '未命名会话'
  return session
}

/**
 * 删除会话：移进 sessions/.trash/ 而不是直接抹掉。
 * 误点一次「×」就丢掉整段对话是最容易发生、也最伤用户的失误，
 * 所以默认保留 7 天，期间可以恢复。
 */
export async function removeSession(id: string): Promise<void> {
  await fs.mkdir(trashDir(), { recursive: true })
  const dest = path.join(trashDir(), `${id}.${Date.now()}.json`)
  try {
    await fs.rename(fileOf(id), dest)
  } catch {
    // 跨设备 / 被占用时 rename 会失败，退化成复制后删除
    await fs.copyFile(fileOf(id), dest)
    await fs.rm(fileOf(id), { force: true })
  }
}

function trashDir(): string {
  return path.join(dir(), '.trash')
}

/** 回收站保留天数 */
export const TRASH_KEEP_DAYS = 7

/**
 * 会话清理的两道闸。
 *
 * 没有上限的话，sessions/ 只会一直涨：每个会话一个 JSON，listSessions() 还要把
 * 每个文件整段读出来解析（只为拿标题和更新时间），几百个会话之后每次开侧栏都要
 * 读几十兆。清得太狠又会删掉用户还想翻的旧对话 —— 所以两条**同时**满足才动：
 * 既不在「最近 300 个」里，又超过 180 天没被动过。
 *
 * 而且不是真删：走 removeSession 进回收站，7 天内还能恢复。
 * 正常用户永远碰不到这条线，它只在长期重度使用后才起作用。
 */
export const SESSION_KEEP_MAX = 300
export const SESSION_KEEP_DAYS = 180

export interface SessionFileEntry {
  id: string
  mtime: number
  size: number
}

export interface SessionPruneStats {
  scanned: number
  archived: number
  kept: number
  archivedBytes: number
}

/**
 * 挑出该归档的会话（纯函数，可单测）。
 * 排序按 mtime 倒序，前 max 个一律不动 —— 那是最可能被翻回去的一批。
 */
export function pickPrunable(
  files: SessionFileEntry[],
  opts: { max: number; maxAgeDays: number; now?: number }
): SessionFileEntry[] {
  const now = opts.now ?? Date.now()
  const max = Math.max(20, Math.floor(opts.max))
  const maxAgeDays = Math.max(7, opts.maxAgeDays)
  const cutoff = now - maxAgeDays * 864e5
  // 刚动过的（10 分钟内）绝不碰：可能正在写
  const active = now - 10 * 60 * 1000
  const sorted = [...files].sort((a, b) => b.mtime - a.mtime)
  const out: SessionFileEntry[] = []
  for (let i = 0; i < sorted.length; i++) {
    if (i < max) continue
    const f = sorted[i]
    if (f.mtime >= cutoff || f.mtime >= active) continue
    out.push(f)
  }
  return out
}

/**
 * 执行一次清理。只 stat 不 parse：判断只需要时间戳和体积，
 * 把每个 JSON 都读出来解析反而会让「为了变快而做的清理」自己变慢。
 */
export async function pruneSessions(
  opts: { max?: number; maxAgeDays?: number } = {}
): Promise<SessionPruneStats> {
  const names = await fs.readdir(dir()).catch(() => [] as string[])
  const files: SessionFileEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const full = path.join(dir(), name)
    const st = await fs.stat(full).catch(() => null)
    if (!st) continue
    files.push({ id: name.slice(0, -5), mtime: st.mtimeMs, size: st.size })
  }

  const targets = pickPrunable(files, {
    max: opts.max ?? SESSION_KEEP_MAX,
    maxAgeDays: opts.maxAgeDays ?? SESSION_KEEP_DAYS
  })

  let archived = 0
  let archivedBytes = 0
  for (const t of targets) {
    try {
      await removeSession(t.id)
      archived++
      archivedBytes += t.size
    } catch {
      // 单个失败（被占用、权限）不影响其他
    }
  }

  return { scanned: files.length, archived, kept: files.length - archived, archivedBytes }
}

/** 回收站文件名：<会话id>.<时间戳>.json，两个字段都要校验，防止路径穿越 */
function parseTrashName(name: string): { id: string; deletedAt: number } | null {
  const m = /^([a-z0-9-]{6,64})\.(\d{10,16})\.json$/i.exec(name)
  if (!m) return null
  return { id: m[1], deletedAt: Number(m[2]) }
}

function trashPath(name: string): string {
  if (!parseTrashName(name)) throw new Error('非法的回收站文件名')
  return path.join(trashDir(), name)
}

export async function listTrash(): Promise<TrashEntry[]> {
  await fs.mkdir(trashDir(), { recursive: true })
  const names = await fs.readdir(trashDir())
  const out: TrashEntry[] = []
  for (const name of names) {
    const meta = parseTrashName(name)
    if (!meta) continue
    try {
      const s = JSON.parse(await fs.readFile(path.join(trashDir(), name), 'utf8')) as Session
      out.push({
        file: name,
        id: meta.id,
        title: s.title || '未命名会话',
        workspace: s.workspace ?? null,
        deletedAt: meta.deletedAt,
        messages: s.messages?.length ?? 0
      })
    } catch {
      // 文件坏了也照样列出来，用户至少能看到并手动清掉
      out.push({
        file: name,
        id: meta.id,
        title: '（文件已损坏）',
        workspace: null,
        deletedAt: meta.deletedAt,
        messages: 0
      })
    }
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt)
}

/** 从回收站恢复，返回会话 id */
export async function restoreSession(file: string): Promise<string> {
  const src = trashPath(file)
  const meta = parseTrashName(file)
  if (!meta) throw new Error('非法的回收站文件名')
  await fs.mkdir(dir(), { recursive: true })
  const dest = fileOf(meta.id)
  // 恢复目标已存在时不能覆盖：那可能是一个新建的同 id 会话（理论上不该出现）
  if (await exists(dest)) throw new Error('同名会话已存在，无法恢复')
  await fs.rename(src, dest)
  return meta.id
}

/** 永久删除回收站里的某一条 */
export async function purgeTrashFile(file: string): Promise<string> {
  const meta = parseTrashName(file)
  if (!meta) throw new Error('非法的回收站文件名')
  await fs.rm(trashPath(file), { force: true })
  return meta.id
}

/**
 * 清掉超过保留期的回收站文件，返回被清掉的会话 id（调用方用来连带清理改动快照）。
 * 启动时跑一次，不设常驻定时器：这东西一天清一次和启动时清一次没区别。
 */
export async function purgeTrash(maxAgeMs = TRASH_KEEP_DAYS * 864e5): Promise<string[]> {
  await fs.mkdir(trashDir(), { recursive: true })
  const names = await fs.readdir(trashDir())
  const now = Date.now()
  const purged: string[] = []
  for (const name of names) {
    const meta = parseTrashName(name)
    if (!meta) continue
    if (now - meta.deletedAt < maxAgeMs) continue
    try {
      await fs.rm(path.join(trashDir(), name), { force: true })
      purged.push(meta.id)
    } catch {
      // 删不掉就先留着，下次启动再试
    }
  }
  return purged
}

/**
 * 清空整个回收站：用户在设置里明确点了「全部删除」。
 *
 * 故意不复用 purgeTrash(0)：那个函数是「按保留期自动清理」，语义是到点才删；
 * 这里是用户当场要求永久删除，两条路径分开写，日后改保留期也不会误伤这个入口。
 * 返回被删掉的会话 id，调用方用来连带清理改动快照。
 */
export async function purgeAllTrash(): Promise<string[]> {
  await fs.mkdir(trashDir(), { recursive: true })
  const names = await fs.readdir(trashDir())
  const purged: string[] = []
  for (const name of names) {
    const meta = parseTrashName(name)
    if (!meta) continue
    try {
      await fs.rm(path.join(trashDir(), name), { force: true })
      purged.push(meta.id)
    } catch {
      // 被占用就先留着：下次点「全部删除」还会再试，别让一条卡住整批
    }
  }
  return purged
}

export async function renameSession(id: string, title: string): Promise<void> {
  const session = await loadSession(id)
  session.title = title.slice(0, 60)
  session.updatedAt = Date.now()
  await persist(session)
}

export async function appendMessages(id: string, messages: ChatMessage[]): Promise<Session> {
  const session = await loadSession(id)
  session.messages.push(...messages)
  session.updatedAt = Date.now()
  if (session.title === '新会话') {
    const firstUser = session.messages.find((m) => m.role === 'user')
    if (firstUser) session.title = firstUser.content.replace(/\s+/g, ' ').slice(0, 40) || '新会话'
  }
  await persist(session)
  return session
}

export async function persist(session: Session): Promise<void> {
  await fs.mkdir(dir(), { recursive: true })
  const tmp = `${fileOf(session.id)}.tmp`
  await fs.writeFile(tmp, JSON.stringify(session, null, 2), 'utf8')
  await fs.rename(tmp, fileOf(session.id))
}

/** 累加一次调用的用量，返回累计值（会话标题栏 / 状态栏显示用） */
export async function bumpUsage(id: string, delta: TokenUsage): Promise<TokenUsage> {
  const session = await loadSession(id)
  const cur = session.usage ?? { prompt: 0, completion: 0 }
  const next: TokenUsage = {
    prompt: cur.prompt + delta.prompt,
    completion: cur.completion + delta.completion,
    cached: (cur.cached ?? 0) + (delta.cached ?? 0),
    costUsd: (cur.costUsd ?? 0) + (delta.costUsd ?? 0)
  }
  session.usage = next
  await persist(session)
  return next
}

/** 从某条消息起全部丢掉（重新生成 / 编辑重发用） */
export async function truncateFrom(id: string, messageId: string): Promise<Session> {
  const session = await loadSession(id)
  const idx = session.messages.findIndex((m) => m.id === messageId)
  if (idx >= 0) session.messages = session.messages.slice(0, idx)
  session.updatedAt = Date.now()
  await persist(session)
  return session
}

/**
 * 删掉某条消息所在的一整轮对话，返回更新后的会话和被删掉的消息。
 *
 * 只做落盘，不动内存里的摘要缓存 —— 那个由 AgentEngine.forgetSummary() 负责，
 * 调用方（IPC handler）必须紧接着调一次，否则按索引记的 upTo 会指向错误位置。
 */
export async function deleteTurn(
  id: string,
  messageId: string
): Promise<{ session: Session; removed: ChatMessage[] }> {
  const session = await loadSession(id)
  const range = turnRangeOf(session.messages, messageId)
  if (!range) throw new Error('找不到这条消息，它可能已经被删掉了')
  const removed = session.messages.slice(range.start, range.end)
  if (!removed.length) throw new Error('没有可删除的消息')
  session.messages = [
    ...session.messages.slice(0, range.start),
    ...session.messages.slice(range.end)
  ]
  if (range.start === 0) {
    session.title = titleAfterTurnDelete(session.title, removed, session.messages)
  }
  session.updatedAt = Date.now()
  await persist(session)
  return { session, removed }
}

/** 丢掉最后一条 assistant 及其之后的工具消息 */
export async function dropLastTurn(id: string): Promise<Session> {
  const session = await loadSession(id)
  let idx = -1
  for (let i = session.messages.length - 1; i >= 0; i--) {
    if (session.messages[i].role === 'assistant') {
      idx = i
      break
    }
  }
  session.messages = idx >= 0 ? session.messages.slice(0, idx) : session.messages
  session.updatedAt = Date.now()
  await persist(session)
  return session
}

export async function updateMessage(
  id: string,
  messageId: string,
  patch: Partial<ChatMessage>
): Promise<Session> {
  const session = await loadSession(id)
  const idx = session.messages.findIndex((m) => m.id === messageId)
  if (idx >= 0) session.messages[idx] = { ...session.messages[idx], ...patch }
  session.updatedAt = Date.now()
  await persist(session)
  return session
}

/** 在标题和正文里找关键词，返回带片段的命中列表 */
export async function searchSessions(query: string): Promise<SessionHit[]> {
  /**
   * IPC 边界没有类型保证：渲染层传 undefined（清空搜索框、旧版界面）时
   * `query.trim()` 直接抛 TypeError，用户看到的是搜索框报错而不是空结果。
   */
  const q = String(query ?? '').trim()
  if (!q) return []
  await fs.mkdir(dir(), { recursive: true })
  const names = await fs.readdir(dir())
  const out: SessionHit[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      // 判定逻辑在 shared/sessionhit：那边对缺失字段做类型检查，不会因为
      // 一个没有 title 的老会话就把整条记录从搜索结果里丢掉
      const hit = searchHit(JSON.parse(await fs.readFile(path.join(dir(), name), 'utf8')), q)
      if (hit) out.push(hit)
    } catch {
      // 损坏文件跳过
    }
  }
  return out.sort((a, b) => b.hits - a.hits || b.updatedAt - a.updatedAt).slice(0, 30)
}
