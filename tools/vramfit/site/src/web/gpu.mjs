/**
 * 浏览器端的「硬件探测」。
 *
 * 前提先说清楚：网页拿不到真实显存容量。navigator.gpu 和 WebGL 只给型号，
 * maxBufferSize 被浏览器 clamp 到 256 MB，跟显存无关。所以这里只有一条路：
 * 认出型号 → 查表拿显存和带宽 → 允许用户覆盖。
 *
 * 认出型号这一步比想象中可靠。Chrome 的 UNMASKED_RENDERER_WEBGL 长这样：
 *   ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)
 *   ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0, D3D11)
 *   ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)
 * Firefox 是 "NVIDIA GeForce RTX 4090/PCIe/SSE2"。都能捞出型号。
 *
 * 但有个坑：笔记本双显卡时，浏览器进程默认跑在核显上，报的是 Intel UHD 而不是
 * RTX 4060。所以识别结果必须可改，且要明说「这是浏览器报的」。
 */

import { tx } from './strings.mjs'

/**
 * 带宽单位 GB/s；vram 单位 GB（0 表示由用户填，Apple 和核显属于这类）
 *
 * 数值来源：NVIDIA / AMD / Apple 产品页公布的内存规格（位宽 × 速率 ÷ 8），
 * 2026-10 核对。都是公开的产品参数，厂商改了以页面为准，改这里即可。
 * CLI 侧有一份同样的表（github/cli/hardware.mjs），两边数值要保持一致。
 */
