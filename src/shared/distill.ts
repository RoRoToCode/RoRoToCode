/**
 * 从会话轨迹里提炼「可复用的做法」的纯逻辑部分。
 *
 * 放在 shared 里只为一个理由：它不碰磁盘、不碰网络、不碰 electron，
 * 所以能直接单测。真正调模型、写技能文件的部分在 main/learn.ts。
 */
import type { ChatMessage } from './types'

/** 喂给模型的轨迹上限：再多也读不完，反而把真正关键的几步稀释掉 */
export const TRACE_LIMIT = 6000

/** 单条文本截断，保留开头（开头通常是命令 / 结论，尾巴多是输出噪音） */
function cut(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

/**
 * 把会话压成轨迹文本。
 *
 * 取舍：工具**调用参数**保留（那是方法的骨架：命令怎么写、改了哪个文件、
 * 用什么参数查的），工具**输出**只留开头（只用来判断成没成）。
 * 「好的，我来看看」这类话一律不要 —— 对蒸馏方法毫无信息量。
 */
export function condenseTrace(messages: ChatMessage[], limit = TRACE_LIMIT): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const t = cut(m.content, 240)
      if (t) lines.push(`\n[用户] ${t}`)
      continue
    }
    if (m.role === 'assistant') {
      for (const c of m.toolCalls ?? []) {
        lines.push(`[调用] ${c.name} ${cut(JSON.stringify(c.args ?? {}), 260)}`)
      }
      const t = cut(m.content, 200)
      // 只有真正给了结论的助手消息才留，避免整段都是客套话
      if (t && t.length > 12) lines.push(`[说明] ${t}`)
      continue
    }
    if (m.role === 'tool') {
      const head = cut(m.content, 160)
      const bad = /^(执行失败|失败|错误|Error)/i.test(head)
      lines.push(`[结果${bad ? '·失败' : ''}] ${m.toolName ?? 'tool'} → ${head}`)
    }
  }
  const text = lines.join('\n').trim()
  if (text.length <= limit) return text
  // 超长留尾巴：关心的是「最后怎么成的」，开头的摸索过程参考价值最低
  return `（前段已省略）\n${text.slice(text.length - limit)}`
}

/** 从模型输出里抠出 JSON。模型经常套一层 ```json，或者前后多一句解释 */
export function parseDistilled(raw: string): { name: string; desc: string; prompt: string } | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
    const name = String(obj.name ?? '').trim()
    const prompt = String(obj.prompt ?? '').trim()
    if (!name || !prompt) return null
    return { name: name.slice(0, 24), desc: String(obj.desc ?? '').trim().slice(0, 120), prompt }
  } catch {
    return null
  }
}
