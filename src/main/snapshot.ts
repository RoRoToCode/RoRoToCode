/**
 * 工作区文件快照与一键回滚。
 *
 * 起因：模型把「改坏了」写进去之后，非 git 工作区没有任何办法回到上一版 ——
 * git 的 undo 依赖工作区是 git 仓库，而很多自动生成的项目（单页游戏、静态站点）
 * 根本没初始化 git。模型改坏一个文件，用户只能手动找备份。
 *
 * 这里补一层与 git 无关的轻量快照：写文件前，把将被覆盖的文件复制到
 * `.roroto/snapshots/<session>/<seq>/` 下，回滚时按序号原样拷回。
 *
 * 边界（刻意收窄，避免变成第二个版本控制系统）：
 * - 只备份「已存在的文件」在写前的最后内容；新建文件不备份（回滚=删除即可）。
 * - 备份内容落在工作区 `.roroto/snapshots/`，`.roroto` 已在交付忽略列表里，不污染产物。
 * - 单文件超过 MAX_BACKUP_BYTES 不备份（大文件不值得整份复制，交给 git 或用户）。
 * - 只允许回滚到工作区内的路径，越界一律拒绝。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 单文件备份上限：超过就不整份复制 */
const MAX_BACKUP_BYTES = 2 * 1024 * 1024
/** 每个会话最多保留多少轮快照，超出删最老的 */
const MAX_SNAPSHOTS = 20

export interface SnapshotEntry {
  /** 快照序号（递增），回滚时按它定位 */
  seq: number
  /** 被改文件的工作区相对路径 */
  rel: string
  /** 备份文件相对路径（在 .roroto/snapshots/<session>/<seq>/ 下） */
  backupRel: string
  /** 备份时的时间戳 */
  at: number
  /** 原文件大小（字节） */
  size: number
}

const SNAP_DIR = '.roroto/snapshots'

function snapshotDir(workspace: string, sessionId: string): string {
  return path.join(workspace, SNAP_DIR, sessionId)
}

/** 把工作区外的路径挡在门外 */
function safeRel(workspace: string, abs: string): string | null {
  const rel = path.relative(workspace, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

/** 读快照索引（内存外不落地，重启即失效——快照是本次会话的兜底，不做跨会话持久化） */
const index = new Map<string, SnapshotEntry[]>()

function entriesOf(workspace: string, sessionId: string): SnapshotEntry[] {
  const key = `${workspace}\u0000${sessionId}`
  let list = index.get(key)
  if (!list) {
    list = []
    index.set(key, list)
  }
  return list
}

/**
 * 写文件前备份。调用方在真正覆盖目标文件之前调用；文件不存在（新建）时不备份，
 * 返回 null。备份失败静默返回 null —— 快照是兜底，不该因为备份失败阻断正常写入。
 */
export async function snapshotBeforeWrite(
  workspace: string,
  sessionId: string,
  absPath: string
): Promise<SnapshotEntry | null> {
  try {
    const rel = safeRel(workspace, absPath)
    if (!rel) return null
    // 不备份快照目录自身，避免递归
    if (rel.startsWith(SNAP_DIR + '/')) return null

    let st
    try {
      st = await fs.stat(absPath)
    } catch {
      return null // 文件不存在 = 新建，无需备份
    }
    if (!st.isFile()) return null
    if (st.size > MAX_BACKUP_BYTES) return null

    const list = entriesOf(workspace, sessionId)
    const seq = (list[list.length - 1]?.seq ?? 0) + 1
    const dir = path.join(snapshotDir(workspace, sessionId), String(seq))
    await fs.mkdir(dir, { recursive: true })
    // 备份文件名保留原文件名，回滚时直接按 rel 定位
    const backupAbs = path.join(dir, path.basename(rel))
    await fs.copyFile(absPath, backupAbs)

    const entry: SnapshotEntry = {
      seq,
      rel,
      backupRel: `${SNAP_DIR}/${sessionId}/${seq}/${path.basename(rel)}`,
      at: Date.now(),
      size: st.size
    }
    list.push(entry)
    // 超出上限丢最老的（连同它的备份目录）
    while (list.length > MAX_SNAPSHOTS) {
      const oldest = list.shift()
      if (oldest) {
        await fs.rm(path.join(snapshotDir(workspace, sessionId), String(oldest.seq)), {
          recursive: true,
          force: true
        }).catch(() => {})
      }
    }
    return entry
  } catch {
    return null
  }
}

/** 列出当前会话的快照（新到旧） */
export function listSnapshots(workspace: string, sessionId: string): SnapshotEntry[] {
  return [...entriesOf(workspace, sessionId)].reverse()
}

/**
 * 回滚到指定序号：把该次快照备份的文件拷回工作区。
 * 返回被恢复的相对路径；越界/找不到返回 null。
 */
export async function rollbackSnapshot(
  workspace: string,
  sessionId: string,
  seq: number
): Promise<string | null> {
  const list = entriesOf(workspace, sessionId)
  const entry = list.find((e) => e.seq === seq)
  if (!entry) return null

  const backupAbs = path.join(workspace, entry.backupRel.split('/').join(path.sep))
  const targetAbs = path.join(workspace, entry.rel.split('/').join(path.sep))
  // 双重越界防护
  if (safeRel(workspace, targetAbs) === null) return null

  try {
    await fs.copyFile(backupAbs, targetAbs)
    return entry.rel
  } catch {
    return null
  }
}

/** 清空本会话快照（任务正常收工时调用，避免 `.roroto/snapshots` 无限增长） */
export async function clearSnapshots(workspace: string, sessionId: string): Promise<void> {
  index.delete(`${workspace}\u0000${sessionId}`)
  await fs.rm(snapshotDir(workspace, sessionId), { recursive: true, force: true }).catch(() => {})
}
