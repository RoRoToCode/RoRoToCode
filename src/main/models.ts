import fsSync, { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CatalogModel, CatalogModality, DownloadProgress, ModelSource } from '../shared/types'
import { modelsRoot } from './llama'
import { downloadResumable } from './resume'
import { sha256Of } from './filehash'

/**
 * 可下载模型目录。
 *
 * 目录来自多个站点：hf-mirror（主）、Hugging Face 官方（备）、魔搭 ModelScope（补充）。
 * 每个站点各自拉列表 → 读文件树 → 挑量化文件 → 建条目，按仓库 id 合并去重。
 * 音频 / 图像 / 视觉模型不再一律排除，而是打上 modality 让界面标注清楚。
 *
 * 每个条目的体积要逐个 HEAD 探测，300 条时全部做完很慢，所以：
 *   ① 解析出文件名就先推一条「体积探测中」的条目给界面（刷出一个显示一个）；
 *   ② 体积探测并发跑完一条再推一条更新，界面原地替换。
 *
 * 检索整体失败时退回下面的内置清单，保证面板不至于空着。
 */

const HF_MIRROR = 'https://hf-mirror.com'
/** HF 协议兼容镜像：换域名即可，实测与 hf-mirror 指向同一份 xet 文件，可作并发第二源 */
const HF_FAST_MIRROR = 'https://aifasthub.com'
const HF_OFFICIAL = 'https://huggingface.co'
const MS_BASE = 'https://www.modelscope.cn'

/** 单个目录源的拉取条数（原先只有 100，热门榜把好模型全挡在外面了） */
const CATALOG_LIMIT = 300
/** 合并全部来源后最多保留多少条 */
const MAX_RESULTS = 300
/**
 * 魔搭补充源最多拉多少个仓库（每个还要单独读一次文件树）。
 * 保持小规模：它是并行等的一路，太大会把「首批立刻显示」拖慢。
 */
const MS_LIMIT = 24
/** 体积探测并发：原先 4，配合 300 条会慢到几十秒 */
const PROBE_CONCURRENCY = 12

const mirrorUrl = (repo: string, file: string) => `${HF_MIRROR}/${repo}/resolve/main/${file}`
const fastMirrorUrl = (repo: string, file: string) => `${HF_FAST_MIRROR}/${repo}/resolve/main/${file}`
const hfUrl = (repo: string, file: string) => `${HF_OFFICIAL}/${repo}/resolve/main/${file}`
const msResolveUrl = (repo: string, file: string) => `${MS_BASE}/models/${repo}/resolve/master/${file}`
const msApiUrl = (repo: string, file: string) =>
  `${MS_BASE}/api/v1/models/${repo}/repo?Revision=master&FilePath=${encodeURIComponent(file)}`

type CatalogSite = 'hf' | 'hf-official' | 'modelscope'

/**
 * 每个权重文件给 5 条下载源，顺序按它来自哪个站点调整。
 *
 * family 是并发下载的「内容契约」：只有 family 相同且远端总长一致的源才会被
 * 分到同一个并发池。实测魔搭上与 HF 同名的 Q4_K_M.gguf 字节数并不一样
 * （1117320768 vs 986048800），所以魔搭单独一组，绝不与 HF 系混着拼文件。
 */
function buildSources(repo: string, file: string, site: CatalogSite = 'hf'): ModelSource[] {
  if (!repo) return []
  const hfMirror: ModelSource = { label: 'HF 镜像', url: mirrorUrl(repo, file), family: 'hf' }
  const hfFast: ModelSource = { label: 'HF 快镜像', url: fastMirrorUrl(repo, file), family: 'hf' }
  const hfOfficial: ModelSource = { label: 'HF 官方', url: hfUrl(repo, file), family: 'hf' }
  const msResolve: ModelSource = { label: '魔搭', url: msResolveUrl(repo, file), family: 'modelscope' }
  const msApi: ModelSource = { label: '魔搭 API', url: msApiUrl(repo, file), family: 'modelscope' }
  if (site === 'modelscope') return [msResolve, msApi, hfMirror, hfFast, hfOfficial]
  if (site === 'hf-official') return [hfOfficial, hfMirror, hfFast, msResolve, msApi]
  return [hfMirror, hfFast, hfOfficial, msResolve, msApi]
}

/** 内置兜底清单也补上快镜像并打 family，逻辑与新目录保持一致 */
function seedSources(sources: ModelSource[]): ModelSource[] {
  const out: ModelSource[] = []
  for (const s of sources) {
    const isHf = s.url.startsWith(HF_MIRROR) || s.url.startsWith(HF_OFFICIAL)
    out.push({ ...s, family: isHf ? 'hf' : s.url.startsWith(MS_BASE) ? 'modelscope' : undefined })
    if (s.url.startsWith(HF_MIRROR)) {
      out.push({ label: 'HF 快镜像', url: s.url.replace(HF_MIRROR, HF_FAST_MIRROR), family: 'hf' })
    }
  }
  return out
}

interface Entry {
  id: string
  repo: string
  name: string
  family: string
  paramsB: number
  /** 参数量是从体积反推的（名字里没写），展示时加 ≈ */
  paramsEstimated?: boolean
  quant: string
  sizeBytes: number
  file: string
  note: string
  sources: ModelSource[]
  downloads: number
  origin: 'remote' | 'builtin'
  modality: CatalogModality
  sourceSite: string
  /** 仓库内完整路径（下载 / 补探体积时用，file 只是落地文件名） */
  remotePath?: string
  site?: CatalogSite
  /** 同仓库配套的视觉投影器文件名；有值就表示下载主权重时会一并下载 */
  mmprojFile?: string
}

interface Seed {
  id: string
  name: string
  family: string
  paramsB: number
  sizeBytes: number
  note: string
  file: string
  sources: ModelSource[]
}

const ms = (org: string, repo: string, file: string) =>
  `https://www.modelscope.cn/models/${org}/${repo}/resolve/master/${file}`

