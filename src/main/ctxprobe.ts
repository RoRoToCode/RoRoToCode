/**
 * 启动时的上下文探测链。
 *
 * 背景：每台机器的显存、显卡、驱动、模型都不一样，不能指望一份固定的默认档
 * （16384）适合所有人。体检（vramfit）能按元数据估出一个「装得下的最大档」，
 * 但估算有三处假设（权重、KV、计算缓冲），对 hybrid 架构和部分 offload 的模型
 * 会偏乐观。所以真实档位必须用「起一次、量一次」来确认。
 *
 * 这条链做的事：
 *   1. 首档用体检估算值（不再固定 16K）启动；
 *   2. 就绪后过三重判据：服务应答 / n_ctx 真的生效 / 单槽窗口够 agent 用；
 *   3. 失败时先归因 —— 只有「显存不够」和「窗口超训练长度」才降档，
 *      文件损坏、参数非法、端口占用一律原样报出来，不做无谓重试；
 *   4. 成功则实测占用，外推最大可装档，只升一档试一次，失败回滚；
 *   5. 结论落盘（带环境指纹），下次指纹一致就直接命中，不再重试。
 *
 * 预算：首档 1 次 + 降档 2 次 + 升档 1 次 + 回滚 1 次，最坏 5 次加载。
 * 只在「首次 / 换模型 / 环境变了」时发生，之后启动和以前一样快。
 *
 * 这个文件不碰 electron、不碰全局状态：所有副作用都从 ProbeDeps 注入，
 * 方便在纯 node 下跑单测。
 */
import {
  adjacentTier,
  bestTier,
  type LoadFailureKind
} from '../shared/ctxtune'
import type { LlamaProbePhase, LlamaProbeProgress } from '../shared/types'

/** 探测阶段，界面据此显示「正在校准 2/4」 */
export type ProbePhase = LlamaProbePhase

/** 进度事件：直接复用 shared 里的形状，主进程与渲染层看到的是同一个契约 */
export type ProbeProgress = LlamaProbeProgress

export interface ProbePlan {
  providerId?: string
  /** 模型原生窗口（tokens）。null 表示元数据缺失，探测上限要自己收窄 */
  nativeCtx: number | null
  /** 本次允许探测的最高档 */
  maxCtx: number
  /** 最低可用档，低于它就判定这台机器跑不了 */
  minCtx: number
  /** 每 1K tokens 的 KV 占用（MiB）。null 时只做验证、不做升档外推 */
  kvMiBPerK: number | null
  /** 显存预算上限（MiB） */
  limitMiB: number
  /** 留给桌面合成器的余量 */
  reserveMiB: number
  /** 允许降几档 */
  downBudget: number
  /** 允许升几档 */
  upBudget: number
  /**
   * 起点是「因为贴着显存上限而主动降下来」的那一档时，禁止再升回去。
   *
   * 否则会出现一个自相矛盾的循环：体检算出 64K 占用 6.42 GB / 预算 6.45 GB
   * （贴着上限），启动时降一档到 32K；探测链量完显存发现「64K 也装得下」，
   * 又升回 64K。实测同一台机器 32K 单槽 38 tok/s、64K 单槽 19 tok/s ——
   * 升回去等于把窗口翻倍、速度砍半，而且余量只剩 850 MiB。
   * 贴边降档是一次有意为之的保守选择，不该被自动调档推翻。
   */
  noUpgrade?: boolean
}

/** 一次重启的结果 */
export interface ProbeAttempt {
  ok: boolean
  port: number | null
  message: string
  /** restart 失败时的归因（端口被占、二进制缺失等） */
  failure?: LoadFailureKind | 'other'
}

/** 就绪判据的结果 */
export interface ProbeVerify {
  ok: boolean
  /** 服务端实际窗口（/props 拿不到时为 null，按「未知」放行） */
  nCtx: number | null
  /** 槽位数。0 表示探不到 */
  slots: number
  /** 短样本实测速度（tok/s），拿不到为 null */
  tokPerSec: number | null
  /** 失败原因；ok=true 时为 null */
  failure: LoadFailureKind | 'timeout' | 'speed' | 'slot' | null
  /** 给用户看的说明 */
  message: string
}

