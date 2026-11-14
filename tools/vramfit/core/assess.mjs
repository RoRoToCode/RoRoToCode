/**
 * 预算推算：给定一份 GGUF 元数据和一套硬件参数，算出「能开多大上下文」。
 * 纯函数，不探测硬件 —— 硬件参数由调用方（CLI 探测本机 / 网页查表）喂进来。
 */

import { paramCountOf, quantFromName, quantTier } from './quant.mjs'
import { TUNING, KV_BYTES_PER_ELEM } from './assumptions.mjs'
import { t } from './i18n.mjs'

/**
 * 显存预算上限。抽成纯函数是因为三个平台的规则真的不一样，混在一个公式里必然算错：
 *
 * - Windows（WDDM）：技术上能驱逐别的进程占用的显存，**但驱逐不等于免费**：被赶出去的
 *   页要在需要时换回来，表现为推理从 14 tok/s 掉到 1.5 tok/s（实测），用户看到的是
 *   「能加载、打字一个字半秒」。所以预算只认当前真正空闲的显存，取 min(free×0.92, total×0.94)。
 *
 *   这里以前写的是 max(free×0.92, total×0.94)，等价于「总显存 94% 永远可用」——
 *   于是 8 GB 卡上已占 7.2 GB 时仍然报 7.7 GB 预算，每个模型都推荐 64K，
 *   真跑起来并发两个请求就掉到 1.5 tok/s。宁可推荐小一档，也不要点下去才发现跑不动。
 * - Linux：显存不可驱逐，free 就是上限。
 * - macOS 统一内存：没有独立显存，用 Metal 的建议最大工作集（物理内存的 2/3~3/4），
 *   再留 10% 给系统。
 * - 没有可用显卡：按物理内存的 80%（CPU 推理）。
 *
 * platform 不再默认读 process.platform —— core 要能在浏览器里跑，
 * 调用方必须显式告诉这里"是哪套规则"。
 */
export function vramCeiling({ totalBytes = 0, usedBytes = 0, unified = false, maxWorkingSetBytes = 0, platform = '', usedUnknown = false } = {}) {
  const total = Math.max(0, Number(totalBytes) || 0)
  if (unified && total > 0) {
    const cap = maxWorkingSetBytes > 0
      ? Math.min(maxWorkingSetBytes, total)
      : total * TUNING.unifiedDefaultFactor
    return { limit: cap * TUNING.unifiedReserve, basis: 'unified', reclaimable: 0 }
  }
  const free = Math.max(0, total - (Number(usedBytes) || 0))
  if (platform === 'win32' && total > 0) {
    /**
     * 读不到已用显存（AMD / Intel 在 Windows 上没有 nvidia-smi 那样的查询接口）时，
     * free 是假的（恒等于 total）。这时不能再套 free×0.92，那等于「整卡都空着」。
     * 改用总显存的 0.6，把典型桌面占用与驱动预留一起扣掉。
     */
    if (usedUnknown) {
      return { limit: total * TUNING.wddmUnknownBudgetFactor, basis: 'wddm-unknown', reclaimable: 0 }
    }
    /**
     * 取 min 而不是 max：total×0.94 只是「物理上不会溢出」的上限，
     * 不是「现在装得下」的预算。真正能用的只有 free，再留 8% 给驱动与合成器。
     * reclaimable 归零 —— 不再向用户承诺「关掉别的程序就能腾出这么多」，
     * 那笔账要用户自己关完之后重新体检才算得准。
     */
    const limit = Math.min(free * TUNING.wddmFreeFactor, total * TUNING.wddmTotalFactor)
    return { limit, basis: 'wddm', reclaimable: 0 }
  }
  return { limit: free * TUNING.freeFactor, basis: 'free', reclaimable: 0 }
}

/**
 * 真正带 KV cache 的层数。
 * - 减掉 MTP（nextn）层：llama.cpp 会忽略它们
 * - 混合架构按 interval 折算：只有 1/N 的层是 full attention
 *
 * interval 优先读元数据；元数据没写但存在 ssm.* 参数时（Qwen3-Next 就是这样），
 * 按 3 层线性 + 1 层全注意力的排布取 4，并在报告里标为「推断」。
 */
