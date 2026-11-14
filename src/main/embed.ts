/**
 * 本地 embedding 语义检索。
 *
 * 为什么要它：repo_map 现在是「正则抽符号 + 词面包含」——模型得先猜对关键词
 * （「鉴权」还是「auth」还是「login」），猜错了就搜不到。换成向量检索之后，
 * 「登录怎么校验的」能直接命中 auth/token/session 那批文件，不用靠词撞词。
 *
 * 全程走本机：llama.cpp 的 /v1/embeddings 或 Ollama 的 /api/embed。
 * 不花钱、不出网、不需要用户配 key —— 这是云端 API 给不了的那部分能力。
 *
 * 拿不到 embedding（服务没开、模型不支持）就返回 null，调用方回落到词面检索，
 * 功能不会因为这块挂掉。
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProviderConfig } from '../shared/types'
import { loadConfig } from './config'
import { isLlamaProvider, isLoopbackUrl } from '../shared/providers'
import type { FileNode, RepoIndex } from './repoindex'

/** 缓存文件跟着仓库走，和 .roroto/index.json 放一起 */
function cachePath(root: string): string {
  return path.join(root, '.roroto', 'embed.json')
}

interface CacheEntry {
  /** 描述文本的指纹：路径/符号/摘要任一变了就重算 */
  hash: string
  /** int8 量化后的向量（base64），768 维约 1KB，比 Float32 的 JSON 小一个量级 */
  vec: string
}

interface EmbedCache {
  version: number
  model: string
  dim: number
  files: Record<string, CacheEntry>
}

const CACHE_VERSION = 1
/** 一次最多向量化多少个文件：几千个文件的仓库全量算要几十秒，超出部分先按词面排 */
const MAX_FILES = 1500
/** 失败的补救冷却：服务没开的时候不要每轮都去撞一次 */
let deadUntil = 0

function providerBase(p: ProviderConfig): string {
  return p.baseUrl.replace(/\/+$/, '')
}

/** OpenAI 兼容端点：baseUrl 可能已经带 /v1 */
function openAiEmbedUrl(base: string): string {
  const b = base.replace(/\/+$/, '')
  return /\/v1$/i.test(b) ? `${b}/embeddings` : `${b}/v1/embeddings`
}

function ollamaRoot(p: ProviderConfig): string {
  return providerBase(p).replace(/\/v1$/i, '')
}

/** 挑一个能算 embedding 的本地服务：显式环境变量优先，其次当前在用的本地模型 */
async function pickEndpoint(): Promise<
  { kind: 'openai' | 'ollama'; url: string; model: string } | null
> {
  const custom = (process.env.ROROTO_EMBED ?? '').trim()
  const envModel = (process.env.ROROTO_EMBED_MODEL ?? '').trim()
  if (custom) {
    return { kind: 'openai', url: custom, model: envModel || 'bge-m3' }
  }
  const cfg = await loadConfig().catch(() => null)
  if (!cfg) return null
  const p = cfg.providers.find((x) => x.id === cfg.activeId) ?? cfg.providers[0] ?? null
  if (!p || !p.baseUrl) return null
  if (p.kind === 'ollama') {
    return { kind: 'ollama', url: `${ollamaRoot(p)}/api/embed`, model: envModel || p.model }
  }
  if (isLlamaProvider(p)) {
    return { kind: 'openai', url: openAiEmbedUrl(providerBase(p)), model: envModel || p.model }
  }
  /**
   * 自建的 OpenAI 兼容服务（LM Studio / vLLM / KoboldCpp）也走同一条路，
   * 但只认回环地址 —— 在线 API 不算：用户没同意过为「索引仓库」额外付钱。
   */
  if (p.kind === 'openai' && isLoopbackUrl(p.baseUrl)) {
    return { kind: 'openai', url: openAiEmbedUrl(providerBase(p)), model: envModel || p.model }
  }
  return null
}

function toB64(vec: number[]): string {
  let max = 0
  for (const v of vec) {
    const a = Math.abs(v)
    if (a > max) max = a
  }
  const scale = max > 0 ? 127 / max : 0
  const buf = Buffer.allocUnsafe(vec.length)
  for (let i = 0; i < vec.length; i++) {
    const q = Math.max(-127, Math.min(127, Math.round(vec[i] * scale)))
    buf[i] = q & 0xff
  }
  return buf.toString('base64')
}

function fromB64(s: string): Int8Array {
  const buf = Buffer.from(s, 'base64')
  return new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

function cosine(a: Int8Array, b: Int8Array): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / Math.sqrt(na * nb)
}

/** 一个文件喂给 embedding 的文本：路径 + 符号 + 摘要，控制在 200 字以内 */
function descriptor(f: FileNode): string {
  const sym = f.symbols.slice(0, 12).join(' ')
  const sum = (f.summary || '').replace(/\s+/g, ' ').slice(0, 120)
  return `${f.path}\n${sym}\n${sum}`.trim()
}

