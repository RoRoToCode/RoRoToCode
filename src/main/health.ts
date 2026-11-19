/**
 * 供应商短期健康状态 —— 只回答一个问题：「这家刚失败过，这会儿还要不要往它身上派活？」
 *
 * 起因：远端 worker 在 `workerPool` 里是无条件 `ready: true` 的，因为远端 API
 * 不需要预热。可它刚被 429 限流时，池子照样报「就绪」，于是几路只读审查全压同一家，
 * 一起 429、全部白跑。这个模块只补这一件事：记住「最近一次失败是什么、什么时候」，
 * 冷却窗口内让 `workerPool` 把它跳过。
 *
 * 刻意做得很轻，三个边界：
 * - **不探测、不轮询**：只在真失败时记一笔，不额外发请求；
 * - **只管派活，不管重试**：主流程那次请求该重试还重试（agent.ts 里的 retryable /
 *   switchReason），那是「这一次换个时机或换一家」；这里管的是「这段时间别派新活」；
 * - **排队不算故障**：本机闸门的 BusyError 是忙不是坏，冷却它等于把一台好好的机器
 *   停掉，所以显式排除。
 */

/** 冷却时长：够躲过一次限流窗口（常见 60s/分钟桶），又不至于让 worker 长时间闲着 */
const COOLDOWN_MS = 60_000

const cooling = new Map<string, { until: number; reason: string }>()

/**
 * 哪些失败值得冷却。
 *
 * 只认「过一会儿可能会好」的：限流、超时、5xx、连不上。
 * 鉴权错（401/403）、余额（402）、模型名不存在（404）、参数错（400/413/422）都不算 ——
 * 那不是这家暂时忙，是配置或请求本身有问题，冷却它只会把问题藏起来。
 */
function coolingWorthy(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (!msg || /已取消|已中止/.test(msg)) return null
  // 本机忙是排队：等前面的活跑完就能用，停它 60 秒纯属自伤
  if (/QUEUE_FULL|QUEUE_TIMEOUT|排队/.test(msg)) return null
  const status = msg.match(/\bHTTP\s+(\d{3})\b/)
  if (status) {
    const code = Number(status[1])
    if (code === 429) return '被限流（HTTP 429）'
    if (code === 408) return '请求超时（HTTP 408）'
    if (code >= 500) return `服务端报错（HTTP ${code}）`
    return null
  }
  if (/连接失败|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(msg)) {
    return '连不上'
  }
  return null
}

/** 记一次失败。不是「暂时性」的失败会被忽略，不会误伤正常可用的 provider */
export function noteProviderFailure(id: string, err: unknown): void {
  const reason = coolingWorthy(err)
  if (!id || !reason) return
  cooling.set(id, { until: Date.now() + COOLDOWN_MS, reason })
}

/** 成功一次就解除冷却：这家的服务其实好了，没必要还晾着 */
export function noteProviderSuccess(id: string): void {
  if (id) cooling.delete(id)
}

/** 还在冷却里就返回原因和剩余秒数，否则 null（顺带把过期的清掉） */
export function providerCooling(id: string): { reason: string; seconds: number } | null {
  const hit = id ? cooling.get(id) : undefined
  if (!hit) return null
  const left = hit.until - Date.now()
  if (left <= 0) {
    cooling.delete(id)
    return null
  }
  return { reason: hit.reason, seconds: Math.ceil(left / 1000) }
}

/** 测试用：清空状态，免得用例之间互相污染 */
export function resetProviderHealth(): void {
  cooling.clear()
}
