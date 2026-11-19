import type { ChatMessage, ProviderConfig, TokenUsage, ToolCall } from '../../shared/types'
import { samplingBody } from '../../shared/chatbody'
import { parseArgs, RAW_ARG_KEY } from '../../shared/toolargs'
import type { ToolSpec } from '../tools/spec'
import { imageDataUrl } from '../vision'
import { outputBudget, timeoutForOutput } from './budget'
import { requestTokens } from '../../shared/tokens'
import { ensureLocalAwake, explainStreamFailure, guardFor, joinUrl, readError, requestSignal, sseLines } from './base'
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
 * 具体给多少不再写死在这里：`budget.outputBudget()` 按「这次请求实际还剩多少窗口」
 * 和「本地/云端各愿意给多少」算。以前那个 16384 常量有两个毛病 ——
 * 不知道 prompt 有多大（55K 历史 + 16K 输出直接把窗口撑爆），也没法配。
 */
function maxOutputTokens(provider: ProviderConfig, promptTokens: number, escalate = false): number {
  return outputBudget(provider, promptTokens, escalate)
}

export async function streamOpenAI(opts: StreamOptions): Promise<StreamResult> {
  const { provider, messages, tools, onText } = opts
  /**
   * 本地服务可能已被空闲卸载：先叫醒再发请求。
   *
   * 必须放在 requestSignal 之前 —— 冷加载要几秒到几十秒，这段时间不该算进
   * 「这一轮回答」的 10 分钟超时里，否则「睡久了 + 长任务」会被误判超时。
   * 非本机 / 非 llama.cpp 的供应商这里直接返回，没有额外开销。
   */
  if (!(await ensureLocalAwake(provider))) {
    /**
     * 叫不醒就别把请求发出去。让 fetch 去撞「连接被拒」，用户看到的是
     * `fetch failed` —— 和真实原因（模型文件没了 / 显存不够 / 服务起不来）
     * 差着十万八千里，还得自己去猜。这里直接把方向指对。
     */
    throw new Error(
      `本地模型没起来：${provider.name} 的服务不在，自动重新加载也失败了。\n` +
        '到「② 本地模型」看一眼状态和崩溃日志（常见原因：模型文件被删、显存不够、端口被别的程序占用），' +
        '重新加载后再发一次。'
    )
  }
  const base = normalizeBase(provider)
  /**
   * 预算要按「这次真的发出去多少」算。
   * 图片附件已经在 messages 里（imageDataUrl），按字符估算对视觉输入偏小，
   * 所以图上再留 1/8 窗口的余量 —— 视觉 token 从来不是按字符数算的。
   */
  const promptTokens = requestTokens(messages, tools) + (messages.some((m) => m.images?.length) ? Math.floor(Number(provider.contextWindow || 0) / 8) : 0)
  const maxOut = maxOutputTokens(provider, promptTokens, opts.escalate)
  const { signal, abort, done } = requestSignal(opts.signal, timeoutForOutput(maxOut))
  // 总超时管「彻底卡死」，看门狗管「一直没有输出」：后者才是排队时的真实体感。
  // 两段的时限按 provider 分级（本机给预填充留足、云端 150 秒），见 guardLimits
  const guard = guardFor(provider, abort, {
    onWait: opts.onWait ? (ms) => opts.onWait?.({ waitedMs: ms, promptTokens }) : undefined
  })

  const body: Record<string, unknown> = {
    model: provider.model,
    messages: toOpenAIMessages(messages),
    stream: true,
    temperature: provider.temperature ?? 0.2,
    max_tokens: maxOut,
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
  // 采样与输出格式：留空 = 不发送（三条规则见 shared/chatbody.ts）
  Object.assign(body, samplingBody(provider, tools.length > 0))

  let res: Response
  if (process.env.RORO_DUMP_REQ) {
    // 临时诊断：把真正发出去的请求落盘，用来定位「写一半就停」是请求差异还是模型行为
    try {
      const fsx = await import('node:fs')
      fsx.writeFileSync(`${process.env.RORO_DUMP_REQ}/req-${Date.now()}.json`, JSON.stringify(body))
    } catch {
      // 诊断失败不影响主流程
    }
  }
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
  // 思考过程只累计、绝不推给界面，也不算进回答正文
  let reasoning = ''
  /**
   * 已经吐出来的帧数：当作「近似生成 token 数」报给界面做实时进度。
   * llama.cpp 是严格一帧一 token，所以本地模型上这个数相当准；在线网关
   * 一帧可能含多个 token，只能当量级看，界面也按「约」展示。
   */
  let genUnits = 0
  const calls = new Map<number, ToolCall>()
  const rawArgs = new Map<number, string>()
  let usage: TokenUsage | undefined
  /** 结束原因（stop / length / tool_calls…）：length 意味着输出被硬截断 */
  let finishReason: string | undefined
  /** llama.cpp 给的纯解码耗时；远端服务没有这个字段就留空 */
  let genMs: number | undefined
  const decodeMs = (n?: number): number | undefined =>
    typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined

  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('event-stream') || !res.body) {
    let json: OpenAIChunk
    try {
      json = (await res.json()) as OpenAIChunk
    } catch (err) {
      guard.stop()
      done()
      // 这里同样可能撞上「响应体读到一半连接断了」，走同一套翻译
      throw new Error(await explainStreamFailure(err, provider, signal))
    }
    guard.stop()
    done()
    const choice = json.choices?.[0]
    const msg = choice?.message ?? choice?.delta
    const content = msg?.content ?? ''
    if (content) {
      text += content
      onText(content)
    }
    reasoning += msg?.reasoning_content ?? msg?.reasoning ?? ''
    const u = json.usage
    if (u) {
      usage = {
        prompt: u.prompt_tokens ?? 0,
        completion: u.completion_tokens ?? 0,
        cached: u.prompt_tokens_details?.cached_tokens,
        promptN: decodeMs(json.timings?.prompt_n),
        promptMs: decodeMs(json.timings?.prompt_ms)
      }
    }
    genMs = decodeMs(json.timings?.predicted_ms)
    return {
      text,
      toolCalls: [],
      usage,
      reasoning: reasoning || undefined,
      genMs,
      finishReason: choice?.finish_reason ?? undefined
    }
  }

  try {
    for await (const payload of sseLines(res.body)) {
      /**
       * 这里**不能**无条件 guard.touch()。
       *
       * llama.cpp 在 prefill 之前会先发一个只有 role、没有 content 的帧；把它当成
       * 「已经开始流式输出」，看门狗就切到「90 秒没有新内容 = 连接断了」这一段，
       * 而 prefill 本身要几分钟 —— 我们自己把请求掐了，上层再重发，于是永远到不了。
       * 只有拿到真正的正文 / 思考 / 工具参数，才算「活过来了」。
       */
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
          cached: chunk.usage.prompt_tokens_details?.cached_tokens,
          promptN: decodeMs(chunk.timings?.prompt_n),
          promptMs: decodeMs(chunk.timings?.prompt_ms)
        }
      }
      // 计时帧通常跟 usage 在同一帧、且 choices 为空，必须放在 continue 之前读
      genMs = decodeMs(chunk.timings?.predicted_ms) ?? genMs
      /**
       * 结束原因要先收：最后一帧往往只有 finish_reason、没有 delta，
       * 放在 `if (!delta) continue` 之后会被整帧丢掉，截断也就无从判断。
       */
      const reason = chunk.choices?.[0]?.finish_reason
      if (reason) finishReason = reason
      const delta = chunk.choices?.[0]?.delta
      if (!delta) continue
      if (delta.content) {
        text += delta.content
        guard.touch()
        onText(delta.content)
        genUnits++
      }
      // 推理模型（MiMo / DeepSeek-R1 蒸馏等）把思考单独放在这个字段。
      // 忽略它会导致「正文一直空 → 触发空白重试 → 用户以为加载失败」。
      const thinking = delta.reasoning_content ?? delta.reasoning
      if (thinking) {
        reasoning += thinking
        // 思考也是真的在产出：模型已经过了 prefill，不能再用「首字前」的时限去掐它
        guard.touch()
        genUnits++
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
          // 写文件/跑命令的耗时全在这些参数里，只数正文会让进度一直停在 0
          guard.touch()
          genUnits++
        }
      }
      if (genUnits > 0) opts.onProgress?.(genUnits)
    }
  } catch (err) {
    // undici 的 `TypeError: terminated` 不能直接甩给用户（见 explainStreamFailure）
    throw new Error(await explainStreamFailure(err, provider, signal))
  } finally {
    guard.stop()
    done()
  }

  const toolCalls: ToolCall[] = []
  for (const [idx, call] of calls) {
    if (!call.name) continue
    // 本地小模型的 arguments 经常不是合法 JSON，交给容错层救一次。
    // 救不回来时把原文挂在 _raw 上：模型在下一轮能看到自己写了什么，
    // 而不是对着一个空参数瞎猜。
    const raw = rawArgs.get(idx) ?? '{}'
    const parsed = parseArgs(raw)
    toolCalls.push({
      id: call.id,
      name: call.name,
      args: parsed.repair === 'failed' ? { [RAW_ARG_KEY]: raw } : parsed.args,
      ...(parsed.repair === 'none' ? {} : { argRepair: parsed.repair })
    })
  }

  return { text, toolCalls, usage, reasoning: reasoning || undefined, genMs, finishReason }
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
