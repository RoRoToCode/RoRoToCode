/**
 * 会话搜索的命中判定。
 *
 * 单独抽成纯函数的原因是它踩过一次坑：以前直接在 store 里
 * `s.title.toLowerCase()`，老会话文件没有 title 字段时就抛 TypeError，
 * 被外层 catch 吞掉 —— 用户看到的是「这条会话明明有记录，搜关键词却搜不出来」，
 * 而且没有任何提示。这种「坏数据 → 静默漏结果」的路径必须有测试盯着，
 * 而 store 依赖 electron 的 app.getPath，跑不进 node --test。
 *
 * 原则：**读到的字段先验类型再使用**。会话文件是磁盘上的历史数据，
 * 版本迁移、手改、写到一半断电都能造出缺字段的文件，搜索不该因此失效。
 */
import type { SessionHit } from './types'

interface RawSession {
  id?: unknown
  title?: unknown
  workspace?: unknown
  createdAt?: unknown
  updatedAt?: unknown
  messages?: unknown
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * 在标题和正文里找关键词，命中就返回带片段的条目，否则 null。
 *
 * 片段取命中位置前 24 字、后 34 字：太短看不出上下文，太长会把搜索面板撑开。
 */
export function searchHit(raw: RawSession | null | undefined, query: string): SessionHit | null {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return null
  if (!raw || typeof raw !== 'object') return null

  // 没有 id 的会话点开是空白，列出来只会误导
  const id = textOf(raw.id)
  if (!id) return null

  const title = textOf(raw.title)
  const messages = Array.isArray(raw.messages) ? raw.messages : []

  let count = 0
  let snippet = ''
  if (title.toLowerCase().includes(q)) {
    count++
    snippet = title
  }

  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    const body = textOf((m as { content?: unknown }).content)
    const idx = body.toLowerCase().indexOf(q)
    if (idx < 0) continue
    count++
    if (!snippet) {
      const start = Math.max(0, idx - 24)
      snippet = `${start > 0 ? '…' : ''}${body.slice(start, idx + q.length + 34).replace(/\s+/g, ' ')}`
    }
  }

  if (!count) return null
  return {
    id,
    title: title || '未命名会话',
    workspace: typeof raw.workspace === 'string' ? raw.workspace : null,
    createdAt: numberOrZero(raw.createdAt),
    updatedAt: numberOrZero(raw.updatedAt),
    snippet,
    hits: count
  }
}
