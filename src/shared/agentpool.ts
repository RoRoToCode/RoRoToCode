import type { ProviderConfig, WorkerIsolation } from './types'
import { deviceClash, isLlamaProvider } from './providers'

/**
 * 「主智能体 / 子智能体」的纯判定层。
 *
 * 规则和线上模型完全一致：每条模型在「④ 模型列表」里有一个角色 —
 * - **主**：当前对话走的那一条（`activeId`，全局唯一）；
 * - **子**：`role = 'worker'`，进子智能体池，主 agent 派 task 时按忙闲分给它。
 *
 * 以前这里是「工作组」：本地模型按「几块卡各配好模型」**自动**成组，
 * 用户在模型列表里看不到也改不了谁是主、谁是子。现在取消自动推导，
 * 主 / 子一律由用户显式指定，本地和线上混在同一个池里。
 *
 * 仍然保留的只有一条硬约束：**两个本地 llama.cpp 实例落在同一块卡上会互相顶掉**
 * （startLlama 会让后者停掉前者），所以进池前要按卡组去重，并把人能看懂的原因
 * 一起交给界面 —— 配错了要说得出来，不能静默回落主模型。
 *
 * 这里不查进程状态、不 import 主进程模块，纯函数可直接单测。
 */

const dev = (d?: string | null): string => (d ?? '').trim().toUpperCase()
const isCpu = (d: string): boolean => d === 'CPU' || d === 'CPU0'

/** 池里的每条候选（判定通过，但不一定已经启动） */
export interface SubAgentMember {
  provider: ProviderConfig
  isolation: WorkerIsolation
}

export interface SubAgentPick {
  /** 能一起进池的：卡组互不重叠、且和主模型也分得开 */
  accepted: SubAgentMember[]
  /** 标了「子」但这次用不了的，附人能看懂的原因 */
  skipped: Array<{ provider: ProviderConfig; reason: string }>
}

/** 远端 API 默认能同时接几路子任务 */
export const DEFAULT_REMOTE_LANES = 3
/** 单条配置的车道上限：再多就是在拿同一家的限流赌运气 */
export const MAX_LANES_PER_PROVIDER = 8
/** 一次派活的总路数上限：防止模型一次拆出十几路把闸门塞满 */
export const MAX_LANES = 8

/**
 * 一条配置能同时接几个子任务。
 *
 * 本地 llama 恒 1：一个 llama-server 只有一个推理槽，多开只会排队 + 各自重付 prefill，
 * 而且同一块卡上同时加载两个还会互相顶掉。
 * 远端按 `lanes`，留空用 3 —— 这就是改动前「没配 worker 时的云端回落值」，
 * 所以不填 `lanes` 的老配置行为不变。
 */
export function capacityOf(p: ProviderConfig): number {
  if (isLlamaProvider(p)) return 1
  const n = Math.round(Number(p.lanes) || 0)
  if (n <= 0) return DEFAULT_REMOTE_LANES
  return Math.min(MAX_LANES_PER_PROVIDER, n)
}

/**
 * 本次真能同时跑几路子任务 = 各成员车道数之和；池子空时就是主模型自己的车道数。
 *
 * 这个数有三个消费者：系统提示里的拆分规则、自动派发文案、`runTaskBatch` 的并发上限。
 * 以前三处各算各的 —— 提示看「配置里标了几个子」，执行看「池里几个就绪」——
 * 配了 1 个 worker 时提示教它「连写 2～3 个」、执行上限却是 1，几路只读审查排队串行，
 * 还全撞在同一家限流上。现在算式只此一份，三处都从这儿取。
 *
 * 改成「按容量求和」而不是「数条目」，修的是云端那半：一个 key 能接多个请求，
 * 不该因为列表里只有一行就被算成串行。
 */
export function laneCount(members: ProviderConfig[], main: ProviderConfig): number {
  const list = members.length ? members : [main]
  const total = list.reduce((n, p) => n + capacityOf(p), 0)
  return Math.min(MAX_LANES, Math.max(1, total))
}