function hashOf(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/** 批量算向量；任何一批失败就当整块不可用（不做半吊子索引） */
async function embedBatch(
  ep: { kind: 'openai' | 'ollama'; url: string; model: string },
  texts: string[]
): Promise<number[][] | null> {
  if (!texts.length) return []
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        ep.kind === 'ollama'
          ? { model: ep.model, input: texts }
          : { model: ep.model, input: texts }
      ),
      signal: AbortSignal.timeout(20000)
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>
      embeddings?: number[][]
    }
    const out = json.embeddings ?? json.data?.map((d) => d.embedding ?? [])
    if (!out || out.length !== texts.length) return null
    if (!out.every((v) => Array.isArray(v) && v.length > 0)) return null
    return out
  } catch {
    return null
  }
}

async function loadCache(root: string, model: string): Promise<EmbedCache> {
  const empty: EmbedCache = { version: CACHE_VERSION, model, dim: 0, files: {} }
  try {
    const raw = JSON.parse(await fs.readFile(cachePath(root), 'utf8')) as EmbedCache
    if (raw.version !== CACHE_VERSION || raw.model !== model) return empty
    return { ...empty, ...raw, files: raw.files ?? {} }
  } catch {
    return empty
  }
}

async function saveCache(root: string, cache: EmbedCache): Promise<void> {
  try {
    await fs.mkdir(path.join(root, '.roroto'), { recursive: true })
    await fs.writeFile(cachePath(root), JSON.stringify(cache), 'utf8')
  } catch {
    // 缓存写不进去不影响本次结果，下次重算而已
  }
}

/**
 * 语义检索：返回直接可以塞给模型的文本，拿不到 embedding 时返回 null。
 *
 * `limit` 是最终列出的文件数；内部会先按词面粗筛一遍再算相似度，
 * 这样几万个文件的仓库也不会一次算爆。
 */
export async function semanticMap(
  root: string,
  index: RepoIndex,
  query: string,
  limit: number,
  subPath?: string
): Promise<string | null> {
  if (Date.now() < deadUntil) return null
  const q = query.trim()
  if (!q || index.files.length === 0) return null

  const ep = await pickEndpoint()
  if (!ep) return null

  let files = index.files
  if (subPath) {
    const prefix = subPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
    files = files.filter((f) => f.path === prefix || f.path.startsWith(`${prefix}/`))
  }
  if (!files.length) return null

  /**
   * 粗筛：符号 / 路径 / 摘要里已经包含查询词的优先参与向量计算，
   * 都不含的时候（模型用自然语言提问的典型情况）就只能全量算了 —— 此时按上限截断。
   */
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  const literal = files.filter((f) => {
    const hay = `${f.path} ${f.symbols.join(' ')} ${f.summary}`.toLowerCase()
    return terms.some((t) => hay.includes(t))
  })
  const pool = (literal.length >= 20 ? literal : files).slice(0, MAX_FILES)

  const cache = await loadCache(root, ep.model)
  const need: FileNode[] = []
  for (const f of pool) {
    const h = hashOf(descriptor(f))
    const hit = cache.files[f.path]
    if (!hit || hit.hash !== h) need.push(f)
  }

  // 新文件按每批 16 个算，别把本地服务一次性压死
  for (let i = 0; i < need.length; i += 16) {
    const chunk = need.slice(i, i + 16)
    const vecs = await embedBatch(
      ep,
      chunk.map((f) => descriptor(f))
    )
    if (!vecs) {
      // 服务没起来 / 模型不支持 embedding：冷却五分钟，期间直接走词面检索
      deadUntil = Date.now() + 5 * 60 * 1000
      return null
    }
    chunk.forEach((f, k) => {
      cache.files[f.path] = { hash: hashOf(descriptor(f)), vec: toB64(vecs[k]) }
      if (!cache.dim) cache.dim = vecs[k].length
    })
  }
  if (need.length) await saveCache(root, cache)

  const qv = await embedBatch(ep, [q])
  if (!qv || !qv[0]) {
    deadUntil = Date.now() + 5 * 60 * 1000
    return null
  }
  const qvec = fromB64(toB64(qv[0]))

  const scored: Array<{ f: FileNode; s: number }> = []
  for (const f of pool) {
    const hit = cache.files[f.path]
    if (!hit) continue
    scored.push({ f, s: cosine(qvec, fromB64(hit.vec)) })
  }
  scored.sort((a, b) => b.s - a.s)
  const top = scored.slice(0, Math.max(1, Math.min(60, limit)))

  if (!top.length) return null
  const lines = top.map((h, i) => {
    const sym = h.f.symbols.length ? `  ${h.f.symbols.slice(0, 10).join('、')}` : ''
    const sum = h.f.summary ? `  — ${h.f.summary}` : ''
    return `${i + 1}. ${h.f.path}${sym}${sum}`
  })
  return [
    `语义检索「${q}」命中 ${top.length} 个文件（本地 embedding，按相关度排序）：`,
    '',
    ...lines,
    '',
    '下一步：用 read_file 精读最像的几个；要看完整目录结构就去掉 query 重新调 repo_map。'
  ].join('\n')
}
