/**
 * 上下文档位的「实测调档」判据。
 *
 * 体检（tools/vramfit）只能按元数据估：权重 + KV + 缓冲，每一块都有假设。
 * 实测则不同 —— 启动后 nvidia-smi 的增量就是这个模型真实的占用量，
 * 剩下的只是「再多一档需要多少显存」，而 KV 与上下文是线性的，可以直接外推：
 *
 *   foot(ctx) = 实测占用 + (ctx − 实测时的 ctx) × 每 K token 的 KV
 *
 * 于是「最大能装到哪一档」不需要反复试错重启，一次实测就能定。
 * 这里的函数全是纯函数，可在 node --test 里直接跑。
 */

/** 候选档位：与 tools/vramfit/core/assess.mjs 的 base 表保持一致 */
export const CTX_TIERS = [4096, 8192, 16384, 32768, 65536, 131072] as const

/** 一档上下文一个 token 要吃的 KV。单位 MiB / 1000 tokens，界面和日志都按它说话 */
export type KvMiBPerKToken = number

export interface CtxProbe {
  /** 实测时用的上下文长度 */
  ctx: number
  /** 实测到的模型占用（MiB）：权重 + KV + 计算缓冲，不含桌面等其它进程 */
  footMiB: number
}

export interface TierPick {
  ctx: number
  /** 该档位的预计占用（MiB） */
  footMiB: number
  /** 卡在哪：vram = 显存放不下；native = 模型训练窗口到头；none = 还有余量 */
  limitedBy: 'vram' | 'native' | 'none'
}

/** 候选档位表。模型原生窗口不在表里时补进去 —— 它本身是一档，而且是不能越过的硬边界 */
export function tierList(nativeCtx?: number | null): number[] {
  const list: number[] = [...CTX_TIERS]
  const n = Math.round(Number(nativeCtx))
  if (Number.isFinite(n) && n >= 2048 && !list.includes(n)) list.push(n)
  return list.sort((a, b) => a - b)
}

/** 把一次实测外推到任意上下文：KV 随 ctx 线性增长，其它部分当作常数 */
export function predictFootMiB(probe: CtxProbe, ctx: number, kvMiBPerK: KvMiBPerKToken): number {
  if (!Number.isFinite(kvMiBPerK) || kvMiBPerK <= 0) return probe.footMiB
  return probe.footMiB + ((ctx - probe.ctx) / 1000) * kvMiBPerK
}

/**
 * 由一次实测选出「装得下的最大一档」。
 *
 * reserveMiB 是留给桌面 / 浏览器 / 录屏那点波动的：WDDM 下显存被抢到极限时不会崩，
 * 而是悄悄把页换到内存，速度会突然掉到个位数 —— 那比直接报错更难查，所以要留余量。
 */
export function bestTier(o: {
  probe: CtxProbe
  kvMiBPerK: KvMiBPerKToken
  /** 可用上限（MiB），来自体检的显存预算 */
  limitMiB: number
  /** 安全余量（MiB） */
  reserveMiB?: number
  /** 模型原生窗口：超过它要靠 RoPE 外推，短对话看不出问题、长任务会崩 */
  nativeCtx?: number | null
  /** 最低可用档，默认 4K */
  minCtx?: number
}): TierPick {
  const reserve = Math.max(0, Math.round(o.reserveMiB ?? 320))
  const native = Number(o.nativeCtx)
  const nativeCap = Number.isFinite(native) && native >= 2048 ? native : Infinity
  const min = Math.max(2048, Math.round(o.minCtx ?? 4096))
  const tiers = tierList(o.nativeCtx).filter((t) => t >= min && t <= nativeCap)

  let pick: TierPick | null = null
  for (const ctx of tiers) {
    const footMiB = predictFootMiB(o.probe, ctx, o.kvMiBPerK)
    if (footMiB + reserve <= o.limitMiB) pick = { ctx, footMiB, limitedBy: 'none' }
  }
  // 一档都装不下：不返回 0，让调用方拿到最小档 + 明确的 vram 结论，由它决定是否降级
  if (!pick) {
    const ctx = tiers[0] ?? min
    return { ctx, footMiB: predictFootMiB(o.probe, ctx, o.kvMiBPerK), limitedBy: 'vram' }
  }
  // 还能更高、只是被训练窗口卡住的，说清楚原因（用户才知道换模型才有用）
  const isTop = tiers[tiers.length - 1] === pick.ctx
  if (isTop) {
    const beyond = tierList(o.nativeCtx).filter((t) => t > pick!.ctx)
    if (beyond.length && Number.isFinite(nativeCap) && nativeCap <= pick.ctx) pick.limitedBy = 'native'
  }
  return pick
}

