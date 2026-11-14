/**
 * 把一份 diff 切成「块」（hunk），并支持按块重建文件内容。
 *
 * 用途：模型改了一个文件里的三处，用户只想要其中两处。整文件接受/撤销都太粗，
 * 这里提供「逐块保留」：选中哪些块，就用「原文 + 选中的改动」重新拼出文件。
 *
 * 纯函数，不碰磁盘 —— 单测直接喂 DiffLine 数组。
 */
import type { DiffLine } from './types'

export interface Hunk {
  id: number
  /** 在 lines 里的起止下标（含） */
  from: number
  to: number
  added: number
  removed: number
}

/** 每块前后各带几行上下文：少了看不出改在哪，多了把整文件都框进来 */
const CONTEXT = 3

/**
 * 切块。相邻改动之间如果只隔了几行没变的代码，算同一块 ——
 * 否则模型在同一个函数里改三行，用户要点三次。
 */
export function diffHunks(lines: DiffLine[], context = CONTEXT): Hunk[] {
  const changes: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== 'ctx') changes.push(i)
  }
  if (!changes.length) return []

  // 先按「改动之间隔多远」分组
  const groups: Array<{ start: number; end: number }> = []
  for (const idx of changes) {
    const last = groups[groups.length - 1]
    if (last && idx - last.end <= context * 2) last.end = idx
    else groups.push({ start: idx, end: idx })
  }

  // 再各自向外扩上下文，扩完可能相接，需要再合并一次
  const expanded = groups.map((g) => ({
    start: Math.max(0, g.start - context),
    end: Math.min(lines.length - 1, g.end + context)
  }))
  const merged: Array<{ start: number; end: number }> = []
  for (const g of expanded) {
    const last = merged[merged.length - 1]
    if (last && g.start <= last.end + 1) last.end = Math.max(last.end, g.end)
    else merged.push({ ...g })
  }

  return merged.map((g, id) => {
    let added = 0
    let removed = 0
    for (let i = g.start; i <= g.end; i++) {
      if (lines[i].kind === 'add') added++
      else if (lines[i].kind === 'del') removed++
    }
    return { id, from: g.start, to: g.end, added, removed }
  })
}

/** 行下标 → 块 id。不在任何块里的行（上下文之外）返回 -1 */
export function hunkIndexOf(hunks: Hunk[], lineIndex: number): number {
  for (const h of hunks) {
    if (lineIndex >= h.from && lineIndex <= h.to) return h.id
  }
  return -1
}

/**
 * 按选中的块重建完整文件内容。
 *
 * 规则很简单，但每条都有原因：
 * - ctx：原文内容，永远保留
 * - add：只有它所在的块被选中才写进去
 * - del：只有它所在的块被选中才「删掉」；没选中就当作原文保留
 */
export function buildWithHunks(lines: DiffLine[], hunks: Hunk[], keep: Set<number>): string {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.kind === 'ctx') {
      out.push(line.text)
      continue
    }
    const id = hunkIndexOf(hunks, i)
    const selected = id >= 0 && keep.has(id)
    if (line.kind === 'add') {
      if (selected) out.push(line.text)
    } else if (line.kind === 'del') {
      if (!selected) out.push(line.text)
    }
  }
  return out.join('\n')
}
