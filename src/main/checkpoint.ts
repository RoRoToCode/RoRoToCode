import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Checkpoint, CheckpointStatus } from '../shared/checkpoint'

/**
 * 结构化任务 checkpoint：把「任务进度」以机器可读的形式独立落盘，
 * 不随对话消息一起被压缩，崩溃 / 重开后也能据此精确续跑。
 *
 * 它和「对话式摘要」的区别：
 * - 摘要把早期对话压成一段文字，细节会逐步失真；
 * - checkpoint 存的是「计划清单 + 改过的文件 + 最后的验证结论」这些硬事实，
 *   不会失真，恢复时直接回灌给模型，让它知道「做到哪了、还剩什么」。
 */

export type { Checkpoint, CheckpointStatus }
export { checkpointBrief } from '../shared/checkpoint'

function dir(): string {
  return path.join(app.getPath('userData'), 'checkpoints')
}

function fileOf(sessionId: string): string {
  if (!/^[a-z0-9-]{6,64}$/i.test(sessionId)) throw new Error('非法的会话 ID')
  return path.join(dir(), `${sessionId}.json`)
}

async function writeJson(abs: string, data: unknown): Promise<void> {
  const tmp = `${abs}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, abs)
}

/**
 * 按会话串行化写盘。
 *
 * 引擎里 saveCheckpoint 是 `void` 调用的（不能因为落盘拖慢每一步），而收工时的
 * clearCheckpoint 是 await 的。两者并发时，一次还在路上的 save 会在 rm 之后
 * 把文件重新 rename 回来 —— 于是「已经跑完」的会话下次启动又冒出「继续」横幅。
 * 排队执行就没有这个窗口：谁最后调用的，谁最后落地。
 */
const tails = new Map<string, Promise<unknown>>()

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const settle = next.catch(() => undefined)
  tails.set(key, settle)
  void settle.then(() => {
    // 队列空了就把键删掉，长跑进程里不会越攒越多
    if (tails.get(key) === settle) tails.delete(key)
  })
  return next
}

/** 写入（或更新）一个 checkpoint。任何 IO 失败都静默吞掉：checkpoint 是兜底，不该拖垮主流程。 */
export async function saveCheckpoint(cp: Checkpoint): Promise<void> {
  await serialize(cp.sessionId, async () => {
    try {
      await fs.mkdir(dir(), { recursive: true })
      await writeJson(fileOf(cp.sessionId), cp)
    } catch {
      // 磁盘写不进也不影响对话继续，下一轮再试
    }
  })
}

export async function loadCheckpoint(sessionId: string): Promise<Checkpoint | null> {
  try {
    const raw = await fs.readFile(fileOf(sessionId), 'utf8')
    return JSON.parse(raw) as Checkpoint
  } catch {
    return null
  }
}

/** 正常完成 / 用户确认放弃后清除，避免下次启动误判成「中断」 */
export async function clearCheckpoint(sessionId: string): Promise<void> {
  // 排在这一会话所有未落地的 save 之后：否则刚删掉就被上一次 save 写回来
  await serialize(sessionId, async () => {
    try {
      await fs.rm(fileOf(sessionId), { force: true })
    } catch {
      // 已不存在或删不掉都无所谓
    }
  })
}

/**
 * 启动时扫描所有还处于 running 状态的 checkpoint —— 这些是「上次没跑完就崩了」的会话。
 * 返回按最近活动排序，供恢复入口使用。
 */
export async function listInterruptedCheckpoints(): Promise<Checkpoint[]> {
  try {
    await fs.mkdir(dir(), { recursive: true })
    const names = await fs.readdir(dir())
    const out: Checkpoint[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = await fs.readFile(path.join(dir(), name), 'utf8')
        const cp = JSON.parse(raw) as Checkpoint
        if (cp && cp.status === 'running') out.push(cp)
      } catch {
        // 损坏的 checkpoint 跳过
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}
