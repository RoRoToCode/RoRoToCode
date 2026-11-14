/**
 * 显卡分档策略：按「build 号 + CUDA 算力 + 后端」输出一组启动参数开关。
 *
 * 为什么要按显卡分档而不是一个布尔开关：不同显卡能跑的 llama.cpp 参数差异很大，
 * 一刀切要么崩要么慢：
 *
 *   - Turing（cc 7.5，如 RTX 2080）：官方 CUDA 构建缺 FA 的 MMA kernel，开 `-fa on`
 *     首次生成即 CUDA error 崩进程。但 KV 量化里的 **K cache 量化（-ctk）不依赖 FA**，
 *     白拿一半 K cache 空间——对 8GB 小卡最值钱。所以 cc<8 时只关 FA + V 量化，保留 K。
 *   - Ampere 及更新（cc≥8.0，如 30/40/50 系）：FA + KV 量化全开。
 *   - Vulkan / CPU：FA 与 KV 量化要么不支持要么无意义，一律不加。
 *
 * 这是纯函数模块（不 import electron、不 spawn、不碰文件），方便单测与复用。
 */

/** 现代性能参数（flash attention + KV 量化）要求的最低 build */
export const PERF_MIN_BUILD = 6000

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'unknown'
export type GpuArch = 'pascal' | 'turing' | 'ampere' | 'ada' | 'blackwell' | 'other' | 'unknown'

/**
 * 能力位：下游只看这些布尔值，不看显卡型号。
 * 由 `resolveGpuProfile` 一份规则推导，诊断 / 启动参数共用，避免两套口径打架。
 */
export interface GpuFeatures {
  /** 构建是否认得现代性能参数（-fa on / -ctk / -ctv / -ub） */
  modernArgs: boolean
  /** FA 的 MMA kernel 可用。Turing(7.5) 的官方 CUDA 构建缺设备代码，开了首次生成即崩 */
  flashAttn: boolean
  /** K cache 量化：不依赖 FA，Turing 也能开 —— 这是拆门控的关键 */
  kvQuantK: boolean
  /** V cache 量化：llama.cpp 要求配合 FA */
  kvQuantV: boolean
  /** 能把层整批放到显卡上 */
  gpuOffload: boolean
  /** 构建支持投机解码（-md） */
  speculative: boolean
  vulkan: boolean
}

/**
 * Vulkan 后端开 FA / KV 量化的最低 build。
 *
 * 为什么默认不开：Vulkan 的 FA kernel 这几年一直在补，AMD / Intel 各代驱动表现差很多，
 * 开错的表现是「模型能加载、第一次生成就崩」，比慢一点糟得多。所以这里只提供
 * **显式开启**（`ROROTO_LLAMA_VULKAN_PERF=1`）+ build 门槛，等用户自己验证过再默认开。
 */
export const VULKAN_PERF_MIN_BUILD = 8000

export interface GpuProfile {
  /** FA（flash attention）能不能开 */
  fa: boolean
  /** K cache 量化（-ctk），不依赖 FA */
  ctk: boolean
  /** V cache 量化（-ctv），依赖 FA */
  ctv: boolean
  /** micro-batch（-ub）建议值；0 = 用默认 512 */
  ub: number
  /** 策略提示：为什么这么判（写进启动日志给用户看） */
  reason: string
  /** 生成此档位的依据标签，供 smoke/诊断断言 */
  tier: 'cuda-fa' | 'cuda-nofa' | 'vulkan' | 'vulkan-fa' | 'cpu' | 'unknown'
}

