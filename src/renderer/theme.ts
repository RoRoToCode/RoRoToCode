import { t as tr } from './i18n'
import type { ThemeKey } from '../shared/types'

export const THEME_KEY = 'roro-theme'

export interface ThemeMeta {
  key: ThemeKey
  label: string
  /** 色板预览用的三个颜色：底色 / 面板 / 文字 */
  swatch: [string, string, string]
}

export const THEMES: ThemeMeta[] = [
  { key: 'dark', get label() { return tr("黑色") }, swatch: ['#0d0d0f', '#1f1f26', '#e9e9ec'] },
  { key: 'light', get label() { return tr("白色") }, swatch: ['#f5f6f8', '#dfe3e9', '#1b1e23'] },
  { key: 'gray', get label() { return tr("灰色") }, swatch: ['#2b2e33', '#474c54', '#eef0f3'] },
  { key: 'stripe', get label() { return tr("大条纹") }, swatch: ['#15151a', '#3a3a46', '#eceef2'] },
  { key: 'contrast', get label() { return tr("高对比") }, swatch: ['#000000', '#0a0a0a', '#ffffff'] }
]

const VALID = THEMES.map((t) => t.key)

export function isTheme(v: unknown): v is ThemeKey {
  return VALID.includes(v as ThemeKey)
}

/** 取上次用的配色；没存过就按黑色 */
export function storedTheme(): ThemeKey {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (isTheme(v)) return v
  } catch {
    // 隐私模式下 localStorage 可能不可用
  }
  return 'dark'
}

/**
 * 把配色写到 <html data-theme>，同时记到 localStorage。
 * 记本地是为了下次启动能在首屏渲染前就套上，避免先黑后白的闪一下。
 */
export function applyTheme(theme: ThemeKey, persist = true): void {
  const el = document.documentElement
  if (theme === 'dark') el.removeAttribute('data-theme')
  else el.setAttribute('data-theme', theme)
  if (!persist) return
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // 忽略：存不了也只影响下次启动的默认值
  }
}

/* ---------- 字体大小 ---------- */

/** 和 main/appinfo.ts 的 FONT_MIN / FONT_MAX 保持一致 */
export const FONT_SCALE_MIN = 0.85
export const FONT_SCALE_MAX = 1.4
export const FONT_SCALE_STEP = 0.05

/** 常用档位，滑块拖动到任意值也照样生效 */
export const FONT_PRESETS: Array<{ value: number; get label(): string }> = [
  { value: 0.9, get label() { return tr("小") } },
  { value: 1, get label() { return tr("标准") } },
  { value: 1.15, get label() { return tr("大") } },
  { value: 1.3, get label() { return tr("特大") } }
]

const FONT_KEY = 'roroto.fontScale'
const CHAT_FONT_KEY = 'roroto.chatFontScale'

export interface FontScaleState {
  /** 界面文字：1 = 100% */
  ui: number
  /** 对话正文；null = 跟随界面 */
  chat: number | null
}

export function clampFontScale(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 1
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(n * 100) / 100))
}

/** 首屏渲染前读一份本地缓存，避免先按默认字号画出来再跳 */
export function storedFontScale(): FontScaleState {
  try {
    const ui = localStorage.getItem(FONT_KEY)
    const chat = localStorage.getItem(CHAT_FONT_KEY)
    return { ui: clampFontScale(ui ?? 1), chat: chat ? clampFontScale(chat) : null }
  } catch {
    return { ui: 1, chat: null }
  }
}

/**
 * 只改字号，不改间距、宽度和布局 —— 这是和「界面缩放」最大的区别。
 * CSS 里所有 font-size 都写成 calc(Npx * var(--fs))，对话区再把 --fs
 * 重定向到 --fs-chat，所以两处能各自独立调。
 */
export function applyFontScale(ui: number, chat: number | null, persist = true): void {
  const scale = clampFontScale(ui)
  const chatScale = chat === null ? null : clampFontScale(chat)
  const el = document.documentElement
  el.style.setProperty('--fs', String(scale))
  el.style.setProperty('--fs-chat', String(chatScale ?? scale))
  if (!persist) return
  try {
    localStorage.setItem(FONT_KEY, String(scale))
    localStorage.setItem(CHAT_FONT_KEY, chatScale === null ? '' : String(chatScale))
  } catch {
    // 隐私模式下存不了，主进程 prefs.json 仍然是权威值
  }
}