/**
 * 相邻档位。返回 null 表示已经到头。
 * 只在「实测确认能上」或「实测证明装不下」时才移动一档，不做跨档跳跃：
 * 跨档跳过去的代价是一次 10 秒的模型重载，试错成本比收益高。
 */
export function adjacentTier(ctx: number, dir: 1 | -1, nativeCtx?: number | null): number | null {
  const tiers = tierList(nativeCtx)
  const i = tiers.indexOf(ctx)
  if (i < 0) {
    // 不在表里（用户手填了怪数字）：往上取第一个更大的，或往下取第一个更小的
    const next = dir > 0 ? tiers.find((t) => t > ctx) : [...tiers].reverse().find((t) => t < ctx)
    return next ?? null
  }
  const j = i + dir
  return j >= 0 && j < tiers.length ? tiers[j] : null
}

/**
 * agent 真正跑起来所需的最小单槽窗口。
 *
 * 为什么不是「能加载就算成功」：`-kvu` 共享池下 `-c` 是总量，一旦开了 `-np 4`，
 * 64K 会被切成每槽 16K。7B 项目的系统提示 + 工具表实测约 5K tokens，
 * 加上几轮历史就顶到 10K 以上 —— 这时服务「起来了」，但一对话就报
 * `exceeds the available context size`。所以判据要按单槽算。
 */
export const MIN_AGENT_SLOT_TOKENS = 12 * 1024

/** 单槽窗口够不够 agent 用。slots<=0 表示探不到，按未知放行（不要因为探测失败拦人） */
export function slotWindowOk(ctx: number, slots: number, min = MIN_AGENT_SLOT_TOKENS): boolean {
  const n = Math.round(slots)
  if (!Number.isFinite(n) || n <= 0) return true
  return ctx / n >= min
}

/**
 * 一次探测结论的「环境指纹」。
 *
 * 用户的判断是对的：每台机器都不一样，不能指望历史数据。但完全不存结论，
 * 每次启动都要多花 30 秒重试。折中办法是给结论配一份指纹 —— 指纹一致才复用，
 * 任何一项变了就作废重探：
 *
 * - 换卡 / 换了显存容量 / 驱动大版本 → 预算变了
 * - 模型换了文件名、体积或时间戳 → 同名不同量化会互相污染（只看文件名不够）
 * - KV 类型（q8_0 / f16）、FA 开关、-ub、槽位数、EXTRA 参数 → 显存占用直接变
 * - 全局「限制上下文」开关 → 预算口径变了
 */
export interface CtxFingerprint {
  gpuName: string
  /** 显存总量（MiB）：换卡或换显存容量最直接的证据 */
  vramMiB: number
  /** 驱动版本，拿不到就留空 */
  driver: string
  model: string
  modelBytes: number
  modelMtimeMs: number
  kvType: string
  parallel: number
  flashAttn: boolean
  extra: string
  contextLimit: boolean
}

const fpText = (v: unknown): string => String(v ?? '').trim()
const fpNum = (v: unknown): number => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? n : 0
}

/** 序列化成稳定字符串：字段顺序固定，避免对象键序不同导致「看起来变了」 */
export function fingerprintOf(p: Partial<CtxFingerprint>): string {
  return [
    fpText(p.gpuName),
    fpNum(p.vramMiB),
    fpText(p.driver),
    fpText(p.model),
    fpNum(p.modelBytes),
    fpNum(p.modelMtimeMs),
    fpText(p.kvType),
    fpNum(p.parallel),
    p.flashAttn === false ? '0' : '1',
    fpText(p.extra),
    p.contextLimit === true ? '1' : '0'
  ].join('|')
}

/** 指纹比对：任一为空都算不匹配（宁可重探一次，也不用可疑结论） */
export function sameFingerprint(a?: string | null, b?: string | null): boolean {
  const x = fpText(a)
  const y = fpText(b)
  return x.length > 0 && x === y
}

/**
 * 加载失败归因。
 *
 * 这是探测链的安全阀：只有「显存真的不够」才值得降档重试。
 * 模型文件损坏、端口被占、参数非法、CUDA 版本不匹配时，降档是徒劳的 ——
 * 更糟的是会把 `ctxCeiling` 写成「这一档装不下」，之后一直被压着。
 *
 * 注意 `CUDA error` 单独出现**不**判显存：驱动崩、非法 kernel 也会报这句。
 */
export type LoadFailureKind = 'vram' | 'native' | 'other'

const VRAM_PATTERNS = [
  /out of memory/i,
  /outofmemory/i,
  /insufficient memory/i,
  /not enough memory/i,
  /failed to allocate/i,
  /unable to allocate/i,
  /cannot allocate/i,
  /alloc(ation)? failed/i,
  /cudamalloc[^\n]*(fail|null)/i,
  /cublas[^\n]*alloc/i,
  /显存不足/,
  /内存不足/
]

