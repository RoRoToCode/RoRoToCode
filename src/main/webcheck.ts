import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 「打开验收」：把产出的网页真的加载一遍。
 *
 * 为什么要有这个模块：`htmlcheck` 只查内联脚本的语法，语法过关但页面白屏、
 * 变量名拼错在运行时才炸、资源路径写错 —— 这些它一个都报不出来。模型于是
 * 一路带着「我觉得能跑」往下写，直到最后用户打开发现什么都没有。
 *
 * 本程序自己就是 Electron，主进程里开一个隐藏窗口就能充当浏览器，不需要
 * puppeteer、不需要下载 Chromium、不需要联网。这是它相对外置工具唯一的结构性便宜。
 *
 * 判定原则（2026-11 修订）：**「不报错」不等于「在跑」，探针必须参与判定。**
 *
 * 起因是一次实测：7 个产物语法全过、控制台全干净，其中 2 个是死的 ——
 * 一个 `init()` 定义了从没被调用（画布 0 像素、按键无反应、得分恒 0），
 * 一个球画出来了但完全静止。这类 bug 不会抛错、不会白屏，只会「安静地什么都不做」，
 * 靠 console 永远抓不到，人打开才能发现。
 *
 * 所以现在分三级：
 *   1. 硬失败（必改）：控制台 error / 加载失败 / 渲染崩溃；
 *   2. 硬失败（必改）：canvas 存在但首帧一个像素都没画；
 *   3. 硬失败（必改）：画面静止 + 页面确实绑了交互 → 模拟一轮输入，前后毫无变化。
 * 第 3 条要求「源码里确实有事件监听」才触发，避免把「画一张静态图」误判成死页面；
 * 而 animated 由 rAF 判定、在隐藏窗口里可能不准，所以只把它当作「要不要做输入探测」的
 * 触发条件，最终以输入前后是否真的变化为准。
 */

/** 与页面本身是否跑起来无关的噪音：留着只会把模型带偏 */
const NOISE: RegExp[] = [
  /favicon\.ico/i,
  /Autoplay is only allowed/i,
  /AudioContext was not allowed to start/i,
  /Download the React DevTools/i,
  /DevTools failed to load source map/i,
  /Electron Security Warning/i,
  /net::ERR_ABORTED/i,
  /Unchecked runtime\.lastError/i
]

/** 单个文件最多等多久拿到 domcontentloaded/did-finish-load */
const LOAD_TIMEOUT_MS = 8000
/** 加载完再等一会儿，让首帧和启动逻辑跑出来 */
const SETTLE_MS = 700
/** 探针本身的时间上限 */
const PROBE_TIMEOUT_MS = 2500
/** 模拟输入之后等多久再看画面：短于一轮游戏 tick 会误判成「没反应」 */
const AFTER_NUDGE_MS = 1100
/**
 * 打开之后的观察窗：盯着首屏，看它在这段时间里发生了什么。
 *
 * 为什么不是「等到画面稳定」：那样会把正常游戏等死。打砖块一打开就发球，
 * 玩家不接住，三秒后球落地、弹结算 —— 如果等到稳定再判断，它就成了「打开就是结束」。
 * 而这个游戏其实完全正常，只是没人操作而已。
 *
 * 所以窗口固定为 1.6 秒，语义很明确：**人类还没来得及按第一个键的这段时间**。
 * 在这段时间里就跑出结算遮罩，说明它根本没给玩家机会（贪吃蛇 1 秒撞墙就是这种）。
 * 窗口内画面一直在变，说明它自己在正常推进，放行。
 */
const START_WATCH_MS = 1600
const START_STEP_MS = 250
/**
 * 一次最多验几个文件。
 * 3 的旧值会让「改完一串文件再复验」只验到前三个，剩下的一直没被打开过；
 * 但逐个开窗口是有代价的（每个约 2s），所以给个够用的上限而不是无限。
 */
const MAX_FILES = 8
/** 画布上至少要有这么多不透明像素才算「画了东西」：单个光标点不该算 */
const MIN_PAINTED_PIXELS = 30

export interface WebProbe {
  readyState: string
  canvasCount: number
  /** 首帧不透明像素数（抽样区域，不是全画布） */
  pixels: number
  painted: boolean
  animated: boolean
  /**
   * 页面上的 WebGL / WebGPU 画布数量。
   * 这类画布的像素只能在帧内 drawImage 取到，取不到时不能当成「画布是空的」。
   */
  glCanvasCount?: number
  /** 其中成功采样到的个数；小于 glCanvasCount 说明有画布读不到像素 */
  glSampled?: number
  /**
   * 是否「活着」：有画面且在动，或对模拟输入做出了反应。
   * undefined 表示没测（无 canvas / 环境不支持），不是失败。
   */
  alive?: boolean
  /** 模拟输入前后的画面确实变了 */
  responded?: boolean
  /** 动画在首帧之后仍在持续（false = 动了一下就停住了） */
  sustained?: boolean
  /** 首屏就盖着「游戏结束 / 最终得分 / 重开」这类遮罩时的原文 */
  endScreen?: string
  /**
   * 布局健康度（客观统计，供无视觉模型做降级判定）：
   * 溢出视口、字体过小、点击目标过小、文本溢出这些数字，纯文本模型也能据此定位布局问题。
   */
  layoutIssues?: string[]
}

