/**
 * 全部可调参数与前提假设，集中在这一处。
 *
 * 为什么要单独抽一个文件：
 *   1. 报告里写的「+ 800 MiB 开销」和代码里算的必须是同一个数。以前分散在
 *      assess / render / 网页三处，改一个忘两个就会自相矛盾。
 *   2. 用户有权知道结论是怎么来的。网页和命令行的「参数与假设」全都是从这里
 *      渲染出来的，不是另写一份文案 —— 文案会过期，代码不会。
 *
 * 改这里的任何数字，等价于改结论。请同步核对 ASSUMPTIONS 里的描述文字。
 */

import { getLocale } from './i18n.mjs'

/**
 * 运行时开销：CUDA context + batch / 计算缓冲。
 *
 * 取 800 MiB 而不是只算 batch 缓冲的那点钱：CUDA context 本身随驱动和显卡版本
 * 就要占几百 MiB（驱动 581 实测 300–500 MiB），再加上计算缓冲与碎片。
 * 8 GB 卡的上限只有 7.5 GB 左右，少了这几百 MiB 就会把「临界装得下」判成装得下，
 * 真加载时反而 OOM —— 宁可保守。
 */
export const TUNING = {
  overheadBytes: 800 * 1024 * 1024,

  /**
   * 挂上视觉投影器（mmproj）之后的额外开销。
   *
   * 这里只算「激活与计算缓冲」，投影器本身的权重由调用方按文件字节数加上去。
   * 实测 Ornith-9B（Q4）在 RTX 3050 8G 上：纯文本 7032 MiB，带图 7710 MiB，
   * 差 680 MiB；其中 mmproj 文件约 290 MiB，剩下的约 390 MiB 就是 CLIP 编码器
   * 在 2048 batch 下的激活。取 384 MiB 与实测对齐（误差 6 MiB）。
   *
   * 为什么不能用「投影器大小的百分比」：激活取决于图像分辨率与 micro-batch，
   * 与权重量无关 —— 一个 100 MB 的小投影器照样要开 300+ MiB 的缓冲。
   */
  visionOverheadBytes: 384 * 1024 * 1024,

  /**
   * 兜底效率（不是主口径）：只在拿不到后端族或权重位宽时使用。
   * 0.7 是按 RTX 2080 + 9B Q4_K_M 实测（53.9 tok/s）拟合的单点值；
   * 主路径见下面的 DECODE_EFFICIENCY，按后端族 × 位宽分档。
   */
  memoryEfficiency: 0.7,

  /** 需要量超过上限的这个比例就标「接近上限」，提醒用户别再往上开上下文 */
  tightRatio: 0.85,

  /**
   * Windows 预算：取 min(可用×0.92, 总×0.94)。
   * 曾经是 max —— 那等于「总显存的 94% 永远可用」，无视当前占用，
   * 8 GB 卡上已占 7.2 GB 时还推荐 64K，真跑起来并发就掉到 1.5 tok/s。
   */
  wddmFreeFactor: 0.92,
  /**
   * 只是物理上限（装进去不会溢出），不是「现在装得下」的预算。
   * 静态口径（`--budget static`）直接拿它乘物理容量 —— 两种口径共用同一个系数，
   * 换机器 / 换卡时「总容量 94%」这个物理边界不该有两套数。
   */
  wddmTotalFactor: 0.94,
  /**
   * 读不到「已用显存」时的保守预算系数（A 卡 / 核显在 Windows 上就是这种情况）。
   *
   * 注册表只能给容量，`usedBytes` 恒为 0，而桌面合成器 + 浏览器在 1080p 下通常已经
   * 占掉 1~2 GB。若仍按 free×0.92 算，预算会比真实可用高 15~30%，
   * 表现在体检推荐 32K、启动直接 OOM 或被 WDDM 驱逐到 1.5 tok/s。
   * 0.6 是「扣掉典型桌面占用 + 留余量」的经验值：8 GB 卡 → 4.8 GB，
   * 和实测「A 卡 8 G 上跑 5.4 GB 模型会被换页」对得上。
   */
  wddmUnknownBudgetFactor: 0.6,

  /** Linux 显存不可驱逐，只能按当前可用算 */
  freeFactor: 0.92,

  /** macOS 统一内存：Metal 建议工作集再留 10% 给系统 */
  unifiedReserve: 0.9,
  /** 读不到 maxWorkingSet 时的兜底：物理内存的 75% */
  unifiedDefaultFactor: 0.75,

  /** 纯 CPU 推理按物理内存的这个比例 */
  ramFactor: 0.8,

  /**
   * MoE 专家 offload 到系统 RAM 时，可拿来放专家权重的可信比例。
   * 物理内存不能全给用户模型：OS、浏览器、llama.cpp 的计算缓冲都要占。
   * 取 0.8 与 CPU 推理同一口径 —— 「显存预算 + RAM×0.8」是 MoE 合计能装下的上限。
   */
  moeRamFactor: 0.8,

  /** 参数量低于这个门槛，只算「能跑」，不算 agent 可用 */
  minAgentParams: 3e9,
  /** 上下文低于这个值，塞不下一个代码文件 */
  minAgentContext: 8192,

  /** 小模型速度封顶：每 token 的固定开销会压住公式值，2 GB 以下最多给 200，其余最多 400 */
  smallModelGB: 2,
  speedCap: 400,
  speedCapTiny: 200,

  /** 速度估算的误差区间（百分比），只用于文案 */
  speedErrorPct: 20
}