const NATIVE_PATTERNS = [
  /exceeds the available context size/i,
  /n_ctx[^\n]*exceed/i,
  /context (window|size)[^\n]*(too (small|large)|exceed)/i,
  /上下文[^\n]*(超出|超过)/
]

export function classifyLoadFailure(log: string): LoadFailureKind {
  const text = String(log ?? '')
  if (!text) return 'other'
  if (VRAM_PATTERNS.some((re) => re.test(text))) return 'vram'
  if (NATIVE_PATTERNS.some((re) => re.test(text))) return 'native'
  return 'other'
}

/**
 * 探测起点：体检给出的「装得下的最大档」。
 *
 * 只有贴着预算上限（tightRatio 以上）时才主动降一档 —— 估算模型对
 * hybrid / 部分 offload 的模型会低估缓冲，贴着上限时那一档最容易翻车。
 * 估算本身富裕时不降：凭空少一档等于白丢一半窗口。
 */
export function probeStartTier(o: {
  recommendedCtx: number | null
  nativeCtx?: number | null
  maxCtx: number
  minCtx?: number
  /** 体检判定「贴着预算上限」 */
  tight?: boolean
}): number {
  const max = Math.max(2048, Math.round(o.maxCtx))
  const min = Math.max(2048, Math.round(o.minCtx ?? 4096))
  const nat = Number(o.nativeCtx)
  const natCap = Number.isFinite(nat) && nat >= 2048 ? nat : Infinity
  const rec = Number(o.recommendedCtx)
  let start = Number.isFinite(rec) && rec >= 2048 ? rec : Math.min(max, natCap)
  start = Math.min(start, max, natCap)
  if (o.tight) {
    const down = adjacentTier(start, -1, o.nativeCtx)
    if (down && down >= min) start = down
  }
  return Math.max(min, Math.min(start, max))
}

/**
 * 部分卸载时 `--fit-target` 的取值（MiB）。
 *
 * 这里以前算错了一个语义：`--fit-target` 是「llama.cpp 分配完之后至少还要留多少空闲」，
 * 而体检给出的 `limitMiB` 已经是 **free × 0.92**（已经替系统留了 8%）。再按
 * `limit × 15%` 传一遍，等于从同一块显存里扣了两次：
 *
 *   8 GB 卡、桌面占 1 GB → free 7.18 GB → limit 6.6 GB → 旧 fit-target 1010 MiB
 *   llama.cpp 于是只肯用 5.6 GB，比体检允许的少一整个 GB 的层
 *
 * 实测 9B Q4 32K：`--fit-target 917` 只跑 15.9 tok/s，改成 300 立刻 32 tok/s ——
 * 一倍的速度差，全是白送的。所以这里只补「体检没算进去的那一点点净空」：
 * 4% 是实测最优值（再小就轮到 WDDM 驱逐桌面，表现为速度断崖）。
 *
 * 小卡（≤12 GB）的净空按比例已经够用（6.6 GB 的 4% ≈ 270 MiB），不再单独抬高比例：
 * 抬高只会重演「二次扣预算」。下限 192 是给 4 GB 卡留的最低呼吸空间。
 *
 * @param limitMiB 体检给出的可用显存预算（已扣过系统预留）
 * @param opts.totalMiB 显卡总显存（保留参数：老调用方还在传，暂不改变语义）
 */
export function fitTargetMiB(limitMiB?: number | null, opts: { totalMiB?: number | null } = {}): number {
  const limit = Number(limitMiB)
  void opts
  if (!Number.isFinite(limit) || limit <= 0) return 320
  return Math.min(512, Math.max(192, Math.round(limit * 0.04)))
}

/**
 * 「装不下时按层分担」的三种模式。
 *
 * - `auto`（默认）：只有这个模型确实装不下才分层 —— 用户要的就是这个直觉，
 *   「大于显存的自动开，普通的不开」。判据优先用体检的 `fits`，体检缺席时
 *   退回「模型文件字节数 > 预算」这条硬比较（权重都比预算大了，没有第二种可能）。
 * - `on`：不管体检怎么说都允许，专治「体检说装得下、实际 OOM」的估偏乐观。
 * - `off`：完全关掉，回到旧行为（装不下就报错，由用户自己换模型）。
 */
export type PartialOffloadMode = 'auto' | 'on' | 'off'

/**
 * 读配置里的分层设置。老配置只有布尔值：
 * `false` 是用户明确关掉（保留），`true` 是当年的默认值、语义本来也只是「装不下才降级」，
 * 所以直接升级成 `auto` —— 不然所有老用户都会被钉死在「全局开」上，与按模型自动相悖。
 */
