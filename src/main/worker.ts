import type { AppConfig, ProviderConfig, WorkerIsolation, WorkerPlan } from '../shared/types'
import { isLlamaProvider } from '../shared/providers'
import { llamaInstances, startLlama, statusLlama } from './llama'

/**
 * 「工人模型」——派出去的子代理用哪个模型干活。
 *
 * 为什么需要单独一层判断：配了 `role='worker'` 不等于它能真并行。
 * 同一块显卡上再塞一个模型就是直接爆显存；只有「各自占一张卡」或者
 * 「一个在远端」时，主对话和子代理才是两条互不排队的线。
 * 这个模块负责把「配置里写了」翻译成「这次到底能不能用」，
 * 并在不能的时候给出人能看懂的原因 —— 而不是悄悄回落到主模型让用户以为在并行。
 */

const dev = (d?: string | null): string => (d ?? '').trim().toUpperCase()
const isCpu = (d: string): boolean => d === 'CPU' || d === 'CPU0'

/**
 * 判断主模型和工人模型能不能同时驻留。
 *
 * 规则只有一条核心：**两个本地实例必须落在不同的设备上**。
 * 因为启动时不绑卡的话 llama.cpp 会自己按可用显存 split，等于两边都往所有卡上挤，
 * 所以「没绑卡」一律按「分不开」处理 —— 宁可明确回落，也不赌它不出问题。
 */
function isolationOf(main: ProviderConfig, worker: ProviderConfig): WorkerIsolation {
  const mainLocal = isLlamaProvider(main)
  const workerLocal = isLlamaProvider(worker)

  // 工人模型在远端：不管主模型在哪，都不抢本地显存
  if (!workerLocal) return 'remote'
  // 主模型在远端、工人模型在本地：本地资源由工人独占
  if (!mainLocal) {
    const wd = dev(worker.device)
    return isCpu(wd) ? 'cpu' : 'gpu'
  }

  const md = dev(main.device)
  const wd = dev(worker.device)
  if (!md || !wd) return 'none'
  if (md === wd) return 'none'
  if (isCpu(md) !== isCpu(wd)) return 'cpu'
  return 'gpu'
}

function describe(
  isolation: WorkerIsolation,
  main: ProviderConfig,
  worker: ProviderConfig
): string {
  switch (isolation) {
    case 'remote':
      return `子代理走 ${worker.name || '远端 API'}，不占本地显存`
    case 'gpu':
      // 主模型在远端时不存在「绑哪块卡」的问题，本地那块由工人独占
      if (!isLlamaProvider(main)) {
        return `子代理独占本地显卡（${dev(worker.device) || '自动'}），主模型在远端，两条线真并行`
      }
      return `子代理绑 ${dev(worker.device)}，主模型绑 ${dev(main.device)}，两条线真并行`
    case 'cpu':
      return `子代理跑在 CPU 上（${worker.model}），不占显存但会慢一些`
    default:
      return noneReason(main, worker)
  }
}

/**
 * 「分不开」的具体原因。这里必须说清是哪一边没配好：
 * 只说「同一块卡」的话，用户不知道是工人模型没绑，还是主模型没绑。
 */
function noneReason(main: ProviderConfig, worker: ProviderConfig): string {
  const md = dev(main.device)
  const wd = dev(worker.device)
  if (!md && !wd) {
    return '主模型和工作模型都没绑显卡，两个实例会挤在同一批卡上，同时加载会爆显存；给它们各选一块显卡就能并行'
  }
  if (!md) return `主模型没绑显卡，工作模型占哪块卡都可能和它撞上；先给主模型也选一块卡`
  if (!wd) return `工作模型（${worker.name || worker.model}）没绑显卡，它启动后会按显存铺到所有卡上；先给它选一块卡`
  if (md === wd) return `两边都绑在 ${md} 上，同时加载会爆显存；把工作模型换到另一块卡`
  if (isCpu(md) && isCpu(wd)) return '两边都跑在 CPU 上，会互相抢核心'
  return '两块卡无法同时驻留这两个模型'
}

/**
 * 算出这次派子代理该用谁。不启动任何进程，纯判断 + 查一次状态，可以随便调。
 */
export async function workerPlan(
  main: ProviderConfig,
  config: AppConfig
): Promise<WorkerPlan> {
  const configured =
    config.providers.find((p) => p.role === 'worker' && p.id !== main.id && p.model) ?? null

  if (!configured) {
    return {
      provider: null,
      configured: null,
      isolation: 'none',
      parallel: false,
      ready: false,
      reason: '没有配置「工作模型」，子代理沿用当前模型'
    }
  }

  const isolation = isolationOf(main, configured)
  if (isolation === 'none') {
    return {
      provider: null,
      configured,
      isolation,
      parallel: false,
      ready: false,
      reason: `${describe(isolation, main, configured)}。本次用主模型`
    }
  }

  // 远端 API 不需要预热，直接可用
  if (isolation === 'remote') {
    return {
      provider: configured,
      configured,
      isolation,
      parallel: true,
      ready: true,
      reason: describe(isolation, main, configured)
    }
  }

  // 本地实例：只有真的在服务才算就绪。加载中（503）也不能用，
  // 否则子代理第一步就撞 503 白跑一趟。
  const st = await statusLlama(configured.id).catch(() => null)
  const ready = Boolean(st?.running)
  return {
    provider: ready ? configured : null,
    configured,
    isolation,
    parallel: true,
    ready,
    reason: ready
      ? describe(isolation, main, configured)
      : `工人模型（${configured.model}）还没启动，本次用主模型；下次派活前会自动拉起`
  }
}

/** 同一时刻只允许一个预热流程，避免连着切两次模型时起两个进程 */
let warming: Promise<{ ok: boolean; message: string }> | null = null

/**
 * 后台把工人模型的本地实例拉起来。
 *
 * 由「切换对话模型」触发，不阻塞界面：模型加载要几十秒，等它不如先让用户聊起来。
 * 子代理派活时只查状态、不等 —— 没就绪就用主模型，不会把一次对话卡在加载上。
 */
export async function warmWorker(
  main: ProviderConfig,
  config: AppConfig
): Promise<{ ok: boolean; message: string }> {
  if (warming) return warming

  warming = (async () => {
    const configured =
      config.providers.find((p) => p.role === 'worker' && p.id !== main.id && p.model) ?? null
    if (!configured) return { ok: true, message: '未配置工作模型' }
    if (!isLlamaProvider(configured)) return { ok: true, message: '工作模型走远端 API，无需预热' }

    const isolation = isolationOf(main, configured)
    if (isolation === 'none') {
      // 分不开：预热等于把主模型挤掉，绝不能做
      return { ok: false, message: `已跳过预热：${noneReason(main, configured)}` }
    }

    const st = await statusLlama(configured.id).catch(() => null)
    if (st?.running) return { ok: true, message: '工作模型已在运行' }
    if (st?.loading) return { ok: true, message: '工作模型正在加载' }

    // 已经在实例表里但端口还没响应：加载中，别再起一个
    const inst = llamaInstances().find((i) => i.key === configured.id)
    if (inst) return { ok: true, message: '工作模型加载中' }

    const r = await startLlama(configured.model, undefined, {
      providerId: configured.id,
      device: configured.device ?? null,
      port: configured.port
    })
    return { ok: r.ok, message: r.message }
  })()

  try {
    return await warming
  } finally {
    warming = null
  }
}
