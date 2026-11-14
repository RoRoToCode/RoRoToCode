/**
 * 跨会话长期记忆：每个工作区一份 MEMORY.md，存在用户数据目录里。
 *
 * 为什么不放工作区根目录：那是用户的代码库，塞一个自动维护的文件会污染项目、
 * 也容易被 git 提交。放在 userData/memory/<目录名>-<路径哈希>.md，按工作区隔离。
 *
 * 每次对话开始时整段注入系统提示（有上限），所以不用模型主动「查记忆」。
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

/** 注入系统提示的最大字符数，超了只带最新的部分 */
export const MEMORY_PROMPT_LIMIT = 2200
const MAX_CHARS = 12000
const MAX_ITEMS = 200

export interface MemoryInfo {
  path: string
  items: number
  chars: number
}

/**
 * 工作区落盘用的短名：目录名 + 绝对路径哈希。
 * 导出是为了让共享黑板（main/board.ts）用同一套命名 —— 同一个项目，
 * 记忆和黑板应该肩并肩放在一起，用户排查时不用记两套规则。
 */
export function workspaceSlug(workspace: string): string {
  const abs = path.resolve(workspace)
  const hash = createHash('sha1').update(abs.toLowerCase()).digest('hex').slice(0, 8)
  const raw = path.basename(abs) || 'workspace'
  // 去掉开头的点/横线：.tmp-ws 这种目录名会生成隐藏文件，不方便用户自己找
  const base = raw
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '_')
    .replace(/^[.\-_]+/, '')
    .slice(0, 24) || 'workspace'
  return `${base}-${hash}`
}

/**
 * 记忆命名空间的落点。
 *
 * 没有 agentId 就是原来的「每个工作区一份」，老文件路径完全不变；
 * 指定 agentId 时另开一份（`<工作区>.<档案>.md`），让巡检记住的坑不会污染审查的判断 ——
 * 角色的经验混在一起，比没有记忆更糟。
 */
function nsSuffix(agentId?: string | null): string {
  if (!agentId) return ''
  const safe = String(agentId).replace(/[^\w.-]+/g, '_').slice(0, 40)
  return safe ? `.${safe}` : ''
}

export function memoryPath(workspace: string, agentId?: string | null): string {
  return path.join(app.getPath('userData'), 'memory', `${workspaceSlug(workspace)}${nsSuffix(agentId)}.md`)
}

export async function readMemory(workspace: string, agentId?: string | null): Promise<string> {
  try {
    return await fs.readFile(memoryPath(workspace, agentId), 'utf8')
  } catch {
    return ''
  }
}

/** 只取条目行，去掉标题和注释 */
function bullets(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => /^\s*-\s+/.test(l))
    .map((l) => l.replace(/^\s*-\s+/, '').trim())
    .filter(Boolean)
}

/** 给系统提示用的片段：最新优先，超长从头截 */
export async function memoryForPrompt(workspace: string, agentId?: string | null): Promise<string> {
  const items = bullets(await readMemory(workspace, agentId))
  if (!items.length) return ''
  const picked: string[] = []
  let used = 0
  for (const item of items) {
    if (used + item.length > MEMORY_PROMPT_LIMIT) break
    picked.push(item)
    used += item.length + 3
  }
  return picked.map((i) => `- ${i}`).join('\n')
}

export async function memoryInfo(workspace: string, agentId?: string | null): Promise<MemoryInfo> {
  const text = await readMemory(workspace, agentId)
  return {
    path: memoryPath(workspace, agentId),
    items: bullets(text).length,
    chars: text.length
  }
}

/**
 * 同一份记忆文件的写入必须排队。
 *
 * 为什么会撞：引擎的并发锁是按会话的，不是按 agent 的 —— 同一个 agent 开两个会话
 * 同时跑时，两边几乎同时调 remember，各自「读全文 → 改 → 写回」，
 * 后写的那次会把先写的那条整条盖掉，且不会报错。
 * 文件只有几 KB，排队成本可以忽略；key 是记忆文件路径，数量随工作区×档案增长，很小。
 */
const writing = new Map<string, Promise<unknown>>()

function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = writing.get(key) ?? Promise.resolve()
  // 前一次失败也要接着做：记忆写不进去不该卡住后面的记录
  const next = prev.then(task, task)
  // 存一个永不 reject 的版本，否则排在后面的会继承这次失败
  writing.set(
    key,
    next.catch(() => undefined)
  )
  return next
}

/**
 * 记一条事实。同一条不重复追加；超过条数或体积上限时丢最旧的（在末尾的那些）。
 */
export async function rememberFact(
  workspace: string,
  note: string,
  agentId?: string | null
): Promise<{ added: boolean; count: number }> {
  const text = note.replace(/\s+/g, ' ').trim().slice(0, 400)
  if (!text) throw new Error('note 不能为空')
  return serialize(memoryPath(workspace, agentId), () => appendFact(workspace, text, agentId))
}

async function appendFact(
  workspace: string,
  text: string,
  agentId?: string | null
): Promise<{ added: boolean; count: number }> {
  const items = bullets(await readMemory(workspace, agentId))
  const normalized = (s: string) => s.replace(/^[\d-]+\s*/, '').toLowerCase()
  if (items.some((i) => normalized(i).includes(normalized(text)))) {
    return { added: false, count: items.length }
  }

  const stamp = new Date().toISOString().slice(0, 10)
  const next = [`${stamp} ${text}`, ...items].slice(0, MAX_ITEMS)
  const body = [
    '# 项目长期记忆',
    '',
    '> 由 RoRoTo Code 自动维护，越靠上越新。可在「软件设置 → 数据」里清空。',
    '',
    ...next.map((i) => `- ${i}`),
    ''
  ].join('\n')

  const file = memoryPath(workspace, agentId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body, 'utf8')

  // 体积仍然超标就继续砍最旧的
  if (body.length > MAX_CHARS) {
    const trimmed = next.slice(0, Math.max(20, Math.floor(next.length * 0.7)))
    const smaller = [
      '# 项目长期记忆',
      '',
      '> 由 RoRoTo Code 自动维护，越靠上越新。可在「软件设置 → 数据」里清空。',
      '',
      ...trimmed.map((i) => `- ${i}`),
      ''
    ].join('\n')
    await fs.writeFile(file, smaller, 'utf8')
    return { added: true, count: trimmed.length }
  }

  return { added: true, count: next.length }
}

export async function clearMemory(workspace: string, agentId?: string | null): Promise<void> {
  await fs.rm(memoryPath(workspace, agentId), { force: true })
}