export interface ProbeDeps {
  /** 首档的端口：startLlama 已经把它拉起来了，探测直接接手，不重复加载 */
  firstPort: number | null
  /** 首档的上下文 */
  firstCtx: number
  /** 重启到指定档位（内部先停后起）。parallel 固定单槽，避免 KV 被切分导致假失败 */
  restart: (ctx: number) => Promise<ProbeAttempt>
  /** 等就绪 + 过三重判据 */
  verify: (port: number) => Promise<ProbeVerify>
  /** 实测该档位的真实占用（MiB） */
  measure: (ctx: number) => Promise<number | null>
  /** 等显存回落到安静状态：不让上一轮的残留污染下一轮的基线 */
  quiet: () => Promise<void>
  /** 停掉服务（全部失败时用） */
  stop: () => Promise<void>
  /** 进度与结论文案 */
  note: (msg: string, progress: ProbeProgress) => void
  /** 用户中途点了别的档位 / 主动启动 → 立刻收手，别覆盖用户的选择 */
  cancelled: () => boolean
  /** 落盘：成功档的实测占用；失败时写 ceiling */
  save: (probe: { ctx: number; footMiB: number; tokPerSec?: number } | null, ceiling?: number) => Promise<void>
}

export interface ProbeOutcome {
  ok: boolean
  cancelled: boolean
  /** 最终生效（或最后一次尝试）的档位 */
  ctx: number
  footMiB: number | null
  /** 实际发生的重启次数 */
  attempts: number
  message: string
}

const k = (n: number): string => `${Math.round(n / 1024)}K`

const emit = (
  deps: ProbeDeps,
  plan: ProbePlan,
  phase: ProbePhase,
  ctx: number,
  attempt: number,
  message: string
): void => {
  deps.note(message, {
    providerId: plan.providerId,
    phase,
    ctx,
    attempt,
    budget: plan.downBudget + plan.upBudget + 1,
    message
  })
}

/**
 * 跑完整条探测链。
 *
 * 调用方必须保证：同一时刻只有一个探测在跑（llama.ts 里用串行链保证），
 * 且探测期间该 provider 的自愈重启被抑制（否则会跟这里的重启互相踩）。
 */
