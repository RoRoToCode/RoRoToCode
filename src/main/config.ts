import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AppConfig, ProviderConfig } from '../shared/types'
import { seal, unseal } from './secrets'

const FILE = 'config.json'

export function defaultProviders(): ProviderConfig[] {
  return [
    {
      id: 'openai-compat',
      name: 'OpenAI 兼容',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
      contextWindow: 128000,
      temperature: 0.2
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: '',
      model: 'claude-sonnet-4-20250514',
      contextWindow: 200000,
      temperature: 0.2
    },
    {
      id: 'ollama',
      name: 'Ollama 本地',
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'ollama',
      model: 'qwen2.5-coder:7b',
      contextWindow: 32768,
      temperature: 0.2
    },
    {
      id: 'lmstudio',
      name: 'LM Studio 本地',
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'lm-studio',
      model: 'qwen2.5-coder-7b-instruct',
      contextWindow: 32768,
      temperature: 0.2
    },
    {
      id: 'llamacpp',
      name: 'llama.cpp 本地',
      kind: 'openai',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: 'no-key',
      model: '',
      contextWindow: 16384,
      temperature: 0.2
    }
  ]
}

export function defaultConfig(): AppConfig {
  return {
    providers: defaultProviders(),
    activeId: 'ollama',
    workspace: null,
    approvalMode: 'ask',
    maxSteps: 30,
    // 默认不限制上下文：模型能记多少就记多少，撑不住了再靠自动压缩
    contextLimit: false,
    contextWindow: 32768,
    autoCompact: true,
    autoVerify: true,
    webSearch: true,
    memory: true,
    proxyUrl: '',
    mcpEnabled: true,
    autoFallback: true,
    // 默认开：任务没做完（计划里还有未完成项 / 模型过早收工）时自己接着跑，不用手点「继续」
    autoContinue: true
  }
}

/** 全局上下文长度的合法范围（tokens） */
export const CONTEXT_RANGE = { min: 2048, max: 262144 } as const

export function normalizeContext(n: unknown, fallback = 32768): number {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v) || v <= 0) return fallback
  return Math.min(Math.max(v, CONTEXT_RANGE.min), CONTEXT_RANGE.max)
}

function configPath(): string {
  return path.join(app.getPath('userData'), FILE)
}

/** 未选择工作区时的默认目录：软件根目录下的 workspace/ */
export function defaultWorkspaceDir(): string {
  const base =
    process.env.PORTABLE_EXECUTABLE_DIR ||
    (app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath())
  return path.join(base, 'workspace')
}

/** 取当前实际使用的工作区，必要时创建默认目录 */
export async function effectiveWorkspace(config: AppConfig): Promise<string> {
  const ws = config.workspace ?? defaultWorkspaceDir()
  await fs.mkdir(ws, { recursive: true }).catch(() => undefined)
  return ws
}

let cache: AppConfig | null = null

export async function loadConfig(): Promise<AppConfig> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(configPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppConfig>
    cache = { ...defaultConfig(), ...parsed }

    /**
     * 读盘后把密钥解密回内存（cache 里始终是明文，落盘才加密）。
     * 解不开的记为 undecryptable，让设置页提示「请重新填写」——
     * 不能当成空字符串，那会变成「明明有 key 却一直 401」。
     */
    const bad: string[] = []
    let plainLeft = false
    cache.providers = cache.providers.map((p) => {
      const raw = p.apiKey ?? ''
      const plain = unseal(raw)
      if (plain === null) {
        bad.push(p.id)
        return { ...p, apiKey: '' }
      }
      if (raw && !raw.startsWith('enc:v1:')) plainLeft = true
      return { ...p, apiKey: plain }
    })
    if (bad.length) cache.undecryptable = bad
    // 老配置里的明文 key：读到的这次就顺手加密落盘，不用等用户改设置
    if (plainLeft) {
      await saveConfig(cache)
      if (bad.length) cache.undecryptable = bad
    }
    if (!Array.isArray(cache.providers) || cache.providers.length === 0) {
      // 配置被清空过：回填默认条目并落盘，否则每次启动都会重新生成一份临时列表
      cache.providers = defaultProviders()
      if (!cache.activeId) cache.activeId = 'llamacpp'
      await saveConfig(cache)
    } else if (!cache.providers.some((p) => p.id === 'llamacpp')) {
      // 老配置升级：补上 llama.cpp 本地端点，不影响已有条目
      const llamacpp = defaultProviders().find((p) => p.id === 'llamacpp')
      if (llamacpp) {
        cache.providers = [...cache.providers, llamacpp]
        await saveConfig(cache)
      }
    }
  } catch {
    cache = defaultConfig()
    await saveConfig(cache)
  }
  return cache
}

export async function saveConfig(next: AppConfig): Promise<AppConfig> {
  // 归一化后的明文版本：内存缓存与返回值都用它，请求头里绝不能出现密文
  const plain: AppConfig = {
    providers: next.providers.map((p) => ({
      ...p,
      baseUrl: (p.baseUrl || '').trim().replace(/\/+$/, ''),
      model: (p.model || '').trim()
    })),
    activeId: next.activeId ?? null,
    workspace: next.workspace ?? null,
    approvalMode: next.approvalMode === 'auto' || next.approvalMode === 'readonly' ? next.approvalMode : 'ask',
    maxSteps: Math.min(Math.max(Number(next.maxSteps) || 30, 5), 100),
    // 老配置里没有这一项：只有显式 true 才算「限制上下文」，默认放开
    contextLimit: next.contextLimit === true,
    contextWindow: normalizeContext(next.contextWindow),
    autoCompact: next.autoCompact !== false,
    autoVerify: next.autoVerify !== false,
    // 老配置里没有这两项：只把明确的 false 当作关闭，其余都按开启处理
    webSearch: next.webSearch !== false,
    memory: next.memory !== false,
    proxyUrl: (next.proxyUrl ?? '').trim(),
    mcpEnabled: next.mcpEnabled !== false,
    // 老配置没有这一项：默认开启（只有显式 false 才关）
    autoFallback: next.autoFallback !== false,
    autoContinue: next.autoContinue !== false,
    // 解密失败的提示只在内存里有效，不落盘
    ...(next.undecryptable?.length ? { undecryptable: next.undecryptable } : {})
  }
  // 落盘版本：只在这一处加密，其余代码看到的都是明文
  const onDisk: AppConfig = {
    ...plain,
    providers: plain.providers.map((p) => ({ ...p, apiKey: seal(p.apiKey ?? '') }))
  }
  delete onDisk.undecryptable
  await fs.mkdir(path.dirname(configPath()), { recursive: true })
  await fs.writeFile(configPath(), JSON.stringify(onDisk, null, 2), 'utf8')
  cache = plain
  return plain
}

export function activeProvider(config: AppConfig): ProviderConfig | null {
  return config.providers.find((p) => p.id === config.activeId) ?? config.providers[0] ?? null
}

/** 会话级模型绑定优先：会话显式绑了 modelId 就用它，否则回落全局 activeId */
export function providerForSession(config: AppConfig, modelId?: string | null): ProviderConfig | null {
  if (modelId) {
    const found = config.providers.find((p) => p.id === modelId)
    if (found) return found
  }
  return activeProvider(config)
}
