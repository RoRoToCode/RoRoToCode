import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ChangeDetail, FileChange, DiffLine } from '../shared/types'
import { diffLines, diffStats } from './diff'
import { buildWithHunks, diffHunks } from '../shared/hunks'

const run = promisify(execFile)

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
  /** 大文件走 git 兜底：before 来自 HEAD（回滚=回到最近一次提交），而非本次改动前的精确原文 */
  revertedFromGit?: boolean
  reverted?: boolean
  /** 记录这条改动时的工作区根：撤销时据此确认目标没被改到工作区之外 */
  root?: string
}

function dirOf(sessionId: string): string {
  return path.join(app.getPath('userData'), 'changes', sessionId.replace(/[^\w-]/g, ''))
}

function fileOf(sessionId: string, id: string): string {
  /**
   * id 必须校验。sessionId 已经清洗过，id 却是渲染层直接传进来的字符串，
   * 拼进路径就是一次穿越（`..\..\..\x`）。store.ts 那边对会话 id 有白名单，
   * 这里没有 —— 同一个程序里两套标准，迟早会有人从松的那边进来。
   */
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) throw new Error('非法的变更 ID')
  return path.join(dirOf(sessionId), `${id}.json`)
}

/** 目标必须还在记录的根目录里：撤销是一条「把旧内容写回去」的写盘操作，不能盲信记录里的路径 */
function insideRoot(rec: ChangeRecord): boolean {
  if (!rec.root || !rec.absPath) return false
  const root = path.resolve(rec.root)
  const abs = path.resolve(rec.absPath)
  const rel = path.relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function newId(): string {
  return `${String(Date.now()).padStart(14, '0')}-${crypto.randomBytes(3).toString('hex')}`
}

/**
 * 大文件（超过内存快照上限）的 git 兜底：从 HEAD 取这个文件的提交版本内容。
 *
 * 应用级快照为防内存失控，对超过 MAX_SNAPSHOT 的文件不再存 before，导致这类改动
 * 只能「看得到、撤不回」。git 兜底让撤销至少能回到「最近一次提交」的状态：
 * 只读 git（`git show HEAD:<path>`），不 stash、不 commit，不污染用户的提交历史。
 *
 * 拿不到（不是 git 仓库 / 文件从没提交过）就返回 null，退回到「不可撤销」的旧行为。
 */
async function gitHeadContent(root: string, absPath: string): Promise<string | null> {
  try {
    const rel = path.relative(root, absPath).split(path.sep).join('/')
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
    const { stdout } = await run('git', ['show', `HEAD:${rel}`], {
      cwd: root,
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    })
    return stdout
  } catch {
    return null
  }
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
  // 大文件才可能走 git 兜底：应用快照存不下 before 时，试着从 HEAD 取提交版本。
  // 取到了就能撤销（回滚到最近一次提交），取不到仍退回「不可撤销」。
  let savedBefore = tooBig ? '' : before ?? ''
  let revertable = !tooBig
  let revertedFromGit = false
  if (tooBig && existed && before !== null) {
    const gitBefore = await gitHeadContent(root, absPath)
    if (gitBefore !== null && gitBefore !== before) {
      savedBefore = gitBefore
      revertable = true
      revertedFromGit = true
    }
  }
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
    before: savedBefore,
    after: tooBig ? '' : after ?? '',
    revertable,
    revertedFromGit,
    root
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
      const { before, after, revertable, reverted, root, revertedFromGit, ...change } = rec
      void before
      void after
      void reverted
      void root
      void revertedFromGit
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
  const { before, after, revertable, reverted, root, revertedFromGit, ...change } = rec
  // 剥离出来只为不泄漏到变更详情；显式消费掉，避免「解构但未使用」告警
  void root
  void revertedFromGit
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
  if (!path.isAbsolute(rec.absPath)) return { ok: false, message: '改动记录里的路径不合法' }
  /**
   * 「撤销新建」等于删文件。目标如果是记录之外的路径（记录被改过、或工作区已经
   * 搬走），就不执行删除：删错了没有第二次机会，宁可让用户自己去删。
   */
  if (rec.kind === 'create' && !insideRoot(rec)) {
    return { ok: false, message: '这条改动记录的目标已不在当前工作区内，为安全起见没有删除文件' }
  }
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
    return {
      ok: true,
      message: rec.revertedFromGit
        ? `已还原 ${rec.path}（大文件走 git 兜底，回滚到最近一次提交的版本）`
        : `已还原 ${rec.path}`
    }
  } catch (err) {
    return { ok: false, message: `还原失败：${(err as Error).message}` }
  }
}

/**
 * 只应用选中的块：其余改动当成没发生。
 *
 * 重建用的是「原 diff + 选中集合」，不重新读盘 —— 这样用户看到的那份 diff
 * 和最后写下去的字节是同一份依据，不会出现「看着一样、写下去不一样」。
 * 写完之后更新快照的 after，撤销仍然能回到最初的 before。
 */
export async function applyHunks(
  sessionId: string,
  id: string,
  keep: number[]
): Promise<{ ok: boolean; message: string }> {
  const rec = await readRecord(sessionId, id)
  if (!rec) return { ok: false, message: '找不到这条改动记录' }
  if (!rec.revertable) return { ok: false, message: '文件太大没有保存原文，不能按块应用' }
  if (rec.kind === 'delete') return { ok: false, message: '删除操作没有「块」可选' }

  const lines = diffLines(rec.before ?? '', rec.after ?? '')
  const hunks = diffHunks(lines)
  if (!hunks.length) return { ok: false, message: '这条改动里没有可选的块' }

  const selected = new Set(keep.filter((k) => Number.isInteger(k) && k >= 0 && k < hunks.length))
  const content = buildWithHunks(lines, hunks, selected)
  const final = rec.after.endsWith('\n') ? `${content}\n` : content

  try {
    await fs.mkdir(path.dirname(rec.absPath), { recursive: true })
    await fs.writeFile(rec.absPath, final, 'utf8')
  } catch (err) {
    return { ok: false, message: `写入失败：${(err as Error).message}` }
  }

  const stats = diffStats(diffLines(rec.before ?? '', final))
  const next: ChangeRecord = {
    ...rec,
    after: final,
    added: stats.added,
    removed: stats.removed,
    size: Buffer.byteLength(final, 'utf8')
  }
  try {
    await fs.writeFile(fileOf(sessionId, id), JSON.stringify(next), 'utf8')
  } catch {
    // 快照更新失败不影响已经写对的文件，只是这条记录的撤销会退回最初内容
  }
  return { ok: true, message: `已保留 ${selected.size}/${hunks.length} 块改动` }
}

/** 从最新往回撤，最终回到本轮最开始的状态 */export async function revertAll(sessionId: string): Promise<{ ok: boolean; message: string; count: number }> {
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
