import type { TodoItem, TodoStatus } from './types'

const MAX_ITEMS = 20
const MAX_LEN = 200

/** 把模型给的 items 洗成合法计划：字符串 / 对象都接受，状态归一，只留一个「进行中」 */
export function normalizeTodos(input: unknown): TodoItem[] {
  const arr = Array.isArray(input) ? input : []
  const items: TodoItem[] = []

  for (const raw of arr.slice(0, MAX_ITEMS)) {
    if (typeof raw === 'string') {
      const content = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_LEN)
      if (content) items.push({ content, status: 'pending' })
      continue
    }
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const content = String(o.content ?? o.text ?? o.title ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_LEN)
    if (!content) continue
    const s = String(o.status ?? '').toLowerCase()
    const status: TodoStatus =
      s === 'completed' || s === 'done' || s === 'finished' || s === 'complete'
        ? 'completed'
        : s === 'in_progress' || s === 'in-progress' || s === 'doing' || s === 'active'
          ? 'in_progress'
          : 'pending'
    items.push({ content, status })
  }

  let hasActive = false
  for (const item of items) {
    if (item.status !== 'in_progress') continue
    if (hasActive) item.status = 'pending'
    else hasActive = true
  }
  return items
}

export function todoProgress(items: TodoItem[]): { done: number; total: number } {
  return { done: items.filter((i) => i.status === 'completed').length, total: items.length }
}

/** 回给模型看的计划文本 */
export function formatTodos(items: TodoItem[]): string {
  if (!items.length) return '计划已清空。'
  const mark = (s: TodoStatus) => (s === 'completed' ? '[x]' : s === 'in_progress' ? '[~]' : '[ ]')
  const { done, total } = todoProgress(items)
  return [
    `当前计划（${done}/${total} 已完成）：`,
    ...items.map((i, n) => `${n + 1}. ${mark(i.status)} ${i.content}`)
  ].join('\n')
}

/** 从历史消息的工具参数里还原最后一次计划（重开会话时用） */
export function todosFromArgs(args: unknown): TodoItem[] | null {
  if (!args || typeof args !== 'object') return null
  const items = (args as Record<string, unknown>).items
  if (!Array.isArray(items)) return null
  return normalizeTodos(items)
}
