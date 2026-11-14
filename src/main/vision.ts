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

/** 正文里能直接显示的图片格式（svg 不在内：nativeImage 不认，且能带脚本） */
const PREVIEW_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])
/** 单张上限：再大就不是「看一眼」，而是让界面卡住 */
const PREVIEW_MAX_BYTES = 32 * 1024 * 1024

/**
 * 图片文件的基本校验：扩展名白名单 + 是普通文件 + 不超过上限。
 * 缩略图和正文预览共用同一套，别让「缩略图」这条路成为绕过校验的后门。
 */
function checkImageFile(abs: string): string | null {
  const ext = path.extname(abs).slice(1).toLowerCase()
  if (!PREVIEW_EXT.has(ext)) return `不支持的图片格式：${ext || '无扩展名'}`
  try {
    const st = fs.statSync(abs)
    if (!st.isFile()) return '不是文件'
    if (st.size > PREVIEW_MAX_BYTES) return '图片太大'
  } catch {
    return '文件不存在'
  }
  return null
}

/** 给界面用的缩略图，返回 data URL（不落盘） */
export function imageThumb(absPath: string, edge = 320): string | null {
  // 以前这里什么都不校验：任意绝对路径、任意格式、任意大小都直接解码
  if (!path.isAbsolute(absPath)) return null
  if (checkImageFile(absPath)) return null
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

/** 正文里能直接显示的图片格式（svg 不在内：nativeImage 不认，且能带脚本） */
const previewCache = new Map<string, string | null>()

/**
 * 把模型写在正文里的本地路径（`![](./shot.png)`）变成一个能塞进 `<img>` 的 data URL。
 *
 * 为什么不直接在渲染层读文件：渲染层没有文件系统权限，也不该有。模型输出的文本
 * 不可信，所以这里做三道闸 —— 扩展名白名单、必须是普通文件且不超过 32MB、
 * 相对路径只能落在工作区里（`../../windows/system32` 这种直接拒掉）。
 */
export function imagePreview(
  rawPath: string,
  base: string | null,
  edge = 1280
): { ok: boolean; url?: string; error?: string } {
  let raw = String(rawPath ?? '').trim()
  if (!raw) return { ok: false, error: '空路径' }
  raw = raw.replace(/^file:\/\//i, '')
  // file:///C:/x.png 去掉协议后是 /C:/x.png，path.resolve 会拼成 C:\C:\…
  if (/^\/[a-z]:[\\/]/i.test(raw)) raw = raw.slice(1)
  try {
    raw = decodeURI(raw)
  } catch {
    // 有裸 % 的路径很常见（比如「100%.png」），保留原样就行
  }

  const abs = path.resolve(base ?? process.cwd(), raw)
  /**
   * 先判越界，再碰文件。顺序反了会泄露信息：一个工作区外的路径，
   * 「文件不存在」和「路径不在工作区内」这两种回答能让人试出盘上有没有这个文件。
   */
  if (!path.isAbsolute(raw) && base) {
    const root = path.resolve(base)
    if (!abs.startsWith(root + path.sep) && abs !== root) {
      return { ok: false, error: '路径不在工作区内' }
    }
  }

  // 扩展名 / 普通文件 / 体积上限：与缩略图共用同一套判定
  const bad = checkImageFile(abs)
  if (bad) return { ok: false, error: bad }

  let stamp = ''
  try {
    const st = fs.statSync(abs)
    stamp = `${st.size}:${Math.floor(st.mtimeMs)}`
  } catch {
    return { ok: false, error: '文件不存在' }
  }

  const key = `${abs}|${stamp}|${edge}`
  if (previewCache.has(key)) {
    const hit = previewCache.get(key) ?? null
    return hit ? { ok: true, url: hit } : { ok: false, error: '解码失败' }
  }

  let url: string | null = null
  try {
    const img = nativeImage.createFromPath(abs)
    if (!img.isEmpty()) {
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
      // png 原样保留（截图里常有透明和细字，转 jpeg 会糊），其余压成 jpeg 省内存
      if (path.extname(abs).slice(1).toLowerCase() === 'png') {
        const buf = out.toPNG()
        url = buf.length ? `data:image/png;base64,${buf.toString('base64')}` : null
      }
      if (!url) {
        const buf = out.toJPEG(85)
        url = buf.length ? `data:image/jpeg;base64,${buf.toString('base64')}` : null
      }
    }
  } catch {
    url = null
  }

  if (previewCache.size > 48) previewCache.clear()
  previewCache.set(key, url)
  return url ? { ok: true, url } : { ok: false, error: '解码失败' }
}
