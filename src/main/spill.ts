import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

/**
 * 工具输出的「溢出存储」。
 *
 * 为什么需要它：上下文装不下时，compact 会把较早的工具输出掐头留尾，中间整段丢掉。
 * 模型于是永远拿不回那段细节 —— 它只记得「我查过这个文件」，于是重新 read 一遍，
 * 而重读又占上下文，下一轮折得更狠。真实会话里「92 次 write_file」那个死循环，
 * 前半段就是这个正反馈。
 *
 * 做法和 dsh 的 spill / opencode 的 tool-output 一致：原文落盘，上下文里只留
 * 有界预览 + 一个能直接 read_file 的路径。区别是我们写在**工作区内**的
 * .roroto/spill/ 下，这样模型的 read_file 能直接够到（工具的 safePath 限定在工作区），
 * 用户也能自己翻。
 *
 * 三个约束：
 * - 内容寻址（sha1 前 16 位）→ 同一条输出反复被折叠也只写一次，不会每轮请求都落盘；
 * - 任何失败都返回 null，绝不因为「存不下」把一次正常回答变成报错；
 * - 只在真正折叠时才调用，未超预算的历史一个字节都不写。
 */

/** 单条输出超过这个大小就不再落盘：多半是几条几 MB 的构建日志，写盘比丢失更慢 */
const MAX_SPILL_BYTES = 32 * 1024 * 1024
/** 溢出文件保留天数。和历史摘要一个量级：够用户回看，又不至于把磁盘塞满 */
const KEEP_DAYS = 7

export interface SpillMeta {
  /** 工具名，只用于文件名，方便用户一眼看出这是什么 */
  toolName?: string
}

function safeSegment(s: string): string {
  return s.replace(/[^\w.-]/g, '').slice(0, 64) || 'x'
}

/** 会话目录：一个会话一个子目录，删会话时能整目录清掉 */
export function spillSessionDir(root: string, sessionId: string): string {
  return path.join(root, safeSegment(sessionId))
}

let cleaned = false

/**
 * 把一段工具输出写到磁盘，返回绝对路径；失败返回 null。
 *
 * 同步写：调用点在 compact 里，本身是同步函数，改成异步会把整条压缩链路染成 Promise。
 * 只在超预算那一轮触发，且同内容只写一次，实际开销是一次几十 KB 的 writeFileSync。
 */
export function saveSpill(root: string, sessionId: string, text: string, meta: SpillMeta = {}): string | null {
  if (!text) return null
  if (Buffer.byteLength(text, 'utf8') > MAX_SPILL_BYTES) return null
  try {
    const dir = spillSessionDir(root, sessionId)
    if (!cleaned) {
      cleaned = true
      // 首次落盘顺手清一次旧文件；失败不影响本次写入
      try {
        cleanupSpill(root)
      } catch {
        // 忽略
      }
    }
    fs.mkdirSync(dir, { recursive: true })
    /**
     * 自带一条 .gitignore。
     *
     * spill 落在工作区的 .roroto/ 下，而 .roroto/agents 之类是要跟着仓库提交的，
     * 不能整个目录忽略。在 spill 根上放一个 `*`，用户什么都不用配，
     * 这些随手生成的缓存也不会被误提交进版本库。
     */
    const ignore = path.join(root, '.gitignore')
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n', 'utf8')
    const hash = createHash('sha1').update(text).digest('hex').slice(0, 16)
    const tool = meta.toolName ? `-${safeSegment(meta.toolName)}` : ''
    const file = path.join(dir, `${hash}${tool}.txt`)
    if (!fs.existsSync(file)) fs.writeFileSync(file, text, 'utf8')
    return file
  } catch {
    return null
  }
}

/**
 * 清理过期的溢出文件。
 *
 * 按文件 mtime 而不是目录：同一个会话可能横跨很多天，按目录删会把还在用的历史一起带走。
 */
export function cleanupSpill(root: string, maxAgeMs = KEEP_DAYS * 24 * 3600 * 1000): number {
  const deadline = Date.now() - maxAgeMs
  let removed = 0
  let dirs: string[]
  try {
    dirs = fs.readdirSync(root)
  } catch {
    return 0
  }
  for (const name of dirs) {
    const dir = path.join(root, name)
    let files: string[]
    try {
      if (!fs.statSync(dir).isDirectory()) continue
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    let left = files.length
    for (const f of files) {
      const file = path.join(dir, f)
      try {
        if (fs.statSync(file).mtimeMs < deadline) {
          fs.unlinkSync(file)
          removed += 1
          left -= 1
        }
      } catch {
        // 单个文件失败继续
      }
    }
    // 空目录一起收掉，免得 spill/ 下堆几百个空壳
    if (left === 0) {
      try {
        fs.rmdirSync(dir)
      } catch {
        // 忽略
      }
    }
  }
  return removed
}
