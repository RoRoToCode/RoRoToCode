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
  /**
   * 推理模型的思考过程（llama.cpp 的 `reasoning_content` / 部分网关的 reasoning）。
   *
   * 它不是回答正文，绝不能拼进 text：否则用户会看到几千字英文内心独白，
   * 还会把下一轮历史撑爆。留着只为判断「正文为空到底是没答，还是思考把预算吃光了」。
   */
  reasoning?: string
  /** 供应商返回的用量；本地服务不一定给，没有就是 undefined */
  usage?: TokenUsage
  /**
   * 结束原因。`length` 表示撞到输出上限被硬截断（本地 16K 窗口下 max_tokens 只有 4096，
   * 写整段代码时很容易撞上）。引擎必须据此判断「这一轮是写完了还是被切断」，
   * 否则半截代码会被当成「模型认为做完了」，任务静默结束。
   */
  finishReason?: string
  /**
   * 本次「纯生成」耗时（毫秒）：Ollama 的 eval_duration、llama.cpp 的
   * timings.predicted_ms。只算解码输出，不含排队和预填充（首字延迟）。
   * 远端 API 一般不给，界面会退回端到端墙钟估算。
   */
  genMs?: number
}

export function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}${suffix}`
}

/**
 * 「发请求前先确保本机服务在跑」的钩子。
 *
 * 用注入而不是直接 import llama.ts，有两个原因：
 * - llama.ts 依赖 electron（读 app.getPath 找模型目录），providers 层要能被
 *   单测直接引用，不能把这条依赖链带进去；
 * - 「怎么拉起本机服务」是主进程的编排逻辑，不该由传输层决定。
 *
 * 没注册钩子时（单测 / 无头脚本）就是空操作，行为与以前完全一致。
 */
type LocalWaker = (provider: ProviderConfig) => Promise<boolean>
let localWaker: LocalWaker | null = null

export function setLocalWaker(fn: LocalWaker | null): void {
  localWaker = fn
}

/**
 * 调一次唤醒。返回 false 只表示「本该叫醒但没叫醒」——
 * 不归本机管的供应商、服务本来就在跑的，都返回 true，不会误伤。
 */
export async function ensureLocalAwake(provider: ProviderConfig): Promise<boolean> {
  if (!localWaker) return true
  try {
    return await localWaker(provider)
  } catch {
    return false
  }
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

/**
 * 探一下服务还在不在。
 *
 * 只问「有没有 HTTP 响应」，不关心状态码：llama.cpp 的 `/` 会 404，
 * 但那已经足够证明进程活着。用来区分两种「流被打断」：
 * 进程没了（要用户去重启），还是进程在、只是这次请求被它自己掐了。
 */
export async function probeAlive(baseUrl: string): Promise<boolean> {
  const root = (baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/i, '')
  if (!root) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1500)
  try {
    await fetch(root, { method: 'GET', signal: controller.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 流式请求中途报错的翻译。
 *
 * 以前用户看到的是 `TypeError: terminated` / `fetch failed` —— 这是 Node 的
 * undici 内部错误，字面意思与真实原因无关，谁看了都不知道下一步该干什么。
 * 这里把它分成两类说清楚，并顺手探一下服务是否还活着（探活失败不等于服务死了，
 * 所以只用作措辞依据，不改变抛出本身）。
 */
export async function explainStreamFailure(
  err: unknown,
  provider: ProviderConfig,
  signal: AbortSignal
): Promise<string> {
  // 用户点了停止 / 看门狗超时：把我们自己写的那句中文原样带出去。
  // 注意传进来的必须是 requestSignal 造的那个内部 signal —— 只有它的 reason 里
  // 存着「已取消 / 请求超时 / 生成中断」这些原始文案。
  if (signal.aborted) {
    const own =
      (signal.reason as Error | undefined)?.message ??
      (err instanceof Error ? err.message : String(err ?? ''))
    return /已取消|超时|中断|僵死|排队/.test(own) ? own : '已取消'
  }
  const msg = err instanceof Error ? err.message : String(err ?? '')
  const cause = (err as { cause?: { message?: string; code?: string } } | null)?.cause
  const detail = `${msg} ${cause?.message ?? ''} ${cause?.code ?? ''}`.trim()

  if (/terminated|other side closed|socket hang up|ECONNRESET|aborted|premature close/i.test(detail)) {
    const alive = await probeAlive(provider.baseUrl)
    const where = provider.model ? `模型 ${provider.model}` : '本地服务'
    if (!alive) {
      return (
        `连接已中断：${provider.name} 的进程不在了（多半是崩溃、被关掉，或刚被另一个模型顶替）。\n` +
        '到「② 本地模型」看一眼状态和崩溃日志，重新加载后再试。'
      )
    }
    return (
      `连接已中断：${where} 主动关掉了这次请求，但服务本身还在。\n` +
      '常见原因：上下文超出该模型的窗口、显存/内存不够被系统杀掉、或服务正在重启。' +
      '可以把「上下文窗口」调小一档再试。'
    )
  }
  // 其它错误原样上抛，不掩盖真实原因
  return msg || '请求失败（没有拿到具体原因）'
}

export interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      /** 推理模型的思考过程：llama.cpp(deepseek 格式) / DeepSeek / 部分网关 */
      reasoning_content?: string | null
      /** 少数网关用 reasoning 这个名字 */
      reasoning?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    /** 非流式响应的正文在 message 里 */
    message?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
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
  /** llama.cpp（含 LM Studio 部分版本）在最后一帧附的解码计时，单位毫秒 */
  timings?: {
    prompt_n?: number
    prompt_ms?: number
    /** llama.cpp 报「命中的缓存 token 数」（cache_n），有的版本不给 */
    cache_n?: number
    predicted_n?: number
    predicted_ms?: number
  }
  error?: { message?: string }
}
