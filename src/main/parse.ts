import type { ToolCall } from '../shared/types'
import { toolSpecs } from './tools/spec'

/**
 * 从模型输出里识别工具调用。
 * 原生 tool_calls 由各 provider 解析；这里处理「模型把调用写成文字」的情况，
 * 主 agent 和子 agent 共用同一套规则，避免两处行为不一致。
 */

/** 已知工具名：用来把「正文里恰好出现的 JSON」和真正的工具调用区分开 */
const knownTools = new Set(toolSpecs.map((t) => t.name))

export interface RawCall {
  name: string
  args: Record<string, unknown>
}

/** 把模型吐出来的一坨 JSON 归一成工具调用；名字不在白名单里就当普通文本 */
function normalizeCall(value: unknown): RawCall | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  const nameRaw = obj.name ?? obj.tool ?? obj.tool_name ?? obj.function
  if (typeof nameRaw !== 'string') return null
  const name = nameRaw.trim()
  if (!knownTools.has(name)) return null

  let argsRaw: unknown = obj.args ?? obj.arguments ?? obj.parameters ?? obj.params ?? obj.input ?? {}
  if (typeof argsRaw === 'string') {
    const raw = argsRaw.trim()
    if (!raw) argsRaw = {}
    else {
      try {
        argsRaw = JSON.parse(raw)
      } catch {
        argsRaw = { input: argsRaw }
      }
    }
  }
  if (!argsRaw || typeof argsRaw !== 'object' || Array.isArray(argsRaw)) argsRaw = {}
  return { name, args: argsRaw as Record<string, unknown> }
}

export function asCalls(value: unknown): RawCall[] {
  if (Array.isArray(value)) return value.flatMap((v) => asCalls(v))
  const one = normalizeCall(value)
  return one ? [one] : []
}

/** 从 start 处的 { 或 [ 找到配对的收尾位置，字符串和转义都跳过 */
export function balancedEnd(text: string, start: number): number {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 把模型输出的文本里夹带的工具调用剥出来。
 * 兼容四种写法：裸 JSON、``` 代码块（不限语言标记）、<tool_call> 标签、以及 JSON 数组。
 * 只认工具白名单里的名字，避免把正文里的示例 JSON 误当调用执行。
 */
export function parseTextToolCalls(text: string): { cleanText: string; calls: ToolCall[] } {
  const calls: ToolCall[] = []
  const removed: Array<[number, number]> = []

  const accept = (start: number, end: number, body: string): boolean => {
    let value: unknown
    try {
      value = JSON.parse(body.trim())
    } catch {
      return false
    }
    const found = asCalls(value)
    if (!found.length) return false
    for (const c of found) {
      calls.push({ id: `txt_${calls.length}_${Date.now()}`, name: c.name, args: c.args })
    }
    removed.push([start, end])
    return true
  }

  const overlaps = (start: number, end: number) =>
    removed.some(([s, e]) => start < e && end > s)

  // 1) <tool_call>…</tool_call>（Qwen 等模型的习惯）
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)<\/tool_call>/gi)) {
    const start = m.index ?? 0
    accept(start, start + m[0].length, m[1])
  }

  // 2) 代码块：只认无语言标记，或 tool / json / tool_call 这类标记
  for (const m of text.matchAll(/```([A-Za-z_-]*)[ \t]*\r?\n([\s\S]*?)```/g)) {
    const lang = (m[1] || '').toLowerCase()
    if (lang && !['tool', 'tools', 'json', 'json5', 'tool_call', 'toolcall'].includes(lang)) continue
    const start = m.index ?? 0
    accept(start, start + m[0].length, m[2])
  }

  // 3) 正文里的裸 JSON：必须自己占一行，且名字在工具白名单里
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== '{' && ch !== '[') continue
    if (overlaps(i, i + 1)) continue
    const end = balancedEnd(text, i)
    if (end < 0) continue

    const lineStart = text.lastIndexOf('\n', i - 1) + 1
    const nl = text.indexOf('\n', end)
    const lineEnd = nl < 0 ? text.length : nl
    const before = text.slice(lineStart, i)
    const after = text.slice(end + 1, lineEnd)
    const okBefore = before.trim() === '' || /^[\s>*+\-\d.、)）]+$/.test(before)
    const okAfter = after.trim() === '' || /^[\s，,。;；、)）】\]>"'」』]+$/.test(after)
    if (!okBefore || !okAfter) continue

    if (accept(i, end + 1, text.slice(i, end + 1))) i = end
  }

  if (!calls.length) return { cleanText: text, calls }

  // 按区间删除调用片段，剩下的才是真正要显示的文字
  let cleanText = ''
  let cursor = 0
  for (const [s, e] of removed.sort((a, b) => a[0] - b[0])) {
    if (s > cursor) cleanText += text.slice(cursor, s)
    cursor = Math.max(cursor, e)
  }
  cleanText += text.slice(cursor)
  cleanText = cleanText
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()

  return { cleanText, calls }
}
