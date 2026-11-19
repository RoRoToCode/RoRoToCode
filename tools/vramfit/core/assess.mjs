/**
 * 预算推算：给定一份 GGUF 元数据和一套硬件参数，算出「能开多大上下文」。
 * 纯函数，不探测硬件 —— 硬件参数由调用方（CLI 探测本机 / 网页查表）喂进来。
 */

import { paramCountOf, quantFromName, quantTier, activeParamsFromName } from './quant.mjs'
import { TUNING, KV_BYTES_PER_ELEM, deviceFamilyOf, decodeEfficiency } from './assumptions.mjs'
import { t } from './i18n.mjs'

/**
 * 显存预算上限。抽成纯函数是因为三个平台的规则真的不一样，混在一个公式里必然算错：
 *
 * - Windows（WDDM，auto 口径）：技术上能驱逐别的进程占用的显存，**但驱逐不等于免费**：被赶出去的
 *   页要在需要时换回来，表现为推理从 14 tok/s 掉到 1.5 tok/s（实测），用户看到的是
 *   「能加载、打字一个字半秒」。所以 auto 下预算只认当前真正空闲的显存，取 min(free×0.92, total×0.94)。
 *
 *   这里 auto 以前写的是 max(free×0.92, total×0.94)，等价于「总显存 94% 永远可用」——
 *   于是 8 GB 卡上已占 7.2 GB 时仍然报 7.7 GB 预算，每个模型都推荐 64K，
 *   真跑起来并发两个请求就掉到 1.5 tok/s。宁可推荐小一档，也不要点下去才发现跑不动。
 * - Linux（auto 口径）：显存不可驱逐，free 就是上限。
 * - macOS 统一内存：没有独立显存，用 Metal 的建议最大工作集（物理内存的 2/3~3/4），
 *   再留 10% 给系统（此分支不看 budget，本来就按容量算）。
 * - 没有可用显卡：按物理内存的 80%（CPU 推理）。
 *
 * platform 不再默认读 process.platform —— core 要能在浏览器里跑，
 * 调用方必须显式告诉这里"是哪套规则"。
 *
 * `budget` 决定要不要看「当前已用显存」，两种口径：
 *
 * - `static`（默认）：只按物理容量算（total × 0.94），与此刻谁占着显存无关。
 * - `auto`：按上面那套「现在真正空闲多少」的规则算，需显式 `--budget auto` 才用。
 *
 * 为什么默认 static：动态口径虽然更贴当下，但它是**一次快照**，读数会随同一张卡上
 * 任何程序的开合而跳 —— 用户看到的是「同一台机器、同一个模型，隔两分钟结论变了」。
 * 更糟的是 WDDM 下这个读数会被"释放了"骗过去：游戏退出、显存记到空闲里，可那块显存
 * 早被换页打散，模型真占进去照样掉到 1.x tok/s。也就是说 free 变大并不等于变快，
 * 拿它当预算会把「物理上装得下、实际跑不动」算成「装得下」。
 * 静态口径给出的是「这张卡的容量决定了它最多能开到哪一档」，可复现、可对比，
 * 代价是不扣桌面占用 —— 所以报告里必须写清口径，要按当前余量算就显式 --budget auto。
 */
