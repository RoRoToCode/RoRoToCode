import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ChatMessage, Session, SessionHit, SessionMeta, TokenUsage, TrashEntry } from '../shared/types'
import { titleAfterTurnDelete, turnRangeOf } from '../shared/turns'

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
      out.push({
        id: s.id,
        title: s.title,
        workspace: s.workspace ?? null,
        modelId: s.modelId ?? null,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt
      })
    } catch {
      // 损坏的会话文件直接跳过，不影响其他会话
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function createSession(workspace: string | null = null): Promise<Session> {
  const now = Date.now()
  const session: Session = {
    id: newId(),
    title: '新会话',
    workspace,
    createdAt: now,
    updatedAt: now,
    messages: []
  }
  await persist(session)
  return session
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

/** 旧版本会话没有 workspace 字段，统一归入当前工作区，避免全部落进“未指定”分组 */
export async function adoptOrphanSessions(workspace: string | null): Promise<void> {
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
  return JSON.parse(raw) as Session
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
  const q = query.trim().toLowerCase()
  if (!q) return []
  await fs.mkdir(dir(), { recursive: true })
  const names = await fs.readdir(dir())
  const out: SessionHit[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const s = JSON.parse(await fs.readFile(path.join(dir(), name), 'utf8')) as Session
      let count = 0
      let snippet = ''
      if (s.title.toLowerCase().includes(q)) {
        count++
        snippet = s.title
      }
      for (const m of s.messages) {
        const idx = (m.content ?? '').toLowerCase().indexOf(q)
        if (idx < 0) continue
        count++
        if (!snippet) {
          const start = Math.max(0, idx - 24)
          snippet = `${start > 0 ? '…' : ''}${m.content.slice(start, idx + q.length + 34).replace(/\s+/g, ' ')}`
        }
      }
      if (!count) continue
      out.push({
        id: s.id,
        title: s.title,
        workspace: s.workspace ?? null,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        snippet,
        hits: count
      })
    } catch {
      // 损坏文件跳过
    }
  }
  return out.sort((a, b) => b.hits - a.hits || b.updatedAt - a.updatedAt).slice(0, 30)
}