/**
 * 解码效率 = 带宽利用率（16-bit）× 反量化惩罚（按权重位宽插值）。
 *
 * 为什么不能只用一个数：原来的固定 0.7 是按 RTX 2080 + 9B Q4_K_M 实测校准的（53.9 tok/s），
 * 对那张卡是对的；但把同一系数套到 4090 这类高带宽卡上，解码就系统性偏乐观 ——
 * 4090 的带宽利用率实测约 0.75，可 4-bit 权重还要先解包，两步合起来只有约 0.59。
 * 这两段效应分开列表，才能既解释 2080 的老实测、又解释新卡上的偏差。
 *
 * 数字来自公开的 llama.cpp pp/tg 基准拟合（不是我们自己测的）：
 *   - cuda-consumer：4090 F16 ≈ 0.72 MBU、7B Q4_0 ≈ 0.57 MBU
 *   - metal：M2 Ultra F16 ≈ 0.71、7B Q4_0 ≈ 0.42
 *   - cuda-datacenter：HBM + CUDA graph 运行时可到 0.85
 *   - rocm：同档内存上解码 kernel 落后 CUDA
 *
 * 只在探测到明确后端时启用分档；后端未知时退回 TUNING.memoryEfficiency（0.7），
 * 保持历史校准口径，不拿猜出来的后端冒充精确。
 */
export const DECODE_EFFICIENCY = {
  'cuda-consumer': { mbu: 0.75, dequant4: 0.78 },
  'cuda-datacenter': { mbu: 0.85, dequant4: 0.85 },
  rocm: { mbu: 0.72, dequant4: 0.7 },
  metal: { mbu: 0.7, dequant4: 0.62 }
}

const DEQUANT_REFERENCE_BITS = 4
const NATIVE_BITS = 16

/**
 * 从硬件描述推断设备族。只有明确的后端标识才会分档：
 * 只给了卡名、没给 backend 的调用方（老的 JSON 契约、第三方集成）继续走兜底，
 * 避免拿名字猜出来的族把已验证的校准点悄悄改掉。
 */
export function deviceFamilyOf(gpu, hw) {
  if (!gpu) return 'cpu'
  const backend = String(gpu.backend || '').toLowerCase()
  const name = String(gpu.name || '').toLowerCase()
  if (backend === 'metal' || hw?.osPlatform === 'darwin' || hw?.platform === 'darwin') return 'metal'
  if (backend === 'rocm' || (backend === 'vulkan' && /amd|radeon/.test(name))) return 'rocm'
  if (backend === 'cuda') {
    // 数据中心卡：A/H/L 系列与老 Tesla/Quadro。消费卡 GeForce/RTX 走另一档。
    return /\b(a100|a8000|a6000|a5000|a40|a30|h100|h200|h800|l40|l40s|l4|v100|p100|t4|a10)\b|tesla/.test(name)
      ? 'cuda-datacenter'
      : 'cuda-consumer'
  }
  return 'unknown'
}

/**
 * 给定设备族和每权重位宽，返回有效带宽利用率。
 * bpw 拿不到时退回历史固定值——宁可保守报粗估，也不编一个精度。
 */
export function decodeEfficiency(family, bitsPerWeight) {
  const table = DECODE_EFFICIENCY[family]
  if (!table || !Number.isFinite(bitsPerWeight) || bitsPerWeight <= 0) return TUNING.memoryEfficiency
  const narrowness = Math.min(Math.max((NATIVE_BITS - bitsPerWeight) / (NATIVE_BITS - DEQUANT_REFERENCE_BITS), 0), 1)
  return table.mbu * (1 - (1 - table.dequant4) * narrowness)
}

