import type { ChatMessage, ProviderConfig, TokenUsage, ToolCall } from '../../shared/types'
import type { ToolSpec } from '../tools/spec'

export interface StreamOptions {
  provider: ProviderConfig
  messages: ChatMessage[]
  tools: ToolSpec[]
  signal: AbortSignal
  onText: (text: string) => void
}

export interface StreamResult {
  text: string
  toolCalls: ToolCall[]
  /** 供应商返回的用量；本地服务不一定给，没有就是 undefined */
  usage?: TokenUsage
}

export function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}${suffix}`
}

/**
 * 是不是本机地址。
 *
 * 两个地方要用同一份判断，且判断错了后果不同：
 * - 发请求时：本机服务不校验 key，远端没有 key 就必须报错；
 * - 控制面列「OpenAI 兼容入口」时：只有本机能填假 key，远端列出去等于教人填错。
 */
export function isLoopbackUrl(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])/i.test((url || '').trim())
}

export function requestSignal(
  signal: AbortSignal,
  timeoutMs: number
): { signal: AbortSignal; abort: (reason: string) => void; done: () => void } {
  const controller = new AbortController()
  const onAbort = () => controller.abort(new Error('已取消'))
  if (signal.aborted) controller.abort(new Error('已取消'))
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs)
  return {
    signal: controller.signal,
    // 交给调用方按「多久没有输出」提前掐断：总超时 10 分钟太长，用户盯着不动更难受
    abort: (reason: string) => controller.abort(new Error(reason)),
    done: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * 空闲看门狗。分两段，因为它们失败的含义不同：
 *
 * - 首字前：本地 server 收到请求后要先做 prompt eval，30K 上下文在弱卡上可能一两分钟
 *   才吐出第一帧；这段时间「没输出」是正常的。给 6 分钟，只为兜住「排队排到天荒地老」。
 * - 首字后：已经在流式输出了，突然 90 秒没有新帧，基本就是进程僵住或连接断了。
 *
 * 总超时 10 分钟兜底；这两段只是让用户更早看到真实原因，而不是在「生成中」干等。
 */
export function idleGuard(
  abort: (reason: string) => void,
  opts: { firstMs?: number; idleMs?: number } = {}
): { touch: () => void; stop: () => void } {
  const firstMs = opts.firstMs ?? 6 * 60 * 1000
  const idleMs = opts.idleMs ?? 90_000
  let last = Date.now()
  let streaming = false
  const timer = setInterval(() => {
    const limit = streaming ? idleMs : firstMs
    if (Date.now() - last <= limit) return
    abort(
      streaming
        ? `生成中断：${Math.round(idleMs / 1000)} 秒没有收到新内容，连接可能已断开。`
        : `本地模型 ${Math.round(firstMs / 60_000)} 分钟没有任何输出：可能在排队（同时只处理一个请求），` +
            '或者进程已经僵死。可以到「本地模型」看状态，必要时停掉后重试。'
    )
  }, 2_000)
  timer.unref?.()
  return {
    touch: () => {
      streaming = true
      last = Date.now()
    },
    stop: () => clearInterval(timer)
  }
}

export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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
      const trimmed = line.replace(/\r$/, '')
      if (trimmed.startsWith('data:')) {
        const payload = trimmed.slice(5).trim()
        if (payload) yield payload
      }
    }
  }
  const tail = buffer.trim()
  if (tail.startsWith('data:')) {
    const payload = tail.slice(5).trim()
    if (payload) yield payload
  }
}

/**
 * 把错误响应变成一句人能看懂的话。
 *
 * 网关（尤其 OpenRouter / 各类中转）出错时返回的是
 * `{"error":{"message":"...","code":402}}` 这一坨，原样抛给界面等于让用户读 JSON。
 * 这里优先取 message 字段；取不到才退回原始文本。
 * 前缀 `HTTP 402` 必须保留 —— agent 的自动切换靠它判断该不该换模型。
 */
export async function readError(res: Response): Promise<string> {
  let raw = ''
  try {
    raw = (await res.text()).slice(0, 2000)
  } catch {
    raw = ''
  }
  let detail = raw.trim()
  if (detail.startsWith('{')) {
    try {
      const json = JSON.parse(detail) as {
        error?: { message?: string } | string
        message?: string
        detail?: string
      }
      const inner =
        typeof json.error === 'string'
          ? json.error
          : json.error?.message ?? json.message ?? json.detail
      if (inner) detail = String(inner)
    } catch {
      // 不是完整 JSON（被截断），保持原样
    }
  }
  detail = detail.replace(/\s+/g, ' ').trim()
  if (detail.length > 400) detail = `${detail.slice(0, 400)}…`
  return `HTTP ${res.status} ${res.statusText}${detail ? `：${detail}` : ''}`
}

export interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  /** 开了 stream_options.include_usage 后，最后一帧带这个（choices 为空） */
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  error?: { message?: string }
}
