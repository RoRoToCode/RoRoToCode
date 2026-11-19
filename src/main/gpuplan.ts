import { spawnSync } from 'node:child_process'
import {
  archTag,
  isMac,
  isWin,
  knownCudaVersions,
  llamaAssetName,
  nvidiaSmiPaths,
  supportsCuda
} from './platform'

/**
 * 该往本机装哪个 llama.cpp 包 —— 显卡版优先。
 *
 * 之前的判定只有一句 `nvidia-smi -L` 能不能跑通。这在真实机器上翻车过：
 * 打包后的程序从资源管理器启动，PATH 里不一定有 nvidia-smi；
 * 笔记本双显卡 / 驱动装在非默认目录时也会漏判。一旦判成「没有 N 卡」，
 * 安装流程就默默下 `-bin-win-cpu-x64.zip`，用户装完才发现显存一动不动，
 * 只能手动重装一次。
 *
 * 所以这里分三层探，逐层放宽：
 *  1. nvidia-smi（PATH + 常见绝对路径）—— 拿名字、驱动版本、CUDA 版本、算力、显存
 *  2. 系统显卡名（Windows WMI / macOS system_profiler / Linux lspci）
 *  3. 都没有 → 才落到 CPU 包
 *
 * 平台差异：
 *  - macOS 没有 CUDA 也没有 Vulkan，官方只有一种 macos 包（Metal 编进包内），
 *    所以直接返回 `metal`，不去探 nvidia-smi。
 *  - Linux 的官方产物叫 `-bin-ubuntu-*`，扩展名是 `.tar.gz`。
 *
 * 另外留一个 `ROROTO_LLAMA_BACKEND=cuda|vulkan|cpu` 环境变量：自动判定
 * 终究是猜，用户想钉死某个后端时要有出口。
 */

export type GpuPreference = 'cuda' | 'vulkan' | 'metal' | 'cpu'

/**
 * 虚拟 / 远程 / 基础显示适配器。
 *
 * 这些不是真显卡：Parsec、向日葵、ToDesk 的虚拟显示器、Hyper-V 的「Microsoft Basic
 * Display Adapter」、RDP 的「Remote Display Adapter」都会出现在系统显卡列表里。
 * 旧代码只把它们当名字看，于是「只有虚拟显卡的机器」被判成有卡 → 装 Vulkan 包 →
 * 启动后 `--list-devices` 空 → 白忙一场。
 */
export const VIRTUAL_GPU_RE =
  /idd|indirect display|basic display|basic render|virtual|mirror|parsec|sunlogin|todesk|oray|remote display|remote desktop|hyper-v|vmware|virtualbox|citrix|displaylink|llvmpipe|swiftshader|softpipe/i

export function isVirtualGpu(name: string): boolean {
  return VIRTUAL_GPU_RE.test(name ?? '')
}

export interface GpuProbe {
  preference: GpuPreference
  /** 判定依据，直接写进安装日志给用户看 */
  reason: string
  /** NVIDIA 驱动版本，如 552.44（仅 CUDA 路径有） */
  driver?: string
  /** nvidia-smi 报的「驱动支持的最高 CUDA 版本」，如 12.4 */
  cudaVersion?: string | null
  /** 主卡 compute capability（2080=7.5，4060=8.9，RTX 50=12.0） */
  computeCap?: number | null
  /** 需要提前告知用户的问题（驱动过旧、包与卡不匹配等） */
  warnings?: string[]
}

export interface ReleaseAsset {
  name: string
  browser_download_url: string
}

export interface InstallPlan {
  main: ReleaseAsset
  /** cudart 运行库是独立包，必须和主包解压到同一目录 */
  extras: ReleaseAsset[]
}

/** 选包时要考虑的本机信息（驱动支持的 CUDA 版本、主卡算力） */
export interface PackageHints {
  /** 驱动支持的最高 CUDA 版本，编码为 1204（= 12.4）；未知为 null */
  cudaCode?: number | null
  /** 主卡算力：≥ 12 是 Blackwell（RTX 50 / sm_120），旧 CUDA 运行时没有它的设备代码 */
  computeCap?: number | null
}

