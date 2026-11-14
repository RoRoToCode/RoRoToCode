import { createReadStream, promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'

/** 每读这么多报一次进度：太密会把事件刷爆，太疏看起来像卡死 */
const REPORT_STEP = 128 * 1024 * 1024

/**
 * 算一个文件的 sha256。
 *
 * 必须流式读：GGUF 动辄十几 GB，`readFile` 一次性读进内存会直接把进程干掉。
 * 放在独立文件里是为了能直接被单测 require —— main 里大多数模块都拽着
 * electron，一旦混进去就再也测不了了。
 */
export async function sha256Of(
  file: string,
  onTick?: (done: number, total: number) => void
): Promise<string> {
  const total = (await fs.stat(file)).size
  const hash = createHash('sha256')
  let done = 0
  let reported = 0
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
    const buf = chunk as Buffer
    hash.update(buf)
    done += buf.length
    if (onTick && done - reported >= REPORT_STEP) {
      reported = done
      onTick(done, total)
    }
  }
  return hash.digest('hex')
}
