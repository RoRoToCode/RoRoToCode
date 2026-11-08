import fsSync, { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CatalogModel, DownloadProgress, ModelSource } from '../shared/types'
import { modelsRoot } from './llama'
import { downloadResumable } from './resume'

/**
 * 可下载模型目录。
 *
 * 主路径是**实时检索 hf-mirror.com**：按下载量拉热门 GGUF 仓库 → 逐个仓库读文件树 →
 * 挑出 Q4_K_M 单文件（拿不到就按 Q4_K_S / Q5_K_M … 降级）→ 用文件里的真实字节数建条目。
 * 这样镜像上有什么新模型就能下什么，不用改代码。
 *
 * 检索失败（断网/镜像挂）时退回下面这份内置清单，保证面板不至于空着。
 * 下载源顺序：HF 镜像 → 魔搭（仅内置条目）→ HF 官方；国内直连 huggingface.co 常年不通，镜像必须排第一。
 */

const HF_API = 'https://hf-mirror.com/api/models'
const mirrorUrl = (repo: string, file: string) => `https://hf-mirror.com/${repo}/resolve/main/${file}`
const hfUrl = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`

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

/** 多模态、语音、图像/音乐生成这类仓库在 llama.cpp 里跑不了或跑不好，直接排除 */
const TEXT_TAGS = new Set(['text-generation', 'image-text-to-text', 'any-to-any', 'conversational'])
const BAD_TAGS = new Set([
  'music-generation',
  'text-to-music',
  'text-to-audio',
  'audio-to-audio',
  'audio-text-to-text',
  'text-to-speech',
  'automatic-speech-recognition',
  'voice-conversion',
  'text-to-image',
  'image-to-image',
  'text-to-video',
  'image-to-video',
  'image-text-to-video',
  'object-detection',
  'image-segmentation',
  'depth-estimation',
  'image-classification',
  'feature-extraction',
  'text-to-3d',
  'image-to-3d',
  'diffusion'
])
/** 名字里带这些的多是「越狱/去审查」分支，对写代码没帮助，只会把榜单刷满 */
const BAD_VARIANT = /abliterated|uncensored|heretic|nsfw|unfiltered|de-?censored/i
const BAD_NAME = /tts\b|whisper|asr\b|speech|audio|voice|music|video|wan\d|hunyuan|cogvideo|mochi|ltx-?v|ocr|embed|rerank|diffus|flux|stable-?diffusion|upscal|super-?resol|segmentation|\bsam\b|clip-|siglip|blip|depth|nudenet|stylegan|vae\b|controlnet|lora-|adapter/i

/** 量化优先级：先 Q4_K_M，没有就退而求其次 */
const QUANT_PREF = ['Q4_K_M', 'Q4_K_S', 'Q5_K_M', 'Q4_0', 'Q3_K_M', 'Q6_K', 'Q8_0']
const SPLIT_RE = /-\d{5}-of-\d{5}\.gguf$/i
const MIN_SIZE = 80 * 1024 ** 2
/** 超过这个体积的单文件对个人机器没有意义（几百 B 参数），直接不进列表 */
const MAX_SIZE = 120 * 1024 ** 3

function isCandidate(m: HfRepo): boolean {
  if (!m.id || !m.id.includes('/')) return false
  const pipe = m.pipeline_tag ?? ''
  if (pipe && !TEXT_TAGS.has(pipe)) return false
  const short = m.id.split('/')[1] ?? ''
  if (BAD_NAME.test(short) || BAD_VARIANT.test(short)) return false
  const tags = (m.tags ?? []).map((t) => t.toLowerCase())
  if (tags.some((t) => BAD_TAGS.has(t))) return false
  return tags.includes('gguf')
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
  paths: string[]
): { path: string; quant: string; mmproj?: string } | null {
  const ggufs = paths.filter((p) => /\.gguf$/i.test(p) && !SPLIT_RE.test(p) && !/mmproj|imatrix/i.test(p))
  if (ggufs.length === 0) return null
  const mmproj = pickMmprojName(paths)
  for (const q of QUANT_PREF) {
    const hit = ggufs.find((p) => p.toLowerCase().includes(q.toLowerCase()))
    if (hit) return { path: hit, quant: q, mmproj }
  }
  return null
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

interface Pick {
  repo: HfRepo
  name: string
  paramsB: number
  file: string
  quant: string
  /** 同仓库的视觉投影器文件名 */
  mmproj?: string
}

async function discover(query: string, refresh: boolean): Promise<Entry[]> {
  const key = query.trim().toLowerCase()
  if (!refresh && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.entries

  // 镜像的 /api 有限流，只能用两次请求把数据凑齐：
  //   ① 普通列表 → 带 tags / pipeline_tag / likes，用于筛掉非文本模型
  //   ② expand[]=siblings → 只带 id + 文件名，用于挑量化文件（这种返回里没有 tags）
  const base = new URLSearchParams({ filter: 'gguf', sort: 'downloads', direction: '-1', limit: '100' })
  if (key) base.set('search', query.trim())
  const fileParams = new URLSearchParams(base)
  fileParams.append('expand[]', 'siblings')

  const [meta, withFiles] = await Promise.all([
    apiJson<HfRepo[]>(`${HF_API}?${base.toString()}`, 15000, 2),
    apiJson<HfRepo[]>(`${HF_API}?${fileParams.toString()}`, 15000, 2)
  ])

  const siblingsOf = new Map<string, string[]>()
  for (const m of Array.isArray(withFiles) ? withFiles : []) {
    siblingsOf.set(m.id, (m.siblings ?? []).map((s) => s.rfilename))
  }

  const candidates = (Array.isArray(meta) ? meta : []).filter(isCandidate)

  const picks: Pick[] = []
  for (const repo of candidates) {
    const names = siblingsOf.get(repo.id) ?? (repo.siblings ?? []).map((s) => s.rfilename)
    const picked = pickQuantName(names)
    if (!picked) continue
    const name = prettyName(repo.id)
    picks.push({
      repo,
      name,
      paramsB: parseParamsB(name),
      file: picked.path,
      quant: picked.quant,
      mmproj: picked.mmproj
    })
  }

  // 同一模型常被多个仓库搬运，先按「模型名 + 参数量」去重，再做 HEAD，能省一大半请求
  const dedup = new Map<string, Pick>()
  for (const p of picks.sort((a, b) => Number(b.repo.downloads ?? 0) - Number(a.repo.downloads ?? 0))) {
    const k = `${p.name.toLowerCase()}|${p.paramsB}|${p.quant}`
    if (!dedup.has(k)) dedup.set(k, p)
  }
  const shortlist = [...dedup.values()].slice(0, 28)

  const found = await mapPool(shortlist, 4, async (p) => {
    const size = await headSize(p.repo.id, p.file)
    if (size < MIN_SIZE || size > MAX_SIZE) return null
    const downloads = Number(p.repo.downloads ?? 0)
    const multimodal = (p.repo.pipeline_tag ?? '') === 'image-text-to-text'
    // 说明文案要说真话：带投影器的写「会一并下载」，只有主权重的不许暗示能看图
    const visionNote = p.mmproj
      ? ' · 含视觉投影器（一并下载）'
      : multimodal
        ? ' · 多模态（纯文本也能用）'
        : ''
    const entry: Entry = {
      id: p.repo.id,
      repo: p.repo.id,
      name: p.name,
      family: familyOf(p.name),
      paramsB: p.paramsB > 0 ? p.paramsB : estimateParamsB(size, p.quant),
      paramsEstimated: p.paramsB === 0,
      quant: p.quant,
      sizeBytes: size,
      file: path.basename(p.file),
      mmprojFile: p.mmproj,
      note: `hf-mirror 下载 ${prettyCount(downloads)} · ${Number(p.repo.likes ?? 0)} 赞${visionNote}`,
      sources: [
        { label: 'HF 镜像', url: mirrorUrl(p.repo.id, p.file) },
        { label: 'HF 官方', url: hfUrl(p.repo.id, p.file) }
      ],
      downloads,
      origin: 'remote'
    }
    return entry
  })

  if (found.length === 0) throw new Error('镜像上没有解析到可下载的 GGUF 文件')

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
  return { ...s, quant: 'Q4_K_M', repo: '', downloads: 0, origin: 'builtin' }
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

export async function listCatalog(opts?: {
  query?: string
  refresh?: boolean
}): Promise<{
  ok: boolean
  models: CatalogModel[]
  dir: string
  freeBytes: number
  origin: 'remote' | 'builtin'
  message?: string
}> {
  const dir = targetDir()
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined)

  let entries: Entry[] = []
  let origin: 'remote' | 'builtin' = 'remote'
  let message: string | undefined
  try {
    entries = await discover(opts?.query ?? '', opts?.refresh ?? false)
  } catch (e) {
    origin = 'builtin'
    message = `在线检索失败（${(e as Error).message}），已退回内置清单`
    entries = SEEDS.map(seedEntry)
  }

  for (const e of entries) allEntries.set(e.id, e)
  // 内置条目也注册，方便检索失败时下载
  for (const s of SEEDS) if (!allEntries.has(s.id)) allEntries.set(s.id, seedEntry(s))

  const models: CatalogModel[] = entries.map((e) => ({
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
    installed: fsSync.existsSync(path.join(dir, e.file)),
    // 老版本只下了主权重：这里单独标出来，界面才好把按钮从「已就绪」换成「补投影器」
    mmprojInstalled: e.mmprojFile
      ? fsSync.existsSync(path.join(dir, projectorDestName(e.file)))
      : undefined,
    downloading: jobs.has(e.id)
  }))

  return { ok: true, models, dir, freeBytes: await freeBytes(dir), origin, message }
}

function emit(onProgress: (p: DownloadProgress) => void, p: DownloadProgress): void {
  try {
    onProgress(p)
  } catch {
    // 渲染进程已关闭，忽略
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

  const dir = targetDir()
  await fs.mkdir(dir, { recursive: true })
  const dest = path.join(dir, entry.file)
  // 投影器落盘名固定成 <主模型>-mmproj.gguf：自动配对按主模型名找它，
  // 沿用 HF 上的原文件名（mmproj-F16.gguf）会配不上，等于白下。
  const mmFile = entry.mmprojFile
  const mmDest = mmFile ? path.join(dir, projectorDestName(entry.file)) : ''
  const haveMain = fsSync.existsSync(dest)
  const needMm = !!mmDest && !fsSync.existsSync(mmDest)

  // 主权重和投影器都齐了才算「已存在」。以前只看主文件：老用户重新点下载只会
  // 得到「已存在」，明明缺投影器却永远补不上 —— 看不了图还查不出原因。
  if (haveMain && !needMm) return { ok: true, message: `已存在：${entry.file}`, file: dest }

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
  const sources = entry.sources.map((s) => ({ label: s.label, url: s.url }))

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
          [
            { label: 'HF 镜像', url: mirrorUrl(entry.repo, mmFile) },
            { label: 'HF 官方', url: hfUrl(entry.repo, mmFile) }
          ],
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