/** 内置兜底清单（检索不可用时使用） */
const SEEDS: Seed[] = [
  {
    id: 'qwen2.5-coder-1.5b',
    name: 'Qwen2.5-Coder-1.5B-Instruct',
    family: '通义代码',
    paramsB: 1.5,
    sizeBytes: 986048800,
    note: '轻量、响应快，适合补全和简单问答',
    file: 'Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf',
    sources: [
      { label: 'HF 镜像', url: mirrorUrl('bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF', 'Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf') },
      { label: '魔搭', url: ms('Qwen', 'Qwen2.5-Coder-1.5B-Instruct-GGUF', 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf') },
      { label: 'HF 官方', url: hfUrl('bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF', 'Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf') }
    ]
  },
  {
    id: 'qwen2.5-coder-3b',
    name: 'Qwen2.5-Coder-3B-Instruct',
    family: '通义代码',
    paramsB: 3,
    sizeBytes: 1929903360,
    note: '小显存也能跑，代码能力明显强于 1.5B',
    file: 'Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf',
    sources: [
      { label: 'HF 镜像', url: mirrorUrl('bartowski/Qwen2.5-Coder-3B-Instruct-GGUF', 'Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf') },
      { label: '魔搭', url: ms('Qwen', 'Qwen2.5-Coder-3B-Instruct-GGUF', 'qwen2.5-coder-3b-instruct-q4_k_m.gguf') },
      { label: 'HF 官方', url: hfUrl('bartowski/Qwen2.5-Coder-3B-Instruct-GGUF', 'Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf') }
    ]
  },
  {
    id: 'qwen2.5-coder-7b',
    name: 'Qwen2.5-Coder-7B-Instruct',
    family: '通义代码',
    paramsB: 7,
    sizeBytes: 4683074336,
    note: '综合最均衡，8G 显存的首选',
    file: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
    sources: [
      { label: 'HF 镜像', url: mirrorUrl('bartowski/Qwen2.5-Coder-7B-Instruct-GGUF', 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf') },
      { label: '魔搭', url: ms('Qwen', 'Qwen2.5-Coder-7B-Instruct-GGUF', 'qwen2.5-coder-7b-instruct-q4_k_m.gguf') },
      { label: 'HF 官方', url: hfUrl('bartowski/Qwen2.5-Coder-7B-Instruct-GGUF', 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf') }
    ]
  },
  {
    id: 'qwen2.5-coder-14b',
    name: 'Qwen2.5-Coder-14B-Instruct',
    family: '通义代码',
    paramsB: 14,
    sizeBytes: 8988111072,
    note: '12G 以上显存可全量放显存，代码质量更高',
    file: 'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf',
    sources: [
      { label: 'HF 镜像', url: mirrorUrl('bartowski/Qwen2.5-Coder-14B-Instruct-GGUF', 'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf') },
      { label: '魔搭', url: ms('Qwen', 'Qwen2.5-Coder-14B-Instruct-GGUF', 'qwen2.5-coder-14b-instruct-q4_k_m.gguf') },
      { label: 'HF 官方', url: hfUrl('bartowski/Qwen2.5-Coder-14B-Instruct-GGUF', 'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf') }
    ]
  },
  {
    id: 'qwen2.5-coder-32b',
    name: 'Qwen2.5-Coder-32B-Instruct',
    family: '通义代码',
    paramsB: 32,
    sizeBytes: 19851336672,
    note: '接近商用水平，需要 24G 显存或多卡/大内存',
    file: 'Qwen2.5-Coder-32B-Instruct-Q4_K_M.gguf',
    sources: [
      { label: 'HF 镜像', url: mirrorUrl('bartowski/Qwen2.5-Coder-32B-Instruct-GGUF', 'Qwen2.5-Coder-32B-Instruct-Q4_K_M.gguf') },
      { label: '魔搭', url: ms('Qwen', 'Qwen2.5-Coder-32B-Instruct-GGUF', 'qwen2.5-coder-32b-instruct-q4_k_m.gguf') },
      { label: 'HF 官方', url: hfUrl('bartowski/Qwen2.5-Coder-32B-Instruct-GGUF', 'Qwen2.5-Coder-32B-Instruct-Q4_K_M.gguf') }
    ]
  },
  {
    id: 'llama-3.1-8b',
    name: 'Llama-3.1-8B-Instruct',
    family: 'Meta',
    paramsB: 8,
    sizeBytes: 4920739232,
    note: '英文和通用对话强，中文略弱于 Qwen',
    file: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    sources: [
      { label: 'HF 镜像', url: mirrorUrl('bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf') },
      { label: 'HF 官方', url: hfUrl('bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf') }
    ]
  },
  {
    id: 'deepseek-coder-v2-lite',
    name: 'DeepSeek-Coder-V2-Lite-Instruct',
    family: 'DeepSeek',
    paramsB: 16,
    sizeBytes: 10364416768,
    note: 'MoE 结构，激活参数少，速度比同体积密集模型快',
    file: 'DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf',
    sources: [
      { label: 'HF 镜像', url: mirrorUrl('bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF', 'DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf') },
      { label: 'HF 官方', url: hfUrl('bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF', 'DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf') }
    ]
  }
]

// ---------------------------------------------------------------- 检索镜像

interface HfRepo {
  id: string
  downloads?: number
  likes?: number
  pipeline_tag?: string
  tags?: string[]
  /** 只在 ?expand[]=siblings 时返回：仓库里的文件名（不含体积） */
  siblings?: Array<{ rfilename: string }>
}

/**
 * 模态标签。原先这些仓库一律被丢掉，现在保留下来打标：
 * 音频 / 图像模型能下，但 llama.cpp 加载不了，界面必须写清楚。
 */
const TEXT_TAGS = new Set(['text-generation', 'conversational', 'text2text-generation', 'fill-mask'])
const VISION_TAGS = new Set(['image-text-to-text', 'any-to-any'])
const AUDIO_TAGS = new Set([
  'music-generation', 'text-to-music', 'text-to-audio', 'audio-to-audio',
  'audio-text-to-text', 'text-to-speech', 'automatic-speech-recognition',
  'voice-conversion', 'audio-classification', 'source-separation',
  'speaker-diarization'
])
const IMAGE_TAGS = new Set([
  'text-to-image', 'image-to-image', 'text-to-video', 'image-to-video',
  'image-text-to-video', 'object-detection', 'image-segmentation',
  'depth-estimation', 'image-classification', 'text-to-3d', 'image-to-3d',
  'diffusion', 'unconditional-image-generation'
])
/** 只有这类「不是完整模型」的仓库继续排除：向量模型、LoRA、投影器单体等 */
const EXCLUDE_TAGS = new Set(['feature-extraction'])
const EXCLUDE_NAME = /embed|rerank|lora-|adapter|controlnet|vae\b|clip-|siglip|blip|nudenet|imatrix|mmproj|gguf-split/i
/** 名字里带这些的多是「越狱/去审查」分支，对写代码没帮助，只会把榜单刷满 */
const BAD_VARIANT = /abliterated|uncensored|heretic|nsfw|unfiltered|de-?censored/i
/** 名字兜底：HF / 魔搭的任务标签有时没填全，靠关键词补上 */
const AUDIO_NAME = /tts\b|whisper|asr\b|speech|audio|voice|music|sound|sing|vocal|yue\b|ace-?step|vox|csm\b/i
const IMAGE_NAME = /diffus|flux|stable-?diffusion|wan\d|cogvideo|mochi|ltx-?v|hunyuanvideo|hunyuan-?image|hunyuan3d|video|image-?gen|upscal|super-?resol|segmentation|\bsam\b|depth|stylegan|text-to-3d|sdxl|qwen-?image|z-?image/i
const VISION_NAME = /[-_]vl\b|vision|ocr|qwen\d*-?vl|internvl|minicpm-?v/i

/** 量化优先级：Q4_K_M 优先；后面补的是 unsloth / 图像音频仓库常见的新式量化 */
const QUANT_PREF = [
  'Q4_K_M', 'Q4_K_S', 'Q5_K_M', 'Q4_0', 'Q3_K_M', 'Q6_K', 'Q8_0',
  'UD-Q4_K_XL', 'Q4_K_XL', 'IQ4_XS', 'Q5_K_S', 'IQ3_M',
  'F16', 'BF16', 'FP16'
]
const SPLIT_RE = /-\d{5}-of-\d{5}\.gguf$/i
/** 音频小模型（whisper-small 之类）可能只有几十 MB，门槛从 80MB 放低 */
const MIN_SIZE = 16 * 1024 ** 2
/** 超过这个体积的单文件对个人机器没有意义（几百 B 参数） */
const MAX_SIZE = 120 * 1024 ** 3

/** 返回模态即表示这个仓库可以进目录；null 表示排除 */
function classify(m: HfRepo): CatalogModality | null {
  if (!m.id || !m.id.includes('/')) return null
  const short = m.id.split('/')[1] ?? ''
  if (BAD_VARIANT.test(short) || EXCLUDE_NAME.test(short)) return null
  const tags = (m.tags ?? []).map((t) => t.toLowerCase())
  if (tags.some((t) => EXCLUDE_TAGS.has(t))) return null
  // 魔搭返回的是 Libraries/Tags，不一定带 'gguf' 这个 HF 专用 tag
  if (!tags.includes('gguf') && !/gguf/i.test(m.id)) return null

  const pipe = (m.pipeline_tag ?? '').toLowerCase()
  const hit = (set: Set<string>) => set.has(pipe) || tags.some((t) => set.has(t))
  const idLower = m.id.toLowerCase()
  if (hit(IMAGE_TAGS) || IMAGE_NAME.test(idLower)) return 'image'
  if (hit(AUDIO_TAGS) || AUDIO_NAME.test(idLower)) return 'audio'
  if (hit(VISION_TAGS) || VISION_NAME.test(idLower)) return 'vision'
  if (pipe === '' || hit(TEXT_TAGS)) return 'text'
  return 'other'
}

/** 非文本模型未必用 LLM 那套量化名：白名单都匹配不上时，允许用第一个单文件权重 */
function allowAnyQuant(modality: CatalogModality): boolean {
  return modality !== 'text' && modality !== 'vision'
}

function parseParamsB(name: string): number {
  const moe = name.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*B/i)
  if (moe) return Math.round(Number(moe[1]) * Number(moe[2]) * 10) / 10
  const one = name.match(/(\d+(?:\.\d+)?)\s*B(?![a-zA-Z0-9])/i)
  return one ? Number(one[1]) : 0
}

/** 每 1B 参数大致占多少 GB（用于名字里没写参数量时反推） */
const GB_PER_B: Record<string, number> = {
  Q4_K_M: 0.62,
  Q4_K_S: 0.6,
  Q5_K_M: 0.72,
  Q4_0: 0.58,
  Q3_K_M: 0.48,
  Q6_K: 0.85,
  Q8_0: 1.1
}

function estimateParamsB(sizeBytes: number, quant: string): number {
  const gb = sizeBytes / 1024 ** 3
  const per = GB_PER_B[quant] ?? 0.62
  return Math.round((gb / per) * 10) / 10
}

const FAMILIES: Array<[RegExp, string]> = [
  [/qwen/i, '通义 Qwen'],
  [/deepseek/i, 'DeepSeek'],
  [/llama/i, 'Meta Llama'],
  [/gemma/i, 'Google Gemma'],
  [/mistral|codestral|mixtral|devstral/i, 'Mistral'],
  [/\bphi[-\s]?\d/i, '微软 Phi'],
  [/glm|chatglm/i, '智谱 GLM'],
  [/internlm|internvl/i, '书生'],
  [/minicpm/i, '面壁 MiniCPM'],
  [/ernie/i, '百度文心'],
  [/baichuan/i, '百川'],
  [/minimax/i, 'MiniMax'],
  [/gpt-oss/i, 'OpenAI'],
  [/nemotron/i, 'NVIDIA'],
  [/granite/i, 'IBM Granite'],
  [/smollm/i, 'HuggingFace'],
  [/command|cohere/i, 'Cohere'],
  [/olmo/i, 'AI2 OLMo'],
  [/exaone/i, 'LG'],
  [/seed/i, '字节 Seed']
]

function familyOf(name: string): string {
  for (const [re, label] of FAMILIES) if (re.test(name)) return label
  const head = name.split(/[-_.\s]/)[0] ?? name
  return head || '其他'
}

function prettyName(repo: string): string {
  const last = repo.split('/').pop() ?? repo
  return last
    .replace(/[-_.]?gguf[-_.]?mtp$/i, '')
    .replace(/[-_.]?gguf$/i, '')
    .replace(/[-_.]?mtp$/i, '')
    .trim()
}

function prettyCount(n: number): string {
  if (!n) return '0'
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

/**
 * 挑同仓库配套的视觉投影器。
 *
 * 只认文件名里的 mmproj：HF 上的视觉仓库都是这么叫的（mmproj-F16.gguf、
 * mmproj-model-f16.gguf、mmproj-BF16.gguf…）。优先 f16/bf16 —— 效果和 f32
 * 基本一样，体积小一半；没有就退而求其次，总比只下主权重、结果看不了图强。
 */
function pickMmprojName(paths: string[]): string | undefined {
  const cands = paths.filter((p) => /\.gguf$/i.test(p) && /mmproj/i.test(p) && !SPLIT_RE.test(p))
  if (cands.length === 0) return undefined
  const pref = (re: RegExp) => cands.find((p) => re.test(path.basename(p)))
  return pref(/f16|bf16/i) ?? pref(/f32/i) ?? cands[0]
}

/** 从仓库文件名里挑一个单文件权重，按量化优先级降级；顺带挑配套投影器 */
function pickQuantName(
  paths: string[],
  modality: CatalogModality
): { path: string; quant: string; mmproj?: string } | null {
  const ggufs = paths.filter((p) => /\.gguf$/i.test(p) && !SPLIT_RE.test(p) && !/mmproj|imatrix/i.test(p))
  if (ggufs.length === 0) return null
  // 投影器只对视觉语言模型有意义，音频 / 图像仓库里的 mmproj 不该连带下载
  const mmproj = modality === 'vision' ? pickMmprojName(paths) : undefined
  for (const q of QUANT_PREF) {
    const hit = ggufs.find((p) => p.toLowerCase().includes(q.toLowerCase()))
    if (hit) return { path: hit, quant: q, mmproj }
  }
  if (!allowAnyQuant(modality)) return null
  const first = ggufs[0]
  const base = path.basename(first)
  const quant = base.match(/\b(I?Q\d[_A-Z0-9]*|F16|BF16|FP16|FP32|F32)\b/i)?.[1] ?? 'GGUF'
  return { path: first, quant, mmproj }
}

/**
 * 投影器落盘名：`<主模型 stem>-mmproj.gguf`。
 *
 * 必须固定成这个形状，不能沿用 HF 上的原文件名（mmproj-F16.gguf 这种）：
 * 自动配对按「主模型名」找投影器，名字对不上就配不上，白下一个文件。
 */
function projectorDestName(mainFile: string): string {
  return `${mainFile.replace(/\.gguf$/i, '')}-mmproj.gguf`
}

/**
 * 用 HEAD 拿真实体积：resolve 的 302 会带 X-Linked-Size，一次轻量请求就有准确字节数，
 * 比下载文件树便宜得多（镜像的 /api 很容易 429，但 resolve 不限得那么死）。
 */
async function headSize(repo: string, file: string): Promise<number> {
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(mirrorUrl(repo, file), {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
        headers: { 'user-agent': 'roroto-code' }
      })
      const linked = Number(res.headers.get('x-linked-size') ?? 0)
      if (linked > 0) return linked
      // 只有 200 的 content-length 才是文件体积；302 的是跳转页大小
      if (res.status === 200) return Number(res.headers.get('content-length') ?? 0)
      throw new Error(`HTTP ${res.status}`)
    } catch {
      if (i === 1) return 0
      await new Promise((r) => setTimeout(r, 800))
    }
  }
  return 0
}

/**
 * 查这个文件应有的 sha256。拿不到就返回空串。
 *
 * 校验是加分项，不是前提。镜像的 API 限流很凶，因为查不到哈希就把几 GB 的
 * 下载判成失败，是本末倒置 —— 所以这里所有异常一律降级成「这次不校验」。
 */
async function fetchSha256(entry: Entry, rel: string): Promise<string> {
  if (!entry.repo) return ''
  // HF 系：tree API 里的 lfs.oid 就是 sha256（GGUF 基本都是 LFS）
  if (entry.site !== 'modelscope') {
    for (const base of [HF_MIRROR, HF_OFFICIAL]) {
      try {
        const res = await fetch(`${base}/api/models/${entry.repo}/tree/main?recursive=true`, {
          signal: AbortSignal.timeout(8000),
          headers: { 'user-agent': 'roroto-code', accept: 'application/json' }
        })
        if (!res.ok) continue
        const arr = (await res.json()) as Array<{ path?: string; lfs?: { oid?: string } }>
        const hit = Array.isArray(arr) ? arr.find((x) => x.path === rel) : undefined
        if (hit?.lfs?.oid) return String(hit.lfs.oid).toLowerCase()
      } catch {
        // 换下一个源
      }
    }
  }
  try {
    const tree = await msTree(entry.repo)
    const hit = tree.find((f) => f.path === rel)
    if (hit?.sha256) return hit.sha256
  } catch {
    // 魔搭不通就算了，不等于文件有问题
  }
  return ''
}

/**
 * 调镜像 API。hf-mirror 对高频请求会直接返回 429（HTML 页面），所以遇到 429/5xx
 * 要退避重试，否则一次并发过高就会把整个检索打挂。
 */
async function apiJson<T>(url: string, timeoutMs = 9000, attempts = 3): Promise<T> {
  let lastErr: Error = new Error('请求失败')
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': 'roroto-code', accept: 'application/json' }
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as T
    } catch (e) {
      lastErr = e as Error
      const retriable = /HTTP 429|HTTP 5\d\d|abort|timeout|fetch failed/i.test(lastErr.message)
      if (!retriable || i === attempts - 1) throw lastErr
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)))
    }
  }
  throw lastErr
}