export function attentionInterval(meta) {
  const explicit = meta.fullAttentionInterval
  if (explicit && explicit > 1) return { interval: explicit, inferred: false }
  if (meta.hasLinearLayers) return { interval: 4, inferred: true }
  return { interval: 1, inferred: false }
}

export function kvLayers(meta) {
  const total = meta.blockCount ?? 0
  if (!total) return 0
  const real = Math.max(1, total - (meta.nextnLayers ?? 0))
  const { interval } = attentionInterval(meta)
  if (interval > 1) return Math.ceil(real / interval)
  return real
}

/**
 * 混合滑窗架构里 full attention 层占多大比例。
 * llama.cpp 里是写死的规则：gemma3/4 每 6 层 1 层 global，gemma2 隔层 global，
 * Mistral 早期模型全部走滑窗。未知架构取 1/4 折中，宁可高估。
 */
export function fullLayerFraction(arch) {
  const a = (arch ?? '').toLowerCase()
  if (/^gemma[34]/.test(a)) return 1 / 6
  if (/^gemma2/.test(a)) return 1 / 2
  if (/^mistral/.test(a)) return 0
  return 0.25
}

/**
 * 是否属于「两种 head_dim 混用」的滑窗架构。
 *
 * 只认 sliding_window + key_length_swa 是不够的：gemma3 的 GGUF 里只有
 * sliding_window，没有 key_length_swa，于是整段滑窗分支从来不执行，
 * 34 层全按全注意力算，长上下文下 KV 高估 4 倍以上。
 * 有 sliding_window 就说明确实有层在滑窗，head_dim 拿 key_length 顶上也比忽略强。
 */
export function isHybridSwa(meta) {
  if (!meta.slidingWindow) return false
  return Boolean(meta.keyLengthSwa || meta.keyLength || meta.embdLength)
}

/** 拿不到 *_swa 时的兜底 head_dim */
function swaHeadDim(meta) {
  return meta.keyLengthSwa ?? meta.keyLength ??
    Math.round((meta.embdLength ?? 0) / (meta.headCount || meta.headKv || 1))
}

/**
 * KV cache 字节数。
 * - 纯注意力：n_ctx × 层数 × n_head_kv × (k_dim + v_dim) × bytes
 * - 混合滑窗：full 层按 ctx 算，滑窗层只保留最近 sliding_window 个 token
 */
export function kvBytes(meta, ctx, kvType) {
  const layers = kvLayers(meta)
  if (!layers || !meta.headKv || !meta.embdLength) return null
  const perElem = KV_BYTES_PER_ELEM[kvType] ?? KV_BYTES_PER_ELEM.f16

  if (isHybridSwa(meta)) {
    const kFull = meta.keyLength ?? Math.round(meta.embdLength / (meta.headCount || meta.headKv))
    const vFull = meta.valueLength ?? kFull
    const kSwa = swaHeadDim(meta)
    const vSwa = meta.valueLengthSwa ?? kSwa
    const frac = fullLayerFraction(meta.arch)
    const fullLayers = Math.max(1, Math.round(layers * frac))
    const swaLayers = Math.max(0, layers - fullLayers)
    const fullKv = ctx * fullLayers * meta.headKv * (kFull + vFull) * perElem
    const swaCtx = Math.min(ctx, meta.slidingWindow)
    const swaKv = swaCtx * swaLayers * meta.headKv * (kSwa + vSwa) * perElem
    return fullKv + swaKv
  }

  const headDim = meta.keyLength ?? Math.round(meta.embdLength / (meta.headCount || meta.headKv))
  const kDim = headDim
  const vDim = meta.valueLength ?? headDim
  return ctx * layers * meta.headKv * (kDim + vDim) * perElem
}

/**
 * 模板能力分析：是不是真的能驱动工具调用。
 *
 * notes 返回结构化项而不是字符串：调用方要靠 ok 决定用 ✓ 还是 ·，
 * 原来靠 `n.startsWith('模板含')` 猜 —  那是拿文案当协议，一翻译就全线失效。
 */
