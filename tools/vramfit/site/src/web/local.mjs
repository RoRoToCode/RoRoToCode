/**
 * 本地文件适配器：用 File.slice 只读需要的那几段，文件不出浏览器。
 *
 * 这是网页版相对命令行的优势之一：拖进去就行，不用先装 Node 也不用敲路径。
 * 十几 GB 的文件也只读头部十几 MB，内存里始终只有一小块。
 */

import { parseGguf } from '../core/index.mjs'

export function localFileReader(file) {
  return {
    async read(buffer, offset, length, position) {
      const end = Math.min(position + length, file.size)
      if (end <= position) return { bytesRead: 0 }
      const chunk = await file.slice(position, end).arrayBuffer()
      const src = new Uint8Array(chunk)
      const n = Math.min(src.length, length)
      buffer.set(src.subarray(0, n), offset)
      return { bytesRead: n }
    }
  }
}

export async function readLocalGguf(file) {
  return parseGguf(localFileReader(file), file.size, file.name)
}

/** 分片模型只认第一片：后面的片子没有完整元数据 */
export function isFirstShard(name) {
  const m = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(String(name))
  return !m || Number(m[1]) === 1
}