async function mapPool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R | null>): Promise<R[]> {
  const out: R[] = []
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      try {
        const r = await fn(items[i])
        if (r) out.push(r)
      } catch {
        // 单个仓库失败不影响整体
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

let cache: { at: number; key: string; entries: Entry[] } | null = null
const CACHE_MS = 10 * 60_000

const SITE_LABEL: Record<CatalogSite, string> = {
  hf: 'HF 镜像',
  'hf-official': 'HF 官方',
  modelscope: '魔搭'
}

/** 模态说明会直接写进 note，界面另外还会打标签，避免用户把音频模型当成本地可跑的模型 */
const MODALITY_NOTE: Record<CatalogModality, string> = {
  text: '',
  vision: ' · 视觉模型，纯文本也能用',
  audio: ' · 音频模型：llama.cpp 无法直接加载，需 whisper.cpp 等专用运行时',
  image: ' · 图像/视频模型：llama.cpp 无法直接加载，需 ComfyUI 等专用运行时',
  other: ' · 非文本模型，本地运行时可能不兼容'
}

interface Pick {
  repo: HfRepo
  name: string
  paramsB: number
  /** 仓库内完整路径（可能带子目录） */
  file: string
  quant: string
  /** 同仓库的视觉投影器文件名 */
  mmproj?: string
  modality: CatalogModality
  site: CatalogSite
  /** 魔搭文件树直接给了体积；> 0 就不用再发 HEAD */
  sizeBytes: number
}

interface HfSiteResult {
  meta: HfRepo[]
  siblings: Map<string, string[]>
  site: CatalogSite
}

/** 一个 HF 兼容站点：两次请求凑齐元数据与文件树（expand[]=siblings 的返回里没有 tags） */
async function fetchHfSite(base: string, key: string, site: CatalogSite): Promise<HfSiteResult> {
  const params = new URLSearchParams({
    filter: 'gguf',
    sort: 'downloads',
    direction: '-1',
    limit: String(CATALOG_LIMIT)
  })
  if (key) params.set('search', key)
  const fileParams = new URLSearchParams(params)
  fileParams.append('expand[]', 'siblings')
  // HF 官方在国内常年不通，给它短超时 + 不重试，别拖住主源
  const timeout = site === 'hf' ? 15000 : 4000
  const attempts = site === 'hf' ? 2 : 1
  const [meta, withFiles] = await Promise.all([
    apiJson<HfRepo[]>(`${base}/api/models?${params.toString()}`, timeout, attempts),
    apiJson<HfRepo[]>(`${base}/api/models?${fileParams.toString()}`, timeout, attempts)
  ])
  const siblings = new Map<string, string[]>()
  for (const m of Array.isArray(withFiles) ? withFiles : []) {
    siblings.set(m.id, (m.siblings ?? []).map((s) => s.rfilename))
  }
  return { meta: Array.isArray(meta) ? meta : [], siblings, site }
}

interface MsBlob {
  path: string
  size: number
  /** 魔搭文件树直接带 sha256；HF 那边没有，要靠 tree API 的 lfs.oid */
  sha256?: string
}

async function msTree(repo: string): Promise<MsBlob[]> {
  const res = await fetch(`${MS_BASE}/api/v1/models/${repo}/repo/files?Revision=master&Recursive=true`, {
    signal: AbortSignal.timeout(9000),
    headers: { 'user-agent': 'roroto-code', accept: 'application/json' }
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j = (await res.json()) as {
    Data?: { Files?: Array<{ Path?: string; Size?: number; Sha256?: string }> }
  }
  return (j?.Data?.Files ?? []).map((f) => ({
    path: String(f.Path ?? ''),
    size: Number(f.Size ?? 0),
    sha256: f.Sha256 ? String(f.Sha256).toLowerCase() : undefined
  }))
}

/**
 * 魔搭第三个目录源：dolphin 检索拿仓库列表，再并发读文件树。
 * 文件树里直接带 Size，所以这些条目不用再 HEAD 探测，是最快的那一批。
 */
async function fetchModelScope(key: string): Promise<Array<{ repo: HfRepo; files: MsBlob[] }>> {
  const res = await fetch(`${MS_BASE}/api/v1/dolphin/models`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'user-agent': 'roroto-code', accept: 'application/json' },
    // SortBy 只接受魔搭枚举里的值，传 'Downloads' 会直接返回参数错误
    body: JSON.stringify({ Name: key || 'gguf', PageSize: MS_LIMIT, PageNumber: 1, SortBy: 'Default' }),
    signal: AbortSignal.timeout(12000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j = (await res.json()) as {
    Success?: boolean
    Message?: string
    Data?: { Model?: { Models?: Array<Record<string, unknown>> } }
  }
  if (j.Success === false) throw new Error(j.Message || '魔搭检索返回失败')
  const repos: HfRepo[] = []
  for (const raw of j?.Data?.Model?.Models ?? []) {
    const ns = String(raw.Path ?? '')
    const nm = String(raw.Name ?? '')
    if (!ns || !nm) continue
    const tasks = Array.isArray(raw.Tasks)
      ? (raw.Tasks as Array<{ Name?: string; ChineseName?: string }>)
      : []
    const tags = [
      ...(Array.isArray(raw.Libraries) ? (raw.Libraries as string[]) : []),
      ...(Array.isArray(raw.Tags) ? (raw.Tags as string[]) : []),
      ...tasks.map((t) => String(t.Name ?? t.ChineseName ?? ''))
    ].filter(Boolean)
    repos.push({
      id: `${ns}/${nm}`,
      downloads: Number(raw.Downloads ?? 0),
      likes: Number(raw.Stars ?? 0),
      tags
    })
  }
  return mapPool(repos, 12, async (repo) => {
    try {
      return { repo, files: await msTree(repo.id) }
    } catch {
      return null
    }
  })
}

function makePick(
  repo: HfRepo,
  names: string[],
  sizes: Map<string, number>,
  site: CatalogSite
): Pick | null {
  const modality = classify(repo)
  if (!modality || names.length === 0) return null
  const picked = pickQuantName(names, modality)
  if (!picked) return null
  return {
    repo,
    name: prettyName(repo.id),
    paramsB: parseParamsB(prettyName(repo.id)),
    file: picked.path,
    quant: picked.quant,
    mmproj: picked.mmproj,
    modality,
    site,
    sizeBytes: sizes.get(picked.path) ?? 0
  }
}

function entryOf(p: Pick, size: number): Entry {
  const downloads = Number(p.repo.downloads ?? 0)
  const canEstimate = p.modality === 'text' || p.modality === 'vision'
  const visionNote = p.mmproj ? ' · 含视觉投影器（一并下载）' : ''
  const sizeNote = size > 0 ? '' : ' · 体积未确认'
  return {
    id: p.repo.id,
    repo: p.repo.id,
    name: p.name,
    family: familyOf(p.name),
    paramsB: p.paramsB > 0 ? p.paramsB : canEstimate && size > 0 ? estimateParamsB(size, p.quant) : 0,
    paramsEstimated: p.paramsB === 0 && canEstimate && size > 0,
    quant: p.quant,
    sizeBytes: size,
    file: path.basename(p.file),
    mmprojFile: p.mmproj,
    note: `${SITE_LABEL[p.site]} 下载 ${prettyCount(downloads)} · ${Number(p.repo.likes ?? 0)} 赞${MODALITY_NOTE[p.modality]}${visionNote}${sizeNote}`,
    sources: buildSources(p.repo.id, p.file, p.site),
    downloads,
    origin: 'remote',
    modality: p.modality,
    sourceSite: SITE_LABEL[p.site],
    remotePath: p.file,
    site: p.site
  }
}

/** Entry → 界面条目。探测中（sizeBytes=0）的条目也会推，只是带 probing 标记 */
function toCatalogModel(e: Entry, dir: string, probing: boolean): CatalogModel {
  return {
    id: e.id,
    name: e.name,
    family: e.family,
    paramsB: e.paramsB,
    paramsEstimated: e.paramsEstimated,
    quant: e.quant,
    sizeBytes: e.sizeBytes,
    file: e.file,
    mmproj: e.mmprojFile,
    note: e.note,
    sources: e.sources,
    repo: e.repo || undefined,
    downloads: e.downloads || undefined,
    origin: e.origin,
    sourceSite: e.sourceSite,
    modality: e.modality,
    probing,
    installed: completeFile(path.join(dir, e.file), e.sizeBytes || MIN_SIZE),
    mmprojInstalled: e.mmprojFile
      ? completeFile(path.join(dir, projectorDestName(e.file)), 0)
      : undefined,
    downloading: jobs.has(e.id)
  }
}

async function discover(
  query: string,
  refresh: boolean,
  emit?: (m: CatalogModel) => void
): Promise<Entry[]> {
  const key = query.trim().toLowerCase()
  // 缓存命中是「瞬间返回完整列表」，不需要也不应该再逐条推流
  if (!refresh && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.entries

  // 三个目录源并行：任一个挂掉都不影响其它源出结果
  const [hfResults, msResults] = await Promise.all([
    Promise.allSettled([
      fetchHfSite(HF_MIRROR, key, 'hf'),
      fetchHfSite(HF_OFFICIAL, key, 'hf-official')
    ]),
    fetchModelScope(key).catch(() => [] as Array<{ repo: HfRepo; files: MsBlob[] }>)
  ])

  const picks: Pick[] = []
  for (const r of hfResults) {
    if (r.status !== 'fulfilled') continue
    for (const repo of r.value.meta) {
      const names =
        r.value.siblings.get(repo.id) ?? (repo.siblings ?? []).map((s) => s.rfilename)
      const p = makePick(repo, names, new Map(), r.value.site)
      if (p) picks.push(p)
    }
  }
  for (const { repo, files } of msResults) {
    const p = makePick(repo, files.map((f) => f.path), new Map(files.map((f) => [f.path, f.size])), 'modelscope')
    if (p) picks.push(p)
  }
  if (picks.length === 0) throw new Error('所有目录源都没有解析到可下载的 GGUF 文件')

  // 同一模型常被多个仓库 / 多个站点搬运。魔搭那条自带体积，优先保留能省一次 HEAD。
  const ordered = picks.sort((a, b) => {
    const known = Number(b.sizeBytes > 0) - Number(a.sizeBytes > 0)
    if (known !== 0) return known
    return Number(b.repo.downloads ?? 0) - Number(a.repo.downloads ?? 0)
  })
  const dedup = new Map<string, Pick>()
  for (const p of ordered) {
    const k = `${p.name.toLowerCase()}|${p.paramsB}|${p.quant}`
    if (!dedup.has(k)) dedup.set(k, p)
  }
  const shortlist = [...dedup.values()].slice(0, MAX_RESULTS)
  const dir = targetDir()

  // ① 先把热门的一小批推给界面：只要解析出文件名就行，不等任何 HEAD，首屏立刻有内容
  const FIRST_BATCH = 36
  for (const p of shortlist) {
    const e = entryOf(p, p.sizeBytes)
    // 全部注册进来，这样首批之外还没显示出来的条目也能直接按 id 下载
    allEntries.set(e.id, e)
  }
  for (const p of shortlist.slice(0, FIRST_BATCH)) {
    const e = entryOf(p, p.sizeBytes)
    emit?.(toCatalogModel(e, dir, p.sizeBytes === 0))
  }

  // ② 再并发补体积：完成一条就推一条。首批是「原地替换」，后面的条目是「新增」，
  //    界面上的列表因此会一条条长出来，而不是全部探测完才一次性出现。
  //    整轮探测设总时限，镜像限流时剩下的条目标「体积未确认」也要及时收尾。
  const deadline = Date.now() + 45_000
  const found = await mapPool(shortlist, PROBE_CONCURRENCY, async (p) => {
    let size = p.sizeBytes
    if (!size && Date.now() < deadline) size = await headSize(p.repo.id, p.file)
    const valid = size >= MIN_SIZE && size <= MAX_SIZE
    const e = entryOf(p, valid ? size : 0)
    allEntries.set(e.id, e)
    emit?.(toCatalogModel(e, dir, false))
    return e
  })

  const entries = found.sort((a, b) => b.downloads - a.downloads)
  cache = { at: Date.now(), key, entries }
  return entries
}

// ---------------------------------------------------------------- 目录与下载

/** id → 条目，下载时按 id 反查（内置 + 检索结果都注册进来） */
const allEntries = new Map<string, Entry>()
const jobs = new Map<string, AbortController>()

/** 内置清单固定都是 Q4_K_M 单文件 */
function seedEntry(s: Seed): Entry {
  return {
    ...s,
    sources: seedSources(s.sources),
    quant: 'Q4_K_M',
    repo: '',
    downloads: 0,
    origin: 'builtin',
    modality: 'text',
    sourceSite: '内置清单',
    site: 'hf'
  }
}

function targetDir(): string {
  return modelsRoot()
}

async function freeBytes(dir: string): Promise<number> {
  try {
    const st = await fs.statfs(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return 0
  }
}

export async function listCatalog(
  opts?: { query?: string; refresh?: boolean; runId?: string; localOnly?: boolean },
  onItem?: (m: CatalogModel, runId: string) => void
): Promise<{
  ok: boolean
  models: CatalogModel[]
  dir: string
  freeBytes: number
  origin: 'remote' | 'builtin'
  message?: string
}> {
  const dir = targetDir()
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined)

  // 下载 / 删除后只重读本地文件状态：绝不为刷新一个「已下载」标记再跑 300 次网络探测
  if (opts?.localOnly) {
    const models = [...allEntries.values()].map((e) => toCatalogModel(e, dir, e.sizeBytes === 0))
    return {
      ok: true,
      models,
      dir,
      freeBytes: await freeBytes(dir),
      origin: cache ? 'remote' : 'builtin'
    }
  }

  // 只有带 runId 的那次检索才走流式推送：下载完成后刷新「已下载」状态那类调用
  // 不带 runId，界面不会把旧检索的迟到条目混进当前列表。
  const runId = opts?.runId
  const emitItem = runId && onItem ? (m: CatalogModel) => onItem(m, runId) : undefined

  let entries: Entry[] = []
  let origin: 'remote' | 'builtin' = 'remote'
  let message: string | undefined
  try {
    entries = await discover(opts?.query ?? '', opts?.refresh ?? false, emitItem)
  } catch (e) {
    origin = 'builtin'
    message = `在线检索失败（${(e as Error).message}），已退回内置清单`
    entries = SEEDS.map(seedEntry)
    // 兜底清单也要推给界面，否则界面只剩一个空列表
    for (const e0 of entries) emitItem?.(toCatalogModel(e0, dir, false))
  }

  for (const e of entries) allEntries.set(e.id, e)
  // 内置条目也注册，方便检索失败时下载
  for (const s of SEEDS) if (!allEntries.has(s.id)) allEntries.set(s.id, seedEntry(s))

  const models: CatalogModel[] = entries.map((e) => toCatalogModel(e, dir, e.sizeBytes === 0))
  return { ok: true, models, dir, freeBytes: await freeBytes(dir), origin, message }
}

/**
 * 最近一次推给界面的进度（按模型 id）。
 *
 * 为什么要存：下载跑在主进程里，界面只是「观众」。用户切到别的面板再切回来，
 * 组件是新挂载的，之前那条进度早就随旧组件一起没了 —— 界面看着像「下载被终止」。
 * 存一份最新的，面板重新挂载时先问快照，进度条和速度就能接上。
 */
const lastProgress = new Map<string, DownloadProgress>()

/** 面板重新挂载时用来恢复进度条；只读，不改下载状态 */
export function downloadsSnapshot(): DownloadProgress[] {
  return [...lastProgress.values()]
}

function emit(onProgress: (p: DownloadProgress) => void, p: DownloadProgress): void {
  lastProgress.set(p.id, p)
  if (p.state !== 'running') {
    // 结论留 10 分钟够用户看；之后清掉，免得列表里堆一堆旧结果
    const timer = setTimeout(() => {
      if (lastProgress.get(p.id) === p) lastProgress.delete(p.id)
    }, 10 * 60 * 1000)
    timer.unref?.()
  }
  try {
    onProgress(p)
  } catch {
    // 渲染进程已关闭 / 面板已卸载：进度没人收不影响下载本身
  }
}

/** 文件存在且体积对得上，才算「已经下载完」。 */
function completeFile(file: string, expect: number): boolean {
  try {
    const st = fsSync.statSync(file)
    if (!st.isFile() || st.size <= 0) return false
    // 拿不到期望体积（目录来源没给 sizeBytes）时，非空就算过
    if (!expect || expect <= 0) return true
    // 与下载器的 2% 容差保持一致：个别 CDN 的头部体积有微小出入
    return st.size >= expect * 0.98 && st.size <= expect * 1.02
  } catch {
    return false
  }
}

export async function downloadModel(
  id: string,
  onProgress: (p: DownloadProgress) => void
): Promise<{ ok: boolean; message: string; file?: string }> {
  let entry = allEntries.get(id)
  if (!entry) {
    const seed = SEEDS.find((s) => s.id === id)
    if (seed) entry = seedEntry(seed)
  }
  if (!entry) return { ok: false, message: '未知的模型 id，请先点「获取可用模型」刷新列表' }
  if (jobs.has(id)) return { ok: false, message: '该模型正在下载中' }

  // 流式列表里「体积探测中」的条目也能直接点下载：这时现问一次真实体积
  if (!entry.sizeBytes && entry.repo) {
    const probed = await headSize(entry.repo, entry.remotePath || entry.file)
    if (probed > 0) entry = { ...entry, sizeBytes: probed }
  }

  const dir = targetDir()
  await fs.mkdir(dir, { recursive: true })
  const dest = path.join(dir, entry.file)
  // 投影器落盘名固定成 <主模型>-mmproj.gguf：自动配对按主模型名找它，
  // 沿用 HF 上的原文件名（mmproj-F16.gguf）会配不上，等于白下。
  const mmFile = entry.mmprojFile
  const mmDest = mmFile ? path.join(dir, projectorDestName(entry.file)) : ''
  /**
   * 只判断 existsSync 是不够的：下载被磁盘满 / 关机打断时，盘上会留下一个半截文件，
   * 之后每次点下载都得到「已存在」，而重新下载的唯一出口也被这一句挡掉了 ——
   * 用户只能自己去资源管理器删。所以这里改成按体积校验。
   */
  // 体积未确认时至少拿 MIN_SIZE 兜底，别把一个几十 KB 的残文件当成完整模型
  const haveMain = completeFile(dest, entry.sizeBytes || MIN_SIZE)
  const needMm = !!mmDest && !completeFile(mmDest, 0)

  // 主权重和投影器都齐了才算「已存在」。以前只看主文件：老用户重新点下载只会
  // 得到「已存在」，明明缺投影器却永远补不上 —— 看不了图还查不出原因。
  if (haveMain && !needMm) return { ok: true, message: `已存在：${entry.file}`, file: dest }

  // 体积不对的残文件先清掉：留着它只会让下一次「已存在」的误判重现
  if (!haveMain && fsSync.existsSync(dest)) {
    await fs.rm(dest, { force: true }).catch(() => undefined)
  }

  // 投影器体积现问：列表阶段不为它多发一次 HEAD（镜像限流很紧）
  const mmSize = needMm && entry.repo && mmFile ? await headSize(entry.repo, mmFile) : 0

  // 空间预检：算上还没下的那一份，留 1GB 余量给系统
  const expect = (haveMain ? 0 : entry.sizeBytes) + (needMm ? mmSize : 0)
  const free = await freeBytes(dir)
  if (free > 0 && expect > 0 && free < expect + 1024 ** 3) {
    const need = ((expect + 1024 ** 3) / 1024 ** 3).toFixed(1)
    return { ok: false, message: `磁盘空间不足：需要约 ${need} GB，当前可用 ${(free / 1024 ** 3).toFixed(1)} GB` }
  }

  const ctrl = new AbortController()
  jobs.set(id, ctrl)
  const part = `${dest}.part`
  const sources = entry.sources.map((s) => ({ label: s.label, url: s.url, family: s.family }))

  try {
    // 主模型已在盘上时也要发一条 running：只补投影器那会儿界面否则毫无反应
    emit(onProgress, {
      id,
      file: entry.file,
      receivedBytes: 0,
      totalBytes: entry.sizeBytes,
      speedBps: 0,
      state: 'running',
      phase: 'weights',
      source: haveMain ? '主模型已在本地，补下视觉投影器…' : '准备下载…'
    })

    let mainSource = ''
    if (!haveMain) {
      // HF 镜像 → 魔搭 → HF 官方：任何一条断了都会从断点续传，不会再从 0 重来
      const r = await downloadResumable(sources, part, {
        signal: ctrl.signal,
        expectedBytes: entry.sizeBytes,
        // 同一份 GGUF 在不同镜像上的字节数应完全一致，2% 容差只用来放过个别 CDN 的头误差
        tolerance: 0.02,
        minBytes: 1024 * 1024,
        headerMs: 25000,
        idleMs: 45000,
        totalMs: 4 * 60 * 60 * 1000,
        onTick: (t) =>
          emit(onProgress, {
            id,
            file: entry.file,
            receivedBytes: t.received,
            totalBytes: t.total || entry.sizeBytes,
            speedBps: t.speed,
            state: 'running',
            phase: 'weights',
            source: t.source
          })
      })
      /**
       * 落盘前先对哈希。
       *
       * 体积校验挡得住「下了一半」，挡不住「下完了但字节不对」：CDN 中途吐错、
       * 代理截断后补零、镜像上本身就是坏文件，这三种体积都能对上，
       * 表现却统一是「模型加载失败」—— 用户根本猜不到是文件坏了。
       */
      const wantSha = await fetchSha256(entry, entry.remotePath || entry.file)
      if (wantSha && ctrl.signal.aborted) throw new Error('已取消')
      if (wantSha) {
        emit(onProgress, {
          id,
          file: entry.file,
          receivedBytes: 0,
          totalBytes: entry.sizeBytes,
          speedBps: 0,
          state: 'running',
          phase: 'verify',
          source: '正在校验文件完整性…'
        })
        let got = ''
        try {
          got = await sha256Of(part, (done, total) =>
            emit(onProgress, {
              id,
              file: entry.file,
              receivedBytes: done,
              totalBytes: total,
              speedBps: 0,
              state: 'running',
              phase: 'verify',
              source: `校验中 ${total > 0 ? Math.floor((done / total) * 100) : 0}%`
            })
          )
        } catch {
          // 读不下去（文件被占用之类）：这次不校验，别把好好的下载判死
          got = ''
        }
        if (got && got !== wantSha) {
          await fs.rm(part, { force: true })
          return {
            ok: false,
            message:
              `文件校验失败（sha256 不符），已删掉损坏的部分，请重新下载。\n` +
              `期望 ${wantSha.slice(0, 16)}…，实际 ${got.slice(0, 16)}…`
          }
        }
      }
      await fs.rename(part, dest)
      mainSource = r.label
    }

    // 第二段：视觉投影器。失败不回滚主模型 —— 掉一个几百 MB 的文件，
    // 不该让几 GB 的权重白下；重新点下载时 haveMain 为真，只会补这一份。
    let mmNote = ''
    if (needMm && entry.repo && mmFile) {
      const mmPart = `${mmDest}.part`
      emit(onProgress, {
        id,
        file: path.basename(mmDest),
        receivedBytes: 0,
        totalBytes: mmSize,
        speedBps: 0,
        state: 'running',
        phase: 'mmproj',
        source: '正在下载视觉投影器…'
      })
      try {
        await downloadResumable(
          buildSources(entry.repo, mmFile, entry.site ?? 'hf'),
          mmPart,
          {
            signal: ctrl.signal,
            expectedBytes: mmSize || undefined,
            tolerance: 0.02,
            minBytes: 64 * 1024,
            headerMs: 25000,
            idleMs: 45000,
            totalMs: 60 * 60 * 1000,
            onTick: (t) =>
              emit(onProgress, {
                id,
                file: path.basename(mmDest),
                receivedBytes: t.received,
                totalBytes: t.total || mmSize,
                speedBps: t.speed,
                state: 'running',
                phase: 'mmproj',
                source: t.source
              })
          }
        )
        const mmBytes = (await fs.stat(mmPart)).size
        await fs.rename(mmPart, mmDest)
        mmNote = `，视觉投影器 ${path.basename(mmDest)}（${(mmBytes / 1024 ** 2).toFixed(0)} MB）`
      } catch (e) {
        if (ctrl.signal.aborted) throw e
        // 投影器单独失败：主模型是好的，别把整单判成失败
        mmNote = `；但视觉投影器下载失败（${(e as Error).message}），这个模型暂时看不了图，重新点下载可只补投影器`
      }
    }

    emit(onProgress, {
      id,
      file: entry.file,
      receivedBytes: entry.sizeBytes,
      totalBytes: entry.sizeBytes,
      speedBps: 0,
      state: 'done',
      phase: 'weights',
      source: mainSource || '完成',
      message: `已保存到 ${dest}${mmNote}`
    })
    const from = mainSource ? `（来源 ${mainSource}）` : ''
    return { ok: true, message: `已下载：${entry.file}${from}${mmNote}`, file: dest }
  } catch (err) {
    const cancelled = ctrl.signal.aborted
    const mainSaved = fsSync.existsSync(dest)
    // 主模型已落盘、只是投影器被取消：不能报「下载失败」，那会让人重复下几 GB
    if (cancelled && mainSaved) {
      emit(onProgress, {
        id,
        file: entry.file,
        receivedBytes: entry.sizeBytes,
        totalBytes: entry.sizeBytes,
        speedBps: 0,
        state: 'done',
        phase: 'weights',
        source: '部分完成',
        message: '主模型已保存；视觉投影器未下完，重新点下载可只补投影器'
      })
      return {
        ok: true,
        message: `已下载主模型：${entry.file}（投影器已取消，重新下载可只补投影器）`,
        file: dest
      }
    }
    const msg = cancelled
      ? `已取消下载（已保留 ${(fsSync.existsSync(part) ? fsSync.statSync(part).size / 1024 / 1024 : 0).toFixed(0)} MB，下次从断点继续）`
      : `下载失败：${(err as Error).message}`
    emit(onProgress, {
      id,
      file: entry.file,
      receivedBytes: 0,
      totalBytes: entry.sizeBytes,
      speedBps: 0,
      state: cancelled ? 'cancelled' : 'error',
      message: msg
    })
    // 断点文件（.part）故意保留，重新点下载会接着下，不再重新拉几个 GB
    return { ok: false, message: msg }
  } finally {
    jobs.delete(id)
  }
}

export function cancelDownload(id: string): void {
  jobs.get(id)?.abort()
}

/**
 * 删掉已下载的模型文件（主权重 + 投影器 + 残留的 .part）。
 *
 * 之前完全没有这个出口：文件坏了、想换量化、磁盘要腾地方，都只能去资源管理器里翻
 * userData 目录。而「坏文件被当成已存在」的问题也因此没法自愈。
 */
export async function removeModel(id: string): Promise<{ ok: boolean; message: string }> {
  if (jobs.has(id)) return { ok: false, message: '正在下载中，先取消再删除' }
  let entry = allEntries.get(id)
  if (!entry) {
    const seed = SEEDS.find((s) => s.id === id)
    if (seed) entry = seedEntry(seed)
  }
  if (!entry) return { ok: false, message: '未知的模型 id' }

  const dir = targetDir()
  const files = [
    path.join(dir, entry.file),
    entry.mmprojFile ? path.join(dir, projectorDestName(entry.file)) : ''
  ].filter(Boolean)
  let removed = 0
  for (const f of files) {
    for (const target of [f, `${f}.part`]) {
      if (!fsSync.existsSync(target)) continue
      try {
        await fs.rm(target, { force: true })
        if (target === f) removed++
      } catch {
        // 文件被占用（模型正在跑）时删不掉：如实说，别假装成功
        return { ok: false, message: `删除失败：${path.basename(target)} 可能正在被使用，请先停止本地模型` }
      }
    }
  }
  if (!removed) return { ok: false, message: '这个模型本来就不在本地' }
  return { ok: true, message: `已删除 ${entry.file}` }
}
