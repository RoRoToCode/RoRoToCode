import type { TodoItem } from './types'

/**
 * 结构化任务 checkpoint 的纯类型 + 纯函数部分（不依赖 electron / fs），
 * 主进程 checkpoint.ts 做落盘，这里只负责类型和「把进度拼成给模型看的恢复摘要」。
 */

export type CheckpointStatus = 'running' | 'done' | 'interrupted'

export interface Checkpoint {
  sessionId: string
  workspace: string | null
  status: CheckpointStatus
  /** 执行计划（update_todos 维护），崩溃后据此知道还剩哪些没做 */
  todos: TodoItem[]
  /** 本次运行改过的文件（相对工作区路径） */
  touched: string[]
  /** 最后一次自动验证的结论（失败原因等） */
  verifyNote: string | null
  lastCalls: string[]
  continues: number
  createdAt: number
  updatedAt: number
}

/**
 * 把 checkpoint 里的结构化进度拼成一段给模型看的「恢复摘要」。
 * 恢复时塞进系统提示 / 用户消息，让模型明确知道做到哪、还剩什么、别重复。
 */
export function checkpointBrief(cp: Checkpoint): string {
  const lines: string[] = []
  const pending = cp.todos.filter((t) => t.status !== 'completed')
  const done = cp.todos.length - pending.length
  if (cp.todos.length) {
    lines.push(
      `上次任务执行到一半被中断了。执行计划还剩 ${pending.length} 项未完成（已完成 ${done}/${cp.todos.length}）：`
    )
    for (const t of pending.slice(0, 10)) {
      lines.push(`  - [${t.status === 'in_progress' ? '进行中' : '未开始'}] ${t.content}`)
    }
  }
  if (cp.touched.length) {
    lines.push('已经改动过的文件（不要重复或回退这些改动，除非确实需要）：')
    for (const f of cp.touched.slice(0, 20)) lines.push(`  - ${f}`)
  }
  if (cp.verifyNote) {
    lines.push(`上次最后的验证结论（需要你接着修）：${cp.verifyNote}`)
  }
  lines.push('请从断点接着做完，不要重复已经完成的部分。')
  return lines.join('\n')
}
