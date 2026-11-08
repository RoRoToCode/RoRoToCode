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

function slug(workspace: string): string {
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

export function memoryPath(workspace: string): string {
  return path.join(app.getPath('userData'), 'memory', `${slug(workspace)}.md`)
}

export async function readMemory(workspace: string): Promise<string> {
  try {
    return await fs.readFile(memoryPath(workspace), 'utf8')
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
export async function memoryForPrompt(workspace: string): Promise<string> {
  const items = bullets(await readMemory(workspace))
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

export async function memoryInfo(workspace: string): Promise<MemoryInfo> {
  const text = await readMemory(workspace)
  return {
    path: memoryPath(workspace),
    items: bullets(text).length,
    chars: text.length
  }
}

/**
 * 记一条事实。同一条不重复追加；超过条数或体积上限时丢最旧的（在末尾的那些）。
 */
export async function rememberFact(
  workspace: string,
  note: string
): Promise<{ added: boolean; count: number }> {
  const text = note.replace(/\s+/g, ' ').trim().slice(0, 400)
  if (!text) throw new Error('note 不能为空')

  const items = bullets(await readMemory(workspace))
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

  const file = memoryPath(workspace)
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

export async function clearMemory(workspace: string): Promise<void> {
  await fs.rm(memoryPath(workspace), { force: true })
}
