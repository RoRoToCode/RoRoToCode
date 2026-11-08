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

/** 从 "CUDA1" / "Vulkan0" 里取卡号；取不到按 0 处理 */
export function deviceIndex(device: string | null | undefined): number {
  const m = (device ?? '').trim().match(/^(?:cuda|vulkan|rocm|hip|metal)(\d+)$/i)
  return m ? Number(m[1]) : 0
}