/* ------------------------------------------------------------------ *
 * 判定
 * ------------------------------------------------------------------ */

/** 单个 NVIDIA 卡的探测结果 */
export interface NvidiaGpu {
  name: string
  driver: string
  /** 算力；老驱动不认 compute_cap 这个字段时为 null */
  computeCap: number | null
  vramMB: number | null
}

export interface NvidiaInfo {
  gpus: NvidiaGpu[]
  /** 驱动支持的最高 CUDA 版本，如 "12.4" */
  cudaVersion: string | null
}

/**
 * 一次问全：名字、驱动、算力、显存，再从表头取 CUDA 版本。
 *
 * 为什么要读 CUDA 版本：官方 CUDA 包是按运行时版本分的（12.4 / 12.8 / 13.5）。
 * 旧代码把 12.4 写死排第一，于是 RTX 50（sm_120）装上也跑不起来 ——
 * 1204 的运行时里没有 sm_120 的设备代码，只能退回 CPU，用户完全看不出原因。
 *
 * 老驱动可能不认 `compute_cap` 字段，整条查询会失败，所以降级查一次不带算力的。
 */
let nvidiaCache: NvidiaInfo | null = null

export function nvidiaGpuInfo(refresh = false): NvidiaInfo {
  if (!refresh && nvidiaCache) return nvidiaCache
  const empty: NvidiaInfo = { gpus: [], cudaVersion: null }
  if (!supportsCuda()) {
    nvidiaCache = empty
    return empty
  }
  for (const bin of nvidiaSmiPaths()) {
    for (const fields of ['name,driver_version,compute_cap,memory.total', 'name,driver_version,memory.total']) {
      try {
        const r = spawnSync(bin, [`--query-gpu=${fields}`, '--format=csv,noheader,nounits'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 6000
        })
        if (r.status !== 0) continue
        const lines = `${r.stdout ?? ''}`.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        if (!lines.length) continue
        const hasCc = fields.includes('compute_cap')
        const gpus: NvidiaGpu[] = []
        for (const line of lines) {
          const cols = line.split(',').map((s) => s.trim())
          const [name, driver, a, b] = cols
          if (!name) continue
          const cc = hasCc ? Number(a) : NaN
          const vram = Number(hasCc ? b : a)
          gpus.push({
            name,
            driver: driver || 'unknown',
            computeCap: Number.isFinite(cc) && cc > 0 ? cc : null,
            vramMB: Number.isFinite(vram) && vram > 0 ? vram : null
          })
        }
        if (!gpus.length) continue
        nvidiaCache = { gpus, cudaVersion: parseCudaVersion(bin) }
        return nvidiaCache
      } catch {
        // 这个路径 / 这组字段不行，换下一个
      }
    }
  }
  nvidiaCache = empty
  return empty
}

