import type {
  AppConfig,
  ProviderConfig,
  WorkerPlan,
  WorkerPoolMember
} from '../shared/types'
import { isLlamaProvider } from '../shared/providers'
import {
  describeIsolation,
  laneCount,
  pickSubAgentPool,
  subAgentProviders
} from '../shared/agentpool'
import { queueInfoOf } from './gate'
import { providerCooling } from './health'
import { llamaInstances, startLlama, statusLlama } from './llama'

/**
 * 子智能体池 —— 派出去的子代理用哪些模型干活。
 *
 * 成员完全由「④ 模型列表」里的主 / 子决定：主是当前对话那条，标了「子」的进池。
 * 本地和线上同一套规则，不再按「拆了几块卡」自动推导。
 *
 * 池里有多条时，一批子任务按忙闲分派到不同实例 —— 只 `find` 第一条会让
 * 第二张卡白占显存，用户看到的是「配了两个子智能体，活全挤在一个上」。
 *
 * 纯判定（能不能分得开、卡组有没有重叠）在 shared/agentpool.ts；
 * 本模块只负责把「配置」翻译成「这次真正能接请求的实例池」并负责起停。
 * 不能在能并行的时候悄悄回落主模型而不说明 —— 界面要能显示原因。
 */

export interface WorkerPoolResult {
  /** 现在能接请求的实例，按配置顺序 */
  pool: WorkerPoolMember[]
  /** 标了「子」但这次用不了的 */
  skipped: Array<{ provider: ProviderConfig; reason: string; cooling?: boolean }>
  /** 配置里声明为子智能体的总数 */
  configuredCount: number
}

/** 闸门里活跃 + 排队的请求数：挑实例时用它当忙闲权重 */
function loadOf(p: ProviderConfig): number {
  const q = queueInfoOf(p.baseUrl)
  return q ? q.active + q.queued : 0
}

/**
 * 算出这次派子代理能用哪些实例。不启动任何进程，纯判断 + 每槽查一次状态，可以随便调。
 */
export async function workerPool(
  main: ProviderConfig,
  config: AppConfig
): Promise<WorkerPoolResult> {
  const { accepted, skipped: picked } = pickSubAgentPool(main, config.providers)
  /** 比 pickSubAgentPool 多一个 cooling 标记：冷却中的远端 worker 也在这里被跳过 */
  const skipped: WorkerPoolResult['skipped'] = [...picked]
  const pool: WorkerPoolMember[] = []

  for (const { provider, isolation } of accepted) {
    const reason = describeIsolation(isolation, main, provider)
    // 远端 API 不需要预热，直接可用
    if (!isLlamaProvider(provider)) {
      /**
       * 但「不用预热」不等于「一定接得住」。
       *
       * 以前这里无条件 ready:true，于是刚被 429 限流的那家还被算成就绪 ——
       * 几路只读审查全压上去、一起 429、一起白跑。冷却中的先跳过，
       * 让这批活落到别的 worker 或主模型上（跳过原因会一起交给界面与 task.note）。
       */
      const cool = providerCooling(provider.id)
      if (cool) {
        skipped.push({
          provider,
          cooling: true,
          reason: `${provider.name || provider.model} 刚${cool.reason}，${cool.seconds} 秒内先不往它身上派活`
        })
        continue
      }
      pool.push({ provider, isolation, ready: true, load: loadOf(provider), reason })
      continue
    }
    // 本地实例：只有真的在服务才算就绪。加载中（503）也不能用，
    // 否则子代理第一步就撞 503 白跑一趟。
    const st = await statusLlama(provider.id).catch(() => null)
    if (st?.running) {
      pool.push({ provider, isolation, ready: true, load: loadOf(provider), reason })
    } else {
      skipped.push({
        provider,
        reason: `${provider.name || provider.model} 还没启动，本次用主模型；下次派活前会自动拉起`
      })
    }
  }

  return {
    pool,
    skipped,
    configuredCount: subAgentProviders(config.providers, main.id).length
  }
}

/**
 * 本次真能并行几路 —— 提示层和执行层共用的那个数。
 *
 * 每步模型循环都会问一次，而查本地实例要走一次 HTTP（`statusLlama` → `/health`），
 * 所以给 5 秒缓存：提示措辞晚几秒跟上没有代价，每步多打一次 HTTP 才有。
 * 池子变了（起了个 worker、某家进了冷却）最多滞后这么久，可以接受。
 */
const LANE_TTL_MS = 5_000
let laneMemo: { key: string; at: number; lanes: number } | null = null

export async function parallelLanes(main: ProviderConfig, config: AppConfig): Promise<number> {
  const key = [
    main.id,
    main.model ?? '',
    ...config.providers.map((p) => `${p.id}:${p.role ?? ''}:${p.model ?? ''}`)
  ].join('|')
  const now = Date.now()
  if (laneMemo && laneMemo.key === key && now - laneMemo.at < LANE_TTL_MS) return laneMemo.lanes
  const lines = await workerPool(main, config).catch(() => null)
  const lanes = laneCount(lines?.pool.length ?? 0, isLlamaProvider(main))
  laneMemo = { key, at: now, lanes }
  return lanes
}

