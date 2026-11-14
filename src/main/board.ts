/**
 * 共享黑板的落盘。
 *
 * 位置和长期记忆一样放 userData（按工作区隔离），不写进代码库：
 * 一份自动维护的便签塞进仓库会被提交、也会让「谁写进来的」变得很难解释。
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { BoardInfo } from '../shared/types'
import {
  addToBoard,
  boardCount,
  boardPromptText,
  emptyBoard,
  isSection,
  parseBoard,
  renderBoard,
  removeFromBoard,
  type BoardData,
  type BoardSection
} from '../shared/board'
import { workspaceSlug } from './memory'

/** 同一个文件的写入排成一条链：两个 agent 同时写黑板，交叉写会把条目冲掉 */
const chain = new Map<string, Promise<unknown>>()

function serialize<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = chain.get(file) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  chain.set(
    file,
    next.catch(() => undefined)
  )
  return next
}

export function boardPath(workspace: string): string {
  return path.join(app.getPath('userData'), 'board', `${workspaceSlug(workspace)}.md`)
}

async function readData(workspace: string): Promise<BoardData> {
  try {
    return parseBoard(await fs.readFile(boardPath(workspace), 'utf8'))
  } catch {
    return emptyBoard()
  }
}

async function writeData(workspace: string, data: BoardData): Promise<void> {
  const file = boardPath(workspace)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, renderBoard(data), 'utf8')
}

/** 给界面：原文 + 条数 + 落点，用户想自己打开改也知道去哪找 */
export async function boardInfo(workspace: string): Promise<BoardInfo> {
  const data = await readData(workspace)
  return { path: boardPath(workspace), text: renderBoard(data), items: boardCount(data) }
}

/** 给系统提示：没有内容就返回空串，别在提示词里留一个空标题 */
export async function boardForPrompt(workspace: string): Promise<string> {
  return boardPromptText(await readData(workspace))
}

/** 工具入口：加一条 */
export async function addBoardNote(
  workspace: string,
  section: BoardSection,
  note: string
): Promise<{ added: boolean; items: number }> {
  if (!isSection(section)) throw new Error('section 只能是 rule / fact / todo')
  return await serialize(boardPath(workspace), async () => {
    const before = await readData(workspace)
    const r = addToBoard(before, section, note)
    if (r.added) await writeData(workspace, r.data)
    return { added: r.added, items: r.items }
  })
}

/** 界面上删一条 */
export async function removeBoardNote(
  workspace: string,
  section: BoardSection,
  note: string
): Promise<BoardInfo> {
  return await serialize(boardPath(workspace), async () => {
    const next = removeFromBoard(await readData(workspace), section, note)
    await writeData(workspace, next)
    return { path: boardPath(workspace), text: renderBoard(next), items: boardCount(next) }
  })
}

export async function clearBoard(workspace: string): Promise<{ ok: boolean }> {
  return await serialize(boardPath(workspace), async () => {
    await fs.rm(boardPath(workspace), { force: true })
    return { ok: true }
  })
}
