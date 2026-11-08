import type { ChatMessage, ProviderConfig, TokenUsage, ToolCall } from '../../shared/types'
import type { ToolSpec } from '../tools/spec'
import { imageDataUrl } from '../vision'
import { idleGuard, joinUrl, readError, requestSignal, sseLines } from './base'
import type { OpenAIChunk, StreamOptions, StreamResult } from './base'

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | ContentPart[]
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

/**
 * 只保留「最近一轮带图」的那条消息的图片：
 * 刚发完图追问一句「再看一眼」还能看见，更早的轮次就别重复发 base64 了（一张就上百 KB）。
 */
function imageTurnIndex(messages: ChatMessage[]): number {
  let budget = 4
  for (let i = messages.length - 1; i >= 0 && budget > 0; i--, budget--) {
    if (messages[i].role === 'user' && messages[i].images?.length) return i
  }
  return -1
}

function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  const imageTurn = imageTurnIndex(messages)
  return messages.map((m, idx) => {
    if (m.role === 'assistant') {
      const out: OpenAIMessage = { role: 'assistant', content: m.content || '' }
      if (m.toolCalls?.length) {
        out.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
        }))
        if (!m.content) out.content = null
      }
      return out
    }
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' }
    }
    if (m.role === 'system') return { role: 'system', content: m.content }

    const urls =
      idx === imageTurn && m.images?.length
        ? m.images.map((p) => imageDataUrl(p)).filter((u): u is string => Boolean(u))
        : []
    if (!urls.length) return { role: 'user', content: m.content }

    const parts: ContentPart[] = []
    if (m.content) parts.push({ type: 'text', text: m.content })
    for (const url of urls) parts.push({ type: 'image_url', image_url: { url } })
    return { role: 'user', content: parts }
  })
}

function normalizeBase(provider: ProviderConfig): string {
  const base = provider.baseUrl.replace(/\/+$/, '')
  if (provider.kind === 'ollama' && !/\/v\d+$/.test(base)) return `${base}/v1`
  return base
}

/**
 * 每次请求都明确带上 max_tokens。
 *
 * 不带的话，各家网关的默认值差得很远：OpenRouter 会按「模型最大输出」预扣额度，
 * 像 deepseek-v4.1-flash 这种 max output 131072 的模型，一句「你好」也要先冻结
 * 十几万 tokens 的钱，余额不够就直接 402 —— 用户看到的是「我明明有额度，却用不了」。
 * 带上一个够用又不夸张的值，预扣就只按这个数算。
 *
 * 上限 8192 与 Anthropic 那条路径保持一致；上下文很小的本地模型按 1/4 留，
 * 免得把整个窗口都许给输出。
 */
function maxOutputTokens(provider: ProviderConfig): number {
  const ctx = Math.floor(Number(provider.contextWindow) || 0)
  const cap = ctx > 0 ? Math.floor(ctx / 4) : 8192
  return Math.min(Math.max(cap, 512), 8192)
}

export async function streamOpenAI(opts: StreamOptions): Promise<StreamResult> {
  const { provider, messages, tools, onText } = opts
  const base = normalizeBase(provider)
  const { signal, abort, done } = requestSignal(opts.signal, 10 * 60 * 1000)
  // 总超时管「彻底卡死」，看门狗管「一直没有输出」：后者才是排队时的真实体感
  const guard = idleGuard(abort)

  const body: Record<string, unknown> = {
    model: provider.model,
    messages: toOpenAIMessages(messages),
    stream: true,
    temperature: provider.temperature ?? 0.2,
    max_tokens: maxOutputTokens(provider),
    // 让服务端在最后一帧附带 token 用量；不认识这个参数的网关会忽略它
    stream_options: { include_usage: true }
  }
  if (tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }))
    body.tool_choice = 'auto'
  }

  let res: Response
  try {
    res = await fetch(joinUrl(base, '/chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal
    })
  } catch (err) {
    guard.stop()
    done()
    throw new Error(`连接失败：${(err as Error).message}`)
  }

  if (!res.ok) {
    guard.stop()
    done()
    throw new Error(await readError(res))
  }

  let text = ''
  const calls = new Map<number, ToolCall>()
  const rawArgs = new Map<number, string>()
  let usage: TokenUsage | undefined

  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('event-stream') || !res.body) {
    const json = (await res.json()) as OpenAIChunk
    guard.stop()
    done()
    const choice = json.choices?.[0]
    const content = choice?.delta?.content ?? ''
    if (content) {
      text += content
      onText(content)
    }
    const u = json.usage
    if (u) {
      usage = {
        prompt: u.prompt_tokens ?? 0,
        completion: u.completion_tokens ?? 0,
        cached: u.prompt_tokens_details?.cached_tokens
      }
    }
    return { text, toolCalls: [], usage }
  }

  try {
    for await (const payload of sseLines(res.body)) {
      guard.touch()
      if (payload === '[DONE]') break
      let chunk: OpenAIChunk
      try {
        chunk = JSON.parse(payload) as OpenAIChunk
      } catch {
        continue
      }
      if (chunk.error?.message) throw new Error(chunk.error.message)
      if (chunk.usage) {
        usage = {
          prompt: chunk.usage.prompt_tokens ?? 0,
          completion: chunk.usage.completion_tokens ?? 0,
          cached: chunk.usage.prompt_tokens_details?.cached_tokens
        }
      }
      const delta = chunk.choices?.[0]?.delta
      if (!delta) continue
      if (delta.content) {
        text += delta.content
        onText(delta.content)
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0
        if (tc.id) {
          calls.set(idx, { id: tc.id, name: tc.function?.name ?? '', args: {} })
        }
        const existing = calls.get(idx)
        if (existing && tc.function?.name && !existing.name) existing.name = tc.function.name
        if (tc.function?.arguments) {
          rawArgs.set(idx, (rawArgs.get(idx) ?? '') + tc.function.arguments)
        }
      }
    }
  } finally {
    guard.stop()
    done()
  }

  const toolCalls: ToolCall[] = []
  for (const [idx, call] of calls) {
    const raw = rawArgs.get(idx) ?? '{}'
    let args: Record<string, unknown> = {}
    try {
      args = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {}
    } catch {
      args = { _raw: raw }
    }
    if (!call.name) continue
    toolCalls.push({ id: call.id, name: call.name, args })
  }

  return { text, toolCalls, usage }
}

export async function listOpenAIModels(provider: ProviderConfig): Promise<string[]> {
  const base = normalizeBase(provider)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(joinUrl(base, '/models'), {
      headers: provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {},
      signal: controller.signal
    })
    if (!res.ok) throw new Error(await readError(res))
    const json = (await res.json()) as { data?: Array<{ id?: string }> }
    return (json.data ?? []).map((m) => m.id ?? '').filter(Boolean).sort()
  } finally {
    clearTimeout(timer)
  }
}

export type { ToolSpec }