export function partialModeOf(v: {
  mode?: unknown
  /** 旧字段 llamaPartialOffload */
  enabled?: unknown
}): PartialOffloadMode {
  const m = String(v.mode ?? '').trim().toLowerCase()
  if (m === 'auto' || m === 'on' || m === 'off') return m as PartialOffloadMode
  if (v.enabled === false) return 'off'
  if (v.enabled === true) return 'auto'
  return 'auto'
}

/**
 * 该不该为这个模型跑「实测调档」探测链。
 *
 * 探测链要的是「这一档行不行」的干净结论，所以它内部禁用分层 ——
 * 而权重本身就装不下的模型，每一档都起不来：探测会连着失败几次，最后把服务停掉、
 * 报「这台机器跑不动这个模型」，把唯一能用的分层路径挡在门外。
 * 实测 8.38 GB 的 14B 在 8 GB 卡上就是这样被误判成「跑不动」的。
 *
 * 其余排除项沿用原来的理由：纯 CPU 降档不会变快（瓶颈是内存带宽）；
 * 用户手点档位 / 探测内部重启 / 调档重试都不该再起一条新链。
 */
export function shouldProbeChain(o: {
  /** 体检判定整模型权重装得下（fits） */
  weightFits: boolean | null | undefined
  /** 体检拿到了显存预算（limitMiB） */
  hasBudget: boolean
  gpuAvailable: boolean
  internal?: boolean
  ctxExplicit?: boolean
  tuned?: boolean
}): boolean {
  if (o.internal || o.ctxExplicit || o.tuned) return false
  if (!o.hasBudget || !o.gpuAvailable) return false
  return o.weightFits === true
}

/**
 * 这次启动该不该走「部分层留在 CPU」的降级。
 *
 * 四个条件都是必要的，少一个都会出问题：
 * - 用户没把这个功能关死（off 就是旧行为：装不下直接 OOM，由用户自己换小模型）；
 * - 这个模型确实装不下。`auto` 模式下 `fits` 为 null（元数据不全）时**不再一律判否**：
 *   拿不到体检结果并不等于装得下，而「模型文件比预算还大」是比体检更硬的证据。
 *   只要 `modelBytes > budgetMiB`，按层分担总比必然 OOM 强。
 * - 真的有显卡可用。纯 CPU 没有「部分」可言，`-ngl 0` 本来就是全在内存；
 * - 不是探测链。探测要的是「这一档行不行」的干净结论，混进部分 offload 后
 *   速度判据会失真（部分层在 CPU 上必然慢），会把能用的档位误判成不可用。
 *
 * `gpuAvailable` 是后加的输入：设置里显卡选「自动」时 `device` 是空串，
 * 但机器上明明有卡 —— 旧判据把这种情况当成「纯 CPU」，于是项目自己的分层分支
 * 从来没生效过，全靠 llama.cpp 内置的 `--fit` 兜住，`--fit-target` 也就永远没机会调。
 */
export function shouldPartialOffload(o: {
  /** 三态模式；不传时按旧 `enabled` 推导，兼容老调用方与老测试 */
  mode?: PartialOffloadMode | null
  /** 旧字段：false = 关闭 */
  enabled?: boolean
  fits: boolean | null | undefined
  device: string
  probing: boolean
  /** 有可用 GPU（哪怕没绑定具体卡）时为 true */
  gpuAvailable?: boolean
  /** 模型文件字节数：体检缺席时用它和预算直接比 */
  modelBytes?: number | null
  /** 显存预算（MiB） */
  budgetMiB?: number | null
}): boolean {
  const mode = o.mode ?? (o.enabled === false ? 'off' : 'auto')
  if (mode === 'off') return false
  if (o.probing) return false
  const dev = String(o.device ?? '').trim()
  if (/^cpu$/i.test(dev)) return false
  const gpu = dev ? true : o.gpuAvailable === true
  if (!gpu) return false

  if (mode === 'on') return true

  // auto：装不下才分层
  if (o.fits === false) return true
  if (o.fits === true) return false
  // 体检拿不到结论：用「文件体积 vs 显存预算」这条硬比较兜底。
  // 98% 的门槛是给元数据里的张量对齐留一点余量，不至于 6.0 GB 的模型配 6.05 GB 预算就分层。
  const bytes = Number(o.modelBytes)
  const budget = Number(o.budgetMiB)
  if (Number.isFinite(bytes) && bytes > 0 && Number.isFinite(budget) && budget > 0) {
    return bytes > budget * 1024 * 1024 * 0.98
  }
  return false
}
