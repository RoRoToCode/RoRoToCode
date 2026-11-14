/**
 * 显存实测：问 nvidia-smi「这张卡现在用了多少」。
 *
 * 为什么需要它：体检只能按 GGUF 元数据估（权重 + KV + 缓冲），每一项都是假设，
 * 而「同一个 9B 模型在 8GB 卡上到底占多少」只有跑起来才知道 —— 尤其是 hybrid
 * 架构（部分层落到 CPU、还有一块与上下文无关的 recurrent state），估算差个 5~10%
 * 就会把「装得下 64K」判成「只装得下 32K」。
 *
 * 取三次的中位数：WDDM 下桌面合成器、浏览器、录屏都在同一张卡上进出显存，
 * 单次采样很容易正好撞上别的进程申请/释放的瞬间。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface GpuUse {
  usedMiB: number
  totalMiB: number
}

let smiPath: string | null | undefined

/** nvidia-smi 常见位置。打包后的主进程 PATH 里经常没有它，所以逐个绝对路径兜底 */
function smiCandidates(): string[] {
  const root = process.env.SystemRoot || 'C:\\Windows'
  const out = [process.env.NVIDIA_SMI_PATH, 'nvidia-smi', path.join(root, 'System32', 'nvidia-smi.exe')]
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  out.push(path.join(programFiles, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'))
  return out.filter((x): x is string => typeof x === 'string' && x.length > 0)
}

function resolveSmi(): string | null {
  if (smiPath !== undefined) return smiPath
  for (const c of smiCandidates()) {
    // PATH 里的名字没有绝对路径，交给 spawn 去找；绝对路径先看文件在不在
    if (!path.isAbsolute(c) || fs.existsSync(c)) {
      smiPath = c
      return c
    }
  }
  smiPath = null
  return null
}

function query(exe: string, index: number, timeoutMs: number): Promise<GpuUse | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: GpuUse | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(v)
    }
    const child = spawn(
      exe,
      [`--id=${Math.max(0, Math.round(index))}`, '--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let out = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 忽略
      }
      finish(null)
    }, timeoutMs)
    child.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf8')
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      if (code !== 0) return finish(null)
      // 多卡时 --id 只回一行；格式是 "1234, 8192"
      const line = out.trim().split(/\r?\n/)[0] ?? ''
      const [used, total] = line.split(',').map((x) => Number(x.trim()))
      if (!Number.isFinite(used) || !Number.isFinite(total)) return finish(null)
      finish({ usedMiB: used, totalMiB: total })
    })
  })
}

/** 单次采样。拿不到（没装 N 卡 / 驱动太老 / 被安全软件拦）就返回 null，调用方据此放弃调档 */
export async function gpuUsedMiB(index = 0): Promise<GpuUse | null> {
  const exe = resolveSmi()
  if (!exe) return null
  return query(exe, index, 4000)
}

/**
 * 采 n 次取中位数。
 *
 * 启动前后的两次采样必须同一口径：都用中位数，才不会被「正好有程序在抢显存」带偏，
 * 否则差值（也就是模型占用）会算出离谱的数。
 */
export async function sampleUsedMiB(index = 0, n = 3, gapMs = 200): Promise<GpuUse | null> {
  const samples: GpuUse[] = []
  for (let i = 0; i < Math.max(1, n); i++) {
    const s = await gpuUsedMiB(index)
    if (s) samples.push(s)
    if (i < n - 1) await new Promise((r) => setTimeout(r, gapMs))
  }
  if (!samples.length) return null
  const used = samples.map((s) => s.usedMiB).sort((a, b) => a - b)
  const mid = used[Math.floor(used.length / 2)]
  return { usedMiB: mid, totalMiB: samples[0].totalMiB }
}

/** 从 'CUDA0' / 'CUDA:1' / '1' 里取卡号；取不到按 0 处理（单卡机器上是常态） */
export function deviceIndexOf(device?: string | null): number {
  const m = /(\d+)\s*$/.exec(String(device ?? '').trim())
  const n = m ? Number(m[1]) : 0
  return Number.isFinite(n) && n >= 0 ? n : 0
}