/**
 * 配置里声明为「子智能体」的模型。
 *
 * 判据只有一条：显式 `role = 'worker'`。不再看「有没有绑卡 / 是不是拆分单卡」——
 * 那种自动成组用户改不掉，换个当前模型还会整组跟着重排，行为和线上模型对不上。
 * 排除主模型自己（同一个模型既主又子没有意义）和没选模型的空槽。
 */
export function subAgentProviders(
  providers: ProviderConfig[],
  mainId: string
): ProviderConfig[] {
  return providers.filter(
    (p) => p.id !== mainId && Boolean(p.model?.trim()) && p.role === 'worker'
  )
}

/**
 * 判断主模型和某个子智能体能不能同时驻留。
 *
 * 核心规则：**两个本地实例必须落在不同的设备上**。没绑卡一律按「分不开」，
 * 因为不传 `-dev` 时 llama.cpp 会自己按显存铺到所有卡上，等于两边往同一批卡挤。
 */
export function subIsolation(main: ProviderConfig, worker: ProviderConfig): WorkerIsolation {
  const mainLocal = isLlamaProvider(main)
  const workerLocal = isLlamaProvider(worker)

  // 子智能体在远端：不管主模型在哪，都不抢本地显存
  if (!workerLocal) return 'remote'
  // 主模型在远端、子智能体在本地：本地资源由子智能体独占
  if (!mainLocal) {
    const wd = dev(worker.device)
    return isCpu(wd) ? 'cpu' : 'gpu'
  }

  const md = dev(main.device)
  const wd = dev(worker.device)
  if (!md || !wd) return 'none'
  /** 按卡组判冲突：`CUDA0,CUDA1` 和 `CUDA0` 文字不等，但抢同一张卡 */
  if (deviceClash(main.device, worker.device)) return 'none'
  if (isCpu(md) !== isCpu(wd)) return 'cpu'
  return 'gpu'
}

/** 「分不开」的具体原因：必须说清是哪一边没配好，否则用户不知道该改哪儿 */
export function noneReason(main: ProviderConfig, worker: ProviderConfig): string {
  const md = dev(main.device)
  const wd = dev(worker.device)
  const label = worker.name || worker.model
  if (!md && !wd) {
    return '主模型和子智能体都没绑显卡，两个实例会挤在同一批卡上，同时加载会爆显存；给它们各选一块显卡就能并行'
  }
  if (!md) return '主模型没绑显卡，子智能体占哪块卡都可能和它撞上；先给主模型也选一块卡'
  if (!wd) return `子智能体（${label}）没绑显卡，它启动后会按显存铺到所有卡上；先给它选一块卡`
  if (md === wd) return `两边都绑在 ${md} 上，同时加载会爆显存；把子智能体换到另一块卡`
  if (deviceClash(main.device, worker.device)) {
    return `主模型用了 ${md}，子智能体用了 ${wd}，两张卡有重叠，同时加载会爆显存；给子智能体换一块没被占的卡`
  }
  if (isCpu(md) && isCpu(wd)) return '两边都跑在 CPU 上，会互相抢核心'
  return '两块卡无法同时驻留这两个模型'
}

/** 一句话说明这个实例为什么能并行，写进子智能体卡片 / 设置页 */
export function describeIsolation(
  isolation: WorkerIsolation,
  main: ProviderConfig,
  worker: ProviderConfig
): string {
  switch (isolation) {
    case 'remote':
      return `子智能体走 ${worker.name || '远端 API'}，不占本地显存`
    case 'gpu':
      if (!isLlamaProvider(main)) {
        return `子智能体独占本地显卡（${dev(worker.device) || '自动'}），主模型在远端，两条线真并行`
      }
      return `子智能体绑 ${dev(worker.device)}，主模型绑 ${dev(main.device)}，两条线真并行`
    case 'cpu':
      return `子智能体跑在 CPU 上（${worker.model}），不占显存但会慢一些`
    default:
      return noneReason(main, worker)
  }
}

/**
 * 把配置里所有子智能体筛成一个可并行的池。
 *
 * 除了「主 vs 子」的隔离，还要判「子 vs 子」：`startLlama` 只允许卡组不重叠的
 * 实例并存，两个子智能体都写 CUDA1 时后者会把前者顶掉。先在这里按已接纳的卡组去重，
 * 界面就能明确告诉用户「这一条和池里的某条抢卡被跳过了」。
 */
