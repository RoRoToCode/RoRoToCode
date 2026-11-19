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

export interface TodoGateVerdict {
  ok: boolean
  reason?: string
  hint?: string
}

/**
 * 计划门禁。
 *
 * 这条是整个「按步推进」能不能立住的关键：以前 update_todos 只是把模型给的表
 * 存下来给界面看，模型想怎么标就怎么标 —— 于是它会在第 1 项还没做的时候把
 * 第 3 项标成完成，也会在页面根本打不开的时候宣布「全部完成」。
 *
 * 三条规则，都是围绕同一件事：**计划的状态必须反映真实进度，否则它只是装饰**。
 *  1. completed 必须构成前缀 —— 不许跳项
 *  2. in_progress 只能落在第一个未完成项上 —— 不许同时推进多项
 *  3. 有文件打开验收没过时，不许新增 completed —— 不许把没跑起来的东西算做完
 *
 * @param prev 上一版计划
 * @param next 模型这次提交的计划
 * @param blocking 打开验收失败的文件（相对路径 → 错误摘要）
 */
export function todoGate(
  prev: TodoItem[],
  next: TodoItem[],
  blocking?: Map<string, string> | null
): TodoGateVerdict {
  if (!next.length) return { ok: true }

  const firstOpen = next.findIndex((t) => t.status !== 'completed')

  // 1) 不许跳项：第一个未完成项之后不能再出现 completed
  if (firstOpen >= 0) {
    const afterIdx = next.findIndex((t, i) => i > firstOpen && t.status === 'completed')
    if (afterIdx >= 0) {
      return {
        ok: false,
        reason: `第 ${firstOpen + 1} 项「${next[firstOpen].content}」还没完成，却把第 ${afterIdx + 1} 项「${next[afterIdx].content}」标成了 completed。`,
        hint:
          `计划要按顺序推进：先把第 ${firstOpen + 1} 项做完再动后面的。` +
          `如果这一项确实不需要做了，把它标成 completed 并说明原因；如果整个计划要改，就整表重发、把不要的那项删掉。`
      }
    }
  }

  // 2) 同一时间只推进一项，而且必须是第一个未完成项
  const active = next.findIndex((t) => t.status === 'in_progress')
  if (active >= 0 && firstOpen >= 0 && active !== firstOpen) {
    return {
      ok: false,
      reason: `同一时间只能推进一项，而你把第 ${active + 1} 项设成了进行中，前面第 ${firstOpen + 1} 项还没完成。`,
      hint: `把第 ${firstOpen + 1} 项设为 in_progress、其余设 pending，重新提交。`
    }
  }

  // 3) 打开验收没过，不许把活算做完
  const prevDone = prev.filter((t) => t.status === 'completed').length
  const nextDone = next.filter((t) => t.status === 'completed').length
  if (blocking && blocking.size && nextDone > prevDone) {
    const detail = [...blocking.entries()]
      .slice(0, 2)
      .map(([f, e]) => `${f}（${e}）`)
      .join('；')
    return {
      ok: false,
      reason: `现在还不能把活标成完成：刚写的页面打开时报错 —— ${detail}`,
      hint:
        '先把报错修掉：按验收里给的行号用 read_file 读那一段，只改坏掉的地方再写回去（不要整份重写）；' +
        '重新写完之后会再验一次，通过后再回来把这一项标 completed。'
    }
  }

  return { ok: true }
}

/** 从历史消息的工具参数里还原最后一次计划（重开会话时用） */
export function todosFromArgs(args: unknown): TodoItem[] | null {
  if (!args || typeof args !== 'object') return null
  const items = (args as Record<string, unknown>).items
  if (!Array.isArray(items)) return null
  return normalizeTodos(items)
}
