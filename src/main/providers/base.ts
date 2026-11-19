import type { ChatMessage, ProviderConfig, TokenUsage, ToolCall } from '../../shared/types'
import type { ToolSpec } from '../tools/spec'
import { log } from '../log'

export interface StreamOptions {
  provider: ProviderConfig
  messages: ChatMessage[]
  tools: ToolSpec[]
  signal: AbortSignal
  onText: (text: string) => void
  /**
   * 已经生成出来的量（近似 token 数），随流式帧持续回调。
   *
   * 为什么需要它：模型写大文件时，一整次调用可能吐七八千 token、跑几分钟，
   * 而这期间**既没有正文 delta、也没有 usage**，界面上的用量数字一动不动 ——
   * 看起来就像卡死了。把生成量实时报上去，界面才能显示「正在生成 · 已 3.2K」。
   *
   * 含工具参数的帧也算：写文件的耗时全在参数里，只数正文会一直是 0。
   * 引擎不要求精确，界面按「约」展示即可。
   */
  onProgress?: (generated: number) => void
  /**
   * 「还一个字都没拿到」期间的定期上报（毫秒）。
   *
   * 本地大提示的预填充可能几分钟，这期间没有任何 delta。没有这个回调，界面
   * 从「发出去」到「第一个字」之间是完全静默的，用户只能看到一个不动的计时器。
   */
  onWait?: (info: { waitedMs: number; promptTokens: number }) => void
  /** 这一发是「撞到输出上限后的升档重试」：把输出预算抬到该模型能给的最大值。
   * 由引擎决定何时升（只升一次），供应商只负责按新预算发。
   */
  escalate?: boolean
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
 * 看门狗的两段时限，按「请求打到哪儿」分级。
 *
 * 首字前那一段的含义是「多久没动静就该判死」：本地 llama.cpp 要先做 prompt eval，
 * 弱卡上三十分钟上下文几分钟不出字是正常的，所以给足 10 分钟；而云端网关正常情况下
 * 10 秒内就吐第一个字，10 分钟一个字没有基本等于连接死了 —— 现场就出现过一次
 * 20 分钟的单请求挂起（14:41 到 15:01 没有任何消息，最后由总超时收尾）。
 * 云端给 150 秒：既容得下网关排队与长提示 prefill，又不会让人对着转圈等十分钟。
 *
 * 首字后那一段两边一致：90 秒没有新帧，流基本已经断了。
 */
export function guardLimits(provider: ProviderConfig): {
  firstMs: number
  idleMs: number
  local: boolean
} {
  const local = isLoopbackUrl(provider.baseUrl)
  return {
    firstMs: local ? 10 * 60 * 1000 : 150_000,
    idleMs: 90_000,
    local
  }
}

/** 把毫秒说成人话：150000 → 「2.5 分钟」，30000 → 「30 秒」 */
function span(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`
  const min = ms / 60_000
  return `${Number.isInteger(min) ? min : min.toFixed(1)} 分钟`
}

/**
 * 空闲看门狗。分两段，因为它们失败的含义不同：
 *
 * - 首字前：本地 server 收到请求后要先做 prompt eval，30K 上下文在弱卡上可能几分钟
 *   才吐出第一帧；这段时间「没输出」是正常的。
 * - 首字后：已经在流式输出了，突然 90 秒没有新帧，基本就是进程僵住或连接断了。
 *
 * 总超时 10 分钟兜底；这两段只是让用户更早看到真实原因，而不是在「生成中」干等。
 *
 * **`touch()` 只能在真的拿到内容时调用。** 这一条是被实测逼出来的：llama.cpp 在做
 * prefill 之前会先发一个只有 role、没有内容的帧（keep-alive）。以前收到任何一帧都
 * `touch()`，于是刚进 prefill 就被当成「已经在流式输出」，接着 90 秒没帧 → 判「生成中断」
 * → 上层重试 → 重新 prefill 又超时。现场表现就是「请求反复重启、decoded 停在 40、
 * 十几分钟一声不响」。空帧必须只更新心跳，不改变段位。
 *
 * `onWait` 用来把「还没出第一帧」这件事定期告诉界面：本地长上下文预填充本来就慢，
 * 用户看到的应该是「在读了 90 秒」，而不是一个转圈的计时器。
 */
export function idleGuard(
  abort: (reason: string) => void,
  opts: {
    firstMs?: number
    idleMs?: number
    /** 本机服务：首字超时的原因说明要指向「预填充」，而不是「网关」。不传按本机算 */
    local?: boolean
    /** 首字前，每隔一段时间回调一次「已经等了多久」 */
    onWait?: (waitedMs: number) => void
    /** 上报间隔，默认 20 秒 */
    waitEveryMs?: number
    /** 看门狗的检查间隔，默认 2 秒（调小只为让单测跑得快，生产不必改） */
    tickMs?: number
    /**
     * 真的掐断时回调一次（不会重复）。
     * 只用于观测 —— 现场那次 20 分钟挂起，日志里只有一句「请求超时」，
     * 看不出它到底是总超时还是看门狗，等于断掉了一半线索。
     */
    onTrip?: (info: { phase: 'first' | 'idle'; waitedMs: number; reason: string }) => void
  } = {}
): { touch: () => void; stop: () => void } {
  const firstMs = opts.firstMs ?? 10 * 60 * 1000
  const idleMs = opts.idleMs ?? 90_000
  const waitEveryMs = opts.waitEveryMs ?? 20_000
  const tickMs = opts.tickMs ?? 2_000
  const startedAt = Date.now()
  let last = Date.now()
  let streaming = false
  let lastWaitAt = 0
  const timer = setInterval(() => {
    const elapsed = Date.now() - last
    if (!streaming && opts.onWait && elapsed >= waitEveryMs && Date.now() - lastWaitAt >= waitEveryMs) {
      lastWaitAt = Date.now()
      opts.onWait(Date.now() - startedAt)
    }
    const limit = streaming ? idleMs : firstMs
    if (elapsed <= limit) return
    /**
     * 掐一次就收手。
     *
     * 以前这里不停表：controller 已经 abort 了，定时器还每 2 秒再调一次 abort，
     * 单测里能连打九次。现在加了 onTrip，不停表就会刷出一串重复日志。
     */
    clearInterval(timer)
    const reason = streaming
      ? `生成中断：${span(idleMs)}没有收到新内容，连接可能已断开。`
      : (opts.local ?? true)
        ? `等了 ${span(firstMs)}仍然没有拿到第一个字：本地模型多半卡在预填充上` +
          '（提示太长、显存不够，或进程僵死 / 在排队）。这一轮已终止，不会再自动重发同一份请求。'
        : `等了 ${span(firstMs)}仍然没有拿到第一个字：云端服务没有响应` +
          '（网关排队、限流，或连接已经断在半路）。这一轮已终止，不会再自动重发同一份请求。'
    opts.onTrip?.({ phase: streaming ? 'idle' : 'first', waitedMs: elapsed, reason })
    abort(reason)
  }, tickMs)
  timer.unref?.()
  return {
    touch: () => {
      streaming = true
      last = Date.now()
    },
    stop: () => clearInterval(timer)
  }
}

/**
 * 按 provider 建一个带日志的看门狗。
 *
 * 三条流式路径（openai / ollama / anthropic）都从这里拿，避免又出现
 * 「三条路各写一套阈值」—— 之前就是这样：云端首字等 10 分钟，跟总超时一样长，
 * 谁先到全看运气，日志里只剩一句「请求超时」。
 */
export function guardFor(
  provider: ProviderConfig,
  abort: (reason: string) => void,
  extra: { onWait?: (waitedMs: number) => void } = {}
): { touch: () => void; stop: () => void } {
  const limits = guardLimits(provider)
  return idleGuard(abort, {
    ...limits,
    onWait: extra.onWait,
    onTrip: (info) => {
      log(
        'warn',
        'provider',
        `${provider.name}｜${provider.model}：看门狗掐断（${info.phase === 'first' ? '首字前' : '流式中'}，` +
          `静默 ${Math.round(info.waitedMs / 1000)} 秒）${info.reason.split('：')[0]}`
      )
    }
  })
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
 * 给一次模型调用的失败打上「是哪个模型」的标签。
 *
 * 现场问题：配置里同时躺着好几条模型（本地 llama.cpp、若干云端 NIM/中转），
 * 失败冒泡到界面时只剩一句裸的 `HTTP 401 Unauthorized` —— 到底是哪家、哪个 Key
 * 出问题，用户得自己一条条试。这里在错误最外层补上供应商名 + 模型名。
 *
 * 两条硬约束：
 *  1. 原文必须完整保留在最末尾。agent 的 switchReason / retryable / isWarmingUp
 *     全靠消息里的 `HTTP 401` 这类子串判断，改一个字就会让自动切换/重试失灵。
 *  2. 幂等。chatWithFallback 可能对同一个错误做两次包装（换模型前 + 抛出前），
 *     重复调用不能把标签越叠越长。
 */
export function modelError(provider: ProviderConfig, err: unknown): Error {
  const src = err instanceof Error ? err : new Error(String(err ?? '未知错误'))
  const msg = src.message || '未知错误'
  const label = `「${provider.name}${provider.model ? ` · ${provider.model}` : ''}」`
  if (msg.startsWith(label)) return src

  // 401/403 给出可操作的下一步：这两类几乎都是 Key 的问题，值得直接说破。
  let advice = ''
  const status = msg.match(/\bHTTP\s+(401|403)\b/)
  if (status) {
    const keyKind = /anthropic/i.test(provider.kind ?? '') ? 'Anthropic API Key' : 'API Key'
    advice = `。多半是这条模型的 ${keyKind} 无效或已过期，到设置里更新后再试`
  }

  const out = new Error(`${label}${msg}${advice}`)
  out.cause = src
  return out
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
    /**
     * 「第一个字」必须在这个白名单里：首字超时那句话里没有「超时 / 中断」字样，
     * 漏掉它就退化成一句「已取消」，用户会以为是自己点了停止。
     */
    return /已取消|超时|中断|僵死|排队|第一个字/.test(own) ? own : '已取消'
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
