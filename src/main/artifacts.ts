import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  isNoisePath,
  isResultFile,
  NOISE_DIRS,
  type ResultFile
} from '../shared/resultfiles'

/**
 * 扫工作区里「能被直接拿走的成果文件」。
 *
 * 为什么需要它：成果面板原先只从 write_file / edit_file / patch 的参数里取路径，
 * 而技能（SKILL.md）的做法是让模型用 run_shell 跑 `python scripts/actions.py …`，
 * 生成的 docx / xlsx / pdf 从来没出现在任何工具参数里 —— 文件明明落盘了，面板却是空的。
 * 这里在命令批次前后各扫一次，用 mtime 差找出真正被生成或改动的文件。
 *
 * 边界（都是怕拖慢大仓库）：
 * - 最多 4 层、最多 3000 个成果文件，超了就停；
 * - 依赖 / 缓存 / 构建目录整棵跳过；
 * - 只认成果类扩展名，源码与脚本一律不收（完整改动在「变更」标签里）。
 * - 只读，永不抛出：扫不动就返回空快照，绝不让一次正常的命令执行因为扫盘失败而中断。
 */

/**
 * 扫盘专用：面板判定里 dist / release 下的 md 仍算成果，但整棵扫进去可能几万个文件，
 * 所以只在「递归遍历」这一层多挡一批目录，不改变成果面板的判定结果。
 */
const SCAN_SKIP_DIRS = new Set([
  ...NOISE_DIRS,
  'dist', 'build', 'release', '.roroto', 'inbox', 'coverage', 'out', 'target', 'vendor'
])

const MAX_DEPTH = 4
const MAX_FILES = 3000
/** mtime 在同一毫秒内可能被文件系统吃掉，给一个很小的容差 */
const MTIME_EPSILON = 2

export type ResultSnapshot = Map<string, number>

export async function snapshotResults(root: string): Promise<ResultSnapshot> {
  const out: ResultSnapshot = new Map()
  if (!root) return out

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.size >= MAX_FILES) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (out.size >= MAX_FILES) return
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.') || SCAN_SKIP_DIRS.has(ent.name.toLowerCase())) continue
        await walk(abs, depth + 1)
        continue
      }
      if (!ent.isFile()) continue
      const rel = path.relative(root, abs).split(path.sep).join('/')
      if (isNoisePath(rel) || !isResultFile(rel)) continue
      try {
        const st = await fs.stat(abs)
        out.set(rel, st.mtimeMs)
      } catch {
        // 扫描期间被删掉 / 正在被别处独占，跳过即可
      }
    }
  }

  try {
    await walk(root, 0)
  } catch {
    return new Map()
  }
  return out
}

/** 只返回「新增」或「内容被改过」的成果；没变化的反复重跑不会刷屏 */
export function diffResults(before: ResultSnapshot, after: ResultSnapshot): ResultFile[] {
  const at = Date.now()
  const out: ResultFile[] = []
  for (const [p, mtime] of after) {
    const prev = before.get(p)
    if (prev === undefined) {
      out.push({ path: p, action: 'created', at, writes: 1 })
    } else if (mtime - prev > MTIME_EPSILON) {
      out.push({ path: p, action: 'edited', at, writes: 1 })
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** 一批工具里有没有可能产生「参数里看不到」的文件 */
export function mayProduceFiles(toolNames: string[]): boolean {
  return toolNames.some((n) => n === 'run_shell' || n === 'shell_bg' || n === 'use_skill' || n === 'task')
}