export function vramCeiling({ totalBytes = 0, usedBytes = 0, unified = false, maxWorkingSetBytes = 0, platform = '', usedUnknown = false, budget = 'static' } = {}) {
  const total = Math.max(0, Number(totalBytes) || 0)
  if (unified && total > 0) {
    const cap = maxWorkingSetBytes > 0
      ? Math.min(maxWorkingSetBytes, total)
      : total * TUNING.unifiedDefaultFactor
    return { limit: cap * TUNING.unifiedReserve, basis: 'unified', reclaimable: 0 }
  }
  /**
   * 静态口径：预算 = 物理容量 × 0.94，不再减 usedBytes。
   * 0.94 不是「预留系统 6%」那么精确，它只是「装进物理容量不留零头会直接分配失败」
   * 这条硬边界 —— 真正的系统占用要用户自己保证（关掉占显存的程序再启动模型）。
   * usedUnknown 在这里没有意义：本来就不读 used。
   */
  if (budget === 'static' && total > 0) {
    return { limit: total * TUNING.wddmTotalFactor, basis: 'static', reclaimable: 0 }
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
  // 元数据直接给了「哪几层带 KV」（逐层 head_count_kv 里有 0），比按间隔推断准得多：
  // LFM2/LFM3 是卷积层与注意力层交替，注意力只落在偶数层，任何「每 N 层 1 层」的
  // 规则都对不上。有这个数就不用再猜。
  const exact = meta.kvLayerCount
  if (typeof exact === 'number' && exact > 0 && exact <= real) return exact
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

/**
 * 是否 MLA（Multi-head Latent Attention，DeepSeek V2/V3/R1）。
 *
 * 判据与 llama.cpp 的 is_mla() 一致：`key_length_mla` 与 `value_length_mla` 两个键
 * 必须同时存在。缺任一个就说明是早期转换（16 KV 头、192/128 长度那种），llama.cpp
 * 走的是普通 GQA 分配路径，这里也必须照普通公式算 —— 用"看到 deepseek2 就当 MLA"
 * 会把老文件的 KV 算小，那比高估更危险。
 */
export function isMla(meta) {
  return (meta?.keyLengthMla ?? 0) > 0 && (meta?.valueLengthMla ?? 0) > 0
}

/** 拿不到 *_swa 时的兜底 head_dim */
function swaHeadDim(meta) {
  return meta.keyLengthSwa ?? meta.keyLength ??
    Math.round((meta.embdLength ?? 0) / (meta.headCount || meta.headKv || 1))
}

/**
 * KV cache 字节数。
 * - 纯注意力：n_ctx × 层数 × n_head_kv × (k_dim + v_dim) × bytes
 * - MLA：n_ctx × 层数 × n_head_kv × k_row × bytes，k_row = kv_lora_rank + rope_dim，
 *   **不再加 v_dim** —— 压缩后的 V 是同一行 K 的视图，llama.cpp 不单独分配
 * - 混合滑窗：full 层按 ctx 算，滑窗层只保留最近 sliding_window 个 token
 */
export function kvBytes(meta, ctx, kvType) {
  const layers = kvLayers(meta)
  if (!layers || !meta.headKv || !meta.embdLength) return null
  const perElem = KV_BYTES_PER_ELEM[kvType] ?? KV_BYTES_PER_ELEM.f16

  // MLA 必须排在滑窗分支之前：DeepSeek 没有滑窗，但两个特征同时出现时以 MLA 为准。
  // 转换后的 GGUF 把 head_count_kv 写成 1、key_length 写成 kv_lora_rank + rope_dim，
  // 所以 head_kv × key_length 正好等于 llama.cpp 实际分配的每层每 token 元素数。
  if (isMla(meta)) {
    const kRow = (meta.keyLength ?? 0) > 0
      ? meta.keyLength
      : (meta.kvLoraRank ?? 0) + (meta.ropeDimCount ?? 0)
    if (!kRow) return null
    return ctx * layers * (meta.headKv || 1) * kRow * perElem
  }

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

/**
 * MoE（混合专家）信息：判定是否 MoE，并算出「每 token 真正读多少权重」。
 *
 * 为什么只影响速度、不影响显存：
 *   MoE 的全部专家权重都得驻留显存（token 可能路由到任意一个专家），所以装不装得下
 *   仍按**全权重**算；但每吐一个 token 只读被激活的那几个专家 + 共享层，带宽瓶颈
 *   看的是**激活权重**。用全权重算速度会把 MoE 严重低估（DeepSeek-R1 可差一个量级）。
 *
 * 激活比例口径（用户确认的简化方案）：active = 全权重 × (每 token 激活专家数 / 总专家数)。
 *   这是对「共享层不该被压缩」的近似 —— 严格算法要拆出 attention/embedding 不压缩、
 *   只压 FFN 专家部分（需要 feed_forward_length 参与，留作后续精确版）。当前口径偏乐观
 *   （激活权重被压得比真实更小 → 速度偏高），报告里必须写明是粗估。
 *
 * 激活专家数来源优先级：
 *   1. GGUF 的 `<arch>.expert_used_count`（最准，模型作者写的）
 *   2. 文件名的 `A22B` 写法 + 总参数反推（KV 缺字段时兜底，作者常把激活数写进文件名）
 *   3. 都没有 → ratio=null、速度不修正，报告提示「缺激活数」，绝不编一个比例出来
 *
 * @returns {null|{experts:number, used:number|null, ratio:number|null, activeParamsB:number|null,
 *   activeBytes:number, corrected:boolean, source:string|null}}
 */
export function moeInfo(meta, weightsBytes) {
  const experts = Number.isFinite(meta?.expertCount) && meta.expertCount > 1 ? meta.expertCount : null
  if (!experts) return null

  const nameActiveB = activeParamsFromName(meta.file ?? '')
  let used = Number.isFinite(meta.expertUsedCount) && meta.expertUsedCount >= 1 && meta.expertUsedCount <= experts
    ? meta.expertUsedCount
    : null
  let source = used !== null ? 'kv' : null

  // KV 没写激活专家数时，用文件名的 A22B / 总参数当作激活比例。
  // 注意 A22B 是「激活参数量」而非专家数，直接拿参数比值当比例，不去反推专家数
  // （反推会先 round 到整数个专家，放大误差）。这条兜底只出现在 KV 缺字段时。
  let nameRatio = null
  if (used === null && nameActiveB) {
    const totalB = paramCountOf(meta.file, meta.paramCount)
    if (typeof totalB === 'number' && totalB > 0 && nameActiveB < totalB / 1e9) {
      nameRatio = nameActiveB / (totalB / 1e9)
      source = 'name'
    }
  }

  // 专家比例口径：used/experts；KV 缺字段时用文件名的参数比例兜底。
  // used >= experts 等于没省，不修正；两者都拿不到也不修正（绝不编数字）。
  const ratio = used !== null && used >= 1 && used < experts
    ? used / experts
    : (nameRatio !== null && nameRatio > 0 && nameRatio < 1 ? nameRatio : null)
  return {
    experts,
    used,
    ratio,
    activeParamsB: nameActiveB,
    activeBytes: ratio ? weightsBytes * ratio : weightsBytes,
    corrected: ratio !== null,
    source
  }
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
  // budget='static' 时按物理容量算，不看当前占用（口径由 CLI 的 --budget 决定）。
  const ceiling = gpu
    ? vramCeiling({
      totalBytes: gpu.totalBytes,
      usedBytes: gpu.usedBytes,
      usedUnknown: gpu.usedUnknown === true,
      unified: gpu.unified,
      maxWorkingSetBytes: gpu.maxWorkingSetBytes,
      platform: hw.osPlatform ?? hw.platform ?? '',
      budget: opts.budget ?? 'static'
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

  // MoE：速度的带宽瓶颈看的是「每 token 实际读的权重」，不是全权重。
  // 显存判定（上面的 weights/limit/rows）仍按「全权重进显存」算，dense 语义不变。
  // 但对 MoE 要额外给一条「显存 + 系统 RAM 合计能不能跑」的结论：
  // llama.cpp 可以用 --n-cpu-moe 把专家 FFN 权重挪到系统 RAM（attention / KV 留显存），
  // 所以「显存装不下」对 MoE 不等于「跑不了」—— 门槛是两者合计。
  const moe = moeInfo(meta, weights)
  if (moe) {
    // 合计供给：显存预算 + 可信的系统 RAM（扣 OS / 缓冲）。无显卡时只有 RAM。
    const ramBytes = hw.ramBytes ?? 0
    const usableRam = ramBytes * TUNING.moeRamFactor
    const supply = limit + usableRam
    // 合计需求：取建议档的 need（= 全权重 + KV + 开销 + 视觉），没有 best 时用最小档
    const need = (best ?? rows.find((r) => r.need !== null))?.need ?? (weights + overhead + extra)
    moe.ramBytes = ramBytes
    moe.usableRam = usableRam
    moe.supplyBytes = supply
    moe.needBytes = need
    moe.combinedFit = need <= supply
    // 需要挪多少到 RAM：显存放不下的那部分（至少 0）。用来估 --n-cpu-moe 的层数。
    moe.spillBytes = Math.max(0, need - limit)
    // offload 层数：按「需挪走的权重 ÷ 总权重」× 推理层数，向上取整、夹在 [1, 层数]。
    // 这是粗估（llama.cpp 实际按层 offload 整个专家 FFN），给个可照着试的起点。
    const layers = Math.max(1, (meta.blockCount ?? 0) - (meta.nextnLayers ?? 0))
    moe.offloadLayers = moe.spillBytes > 0 && weights > 0
      ? Math.max(1, Math.min(layers, Math.ceil(layers * moe.spillBytes / weights)))
      : 0
    moe.totalLayers = layers || null
    // 只有「显存装不下、但合计够」时这条路径才有意义
    moe.canOffload = !weightsFit && moe.combinedFit && gpu !== null
  }
  const speedWeights = moe?.activeBytes ?? weights

  // 生成速度：每吐一个 token 要把权重从显存读一遍，所以瓶颈是带宽不是算力。
  // 峰值口径是「零上下文、batch=1、权重驻留显存」：真实解码每步还要读 KV cache，
  // 另外还有首字延迟、工具执行、排队，所以主界面的实测值必然低于这个数。
  // 部分 offload 时读的是系统内存，速度掉到内存带宽水平；纯 CPU 推理只有这一档。
  const ramBw = hw.ramBandwidthGBps
  // 位宽从「真实文件体积 ÷ 参数量」反推：本工具本来就读真实 GGUF 体积，
  // 这样不必维护量化名→bpw 对照表，新量化格式也能算。拿不到就保持空值，
  // 让效率函数退回历史 0.7，而不是猜一个位宽出来。
  const paramCount = paramCountOf(meta.file, meta.paramCount)
  const bitsPerWeight = Number.isFinite(paramCount) && paramCount > 0 && weights > 0
    ? (weights * 8) / paramCount
    : null
  const family = deviceFamilyOf(gpu, hw)
  const eff = decodeEfficiency(family, bitsPerWeight)
  const gb = speedWeights / 1e9
  let speed = null
  if (!gpu) {
    // CPU 分支同样走分档函数；后端未知时它返回 TUNING.memoryEfficiency，
    // 两条路径共用一处校准，改这里不会再出现「显存改了 CPU 没改」。
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
  if (speed) {
    speed.family = family
    speed.bitsPerWeight = bitsPerWeight
  }

  // 按建议上下文折减：解码每步除了读权重，还要把整段 KV cache 读一遍。
  // 带宽和利用率不变时速度 ∝ 1/(权重 + KV)，所以 折减值 = 峰值 × 权重/(权重 + KV)。
  // 这仍然不是实测，只是把「不计上下文」这条假设的代价算出来，
  // 让用户能解释「为什么体检写 54、主界面只有 38」。
  if (speed) {
    const peak = speed.onVram ?? speed.onRam
    const kv = best?.kv
    if (Number.isFinite(peak) && peak > 0 && Number.isFinite(kv) && kv > 0 && best) {
      // 分子用激活权重：MoE 解码每步读的是激活专家 + KV，不是全权重
      speed.atCtx = peak * (speedWeights / (speedWeights + kv))
      speed.atCtxTokens = best.ctx
    } else {
      speed.atCtx = null
      speed.atCtxTokens = null
    }
    // 速度口径所用的权重字节数，供三端封顶判断对齐（CLI/JSON/网页别各算各的）
    speed.basisBytes = speedWeights
  }

  return {
    gpu, onCpu: !gpu, weights, overhead, extra, freeVram, limit,
    limitBasis: ceiling.basis, reclaimable: ceiling.reclaimable,
    rows, best, weightsFit, estimated, speed, moe
  }
}

/**
 * 把多张显卡合成一张「虚拟卡」，用于合并显存评估（一个模型按层切开摊到多卡）。
 *
 * 与主程序 llama.ts 的合并模式口径一致：`-dev CUDA0,CUDA1 -sm layer` 时显存池是各卡
 * 容量之和。这里只负责把硬件描述合成一条，真正的装不装得下仍交给 assess() 算 ——
 * 这样单卡和合并共用同一套 KV / 上下文算式，不会出现两套口径。
 *
 * 带宽取「最弱的一张」：多卡按层切分时每个 token 仍要顺序经过各卡，最慢的那张决定
 * 下限；而且其中一张带宽未知时不能当成无限快，只能按已知里最保守的估。速度属于粗估，
 * 报告里必须写明多卡带宽不可精确建模。
 *
 * 单卡（或没有卡）原样返回 `merged:false`，调用方据此决定要不要显示合并段。
 */
export function mergedHardware(hw) {
  const gpus = (hw?.gpus ?? []).filter((g) => g && (g.totalBytes ?? 0) > 0 && !g.unified && !g.shared)
  if (gpus.length < 2) return { hw, gpus: gpus.length, merged: false }
  const totalBytes = gpus.reduce((s, g) => s + g.totalBytes, 0)
  const usedBytes = gpus.reduce((s, g) => s + (g.usedBytes ?? 0), 0)
  const knownBw = gpus.map((g) => g.bandwidthGBps).filter((b) => Number.isFinite(b) && b > 0)
  // 有一张卡带宽未知 → 无法保证下限，bandwidthGBps 置空让 assess 不报速度（报告改说「无法估」）
  const allKnown = knownBw.length === gpus.length
  const bandwidthGBps = allKnown ? Math.min(...knownBw) : null
  const weakest = allKnown
    ? gpus.reduce((a, b) => (a.bandwidthGBps <= b.bandwidthGBps ? a : b))
    : null
  const virtual = {
    name: gpus.map((g) => g.name).join(' + '),
    totalBytes,
    usedBytes,
    usedUnknown: gpus.some((g) => g.usedUnknown === true),
    backend: gpus[0].backend,
    driver: gpus[0].driver,
    kind: 'discrete',
    bandwidthGBps,
    // 合并是「按层切分」，没有单一物理卡的 WDDM 驱逐语义；口径沿用调用方的 budget
  }
  // 给「合并怎么启动」用的 device 名。llama.cpp 的编号按驱动枚举顺序，
  // 和 gpus 数组顺序不一定一致（--gpu 会把选中的卡换到第一位），
  // 所以优先用硬件层留下的 devIndex，再按它升序排。
  const prefixOf = { cuda: 'CUDA', rocm: 'CUDA', vulkan: 'Vulkan', metal: 'MTL' }
  const devices = gpus.every((g) => prefixOf[g.backend])
    ? gpus
      .map((g, i) => ({ i: Number.isInteger(g.devIndex) ? g.devIndex : i, tag: `${prefixOf[g.backend]}${Number.isInteger(g.devIndex) ? g.devIndex : i}` }))
      .sort((a, b) => a.i - b.i)
      .map((x) => x.tag)
    : null

  return {
    hw: { ...hw, gpus: [virtual] },
    gpus: gpus.length,
    merged: true,
    weakestName: weakest?.name ?? null,
    bandwidthUnknown: !allKnown,
    devices,
    cards: gpus.map((g) => g.name)
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
  // MLA 的 K 行宽 = 潜向量 + RoPE 分量；V 不单独占一行，所以没有 v 字段
  const mla = isMla(meta) ? {
    latentRank: meta.kvLoraRank ?? null,
    ropeDim: meta.ropeDimCount ?? null,
    keyRow: (meta.keyLength ?? 0) > 0
      ? meta.keyLength
      : (meta.kvLoraRank ?? 0) + (meta.ropeDimCount ?? 0),
    valueReusesKey: true
  } : null
  return {
    kvLayers: layers || null,
    interval: ai.interval,
    intervalInferred: ai.inferred,
    slidingWindow: meta.slidingWindow ?? null,
    swa,
    mla
  }
}

/** 三档结论，报告和 JSON 共用同一套判据 */
export function verdictOf(meta, result) {
  // 附加件不是模型，没有「装不装得下」这回事。单独给一个档，
  // 免得界面拿 not-recommended 去渲染红色叉 —— 用户会以为文件有问题。
  if (meta?.isVision || meta?.isAssistant) return meta.isVision ? 'vision-projector' : 'draft-model'
  const tpl = analyzeTemplate(meta.chatTemplate)
  // 元数据缺层数 / head / 隐层维度，KV 一档都算不出来。
  // 这种情况不能报「装不下」—— 用户会去换更小的模型，而真正的问题是文件本身。
  if (result.estimated === false) return 'unknown'
  // MoE 把专家放内存也能跑：只看 weightsFit/best 会把它判成「跑不动」，
  // 而报告抬头上明明写着「能跑，但专家要放内存」。同一个结论不能两个说法 ——
  // 消费 JSON 的界面会照着 not-recommended 劝用户换模型，其实机器够。
  const runnable = Boolean(result.best || result.moe?.canOffload)
  if (!runnable) return 'not-recommended'
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
  // 附加件先判：它们是「零件」不是「模型」。
  // 不拦的话，77 MB 的 MTP 草稿件会被判成「128K 装得下、可以当 agent 用」——
  // 用户照着去加载，llama.cpp 直接报错，工具的公信力就没了。
  if (meta?.isVision || meta?.isAssistant) {
    const kind = meta.isVision ? 'vision' : 'draft'
    const bytes = (meta.sizeBytes ?? 0) +
      (meta.isVision ? TUNING.visionOverheadBytes : 0)
    return {
      level: 'warn',
      title: t(`hl.${kind}.title`),
      short: t(`hl.${kind}.short`),
      why: t(`hl.${kind}.why`, { s: `${(bytes / 1024 ** 3).toFixed(2)} GB` })
    }
  }
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
    // MoE：显存装不下，但专家能挪到系统 RAM，合计够 → 能跑，只是要 offload（降速）。
    // 这条必须在 nofit 之前：否则用户看到「跑不动」就去换模型，而实际能跑。
    if (result.moe?.canOffload) {
      return {
        level: 'warn', title: t('hl.moeOffload.title'), short: t('hl.moeOffload.short'),
        why: t('hl.moeOffload.why', { w: gb(result.weights), n: result.moe.offloadLayers })
      }
    }
    // 权重放得下、但连最小档上下文都放不下：说「权重超过上限」是错的，
    // 用户会去算 6.63 < 7.52 发现对不上，然后怀疑整份报告。
    const first = result.rows?.find((r) => r.need !== null && r.need !== undefined)
    if (result.weightsFit && first && result.gpu) {
      return {
        level: 'bad', title: t('hl.nofit.title'), short: t('hl.nofit.short'),
        why: t('hl.nofit.why.ctx', { w: gb(result.weights), c: ctx(first.ctx), need: gb(first.need), limit: gb(result.limit) })
      }
    }
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

/**
 * llama.cpp 启动参数建议：把这份体检结论翻译成可照抄的旗标。
 *
 * 只给关键几个，不做完整命令行生成器（端口、模型路径、后端由调用方决定）：
 *   -ngl           尝试放 GPU 的层数。全放得下给 999，放不下按显存/权重比例给。
 *   --n-cpu-moe    仅 MoE 且需要 offload 时：把前 N 层的路由专家留在系统 RAM。
 *                  N 来自 assess 里按显存缺口估的 offloadLayers。
 *   -c             建议上下文（= result.best.ctx，即体检算出的最大可开档）。
 *   -ctk / -ctv    KV 精度：k8v16 口径下 Turing 卡只能用 -ctk q8_0（见 assumptions）。
 *
 * @returns {Array<{flag:string, whyKey:string, args?:object}>}
 */
export function launchArgsOf(meta, result, opts = {}) {
  if (result.estimated === false) return []
  const out = []
  const moe = result.moe
  const layers = (meta.blockCount ?? 0) - (meta.nextnLayers ?? 0)

  // 合并多卡（按层切分）：先指定参与计算的卡，再让 llama.cpp 按整层分摊。
  // 不能拿它冒充张量并行 —— -sm layer 是「一层整个放某张卡」，速度和显存都按这个算。
  if (opts.merged?.devices?.length) {
    out.push({ flag: `-dev ${opts.merged.devices.join(',')}`, whyKey: 'la.dev' })
    out.push({ flag: '-sm layer', whyKey: 'la.sm' })
  }

  // 全权重进显存的层数：装得下就全放，装不下按预算/需求比例给一个保守起点。
  // MoE 走 --n-cpu-moe 时不能砍 -ngl：RAM 里放的是那几层的专家 FFN，
  // 注意力/KV 仍该全上显存。以前两个一起给（-ngl 21 + --n-cpu-moe 15），
  // 等于又砍掉 11 层注意力，显存闲着、速度白掉一截。
  let ngl = 999
  if (!result.weightsFit && !moe?.canOffload && result.weights > 0 && result.limit > 0) {
    ngl = Math.max(0, Math.min(999, Math.floor(result.limit / result.weights * layers)))
  }
  out.push({
    flag: `-ngl ${ngl}`,
    whyKey: moe?.canOffload && ngl >= layers ? 'la.nglMoe' : (ngl >= layers && layers > 0 ? 'la.nglAll' : 'la.nglPartial')
  })

  // MoE offload：显存放不下但合计够时，把专家挪到 RAM
  if (moe?.canOffload && moe.offloadLayers > 0) {
    out.push({
      flag: `--n-cpu-moe ${moe.offloadLayers}`,
      whyKey: 'la.cpuMoe',
      args: { n: moe.offloadLayers }
    })
  }

  // 建议上下文。MoE offload 场景 best 可能为 null（全权重进显存一档都放不下），
  // 但专家挪到 RAM 后 KV 仍在显存、能跑，此时给 4K 保守起步，而不是干脆不给。
  const ctxVal = result.best?.ctx ?? (moe?.canOffload ? 4096 : null)
  if (ctxVal) {
    out.push({
      flag: `-c ${ctxVal}`,
      whyKey: 'la.ctx',
      args: { c: ctxVal >= 1024 ? `${Math.round(ctxVal / 1024)}K` : String(ctxVal) }
    })
  }

  // KV 精度：报告按 k8v16 混合口径算时，给出对应的实际旗标（Turing 卡 -ctv 依赖 flash attn）
  if (opts.kvType === 'k8v16') {
    out.push({ flag: '-ctk q8_0', whyKey: 'la.ctk' })
  }

  return out
}