export interface WebCheckResult {
  file: string
  ok: boolean
  errors: string[]
  warnings: number
  probe?: WebProbe
  /** 环境不具备（非 Electron、app 未就绪）：调用方应当当作「没查」，不是「没通过」 */
  skipped?: 'no-electron' | 'not-ready'
  timedOut?: boolean
  /**
   * 截屏落盘后的**相对工作区路径**（如 `.roroto/shots/xxx.png`）。
   * 视觉验证闭环：光有「探针说画布有像素」不够，布局错位、配色字号、
   * 非 canvas 的 DOM 这些探针全看不见 —— 把截图交给视觉模型才查得出。
   * 没截到（环境不支持 / 页面没加载）就是 undefined。
   */
  shot?: string
}

type ElectronLike = {
  app?: { isReady?: () => boolean }
  BrowserWindow?: new (opts: Record<string, unknown>) => BrowserWindowLike
}

type WebContentsLike = {
  on: (ev: string, fn: (...args: unknown[]) => void) => void
  once: (ev: string, fn: (...args: unknown[]) => void) => void
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>
}

type BrowserWindowLike = {
  webContents: WebContentsLike
  loadURL: (url: string) => Promise<void>
  destroy: () => void
}

/** capturePage 挂在 webContents 上（不是 window），单独声明 */
type WebContentsWithCapture = WebContentsLike & {
  capturePage?: (rect?: { x: number; y: number; width: number; height: number }) => Promise<unknown>
}

/**
 * 只在主进程里拿得到真模块。
 * 单测跑在普通 node 下，`require('electron')` 返回的是可执行文件路径字符串，
 * 不是模块 —— 这里返回 null，调用方据此走 skipped，而不是把测试搞崩。
 */
function electronModule(): ElectronLike | null {
  try {
    // 必须动态 require：编译成 CJS 后，node 单测里 'electron' 解析成可执行文件路径字符串，
    // electron 主进程里才是真模块。静态 import 拿不到「整个 module 对象」(BrowserWindow + app)，
    // 也无法在两种环境下都安全地探测可用性。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('electron') as unknown as ElectronLike
    return m && typeof m === 'object' && typeof m.BrowserWindow === 'function' ? m : null
  } catch {
    return null
  }
}

function normLevel(raw: unknown): 'error' | 'warning' | 'info' {
  if (typeof raw === 'number') return raw >= 3 ? 'error' : raw === 2 ? 'warning' : 'info'
  const s = String(raw ?? '').toLowerCase()
  if (s === 'error') return 'error'
  if (s === 'warning' || s === 'warn') return 'warning'
  return 'info'
}

/**
 * `console-message` 的参数形状在 Electron 大版本之间变过：
 * 旧的是 (event, level:number, message, line, sourceId)，新的是 (event, details)。
 * 两种都认，免得升级 Electron 之后验收静默失效 —— 静默失效比报错更糟。
 */
function readConsole(args: unknown[]): { level: 'error' | 'warning' | 'info'; message: string; line: number } | null {
  for (const a of args) {
    if (a && typeof a === 'object' && typeof (a as { message?: unknown }).message === 'string') {
      const d = a as { message: string; level?: unknown; lineNumber?: unknown }
      return { level: normLevel(d.level), message: d.message, line: Number(d.lineNumber ?? 0) }
    }
  }
  const i = args.findIndex((a) => typeof a === 'number')
  if (i >= 0 && typeof args[i + 1] === 'string') {
    return { level: normLevel(args[i]), message: String(args[i + 1]), line: Number(args[i + 2] ?? 0) }
  }
  return null
}

/** 带清理的超时：直接用 Promise.race 会留下未清的定时器，拖住进程退出 */
function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      () => {
        clearTimeout(t)
        resolve(null)
      }
    )
  })
}

/**
 * 页面内探针。
 *
 * 只读取事实，不修改页面。rAF 用「等两帧」来判，等不到就报 false ——
 * 调用方不会因为它 false 就判定失败。
 */
