import type { ProviderConfig } from './types'

/**
 * 模型名里出现这些片段，基本就是多模态（能看图）。
 * 只做「大概判断」，所以故意用比较具体的片段，避免 qwen2.5-coder / llama3.2 之类被误判。
 */
const VISION_HINTS = [
  'vl',
  'vision',
  'llava',
  'minicpm-v',
  'moondream',
  'pixtral',
  'internvl',
  'glm-4v',
  'glm4v',
  'gemma3',
  'gemma-3',
  'gemma4',
  'gemma-4',
  'mistral-small-3',
  'phi-4-multimodal',
  'janus',
  'cogvlm',
  'yi-vl',
  'gpt-4o',
  'gpt-4.1',
  'gpt-5',
  'o4-mini',
  'claude-3',
  'claude-4',
  'claude-sonnet',
  'claude-opus',
  'gemini',
  'grok-2-vision',
  'grok-4'
]

/** 名字里带这些的多半是纯文本模型，即使命中上面的片段也排除 */
const TEXT_ONLY_HINTS = ['coder', 'code-', '-code', 'embed', 'rerank', 'whisper']

export function modelLooksVision(model: string): boolean {
  const name = (model || '').toLowerCase()
  if (!name) return false
  // qwen2.5-coder 里没有 vl；但 "coder-vl" 这种仍应是视觉模型，所以先看强信号
  if (/-(vl|vision)\b|vl-|vision-/.test(name)) return true
  if (VISION_HINTS.some((h) => name.includes(h))) {
    if (TEXT_ONLY_HINTS.some((h) => name.includes(h)) && !/vl|vision/.test(name)) return false
    return true
  }
  return false
}

/**
 * GGUF 元数据里的架构 / 名字看起来是不是**必须**配投影器的视觉模型。
 *
 * 只认强信号（qwen3vl / llava / internvl / minicpm-v / glm-4v / pixtral / janus …），
 * 故意不把 gemma3 / gemma4 算进来：它们的纯文本权重也用同一个架构名，
 * 「有 gemma4 架构但没投影器」是很正常的状态，报成缺投影器只会误伤。
 * 仅用于界面提示和启动说明，不参与「能不能看图」的能力判定。
 */
export function ggufLooksVision(arch?: string, name?: string): boolean {
  const s = `${arch ?? ''} ${name ?? ''}`.toLowerCase()
  if (!s.trim()) return false
  return /qwen\d*(\.\d+)?[-_]?vl|llava|internvl|minicpm[-_]?v|glm[-_]?4v|pixtral|janus|moondream|cogvlm|yi[-_]vl|phi-4-multimodal|\bvision\b/.test(
    s
  )
}

/** 当前配置的模型能不能看图：用户手写的开关优先，否则按模型名猜 */
export function providerSupportsVision(provider: ProviderConfig | null | undefined): boolean {
  if (!provider) return false
  if (provider.vision === 'on') return true
  if (provider.vision === 'off') return false
  // 本地 llama.cpp：以服务端实际有没有挂 mmproj 为准。
  // 名字里带 gemma-4 不代表一定能看图（E4B 就没有配套投影器）。
  if (typeof provider.llamaVision === 'boolean') return provider.llamaVision
  return modelLooksVision(provider.model)
}

/** 附件里哪些扩展名算「图片」，能交给视觉模型看 */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])

export function isImagePath(p: string): boolean {
  const ext = (p.split('.').pop() ?? '').toLowerCase()
  return IMAGE_EXT.has(ext)
}