/** 分档决策的输入（探测结果 + 覆盖开关） */
export interface GpuProfileInput {
  /** 已装 llama.cpp 的 build 号；识别不出为 null */
  build: number | null
  /** 主显卡 CUDA compute capability（2080=7.5，3080=8.6）；查不到为 null */
  cc: number | null
  /** 后端偏好（gpuplan 探测结果） */
  pref: 'cuda' | 'vulkan' | 'cpu'
  /** ROROTO_LLAMA_NO_FA=1：全关 */
  noFa: boolean
  /** ROROTO_LLAMA_FORCE_FA=1：即使算力不足也强开 FA */
  forceFa: boolean
  /** ROROTO_LLAMA_VULKAN_PERF=1：Vulkan 也开 FA / KV 量化（默认关） */
  vulkanPerf?: boolean
}

/**
 * 纯函数：给定 build / 算力 / 后端 / 覆盖开关，返回一档策略。
 * 所有输入显式传入，测试里可覆盖全部分支；探测与缓存由调用方（llama.ts）负责。
 */
export function resolveGpuProfile(input: GpuProfileInput): GpuProfile {
  const base: GpuProfile = { fa: false, ctk: false, ctv: false, ub: 0, reason: '', tier: 'unknown' }
  const { build, cc, pref } = input

  // build 太老 / 识别不出：一律不加，宁慢勿崩
  if (build === null || build < PERF_MIN_BUILD) {
    return { ...base, reason: `build ${build ?? '未知'} 低于 ${PERF_MIN_BUILD}，不加性能参数` }
  }

  if (input.noFa) return { ...base, reason: 'ROROTO_LLAMA_NO_FA=1，全部关闭' }

  // Vulkan / CPU：FA 与 KV 量化在这两个后端上没有对应 kernel 或没有收益
  if (pref === 'vulkan') {
    /**
     * Vulkan 现在（新构建 + 部分驱动）是支持 `-fa on` 和 KV 量化的，但支持度取决于
     * 显卡与驱动版本，出错的表现是「加载正常、第一次生成崩」。所以只做显式开启：
     * 用户验证过自己的卡能跑，再设 ROROTO_LLAMA_VULKAN_PERF=1。
     */
    if (input.vulkanPerf === true && build >= VULKAN_PERF_MIN_BUILD) {
      return {
        fa: true,
        ctk: true,
        ctv: true,
        ub: 0,
        tier: 'vulkan-fa',
        reason: `Vulkan 后端 + build ${build}：已按 ROROTO_LLAMA_VULKAN_PERF=1 开启 FA / KV 量化`
      }
    }
    return {
      ...base,
      tier: 'vulkan',
      reason:
        'Vulkan 后端：默认不加 FA / KV 量化（各驱动 kernel 差异大，开错会首次生成就崩）；' +
        `确认自己的卡稳定后，设 ROROTO_LLAMA_VULKAN_PERF=1 可开启（需 build ≥ ${VULKAN_PERF_MIN_BUILD}）`
    }
  }
  if (pref === 'cpu') {
    return { ...base, tier: 'cpu', reason: 'CPU 后端：flash attention / KV 量化不适用' }
  }

  // CUDA：按算力分档
  if (cc === null) {
    // 是 N 卡但算力探不出（驱动异常）：宁可退回最保守，别赌 FA
    return { ...base, tier: 'cuda-nofa', reason: 'CUDA 算力识别不出，退回保守档（不加 FA/KV 量化）' }
  }

  if (cc >= 8 || input.forceFa) {
    return {
      fa: true,
      ctk: true,
      ctv: true,
      ub: 1024,
      tier: 'cuda-fa',
      reason: input.forceFa ? `强制开 FA（ROROTO_LLAMA_FORCE_FA=1，cc=${cc}）` : `cc ${cc} ≥ 8：FA + KV 量化全开`
    }
  }

  // Turing 及更老（cc < 8）：关 FA，但 K cache 量化仍可用
  return {
    fa: false,
    ctk: true,
    ctv: false,
    ub: 0,
    tier: 'cuda-nofa',
    reason: `cc ${cc} < 8（Turing）：官方构建缺 FA kernel，关 FA/V 量化；K cache 量化保留`
  }
}