const PROBE_JS = `(async () => {
  const animated = await new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; resolve(false) } }, 400)
    try {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!done) { done = true; clearTimeout(timer); resolve(true) }
      }))
    } catch (e) { if (!done) { done = true; clearTimeout(timer); resolve(false) } }
  })
  const canvases = Array.from(document.querySelectorAll('canvas'))
  // 采样必须在 requestAnimationFrame 回调里做。
  // WebGL 画布默认 preserveDrawingBuffer=false：合成之后绘制缓冲就被丢弃了，
  // 帧外去读只能是「getContext('2d') 返回 null」、「readPixels 全 0」、「drawImage 全空」三种空结果。
  // 只有在 rAF 回调内（本帧刚画完、还没合成交换）drawImage 才拿得到真实画面。
  // 这一点是实测出来的：同一个 WebGL 画布，帧外 drawImage 得 0 像素，帧内得满屏像素。
  const sampled = await new Promise((resolve) => {
    const run = () => {
      let pixels = 0
      let glCanvasCount = 0
      let glSampled = 0
      let off = null
      let octx = null
      for (const c of canvases) {
        if (!c.width || !c.height) continue
        let g = null
        try { g = c.getContext && c.getContext('2d') } catch (e) { g = null }
        try {
          let data = null
          let w = c.width
          let h = c.height
          if (g) {
            // 2D 画布：直接读回像素
            data = g.getImageData(0, 0, w, h).data
          } else {
            // WebGL / WebGPU 等：借离屏 2D 画布把当前帧 drawImage 出来再读
            glCanvasCount++
            if (!octx) {
              off = document.createElement('canvas')
              octx = off.getContext('2d', { willReadFrequently: true })
            }
            if (!octx) continue
            if (off.width !== w) off.width = w
            if (off.height !== h) off.height = h
            octx.clearRect(0, 0, w, h)
            octx.drawImage(c, 0, 0)
            data = octx.getImageData(0, 0, w, h).data
            glSampled++
          }
          // 必须整幅采样：只看左上角会把「内容画在中央/右下」误判成空画布。
          // 大画布用步长跳采，够判断有没有内容，又不必逐像素扫。
          const stride = Math.max(4, Math.floor((w * h) / 80000) * 4)
          for (let i = 3; i < data.length; i += stride) {
            if (data[i] !== 0) pixels++
          }
        } catch (e) {}
      }
      resolve({ pixels, glCanvasCount, glSampled })
    }
    try { requestAnimationFrame(run) } catch (e) { run() }
  })
  const pixels = sampled.pixels
  const glCanvasCount = sampled.glCanvasCount
  const glSampled = sampled.glSampled
  // 首屏是不是已经盖着「结算/结束」遮罩？
  // 判据用「画布正中命中的元素及其祖先」，比按面积猜准得多：
  // 「按空格开始游戏」这类开场遮罩不该命中，只有「游戏结束 / 最终得分 / 重开」才算。
  let endScreen = ''
  try {
    const c = document.querySelector('canvas')
    if (c) {
      const r = c.getBoundingClientRect()
      let el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
        const t = (el.innerText || '').replace(/\\s+/g, ' ').trim()
        if (t && t.length <= 120 && /游戏结束|游戏失败|你输了|最终得分|Game\\s*Over|You\\s*(Lost|Died)|重新开始|再来一次/i.test(t)) {
          endScreen = t.slice(0, 80)
          break
        }
        if (el === document.body) break
      }
    }
  } catch (e) {}
  // 布局健康度：无视觉模型的客观降级判定。
  // 视觉模型能直接看图，纯文本模型只能看这一串统计 —— 所以要尽量给出
  // 能独立定位问题的客观数字：溢出视口、字体过小、点击目标过小、文本溢出。
  let layoutIssues = []
  try {
    const vw = window.innerWidth || document.documentElement.clientWidth || 900
    const vh = window.innerHeight || document.documentElement.clientHeight || 600
    const els = Array.from(document.querySelectorAll('button, a, input, textarea, select, [role="button"], h1, h2, h3, p, span, div')).slice(0, 400)
    let overflow = 0, tinyFont = 0, tinyTarget = 0, clipped = 0
    const samples = []
    for (const el of els) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      // 可交互元素溢出视口（整块在视口外）
      const interactive = /^(button|a|input|textarea|select)$/i.test(el.tagName) || el.getAttribute('role') === 'button'
      if (interactive && (r.right < 0 || r.left > vw || r.bottom < 0 || r.top > vh)) overflow++
      // 字体过小：可见文字小于 9px 通常就是布局塌了
      if (el.innerText && el.innerText.trim()) {
        const cs = getComputedStyle(el)
        const fs = parseFloat(cs.fontSize || '0')
        if (fs > 0 && fs < 9) tinyFont++
      }
      // 点击目标过小：按钮/链接小于 24x24 或高小于 20
      if (interactive && r.width > 0 && (r.width < 24 || r.height < 20)) tinyTarget++
      // 文本溢出：scrollWidth 明显大于 clientWidth 且没有省略号
      if (el.scrollWidth > el.clientWidth + 4 && el.clientWidth > 0 && el.innerText && el.innerText.trim().length > 4) clipped++
      if (samples.length < 3 && (overflow || tinyFont || tinyTarget || clipped) && el.innerText) {
        samples.push('「' + el.innerText.trim().slice(0, 24) + '」')
      }
    }
    if (overflow) layoutIssues.push(overflow + ' 个可交互元素整块落在视口外')
    if (tinyFont) layoutIssues.push(tinyFont + ' 处可见文字字号小于 9px')
    if (tinyTarget) layoutIssues.push(tinyTarget + ' 个按钮/链接点击目标过小（<24px 或 <20px 高）')
    if (clipped) layoutIssues.push(clipped + ' 处文本溢出被裁切' + (samples.length ? '（如 ' + samples.join('、') + '）' : ''))
  } catch (e) {}
  return {
    readyState: document.readyState,
    canvasCount: canvases.length,
    pixels,
    painted: pixels >= 30,
    animated,
    endScreen,
    glCanvasCount,
    glSampled,
    layoutIssues
  }
})()`

