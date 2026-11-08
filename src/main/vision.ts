import { nativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 把本地图片转成 data URL 交给视觉模型。
 *
 * 手机截图动辄 1~3 MB，一张就吃光上下文，所以先用 Electron 自带的 nativeImage
 * 缩到长边 1280 再转 JPEG；失败（格式不认识）才退回原文件 base64。
 * 结果按「路径 + 修改时间」缓存，同一轮里多次请求不会重复解码。
 */
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp'
}

/** 单张图最大 6MB base64，超过就再缩一档，仍然超就放弃（避免请求被服务端直接拒绝） */
const MAX_BYTES = 6 * 1024 * 1024
const EDGES = [1280, 1024, 768]

const cache = new Map<string, string | null>()

export function imageDataUrl(absPath: string): string | null {
  let stamp = ''
  try {
    const st = fs.statSync(absPath)
    stamp = `${st.size}:${Math.floor(st.mtimeMs)}`
  } catch {
    return null
  }
  const key = `${absPath}|${stamp}`
  if (cache.has(key)) return cache.get(key) ?? null

  let data: string | null = null
  try {
    const img = nativeImage.createFromPath(absPath)
    if (!img.isEmpty()) {
      const size = img.getSize()
      const longest = Math.max(size.width, size.height)
      for (const edge of EDGES) {
        const scale = longest > edge ? edge / longest : 1
        const shrunk =
          scale < 1
            ? img.resize({
                width: Math.max(1, Math.round(size.width * scale)),
                height: Math.max(1, Math.round(size.height * scale)),
                quality: 'good'
              })
            : img
        const buf = shrunk.toJPEG(82)
        if (!buf.length) continue
        const url = `data:image/jpeg;base64,${buf.toString('base64')}`
        if (url.length <= MAX_BYTES) {
          data = url
          break
        }
      }
    }

    if (!data) {
      const ext = path.extname(absPath).slice(1).toLowerCase()
      const raw = fs.readFileSync(absPath)
      const url = `data:${MIME[ext] ?? 'image/png'};base64,${raw.toString('base64')}`
      if (url.length <= MAX_BYTES) data = url
    }
  } catch {
    data = null
  }

  // 缓存别无限涨：简单按容量清空
  if (cache.size > 32) cache.clear()
  cache.set(key, data)
  return data
}

/** 给界面用的缩略图，返回 data URL（不落盘） */
export function imageThumb(absPath: string, edge = 320): string | null {
  try {
    const img = nativeImage.createFromPath(absPath)
    if (img.isEmpty()) return null
    const size = img.getSize()
    const longest = Math.max(size.width, size.height)
    const scale = longest > edge ? edge / longest : 1
    const out =
      scale < 1
        ? img.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
            quality: 'good'
          })
        : img
    return `data:image/jpeg;base64,${out.toJPEG(78).toString('base64')}`
  } catch {
    return null
  }
}