export async function runProbeChain(plan: ProbePlan, deps: ProbeDeps): Promise<ProbeOutcome> {
  let cur = Math.max(plan.minCtx, Math.round(deps.firstCtx))
  let attempts = 0
  let foot: number | null = null

  if (deps.cancelled()) {
    return { ok: false, cancelled: true, ctx: cur, footMiB: null, attempts, message: '探测已取消' }
  }

  emit(deps, plan, 'verify', cur, attempts, `正在校验 ${k(cur)} 是否能真正跑起来…`)

  // 首档：startLlama 已经拉起进程，这里只等它就绪并过判据
  let verdict: ProbeVerify = deps.firstPort
    ? await deps.verify(deps.firstPort)
    : { ok: false, nCtx: null, slots: 0, tokPerSec: null, failure: 'timeout', message: '服务没有起来' }

  /**
   * 降档循环。
   *
   * 只有显存不够、或者请求窗口超过训练长度才值得降 —— 降档能同时解决这两个问题。
   * 文件损坏 / 参数非法 / 端口被占时降档是徒劳的，直接带着真实原因退出，
   * 免得把 ctxCeiling 写成「这一档装不下」，以后一直被压着。
   */
  let down = 0
  while (!verdict.ok) {
    const kind = verdict.failure
    const canDown = kind === 'vram' || kind === 'native'
    if (!canDown) {
      const why =
        kind === 'timeout'
          ? '服务在 45 秒内没有应答'
          : kind === 'speed'
            ? '服务能应答但推理速度异常，判断为显存被换页'
            : kind === 'slot'
              ? '单槽窗口不够 agent 使用'
              : '加载失败（不是显存问题，降档无用）'
      const msg = `${why}：${verdict.message}`
      emit(deps, plan, 'fail', cur, attempts, msg)
      await deps.save(null, Math.max(plan.minCtx, cur)).catch(() => undefined)
      await deps.stop().catch(() => undefined)
      return { ok: false, cancelled: false, ctx: cur, footMiB: null, attempts, message: msg }
    }
    if (down >= plan.downBudget) break
    const next = adjacentTier(cur, -1, plan.nativeCtx)
    if (!next || next < plan.minCtx) break
    if (deps.cancelled()) {
      return { ok: false, cancelled: true, ctx: cur, footMiB: null, attempts, message: '探测已取消' }
    }
    down++
    attempts++
    emit(
      deps,
      plan,
      'down',
      next,
      attempts,
      `${k(cur)} 起不来（${verdict.failure === 'native' ? '窗口超出模型上限' : '显存不够'}），降到 ${k(next)} 重试`
    )
    await deps.quiet()
    const r = await deps.restart(next)
    if (!r.ok) {
      const msg = `降到 ${k(next)} 也没能启动：${r.message}`
      emit(deps, plan, 'fail', next, attempts, msg)
      await deps.stop().catch(() => undefined)
      return { ok: false, cancelled: false, ctx: next, footMiB: null, attempts, message: msg }
    }
    cur = next
    verdict = await deps.verify(r.port ?? 0)
  }

  /**
   * 预算用尽但服务仍然不可用：这是终态，不是成功。
   *
   * 这里必须显式拦一道 —— 循环是靠 break 出来的，如果不检查 verdict，
   * 后面的实测与落盘会拿一个「已经挂掉的档位」当成功写进配置，
   * 用户下次启动就会按这个装不下的档位硬来。
   */
  if (!verdict.ok) {
    const msg = `降到 ${k(cur)} 仍没跑起来（${verdict.message}），这台机器可能跑不动这个模型`
    emit(deps, plan, 'fail', cur, attempts, msg)
    await deps.save(null, Math.max(plan.minCtx, cur)).catch(() => undefined)
    await deps.stop().catch(() => undefined)
    return { ok: false, cancelled: false, ctx: cur, footMiB: null, attempts, message: msg }
  }

  // 到这里服务是可用的。实测真实占用 —— 这一步的数据比体检估算准得多
  foot = await deps.measure(cur).catch(() => null)
  if (foot && foot > 0) {
    await deps.save({ ctx: cur, footMiB: foot, tokPerSec: verdict.tokPerSec ?? undefined }).catch(() => undefined)
  }

  emit(
    deps,
    plan,
    'verify',
    cur,
    attempts,
    foot ? `${k(cur)} 跑得动：实测占用 ${Math.round(foot)} MiB` : `${k(cur)} 跑得动`
  )

  /**
   * 升档：用实测值外推「装得下的最大档」，只往上试一档。
   *
   * 为什么不逐档试：KV 与上下文是线性的，一次实测就能算出上限；逐档试是
   * O(n) 次 10 秒重载。跨档跳也试一次就够 —— 失败就退回，不做二次试探，
   * 否则最坏会变成「一直加载」。
   */
  if (foot && foot > 0 && plan.kvMiBPerK && plan.kvMiBPerK > 0 && plan.upBudget > 0 && !plan.noUpgrade) {
    const pick = bestTier({
      probe: { ctx: cur, footMiB: foot },
      kvMiBPerK: plan.kvMiBPerK,
      limitMiB: plan.limitMiB,
      reserveMiB: plan.reserveMiB,
      nativeCtx: plan.nativeCtx
    })
    const target = Math.min(pick.ctx, plan.maxCtx)
    if (target > cur && !deps.cancelled()) {
      attempts++
      emit(
        deps,
        plan,
        'up',
        target,
        attempts,
        `实测 ${k(cur)} 占用 ${Math.round(foot)} MiB，按每 1K ${plan.kvMiBPerK.toFixed(0)} MiB 算，尝试升到 ${k(target)}`
      )
      await deps.quiet()
      const r = await deps.restart(target)
      if (r.ok) {
        const upVerdict = await deps.verify(r.port ?? 0)
        if (upVerdict.ok) {
          cur = target
          const upFoot = await deps.measure(cur).catch(() => null)
          if (upFoot && upFoot > 0) {
            foot = upFoot
            await deps.save({ ctx: cur, footMiB: upFoot, tokPerSec: upVerdict.tokPerSec ?? undefined }).catch(() => undefined)
          }
          emit(deps, plan, 'done', cur, attempts, `已升到 ${k(cur)} 并确认可用`)
          return {
            ok: true,
            cancelled: false,
            ctx: cur,
            footMiB: foot,
            attempts,
            message: `已按实测升到 ${k(cur)} 上下文（占用 ${Math.round(foot ?? 0)} MiB）`
          }
        }
        // 升上去起不来：回滚。回滚本身也算一次重启，但必须做 —— 否则服务停着
        attempts++
        emit(deps, plan, 'rollback', cur, attempts, `${k(target)} 没跑起来，退回 ${k(cur)}`)
        await deps.quiet()
        const back = await deps.restart(cur)
        if (!back.ok) {
          const msg = `升到 ${k(target)} 失败，退回 ${k(cur)} 也失败：${back.message}`
          emit(deps, plan, 'fail', cur, attempts, msg)
          return { ok: false, cancelled: false, ctx: cur, footMiB: foot, attempts, message: msg }
        }
        const backVerdict = await deps.verify(back.port ?? 0)
        if (!backVerdict.ok) {
          const msg = `退回 ${k(cur)} 后服务仍不可用：${backVerdict.message}`
          emit(deps, plan, 'fail', cur, attempts, msg)
          return { ok: false, cancelled: false, ctx: cur, footMiB: foot, attempts, message: msg }
        }
        emit(deps, plan, 'done', cur, attempts, `已退回 ${k(cur)}（${k(target)} 装不下）`)
        return {
          ok: true,
          cancelled: false,
          ctx: cur,
          footMiB: foot,
          attempts,
          message: `保持 ${k(cur)} 上下文（试过 ${k(target)} 装不下）`
        }
      }
      // 重启请求本身失败（端口/进程层）：当前服务已经被停掉了，必须拉回来
      attempts++
      emit(deps, plan, 'rollback', cur, attempts, `升档启动失败，退回 ${k(cur)}`)
      await deps.quiet()
      const back = await deps.restart(cur)
      if (back.ok) {
        emit(deps, plan, 'done', cur, attempts, `已退回 ${k(cur)}`)
        return {
          ok: true,
          cancelled: false,
          ctx: cur,
          footMiB: foot,
          attempts,
          message: `保持 ${k(cur)} 上下文（升档启动失败，已回退）`
        }
      }
      const msg = `升档失败且回退失败：${back.message}`
      emit(deps, plan, 'fail', cur, attempts, msg)
      return { ok: false, cancelled: false, ctx: cur, footMiB: foot, attempts, message: msg }
    }
  }

  emit(deps, plan, 'done', cur, attempts, `${k(cur)} 已是最合适的档位`)
  return {
    ok: true,
    cancelled: false,
    ctx: cur,
    footMiB: foot,
    attempts,
    message: `按 ${k(cur)} 上下文启动（${attempts} 次探测）`
  }
}

/**
 * 探测预算：给界面和日志一个统一说法。
 * 首档 1 次 + 降 2 次 + 升 1 次 + 回滚 1 次 = 最坏 5 次加载。
 */
export function probeBudget(plan: Pick<ProbePlan, 'downBudget' | 'upBudget'>): number {
  return 1 + Math.max(0, plan.downBudget) + Math.max(0, plan.upBudget) + (plan.upBudget > 0 ? 1 : 0)
}
