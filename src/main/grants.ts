/**
 * 「以后都这样」的长期放行记录。
 *
 * 会话内的「之后全允许」是临时的：点完这轮不再问，下次运行重新开始。
 * 但有些操作在一个项目里会反复出现（比如改了源码就 `npm test`、写文件到某个子目录），
 * 每轮都弹一次是纯噪音，用户会习惯性地乱点「允许」—— 那比不问更危险。
 * 所以给一条明确的、看得见、能撤掉的长期授权。
 *
 * 三条边界：
 * 1. **只记非高危**。删除、越界写盘、外部 MCP 这类操作永远每次都要人看一眼，
 *    它们的「始终允许」只在一轮里有效，不落盘（见 agent.ts 的 respondApproval）。
 * 2. **按「工作区 + 工具名」记**，不按会话：用户的意思是「这个项目里这个工具别再问」，
 *    按会话记等于什么都没解决。
 * 3. **独立文件**，不塞进 config.json —— 设置页保存时是整个配置对象回传的，
 *    混在一起迟早会被一次「保存设置」把授权悄悄清空，或者反过来。
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ApprovalGrant } from '../shared/types'

const FILE = 'approvals.json'

function filePath(): string {
  return path.join(app.getPath('userData'), FILE)
}

/** 匹配键：Windows 路径大小写不敏感，统一小写再比 */
export function grantKey(workspace: string, tool: string): string {
  return `${path.resolve(workspace).toLowerCase()}|${tool}`
}

async function readAll(): Promise<ApprovalGrant[]> {
  try {
    const raw = await fs.readFile(filePath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (g): g is ApprovalGrant =>
        !!g && typeof (g as ApprovalGrant).tool === 'string' && typeof (g as ApprovalGrant).workspace === 'string'
    ).map((g) => ({ tool: g.tool, workspace: g.workspace, at: Number(g.at) || 0 }))
  } catch {
    return []
  }
}

/**
 * 读写都排队：审批弹窗是用户在点，但两个并行会话可能同时点「记住」，
 * 各自「读全文 → 加一条 → 写回」，后写的会把先写的整条盖掉。
 */
const writing = new Map<string, Promise<unknown>>()

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const prev = writing.get('file') ?? Promise.resolve()
  const next = prev.then(task, task)
  writing.set(
    'file',
    next.catch(() => undefined)
  )
  return next
}

async function writeAll(list: ApprovalGrant[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath()), { recursive: true })
  await fs.writeFile(filePath(), JSON.stringify(list, null, 2), 'utf8')
}

export async function listGrants(): Promise<ApprovalGrant[]> {
  return (await readAll()).sort((a, b) => b.at - a.at)
}

/** 展开成可直接查的键集合，引擎启动一次、每次「记住」时增量更新 */
export async function loadGrantSet(): Promise<Set<string>> {
  return new Set((await readAll()).map((g) => grantKey(g.workspace, g.tool)))
}

/** 记一条授权。已经记过就不重复加（重复点「记住」不该长出一堆相同条目） */
export async function grantTool(workspace: string, tool: string): Promise<void> {
  const ws = path.resolve(workspace)
  return serialize(async () => {
    const list = await readAll()
    if (list.some((g) => grantKey(g.workspace, g.tool) === grantKey(ws, tool))) return
    list.push({ tool, workspace: ws, at: Date.now() })
    await writeAll(list)
  })
}

/** 撤销一个工具在一个工作区里的授权 */
export async function revokeGrant(workspace: string, tool: string): Promise<boolean> {
  return serialize(async () => {
    const list = await readAll()
    const next = list.filter((g) => grantKey(g.workspace, g.tool) !== grantKey(workspace, tool))
    if (next.length === list.length) return false
    await writeAll(next)
    return true
  })
}

/** 全部撤销：设置页那个「清除」按钮 */
export async function clearGrants(): Promise<number> {
  return serialize(async () => {
    const n = (await readAll()).length
    await fs.rm(filePath(), { force: true })
    return n
  })
}
