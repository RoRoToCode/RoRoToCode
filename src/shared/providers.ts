import type { LocalRuntimeKind, ProviderConfig } from './types'

/**
 * 供应商归属判断。
 *
 * 以前「这是不是 llama.cpp」是靠 `/:8080\b/` 正则认的，散在七八个文件里 ——
 * 结果就是端口一改，整个软件的判断全歪。现在统一走这里：
 * 优先看配置里的 `runtime` 字段，老配置才回退到 id / 端口。
 */

/** llama.cpp 默认端口；多实例从它开始往后排 */
export const LLAMA_PORT = 8080
/** 允许自动分配的端口序列：一台机器最多四张卡跑四个实例，够用 */
export const LLAMA_PORTS = [8080, 8081, 8082, 8083] as const

export function portOfUrl(baseUrl: string): number {
  try {
    const n = Number(new URL((baseUrl || '').trim()).port)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

export function isLoopbackUrl(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test((url || '').trim())
}

/** 这一条是不是本程序托管的 llama.cpp 实例 */
export function isLlamaProvider(p: ProviderConfig | null | undefined): boolean {
  if (!p) return false
  if (p.runtime) return p.runtime === 'llama'
  // 老配置没有 runtime 字段：按 id 或「本机 + 默认端口段」认领
  if (p.id === 'llamacpp' || /^llamacpp[-_]/i.test(p.id)) return true
  if (!isLoopbackUrl(p.baseUrl)) return false
  const port = portOfUrl(p.baseUrl)
  return (LLAMA_PORTS as readonly number[]).includes(port)
}

/**
 * llama.cpp 实例端口：配置里手动写了就用，否则从 baseUrl 里读，最后退回 8080。
 * 注意这只是「首选端口」，启动前还会真实探测并自动避让（见 main/portprobe.ts）。
 */
export function llamaPortOf(p: ProviderConfig | null | undefined): number {
  if (!p) return LLAMA_PORT
  const own = Number(p.port)
  if (Number.isFinite(own) && own >= 1024 && own <= 65535) return Math.round(own)
  const fromUrl = portOfUrl(p.baseUrl)
  if (fromUrl >= 1024 && fromUrl <= 65535) return fromUrl
  return LLAMA_PORT
}

/**
 * 供应商 → Ollama / LM Studio；llama.cpp 和远程 API 都返回 null
 * （llama.cpp 由本程序自己管进程，不走「卸载模型」这条命令路径）。
 */
export function runtimeKindOf(p: ProviderConfig | null | undefined): LocalRuntimeKind | null {
  if (!p) return null
  if (p.runtime) return p.runtime === 'llama' ? null : p.runtime
  if (isLlamaProvider(p)) return null
  if (p.id === 'lmstudio') return 'lmstudio'
  if (p.id === 'ollama') return 'ollama'
  if (!isLoopbackUrl(p.baseUrl)) return null
  const port = portOfUrl(p.baseUrl)
  // LM Studio 的端口会被它自己换：默认 1234，占用了就 1235
  if (port === 1234 || port === 1235) return 'lmstudio'
  if (port === 11434) return 'ollama'
  return null
}

/**
 * 自动备用链：设置页不再提供「作为备用模型」勾选，改由这里给答案。
 *
 * 顺序与边界都有讲究：
 * - 显式勾过 fallback 的排最前，老配置的行为不变（包括用户主动指定的在线 API）；
 * - 其余只自动纳入**本地**供应商：本机模型互为兜底不额外花钱，远程 API 绝不自动切，
 *   否则主模型一次 5xx 可能悄悄产生一笔账单；
 * - worker 角色是子代理专用，不能接主对话；fallback === false 是显式排除；
 * - 内置 core 兜底由调用方追加，不在这里管，避免和 CORE_PROVIDER_ID 耦合。
 */
export function fallbackCandidates(
  providers: ProviderConfig[],
  primaryId: string
): ProviderConfig[] {
  const explicit: ProviderConfig[] = []
  const local: ProviderConfig[] = []
  for (const p of providers) {
    if (p.id === primaryId || !p.model?.trim() || p.fallback === false || p.role === 'worker') continue
    if (p.fallback === true) explicit.push(p)
    else if (isLlamaProvider(p) || isLoopbackUrl(p.baseUrl)) local.push(p)
  }
  return [...explicit, ...local]
}

/**
 * 设备串 → 设备清单。
 *
 * 单卡是 `CUDA1`，合并多卡是 `CUDA0,CUDA1`（逗号是 llama.cpp `-dev` 自己的语法）。
 * 以前这里只有「一个设备名」的概念，于是 `CUDA0,CUDA1` 会一路静默退化成 0 号卡 ——
 * 体检、显存采样、性能分档全都按第一张算，合并模式下每个数都是错的。
 *
 * 顺手兼容空格 / 分号分隔和重复项：用户手填时很难保证格式。
 */
export function deviceList(device: string | null | undefined): string[] {
  const raw = (device ?? '').trim()
  if (!raw) return []
  const out: string[] = []
  for (const part of raw.split(/[,;\/\s]+/)) {
    const d = part.trim()
    if (!d) continue
    if (!out.some((x) => x.toLowerCase() === d.toLowerCase())) out.push(d)
  }
  return out
}

/** 是不是「多张卡跑同一个模型」 */
export function isMultiDevice(device: string | null | undefined): boolean {
  return deviceList(device).filter((d) => !/^cpu$/i.test(d)).length > 1
}

/** 清单 → 规范化设备串（去重、逗号连接）；空清单返回空串 */
export function deviceJoin(list: Array<string | null | undefined>): string {
  return deviceList(list.filter(Boolean).join(',')).join(',')
}

/**
 * 两条实例会不会抢同一块卡。
 *
 * 「自动」（空串）视为**占用全部卡**：不传 `-dev` 时 llama.cpp 会自己往所有卡上放，
 * 所以它和任何绑卡实例都算冲突 —— 这正是 startLlama 里「起新实例前先停掉自动实例」
 * 那条规则的来历。多卡合并实例与单卡实例只要有一张卡重叠，同样是冲突。
 */
export function deviceClash(a: string | null | undefined, b: string | null | undefined): boolean {
  const la = deviceList(a)
  const lb = deviceList(b)
  if (!la.length || !lb.length) return true
  const low = new Set(la.map((x) => x.toLowerCase()))
  return lb.some((x) => low.has(x.toLowerCase()))
}

/** 从 "CUDA1" 里取卡号；多卡合并取第一张。取不到按 0 处理 */
export function deviceIndex(device: string | null | undefined): number {
  const first = deviceList(device)[0] ?? ''
  const m = first.match(/^(?:cuda|vulkan|rocm|hip|metal)(\d+)$/i)
  return m ? Number(m[1]) : 0
}

/** 设备串里所有 GPU 的卡号（CPU 不算，顺序保留、去重） */
export function deviceIndexes(device: string | null | undefined): number[] {
  const out: number[] = []
  for (const d of deviceList(device)) {
    if (/^cpu$/i.test(d)) continue
    const m = d.match(/^(?:cuda|vulkan|rocm|hip|metal)(\d+)$/i)
    const n = m ? Number(m[1]) : 0
    if (!out.includes(n)) out.push(n)
  }
  return out.length ? out : [0]
}