export function analyzeTemplate(tpl) {
  if (!tpl) return { level: 'none', notes: [{ ok: false, text: t('tpl.none') }] }
  const notes = []

  const hasToolsVar = /\{%[-\s]*if\s+tools|tools\s*\|length|\{\{-?\s*tools/.test(tpl)
  const hasToolCallTag = /<tool_call|tool_calls|"tool_calls"|function_call/i.test(tpl)
  // 注意不能写成 /{%-/：绝大多数模板是 `{% if message.role == 'user' %}`，没有那个减号，
  // 旧正则因此几乎从不命中，能对话的模板被打成"不支持"。
  const hasGenPrompt = /add_generation_prompt|\{%-?\s*if\s[^%]*message/i.test(tpl)

  notes.push({ ok: hasToolsVar, text: t(hasToolsVar ? 'tpl.tools.yes' : 'tpl.tools.no') })
  notes.push({ ok: hasToolCallTag, text: t(hasToolCallTag ? 'tpl.call.yes' : 'tpl.call.no') })

  // 分级按结构判定，不按累积分：只要没有 tools 分支，无论模板多完整都不算能驱动工具。
  // （原来用分数相加，会出现"有 tools 分支但没定义 tool_call"却判 strong 的情况。）
  const level = hasToolsVar && hasToolCallTag
    ? 'strong'
    : hasToolsVar
      ? 'partial'
      : (hasToolCallTag || hasGenPrompt)
        ? 'weak'
        : 'none'
  return { level, notes, hasToolsVar, hasToolCallTag }
}

/** 主判定：给定显存，逐档算上下文 */
export function assess(meta, hw, opts = {}) {
  const gpu = hw.gpus?.[0] ?? null
  // 分片模型只有第 1 片带元数据，单片体积只是整体的 1/N，由调用方按片数折算后传进来
  const weights = opts.weightsBytes ?? meta.sizeBytes
  const freeVram = gpu ? Math.max(0, gpu.totalBytes - (gpu.usedBytes ?? 0)) : 0

  // 运行时开销：RTX 2080 + 9B Q4 实测约 80 MiB（n_batch 2048）。
  // 具体数值在 core/assumptions.mjs 里，报告里写的就是那个数。
  const overhead = TUNING.overheadBytes
  /**
   * 视觉投影器的额外占用（mmproj 权重 + CLIP 激活）。
   *
   * 以前完全没算：9B 视觉模型体检报 7032 MiB / 32K，实际挂上投影器是 7710 MiB ——
   * 差的 680 MiB 正好把「推荐档」顶过预算，表现为「体检说装得下，一发图片就崩」。
   * 投影器权重由调用方按文件大小传进来，激活是固定开销（见 assumptions）。
   */
  const extra = Math.max(0, Number(opts.extraBytes) || 0)

  // 上限怎么取，各平台不是一回事：Windows 能驱逐别人的显存，Linux/macOS 不能。
  // 没有可用显卡时退化成「CPU 推理」，按内存算 —— 不能直接给 0，那会让所有模型都判装不下。
  const ceiling = gpu
    ? vramCeiling({
      totalBytes: gpu.totalBytes,
      usedBytes: gpu.usedBytes,
      usedUnknown: gpu.usedUnknown === true,
      unified: gpu.unified,
      maxWorkingSetBytes: gpu.maxWorkingSetBytes,
      platform: hw.osPlatform ?? hw.platform ?? ''
    })
    : { limit: (hw.ramBytes ?? 0) * TUNING.ramFactor, basis: 'ram', reclaimable: 0 }
  const limit = ceiling.limit

  const base = [4096, 8192, 16384, 32768, 65536, 131072]
  // 原生上下文是硬边界：超过它必须靠 RoPE 外推，短文本看不出问题、长任务会崩。
  // 原生值本身就作为一档列出来（小模型可能只有 2K，低于最低测试档）
  const native = meta.contextLength ?? 131072
  const tiers = meta.contextLength && !base.includes(meta.contextLength)
    ? [...base, meta.contextLength].sort((a, b) => a - b)
    : base

  const rows = tiers.map((ctx) => {
    const kv = kvBytes(meta, ctx, opts.kvType ?? 'f16')
    if (kv === null) return { ctx, kv: null, need: null, fits: null, beyondNative: false }
    const need = weights + kv + overhead + extra
    return {
      ctx,
      kv,
      need,
      fits: need <= limit,
      tight: need > limit * TUNING.tightRatio && need <= limit,
      beyondNative: ctx > native
    }
  })

  const fitting = rows.filter((r) => r.fits && !r.beyondNative)
  const best = fitting.length ? fitting[fitting.length - 1] : null

  // 权重本身就超安全上限时，连最小上下文的对话都别想
  const weightsFit = weights + overhead + extra <= limit

  // 一个档位都算不出来，说明元数据缺了层数 / head / 隐层维度。
  // 这种情况必须和「装不下」分开报 —— 两者的下一步动作完全不同
  // （一个是换小模型，一个是换个文件或让作者补元数据）。
  const estimated = rows.some((r) => r.need !== null)

  // 生成速度：每吐一个 token 要把全部权重从显存读一遍，所以瓶颈是带宽不是算力。
  // 用 RTX 2080 + 9B Q4_K_M 实测校准过：448 × 0.7 / 5.78 = 54.3，实测 53.9（±1%）。
  // 这是「零上下文、batch=1、全权重驻留显存」的解码峰值：真实解码每步还要读 KV cache，
  // 另外还有首字延迟、工具执行、排队，所以主界面的实测值必然低于这个数。
  // 部分 offload 时读的是系统内存，速度掉到内存带宽水平；纯 CPU 推理只有这一档。
  const ramBw = hw.ramBandwidthGBps
  const eff = TUNING.memoryEfficiency
  const gb = weights / 1e9
  let speed = null
  if (!gpu) {
    // 效率因子和显存分支共用同一个 TUNING 值：以前这里写死 0.7，
    // 重新校准时 CPU 分支纹丝不动，两条路径悄悄给出不同口径。
    speed = ramBw
      ? { bandwidth: ramBw, onVram: null, onRam: (ramBw * eff) / gb, efficiency: eff, cpu: true }
      : null
  } else if (gpu.bandwidthGBps) {
    speed = {
      bandwidth: gpu.bandwidthGBps,
      onVram: (gpu.bandwidthGBps * eff) / gb,
      onRam: ramBw ? (ramBw * eff) / gb : null,
      efficiency: eff
    }
  }

  // 按建议上下文折减：解码每步除了读权重，还要把整段 KV cache 读一遍。
  // 带宽和利用率不变时速度 ∝ 1/(权重 + KV)，所以 折减值 = 峰值 × 权重/(权重 + KV)。
  // 这仍然不是实测，只是把「不计上下文」这条假设的代价算出来，
  // 让用户能解释「为什么体检写 54、主界面只有 38」。
  if (speed) {
    const peak = speed.onVram ?? speed.onRam
    const kv = best?.kv
    if (Number.isFinite(peak) && peak > 0 && Number.isFinite(kv) && kv > 0 && best) {
      speed.atCtx = peak * (weights / (weights + kv))
      speed.atCtxTokens = best.ctx
    } else {
      speed.atCtx = null
      speed.atCtxTokens = null
    }
  }

  return {
    gpu, onCpu: !gpu, weights, overhead, extra, freeVram, limit,
    limitBasis: ceiling.basis, reclaimable: ceiling.reclaimable,
    rows, best, weightsFit, estimated, speed
  }
}

/**
 * 注意力结构的结构化描述（给 JSON / 网页用）。
 * 滑窗架构下所有层都有 KV，只是大部分层只保留最近 N 个 token；
 * 混合线性注意力则只有 1/N 层带 KV —— 两者不能混成同一个 kvLayers 数字。
 */
export function attentionReport(meta) {
  const layers = kvLayers(meta)
  const ai = attentionInterval(meta)
  let swa = null
  if (isHybridSwa(meta)) {
    const full = Math.max(1, Math.round(layers * fullLayerFraction(meta.arch)))
    swa = { fullLayers: full, swaLayers: Math.max(0, layers - full), window: meta.slidingWindow }
  }
  return {
    kvLayers: layers || null,
    interval: ai.interval,
    intervalInferred: ai.inferred,
    slidingWindow: meta.slidingWindow ?? null,
    swa
  }
}

/** 三档结论，报告和 JSON 共用同一套判据 */
export function verdictOf(meta, result) {
  const tpl = analyzeTemplate(meta.chatTemplate)
  // 元数据缺层数 / head / 隐层维度，KV 一档都算不出来。
  // 这种情况不能报「装不下」—— 用户会去换更小的模型，而真正的问题是文件本身。
  if (result.estimated === false) return 'unknown'
  if (!result.weightsFit || !result.best) return 'not-recommended'
  if (!meta.chatTemplate) return 'not-recommended'
  // 与 render 里的 tooSmall 同一条门槛：小于 3B 只算「能跑」，不算 agent 可用
  const p = paramCountOf(meta.file, meta.paramCount)
  if (typeof p === 'number' && p < TUNING.minAgentParams) return 'runs-only'
  if (tpl.level === 'strong' || tpl.level === 'partial') return 'agent-ready'
  return 'runs-only'
}

/**
 * 给人看的一句话结论。命令行和网页都从这一份取，避免两边说法不一样。
 *
 * 判定顺序按照「最可能出问题的地方」排：先看装不装得下，再看会不会对话，
 * 再看量化是不是把质量吃光了，最后才看模型规模。任何一步否决就直接返回，
 * 后面的都不用看了 —— 所以这是一串 early return，不要合并成打分。
 *
 * level 只有 good / warn / bad 三档：
 *   good → CLI 绿色对勾，网页绿色卡片
 *   warn → 黄色三角，能跑但有前提
 *   bad  → 红色叉，别在这台机器上试
 */
export function headlineOf(meta, result) {
  const tpl = analyzeTemplate(meta.chatTemplate)
  const p = paramCountOf(meta.file, meta.paramCount)
  const tier = quantTier(quantFromName(meta.file)).tier
  const gb = (b) => `${(b / 1024 ** 3).toFixed(2)} GB`
  const ctx = (n) => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n))
  const prm = (n) => {
    const b = n / 1e9
    return b >= 10 ? `${b.toFixed(0)}B` : b >= 1 ? `${b.toFixed(1)}B` : `${b.toFixed(2)}B`
  }

  // 元数据缺层数 / head / 隐层维度：不是装不下，是算不出来。
  // 这两件事给的建议完全相反 —— 一个换更小的模型，一个换文件。
  if (result.estimated === false) {
    return {
      level: 'warn', title: t('hl.unknown.title'), short: t('hl.unknown.short'),
      why: t('hl.unknown.why')
    }
  }

  if (!result.weightsFit || !result.best) {
    return {
      level: 'bad', title: t('hl.nofit.title'), short: t('hl.nofit.short'),
      why: result.gpu
        ? t('hl.nofit.why.gpu', { w: gb(result.weights), limit: gb(result.limit) })
        : t('hl.nofit.why.cpu')
    }
  }

  if (!meta.chatTemplate) {
    return {
      level: 'warn', title: t('hl.notpl.title'), short: t('hl.notpl.short'),
      why: t('hl.notpl.why')
    }
  }

  if (tier <= 1) {
    return {
      level: 'bad', title: t('hl.lowq.title'), short: t('hl.lowq.short'),
      why: t('hl.lowq.why')
    }
  }

  if (typeof p === 'number' && p < TUNING.minAgentParams) {
    return {
      level: 'warn', title: t('hl.small.title'), short: t('hl.small.short'),
      why: t('hl.small.why', { p: prm(p) })
    }
  }

  if (tpl.level !== 'strong' && tpl.level !== 'partial') {
    return {
      level: 'warn', title: t('hl.notool.title'), short: t('hl.notool.short'),
      why: t('hl.notool.why')
    }
  }

  if (result.best.ctx < TUNING.minAgentContext) {
    return {
      level: 'warn', title: t('hl.shortctx.title'), short: t('hl.shortctx.short'),
      why: t('hl.shortctx.why', { ctx: ctx(result.best.ctx) })
    }
  }

  if (tier === 2) {
    return {
      level: 'warn', title: t('hl.tight.title'), short: t('hl.tight.short'),
      why: t('hl.tight.why', { ctx: ctx(result.best.ctx) })
    }
  }

  return {
    level: 'good', title: t('hl.good.title'), short: t('hl.good.short'),
    why: t('hl.good.why', { ctx: ctx(result.best.ctx) })
  }
}
