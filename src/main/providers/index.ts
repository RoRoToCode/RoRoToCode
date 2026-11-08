import type { ProviderConfig } from '../../shared/types'
import type { ToolSpec } from '../tools/spec'
import type { StreamResult } from './base'
import { isLoopbackUrl } from './base'
import { acquireSlot, markHolding } from '../gate'
import { listOpenAIModels, streamOpenAI } from './openai'
import { listAnthropicModels, streamAnthropic } from './anthropic'
import { ollamaNumCtx, streamOllama } from './ollama'
import type { ChatMessage } from '../../shared/types'

export interface ChatRequest {
  provider: ProviderConfig
  messages: ChatMessage[]
  tools: ToolSpec[]
  signal: AbortSignal
  onText: (text: string) => void
}

/** 本机地址不校验 key：llama.cpp / Ollama / LM Studio 都不看这个字段 */
const isLoopback = isLoopbackUrl

export async function chat(request: ChatRequest): Promise<StreamResult> {
  const provider = request.provider
  if (!provider.model) throw new Error('还没有选择模型')
  // 没填 Key 就别发请求了：远端会回 401「No auth credentials found」，
  // 这行字对着界面看毫无线索，用户只会以为是整个功能坏了。
  // 这里也不触发自动切换 —— 配置问题该让人看见，悄悄换一家等于把问题藏起来。
  if (!(provider.apiKey ?? '').trim() && !isLoopback(provider.baseUrl)) {
    throw new Error(`「${provider.name}」还没有填 API Key，到「模型 API」里补上再发`)
  }
  // 本机服务的槽位有限：先排队拿槽，排不上就明确报错，别让请求无声挂着。
  // 只对本机地址生效 —— 远端 API 没有槽位概念，而且不该为了探 /props
  // 每次都往人家服务器发一个多余的请求（还可能被计费 / 触发风控）。
  const release = isLoopback(provider.baseUrl) ? await acquireSlot(provider.baseUrl, request.signal) : null
  if (!release) return dispatch(request)
  try {
    return await markHolding(() => dispatch(request))
  } finally {
    release()
  }
}

function dispatch(request: ChatRequest): Promise<StreamResult> {
  const provider = request.provider
  if (provider.kind === 'anthropic') {
    return streamAnthropic({
      provider: request.provider,
      messages: request.messages,
      tools: request.tools,
      signal: request.signal,
      onText: request.onText
    })
  }
  // Ollama 走原生接口，这样才能带上 num_ctx（OpenAI 兼容层会忽略它，默认只给 4096）
  if (request.provider.kind === 'ollama') {
    return streamOllama({
      provider: request.provider,
      messages: request.messages,
      tools: request.tools,
      signal: request.signal,
      onText: request.onText
    })
  }
  return streamOpenAI({
    provider: request.provider,
    messages: request.messages,
    tools: request.tools,
    signal: request.signal,
    onText: request.onText
  })
}

/**
 * 本机 llama.cpp 服务真正开了多大窗口。
 *
 * llama-server 的 `/props` 会回报 `default_generation_settings.n_ctx`。
 * 配置里记的 16384 只是「启动时我想要多少」，用户手动带 `-c 4096` 起服务、
 * 或者显存不够被降过档时，配置就是错的，程序会按错的值算预算，
 * 于是不断出现 `request (16566 tokens) exceeds the available context size (16384 tokens)`。
 */
async function llamaServerCtx(baseUrl: string): Promise<number> {
  const base = (baseUrl || '').trim().replace(/\/+$/, '').replace(/\/v\d+$/, '')
  if (!base) return 0
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 1200)
  try {
    const res = await fetch(`${base}/props`, { signal: ctl.signal })
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      return 0
    }
    const json = (await res.json()) as {
      default_generation_settings?: { n_ctx?: number }
      n_ctx?: number
    }
    const n = Math.round(Number(json.default_generation_settings?.n_ctx ?? json.n_ctx ?? 0))
    return Number.isFinite(n) && n >= 512 ? n : 0
  } catch {
    // 不是 llama.cpp（LM Studio / vLLM / 中转站）就会 404 或超时，忽略
    return 0
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 实际可用的上下文窗口：Ollama 会被模型自身上限截断，
 * 本机 llama.cpp 以服务端真实开的为准，
 * 历史预算必须按真实值算，否则又会出现「程序以为还有两万，服务端只有八千」。
 */
export async function effectiveContextWindow(provider: ProviderConfig): Promise<number> {
  const configured = Math.max(0, Math.round(Number(provider.contextWindow) || 0))
  if (provider.kind === 'ollama') {
    try {
      return await ollamaNumCtx(provider)
    } catch {
      return configured
    }
  }
  // 只有本机服务才值得探一下：远端网关没有 /props，白等一次超时
  if (isLoopback(provider.baseUrl)) {
    const real = await llamaServerCtx(provider.baseUrl)
    // 服务端亲口报的窗口才是真的：条目里写的那个值只是「启动它时想开多大」，
    // 用户手工用更大的 -c 起服务时，不该被旧配置反过来压小
    if (real > 0) return real
  }
  return configured
}

export async function listModels(provider: ProviderConfig): Promise<string[]> {
  if (provider.kind === 'anthropic') return listAnthropicModels(provider)
  return listOpenAIModels(provider)
}
