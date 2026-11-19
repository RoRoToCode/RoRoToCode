import { app } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { spawnSync } from 'node:child_process'
import type { GpuInfo, SystemSpecs } from '../shared/types'
import { isMac, isWin, isLinux } from './platform'
import { isVirtualGpu } from './gpuplan'

/**
 * 读取本机硬件参数（显卡 / CPU / 内存 / 磁盘）。
 *
 * 显存来源按平台分三路：
 *  - Windows：nvidia-smi（N 卡最准）→ 注册表 qwMemorySize（WMI 的 AdapterRAM 是 32 位，
 *    超过 4GB 的显卡会被截断成 4GB，不可用）
 *  - macOS：system_profiler SPDisplaysDataType（Apple Silicon 是统一内存，读不到固定显存时为 0）
 *  - Linux：nvidia-smi（N 卡）→ lspci（AMD / Intel，只能拿名字）
 */

interface PsResult {
  cores?: number
  logical?: number
  gpus?: Array<{ name?: string; vram?: number; driver?: string }>
}

const PS_SCRIPT = `
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
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
[pscustomobject]@{
  cores   = $cpu.NumberOfCores
  logical = $cpu.NumberOfLogicalProcessors
  gpus    = $gpus
} | ConvertTo-Json -Compress -Depth 4
`

function queryPowerShell(): PsResult | null {
  if (!isWin) return null
  try {
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 }
    )
    const out = (r.stdout ?? '').trim()
    if (!out) return null
    return JSON.parse(out) as PsResult
  } catch {
    return null
  }
}

/** "8 GB" / "4096 MB" → 字节 */
function parseSize(v: string | undefined): number {
  if (!v) return 0
  const m = /([\d.]+)\s*(TB|GB|MB|KB)/i.exec(v)
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n)) return 0
  const unit = m[2].toUpperCase()
  const mul = unit === 'TB' ? 1024 ** 4 : unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : 1024
  return Math.round(n * mul)
}

/** macOS：显卡型号 + 显存（统一内存机型可能读不到）+ 物理核数 */
function queryMac(): PsResult | null {
  if (!isMac) return null
  const gpus: Array<{ name?: string; vram?: number; driver?: string }> = []
  try {
    const r = spawnSync('system_profiler', ['SPDisplaysDataType', '-json'], {
      encoding: 'utf8',
      timeout: 20000
    })
    if (r.status === 0 && r.stdout) {
      const j = JSON.parse(r.stdout) as { SPDisplaysDataType?: Array<Record<string, string>> }
      for (const d of j.SPDisplaysDataType ?? []) {
        const name = d.sppci_model || d._name
        if (!name) continue
        gpus.push({
          name,
          vram: parseSize(d.spdisplays_vram || d.spdisplays_vram_shared),
          driver: d.spdisplays_metal ? `Metal ${d.spdisplays_metal}` : undefined
        })
      }
    }
  } catch {
    // 读不到显卡不算错误，CPU / 内存照常返回
  }
  let cores = 0
  try {
    const r = spawnSync('sysctl', ['-n', 'hw.physicalcpu'], { encoding: 'utf8', timeout: 5000 })
    if (r.status === 0) cores = Number(`${r.stdout ?? ''}`.trim()) || 0
  } catch {
    // 忽略
  }
  return { cores, gpus }
}

/** Linux：lspci 显卡型号（NVIDIA 的显存由 nvidia-smi 补）+ lscpu 物理核数 */
function queryLinux(): PsResult | null {
  if (!isLinux) return null
  const gpus: Array<{ name?: string; vram?: number; driver?: string }> = []
  try {
    const r = spawnSync('lspci', [], { encoding: 'utf8', timeout: 8000 })
    if (r.status === 0 && r.stdout) {
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = /(VGA compatible controller|3D controller|Display controller):\s*(.+)$/i.exec(line)
        if (!m) continue
        const name = m[2].replace(/\s*\(rev [^)]*\)\s*$/i, '').trim()
        if (name && !isVirtualGpu(name)) gpus.push({ name, vram: 0 })
      }
    }
  } catch {
    // 没有 lspci 就算了
  }
  let cores = 0
  try {
    const r = spawnSync('lscpu', [], { encoding: 'utf8', timeout: 5000 })
    if (r.status === 0) {
      const per = /Core\(s\) per socket:\s*(\d+)/i.exec(`${r.stdout ?? ''}`)
      const sockets = /Socket\(s\):\s*(\d+)/i.exec(`${r.stdout ?? ''}`)
      if (per) cores = Number(per[1]) * (sockets ? Number(sockets[1]) : 1)
    }
  } catch {
    // 忽略
  }
  return { cores, gpus }
}

