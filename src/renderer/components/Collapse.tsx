import { useEffect, useState } from 'react'

/**
 * 折叠面板用的小工具。
 *
 * 状态放在模块级 Map 里：切到别的标签页再回来、或者关掉设置面板重新打开，
 * 折叠状态都保持原样，不会「刚收起来又弹开」。
 *
 * 默认折叠（defaultOpen 默认 false）：Ollama / LM Studio / 设置里的功能分组
 * 都不该一进来就全摊开，用户要用哪个再点开哪个。
 */
const memory = new Map<string, boolean>()

export function useCollapse(key: string, defaultOpen = false): [boolean, () => void] {
  const [open, setOpen] = useState(() => memory.get(key) ?? defaultOpen)
  useEffect(() => {
    memory.set(key, open)
  }, [key, open])
  return [open, () => setOpen((v) => !v)]
}

/** 卡片标题右侧的小箭头，展开时朝上 */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`chev ${open ? 'open' : ''}`}
      width="12"
      height="12"
      viewBox="0 0 10 10"
      aria-hidden="true"
    >
      <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </svg>
  )
}