/**
 * 速度封顶值：命令行主报告和 --json 必须走同一套，不能一个封顶一个不封。
 *
 * 为什么会踩坑：原先封顶只写在命令行渲染里，`toJson` 直接把公式值
 * Math.round 出去。0.5 GB 的小模型在 448 GB/s 的卡上公式给 627 tok/s，
 * 界面（消费 JSON）就显示 ~627，而命令行写「不到 200」——同一个工具
 * 两条出口给出两个数，用户只会挑大的那个信。
 */
export function speedCapFor(weightsBytes) {
  const gb = (Number(weightsBytes) || 0) / 1e9
  return gb > 0 && gb < TUNING.smallModelGB ? TUNING.speedCapTiny : TUNING.speedCap
}

/** KV cache 每个元素的字节数。q8_0 / q4_0 带 per-block scale，不是整 1 / 0.5 字节 */
/**
 * KV cache 每元素的字节数。q8_0/q4_0 的零头是块量化的 scale（32 元素一块多 2 字节）。
 *
 * `k8v16` 是「只量化 K、V 保持 f16」的组合档 —— RoRoToCode 在 Turing（cc<8）上就是
 * 这么起的：`-ctk q8_0` 不依赖 flash attention，`-ctv` 依赖，所以 V 不量化。
 * 平均值 1.53125 与 K/V 同维度时完全等价（实测 Ornith-9B：65536 上下文正好 1568 MiB，
 * 其中 K 544 + V 1024）。按 f16 估会少算 25%，按 q8_0 估会多算 30%，取中间才是真值。
 */
export const KV_BYTES_PER_ELEM = { f16: 2, q8_0: 1.0625, q4_0: 0.5625, k8v16: 1.53125 }

/**
 * 报告 / 网页 / README 共用的「参数与假设」清单。
 * 每条都对应 TUNING 里的一个数字，或者一条代码里写死的判据。
 *
 * 文案写成 [中文, English]：清单本身是数据，不能在模块加载那一刻就锁死语言。
 * 取用一律走 assumptionsList()，它按当前 locale 展开。
 */