/** nvidia-smi 表头里的 `CUDA Version: 12.4` */
function parseCudaVersion(bin: string): string | null {
  try {
    const r = spawnSync(bin, [], { encoding: 'utf8', windowsHide: true, timeout: 6000 })
    if (r.status !== 0) return null
    const m = /CUDA Version:\s*([\d.]+)/i.exec(`${r.stdout ?? ''}`)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** "12.4" → 1204。用于比较包版本与驱动支持的版本 */
export function cudaCodeOf(ver: string | null | undefined): number | null {
  const m = /(\d+)\.(\d+)/.exec(String(ver ?? ''))
  if (!m) return null
  return Number(m[1]) * 100 + Number(m[2])
}

/** 所有平台产物名里取 CUDA 版本：`...-bin-win-cuda-12.4-x64.zip` → "12.4" */
function cudaVersionOf(name: string): string | null {
  const m = /-bin-(?:win|ubuntu|linux|macos)-cuda-([\d.]+)-/i.exec(name)
  return m ? m[1] : null
}

/** 从 llama.cpp 产物名里取 CUDA 版本：`...-bin-win-cuda-12.4-x64.zip` → 1204 */
export function packageCudaCode(name: string): number | null {
  return cudaCodeOf(cudaVersionOf(name))
}

/** cudart 包名里的 CUDA 版本（Windows 不含 tag，Linux 含 tag） */
function cudartCudaVersion(name: string): string | null {
  const m = /^cudart-llama-(?:b\d+-)?bin-(?:win|ubuntu|linux)-cuda-([\d.]+)-/i.exec(name)
  return m ? m[1] : null
}

/** 跑 nvidia-smi -L，拿到显卡名；拿不到返回空串 */
export function nvidiaSmiList(): string {
  for (const bin of nvidiaSmiPaths()) {
    try {
      const r = spawnSync(bin, ['-L'], { windowsHide: true, timeout: 5000, encoding: 'utf8' })
      if (r.status !== 0) continue
      const out = `${r.stdout ?? ''}`
      if (/GPU\s+\d+/i.test(out)) return out.trim()
    } catch {
      // 这个路径没有，试下一个
    }
  }
  return ''
}

/** Windows：WMI 优先，老系统退回 wmic */
function windowsVideoControllers(): string[] {
  const queries: Array<[string, string[]]> = [
    [
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name'
      ]
    ],
    ['wmic', ['path', 'win32_VideoController', 'get', 'name']]
  ]
  for (const [bin, args] of queries) {
    try {
      const r = spawnSync(bin, args, { windowsHide: true, timeout: 8000, encoding: 'utf8' })
      if (r.status !== 0) continue
      const names = `${r.stdout ?? ''}`
        .split(/\r?\n/)
        .map((s) => s.trim())
        // wmic 会输出表头 Name
        .filter((s) => s && !/^name$/i.test(s))
      const real = names.filter((n) => !isVirtualGpu(n))
      // 只剩虚拟卡时返回空数组：那等于「没有可用显卡」，而不是「有卡」
      if (real.length) return real
      if (names.length) return []
    } catch {
      // 继续下一个查询方式
    }
  }
  return []
}

/** macOS：system_profiler 的显卡型号 */
function macGpuNames(): string[] {
  try {
    const r = spawnSync('system_profiler', ['SPDisplaysDataType', '-json'], {
      encoding: 'utf8',
      timeout: 20000
    })
    if (r.status === 0 && r.stdout) {
      const j = JSON.parse(r.stdout) as {
        SPDisplaysDataType?: Array<Record<string, string>>
      }
      const names = (j.SPDisplaysDataType ?? [])
        .map((d) => d.sppci_model || d._name || '')
        .filter(Boolean)
      if (names.length) return names.filter((n) => !isVirtualGpu(n))
    }
  } catch {
    // 退回文本解析
  }
  try {
    const r = spawnSync('system_profiler', ['SPDisplaysDataType'], {
      encoding: 'utf8',
      timeout: 20000
    })
    const names: string[] = []
    for (const line of `${r.stdout ?? ''}`.split(/\r?\n/)) {
      const m = /Chipset Model:\s*(.+)$/i.exec(line)
      if (m) names.push(m[1].trim())
    }
    return names.filter((n) => !isVirtualGpu(n))
  } catch {
    return []
  }
}

/** Linux：lspci 的显卡条目（NVIDIA / AMD / Intel 都能认出来） */
function linuxGpuNames(): string[] {
  try {
    const r = spawnSync('lspci', [], { encoding: 'utf8', timeout: 8000 })
    if (r.status !== 0 || !r.stdout) return []
    const names: string[] = []
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /(VGA compatible controller|3D controller|Display controller):\s*(.+)$/i.exec(line)
      if (m) names.push(m[2].replace(/\s*\(rev [^)]*\)\s*$/i, '').trim())
    }
    return names.filter((n) => !isVirtualGpu(n))
  } catch {
    return []
  }
}

/** 显卡名清单（按平台选择探测方式），虚拟显卡在这里就滤掉 */
export function videoControllerNames(): string[] {
  if (isWin) return windowsVideoControllers()
  if (isMac) return macGpuNames()
  return linuxGpuNames()
}

/**
 * 按显卡名判后端。
 *
 * 独立成纯函数：真实探测要 spawn 子进程，测试里没法造机器，
 * 但「这台机器叫什么显卡 → 该装哪个包」这条规则必须能单测。
 */
