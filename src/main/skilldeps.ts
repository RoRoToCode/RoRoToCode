import { spawnSync } from 'node:child_process'
import {
  allModules,
  summarizeDeps,
  type SkillDepReport
} from '../shared/skilldeps'

/**
 * 本机依赖探测：只跑两条只读命令 —— `python --version` 和一次 importlib 批量查询。
 * 不装东西、不联网、不改环境，检查失败也只返回「没查到」，不抛错。
 *
 * 一次批量查所有模块而不是每个包起一个进程：十几个包逐个 spawn 在 Windows 上
 * 要好几秒，技能面板点一下等半天；合成一条 `python -c` 通常在 200ms 内回来。
 */

const CANDIDATES =
  process.platform === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', 'python']

function detectPython(): { cmd: string; version: string } | null {
  for (const cmd of CANDIDATES) {
    try {
      const r = spawnSync(cmd, ['--version'], {
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true
      })
      if (r.status === 0) {
        // 有些发行版把版本打到 stderr
        return { cmd, version: String(r.stdout || r.stderr || '').trim() || cmd }
      }
    } catch {
      // Microsoft Store 的 python 别名会直接抛 ENOENT，换下一个候选
    }
  }
  return null
}

function probeModules(cmd: string): Record<string, boolean> {
  const script =
    'import importlib.util,json;' +
    `mods=${JSON.stringify(allModules())};` +
    'print(json.dumps({m: importlib.util.find_spec(m) is not None for m in mods}))'
  try {
    const r = spawnSync(cmd, ['-c', script], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    })
    if (r.status !== 0) return {}
    const parsed = JSON.parse(String(r.stdout || '').trim()) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      out[k] = v === true
    }
    return out
  } catch {
    return {}
  }
}

export async function checkSkillDeps(): Promise<SkillDepReport> {
  const py = detectPython()
  if (!py) return summarizeDeps(null, '', {})
  return summarizeDeps(py.cmd, py.version, probeModules(py.cmd))
}
