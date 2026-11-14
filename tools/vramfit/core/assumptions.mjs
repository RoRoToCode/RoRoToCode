/**
 * 全部可调参数与前提假设，集中在这一处。
 *
 * 为什么要单独抽一个文件：
 *   1. 报告里写的「+ 200 MiB 开销」和代码里算的必须是同一个数。以前分散在
 *      assess / render / 网页三处，改一个忘两个就会自相矛盾。
 *   2. 用户有权知道结论是怎么来的。网页和命令行的「参数与假设」全都是从这里
 *      渲染出来的，不是另写一份文案 —— 文案会过期，代码不会。
 *
 * 改这里的任何数字，等价于改结论。请同步核对 ASSUMPTIONS 里的描述文字。
 */

import { getLocale } from './i18n.mjs'

export const TUNING = {  /** 运行时开销：batch / 计算缓冲。RTX 2080 + 9B Q4_M 实测约 80 MiB，取 200 MiB 留余量 */
  overheadBytes: 200 * 1024 * 1024,

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

  /** 显存带宽利用率：每吐一个 token 要把全部权重读一遍，实际有效带宽约为标称值的 70% */
  memoryEfficiency: 0.7,

  /** 需要量超过上限的这个比例就标「接近上限」，提醒用户别再往上开上下文 */
  tightRatio: 0.85,

  /**
   * Windows 预算：取 min(可用×0.92, 总×0.94)。
   * 曾经是 max —— 那等于「总显存的 94% 永远可用」，无视当前占用，
   * 8 GB 卡上已占 7.2 GB 时还推荐 64K，真跑起来并发就掉到 1.5 tok/s。
   */
  wddmFreeFactor: 0.92,
  /** 只是物理上限（装进去不会溢出），不是「现在装得下」的预算 */
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

  /** 参数量低于这个门槛，只算「能跑」，不算 agent 可用 */
  minAgentParams: 3e9,
  /** 上下文低于这个值，塞不下一个代码文件 */
  minAgentContext: 8192,

  /** 小模型速度封顶：每 token 的固定开销会压住公式值，2 GB 以下最多给 200，其余最多 400 */
  smallModelGB: 2,
  speedCap: 400,
  speedCapTiny: 200,

  /** 速度估算的误差区间（百分比），只用于文案 */
  speedErrorPct: 15
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
      { k: ['固定预留', 'Fixed reserve'], v: ['200 MiB', '200 MiB'],
        note: ['batch 与计算缓冲。RTX 2080 + 9B Q4_K_M 实测约 80 MiB，这里留了余量',
          'Batch and compute buffers. Measured ~80 MiB on an RTX 2080 with 9B Q4_K_M; rounded up'] },
      { k: ['看图投影器', 'Vision projector'], v: ['投影器文件 + 384 MiB 激活', 'projector file + 384 MiB activation'],
        note: ['传了 --mmproj 才计入。实测 9B：纯文本 7032 MiB，带图 7710 MiB（+680 MiB，其中投影器 290 MiB）',
          'Only counted with --mmproj. Measured 9B: 7032 MiB text vs 7710 MiB with images (+680 MiB, projector 290 MiB)'] }
    ]
  },
  {
    group: ['显存上限', 'VRAM ceiling'],
    items: [
      { k: ['Windows', 'Windows'], v: ['min(可用 × 0.92, 总显存 × 0.94)', 'min(free × 0.92, total × 0.94)'],
        note: ['WDDM 虽可驱逐显存，但换页会让推理慢到不可用，所以只按当前可用算', 'WDDM can evict VRAM, but paging makes inference unusably slow, so only current free counts'] },
      { k: ['Linux', 'Linux'], v: ['可用 × 0.92', 'free × 0.92'],
        note: ['显存不可驱逐，只能按当前可用算', 'VRAM is not evictable, so only current free counts'] },
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
      { k: ['公式', 'Formula'], v: ['带宽 × 0.7 ÷ 权重 GB', 'bandwidth × 0.7 ÷ weight GB'],
        note: ['瓶颈是带宽不是算力，已按 RTX 2080 + 9B 实测校准（±1%）。这是零上下文、batch=1、全权重驻留显存时的理论上限，不是实际能跑到的速度',
          'Bandwidth-bound, not compute-bound; calibrated against an RTX 2080 with 9B (±1%). This is a theoretical ceiling at zero context, batch=1, all weights resident — not a speed you should expect in practice'] },
      { k: ['不计上下文', 'Context excluded'], v: ['不计 KV cache 读取', 'KV cache reads excluded'],
        note: ['解码每步还要把整段 KV cache 读一遍，上下文越长越慢；另给「按建议上下文」的折减值，仍属静态推算',
          'Each decode step also reads the whole KV cache, so longer contexts are slower. A context-adjusted figure is reported separately; it is still a static estimate'] },
      { k: ['误差', 'Error'], v: ['约 ±15%', 'about ±15%'],
        note: ['受驱动、batch 设置、KV 精度影响；不含首字延迟、工具执行与排队，长上下文下会明显低于峰值',
          'Depends on driver, batch settings and KV precision; excludes time-to-first-token, tool runs and queueing. Long contexts land well below the peak'] },
      { k: ['小模型', 'Small models'], v: ['< 2 GB 封顶 200，其余 400 tok/s', 'cap 200 under 2 GB, 400 otherwise'],
        note: ['每 token 的固定开销会压住公式值，公式对小模型失效；命令行与 JSON 都套用同一个封顶',
          'Per-token overhead dominates, so the formula stops holding. CLI and JSON apply the same cap'] },
      { k: ['MoE 模型', 'MoE models'], v: ['未计入激活比例', 'activation ratio not modelled'],
        note: ['MoE 每 token 只读部分专家，实际速度会高于估算；界面会提示这一点',
          'Only some experts are read per token, so real speed is higher; the UI flags this'] }
    ]
  },
  {
    group: ['这个工具不做什么', 'What this tool does not do'],
    items: [
      { k: ['不实测', 'No measurement'], v: ['不加载模型、不跑推理', 'loads no model, runs no inference'],
        note: ['所有数字都是静态推算，不是性能测试', 'Every number is a static estimate, not a benchmark'] },
      { k: ['不读真实占用', 'No live usage'], v: ['网页端做不到', 'impossible in a browser'],
        note: ['浏览器不暴露显存占用，只能按用户填的值算', 'Browsers do not expose VRAM usage, so the value you type is used'] },
      { k: ['不跨卡切分', 'No cross-GPU split'], v: ['一个模型只放一张卡', 'one model on one GPU only'],
        note: ['可以用 --gpu 选评估哪张卡，但张量并行 / 逐层切分不在估算范围内',
          'Use --gpu to pick which card to evaluate; tensor parallelism and layer splits are out of scope'] },
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
