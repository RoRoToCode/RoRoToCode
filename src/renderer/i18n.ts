/**
 * 界面语言：中文 / 英文一键切换。
 *
 * 字典以「中文原文」为 key，所以组件里直接写 t('软件设置') 就行，
 * 不用给几百条文案各起一个名字；没翻译到的条目自动退回中文。
 * 语言状态放在模块里，切换时通知 React 根组件重渲染，所有 t() 重新求值。
 */
import { useSyncExternalStore } from 'react'
import { EN } from './i18n-en'

export type Lang = 'zh' | 'en'

const STORAGE_KEY = 'roroto.lang'
const listeners = new Set<() => void>()

function readLang(): Lang {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

let current: Lang = readLang()

/** 同步 <html lang>，让字体与无障碍读屏跟着切 */
function applyHtmlLang(lang: Lang): void {
  try {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  } catch {
    // SSR / 测试环境没有 document，忽略
  }
}
applyHtmlLang(current)

/** 把语言同步给主进程，让安装确认、保存文件等系统对话框也是同一语言 */
function syncMainLang(lang: Lang): void {
  try {
    const api = (window as { pico?: { app?: { setLang?: (l: Lang) => Promise<void> } } }).pico
    void api?.app?.setLang?.(lang)?.catch(() => undefined)
  } catch {
    // 浏览器预览环境没有 preload，忽略
  }
}
syncMainLang(current)

export function getLang(): Lang {
  return current
}

export function setLang(next: Lang): void {
  if (next === current) return
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // 隐私模式下写不了，本次会话内仍然生效
  }
  applyHtmlLang(next)
  syncMainLang(next)
  listeners.forEach((fn) => fn())
}

export function toggleLang(): void {
  setLang(current === 'zh' ? 'en' : 'zh')
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 在根组件里调用一次即可：语言变化时整棵界面树重渲染 */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, () => 'zh' as Lang)
}

/**
 * 取文案。vars 用来替换模板占位符，如 t('已切换到 {to}', { to: name })。
 * 中英文都会替换占位符，中文模式下没有对应英文词条时原样返回。
 */
export function t(key: string, vars?: Record<string, unknown>): string {
  const raw = current === 'en' ? (EN[key] ?? key) : key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = vars[name]
    return v === undefined || v === null ? whole : String(v)
  })
}
