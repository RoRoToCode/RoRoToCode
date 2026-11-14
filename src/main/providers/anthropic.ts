import type { ChatMessage, ProviderConfig, TokenUsage, ToolCall } from '../../shared/types'
import { parseArgs, RAW_ARG_KEY } from '../../shared/toolargs'
import { imageDataUrl } from '../vision'
import { explainStreamFailure, joinUrl, readError, requestSignal, sseLines } from './base'
import type { StreamOptions, StreamResult } from './base'

type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: Block[]
}

/** data:image/jpeg;base64,xxx → Claude 的 image block */
function imageBlocks(absPaths: string[]): Block[] {
  const blocks: Block[] = []
  for (const p of absPaths) {
    const url = imageDataUrl(p)
    if (!url) continue
    const m = /^data:([^;]+);base64,(.+)$/.exec(url)
    if (!m) continue
    blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
  }
  return blocks
}

/** 只保留最近一轮带图的消息（同 openai.ts，避免历史图片重复发送） */
function imageTurnIndex(messages: ChatMessage[]): number {
  let budget = 4
  for (let i = messages.length - 1; i >= 0 && budget > 0; i--, budget--) {
    if (messages[i].role === 'user' && messages[i].images?.length) return i
  }
  return -1
}

function toAnthropic(messages: ChatMessage[]): { system: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = []
  const out: AnthropicMessage[] = []
  const imageTurn = imageTurnIndex(messages)

  for (const [idx, m] of messages.entries()) {
    if (m.role === 'system') {
      systemParts.push(m.content)
      continue
    }
    if (m.role === 'tool') {
      const blocks: Block[] = [
        { type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }
      ]
      const last = out[out.length - 1]
      if (last && last.role === 'user') last.content.push(...blocks)
      else out.push({ role: 'user', content: blocks })
      continue
    }
    if (m.role === 'assistant') {
      const blocks: Block[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const call of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} })
      }
      if (!blocks.length) continue
      out.push({ role: 'assistant', content: blocks })
      continue
    }
    const forThisTurn = idx === imageTurn && m.images?.length ? imageBlocks(m.images) : []
    out.push({ role: 'user', content: [...forThisTurn, { type: 'text', text: m.content }] })
  }

  const merged: AnthropicMessage[] = []
  for (const m of out) {
    const last = merged[merged.length - 1]
    if (last && last.role === m.role) last.content.push(...m.content)
    else merged.push(m)
  }
  if (merged.length && merged[0].role !== 'user') {
    merged.unshift({ role: 'user', content: [{ type: 'text', text: '继续' }] })
  }

  return { system: systemParts.join('\n\n'), messages: merged }
}

export async function streamAnthropic(opts: StreamOptions): Promise<StreamResult> {
  const { provider, tools } = opts
  const base = provider.baseUrl.replace(/\/+$/, '')
  const { signal, done } = requestSignal(opts.signal, 10 * 60 * 1000)
  const converted = toAnthropic(opts.messages)

  const body: Record<string, unknown> = {
    model: provider.model,
    max_tokens: 8192,
    stream: true,
    temperature: provider.temperature ?? 0.2,
    messages: converted.messages
  }
  if (converted.system) body.system = converted.system
  if (tools.length) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters
    }))
  }

  let res: Response
  try {
    res = await fetch(joinUrl(base, '/v1/messages'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'anthropic-version': '2023-06-01',
        ...(provider.apiKey ? { 'x-api-key': provider.apiKey } : {})
      },
      body: JSON.stringify(body),
      signal
    })
  } catch (err) {
    done()
    throw new Error(`连接失败：${(err as Error).message}`)
  }

  if (!res.ok) {
    done()
    throw new Error(await readError(res))
  }
  if (!res.body) {
    done()
    throw new Error('响应没有数据流')
  }

  let text = ''
  const calls = new Map<number, { id: string; name: string; json: string }>()
  // Anthropic 把输入用量放在 message_start，输出用量放在 message_delta，要分开累
  let usage: TokenUsage | undefined

  try {
    for await (const payload of sseLines(res.body)) {
      let evt: {
        type?: string
        index?: number
        content_block?: { type?: string; id?: string; name?: string }
        delta?: { type?: string; text?: string; partial_json?: string }
        message?: {
          usage?: { input_tokens?: number; cache_read_input_tokens?: number }
        }
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }
        error?: { message?: string }
      }
      try {
        evt = JSON.parse(payload)
      } catch {
        continue
      }
      if (evt.type === 'error') throw new Error(evt.error?.message ?? 'Anthropic 返回错误')
      if (evt.type === 'message_start' && evt.message?.usage) {
        usage = {
          prompt: evt.message.usage.input_tokens ?? 0,
          completion: 0,
          cached: evt.message.usage.cache_read_input_tokens
        }
      }
      if (evt.type === 'message_delta' && evt.usage) {
        usage = {
          prompt: evt.usage.input_tokens ?? usage?.prompt ?? 0,
          completion: evt.usage.output_tokens ?? 0,
          cached: evt.usage.cache_read_input_tokens ?? usage?.cached
        }
      }
      if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
        calls.set(evt.index ?? 0, {
          id: evt.content_block.id ?? '',
          name: evt.content_block.name ?? '',
          json: ''
        })
      }
      if (evt.type === 'content_block_delta') {
        if (evt.delta?.type === 'text_delta' && evt.delta.text) {
          text += evt.delta.text
          opts.onText(evt.delta.text)
        }
        if (evt.delta?.type === 'input_json_delta' && evt.delta.partial_json) {
          const entry = calls.get(evt.index ?? 0)
          if (entry) entry.json += evt.delta.partial_json
        }
      }
    }
  } catch (err) {
    throw new Error(await explainStreamFailure(err, provider, signal))
  } finally {
    done()
  }

  const toolCalls: ToolCall[] = []
  for (const call of calls.values()) {
    if (!call.name) continue
    // 三条 provider 走同一个容错层：Anthropic 官方不会吐坏 JSON，
    // 但 baseUrl 指到本地代理时它就是另一个「小模型」，行为得一致
    const parsed = parseArgs(call.json)
    toolCalls.push({
      id: call.id || `tool_${Math.random().toString(36).slice(2)}`,
      name: call.name,
      args: parsed.repair === 'failed' ? { [RAW_ARG_KEY]: call.json } : parsed.args,
      ...(parsed.repair === 'none' ? {} : { argRepair: parsed.repair })
    })
  }

  return { text, toolCalls, usage }
}

export async function listAnthropicModels(provider: ProviderConfig): Promise<string[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(joinUrl(provider.baseUrl.replace(/\/+$/, ''), '/v1/models'), {
      headers: {
        'anthropic-version': '2023-06-01',
        ...(provider.apiKey ? { 'x-api-key': provider.apiKey } : {})
      },
      signal: controller.signal
    })
    if (!res.ok) throw new Error(await readError(res))
    const json = (await res.json()) as { data?: Array<{ id?: string }> }
    return (json.data ?? []).map((m) => m.id ?? '').filter(Boolean)
  } finally {
    clearTimeout(timer)
  }
}