const GPU_TABLE = [
  // ── NVIDIA RTX 50
  { re: /rtx\s*5090/i, name: 'RTX 5090', vram: 32, bw: 1792, vendor: 'nvidia' },
  { re: /rtx\s*5080/i, name: 'RTX 5080', vram: 16, bw: 960, vendor: 'nvidia' },
  { re: /rtx\s*5070\s*ti/i, name: 'RTX 5070 Ti', vram: 16, bw: 896, vendor: 'nvidia' },
  { re: /rtx\s*5070/i, name: 'RTX 5070', vram: 12, bw: 672, vendor: 'nvidia' },
  { re: /rtx\s*5060\s*ti/i, name: 'RTX 5060 Ti', vram: 16, bw: 448, vendor: 'nvidia' },
  { re: /rtx\s*5060/i, name: 'RTX 5060', vram: 8, bw: 448, vendor: 'nvidia' },
  // ── NVIDIA RTX 40
  // 注意 \b：ANGLE 的字符串里每个型号后面都跟着 "Direct3D11"，
  // 写成 /4090\s*d/ 会把 "4090 Direct3D11" 认成 4090 D（显存差 0 但名字错，且会误导人）。
  { re: /rtx\s*4090\s*-?\s*d\b/i, name: 'RTX 4090 D', vram: 24, bw: 1008, vendor: 'nvidia' },
  { re: /rtx\s*4090/i, name: 'RTX 4090', vram: 24, bw: 1008, vendor: 'nvidia' },
  { re: /rtx\s*4080\s*super/i, name: 'RTX 4080 SUPER', vram: 16, bw: 736, vendor: 'nvidia' },
  { re: /rtx\s*4080/i, name: 'RTX 4080', vram: 16, bw: 717, vendor: 'nvidia' },
  { re: /rtx\s*4070\s*ti\s*super/i, name: 'RTX 4070 Ti SUPER', vram: 16, bw: 672, vendor: 'nvidia' },
  { re: /rtx\s*4070\s*ti/i, name: 'RTX 4070 Ti', vram: 12, bw: 504, vendor: 'nvidia' },
  { re: /rtx\s*4070\s*super/i, name: 'RTX 4070 SUPER', vram: 12, bw: 504, vendor: 'nvidia' },
  { re: /rtx\s*4070/i, name: 'RTX 4070', vram: 12, bw: 504, vendor: 'nvidia' },
  { re: /rtx\s*4060\s*ti/i, name: 'RTX 4060 Ti', vram: 8, bw: 288, vendor: 'nvidia' },
  { re: /rtx\s*4060/i, name: 'RTX 4060', vram: 8, bw: 272, vendor: 'nvidia' },
  // ── NVIDIA RTX 30
  { re: /rtx\s*3090\s*ti/i, name: 'RTX 3090 Ti', vram: 24, bw: 1008, vendor: 'nvidia' },
  { re: /rtx\s*3090/i, name: 'RTX 3090', vram: 24, bw: 936, vendor: 'nvidia' },
  { re: /rtx\s*3080\s*ti/i, name: 'RTX 3080 Ti', vram: 12, bw: 912, vendor: 'nvidia' },
  { re: /rtx\s*3080/i, name: 'RTX 3080', vram: 10, bw: 760, vendor: 'nvidia' },
  { re: /rtx\s*3070\s*ti/i, name: 'RTX 3070 Ti', vram: 8, bw: 608, vendor: 'nvidia' },
  { re: /rtx\s*3070/i, name: 'RTX 3070', vram: 8, bw: 448, vendor: 'nvidia' },
  { re: /rtx\s*3060\s*ti/i, name: 'RTX 3060 Ti', vram: 8, bw: 448, vendor: 'nvidia' },
  { re: /rtx\s*3060/i, name: 'RTX 3060', vram: 12, bw: 360, vendor: 'nvidia' },
  { re: /rtx\s*3050/i, name: 'RTX 3050', vram: 8, bw: 224, vendor: 'nvidia' },
  // ── NVIDIA RTX 20
  { re: /rtx\s*2080\s*ti/i, name: 'RTX 2080 Ti', vram: 11, bw: 616, vendor: 'nvidia' },
  { re: /rtx\s*2080\s*super/i, name: 'RTX 2080 SUPER', vram: 8, bw: 496, vendor: 'nvidia' },
  { re: /rtx\s*2080/i, name: 'RTX 2080', vram: 8, bw: 448, vendor: 'nvidia' },
  { re: /rtx\s*2070\s*super/i, name: 'RTX 2070 SUPER', vram: 8, bw: 448, vendor: 'nvidia' },
  { re: /rtx\s*2070/i, name: 'RTX 2070', vram: 8, bw: 448, vendor: 'nvidia' },
  { re: /rtx\s*2060\s*super/i, name: 'RTX 2060 SUPER', vram: 8, bw: 448, vendor: 'nvidia' },
  { re: /rtx\s*2060/i, name: 'RTX 2060', vram: 6, bw: 336, vendor: 'nvidia' },
  // ── NVIDIA 专业卡 / 数据中心
  { re: /h200/i, name: 'H200', vram: 141, bw: 4800, vendor: 'nvidia' },
  { re: /h100/i, name: 'H100', vram: 80, bw: 3350, vendor: 'nvidia' },
  { re: /a100\s*80|a100.*80/i, name: 'A100 80GB', vram: 80, bw: 2039, vendor: 'nvidia' },
  { re: /a100/i, name: 'A100 40GB', vram: 40, bw: 1555, vendor: 'nvidia' },
  { re: /rtx\s*6000\s*ada|6000\s*ada/i, name: 'RTX 6000 Ada', vram: 48, bw: 960, vendor: 'nvidia' },
  { re: /l40s/i, name: 'L40S', vram: 48, bw: 864, vendor: 'nvidia' },
  { re: /l40/i, name: 'L40', vram: 48, bw: 864, vendor: 'nvidia' },
  { re: /a6000/i, name: 'RTX A6000', vram: 48, bw: 768, vendor: 'nvidia' },
  { re: /a5000/i, name: 'RTX A5000', vram: 24, bw: 768, vendor: 'nvidia' },
  // ── AMD RDNA4 / RDNA3
  { re: /9070\s*xt/i, name: 'RX 9070 XT', vram: 16, bw: 645, vendor: 'amd' },
  { re: /9070\s*gre/i, name: 'RX 9070 GRE', vram: 12, bw: 576, vendor: 'amd' },
  { re: /9070/i, name: 'RX 9070', vram: 16, bw: 576, vendor: 'amd' },
  { re: /9060\s*xt/i, name: 'RX 9060 XT', vram: 16, bw: 322, vendor: 'amd' },
  { re: /7900\s*xtx/i, name: 'RX 7900 XTX', vram: 24, bw: 960, vendor: 'amd' },
  { re: /7900\s*xt/i, name: 'RX 7900 XT', vram: 20, bw: 800, vendor: 'amd' },
  { re: /7900\s*gre/i, name: 'RX 7900 GRE', vram: 16, bw: 576, vendor: 'amd' },
  { re: /7800\s*xt/i, name: 'RX 7800 XT', vram: 16, bw: 624, vendor: 'amd' },
  { re: /7700\s*xt/i, name: 'RX 7700 XT', vram: 12, bw: 432, vendor: 'amd' },
  { re: /7600/i, name: 'RX 7600', vram: 8, bw: 288, vendor: 'amd' },
  // ── AMD RDNA2 / RDNA1
  { re: /6950\s*xt/i, name: 'RX 6950 XT', vram: 16, bw: 576, vendor: 'amd' },
  { re: /6900\s*xt/i, name: 'RX 6900 XT', vram: 16, bw: 512, vendor: 'amd' },
  { re: /6800\s*xt/i, name: 'RX 6800 XT', vram: 16, bw: 512, vendor: 'amd' },
  { re: /6800/i, name: 'RX 6800', vram: 16, bw: 512, vendor: 'amd' },
  { re: /6750\s*xt/i, name: 'RX 6750 XT', vram: 12, bw: 432, vendor: 'amd' },
  { re: /6700\s*xt/i, name: 'RX 6700 XT', vram: 12, bw: 384, vendor: 'amd' },
  { re: /6600\s*xt/i, name: 'RX 6600 XT', vram: 8, bw: 224, vendor: 'amd' },
  { re: /6600/i, name: 'RX 6600', vram: 8, bw: 224, vendor: 'amd' },
  { re: /5700\s*xt/i, name: 'RX 5700 XT', vram: 8, bw: 448, vendor: 'amd' },
  // ── Apple Silicon：显存 = 统一内存，容量由用户选，这里只给带宽
  { re: /m4\s*max/i, name: 'Apple M4 Max', vram: 0, bw: 546, vendor: 'apple', unified: true },
  { re: /m4\s*pro/i, name: 'Apple M4 Pro', vram: 0, bw: 273, vendor: 'apple', unified: true },
  { re: /m4/i, name: 'Apple M4', vram: 0, bw: 120, vendor: 'apple', unified: true },
  { re: /m3\s*ultra/i, name: 'Apple M3 Ultra', vram: 0, bw: 800, vendor: 'apple', unified: true },
  { re: /m3\s*max/i, name: 'Apple M3 Max', vram: 0, bw: 400, vendor: 'apple', unified: true },
  { re: /m3\s*pro/i, name: 'Apple M3 Pro', vram: 0, bw: 150, vendor: 'apple', unified: true },
  { re: /m3/i, name: 'Apple M3', vram: 0, bw: 100, vendor: 'apple', unified: true },
  { re: /m2\s*ultra/i, name: 'Apple M2 Ultra', vram: 0, bw: 800, vendor: 'apple', unified: true },
  { re: /m2\s*max/i, name: 'Apple M2 Max', vram: 0, bw: 400, vendor: 'apple', unified: true },
  { re: /m2\s*pro/i, name: 'Apple M2 Pro', vram: 0, bw: 200, vendor: 'apple', unified: true },
  { re: /m2/i, name: 'Apple M2', vram: 0, bw: 100, vendor: 'apple', unified: true },
  { re: /m1\s*ultra/i, name: 'Apple M1 Ultra', vram: 0, bw: 800, vendor: 'apple', unified: true },
  { re: /m1\s*max/i, name: 'Apple M1 Max', vram: 0, bw: 400, vendor: 'apple', unified: true },
  { re: /m1\s*pro/i, name: 'Apple M1 Pro', vram: 0, bw: 200, vendor: 'apple', unified: true },
  { re: /m1/i, name: 'Apple M1', vram: 0, bw: 68, vendor: 'apple', unified: true },
]

