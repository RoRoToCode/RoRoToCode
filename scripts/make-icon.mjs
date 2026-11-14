/**
 * 生成应用图标（build/icon.png）+ 托盘小图（build/tray.png）。
 *
 * 为什么要自己画：项目里原本没有任何图标文件，BrowserWindow 与 Tray 都拿不到图，
 * 托盘就成了一个「透明图标」——窗口一关，用户既看不到托盘入口，也找不到后台进程。
 *
 * 画的是本程序的调性：深色圆角方块 + 终端提示符（>_），主色取界面的 --accent。
 * 纯像素计算 + SDF 抗锯齿，不依赖 canvas / sharp，`node scripts/make-icon.mjs` 即可重生成。
 */
import { deflateSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

const OUT_DIR = path.join(process.cwd(), 'build')
const SIZE = 512

/* ---------- 颜色 ---------- */
const BG_TOP = [26, 30, 40]
const BG_BOTTOM = [10, 11, 14]
const ACCENT = [110, 168, 254] // 与 styles.css 的 --accent 一致
const GLYPH = [244, 247, 255]

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** 圆角矩形的有符号距离：内部为负 */
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r)
  const qy = Math.abs(y - cy) - (hh - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

/** 点到线段的距离（用于画笔画） */
function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const len2 = vx * vx + vy * vy || 1
  const t = clamp01((wx * vx + wy * vy) / len2)
  return Math.hypot(wx - vx * t, wy - vy * t)
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ]
}

/**
 * 渲染成 RGBA 像素缓冲。
 * glyph：提示符的放大倍数——托盘图标只有 16 px（逻辑），按 512 的比例画会糊成一团，
 * 所以要单独放大字重、放大笔画。
 */
function render(size, glyph = 1) {
  const px = Buffer.alloc(size * size * 4)
  const s = (size / 512) * glyph // 以 512 为设计基准缩放所有几何量
  const cx = size / 2
  const cy = size / 2
  const half = size / 2 - 4 * (size / 512)
  const radius = 108 * (size / 512)
  const stroke = 34 * s

  // 提示符折线：> 的两段 + 后面一条下划线（围绕画布中心放大）
  const gx = (x) => size / 2 + (x - 256) * s
  const gy = (y) => size / 2 + (y - 256) * s
  const chevA = [gx(185), gy(184)]
  const chevB = [gx(296), gy(256)]
  const chevC = [gx(185), gy(328)]
  const barA = [gx(318), gy(340)]
  const barB = [gx(384), gy(340)]

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const p = { x: x + 0.5, y: y + 0.5 }

      // 背景：圆角方块 + 纵向渐变
      const d = sdRoundRect(p.x, p.y, cx, cy, half, half, radius)
      const aBg = clamp01(0.5 - d)
      if (aBg <= 0) {
        px[i + 3] = 0
        continue
      }
      const t = clamp01((p.y - 4 * (size / 512)) / (size - 8 * (size / 512)))
      let col = mix(BG_TOP, BG_BOTTOM, t)

      // 内描边：一圈若有若无的亮边，让图标在深色任务栏上不糊成一团
      const ring = Math.abs(d + 2.5 * (size / 512)) - 1.2 * (size / 512)
      const aRing = clamp01(0.5 - ring) * 0.10
      if (aRing > 0) col = mix(col, [255, 255, 255], aRing)

      // 折线 > 与下划线
      const dChev = Math.min(
        sdSegment(p.x, p.y, chevA[0], chevA[1], chevB[0], chevB[1]),
        sdSegment(p.x, p.y, chevB[0], chevB[1], chevC[0], chevC[1])
      )
      const dBar = sdSegment(p.x, p.y, barA[0], barA[1], barB[0], barB[1])
      const aChev = clamp01(0.5 + stroke / 2 - dChev)
      const aBar = clamp01(0.5 + stroke / 2 - dBar)
      if (aChev > 0) col = mix(col, GLYPH, aChev)
      if (aBar > 0) col = mix(col, ACCENT, aBar)

      px[i] = col[0]
      px[i + 1] = col[1]
      px[i + 2] = col[2]
      px[i + 3] = Math.round(aBg * 255)
    }
  }
  return px
}

/* ---------- 最小 PNG 编码器 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const big = render(SIZE)
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), encodePng(big, SIZE))
// 托盘小图直接按 32 px 渲染并放大字重（不缩小大图，缩小后笔画就散了）
fs.writeFileSync(path.join(OUT_DIR, 'tray.png'), encodePng(render(32, 1.32), 32))
console.log(`[icon] build/icon.png (${SIZE}×${SIZE})、build/tray.png (32×32) 已生成`)
