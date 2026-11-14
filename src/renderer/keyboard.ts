import type { KeyboardEvent } from 'react'

/**
 * 这个按键是不是输入法正在合成文字时产生的。
 *
 * 中文/日文输入法里，回车的第一作用是「确认候选词」，第二作用才是「提交」。
 * 聊天框如果只看 `e.key === 'Enter'`，用户打「你好」按回车选字，消息就被发出去了 ——
 * 这是中文环境下最高频的误操作，而且它一定发生在最需要信任的那个位置（发送）。
 *
 * 判断两路都看：
 * - `isComposing`：标准字段，Chrome/Edge 上可靠；
 * - `keyCode === 229`：部分输入法（老版微软拼音、某些五笔）在合成期间给这个哨兵值，
 *   而 isComposing 偶尔是 false。
 */
export function isComposingKey(e: KeyboardEvent): boolean {
  return Boolean(e.nativeEvent?.isComposing) || e.keyCode === 229
}

/** 真的按下了回车：既不是输入法选字，也不是 Shift+Enter 换行 */
export function isPlainEnter(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && !e.shiftKey && !isComposingKey(e)
}
