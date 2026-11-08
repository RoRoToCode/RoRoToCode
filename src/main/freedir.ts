import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FreeCatalog, FreeModel, FreeSource } from '../shared/types'

/**
 * 免费模型目录。
 *
 * 两个来源：
 *  - OpenRouter 的公开目录接口（不需要 key），筛「输入输出都为 0」且支持工具调用的对话模型；
 *  - 几个固定推荐位（Groq / Google / 硅基流动 / GitHub Models）：它们没有公开目录，
 *    填好 key 之后由「拉取模型列表」现读，所以这里只给地址和申请入口。
 *
 * 结果缓存 12 小时，断网时退回上次的缓存，不让设置页白屏。
 */

const TTL = 12 * 60 * 60 * 1000
const CACHE = 'free-models.json'

interface OpenRouterModel {
  id?: string
  name?: string
  context_length?: number
  supported_parameters?: string[]
  pricing?: { prompt?: string; completion?: string }
  architecture?: { output_modalities?: string[] }
  top_provider?: { context_length?: number }
}

const PRESETS: Array<Omit<FreeSource, 'models'>> = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    hint: '一个 key 通用上百个模型；免费模型带 :free 后缀，一般限 20 次/分钟，适合当备用。'
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    hint: '免费档速度很快，按天限量；填 key 后点「拉取模型列表」看实际可用型号。'
  },
  {
    id: 'google',
    name: 'Google AI Studio',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    keyUrl: 'https://aistudio.google.com/apikey',
    hint: 'Gemini 的 OpenAI 兼容端点，免费额度较大，适合长上下文任务。'
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    kind: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    hint: '国内直连，部分小模型免费；key 注册即得。'
  },
  {
    id: 'github',
    name: 'GitHub Models',
    kind: 'openai',
    baseUrl: 'https://models.github.ai/inference',
    keyUrl: 'https://github.com/settings/tokens',
    hint: '用 GitHub 个人访问令牌当 key，有免费额度，适合已有 GitHub 账号的人。'
  }
]

function cachePath(): string {
  return path.join(app.getPath('userData'), CACHE)
}

const isFree = (m: OpenRouterModel): boolean =>
  Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0

const isChat = (m: OpenRouterModel): boolean => {
  const id = (m.id ?? '').toLowerCase()
  // 目录里混着向量、语音、重排模型，接进 agent 也用不了
  if (/(embed|rerank|whisper|tts|audio|speech|moderation|guard)/.test(id)) return false
  const out = m.architecture?.output_modalities
  return !out || out.includes('text')
}

/** 免费模型里支持工具调用的才值得给 agent 用 */
function toFreeModel(m: OpenRouterModel): FreeModel {
  const ctx = Number(m.context_length ?? m.top_provider?.context_length ?? 0)
  return {
    id: m.id ?? '',
    name: m.name || m.id || '未知模型',
    context: Number.isFinite(ctx) ? ctx : 0,
    tools: (m.supported_parameters ?? []).includes('tools')
  }
}

async function fromOpenRouter(signal: AbortSignal): Promise<FreeModel[]> {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { accept: 'application/json' },
    signal
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as { data?: OpenRouterModel[] }
  const list = (json.data ?? []).filter((m) => m.id && isFree(m) && isChat(m))
  const mapped = list.map(toFreeModel)
  // 支持工具的排前面，其次按上下文从大到小；只要前 60 个，列表太长反而挑不出来
  mapped.sort((a, b) => Number(b.tools) - Number(a.tools) || b.context - a.context)
  return mapped.slice(0, 60)
}

async function readCache(): Promise<{ fetchedAt: number; models: FreeModel[] } | null> {
  try {
    const raw = await fs.readFile(cachePath(), 'utf8')
    const json = JSON.parse(raw) as { fetchedAt?: number; models?: FreeModel[] }
    if (!json.fetchedAt || !Array.isArray(json.models)) return null
    return { fetchedAt: json.fetchedAt, models: json.models }
  } catch {
    return null
  }
}

async function writeCache(models: FreeModel[]): Promise<number> {
  const fetchedAt = Date.now()
  try {
    await fs.mkdir(path.dirname(cachePath()), { recursive: true })
    await fs.writeFile(cachePath(), JSON.stringify({ fetchedAt, models }, null, 1), 'utf8')
  } catch {
    // 缓存写不进去也能用，只是下次还要联网
  }
  return fetchedAt
}

export async function freeCatalog(refresh = false): Promise<FreeCatalog> {
  const cached = await readCache()
  const fresh = cached && Date.now() - cached.fetchedAt < TTL

  if (cached && fresh && !refresh) return build(cached.models, cached.fetchedAt)

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 15000)
  try {
    const models = await fromOpenRouter(ctl.signal)
    const fetchedAt = await writeCache(models)
    return build(models, fetchedAt)
  } catch (err) {
    const reason = (err as Error).message.includes('abort') ? '请求超时' : (err as Error).message
    // 断网时用旧缓存，至少还能挑；一次都没成功过就把错误显示出来
    if (cached?.models.length) {
      return { ...build(cached.models, cached.fetchedAt), error: `目录刷新失败（${reason}），显示的是上次的结果` }
    }
    return build([], 0, `拉取免费模型目录失败：${reason}`)
  } finally {
    clearTimeout(timer)
  }
}

function build(models: FreeModel[], fetchedAt: number, error?: string): FreeCatalog {
  const sources: FreeSource[] = PRESETS.map((p) =>
    p.id === 'openrouter' ? { ...p, models, ...(error ? { error } : {}) } : { ...p, models: [] }
  )
  return { sources, fetchedAt, ...(error ? { error } : {}) }
}
