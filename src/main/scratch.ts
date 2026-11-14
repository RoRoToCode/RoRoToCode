/**
 * 会话级便签（scratch）：每条会话一小份，跑完这摊活就没用了。
 *
 * 为什么需要第三层：
 * - 长期记忆（memory）记「这个项目一直如此」，写进去就一直在；
 * - 共享黑板（board）记「这摊活现在到哪了」，同一个工作区的档案都看得到；
 * - 但有些东西只属于「我正在做的这一次」：改了三个文件、待会儿要回头补测试、
 *   某个行号刚查过不想再 grep 一遍。写进上面两层都是污染 ——
 *   下次开工别人读到一条早就过期的行号，比没有更糟。
 *
 * 所以它按会话存，只注入当前会话的系统提示，不进任何共享视图。
 * 内容是纯文本，模型自己读写；界面上以工具卡片的形式可见，不需要额外的面板。
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 注入系统提示的上限：便签是临时状态，不该占掉上下文的大头 */
export const SCRATCH_PROMPT_LIMIT = 900
/** 文件本身的体积上限，超了从最早的开始丢（保留最新的尾巴） */
export const SCRATCH_MAX_CHARS = 8000

function dir(): string {
  return path.join(app.getPath('userData'), 'scratch')
}

function fileOf(sessionId: string): string {
  if (!/^[a-z0-9-]{6,64}$/i.test(sessionId)) throw new Error('非法的会话 ID')
  return path.join(dir(), `${sessionId}.md`)
}

/**
 * 同一条会话的读写必须排队。一次运行里模型可能连着调两次 scratch，
 * 两个都是「读全文 → 改 → 写回」，交叉执行会丢内容。跟 memory/board 同一套办法。
 */
const writing = new Map<string, Promise<unknown>>()

function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = writing.get(key) ?? Promise.resolve()
  const next = prev.then(task, task)
  writing.set(
    key,
    next.catch(() => undefined)
  )
  return next
}

export async function readScratch(sessionId: string): Promise<string> {
  try {
    return await fs.readFile(fileOf(sessionId), 'utf8')
  } catch {
    return ''
  }
}

/**
 * 写便签。mode=append 追加一行（默认），replace 整篇覆盖。
 * 返回写完之后的总字数，让模型知道还剩多少空间。
 */
export async function writeScratch(
  sessionId: string,
  text: string,
  mode: 'append' | 'replace' = 'append'
): Promise<{ chars: number }> {
  const body = text.replace(/\r\n/g, '\n').trim()
  if (!body) throw new Error('要写的内容是空的')
  return serialize(fileOf(sessionId), async () => {
    const prev = mode === 'replace' ? '' : await readScratch(sessionId)
    let next = mode === 'replace' ? body : prev.trimEnd() ? `${prev.trimEnd()}\n${body}` : body
    // 超长就砍头留尾：最近的几条才有用，旧的一般已经做完了
    if (next.length > SCRATCH_MAX_CHARS) next = next.slice(next.length - SCRATCH_MAX_CHARS)
    await fs.mkdir(dir(), { recursive: true })
    await fs.writeFile(fileOf(sessionId), next, 'utf8')
    return { chars: next.length }
  })
}

export async function clearScratch(sessionId: string): Promise<void> {
  await serialize(fileOf(sessionId), () => fs.rm(fileOf(sessionId), { force: true }))
}

/** 给系统提示的片段：超长只带最新的尾巴（旧的大概率已经做完） */
export async function scratchForPrompt(sessionId: string): Promise<string> {
  const text = (await readScratch(sessionId)).trim()
  if (!text) return ''
  if (text.length <= SCRATCH_PROMPT_LIMIT) return text
  return `…（只显示最近的部分）\n${text.slice(text.length - SCRATCH_PROMPT_LIMIT)}`
}
