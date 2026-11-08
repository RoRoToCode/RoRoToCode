import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * 离线读取本机 Ollama 已经下载的模型。
 *
 * 为什么不用 /api/tags：那要求 Ollama 服务正在跑。用户很可能装了 Ollama、
 * 下了一堆模型，但服务没开（或者开在别的端口）。这时候「本机有 6 个模型、
 * 共 28G，其中 3 个适合当 coding agent」这个判断就完全给不出来 ——
 * 而它恰恰是本程序最该提供的东西：不抢运行时，抢判断层。
 *
 * Ollama 的存储格式（稳定多年）：
 *   models/manifests/<host>/[<namespace>/]<model>/<tag>   纯 JSON，无扩展名
 *   models/blobs/sha256-<hex>                              实际权重，无扩展名
 * 清单里的 layers 找一个 mediaType = application/vnd.ollama.image.model 的，
 * 它的 digest 就对应 blobs/sha256-<hex>。
 *
 * 注意 blob 没有 .gguf 后缀，所以按扩展名扫盘的逻辑一律看不见它们 ——
 * 只能靠这里读清单，再校验文件头是不是 GGUF。
 */

export interface OllamaDiskModel {
  /** 展示用：qwen2.5-coder:7b（library 命名空间会省掉，和 ollama list 一致） */
  name: string
  /** 主权重 blob 的绝对路径；可以直接喂给 llama-server 或 vramfit */
  blob: string
  sizeBytes: number
  /** 是否真的是 GGUF（旧版本可能是 GGML，那种 llama-server 也读不了） */
  gguf: boolean
}

export interface OllamaDiskScan {
  ok: boolean
  /** 模型目录；找不到时为 null */
  dir: string | null
  models: OllamaDiskModel[]
  message: string
}

/** Ollama 的模型根目录：优先环境变量，其次默认位置 */
export function ollamaModelsRoot(): string {
  const env = (process.env.OLLAMA_MODELS ?? '').trim()
  if (env) return env
  return path.join(os.homedir(), '.ollama', 'models')
}

const MODEL_MEDIA_TYPE = 'application/vnd.ollama.image.model'
/** 清单文件很小，但恶意/损坏的 JSON 不该把内存吃光 */
const MAX_MANIFEST_BYTES = 256 * 1024
/** 兜底上限：真有人存了几千个也不该卡住启动 */
const MAX_MODELS = 400

interface ManifestLayer {
  mediaType?: string
  digest?: string
  size?: number
}

/** digest `sha256:abc` → blob 文件名 `sha256-abc` */
function blobNameOf(digest: string): string {
  return String(digest).replace(':', '-')
}

/** 读文件头 4 字节，判断是不是 GGUF */
export async function isGgufFile(file: string): Promise<boolean> {
  try {
    const fh = await fs.open(file, 'r')
    try {
      const buf = Buffer.alloc(4)
      const { bytesRead } = await fh.read(buf, 0, 4, 0)
      return bytesRead === 4 && buf.toString('latin1') === 'GGUF'
    } finally {
      await fh.close()
    }
  } catch {
    return false
  }
}

/** 递归收集 manifests 下的所有清单文件 */
async function listManifests(root: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > 6 || out.length >= MAX_MODELS * 2) return out
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    for (const e of entries) {
      const p = path.join(root, e.name)
      if (e.isDirectory()) await listManifests(p, depth + 1, out)
      else out.push(p)
    }
  } catch {
    // 目录读不了（权限 / 已被删）：跳过这一层
  }
  return out
}

/**
 * 清单相对路径 → 模型名。
 * registry.ollama.ai/library/qwen2.5-coder/7b → qwen2.5-coder:7b
 * registry.ollama.ai/someone/mymodel/v2       → someone/mymodel:v2
 */
function nameFromRel(rel: string): string | null {
  const parts = rel.split(/[\\/]+/).filter(Boolean)
  // 至少要有 <host>/<model>/<tag>
  if (parts.length < 3) return null
  const rest = parts.slice(1)
  const tag = rest.pop() as string
  const model = rest.filter((s) => s !== 'library').join('/')
  return model ? `${model}:${tag}` : null
}

/**
 * 扫一遍本机 Ollama 的模型目录。纯只读，不需要 Ollama 在跑。
 * 目录不存在不是错误 —— 只表示这台机器没装过 Ollama。
 */
export async function scanOllamaDisk(): Promise<OllamaDiskScan> {
  const root = ollamaModelsRoot()
  const manifestsDir = path.join(root, 'manifests')
  const blobsDir = path.join(root, 'blobs')

  const exists = await fs
    .stat(manifestsDir)
    .then((s) => s.isDirectory())
    .catch(() => false)
  if (!exists) {
    return { ok: true, dir: null, models: [], message: '没有找到 Ollama 模型目录（可能没装过 Ollama）' }
  }

  const manifests = await listManifests(manifestsDir)
  const models: OllamaDiskModel[] = []
  const seen = new Set<string>()

  for (const file of manifests) {
    if (models.length >= MAX_MODELS) break
    const rel = path.relative(manifestsDir, file)
    const name = nameFromRel(rel)
    if (!name || seen.has(name)) continue
    try {
      const st = await fs.stat(file)
      if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) continue
      const json = JSON.parse(await fs.readFile(file, 'utf8')) as { layers?: ManifestLayer[] }
      const layers = Array.isArray(json.layers) ? json.layers : []
      // 分片模型会有多个 model 层：取最大的那块（llama-server 认不了 Ollama 的 blob
      // 命名分片，所以这里只保证「能体检、能导入」，不承诺直接分片加载）
      const modelLayer = layers
        .filter((l) => l.mediaType === MODEL_MEDIA_TYPE && l.digest)
        .sort((a, b) => Number(b.size ?? 0) - Number(a.size ?? 0))[0]
      if (!modelLayer?.digest) continue
      const blob = path.join(blobsDir, blobNameOf(modelLayer.digest))
      const bst = await fs.stat(blob).catch(() => null)
      if (!bst?.isFile()) continue
      seen.add(name)
      models.push({
        name,
        blob,
        sizeBytes: bst.size,
        gguf: await isGgufFile(blob)
      })
    } catch {
      // 单个清单坏了不影响其它模型
    }
  }

  models.sort((a, b) => b.sizeBytes - a.sizeBytes)
  return {
    ok: true,
    dir: root,
    models,
    message: models.length ? `Ollama 里已有 ${models.length} 个模型` : 'Ollama 目录是空的'
  }
}