/**
 * 核显：共用系统内存，没有独立带宽优势
 *
 * 名字放进词条表，但这里只存 key：模块加载时还不一定知道界面语言（app.mjs 在
 * import 之后才读页面 lang），必须在 matchGpu() 调用时再取。正则匹配的是浏览器
 * 给的渲染器字符串，跟这些 label 无关，改文案不会影响识别。
 */
const INTEGRATED = [
  { re: /arc\s*(?:\(tm\)\s*)?(?:a|b)?\d{3}/i, nameKey: 'hw.igpu.arc', vendor: 'intel', integrated: true },
  { re: /iris\s*xe|uhd\s*graphics|hd\s*graphics/i, nameKey: 'hw.igpu.intel', vendor: 'intel', integrated: true },
  { re: /radeon\s*(?:\(tm\)\s*)?\d{3}m|vega\s*\d+/i, nameKey: 'hw.igpu.amd', vendor: 'amd', integrated: true },
]

/** 这些渲染器名说明拿到的是软件/远程桌面后端，不是真显卡 */
const BOGUS = /swiftshader|llvmpipe|basic render|microsoft basic|remote|parsec|virtual|mesa offscreen|angle \(google/i

/** 是不是软件渲染（没有真显卡，常见于远程桌面、无头服务器、虚拟机） */
export function isSoftwareRenderer(renderer) {
  return !renderer || BOGUS.test(renderer)
}

export const VENDOR_LABEL = {
  nvidia: 'NVIDIA',
  amd: 'AMD',
  apple: 'Apple',
  intel: 'Intel',
  // 只有这一项要翻。用 getter 而不是普通字段：模块加载时界面语言可能还没设定。
  get other() { return tx('hw.other') }
}

/** 从 WebGL 的渲染器字符串里认出型号。认不出返回 null。 */
export function matchGpu(renderer) {
  const s = String(renderer ?? '')
  if (!s || BOGUS.test(s)) return null
  for (const g of GPU_TABLE) if (g.re.test(s)) return { ...g, kind: g.unified ? 'unified' : 'discrete' }
  for (const g of INTEGRATED) {
    if (!g.re.test(s)) continue
    // 名字按当前界面语言取，不能把 key 泄到下拉框和报告里
    const { nameKey, ...rest } = g
    return { ...rest, name: tx(nameKey), vram: 0, bw: 0, kind: 'integrated' }
  }
  return null
}

/** 读浏览器的 GPU 型号字符串。拿不到返回空串。 */
export function detectRenderer() {
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl')
    if (!gl) return ''
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const s = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    // 用完就把上下文丢掉，有的浏览器同时存在的 WebGL 上下文有限
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return String(s ?? '')
  } catch {
    return ''
  }
}

