/**
 * 「读过没读过」的文件状态表。
 *
 * 为什么需要：edit_file 的全部正确性都押在「old_string 是从原文复制的」这个前提上。
 * 模型没读过文件时，它写的 old_string 只能靠猜 —— 猜错就抛「未找到」，
 * 于是重读、再猜、再错，一轮任务能在这里耗掉十几步。
 *
 * Claude Code 的做法是硬性要求「先 Read 才能 Edit」，并且在 Read 时记下 mtime，
 * 写之前再校验一次。这条约束看起来烦，实际上是把「猜」变成「必须看」：
 * 模型一旦读过，old_string 的准确率立刻从碰运气变成基本可靠。
 *
 * 这里实现同一套：
 *   - read_file / grep 命中的文件 → 记下 mtime + size
 *   - write/edit/patch 之前 → 校验「读过」且「没被别人改过」
 *   - 自己刚写完的文件 → 直接记为已读（内容就是它自己给的，没必要再读一遍）
 *
 * 只记内存，不落盘：这是一份短期缓存，进程重启后重新建立即可。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

interface Stamp {
  mtimeMs: number
  size: number
  at: number
}

/** 上限定得比「一次任务会碰到的文件数」大得多，纯粹用来防内存泄漏 */
const MAX_ENTRIES = 4000

const seen = new Map<string, Stamp>()

function keyOf(abs: string): string {
  const p = path.resolve(abs)
  // Windows 的文件名不区分大小写：`C:\A\b.ts` 和 `c:\a\B.ts` 是同一个文件
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function evictIfNeeded(): void {
  if (seen.size <= MAX_ENTRIES) return
  let drop = seen.size - MAX_ENTRIES
  for (const k of seen.keys()) {
    seen.delete(k)
    if (--drop <= 0) break
  }
}

/** 记一次「读过了」 */
export function rememberRead(abs: string, st: { mtimeMs: number; size: number }): void {
  seen.delete(keyOf(abs))
  seen.set(keyOf(abs), { mtimeMs: Math.floor(st.mtimeMs), size: st.size, at: Date.now() })
  evictIfNeeded()
}

/** 自己刚写完：内容就是它自己给的，直接算「读过」，否则下一次编辑会被自己拦住 */
export async function rememberWritten(abs: string): Promise<void> {
  try {
    const st = await fs.stat(abs)
    rememberRead(abs, st)
  } catch {
    seen.delete(keyOf(abs))
  }
}

export function forgetFile(abs: string): void {
  seen.delete(keyOf(abs))
}

/** 只给测试用：清空整张表 */
export function resetFileState(): void {
  seen.clear()
}

export interface EditableVerdict {
  ok: boolean
  /** 不 ok 时给模型看的说明：必须能直接照做，而不是「出错了」 */
  message: string
  /** 文件不存在（新建场景），调用方按自己的语义处理 */
  missing?: boolean
}

/**
 * 改这个文件之前先过一遍：读过吗？读完之后有人动过吗？
 *
 * 文件不存在时返回 `missing`，交给调用方决定是「新建」还是「路径写错了」——
 * 这里不替上层下结论，因为 write_file 新建文件是合法的。
 */
export async function checkEditable(abs: string, display?: string): Promise<EditableVerdict> {
  const name = display ?? abs
  let st: { mtimeMs: number; size: number }
  try {
    st = await fs.stat(abs)
  } catch {
    return { ok: false, message: '', missing: true }
  }
  const rec = seen.get(keyOf(abs))
  if (!rec) {
    return {
      ok: false,
      message:
        `「${name}」这个文件你还没读过，不能直接改 —— 现在写的 old_string 只能靠猜，猜错就得重来。\n` +
        `先用 read_file 读一遍（大文件用 offset/limit 分段读），照着原文复制 old_string，再改。`
    }
  }
  if (rec.mtimeMs !== Math.floor(st.mtimeMs) || rec.size !== st.size) {
    return {
      ok: false,
      message:
        `「${name}」在你上次读过之后被改过了（文件大小或修改时间变了），你手里的内容已经过期。\n` +
        `请重新 read_file 读一遍这个文件，再按新的原文去改。`
    }
  }
  return { ok: true, message: '' }
}

/** write_file 覆盖已有文件时的软提醒：不拦，但要让它知道自己没读过 */
export async function unreadOverwriteNote(abs: string, display?: string): Promise<string> {
  const verdict = await checkEditable(abs, display)
  if (verdict.ok || verdict.missing) return ''
  return (
    `\n\n注意：${verdict.message.split('\n')[0]}` +
    '\n如果这次是要整份重写、并且确认原文已经不需要了，可以忽略这条；否则建议先读再改。'
  )
}
