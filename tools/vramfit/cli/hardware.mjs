/**
 * 本机硬件探测（Node 专属）。
 *
 * 网页端拿不到这些信息：浏览器沙箱不给显存容量，nvidia-smi / rocm-smi / sysctl 也都调不了。
 * 所以这一整个文件只在 CLI 里用，网页端走 ../../site/src/web/gpu.mjs 的型号查表。
 *
 * 三个平台的取法完全不同，原因写在对应函数上，别为了「统一」把它们合并。
 */

import { promises as fs, openSync, readSync, closeSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { GB } from '../core/index.mjs'

// ───────────────────────────── 硬件探测 ─────────────────────────────

const VIRTUAL_GPU = /idd|indirect display|basic display|virtual|mirror|parsec|sunlogin|todesk|oray|remote/i

/**
 * 显存带宽表（GB/s）。生成速度的瓶颈就在这里：每吐一个 token 要把全部权重从显存读一遍。
 * nvidia-smi 拿不到 bus width，所以只能内置规格。匹配不到就不给速度，而不是瞎猜。
 *
 * 数据来源：NVIDIA / AMD / Apple 各自产品页公布的内存规格
 * （位宽 × 等效速率 ÷ 8，统一内存取 SoC 的 LPDDR 带宽），2026-10 核对过一遍。
 * 这些是公开的产品参数，不是别人的劳动成果；数值有出入时以厂商页面为准，改这里就行。
 * 顺序敏感 —— 长后缀型号必须排在短型号前面（`5070 Ti` 先于 `5070`，差 224 GB/s）。
 */
const GPU_BANDWIDTH = [
  // RTX 50
  [/rtx\s*5090/i, 1792], [/rtx\s*5080/i, 960], [/rtx\s*5070\s*ti/i, 896],
  [/rtx\s*5070/i, 672], [/rtx\s*5060\s*ti/i, 448], [/rtx\s*5060/i, 448],
  // RTX 40
  [/rtx\s*4090/i, 1008], [/rtx\s*4080\s*super/i, 736], [/rtx\s*4080/i, 717],
  [/rtx\s*4070\s*ti\s*super/i, 672], [/rtx\s*4070\s*ti/i, 504],
  [/rtx\s*4070\s*super/i, 504], [/rtx\s*4070/i, 504],
  [/rtx\s*4060\s*ti/i, 288], [/rtx\s*4060/i, 272],
  // RTX 30
  [/rtx\s*3090\s*ti/i, 1008], [/rtx\s*3090/i, 936], [/rtx\s*3080\s*ti/i, 912],
  [/rtx\s*3080/i, 760], [/rtx\s*3070\s*ti/i, 608], [/rtx\s*3070/i, 448],
  [/rtx\s*3060\s*ti/i, 448], [/rtx\s*3060/i, 360], [/rtx\s*3050/i, 224],
  // RTX 20
  [/rtx\s*2080\s*ti/i, 616], [/rtx\s*2080\s*super/i, 496], [/rtx\s*2080/i, 448],
  [/rtx\s*2070\s*super/i, 448], [/rtx\s*2070/i, 448],
  [/rtx\s*2060\s*super/i, 448], [/rtx\s*2060/i, 336],
  // 专业卡 / 数据中心
  [/h200/i, 4800], [/h100/i, 3350], [/a100\s*80/i, 2039], [/a100/i, 1555],
  [/l40s/i, 864], [/l40/i, 864], [/a6000/i, 768], [/a5000/i, 768],
  [/4090\s*d/i, 1008], [/rtx\s*6000\s*ada/i, 960],
  // AMD（rocm-smi / sysfs 读出的型号对得上这些名字）
  [/9070\s*xt/i, 645], [/9070\s*gre/i, 576], [/9070/i, 576], [/9060\s*xt/i, 322],
  [/7900\s*xtx/i, 960], [/7900\s*xt/i, 800], [/7900\s*gre/i, 576],
  [/7800\s*xt/i, 624], [/7700\s*xt/i, 432], [/7600/i, 288],
  [/6950\s*xt/i, 576], [/6900\s*xt/i, 512], [/6800\s*xt/i, 512], [/6800/i, 512],
  [/6750\s*xt/i, 432], [/6700\s*xt/i, 384], [/6600\s*xt/i, 224], [/6600/i, 224],
  [/5700\s*xt/i, 448], [/vega\s*64/i, 484],
  // Apple Silicon（统一内存，带宽即系统内存带宽）
  [/m4\s*max/i, 546], [/m4\s*pro/i, 273], [/m4/i, 120],
  [/m3\s*ultra/i, 800], [/m3\s*max/i, 400], [/m3\s*pro/i, 150], [/m3/i, 100],
  [/m2\s*ultra/i, 800], [/m2\s*max/i, 400], [/m2\s*pro/i, 200], [/m2/i, 100],
  [/m1\s*ultra/i, 800], [/m1\s*max/i, 400], [/m1\s*pro/i, 200], [/m1/i, 68],
]

function gpuBandwidth(name) {
  for (const [re, bw] of GPU_BANDWIDTH) if (re.test(name)) return bw
  return null
}

/**
 * 系统内存带宽粗估：部分 offload 时速度由这里决定，会慢 5–10 倍。
 *
 * 以前固定 60 GB/s，误差能到 ±50%：DDR4-3200 双通道实际约 51，DDR5-5600 约 90。
 * 对「部分层留在内存」的模型，这直接决定 tok/s 估算是 3 还是 6。
 * 现在按已装内存条的规格自己算：每条 DIMM 视为一个 64-bit 通道，
 * 带宽 ≈ Σ(速率 MHz × 8 B) —— 2×5600 正好 89.6，2×3200 是 51.2，和实测对得上。
 */
let ramBandwidthCache

function ramBandwidth() {
  if (ramBandwidthCache !== undefined) return ramBandwidthCache
  ramBandwidthCache = detectRamBandwidth() ?? 60 // 读不到就按 DDR4 双通道的中间值
  return ramBandwidthCache
}

function detectRamBandwidth() {
  if (process.platform !== 'win32') return null
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_PhysicalMemory |
  Select-Object @{n='cap';e={$_.Capacity}}, @{n='speed';e={$_.ConfiguredClockSpeed}}, @{n='type';e={$_.SMBIOSMemoryType}} |
  ConvertTo-Json -Compress -Depth 3`
  try {
    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    const txt = (r.stdout ?? '').trim()
    if (!txt) return null
    const parsed = JSON.parse(txt)
    const dimms = (Array.isArray(parsed) ? parsed : [parsed]).filter((d) => d && Number(d.speed) > 0)
    if (!dimms.length) return null
    // 每条 DIMM 一条 64-bit 通道：MHz × 8 B/s → GB/s 要再 / 1000
    const gbs = dimms.reduce((sum, d) => sum + (Number(d.speed) * 8) / 1000, 0)
    if (!Number.isFinite(gbs) || gbs < 8) return null
    // 四通道 / 八通道工作站上「每条 DIMM 一条通道」会低估，但那是少数，宁可保守
    return Math.round(gbs)
  } catch {
    return null
  }
}


function queryNvidia() {
  try {
    const r = spawnSync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,memory.used,driver_version', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 }
    )
    if (r.status !== 0 || !r.stdout) return []
    const out = []
    for (const line of r.stdout.split(/\r?\n/)) {
      const [name, total, used, driver] = line.split(',').map((s) => s.trim())
      if (!name || VIRTUAL_GPU.test(name)) continue
      const mib = Number(total)
      if (!Number.isFinite(mib) || mib <= 0) continue
      out.push({
        name,
        totalBytes: Math.round(mib * 1024 * 1024),
        usedBytes: Number.isFinite(Number(used)) ? Math.round(Number(used) * 1024 * 1024) : 0,
        driver: driver || undefined,
        backend: /nvidia|geforce|quadro|tesla|rtx/i.test(name) ? 'cuda' : 'unknown',
        source: 'nvidia-smi'
      })
    }
    return out
  } catch {
    return []
  }
}

/** 注册表兜底：WMI 的 AdapterRAM 是 32 位，超过 4GB 会被截断，所以读 qwMemorySize */
function queryRegistryGpus() {
  if (process.platform !== 'win32') return []
  const ps = `
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$gpus = @()
Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' |
  Where-Object { $_.PSChildName -match '^\\d{4}$' } |
  ForEach-Object {
    $p = Get-ItemProperty $_.PSPath
    if ($p.DriverDesc) {
      $gpus += [pscustomobject]@{
        name   = $p.DriverDesc
        vram   = [int64]$p.'HardwareInformation.qwMemorySize'
        driver = $p.DriverVersion
      }
    }
  }
$gpus | ConvertTo-Json -Compress -Depth 4`
  try {
    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    const txt = (r.stdout ?? '').trim()
    if (!txt) return []
    const parsed = JSON.parse(txt)
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    return arr
      .filter((g) => g?.name && !VIRTUAL_GPU.test(g.name))
      .map((g) => ({
        name: String(g.name),
        totalBytes: Number(g.vram) > 0 ? Number(g.vram) : 0,
        usedBytes: 0,
        /**
         * 注册表只能读到「容量」，读不到「现在用了多少」。
         * 旧代码把它当 0，于是预算变成 total×0.92 —— 桌面已经占掉 1~2 GB 的 A 卡 / I 卡
         * 上，这个数偏乐观 10~25%，推荐出来的上下文启动就 OOM 或者被 WDDM 换页拖死。
         * 这个标记让 vramCeiling 改用保守系数（见 core/assumptions.mjs）。
         */
        usedUnknown: true,
        driver: g.driver ? String(g.driver) : undefined,
        backend: /nvidia/i.test(g.name) ? 'cuda' : /amd|radeon/i.test(g.name) ? 'vulkan' : 'unknown',
        source: 'registry'
      }))
  } catch {
    return []
  }
}

/**
 * 读一个很小的文件（sysfs 探针），失败返回 null。
 * 不能用 readFileSync：sysfs / procfs 的 st_size 是 0，readFileSync 会直接返回空串。
 * 必须自己 open + read 到固定缓冲。
 */
function readTextFile(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.allocUnsafe(256)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return n > 0 ? buf.toString('utf8', 0, n).trim() : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* ignore */ } }
  }
}

/** 从 PCI 地址问出显卡型号：有型号才能对上带宽表 */
function pciModelName(card) {
  try {
    const uevent = readTextFile(`/sys/class/drm/${card}/device/uevent`)
    const m = /^PCI_SLOT_NAME=(.+)$/m.exec(uevent ?? '')
    if (!m) return null
    const r = spawnSync('lspci', ['-mm', '-s', m[1].trim()], { encoding: 'utf8', timeout: 3000 })
    if (r.status !== 0 || !r.stdout) return null
    // 0000:03:00.0 "VGA compatible controller" "Advanced Micro Devices [AMD/ATI]" "Navi 31 [Radeon RX 7900 XTX]"
    const parts = (r.stdout.match(/"([^"]*)"/g) ?? []).map((s) => s.slice(1, -1))
    return parts[2] || null
  } catch { return null }
}

/**
 * AMD：先试 rocm-smi（能拿到型号，带宽表才对得上），再退到 Linux 的 sysfs。
 * sysfs 这条路不需要装任何东西，只要有 amdgpu 驱动就能读到容量。
 */
function queryRocm() {
  const out = []
  try {
    const r = spawnSync('rocm-smi', ['--showmeminfo', 'vram', '--showproductname', '--json'],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    if (r.status === 0 && r.stdout && r.stdout.trim().startsWith('{')) {
      const j = JSON.parse(r.stdout)
      for (const [k, v] of Object.entries(j)) {
        if (!/^card\d+$/i.test(k) || !v || typeof v !== 'object') continue
        const total = Number(v['VRAM Total Memory (B)'] ?? 0)
        const used = Number(v['VRAM Total Used Memory (B)'] ?? 0)
        if (!Number.isFinite(total) || total <= 0) continue
        const name = String(v['Card series'] ?? v['Card SKU'] ?? v['Card model'] ?? 'AMD GPU').trim()
        out.push({
          name, totalBytes: total,
          usedBytes: Number.isFinite(used) ? Math.max(0, used) : 0,
          backend: 'rocm', kind: 'discrete', source: 'rocm-smi'
        })
      }
    }
  } catch { /* 没装 rocm-smi：走 sysfs */ }

  if (out.length || process.platform !== 'linux') return out

  let cards = []
  try { cards = readdirSync('/sys/class/drm') } catch { return [] }
  for (const card of cards.filter((c) => /^card\d+$/.test(c))) {
    const base = `/sys/class/drm/${card}/device`
    const total = Number(readTextFile(`${base}/mem_info_vram_total`))
    if (!Number.isFinite(total) || total <= 0) continue
    out.push({
      name: readTextFile(`${base}/product_name`) || pciModelName(card) || 'AMD GPU (amdgpu)',
      totalBytes: total,
      usedBytes: Number(readTextFile(`${base}/mem_info_vram_used`)) || 0,
      backend: 'rocm', kind: 'discrete', source: 'sysfs'
    })
  }
  return out
}

/**
 * Apple Silicon：统一内存，没有独立显存。
 * Metal 给的「建议最大可用工作集」在 36 GB 及以下是内存的 2/3，更大是 3/4——
 * 这是系统真正允许 GPU 用的量，按它算才不会给出必然爆内存的结论。
 */
function appleWorkingSet(totalBytes) {
  return Math.floor(totalBytes * (totalBytes <= 36 * GB ? 2 / 3 : 0.75))
}

function queryAppleSilicon() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return []
  try {
    const brand = spawnSync('sysctl', ['-n', 'machdep.cpu.brand_string'],
      { encoding: 'utf8', timeout: 3000 }).stdout?.trim()
    const total = Number(spawnSync('sysctl', ['-n', 'hw.memsize'],
      { encoding: 'utf8', timeout: 3000 }).stdout?.trim())
    if (!brand || !Number.isFinite(total) || total <= 0) return []
    return [{
      name: brand,                 // "Apple M2 Pro"，带宽表按 M 系列匹配
      totalBytes: total,
      usedBytes: 0,
      unified: true,
      maxWorkingSetBytes: appleWorkingSet(total),
      backend: 'metal',
      kind: 'unified',
      source: 'sysctl'
    }]
  } catch { return [] }
}

/**
 * 合并各来源的显卡，并判定「独显 / 核显 / 统一内存」。
 *
 * 核显的注册表显存常常只有 128 MB（那只是专用部分），真正能用的是共享内存。
 * 按 128 MB 算会得出「什么都装不下」，所以核显至少按物理内存的一半计。
 */
function collectGpus(ramBytes) {
  const nv = queryNvidia()
  const rocm = queryRocm()
  const apple = queryAppleSilicon()
  const reg = queryRegistryGpus()

  const norm = (s) => s.toLowerCase()
    .replace(/\(r\)|\(tm\)|nvidia|geforce|amd|radeon|graphics/g, '')
    .replace(/\s+/g, ' ').trim()
  const merged = []
  for (const g of [...nv, ...rocm, ...apple, ...reg]) {
    const key = norm(g.name)
    const hit = merged.find((x) => norm(x.name) === key)
    if (!hit) {
      merged.push({ ...g })
      continue
    }
    // 「占用未知」只在两条来源都读不到时成立：nvidia-smi / rocm-smi 能读到真实占用，
    // 不能被紧随其后的注册表条目（容量更大但 used=0）抹成未知。
    const usedUnknown = Boolean(hit.usedUnknown) && Boolean(g.usedUnknown)
    // 同一张卡从多个来源读到：保留容量更大的那条，已占用取两者较大值
    if (g.totalBytes > hit.totalBytes) {
      Object.assign(hit, g, { usedBytes: Math.max(hit.usedBytes ?? 0, g.usedBytes ?? 0), usedUnknown })
    } else {
      hit.usedBytes = Math.max(hit.usedBytes ?? 0, g.usedBytes ?? 0)
      hit.usedUnknown = usedUnknown
    }
  }

  // 容量读成 0 的条目直接丢掉 —— 留着会让预算上限变成 0，把所有模型都判成装不下，
  // 还不如老实退化成 CPU 估算（按内存算）。
  const gpus = merged.filter((g) => g.totalBytes > 0)
  for (const g of gpus) {
    g.kind ??= /intel|uhd|iris|arc\s*graphics/i.test(g.name) ? 'integrated' : 'discrete'
    if (g.kind === 'integrated') {
      /**
       * 核显没有独立显存，Windows 允许它借用物理内存的一部分（通常上限是内存的一半，
       * 但 BIOS 里可以调小）。旧代码直接取内存的 50% 当显存容量，既不扣系统开销，
       * 也没有「BIOS 只给了 512 MB」这种情形 —— 16 GB 机器上于是报 8 GB「显存」。
       *
       * 这里同时做了两件事：
       * 1. 共享上限不超过「内存 − 4 GB」：留够系统和应用程序，否则权重装进去就换页；
       * 2. 标 usedUnknown，让预算再乘一个保守系数（而不是按 free×0.92 算）。
       */
      const shared = Math.max(GB, Math.min(Math.floor(ramBytes * 0.5), Math.floor(ramBytes - 4 * GB)))
      if (g.totalBytes < shared) {
        g.shared = true
        g.totalBytes = shared
        g.usedUnknown = true
      }
    }
    g.bandwidthGBps = gpuBandwidth(g.name)
  }

  // 统一内存 / 独显优先，核显最后：有独显的笔记本不该按核显出结论
  const rank = (g) => (g.kind === 'integrated' ? 2 : g.kind === 'unified' ? 0 : 1)
  return gpus.sort((a, b) => rank(a) - rank(b) || b.totalBytes - a.totalBytes)
}

function detectHardware() {
  return {
    gpus: collectGpus(os.totalmem()),
    ramBytes: os.totalmem(),
    ramBandwidthGBps: ramBandwidth(),
    cpu: os.cpus()[0]?.model?.trim() || 'unknown',
    platform: `${os.type()} ${os.release()}`,
    osPlatform: process.platform,
    arch: process.arch
  }
}



function makeHardware(manualVram = 0, gpuIndex = 0) {
  const hw = detectHardware()
  // 选卡：把要评估的那张换到第一位。
  // assess() 只认 gpus[0]，这样「整模型装不装得下」自然按这张卡算 ——
  // 双卡机器上两个模型各跑各的卡，公式一行都不用改。
  const idx = Math.max(0, Math.min(Math.floor(Number(gpuIndex) || 0), Math.max(0, hw.gpus.length - 1)))
  if (idx > 0 && hw.gpus.length > 1) {
    const picked = hw.gpus[idx]
    hw.gpus = [picked, ...hw.gpus.filter((_, i) => i !== idx)]
  }
  if (manualVram > 0) {
    // 只替换容量，保留卡名和带宽：--vram 是「假如我有 12G」的假设题，
    // 带宽还按本机的卡算，才不至于把速度估成「—」。
    const g = hw.gpus[0]
    // 统一内存（Apple Silicon）不能当成独立显卡：假设成 24 GB，GPU 实际能用的
    // 仍受 Metal 建议工作集约束（约 2/3），按「可用 × 0.92」算会把上限抬高一倍。
    const keepUnified = Boolean(g?.unified)
    hw.gpus = [g
      ? {
        ...g,
        name: `${g.name}（按 ${manualVram} GB 计）`,
        totalBytes: manualVram * GB,
        usedBytes: 0,
        unified: keepUnified,
        maxWorkingSetBytes: keepUnified ? appleWorkingSet(manualVram * GB) : 0,
        shared: false,
        source: 'manual'
      }
      : {
        name: `手动指定 ${manualVram} GB`, totalBytes: manualVram * GB, usedBytes: 0,
        kind: 'discrete', backend: 'unknown', source: 'manual'
      }]
  }
  return hw
}

export {
  detectHardware, makeHardware, gpuBandwidth, ramBandwidth, appleWorkingSet,
  GPU_BANDWIDTH, VIRTUAL_GPU
}