/**
 * 粗略猜操作系统。只用来决定显存上限该套哪套规则：
 * Windows 的 WDDM 允许超卖，Linux 不允许，macOS 是统一内存。
 */
export function detectOS() {
  const nav = globalThis.navigator
  const p = String(nav?.userAgentData?.platform || nav?.platform || '')
  const ua = String(nav?.userAgent || '')
  if (/win/i.test(p) || /windows/i.test(ua)) return 'win32'
  if (/mac/i.test(p) || /mac os/i.test(ua)) return 'darwin'
  if (/linux|android/i.test(p) || /linux/i.test(ua)) return 'linux'
  return ''
}

/** 内存带宽粗估：部分 offload 和纯 CPU 推理都吃这条 */
const RAM_BW = 60

/**
 * 组装 core.assess 需要的硬件对象。
 *
 * @param entry  matchGpu 的结果，或下拉框选中项
 * @param opts.vramGB    覆盖显存容量（GB）；Apple / 核显必填
 * @param opts.usedGB    已占用显存。浏览器读不到，默认按 0.8 GB 估
 * @param opts.ramGB     系统内存，用于 CPU 兜底和 offload 速度
 */
export function buildHardware(entry, opts = {}) {
  const os = detectOS()
  const vramGB = Number(opts.vramGB) > 0 ? Number(opts.vramGB) : (entry?.vram || 0)
  const usedGB = Number(opts.usedGB) >= 0 ? Number(opts.usedGB) : 0.8
  const ramGB = Number(opts.ramGB) > 0 ? Number(opts.ramGB) : 16

  if (!entry || !vramGB) {
    // 认不出卡或用户没填容量：退化成 CPU 推理，按内存估
    return {
      gpus: [],
      ramBytes: ramGB * 1024 ** 3,
      ramBandwidthGBps: RAM_BW,
      osPlatform: os,
      cpuOnly: true
    }
  }

  const unified = Boolean(entry.unified)
  return {
    gpus: [{
      name: entry.name,
      totalBytes: vramGB * 1024 ** 3,
      // Apple 统一内存没有"已用显存"这个概念，整机占用交给 maxWorkingSet 处理
      usedBytes: unified ? 0 : usedGB * 1024 ** 3,
      bandwidthGBps: entry.bw || 0,
      unified,
      kind: entry.kind ?? (unified ? 'unified' : 'discrete'),
      source: 'web-table'
    }],
    ramBytes: ramGB * 1024 ** 3,
    ramBandwidthGBps: RAM_BW,
    osPlatform: os,
    cpuOnly: false
  }
}

/** 下拉框用的分组清单 */
export function gpuOptions() {
  const groups = new Map()
  for (const g of GPU_TABLE) {
    if (!groups.has(g.vendor)) groups.set(g.vendor, [])
    groups.get(g.vendor).push(g)
  }
  return [...groups.entries()].map(([vendor, items]) => ({
    vendor,
    label: VENDOR_LABEL[vendor] ?? vendor,
    items: items.map((g) => ({
      name: g.name,
      vram: g.vram,
      bw: g.bw,
      unified: Boolean(g.unified),
      vendor
    }))
  }))
}

/** 常见统一内存档位（Apple Silicon）与核显共享内存 */
export const UNIFIED_SIZES = [8, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 256, 512]
