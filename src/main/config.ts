import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AppConfig, ProviderConfig } from '../shared/types'
import { parseLimit } from '../shared/quota'
import { partialModeOf } from '../shared/ctxtune'
import { seal, unseal } from './secrets'

const FILE = 'config.json'

/**
 * 首次启动只带三个「本地运行时」入口（Ollama / LM Studio / llama.cpp）。
 *
 * 云端接口不再预置：没填 Key 的 OpenAI / Anthropic 条目既用不了又占列表，
 * 用户想接哪家，到「模型设置 → 模型 API」点「添加」自己填地址和 Key 即可。
 * 这三个本地条目是「本地模型」页的探测与启动入口，不是预设 API，必须保留。
 */
export function defaultProviders(): ProviderConfig[] {
  return [
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
      /**
       * 必须是 openai，不能是 ollama。
       *
       * kind='ollama' 会把请求发到 `<根>/api/chat`（见 providers/index.ts 的分发），
       * 而 LM Studio 的接口是 `/api/v0/*` / `/api/v1/*` 加 OpenAI 兼容的
       * `/v1/chat/completions`，**没有** `/api/chat` —— 实测直接 404
       * “404 page not found: POST /api/chat”，选上它就一句都聊不了。
       * 走 OpenAI 兼容层还能顺带解决嵌入（/v1/embeddings）。
       */
      kind: 'openai',
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
    diagnoseOnWrite: true,
    formatOnWrite: true,
    webSearch: true,
    memory: true,
    proxyUrl: '',
    mcpEnabled: true,
    autoFallback: true,
    // 默认开：任务没做完（计划里还有未完成项 / 模型过早收工）时自己接着跑，不用手点「继续」
    autoContinue: true,
    // 用量闸门默认不限：不配置的人行为完全不变，想限流的人在设置里填数字
    tokenLimitPerRun: 0,
    tokenLimitPerDay: 0,
    // 工作区钩子默认不执行：那是随仓库走的可执行代码，必须由用户显式信任
    trustWorkspaceHooks: false,
    // 空闲 10 分钟释放显存；下一次发消息自动拉起
    llamaIdleMin: 10,
    // 分层加载：默认「按模型自动」—— 装不下的模型才分层，普通模型全放显存
    llamaPartialOffload: true,
    llamaPartialOffloadMode: 'auto'
  }
}

/**
 * 空闲卸载时长（分钟）。
 *
 * 0 是合法值且含义特殊（关闭），所以不能像其它数值项那样把 0 当「没填」回落到默认。
 * 上限 240 分钟：再长就等于常驻了，不如直接关掉这个功能，语义更清楚。
 */
export function normalizeIdleMin(n: unknown, fallback = 10): number {
  if (n === undefined || n === null || n === '') return fallback
  const v = Math.round(Number(n))
  if (!Number.isFinite(v) || v < 0) return fallback
  return Math.min(v, 240)
}

/** 全局上下文长度的合法范围（tokens） */
export const CONTEXT_RANGE = { min: 2048, max: 262144 } as const

export function normalizeContext(n: unknown, fallback = 32768): number {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v) || v <= 0) return fallback
  return Math.min(Math.max(v, CONTEXT_RANGE.min), CONTEXT_RANGE.max)
}

/**
 * 带上下界的可选数值：没填就保持「未设置」，越界就当没填。
 *
 * 和 normalizeContext 的区别是这里不回落默认 —— 采样参数要区分
 * 「用户想要服务端默认」和「用户填了个具体值」，前者必须留空。
 */
function inRange(n: unknown, min: number, max: number): number | undefined {
  if (n === undefined || n === null || n === '') return undefined
  const v = Number(n)
  if (!Number.isFinite(v) || v < min || v > max) return undefined
  return v
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
     * 分层开关的迁移必须按**磁盘原文**判，不能用合并后的值。
     *
     * `defaultConfig()` 里已经有 `llamaPartialOffloadMode: 'auto'`，
     * 如果拿合并结果判断，老配置里的 `llamaPartialOffload: false`（用户明确关过）
     * 会被默认值盖住，升级后静默变回 auto —— 用户会以为设置被重置了。
     */
    cache.llamaPartialOffloadMode = partialModeOf({
      mode: parsed.llamaPartialOffloadMode,
      enabled: parsed.llamaPartialOffload
    })

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
    /**
     * 老版本预置过两条没填 Key 的云端供应商（OpenAI 兼容 / Anthropic）。
     * 现在云端接口一律由用户自己添加，把这些「空白预设」清掉：
     * 它们在列表里看着像配好了，其实选上就 401。用户填过 Key 的同名条目必须保留。
     */
    const cfg = cache as AppConfig
    const blankPresets = new Set(['openai-compat', 'anthropic'])
    const kept = cfg.providers.filter(
      (p) => !(blankPresets.has(p.id) && !(p.apiKey ?? '').trim())
    )
    if (kept.length !== cfg.providers.length) {
      cfg.providers = kept.length ? kept : defaultProviders()
      if (cfg.activeId && !cfg.providers.some((p) => p.id === cfg.activeId)) {
        cfg.activeId = cfg.providers[0]?.id ?? null
      }
      await saveConfig(cfg)
    }

    /**
     * LM Studio 的协议迁移。
     *
     * 老默认值把这一条写成 kind='ollama'，于是每次对话都打到 `/api/chat`；
     * LM Studio（含 1.x 的 Bionic）没有这个路由，返回 404，模型选得好好的却一句都答不上来。
     * 只修协议字段，地址 / 模型 / Key 一律不动 —— 用户改过的端口和模型名必须留着。
     */
    const lms = cfg.providers.find((p) => p.id === 'lmstudio' && p.kind !== 'openai')
    if (lms) {
      lms.kind = 'openai'
      await saveConfig(cfg)
    }
  } catch {
    cache = defaultConfig()
    await saveConfig(cache)
  }
  return cache
}