export function pickSubAgentPool(main: ProviderConfig, providers: ProviderConfig[]): SubAgentPick {
  const accepted: SubAgentMember[] = []
  const skipped: SubAgentPick['skipped'] = []
  /** 已经被池占住的设备；主模型也算，因为它在同一台机器上 */
  const taken: ProviderConfig[] = [main]

  for (const worker of subAgentProviders(providers, main.id)) {
    const isolation = subIsolation(main, worker)
    if (isolation === 'none') {
      skipped.push({ provider: worker, reason: describeIsolation(isolation, main, worker) })
      continue
    }

    if (isLlamaProvider(worker)) {
      const clash = taken.find((t) => isLlamaProvider(t) && deviceClash(t.device, worker.device))
      if (clash) {
        const other = clash.id === main.id ? '主模型' : `子智能体（${clash.name || clash.model}）`
        skipped.push({
          provider: worker,
          reason: `子智能体（${worker.name || worker.model}）绑的 ${dev(worker.device)} 和${other}的 ${dev(clash.device)} 有重叠，同时加载会互相顶掉；换一张没被占的卡`
        })
        continue
      }
      taken.push(worker)
    }

    accepted.push({ provider: worker, isolation })
  }

  return { accepted, skipped }
}

/**
 * 整池保活的实例 id：所有本地子智能体 + **当前主模型**（如果它也是本地的）。
 *
 * 主模型必须在池里，否则用户一直跟主模型聊天（主忙、子闲）超过阈值时，
 * 子智能体那几张卡会被逐个空闲卸载；反过来子智能体跑长任务时主模型也会被单独卸掉。
 * 交给 idleunload 后，池内任一在忙整池不卸、全闲才一起卸。
 */
export function subAgentKeepAliveIds(
  providers: ProviderConfig[],
  activeId: string | null
): string[] {
  const ids = new Set<string>()
  for (const p of subAgentProviders(providers, activeId ?? '')) {
    if (isLlamaProvider(p)) ids.add(p.id)
  }
  const main = providers.find((p) => p.id === activeId)
  if (main && isLlamaProvider(main)) ids.add(main.id)
  return [...ids]
}

export interface DispatchableWorker {
  provider: ProviderConfig
  /** 闸门里的活跃 + 排队请求数 */
  load: number
}

/**
 * 一批子任务的分派器：每次返回「当前最闲、且还没满员」的一条实例。
 *
 * `load` 只是派活那一刻的快照，本批刚分出去的任务还没进闸门，所以用
 * `assigned` 补上这一批已分给它的数量。两者之和最小的优先，平手时自然轮转 ——
 * 否则一批 3 个子任务会全落到配置里的第一条，第二条依旧白占显存。
 *
 * 满员判断按 `capacityOf` 来：本地恒 1（所以照旧一人一个），远端默认 3。
 * 少了这道判断，「本地 1 条 + 云端 1 条」这种混合池会按忙闲把活平均分下去 ——
 * 本地那条明明只有一个推理槽，却拿到两个任务，第二个只能在闸门里空等，
 * 让「几路并行」这个数名不副实。
 *
 * 分派器是**每批新建**的（调用方在每批开头重建）：`assigned` 是批内计数，
 * 跨批累积会让第二批看到「上一批已经占满」而误判没容量。
 */
export function createSubAgentDispatcher<T extends DispatchableWorker>(
  pool: T[],
  capacity: (p: ProviderConfig) => number = capacityOf
): () => T | null {
  const assigned = new Map<string, number>()
  return () => {
    if (!pool.length) return null
    let best: T | null = null
    let bestScore = Infinity
    for (const m of pool) {
      const mine = assigned.get(m.provider.id) ?? 0
      const cap = capacity(m.provider)
      // 已经排满的这条不再接活；全部满员时返回 null，本批剩下的等下一批
      if (m.load + mine >= cap) continue
      const score = m.load + mine
      if (score < bestScore) {
        bestScore = score
        best = m
      }
    }
    if (!best) return null
    assigned.set(best.provider.id, (assigned.get(best.provider.id) ?? 0) + 1)
    return best
  }
}
