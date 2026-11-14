/**
 * 工作区登记簿：记住用户用过哪些目录，好在它们之间快速切换。
 *
 * 会话本身已经带 workspace，所以「多个工作区」在数据层是成立的；
 * 缺的只是「没有会话的目录怎么找回来」——不然换走一次就再也点不回去了。
 *
 * 纯文件读写，不依赖 Electron 的窗口状态；userData 路径由调用方传入，
 * 方便单测。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface WorkspaceEntry {
  /** 绝对路径 */
  path: string
  /** 目录名，仅用于展示 */
  name: string
  /** 最近一次进入的时间 */
  lastOpened: number
  /** 用户手动置顶 */
  pinned?: boolean
}

const FILE = 'workspaces.json'
const MAX_ENTRIES = 30

export function workspacesFile(userData: string): string {
  return path.join(userData, FILE)
}

function normalize(list: unknown): WorkspaceEntry[] {
  if (!Array.isArray(list)) return []
  const out: WorkspaceEntry[] = []
  for (const raw of list) {
    const e = raw as Partial<WorkspaceEntry>
    if (typeof e?.path !== 'string' || !e.path) continue
    out.push({
      path: e.path,
      name: typeof e.name === 'string' && e.name ? e.name : path.basename(e.path),
      lastOpened: Number(e.lastOpened) || 0,
      pinned: e.pinned === true
    })
  }
  return out
}

export async function listWorkspaces(userData: string): Promise<WorkspaceEntry[]> {
  try {
    const raw = JSON.parse(await fs.readFile(workspacesFile(userData), 'utf8'))
    return normalize(raw).sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
      return b.lastOpened - a.lastOpened
    })
  } catch {
    return []
  }
}

export async function rememberWorkspace(userData: string, dir: string): Promise<WorkspaceEntry[]> {
  if (!dir) return listWorkspaces(userData)
  const target = path.resolve(dir)
  const list = await listWorkspaces(userData)
  const existing = list.find((w) => w.path.toLowerCase() === target.toLowerCase())
  const next: WorkspaceEntry[] = existing
    ? list.map((w) => (w === existing ? { ...w, lastOpened: Date.now() } : w))
    : [
        { path: target, name: path.basename(target) || target, lastOpened: Date.now() },
        ...list
      ]

  // 只留最近的 N 个：这是「最近用过」，不是书签管理器
  const trimmed = next
    .sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
      return b.lastOpened - a.lastOpened
    })
    .slice(0, MAX_ENTRIES)

  try {
    await fs.mkdir(userData, { recursive: true })
    await fs.writeFile(workspacesFile(userData), JSON.stringify(trimmed, null, 2), 'utf8')
  } catch {
    // 写不进去不影响本次使用，下次还得重新登记
  }
  return trimmed
}

export async function forgetWorkspace(userData: string, dir: string): Promise<WorkspaceEntry[]> {
  const target = path.resolve(dir).toLowerCase()
  const list = (await listWorkspaces(userData)).filter((w) => w.path.toLowerCase() !== target)
  try {
    await fs.writeFile(workspacesFile(userData), JSON.stringify(list, null, 2), 'utf8')
  } catch {
    // 同上
  }
  return list
}

/** 目录还在不在：切换前提示「路径已不存在」比切过去报错友好 */
export async function existsDir(dir: string): Promise<boolean> {
  try {
    const st = await fs.stat(dir)
    return st.isDirectory()
  } catch {
    return false
  }
}