export const ASSUMPTIONS = [
  {
    group: ['权重体积', 'Weight size'],
    items: [
      { k: ['取法', 'Source'], v: ['文件字节数', 'File byte count'],
        note: ['分片模型按「第 1 片 × 片数」估算，各片大小基本相等',
          'Sharded models use shard 1 × count; shards are near-equal in size'] },
      { k: ['包含', 'Includes'], v: ['全部张量', 'All tensors'],
        note: ['含 embedding / lm_head；不含训练或微调时的额外状态',
          'Embeds and lm_head included; no training or fine-tuning state'] }
    ]
  },
  {
    group: ['KV cache', 'KV cache'],
    items: [
      { k: ['公式', 'Formula'], v: ['ctx × 层数 × n_kv_head × (k_dim + v_dim) × 每元素字节',
        'ctx × layers × n_kv_head × (k_dim + v_dim) × bytes per element'],
        note: ['', ''] },
      { k: ['MLA（DeepSeek）', 'MLA (DeepSeek)'], v: ['ctx × 层数 × n_kv_head × (潜向量 + RoPE) × 每元素字节',
        'ctx × layers × n_kv_head × (latent + RoPE) × bytes/element'],
        note: ['V 复用同一行 K，不单独分配；只在 GGUF 同时带 key/value_length_mla 时按 MLA 算',
          'V reuses the same K row; applied only when both *_length_mla keys are present'] },
      { k: ['每元素字节', 'Bytes per element'], v: ['f16 = 2 B · q8_0 = 1.0625 B · q4_0 = 0.5625 B',
        'f16 = 2 B · q8_0 = 1.0625 B · q4_0 = 0.5625 B'],
        note: ['q8_0 / q4_0 带 per-block scale', 'q8_0 / q4_0 carry a per-block scale'] },
      { k: ['混合线性架构', 'Hybrid linear arch'], v: ['只算 1/N 层有 KV', 'Only 1/N of layers carry KV'],
        note: ['N 从 full_attention_interval 读；缺失时按 ssm.* 参数推断为 4',
          'N comes from full_attention_interval; inferred as 4 from ssm.* params when absent'] },
      { k: ['滑窗架构', 'Sliding-window arch'], v: ['full 层按 ctx，其余层按窗口长度',
        'full layers use ctx, the rest use the window length'],
        note: ['层分配比例按架构规则推断，可能有 ±25% 偏差',
          'Layer split is inferred from architecture rules; ±25% possible'] }
    ]
  },
  {
    group: ['运行时开销', 'Runtime overhead'],
    items: [
      { k: ['固定预留', 'Fixed reserve'], v: ['800 MiB', '800 MiB'],
        note: ['CUDA context + batch 与计算缓冲。驱动 581 实测 context 300–500 MiB，再加缓冲与碎片',
          'CUDA context plus batch/compute buffers. Driver 581 measured 300–500 MiB for context alone'] },
      { k: ['看图投影器', 'Vision projector'], v: ['投影器文件 + 384 MiB 激活', 'projector file + 384 MiB activation'],
        note: ['传了 --mmproj 才计入。实测 9B：纯文本 7032 MiB，带图 7710 MiB（+680 MiB，其中投影器 290 MiB）',
          'Only counted with --mmproj. Measured 9B: 7032 MiB text vs 7710 MiB with images (+680 MiB, projector 290 MiB)'] }
    ]
  },
  {
    group: ['显存上限', 'VRAM ceiling'],
    items: [
      { k: ['Windows 静态', 'Windows static'], v: ['总显存 × 0.94', 'total × 0.94'],
        note: ['默认静态口径：不扣当前占用，同一台机器结论可复现；`--budget auto` 才按当前可用算',
          'Static by default: current usage is ignored, so results are reproducible; `--budget auto` uses current free'] },
      { k: ['Windows 动态', 'Windows auto'], v: ['min(可用 × 0.92, 总显存 × 0.94)', 'min(free × 0.92, total × 0.94)'],
        note: ['WDDM 虽可驱逐显存，但换页会让推理慢到不可用，所以只按当前可用算；读数会随别的程序开合跳',
          'WDDM can evict VRAM, but paging makes inference unusably slow, so only current free counts; the reading swings as other apps open and close'] },
      { k: ['Linux', 'Linux'], v: ['总显存 × 0.94；auto 时 可用 × 0.92', 'total × 0.94; free × 0.92 with auto'],
        note: ['显存不可驱逐；auto 口径只按当前可用算', 'VRAM is not evictable; the auto basis uses current free only'] },
      { k: ['macOS 统一内存', 'macOS unified'], v: ['Metal 建议工作集 × 0.9', 'Metal working set × 0.9'],
        note: ['读不到建议工作集时按物理内存 75%', 'Falls back to 75% of physical RAM when unavailable'] },
      { k: ['没有独立显卡', 'No dGPU'], v: ['物理内存 × 0.8', 'physical RAM × 0.8'],
        note: ['纯 CPU 推理，要给系统和页缓存留空间', 'Pure CPU inference; leave room for the OS and page cache'] }
    ]
  },
  {
    group: ['判定门槛', 'Thresholds'],
    items: [
      { k: ['接近上限', 'Near ceiling'], v: ['需要量 > 上限 × 85%', 'need > ceiling × 85%'],
        note: ['仍算装得下，但再开大上下文就会失败', 'Still counts as fitting, but a larger context will fail'] },
      { k: ['参数量', 'Parameters'], v: ['< 3B 只算「能跑」', '< 3B counts as "runs only"'],
        note: ['这不是能力评测，只是拦住明显不可能的档位', 'Not a capability benchmark — just rules out obviously impossible tiers'] },
      { k: ['上下文', 'Context'], v: ['< 8K 判「太短」', '< 8K is "too short"'],
        note: ['塞不下一个像样的代码文件', 'Not enough for a reasonable source file'] },
      { k: ['量化质量', 'Quantization'], v: ['1–2 bit 判「别用」', '1–2 bit is "avoid"'],
        note: ['经验分级，不是测出来的', 'An empirical tier, not a measurement'] }
    ]
  },
  {
    group: ['生成速度（零上下文解码峰值）', 'Generation speed (zero-context decode peak)'],
    items: [
      { k: ['公式', 'Formula'], v: ['带宽 × 效率 ÷ 权重 GB', 'bandwidth × efficiency ÷ weight GB'],
        note: ['瓶颈是带宽不是算力。效率按显卡后端和权重量化位宽分档：带宽利用率 × 4-bit 反量化惩罚，取自 llama.cpp 公开 pp/tg 基准；后端未知时退回 0.7（RTX 2080 + 9B 实测校准点）。这是零上下文、batch=1、权重驻留显存时的理论上限，不是实际能跑到的速度',
          'Bandwidth-bound, not compute-bound. Efficiency is tabulated by backend and weight width: bandwidth utilisation × 4-bit dequantisation penalty, fitted to published llama.cpp pp/tg benchmarks; unknown backends fall back to 0.7 (calibrated on an RTX 2080 with 9B). This is a theoretical ceiling at zero context, batch=1, all weights resident — not a speed you should expect in practice'] },
      { k: ['不计上下文', 'Context excluded'], v: ['不计 KV cache 读取', 'KV cache reads excluded'],
        note: ['解码每步还要把整段 KV cache 读一遍，上下文越长越慢；另给「按建议上下文」的折减值，仍属静态推算',
          'Each decode step also reads the whole KV cache, so longer contexts are slower. A context-adjusted figure is reported separately; it is still a static estimate'] },
      { k: ['误差', 'Error'], v: ['约 ±20%', 'about ±20%'],
        note: ['受驱动、batch 设置、KV 精度影响；不含首字延迟、工具执行与排队，长上下文下会明显低于峰值。分档系数取自公开基准，本机 RTX 2080 + 9B Q4_K_M 的实测点（53.9）现落在 -14% 侧，故误差带放宽到 ±20%',
          'Depends on driver, batch settings and KV precision; excludes time-to-first-token, tool runs and queueing. Long contexts land well below the peak. Family factors come from published benchmarks, and our own RTX 2080 + 9B Q4_K_M measurement (53.9) now lands 14% low, hence the ±20% band'] },
      { k: ['小模型', 'Small models'], v: ['< 2 GB 封顶 200，其余 400 tok/s', 'cap 200 under 2 GB, 400 otherwise'],
        note: ['每 token 的固定开销会压住公式值，公式对小模型失效；命令行与 JSON 都套用同一个封顶',
          'Per-token overhead dominates, so the formula stops holding. CLI and JSON apply the same cap'] },
      { k: ['MoE 模型', 'MoE models'], v: ['速度按激活专家数修正', 'speed adjusted by active experts'],
        note: ['MoE 每 token 只读激活的专家，速度按「全权重×(激活数/专家数)」估算；显存仍按全权重（专家都得驻留）。共享层未剔除，故偏乐观',
          'Each token reads only active experts: speed uses full weights × (active/experts); VRAM still counts all weights. Shared layers are not excluded, so this is optimistic'] }
    ]
  },
  {
    group: ['这个工具不做什么', 'What this tool does not do'],
    items: [
      { k: ['不实测', 'No measurement'], v: ['不加载模型、不跑推理', 'loads no model, runs no inference'],
        note: ['所有数字都是静态推算，不是性能测试', 'Every number is a static estimate, not a benchmark'] },
      { k: ['不读真实占用', 'No live usage'], v: ['网页端做不到', 'impossible in a browser'],
        note: ['浏览器不暴露显存占用，只能按用户填的值算', 'Browsers do not expose VRAM usage, so the value you type is used'] },
      { k: ['不做张量并行', 'No tensor parallelism'], v: ['多卡只按整层切分', 'multi-GPU is layer split only'],
        note: ['--gpu 选评估哪张卡；多卡机器另给合并评估（显存相加、带宽取最慢卡、速度不翻倍），张量并行不在范围内',
          'Use --gpu to pick a card; multi-GPU machines also get a combined estimate (VRAM summed, weakest bandwidth, no speed-up). Tensor parallelism is out of scope'] },
      { k: ['模板只做字符串分析', 'Templates are parsed, not run'], v: ['不代表真实调用成功率', 'not a measure of success rate'],
        note: ['有 tools 分支 ≠ 模型真会稳定调用工具', 'A tools branch ≠ reliable tool calling'] }
    ]
  }
]

/**
 * 按当前语言展开的假设清单。渲染层只认这个形状，
 * 数据里那层 [zh, en] 不外泄。
 */
export function assumptionsList() {
  const pick = (pair) => (Array.isArray(pair) ? (getLocale() === 'en' ? pair[1] : pair[0]) : pair)
  return ASSUMPTIONS.map((g) => ({
    group: pick(g.group),
    items: g.items.map((it) => ({ k: pick(it.k), v: pick(it.v), note: pick(it.note) }))
  }))
}

/** 把假设清单拍平成纯文本行，命令行和 README 都用它，避免各写一份 */
export function assumptionLines() {
  const sep = getLocale() === 'en' ? ': ' : '：'
  const out = []
  for (const g of assumptionsList()) {
    out.push(g.group)
    for (const it of g.items) {
      out.push(`  ${it.k}${sep}${it.v}${it.note ? (getLocale() === 'en' ? ` (${it.note})` : `（${it.note}）`) : ''}`)
    }
  }
  return out
}