export function preferFromNames(names: string[]): GpuProbe {
  const real = names.filter((n) => !isVirtualGpu(n))
  const nv = real.find((n) => /nvidia|geforce|quadro|tesla|rtx|gtx/i.test(n))
  if (nv) return { preference: 'cuda', reason: `检测到 NVIDIA 显卡：${nv}` }
  // 非 N 卡走 Vulkan：AMD / Intel 核显都是这条路，比 CPU 包快一个数量级
  const other = real.find((n) => /amd|radeon|intel|arc|iris|uhd|vega|apple m\d/i.test(n))
  if (other) return { preference: 'vulkan', reason: `检测到显卡：${other}（装 Vulkan 版）` }
  return { preference: 'cpu', reason: '没检测到可用显卡，装 CPU 版' }
}

let cached: GpuProbe | null = null

export interface DetectOptions {
  /** 忽略缓存重新探测 */
  refresh?: boolean
  /** 外部强制指定（测试 / 用户显式选择） */
  force?: GpuPreference | null
}

/** 驱动低于这个 CUDA 版本就没法跑官方 CUDA 12 构建，提前告知比装完再查强 */
const MIN_CUDA_FOR_CUDA_BUILD = 1108

/** 本机该装哪个后端。结果缓存：一次安装里会问好几遍，别反复 spawn */
export function detectGpuPreference(opts: DetectOptions = {}): GpuProbe {
  if (!opts.refresh && cached) return cached

  // macOS：官方只有一种包，Metal 编在包内，没有独立后端可选
  if (isMac) {
    cached = {
      preference: 'metal',
      reason: 'macOS 使用系统内置 Metal（官方 macos 包已包含，无需单独显卡后端）'
    }
    return cached
  }

  const forced =
    opts.force ??
    (() => {
      const env = (process.env.ROROTO_LLAMA_BACKEND ?? '').trim().toLowerCase()
      return env === 'cuda' || env === 'vulkan' || env === 'cpu' ? (env as GpuPreference) : null
    })()
  if (forced) return { preference: forced, reason: `按指定强制使用 ${forced.toUpperCase()} 版` }

  /**
   * 先问 nvidia-smi 要结构化信息：名字 + 驱动 + 算力 + CUDA 版本。
   * 光靠 `-L` 只能拿到名字，装哪个 CUDA 版本、驱动够不够新全靠猜。
   */
  const info = nvidiaGpuInfo(opts.refresh)
  const real = info.gpus.filter((g) => !isVirtualGpu(g.name))
  if (real.length) {
    const g = real[0]
    const warnings: string[] = []
    const cudaCode = cudaCodeOf(info.cudaVersion)
    if (cudaCode !== null && cudaCode < MIN_CUDA_FOR_CUDA_BUILD) {
      warnings.push(
        `NVIDIA 驱动 ${g.driver} 只支持到 CUDA ${info.cudaVersion}，官方 CUDA 构建加载不了：` +
          '本次会装 Vulkan 版（比 CPU 快一个数量级，比 CUDA 略慢）；想用满速请更新显卡驱动'
      )
    }
    if (g.computeCap !== null && g.computeCap >= 12 && cudaCode !== null && cudaCode < 1208) {
      warnings.push(
        `这张卡是 Blackwell（算力 ${g.computeCap}，RTX 50 系 / sm_120），而驱动只支持到 CUDA ${info.cudaVersion}：` +
          '需要 CUDA 12.8 以上的运行时才能用上显卡，请更新驱动'
      )
    }
    const bits = [`检测到 NVIDIA 显卡：${g.name}`]
    if (g.driver !== 'unknown') bits.push(`驱动 ${g.driver}`)
    if (info.cudaVersion) bits.push(`CUDA ${info.cudaVersion}`)
    cached = {
      preference: 'cuda',
      reason: bits.join('，'),
      driver: g.driver,
      cudaVersion: info.cudaVersion,
      computeCap: g.computeCap,
      warnings: warnings.length ? warnings : undefined
    }
    return cached
  }

  // 老驱动 / 非 Windows 上 `--query-gpu` 可能整条失败：退回 `-L` 只认名字
  const smi = nvidiaSmiList()
  if (smi) {
    const name = /GPU\s+\d+:\s*(.+?)(?:\s*\(|$)/im.exec(smi)?.[1]?.trim() || 'NVIDIA GPU'
    cached = { preference: 'cuda', reason: `检测到 NVIDIA 显卡：${name}` }
    return cached
  }
  cached = preferFromNames(videoControllerNames())
  return cached
}

/** 探测结果 → 选包提示（装包和镜像兜底都要用同一份） */
export function hintsOf(probe: GpuProbe): PackageHints {
  return {
    cudaCode: cudaCodeOf(probe.cudaVersion),
    computeCap: probe.computeCap ?? null
  }
}

/* ------------------------------------------------------------------ *
 * 选包
 * ------------------------------------------------------------------ */

/** 只有 `llama-*` 开头的是主程序包（cudart 包名也以 -bin-…-cuda-… 结尾，必须排掉） */
export function isMainPackage(name: string): boolean {
  return /^llama-[^/]+-bin-(?:win|ubuntu|linux|macos)-/i.test(name) && !/^cudart-/i.test(name)
}

/**
 * 给一个 CUDA 包打分，选最高的。
 *
 * 三条规则叠在一起：
 * 1. 驱动装不了的版本排到最后（`cudaCode > 驱动支持` 就扣 10000）。这是硬约束：
 *    运行时比驱动新，动态库直接加载失败，装完等于白装。
 * 2. Blackwell（算力 ≥ 12）必须 CUDA 12.8+：sm_120 的设备代码只在 12.8 之后才有；
 *    驱动又够新时，版本越高越好。
 * 3. 驱动版本未知时保守回到 12.x：13.x 要求的驱动更高，未知就当它不够。
 */
function rankCuda(code: number, hints: PackageHints): number {
  const supported = Number(hints.cudaCode)
  const hasSupported = Number.isFinite(supported) && supported > 0
  const allowed = !hasSupported || code <= supported
  const needNew = (Number(hints.computeCap) || 0) >= 12
  let score = code
  if (!allowed) score -= 10000
  if (!needNew && !hasSupported && code >= 1300) score -= 500
  if (needNew && allowed && code < 1208) score -= 3000
  return score
}

/** 官方产物里出现过的 CUDA 运行时版本（镜像兜底时按这个顺序试；保持 Windows 行为不变） */
const KNOWN_CUDA_VERSIONS = ['12.4', '13.4']

/**
 * 按本机情况排好序的 CUDA 版本（越靠前越该用）。
 * 驱动装不了的版本直接剔掉：留在这里只会让镜像兜底白探一遍、
 * 让 `planFromAssets` 得出一个必然加载失败的结论。
 */
export function orderedCudaVersions(
  hints: PackageHints = {},
  versions: string[] = KNOWN_CUDA_VERSIONS
): string[] {
  return [...versions]
    .filter((v) => {
      const code = cudaCodeOf(v)
      return code !== null && rankCuda(code, hints) > 0
    })
    .sort((a, b) => {
      const ca = cudaCodeOf(a) ?? 0
      const cb = cudaCodeOf(b) ?? 0
      return rankCuda(cb, hints) - rankCuda(ca, hints)
    })
}

/** 各后端的候选顺序（按平台 + 架构生成，先精确、再降级，最后是能跑的兜底） */
function ordersFor(prefer: GpuPreference): RegExp[] {
  const a = archTag()
  if (isMac) {
    return [
      new RegExp(`-bin-macos-${a}\\.tar\\.gz$`, 'i'),
      /-bin-macos-(x64|arm64)\.tar\.gz$/i
    ]
  }
  const osTag = isWin ? 'win' : 'ubuntu'
  const ext = isWin ? 'zip' : 'tar\\.gz'
  const cuda12 = new RegExp(`-bin-${osTag}-cuda-12\\.\\d+-${a}\\.${ext}$`, 'i')
  const cudaAny = new RegExp(`-bin-${osTag}-cuda-[^/]+-${a}\\.${ext}$`, 'i')
  const vulkan = new RegExp(`-bin-${osTag}-vulkan-${a}\\.${ext}$`, 'i')
  const cpu = isWin
    ? new RegExp(`-bin-win-cpu-${a}\\.zip$`, 'i')
    : new RegExp(`-bin-ubuntu-${a}\\.tar\\.gz$`, 'i')

  if (prefer === 'cuda') return [cuda12, cudaAny, vulkan, cpu]
  if (prefer === 'vulkan') return [vulkan, cpu]
  return [cpu, vulkan]
}

/** 按优先级挑一个主包 + 版本匹配的 cudart */
export function planFromAssets(
  assets: ReleaseAsset[],
  prefer: GpuPreference,
  hints: PackageHints = {}
): InstallPlan | null {
  const pool = assets.filter((a) => isMainPackage(a.name))

  // macOS：只有一种包，不存在后端选择
  if (isMac) {
    const main =
      pool.find((a) => new RegExp(`-bin-macos-${archTag()}\\.tar\\.gz$`, 'i').test(a.name)) ??
      pool.find((a) => /-bin-macos-(x64|arm64)\.tar\.gz$/i.test(a.name))
    return main ? { main, extras: [] } : null
  }

  let main: ReleaseAsset | undefined
  if (prefer === 'cuda') {
    // 先把所有 CUDA 包按本机情况排序，取第一个装得上的
    const cudas = pool
      .map((a) => ({ a, code: packageCudaCode(a.name) }))
      .filter((x): x is { a: ReleaseAsset; code: number } => x.code !== null)
      .sort((x, y) => rankCuda(y.code, hints) - rankCuda(x.code, hints))
    /**
     * 分数为负 = 没有任何一个 CUDA 包能被这个驱动加载（运行时比驱动新，动态库直接失败）。
     * 这时硬装 CUDA 等于让用户白下载几百 MB 再看到「显存一动不动」，
     * 不如落到 Vulkan 兜底：比 CPU 快一个数量级，只是比 CUDA 略慢。
     */
    if (cudas.length && rankCuda(cudas[0].code, hints) > 0) {
      main = cudas[0].a
    } else {
      const vulkan = new RegExp(`-bin-${isWin ? 'win' : 'ubuntu'}-vulkan-${archTag()}\\.${isWin ? 'zip' : 'tar\\.gz'}$`, 'i')
      const cpu = isWin
        ? new RegExp(`-bin-win-cpu-${archTag()}\\.zip$`, 'i')
        : new RegExp(`-bin-ubuntu-${archTag()}\\.tar\\.gz$`, 'i')
      main = pool.find((a) => vulkan.test(a.name)) ?? pool.find((a) => cpu.test(a.name))
    }
  }
  if (!main && prefer !== 'cuda') {
    for (const re of ordersFor(prefer)) {
      main = pool.find((a) => re.test(a.name))
      if (main) break
    }
  }
  if (!main) return null

  const extras: ReleaseAsset[] = []
  const cudaVer = cudaVersionOf(main.name)
  if (cudaVer && supportsCuda()) {
    const cudart = assets.find((a) => cudartCudaVersion(a.name) === cudaVer)
    if (cudart) extras.push(cudart)
  }
  return { main, extras }
}

/** 镜像兜底路径要拼的候选文件名（按优先级） */
export function candidateNames(tag: string, prefer: GpuPreference, hints: PackageHints = {}): string[] {
  // macOS：按本机架构优先，另一种架构兜底（Intel / Apple Silicon 都可能）
  if (isMac) {
    const self = archTag()
    const other = self === 'arm64' ? 'x64' : 'arm64'
    return [
      llamaAssetName(tag, 'metal', { arch: self }),
      llamaAssetName(tag, 'metal', { arch: other })
    ]
  }
  if (prefer === 'cuda') {
    // Windows 保持历史上的 12.4/13.4 兜底；Linux 用官方 ubuntu 产物里的 12.8/13.5
    const versions = isWin ? undefined : knownCudaVersions()
    return [
      ...orderedCudaVersions(hints, versions).map((v) => llamaAssetName(tag, 'cuda', { cudaVer: v })),
      llamaAssetName(tag, 'vulkan'),
      llamaAssetName(tag, 'cpu')
    ]
  }
  if (prefer === 'vulkan') {
    return [llamaAssetName(tag, 'vulkan'), llamaAssetName(tag, 'cpu')]
  }
  return [llamaAssetName(tag, 'cpu'), llamaAssetName(tag, 'vulkan')]
}