/**
 * 画面指纹：把每块 canvas 的抽样像素折成一个数，外加整页文字和「首屏结算遮罩」。
 * 只用来比较「有没有变化」，不做任何渲染判断。
 */
const SNAP_JS = `(async () => {
  const cs = Array.from(document.querySelectorAll('canvas'))
  // 与 PROBE_JS 同理：WebGL 画布的像素只能在 rAF 回调内 drawImage 取到，
  // 否则指纹恒等于初值，任何 WebGL 页面都会被判成「对输入毫无反应」。
  const fp = await new Promise((resolve) => {
    const run = () => {
      let h = 7, n = 0
      let off = null, octx = null
      for (const c of cs) {
        if (!c.width || !c.height) continue
        try {
          const g = c.getContext && c.getContext('2d')
          let data = null
          const w = c.width, hh = c.height
          if (g) {
            // 同样整幅采样：只比左上角会漏掉画布中央发生的变化
            data = g.getImageData(0, 0, w, hh).data
          } else {
            if (!octx) {
              off = document.createElement('canvas')
              octx = off.getContext('2d', { willReadFrequently: true })
            }
            if (!octx) continue
            if (off.width !== w) off.width = w
            if (off.height !== hh) off.height = hh
            octx.clearRect(0, 0, w, hh)
            octx.drawImage(c, 0, 0)
            data = octx.getImageData(0, 0, w, hh).data
          }
          const stride = Math.max(4, Math.floor((w * hh) / 80000) * 4)
          for (let i = 0; i < data.length; i += stride) {
            if (data[i + 3]) n++
            h = (h * 31 + data[i] + data[i + 1] * 3 + data[i + 2] * 7 + data[i + 3]) % 2147483647
          }
        } catch (e) {}
      }
      resolve({ h, n })
    }
    try { requestAnimationFrame(run) } catch (e) { run() }
  })
  const h = fp.h
  const n = fp.n
  const text = document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400) : ''
  let endScreen = ''
  try {
    const c = document.querySelector('canvas')
    if (c) {
      const r = c.getBoundingClientRect()
      let el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
        const t = (el.innerText || '').replace(/\\s+/g, ' ').trim()
        if (t && t.length <= 120 && /游戏结束|游戏失败|你输了|最终得分|Game\\s*Over|You\\s*(Lost|Died)|重新开始|再来一次/i.test(t)) {
          endScreen = t.slice(0, 80)
          break
        }
        if (el === document.body) break
      }
    }
  } catch (e) {}
  return { h, n, text, title: document.title || '', endScreen }
})()`

/**
 * 模拟一轮操作：方向键、空格、回车、字母键各按一次，再点一下画布中心。
 * 用合成事件而不是 webContents.sendInputEvent —— 后者要算窗口内坐标，
 * 页面一缩放就点偏，而合成事件直接命中元素，且不依赖窗口是否可见。
 *
 * 故意不按 R（很多实现里 R 是重开，会把验证搅乱）。
 */
const NUDGE_JS = `(async () => {
  const keys = [
    { key: 'ArrowUp', code: 'ArrowUp', kc: 38 },
    { key: 'ArrowDown', code: 'ArrowDown', kc: 40 },
    { key: 'ArrowLeft', code: 'ArrowLeft', kc: 37 },
    { key: 'ArrowRight', code: 'ArrowRight', kc: 39 },
    { key: ' ', code: 'Space', kc: 32 },
    { key: 'Enter', code: 'Enter', kc: 13 },
    { key: 'a', code: 'KeyA', kc: 65 }
  ]
  const fire = (target, type, key) => {
    if (!target) return
    let ev
    try {
      ev = new KeyboardEvent(type, { key: key.key, code: key.code, bubbles: true, cancelable: true })
      Object.defineProperty(ev, 'keyCode', { get: () => key.kc })
      Object.defineProperty(ev, 'which', { get: () => key.kc })
    } catch (e) { return }
    try { target.dispatchEvent(ev) } catch (e) {}
  }
  for (const k of keys) {
    for (const t of [document, window, document.body]) {
      fire(t, 'keydown', k)
      fire(t, 'keyup', k)
    }
    await new Promise(r => setTimeout(r, 60))
  }
  // 先把「开始 / 继续 / Play」这类按钮点掉。
  // 带开始界面的游戏是很常见的写法，而开始按钮通常盖在 canvas 上、
  // 并不是 canvas 的子元素 —— 只点画布中心永远点不到它，
  // 于是游戏停在开始界面、画面纹丝不动，被误判成「对输入毫无反应」。
  const START_RE = /开始|继续|进入|出发|start|play|resume/i
  try {
    const cands = Array.from(document.querySelectorAll(
      'button, [role="button"], input[type="button"], input[type="submit"], .btn, .button'
    ))
    for (const b of cands) {
      const t = String(b.innerText || b.value || b.textContent || '').replace(/\s+/g, ' ').trim()
      if (!t || t.length > 24) continue
      if (!START_RE.test(t)) continue
      let vis = false
      try {
        const r = b.getBoundingClientRect()
        const cs = getComputedStyle(b)
        vis = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'
      } catch (e) { vis = false }
      if (!vis) continue
      try { b.click() } catch (e) {}
      await new Promise(r => setTimeout(r, 250))
    }
  } catch (e) {}
  const c = document.querySelector('canvas') || document.body
  let x = 200, y = 200
  try {
    const r = c.getBoundingClientRect()
    x = r.left + r.width / 2
    y = r.top + r.height / 2
  } catch (e) {}
  for (const type of ['mousedown', 'mouseup', 'click']) {
    try {
      c.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, view: window }))
    } catch (e) {}
  }
  return true
})()`

