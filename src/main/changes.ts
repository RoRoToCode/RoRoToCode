import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ChangeDetail, FileChange, DiffLine } from '../shared/types'
import { diffLines, diffStats } from './diff'

/**
 * 每次 write_file / edit_file 都把「改前」和「改后」存下来。
 * 一个改动一个 JSON，撤销时把 before 写回去；新建的文件撤销就是删掉。
 * 存不下（超大文件）就只记统计，标注不可撤销，至少不把内存撑爆。
 */
const MAX_SNAPSHOT = 512 * 1024

interface ChangeRecord extends FileChange {
  before: string
  after: string
  revertable: boolean
  reverted?: boolean
}

function dirOf(sessionId: string): string {
  return path.join(app.getPath('userData'), 'changes', sessionId.replace(/[^\w-]/g, ''))
}

function fileOf(sessionId: string, id: string): string {
  return path.join(dirOf(sessionId), `${id}.json`)
}

function newId(): string {
  return `${String(Date.now()).padStart(14, '0')}-${crypto.randomBytes(3).toString('hex')}`
}

export async function recordChange(input: {
  sessionId: string
  root: string
  absPath: string
  before: string | null
  after: string | null
  tool: string
}): Promise<FileChange | null> {
  const { sessionId, root, absPath, before, after, tool } = input
  const existed = before !== null
  const deleted = after === null
  // 内容没变就不记，免得列表里全是空改动
  if (existed && before === after) return null
  // 前后都没内容（异常情况）不记
  if (!existed && deleted) return null

  const lines = diffLines(before ?? '', after ?? '')
  const { added, removed } = diffStats(lines)
  const tooBig =
    (before?.length ?? 0) > MAX_SNAPSHOT || (after?.length ?? 0) > MAX_SNAPSHOT
  const change: FileChange = {
    id: newId(),
    sessionId,
    path: path.relative(root, absPath).split(path.sep).join('/') || path.basename(absPath),
    absPath,
    kind: deleted ? 'delete' : existed ? 'modify' : 'create',
    at: Date.now(),
    tool,
    added,
    removed,
    size: Buffer.byteLength(after ?? '', 'utf8')
  }
  const rec: ChangeRecord = {
    ...change,
    before: tooBig ? '' : before ?? '',
    after: tooBig ? '' : after ?? '',
    revertable: !tooBig
  }
  try {
    await fs.mkdir(dirOf(sessionId), { recursive: true })
    await fs.writeFile(fileOf(sessionId, change.id), JSON.stringify(rec), 'utf8')
  } catch {
    // 记录失败不影响正常改文件
    return null
  }
  return change
}

async function readRecord(sessionId: string, id: string): Promise<ChangeRecord | null> {
  try {
    const raw = await fs.readFile(fileOf(sessionId, id), 'utf8')
    return JSON.parse(raw) as ChangeRecord
  } catch {
    return null
  }
}

export async function listChanges(sessionId: string): Promise<FileChange[]> {
  try {
    const names = await fs.readdir(dirOf(sessionId))
    const out: FileChange[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const rec = await readRecord(sessionId, name.replace(/\.json$/, ''))
      if (!rec || rec.reverted) continue
      const { before, after, revertable, reverted, ...change } = rec
      void before
      void after
      void reverted
      out.push({ ...change, revertable })
    }
    return out.sort((a, b) => b.at - a.at)
  } catch {
    return []
  }
}

export async function changeDetail(sessionId: string, id: string): Promise<ChangeDetail | null> {
  const rec = await readRecord(sessionId, id)
  if (!rec) return null
  const { before, after, revertable, reverted, ...change } = rec
  const lines: DiffLine[] = revertable
    ? diffLines(before, after)
    : [
        { kind: 'ctx', text: `（文件较大，本次只记录了统计：+${change.added} −${change.removed}，无法撤销）` }
      ]
  return { change, lines, revertable, reverted }
}

export async function revertChange(
  sessionId: string,
  id: string
): Promise<{ ok: boolean; message: string }> {
  const rec = await readRecord(sessionId, id)
  if (!rec) return { ok: false, message: '找不到这条改动记录' }
  if (!rec.revertable) return { ok: false, message: '这条改动太大，没有保存原文，不能撤销' }
  try {
    if (rec.kind === 'create') {
      await fs.rm(rec.absPath, { force: true })
    } else if (rec.kind === 'delete') {
      // 删除的撤销：把 before 写回去
      await fs.mkdir(path.dirname(rec.absPath), { recursive: true })
      await fs.writeFile(rec.absPath, rec.before, 'utf8')
    } else {
      await fs.mkdir(path.dirname(rec.absPath), { recursive: true })
      await fs.writeFile(rec.absPath, rec.before, 'utf8')
    }
    await fs.rm(fileOf(sessionId, id), { force: true })
    return { ok: true, message: `已还原 ${rec.path}` }
  } catch (err) {
    return { ok: false, message: `还原失败：${(err as Error).message}` }
  }
}

/** 从最新往回撤，最终回到本轮最开始的状态 */
export async function revertAll(sessionId: string): Promise<{ ok: boolean; message: string; count: number }> {
  const list = await listChanges(sessionId)
  let count = 0
  const failed: string[] = []
  for (const item of list) {
    const r = await revertChange(sessionId, item.id)
    if (r.ok) count++
    else failed.push(item.path)
  }
  if (failed.length) return { ok: false, message: `已还原 ${count} 个，失败：${failed.join('、')}`, count }
  return { ok: true, message: count ? `已还原 ${count} 个文件` : '没有可还原的改动', count }
}

export async function clearChanges(sessionId: string): Promise<void> {
  await fs.rm(dirOf(sessionId), { recursive: true, force: true })
}
