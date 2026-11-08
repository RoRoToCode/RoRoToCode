import type { DiffLine } from '../shared/types'

/**
 * 行级 diff：先砍掉公共前后缀，中间段用 LCS 求最短编辑。
 * 只为了给人看改动，不追求算法最优；超大文件退化成整段替换，避免 O(n*m) 卡死。
 */
const DP_LIMIT = 2_000_000

export function splitLines(text: string): string[] {
  if (!text) return []
  // 统一换行，末尾空行不算一行
  return text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
}

function lcsTable(a: string[], b: string[]): Int32Array {
  const n = a.length
  const m = b.length
  const dp = new Int32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] =
        a[i] === b[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1])
    }
  }
  return dp
}

export function diffLines(beforeText: string, afterText: string): DiffLine[] {
  const a = splitLines(beforeText)
  const b = splitLines(afterText)

  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }

  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)

  const out: DiffLine[] = []
  for (let i = 0; i < head; i++) out.push({ kind: 'ctx', text: a[i], before: i + 1, after: i + 1 })

  if (midA.length * midB.length > DP_LIMIT) {
    // 太大了：整段当作删除 + 新增
    midA.forEach((t, i) => out.push({ kind: 'del', text: t, before: head + i + 1 }))
    midB.forEach((t, i) => out.push({ kind: 'add', text: t, after: head + i + 1 }))
  } else {
    const dp = lcsTable(midA, midB)
    const m = midB.length
    let i = 0
    let j = 0
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        out.push({ kind: 'ctx', text: midA[i], before: head + i + 1, after: head + j + 1 })
        i++
        j++
      } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
        out.push({ kind: 'del', text: midA[i], before: head + i + 1 })
        i++
      } else {
        out.push({ kind: 'add', text: midB[j], after: head + j + 1 })
        j++
      }
    }
    while (i < midA.length) out.push({ kind: 'del', text: midA[i], before: head + i++ + 1 })
    while (j < midB.length) out.push({ kind: 'add', text: midB[j], after: head + j++ + 1 })
  }

  for (let k = 0; k < tail; k++) {
    const idx = a.length - tail + k
    out.push({ kind: 'ctx', text: a[idx], before: idx + 1, after: b.length - tail + k + 1 })
  }
  return out
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.kind === 'add') added++
    else if (l.kind === 'del') removed++
  }
  return { added, removed }
}

/** 给终端用的补丁文本（也用于导出） */
export function unifiedText(name: string, lines: DiffLine[]): string {
  const out = [`--- a/${name}`, `+++ b/${name}`]
  for (const l of lines) {
    out.push(`${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`)
  }
  return out.join('\n')
}