function queryNvidia(): GpuInfo[] {
  try {
    const r = spawnSync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 }
    )
    if (r.status !== 0 || !r.stdout) return []
    const list: GpuInfo[] = []
    for (const line of r.stdout.split(/\r?\n/)) {
      const [name, mem, driver] = line.split(',').map((s) => s.trim())
      if (!name) continue
      const mib = Number(mem)
      list.push({
        name,
        vramBytes: Number.isFinite(mib) ? Math.round(mib * 1024 * 1024) : 0,
        driver: driver || undefined,
        source: 'nvidia-smi'
      })
    }
    return list
  } catch {
    return []
  }
}

const norm = (s: string) =>
  s.toLowerCase().replace(/\(r\)|\(tm\)|nvidia|geforce|amd|radeon/g, '').replace(/\s+/g, ' ').trim()

/** 虚拟显示器 / 远程桌面显卡没有推理价值，过滤掉（如向日葵、ToDesk、Parsec） */
const VIRTUAL_GPU = /idd|indirect display|basic display|virtual|mirror|parsec|sunlogin|todesk|oray|remote|llvmpipe|swiftshader|softpipe/i

/** 只取显卡名字（按显存从大到小）。给「现在跑在哪张卡上」这类展示做兜底 */
export function gpuNames(): string[] {
  return queryNvidia()
    .filter((g) => !VIRTUAL_GPU.test(g.name))
    .map((g) => g.name)
}

/** PowerShell 5.1 的单元素数组会序列化成对象而非数组，这里统一成数组 */
function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

/** 合并两路显卡信息：同名取显存更大的那条，避免系统值覆盖 nvidia-smi 的准确值 */
function mergeGpus(a: GpuInfo[], b: GpuInfo[]): GpuInfo[] {
  const out: GpuInfo[] = []
  for (const g of [...a, ...b]) {
    if (!g.name || VIRTUAL_GPU.test(g.name)) continue
    const key = norm(g.name)
    const hit = out.find((x) => norm(x.name) === key)
    if (!hit) out.push({ ...g })
    else if (g.vramBytes > hit.vramBytes) Object.assign(hit, g)
  }
  // 先独立显卡后集成显卡（显存大的排前面）
  return out.sort((x, y) => y.vramBytes - x.vramBytes)
}

async function diskOf(target: string): Promise<SystemSpecs['disk']> {
  try {
    const root = path.parse(target).root || target
    const st = await fs.statfs(root)
    return {
      path: root,
      freeBytes: Number(st.bavail) * Number(st.bsize),
      totalBytes: Number(st.blocks) * Number(st.bsize)
    }
  } catch {
    return null
  }
}

export async function systemSpecs(): Promise<SystemSpecs> {
  const cpus = os.cpus()
  const logicalCores = cpus.length
  const ps = isWin ? queryPowerShell() : isMac ? queryMac() : queryLinux()
  const nv = queryNvidia()

  const source: GpuInfo['source'] = isWin ? 'wmi' : isMac ? 'system_profiler' : 'lspci'
  const psGpus: GpuInfo[] = asArray(ps?.gpus)
    .filter((g) => !!g?.name)
    .map((g) => ({
      name: String(g.name),
      vramBytes: Number(g.vram) > 0 ? Number(g.vram) : 0,
      driver: g.driver ? String(g.driver) : undefined,
      source
    }))

  const gpus = mergeGpus(psGpus, nv)

  const diskTarget = app.isPackaged ? path.dirname(app.getPath('exe')) : app.getPath('userData')

  return {
    ok: true,
    cpu: {
      model: cpus[0]?.model?.trim() || '未知 CPU',
      physicalCores: Number(ps?.cores) > 0 ? Number(ps!.cores) : 0,
      logicalCores,
      speedGHz: cpus[0]?.speed ? Math.round((cpus[0].speed / 1000) * 10) / 10 : 0
    },
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
    gpus,
    os: { platform: `${os.type()} ${os.release()}`, release: os.version?.() ?? '', arch: os.arch() },
    disk: await diskOf(diskTarget)
  }
}
