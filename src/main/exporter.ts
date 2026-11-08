import { dialog } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ChatMessage, Session } from '../shared/types'
import { mt } from './i18n'

function time(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fence(text: string): string {
  // 内容里本来就有 ``` 时用四个反引号，避免把 Markdown 撑破
  const ticks = text.includes('```') ? '````' : '```'
  return `${ticks}\n${text}\n${ticks}`
}

function renderMessage(m: ChatMessage): string {
  if (m.role === 'user') {
    const parts = [`## 你\n`, m.content]
    if (m.images?.length) parts.push(`\n（附带 ${m.images.length} 张图片）`)
    return parts.join('\n')
  }
  if (m.role === 'tool') {
    const name = m.toolName ?? 'tool'
    const arg = m.toolArgs ? JSON.stringify(m.toolArgs) : ''
    const head = `**工具 ${name}** ${arg ? `\`${arg.slice(0, 120)}\`` : ''}`
    return `<details><summary>${head}</summary>\n\n${fence(m.content || '（无输出）')}\n\n</details>`
  }
  if (m.role === 'assistant') {
    const body = m.content?.trim() || '（无文字回复）'
    const calls = m.toolCalls?.length
      ? `\n\n> 调用工具：${m.toolCalls.map((c) => c.name).join('、')}`
      : ''
    return `## RoRoTo Code\n\n${body}${calls}`
  }
  return ''
}

export function renderSessionMarkdown(session: Session): string {
  const head = [
    `# ${session.title || '未命名会话'}`,
    '',
    `- 工作区：${session.workspace ?? '（未指定）'}`,
    `- 创建时间：${time(session.createdAt)}`,
    `- 导出时间：${time(Date.now())}`,
    `- 消息数：${session.messages.length}`,
    '',
    '---',
    ''
  ].join('\n')
  return head + session.messages.map(renderMessage).filter(Boolean).join('\n\n') + '\n'
}

export async function exportSessionMarkdown(
  session: Session
): Promise<{ ok: boolean; message?: string; path?: string }> {
  const safe = (session.title || '会话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
  const res = await dialog.showSaveDialog({
    title: mt('导出对话'),
    defaultPath: `${safe}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  })
  if (res.canceled || !res.filePath) return { ok: false, message: '已取消' }
  try {
    await fs.mkdir(path.dirname(res.filePath), { recursive: true })
    await fs.writeFile(res.filePath, renderSessionMarkdown(session), 'utf8')
    return { ok: true, path: res.filePath }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}
