/**
 * 快捷键的纯逻辑：解析、格式化、匹配、冲突检查。
 *
 * 放在 shared 里是因为主进程测试能直接跑它（tsc 会把 shared 一起编译成 CJS），
 * 而渲染层只是 import —— 两边都不用重复实现一套。
 *
 * 约定：只接受带 Ctrl（mac 上是 Cmd）的组合。裸字母不算快捷键，
 * 否则用户在输入框里打字就会被劫走。
 */

export type KeyAction = 'search' | 'newSession' | 'export' | 'settings'

export const KEY_ACTIONS: KeyAction[] = ['search', 'newSession', 'export', 'settings']

/** 默认绑定，也是「恢复默认」要还原的值 */
export const DEFAULT_KEYS: Record<KeyAction, string> = {
  search: 'Ctrl+K',
  newSession: 'Ctrl+N',
  export: 'Ctrl+E',
  settings: 'Ctrl+,'
}

export interface KeyCombo {
  /** KeyboardEvent.key 的小写形式：a、k、,、f5 */
  key: string
  shift: boolean
  alt: boolean
}

const MOD_ALIASES: Record<string, 'ctrl' | 'shift' | 'alt'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'ctrl',
  command: 'ctrl',
  meta: 'ctrl',
  win: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  opt: 'alt'
}

/** 键名统一小写；F1~F12、方向键这类保持原样小写即可比较 */
function normKey(raw: string): string {
  const k = raw.trim()
  if (!k) return ''
  return k.length === 1 ? k.toLowerCase() : k.toLowerCase()
}

/**
 * "Ctrl+Shift+K" -> { key: 'k', shift: true, alt: false }
 * 非法（没有 Ctrl、没有键、多个主键）返回 null。
 */
export function parseCombo(text: string): KeyCombo | null {
  if (!text || typeof text !== 'string') return null
  const parts = text.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return null
  const main = parts[parts.length - 1]
  const mods = parts.slice(0, -1)
  let ctrl = false
  let shift = false
  let alt = false
  for (const m of mods) {
    const kind = MOD_ALIASES[m.toLowerCase()]
    // 不认识的修饰键直接判非法，避免把错的东西当成合法绑定
    if (!kind) return null
    if (kind === 'ctrl') ctrl = true
    else if (kind === 'shift') shift = true
    else alt = true
  }
  if (!ctrl) return null
  const key = normKey(main)
  if (!key) return null
  return { key, shift, alt }
}

/** 统一成规范写法，用于存盘与比较 */
export function formatCombo(combo: KeyCombo): string {
  const parts: string[] = ['Ctrl']
  if (combo.shift) parts.push('Shift')
  if (combo.alt) parts.push('Alt')
  const k = combo.key.length === 1 ? combo.key.toUpperCase() : combo.key
  parts.push(k)
  return parts.join('+')
}

/** 从键盘事件取组合键；不满足「Ctrl + 单个主键」就返回 null（Ctrl 按住连按两次也会返回 null） */
export function comboFromEvent(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}): KeyCombo | null {
  if (!e.ctrlKey && !e.metaKey) return null
  // 单独按修饰键没意义，等用户按真正的键
  const k = e.key.toLowerCase()
  if (k === 'control' || k === 'shift' || k === 'alt' || k === 'meta') return null
  return { key: normKey(e.key), shift: e.shiftKey, alt: e.altKey }
}

/** 判断一次按键是否命中某个绑定 */
export function comboMatches(
  e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean },
  binding: string
): boolean {
  const want = parseCombo(binding)
  if (!want) return false
  const got = comboFromEvent(e)
  if (!got) return false
  return got.key === want.key && got.shift === want.shift && got.alt === want.alt
}

/** 绑定表里已经占用了这个组合的动作（不含自己）；没有冲突返回 null */
export function findConflict(
  keys: Record<string, string>,
  action: KeyAction,
  binding: string
): KeyAction | null {
  const target = parseCombo(binding)
  if (!target) return null
  for (const other of KEY_ACTIONS) {
    if (other === action) continue
    const b = keys[other]
    if (!b) continue
    const c = parseCombo(b)
    if (c && c.key === target.key && c.shift === target.shift && c.alt === target.alt) return other
  }
  return null
}

/**
 * 把外部来的（磁盘 / localStorage）绑定表收敛成一份可用的：
 * 非法值回退默认，重复的按顺序先到先得，后到的回退默认；默认也被占了就解绑（空串）。
 */
export function normalizeKeys(input: unknown): Record<KeyAction, string> {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const out = {} as Record<KeyAction, string>
  const used = new Set<string>()
  const canon = (v: unknown): string | null => {
    if (typeof v !== 'string') return null
    const c = parseCombo(v)
    return c ? formatCombo(c) : null
  }
  // 第一轮：用户自己的有效值
  for (const action of KEY_ACTIONS) {
    const c = canon(src[action])
    if (c && !used.has(c)) {
      out[action] = c
      used.add(c)
    }
  }
  // 第二轮：缺的、重复的补默认
  for (const action of KEY_ACTIONS) {
    if (out[action]) continue
    const d = DEFAULT_KEYS[action]
    out[action] = used.has(d) ? '' : d
    if (out[action]) used.add(out[action])
  }
  return out
}

/** 全部回到默认 */
export function defaultKeys(): Record<KeyAction, string> {
  return { ...DEFAULT_KEYS }
}