/** 页面里是否绑了交互：没绑的话「画面不动」可能只是静态图，不该判死 */
const INTERACTIVE_RE =
  /addEventListener\s*\(|onkeydown|onkeyup|onclick|onmousedown|onmouseup|ontouchstart|pointerdown|requestAnimationFrame|setInterval/i

function readSource(p: string): string {
  try {
    const st = fs.statSync(p)
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return ''
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

interface Snap {
  h: number
  n: number
  text: string
  title: string
  endScreen: string
}

async function snap(wc: WebContentsLike): Promise<Snap | null> {
  const got = await raceTimeout(wc.executeJavaScript(SNAP_JS, true), PROBE_TIMEOUT_MS)
  if (!got || typeof got !== 'object') return null
  const s = got as Record<string, unknown>
  return {
    h: Number(s.h ?? 0),
    n: Number(s.n ?? 0),
    text: String(s.text ?? ''),
    title: String(s.title ?? ''),
    endScreen: String(s.endScreen ?? '')
  }
}

export const EMPTY_CANVAS_ERROR =
  '画布是空的：页面加载完了，canvas 上一个不透明像素都没有。这通常是在脚本末尾漏了初始化调用 —— ' +
  '检查 init() / start() / setup() 这类函数是不是只有定义、从来没有被调用过。'

export const NO_RESPONSE_ERROR =
  '画面完全没有反应：模拟了方向键、空格、回车、字母键和一次点击之后，画布内容和页面文字与之前一模一样。' +
  '说明交互没有真正接上 —— 常见原因是事件监听绑上了但驱动状态的定时器/动画循环没启动、' +
  '或者按键判断用的键名与事件里的不一致（e.key / e.code / e.keyCode 三者的取值不同）。'

export interface AliveInput {
  canvasCount: number
  pixels: number
  animated: boolean
  /** 源码里是否绑了交互或定时器 */
  interactive: boolean
  /** 模拟输入后画面是否变化；undefined = 还没测 */
  changed?: boolean
  /**
   * 读不到像素的 WebGL 画布数量。
   * 没开 preserveDrawingBuffer 的画布在帧外只能读成空，「0 像素」是测量失败而不是证据，
   * 所以这个值 > 0 时不许以「画布是空的」判死。
   */
  glUnreadable?: number
}

export interface AliveVerdict {
  /** true 活 / false 死 / undefined 不判定（没有 canvas，或只是静态图） */
  alive?: boolean
  error?: string
  /** 需要再模拟一轮输入才能定论 */
  needsNudge?: boolean
}

/**
 * 纯判定：不碰窗口、不碰文件，好处是能在 node 下直接单测。
 * 这是整套验收里唯一「会冤枉人」的地方，所以规则要能被逐条钉住。
 */
export function decideAlive(i: AliveInput): AliveVerdict {
  if (i.canvasCount === 0) return { alive: undefined }

  // WebGL 画布没开 preserveDrawingBuffer 时，帧外必然读成 0 像素 —— 那是测量失败，不是证据。
  // 在这种情况下，「像素为空」不足以判死，只能靠动画和「对输入有没有反应」来判断。
  const unreadable = (i.glUnreadable ?? 0) > 0

  if (i.pixels < MIN_PAINTED_PIXELS && !unreadable) {
    return { alive: false, error: EMPTY_CANVAS_ERROR }
  }
  if (i.animated) return { alive: true }
  // 没有动画、源码里也没绑任何事件：可能只是一张静态图，不该判死
  if (!i.interactive) return { alive: undefined }
  if (i.changed === undefined) return unreadable ? { alive: undefined } : { needsNudge: true }
  if (i.changed) return { alive: true }
  return unreadable ? { alive: undefined } : { alive: false, error: NO_RESPONSE_ERROR }
}

export const END_SCREEN_ERROR =
  '打开就已经结束了：首屏画布上盖着结算遮罩，玩家还没开始操作游戏就已经处于结束状态。' +
  '通常是一开场的自动推进逻辑立刻跑到底（比如角色不等输入就朝一个方向走，直到撞墙）。' +
  '应当从「等待第一次按键」的初始状态进入，而不是加载后立刻开始计时/移动。'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface StartWatch {
  snap: Snap | null
  /** 窗口内画面变化过：它自己在推进 */
  moved: boolean
  /** 窗口内出现了结算遮罩 */
  endScreen?: string
}

/**
 * 盯首屏一段时间。
 *
 * 原先的做法是「等到画面稳定再发输入」，结果把正常游戏等死了：打砖块打开就发球，
 * 三秒后球落地弹结算，被误判成「打开就结束」。所以等待不看「稳不稳」，
 * 只看「人类还来不及动手的这段时间里发生了什么」。
 */
async function watchStart(wc: WebContentsLike, windowMs: number): Promise<StartWatch | null> {
  let prev = await snap(wc)
  if (!prev) return null
  if (prev.endScreen) return { snap: prev, moved: false, endScreen: prev.endScreen }
  let moved = false
  const t0 = Date.now()
  while (Date.now() - t0 < windowMs) {
    await sleep(START_STEP_MS)
    const cur = await snap(wc)
    if (!cur) break
    if (cur.endScreen) return { snap: cur, moved, endScreen: cur.endScreen }
    if (cur.h !== prev.h || cur.text !== prev.text || cur.title !== prev.title) moved = true
    prev = cur
  }
  return { snap: prev, moved }
}

/**
 * 判定「这个页面到底有没有在跑」。
 *
 * 顺序（从确定到不确定，每步都能单独放行或判死）：
 *   1. canvas 一个像素都没画 → 死。初始化根本没执行；
 *   2. 等画面稳定。期间冒出结算遮罩（「游戏结束 / 最终得分 / 重开」）→ 死：
 *      用户打开看到的是「你输了」，这不能算能用；
 *   3. 一直不稳定（画面持续在变）→ 活，它本来就在跑；
 *   4. 稳定下来、源码里也没绑任何交互 → 当作静态图，放行（画一张图是合法产物）；
 *   5. 稳定 + 绑了交互 → 发一轮输入；有变化 → 活，没变化 → 死。
 */
async function judgeAlive(
  wc: WebContentsLike,
  absPath: string,
  probe: WebProbe,
  errors: string[]
): Promise<void> {
  // 没有 canvas 的页面（文档、表单）不归这套规则管
  if (probe.canvasCount === 0) return

  // 有的画布读不到像素（典型：没开 preserveDrawingBuffer 的 WebGL）
  const glUnreadable = Math.max(0, (probe.glCanvasCount ?? 0) - (probe.glSampled ?? 0))

  const gate = decideAlive({
    canvasCount: probe.canvasCount,
    pixels: probe.pixels,
    animated: false,
    interactive: true,
    glUnreadable
  })
  if (gate.error) {
    probe.alive = false
    errors.push(gate.error)
    return
  }

  const w = await watchStart(wc, START_WATCH_MS)
  if (!w || !w.snap) return

  if (w.endScreen) {
    probe.endScreen = w.endScreen
    probe.alive = false
    errors.push(END_SCREEN_ERROR)
    return
  }

  if (w.moved) {
    // 首屏就在自己推进：说明游戏已经在跑（打砖块、跑酷都属这一类）
    probe.sustained = true
    probe.alive = true
    return
  }

  if (w.snap.n < MIN_PAINTED_PIXELS) {
    // 像素读不到时，「看起来是空的」不构成证据 —— 宁可放行，也不能冤枉一个 WebGL 页面
    if (glUnreadable > 0) {
      probe.alive = undefined
      return
    }
    probe.alive = false
    errors.push(EMPTY_CANVAS_ERROR)
    return
  }

  if (!INTERACTIVE_RE.test(readSource(absPath))) {
    // 首屏静止、有内容、没绑交互：静态图，不判死
    probe.alive = true
    return
  }

  const before = w.snap
  await raceTimeout(wc.executeJavaScript(NUDGE_JS, true), PROBE_TIMEOUT_MS * 2)
  await sleep(AFTER_NUDGE_MS)
  const after = await snap(wc)
  if (!after) return

  const changed = before.h !== after.h || before.text !== after.text || before.title !== after.title
  probe.responded = changed
  probe.alive = changed
  if (!changed) errors.push(NO_RESPONSE_ERROR)
}

/**
 * 截屏落盘目录：工作区里的 `.roroto/shots/`。
 *
 * 选这里而不是临时目录，是因为模型的 `read_file` 只能读到工作区里（safePath 限制），
 * 而视觉闭环要的就是「让模型下一轮自己打开这张图看」。`.roroto` 已在 artifacts 忽略
 * 列表里，不污染交付目录，收工时也不被 hygiene 当垃圾挪走。
 */
const SHOTS_DIR = '.roroto/shots'

async function checkOne(
  BW: NonNullable<ElectronLike['BrowserWindow']>,
  absPath: string,
  shotDir?: string
): Promise<WebCheckResult> {
  const errors: string[] = []
  let warnings = 0
  let probe: WebProbe | undefined
  let timedOut = false
  let finished = false
  let shot: string | undefined

  const win = new BW({
    show: false,
    width: 900,
    height: 600,
    webPreferences: {
      // 隐藏窗口默认会被降频，动画和定时器都会变慢；关掉才能看到真实的启动行为
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  try {
    const wc = win.webContents

    wc.on('console-message', (...args: unknown[]) => {
      const msg = readConsole(args)
      if (!msg) return
      if (NOISE.some((re) => re.test(msg.message))) return
      if (msg.level === 'warning') {
        warnings += 1
        return
      }
      if (msg.level !== 'error') return
      const text = msg.line ? `${msg.message}（第 ${msg.line} 行）` : msg.message
      if (!errors.includes(text)) errors.push(text)
    })

    wc.on('did-fail-load', (...args: unknown[]) => {
      // (event, errorCode, errorDescription, validatedURL, isMainFrame)
      const code = Number(args[1] ?? 0)
      const desc = String(args[2] ?? '')
      const url = String(args[3] ?? '')
      const isMain = args[4] === undefined ? true : args[4] !== false
      if (!isMain) return
      // -3 是 ABORTED：多半是页面自己又跳了一次，不当失败
      if (code === -3) return
      errors.push(`页面加载失败：${desc || code}${url ? `（${url}）` : ''}`)
    })

    wc.on('render-process-gone', (...args: unknown[]) => {
      const d = args[1] as { reason?: string } | undefined
      errors.push(`渲染进程崩溃：${d?.reason ?? 'unknown'}`)
    })

    const loaded = new Promise<void>((resolve) => {
      const done = () => {
        finished = true
        resolve()
      }
      wc.once('did-finish-load', done)
      wc.once('did-fail-load', done)
    })

    try {
      void win.loadURL(pathToFileURL(absPath).href).catch((err: unknown) => {
        errors.push(`打开失败：${(err as Error)?.message ?? String(err)}`)
        finished = true
      })
    } catch (err) {
      errors.push(`打开失败：${(err as Error)?.message ?? String(err)}`)
      finished = true
    }

    await raceTimeout(loaded, LOAD_TIMEOUT_MS)
    if (!finished) timedOut = true

    if (!timedOut) {
      await new Promise((r) => setTimeout(r, SETTLE_MS))
      const got = await raceTimeout(wc.executeJavaScript(PROBE_JS, true), PROBE_TIMEOUT_MS)
      if (got && typeof got === 'object') {
        const p = got as Record<string, unknown>
        probe = {
          readyState: String(p.readyState ?? ''),
          canvasCount: Number(p.canvasCount ?? 0),
          pixels: Number(p.pixels ?? 0),
          painted: p.painted === true,
          animated: p.animated === true,
          endScreen: String(p.endScreen ?? '') || undefined,
          glCanvasCount: Number(p.glCanvasCount ?? 0),
          glSampled: Number(p.glSampled ?? 0),
          layoutIssues: Array.isArray(p.layoutIssues) ? (p.layoutIssues as string[]) : undefined
        }
        await judgeAlive(wc, absPath, probe, errors)
      }
      // 视觉闭环：无论探针判死判活，都把最终画面截下来，交给视觉模型复核。
      // 探针只能抓「画没画、动不动、对输入有没有反应」，布局错位、配色字号、
      // 非 canvas 的 DOM 结构全靠截图才看得见 —— 那些正是「长得难看但能跑」的 bug。
      if (shotDir) {
        const cap = (wc as WebContentsWithCapture).capturePage
        if (typeof cap === 'function') {
          const img = await raceTimeout(
            cap.call(wc).then((i) => (i && typeof i === 'object' && 'toPNG' in (i as object) ? i : null)),
            PROBE_TIMEOUT_MS
          ).catch(() => null)
          if (img && typeof (img as { toPNG?: unknown }).toPNG === 'function') {
            try {
              const buf = (img as { toPNG: () => Buffer }).toPNG()
              if (buf && buf.length) {
                await fs.promises.mkdir(shotDir, { recursive: true })
                const name = `${path.basename(absPath, path.extname(absPath))}-${Date.now().toString(36)}.png`
                const abs = path.join(shotDir, name)
                await fs.promises.writeFile(abs, buf)
                shot = path.join(SHOTS_DIR, name)
              }
            } catch {
              /* 截屏失败不拦验收：探针结论已经足够 */
            }
          }
        }
      }
    }
  } catch (err) {
    errors.push(`验收过程出错：${(err as Error)?.message ?? String(err)}`)
  } finally {
    try {
      win.destroy()
    } catch {
      /* 窗口已经没了就别再闹 */
    }
  }

  return {
    file: absPath,
    ok: !timedOut && errors.length === 0,
    errors,
    warnings,
    probe,
    timedOut,
    shot
  }
}

/** 环境是否具备「打开验收」的能力（主进程 + app 已就绪） */
export function webCheckAvailable(): boolean {
  const m = electronModule()
  if (!m || typeof m.BrowserWindow !== 'function') return false
  try {
    return m.app?.isReady ? m.app.isReady() === true : true
  } catch {
    return false
  }
}

/**
 * 逐个打开验收。永远不抛错：验收失败不该让整轮工具执行崩掉。
 * 非 Electron 环境（单测、独立 CLI）统一返回 skipped，调用方据此什么都不说。
 */
export async function checkWebPages(absPaths: string[], root?: string): Promise<WebCheckResult[]> {
  const files = absPaths.filter((f) => /\.html?$/i.test(f)).slice(0, MAX_FILES)
  if (!files.length) return []

  const m = electronModule()
  const BW = m && typeof m.BrowserWindow === 'function' ? m.BrowserWindow : null
  if (!BW) {
    return files.map((file) => ({ file, ok: true, errors: [], warnings: 0, skipped: 'no-electron' }))
  }
  if (m?.app?.isReady && m.app.isReady() !== true) {
    return files.map((file) => ({ file, ok: true, errors: [], warnings: 0, skipped: 'not-ready' }))
  }

  // 截屏落盘到工作区 .roroto/shots/：模型能 read_file 够到，视觉闭环才成立
  const shotDir = root ? path.join(root, SHOTS_DIR) : undefined

  const out: WebCheckResult[] = []
  for (const file of files) {
    out.push(await checkOne(BW, file, shotDir))
  }
  return out
}

/** 有没有真正挡住「这一步算做完」的结果 */
export function hasBlockingFailure(results: WebCheckResult[]): boolean {
  return results.some((r) => !r.ok && !r.skipped)
}

function relOf(file: string, root: string): string {
  const rel = path.relative(root, file)
  return (rel && !rel.startsWith('..') ? rel : file).split(path.sep).join('/')
}

/**
 * 回给模型看的验收报告。
 *
 * 通过时也说话 —— 对 9B 来说，「我刚才那一下真的跑起来了」是它没有的反馈，
 * 少了这句它就不知道什么时候该停，只会继续加东西。
 */
export function formatWebCheck(results: WebCheckResult[], root: string): string {
  const lines: string[] = []
  for (const r of results) {
    if (r.skipped) continue
    if (!r.ok) {
      lines.push(
        `【打开验收·未通过】${relOf(r.file, root)} 打开后没有真正跑起来（${r.errors.length} 处）：`
      )
      for (const e of r.errors.slice(0, 6)) lines.push(`  - ${e}`)
      if (r.errors.length > 6) lines.push(`  - 其余 ${r.errors.length - 6} 处略`)
      if (r.timedOut) lines.push('  - 还有：页面在 8 秒内没有加载完成')
      if (r.shot) lines.push(`  - 已截图：${r.shot}（如果页面有画面，用 read_file 打开看实际样子）`)
      lines.push(
        '语法检查通过、控制台没报错，都不能说明它能用 —— 上面这些是「打开看」才能发现的问题。' +
          '这一步不能算完成：用 read_file 读相关段落，只改坏掉的那一处再写回去，不要整份重写。'
      )
      continue
    }
    const bits: string[] = []
    if (r.probe) {
      if (r.probe.canvasCount > 0) bits.push(`canvas ${r.probe.canvasCount} 个`)
      if (r.probe.painted) bits.push('画布已绘制')
      if (r.probe.animated) bits.push('动画帧在跑')
      if (r.probe.responded) bits.push('对模拟操作有响应')
    }
    lines.push(
      `【打开验收】${relOf(r.file, root)} 已实际打开，控制台无报错${bits.length ? `（${bits.join('、')}）` : ''}。`
    )
    if (r.shot) lines.push(`  - 已截图：${r.shot}`)
    // 布局健康度：客观统计，纯文本模型也能据此判断布局有没有问题
    const layoutIssues = r.probe?.layoutIssues
    if (layoutIssues && layoutIssues.length) {
      lines.push(
        `  - 布局客观检查发现问题：${layoutIssues.join('；')}。` +
          '即使看不了截图，这些数字也说明存在错位/裁切，应按位置去查对应元素的 CSS。'
      )
    }
  }
  // 有截图就统一提醒一句：探针看不到的东西（布局、配色、字号、排版）要靠看图补
  const shots = results.filter((r) => r.shot)
  if (shots.length) {
    lines.push(
      '本次打开验收已为页面截图，落在上面的路径里。如果你能看图，用 read_file 打开截图，' +
        '核对布局有没有错位、配色字号是否合理、非画布的元素（按钮/文字/表单）是否正常显示；' +
        '看不了图也没关系：上面的布局客观检查已经给了溢出/字号/点击目标的数字，据此定位即可。' +
        '只看「控制台无报错」不算完成。'
    )
  }
  return lines.join('\n')
}
