import type { ChatMessage, ProviderConfig, TokenUsage, ToolCall } from '../../shared/types'
import type { ToolSpec } from '../tools/spec'
import { imageDataUrl } from '../vision'
import { idleGuard, joinUrl, readError, requestSignal } from './base'
import type { StreamOptions, StreamResult } from './base'

/**
 * Ollama 走原生 /api/chat，而不是 OpenAI 兼容层。
 *
 * 原因只有一个：**上下文长度**。OpenAI 兼容接口（/v1/chat/completions）不认
 * options.num_ctx，Ollama 就按自己的默认值 4096 加载模型——不管配置里写的是 32K 还是 128K，
 * 实际只有 4K，程序以为还有两万多 token 可用，早期的对话会被服务端悄悄截断。
 * 原生接口能带 options.num_ctx，实测 16384 就是 16384（/api/ps 的 context_length 可查）。
 */

/** 原生 /api/chat 的消息格式：工具参数是对象，不是 JSON 字符串 */
interface NativeMsg {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]
  tool_name?: string
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>
}

interface NativeChunk {
  message?: {
    role?: string
    content?: string
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>
  }
  done?: boolean
  // 最后一帧带上的统计（Ollama 原生接口的字段名）
  prompt_eval_count?: number
  eval_count?: number
  error?: string
}

/** 用户可能把地址填成 http://127.0.0.1:11434/v1，原生接口在根上 */
function nativeRoot(provider: ProviderConfig): string {
  return provider.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
}

/** 只保留最近一轮带图的消息，和 openai.ts 的做法一致 */
function imageTurnIndex(messages: ChatMessage[]): number {
  let budget = 4
  for (let i = messages.length - 1; i >= 0 && budget > 0; i--, budget--) {
    if (messages[i].role === 'user' && messages[i].images?.length) return i
  }
  return -1
}

/** data:image/png;base64,xxx → xxx（原生接口要裸 base64） */
function bareBase64(absPath: string): string | null {
  const url = imageDataUrl(absPath)
  if (!url) return null
  const at = url.indexOf(',')
  return at >= 0 ? url.slice(at + 1) : url
}

function toNativeMessages(messages: ChatMessage[]): NativeMsg[] {
  const imageTurn = imageTurnIndex(messages)
  return messages.map((m, idx) => {
    if (m.role === 'assistant') {
      const out: NativeMsg = { role: 'assistant', content: m.content || '' }
      if (m.toolCalls?.length) {
        out.tool_calls = m.toolCalls.map((c) => ({
          function: { name: c.name, arguments: c.args ?? {} }
        }))
      }
      return out
    }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        ...(m.toolName ? { tool_name: m.toolName } : {})
      }
    }
    if (m.role === 'system') return { role: 'system', content: m.content }

    const imgs =
      idx === imageTurn && m.images?.length
        ? m.images.map(bareBase64).filter((b): b is string => Boolean(b))
        : []
    return {
      role: 'user',
      content: m.content,
      ...(imgs.length ? { images: imgs } : {})
    }
  })
}

/** NDJSON（每行一个 JSON），Ollama 流式返回就是这个格式 */
async function* jsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const line of parts) {
      const trimmed = line.trim()
      if (trimmed) yield trimmed
    }
  }
  const tail = buffer.trim()
  if (tail) yield tail
}

const ctxCache = new Map<string, { max: number; at: number }>()
const CTX_TTL = 10 * 60 * 1000

/**
 * 模型训练时的最大上下文：/api/show 的 model_info 里有 `<架构>.context_length`。
 * 拿不到就返回 0，表示「不知道，按配置来」。
 */
async function modelMaxCtx(root: string, model: string): Promise<number> {
  const key = `${root}|${model}`
  const hit = ctxCache.get(key)
  if (hit && Date.now() - hit.at < CTX_TTL) return hit.max

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(joinUrl(root, '/api/show'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: controller.signal
    })
    if (!res.ok) return 0
    const json = (await res.json()) as { model_info?: Record<string, unknown> }
    const info = json.model_info ?? {}
    let max = 0
    for (const [k, v] of Object.entries(info)) {
      if (!k.endsWith('.context_length')) continue
      const n = Number(v)
      // 优先取和架构同名的那条（例如 qwen2.context_length），否则取最大的
      if (Number.isFinite(n) && n > 0) max = Math.max(max, Math.floor(n))
    }
    if (max > 0) ctxCache.set(key, { max, at: Date.now() })
    return max
  } catch {
    return 0
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 实际要请求的 num_ctx：取配置里的上下文窗口，但不超过模型自己支持的上限。
 * 太大不会更聪明，只会白占显存；太小则会静默丢历史。
 */
export async function ollamaNumCtx(provider: ProviderConfig): Promise<number> {
  const want = Math.round(provider.contextWindow || 8192)
  const max = await modelMaxCtx(nativeRoot(provider), provider.model)
  const n = max > 0 ? Math.min(want, max) : want
  return Math.max(2048, Math.min(n, 262144))
}

export async function streamOllama(opts: StreamOptions): Promise<StreamResult> {
  const { provider, messages, tools, onText } = opts
  const root = nativeRoot(provider)
  const { signal, abort, done } = requestSignal(opts.signal, 10 * 60 * 1000)
  // Ollama 也是单模型排队：一直没输出时，3 分钟就明说，别让人干等 10 分钟
  const guard = idleGuard(abort)
  const numCtx = await ollamaNumCtx(provider)

  const body: Record<string, unknown> = {
    model: provider.model,
    messages: toNativeMessages(messages),
    stream: true,
    options: {
      temperature: provider.temperature ?? 0.2,
      num_ctx: numCtx
    }
  }
  if (tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }))
  }

  let res: Response
  try {
    res = await fetch(joinUrl(root, '/api/chat'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/x-ndjson',
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
  if (!res.body) {
    guard.stop()
    done()
    return { text: '', toolCalls: [], usage: undefined }
  }

  let text = ''
  const toolCalls: ToolCall[] = []
  const stamp = Date.now().toString(36)
  let usage: TokenUsage | undefined

  try {
    for await (const line of jsonLines(res.body)) {
      guard.touch()
      let chunk: NativeChunk
      try {
        chunk = JSON.parse(line) as NativeChunk
      } catch {
        continue
      }
      if (chunk.error) throw new Error(chunk.error)
      if (chunk.done && (chunk.prompt_eval_count || chunk.eval_count)) {
        usage = { prompt: chunk.prompt_eval_count ?? 0, completion: chunk.eval_count ?? 0 }
      }
      const msg = chunk.message
      if (msg?.content) {
        text += msg.content
        onText(msg.content)
      }
      for (const tc of msg?.tool_calls ?? []) {
        const name = tc.function?.name
        if (!name) continue
        let args: Record<string, unknown> = {}
        const raw = tc.function?.arguments
        if (typeof raw === 'string') {
          try {
            args = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {}
          } catch {
            args = { _raw: raw }
          }
        } else if (raw && typeof raw === 'object') {
          args = raw as Record<string, unknown>
        }
        toolCalls.push({ id: `call_${stamp}_${toolCalls.length}`, name, args })
      }
      if (chunk.done) break
    }
  } finally {
    guard.stop()
    done()
  }

  return { text, toolCalls, usage }
}
