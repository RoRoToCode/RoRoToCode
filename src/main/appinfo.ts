import { app, BrowserWindow, shell } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AppInfo, AppPrefs, ThemeKey } from '../shared/types'

/** 软件偏好单独存一份，别和模型配置搅在一起 */
const FILE = 'prefs.json'

const DEFAULTS: AppPrefs = {
  zoom: 1,
  theme: 'dark',
  fontScale: 1,
  chatFontScale: null
}

const THEMES: ThemeKey[] = ['dark', 'light', 'gray', 'stripe', 'contrast']

/** 渲染层 localStorage 里也留一份：首屏渲染前就能套上，不闪一下默认字号 */
export const FONT_KEY = 'roroto.fontScale'
export const CHAT_FONT_KEY = 'roroto.chatFontScale'

function normTheme(v: unknown): ThemeKey {
  return THEMES.includes(v as ThemeKey) ? (v as ThemeKey) : 'dark'
}

/** 缩放范围限制在 80% ~ 160%，再大界面就散了 */
const ZOOM_MIN = 0.8
const ZOOM_MAX = 1.6

/** 字号单独限在 85% ~ 140%：超过后固定宽度的侧栏、按钮会挤掉文字 */
export const FONT_MIN = 0.85
export const FONT_MAX = 1.4

function clampFontScale(n: unknown): number {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return 1
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(v * 100) / 100))
}

/** 空串 / null 都表示「跟随界面」，其余按数值收敛到合法区间 */
function normChatFontScale(n: unknown): number | null {
  if (n === null || n === undefined || n === '') return null
  return clampFontScale(n)
}

function prefsPath(): string {
  return path.join(app.getPath('userData'), FILE)
}

let cache: AppPrefs | null = null

function clampZoom(n: unknown): number {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v * 100) / 100))
}

export async function loadPrefs(): Promise<AppPrefs> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(prefsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppPrefs>
    // 逐项取值：旧版 prefs.json 里的 keys（快捷键）等字段随之丢弃，下次保存即清掉
    cache = {
      zoom: clampZoom(parsed.zoom ?? DEFAULTS.zoom),
      theme: normTheme(parsed.theme),
      fontScale: clampFontScale(parsed.fontScale ?? DEFAULTS.fontScale),
      chatFontScale: normChatFontScale(parsed.chatFontScale)
    }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export async function savePrefs(patch: Partial<AppPrefs>): Promise<AppPrefs> {
  const cur = await loadPrefs()
  const next: AppPrefs = {
    ...cur,
    ...patch,
    zoom: clampZoom(patch.zoom ?? cur.zoom),
    theme: normTheme(patch.theme ?? cur.theme),
    fontScale: clampFontScale(patch.fontScale ?? cur.fontScale),
    // 这里不能用 ??：用户把「跟随界面」重新打开时传的是 null，要能真的写回去
    chatFontScale:
      'chatFontScale' in patch ? normChatFontScale(patch.chatFontScale) : cur.chatFontScale
  }
  await fs.mkdir(path.dirname(prefsPath()), { recursive: true })
  await fs.writeFile(prefsPath(), JSON.stringify(next, null, 2), 'utf8')
  cache = next
  return next
}

/** 各配色对应的窗口底色，减少启动/缩放时的白闪或黑闪 */
const WINDOW_BG: Record<ThemeKey, string> = {
  dark: '#0d0d0f',
  light: '#f5f6f8',
  gray: '#2b2e33',
  stripe: '#0b0b0e',
  contrast: '#000000'
}

export function windowBg(theme: ThemeKey): string {
  return WINDOW_BG[theme] ?? WINDOW_BG.dark
}

/**
 * 窗口加载完后按上次的缩放比、配色与字号还原。
 * 缩放走 Electron zoomFactor；字号是页面里的 CSS 变量，主进程在这里注入一次，
 * 顺手同步进 localStorage，下次启动渲染层能在首屏渲染前自己套上，不会闪一下默认字号。
 */
export async function applySavedAppearance(win: BrowserWindow): Promise<void> {
  const p = await loadPrefs()
  win.setBackgroundColor(windowBg(p.theme))
  if (Math.abs(p.zoom - 1) >= 0.001) win.webContents.setZoomFactor(p.zoom)

  const ui = p.fontScale
  const chat = p.chatFontScale ?? p.fontScale
  const storedChat = p.chatFontScale === null ? '' : String(p.chatFontScale)
  // ui / chat 都是 clamp 过的数字，拼进脚本没有注入风险
  const script =
    `(() => { const r = document.documentElement;` +
    ` r.style.setProperty('--fs', '${ui}');` +
    ` r.style.setProperty('--fs-chat', '${chat}');` +
    ` try { localStorage.setItem('${FONT_KEY}', '${ui}');` +
    ` localStorage.setItem('${CHAT_FONT_KEY}', '${storedChat}'); } catch (_) {} })()`
  await win.webContents.executeJavaScript(script).catch(() => undefined)
}

/** 改缩放：所有窗口立即生效并落盘 */
export async function setZoom(factor: number): Promise<AppPrefs> {
  const prefs = await savePrefs({ zoom: factor })
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.setZoomFactor(prefs.zoom)
  }
  return prefs
}

export async function appInfo(): Promise<AppInfo> {
  const dataDir = app.getPath('userData')
  const sessionsDir = path.join(dataDir, 'sessions')
  let sessionCount = 0
  try {
    const names = await fs.readdir(sessionsDir)
    sessionCount = names.filter((n) => n.endsWith('.json')).length
  } catch {
    // 还没建过会话目录，算 0 个
  }
  const prefs = await loadPrefs()
  return {
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    platform: `${process.platform} ${process.arch}`,
    dataDir,
    sessionsDir,
    sessionCount,
    zoom: prefs.zoom,
    packaged: app.isPackaged
  }
}

export async function openDataDir(): Promise<{ ok: boolean; message?: string }> {
  const dir = app.getPath('userData')
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined)
  const err = await shell.openPath(dir)
  return err ? { ok: false, message: err } : { ok: true }
}