/**
 * 配置写入串行化。
 *
 * `saveConfig` 的调用方都是「loadConfig → 改字段 → saveConfig」这种读-改-写模式。
 * 探测链会在几秒内连写两次（中间档位 + 最终档位），启动流程和设置面板也可能同时写。
 * 不排队的话，后落盘的那次会拿着旧快照把前一次的修改整体覆盖掉 ——
 * 表现就是「刚改的设置自己变回去了」，而且没有任何报错。
 */
let writeChain: Promise<unknown> = Promise.resolve()

/** 真正落盘的那一层：只被 saveConfig 的队列调用 */
async function writeConfigNow(next: AppConfig): Promise<AppConfig> {
  // 归一化后的明文版本：内存缓存与返回值都用它，请求头里绝不能出现密文
  const plain: AppConfig = {
    providers: next.providers.map((p) => ({
      ...p,
      baseUrl: (p.baseUrl || '').trim().replace(/\/+$/, ''),
      model: (p.model || '').trim(),
      /**
       * 采样参数留空（undefined）表示「用服务端默认」，这和「填 0」是两件事：
       * top_p=0 会让采样退化成贪心，用户想要默认时不该被悄悄改成 0。
       * 越界的值直接丢弃，别带着一个会让模型胡言乱语的数去请求。
       */
      topP: inRange(p.topP, 0.01, 1),
      repeatPenalty: inRange(p.repeatPenalty, 0.5, 2),
      jsonMode: p.jsonMode === true ? true : undefined
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
    diagnoseOnWrite: next.diagnoseOnWrite !== false,
    formatOnWrite: next.formatOnWrite !== false,
    // 老配置里没有这两项：只把明确的 false 当作关闭，其余都按开启处理
    webSearch: next.webSearch !== false,
    memory: next.memory !== false,
    proxyUrl: (next.proxyUrl ?? '').trim(),
    mcpEnabled: next.mcpEnabled !== false,
    // 老配置没有这一项：默认开启（只有显式 false 才关）
    autoFallback: next.autoFallback !== false,
    autoContinue: next.autoContinue !== false,
    // 用量上限：0 表示不限。用 parseLimit 归一化，负数 / NaN 都落到 0，
    // 避免一次手滑保存就把所有会话卡死（0 是「不限」而不是「立刻停」）
    tokenLimitPerRun: parseLimit(next.tokenLimitPerRun),
    tokenLimitPerDay: parseLimit(next.tokenLimitPerDay),
    // 默认关：老配置里没有这一项，也就等于「不信任工作区钩子」，这正是我们要的
    trustWorkspaceHooks: next.trustWorkspaceHooks === true,
    // 老配置没有：按默认 10 分钟卸载；分层加载默认「按模型自动」
    llamaIdleMin: normalizeIdleMin(next.llamaIdleMin),
    /**
     * 分层模式：新字段优先，老配置里的布尔值负责迁移。
     *
     * `true` 翻译成 `auto` 而不是 `on`：老版本的 `true` 本来就只在「体检判定装不下」
     * 时才生效，`auto` 才是它真实的语义。老配置里的 `false` 保留为 `off`。
     * 落盘同时写一份布尔值，让降级回旧版本时不至于把「关」读成「开」。
     */
    ...(() => {
      const mode = partialModeOf({
        mode: next.llamaPartialOffloadMode,
        enabled: next.llamaPartialOffload
      })
      return { llamaPartialOffloadMode: mode, llamaPartialOffload: mode !== 'off' }
    })(),
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

/**
 * 写配置：排队执行，保证「读-改-写」不会互相覆盖。
 *
 * 队列里一次失败不能卡死后面的写入，所以用 catch 把链恢复成 resolved。
 */
export function saveConfig(next: AppConfig): Promise<AppConfig> {
  const run = writeChain.then(
    () => writeConfigNow(next),
    () => writeConfigNow(next)
  )
  writeChain = run.catch(() => undefined)
  return run
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

/**
 * 会话真正要用的供应商配置。
 *
 * modelOverride 是「同一家供应商换个模型」：本地 llama.cpp 的 provider 里
 * 存的是启动参数和默认模型，换模型不该改全局配置（会把别的会话一起带跑偏）。
 * 这里返回副本，调用方拿到的 provider.model 就是这次要发的模型名。
 */
export function resolveProvider(
  config: AppConfig,
  providerId?: string | null,
  modelOverride?: string | null
): ProviderConfig | null {
  const base = providerForSession(config, providerId)
  if (!base) return null
  const model = (modelOverride ?? '').trim()
  if (!model || model === base.model) return base
  return { ...base, model }
}