/** 人能看懂的池结论：没配 / 全部不可用 / 几条就绪，都说清楚 */
function poolReason(r: WorkerPoolResult): string {
  if (r.configuredCount === 0) {
    return '没有子智能体（在「④ 模型列表」把模型设为「子」才生效），子代理沿用当前模型'
  }
  if (r.pool.length === 0) {
    const why = r.skipped[0]?.reason ?? '子智能体都不可用'
    if (r.configuredCount === 1) {
      return /本次用主模型/.test(why) ? why : `${why}。本次用主模型`
    }
    return `子智能体 ${r.configuredCount} 个都不可用：${why}。本次用主模型`
  }
  if (r.configuredCount === 1) return r.pool[0].reason

  const cards = r.pool
    .slice(0, 4)
    .map((m) => m.provider.device?.trim() || (isLlamaProvider(m.provider) ? '自动' : '远端'))
    .join('、')
  const more = r.pool.length > 4 ? ` 等 ${r.pool.length} 张卡` : ''
  const skipped = r.skipped.length ? `；${r.skipped.length} 个暂不可用` : ''
  return `子智能体：${r.pool.length}/${r.configuredCount} 个就绪（${cards}${more}），子任务按忙闲分派${skipped}`
}

/**
 * 兼容入口：设置页「检查能否并行」和主进程 IPC 都还在用 WorkerPlan。
 * `provider` 保留为 pool[0]，旧的调用方（只看 provider / reason）不用改。
 */
export async function workerPlan(
  main: ProviderConfig,
  config: AppConfig
): Promise<WorkerPlan> {
  const r = await workerPool(main, config)
  const head = r.pool[0] ?? null
  return {
    provider: head?.provider ?? null,
    configured: head?.provider ?? r.skipped[0]?.provider ?? null,
    isolation: head?.isolation ?? 'none',
    parallel: r.pool.length > 0,
    ready: r.pool.length > 0,
    reason: poolReason(r),
    pool: r.pool,
    skipped: r.skipped,
    configuredCount: r.configuredCount
  }
}

/** 同一时刻只允许一个预热流程，避免连着切两次模型时起两组进程 */
let warming: Promise<{ ok: boolean; message: string }> | null = null

/** 单个实例从「已下达启动」等到「能接请求」；超时就放手，让下一个接着加载 */
async function waitWorkerReady(id: string, timeoutMs = 45_000): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const st = await statusLlama(id).catch(() => null)
    if (st?.running) return true
    // 启动失败进程已经退出：别把整池的时间耗在一个死掉的实例上
    if (!llamaInstances().some((i) => i.key === id)) return false
  }
  return false
}

/**
 * 后台把池里的本地子智能体拉起来。
 *
 * 由「切换对话模型」或「派子代理发现一个都没就绪」触发，不阻塞界面：
 * 模型加载要几十秒，等它不如先让用户聊起来。子代理派活时只查状态、不等。
 *
 * **串行 + 等就绪再起下一个**：多张卡同时冷加载会瞬间把显存/内存打满，
 * 而且 startLlama 各自要探测端口，并发起容易撞上同一个空闲端口。
 * 就绪一个才纳入池一个（workerPool 只认 running），没起来的不占名额。
 */
export async function warmWorker(
  main: ProviderConfig,
  config: AppConfig
): Promise<{ ok: boolean; message: string }> {
  if (warming) return warming

  warming = (async () => {
    const { accepted, skipped } = pickSubAgentPool(main, config.providers)
    if (!accepted.length) {
      if (skipped.length) return { ok: false, message: `已跳过预热：${skipped[0].reason}` }
      return { ok: true, message: '没有子智能体（在模型列表里把模型设为「子」后才会预热）' }
    }

    const local = accepted.filter(({ provider }) => isLlamaProvider(provider))
    const remote = accepted.length - local.length
    let started = 0
    let already = 0
    const failed: string[] = []

    for (const { provider } of local) {
      const st = await statusLlama(provider.id).catch(() => null)
      if (st?.running || st?.loading || llamaInstances().some((i) => i.key === provider.id)) {
        already++
        continue
      }
      const r = await startLlama(provider.model, undefined, {
        providerId: provider.id,
        device: provider.device ?? null,
        port: provider.port
      })
      if (!r.ok) {
        failed.push(`${provider.name || provider.model}：${r.message}`)
        continue
      }
      started++
      await waitWorkerReady(provider.id)
    }

    const parts = [
      `子智能体：已启动 ${started} 个`,
      already ? `、已在运行 ${already} 个` : '',
      remote ? `、远端 ${remote} 个无需预热` : '',
      skipped.length ? `；跳过 ${skipped.length} 个（${skipped[0].reason}）` : '',
      failed.length ? `；失败：${failed.join('；')}` : ''
    ]
    return { ok: failed.length === 0, message: parts.join('') }
  })()

  try {
    return await warming
  } finally {
    warming = null
  }
}
