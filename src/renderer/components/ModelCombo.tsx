import { t as tr } from '../i18n'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  value: string
  options: string[]
  onChange: (next: string) => void
  placeholder?: string
  /** 选项显示文本（例如给运行中的模型加后缀），默认原样 */
  labelOf?: (v: string) => string
  /** 下拉底部的一行说明 */
  footer?: ReactNode
  emptyHint?: string
  disabled?: boolean
  title?: string
}

interface Box {
  left: number
  width: number
  top?: number
  bottom?: number
  maxHeight: number
}

/**
 * 模型名选择框。
 *
 * 原来的 <input list> + <datalist> 在 Electron 里不可靠：设置面板本身是滚动容器，
 * 原生弹出层只按可视空间的一半来算高度，经常只露出两三条、也没有滚动条。
 * 这里改成自绘列表（挂到 body 上 fixed 定位），能完整滚动、能输入筛选、支持键盘。
 */
export function ModelCombo({
  value,
  options,
  onChange,
  placeholder,
  labelOf,
  footer,
  emptyHint,
  disabled,
  title
}: Props) {
  const [open, setOpen] = useState(false)
  /** 只在用户真正输入时筛选；点箭头打开时显示全部 */
  const [query, setQuery] = useState('')
  const [hi, setHi] = useState(0)
  const [box, setBox] = useState<Box | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const label = labelOf ?? ((v: string) => v)

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.toLowerCase().includes(q))
  }, [options, query])

  /* 打开时算位置：面板可能刚滚动过，所以每次打开和滚动都重算 */
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const el = wrapRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const below = window.innerHeight - r.bottom - 12
      const above = r.top - 12
      const up = below < 200 && above > below
      setBox({
        left: r.left,
        width: r.width,
        ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
        maxHeight: Math.max(140, Math.min(320, up ? above : below))
      })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, shown.length])

  /* 点外面关掉；高亮项滚进视野 */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (wrapRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    const box = menuRef.current
    const item = box?.querySelector<HTMLElement>(`[data-i="${hi}"]`)
    item?.scrollIntoView({ block: 'nearest' })
  }, [hi, open])

  function show() {
    if (disabled) return
    setQuery('')
    setHi(Math.max(0, options.indexOf(value)))
    setOpen(true)
  }

  function commit(v: string) {
    onChange(v)
    setQuery('')
    setOpen(false)
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) return show()
      setHi((i) => Math.min(shown.length - 1, i + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) return show()
      setHi((i) => Math.max(0, i - 1))
      return
    }
    if (e.key === 'Enter') {
      if (!open) return
      e.preventDefault()
      const pick = shown[hi]
      if (pick) commit(pick)
      return
    }
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (open) {
        // 只关下拉，别让 Esc 把整个设置面板也关了
        e.stopPropagation()
        if (e.key === 'Escape') e.preventDefault()
        setOpen(false)
      }
    }
  }

  const style: CSSProperties | undefined = box
    ? { left: box.left, width: box.width, top: box.top, bottom: box.bottom, maxHeight: box.maxHeight }
    : undefined

  return (
    <div className={`combo ${open ? 'open' : ''}`} ref={wrapRef}>
      <div className="combo-box" title={title}>
        <input
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            onChange(e.target.value)
            setQuery(e.target.value)
            setHi(0)
            setOpen(true)
          }}
          onClick={() => {
            if (!open) show()
          }}
          onFocus={() => {
            if (!open) show()
          }}
          onKeyDown={onKey}
        />
        <button
          type="button"
          className="combo-arrow"
          tabIndex={-1}
          disabled={disabled}
          title={open ? tr("收起列表") : tr("展开全部模型")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (open ? setOpen(false) : show())}
        >
          <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M2 4l3 3 3-3"
              stroke="currentColor"
              strokeWidth="1.4"
              fill="none"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {open &&
        box &&
        createPortal(
          <div className="combo-menu" ref={menuRef} style={style}>
            <div className="combo-head">
              <span>{tr("共")}{options.length} {tr("个")}</span>
              <span className="combo-head-tip">{query ? tr("筛选出 {length} 个", { length: shown.length }) : tr("滚动查看全部")}</span>
            </div>
            <div className="combo-list">
              {shown.length === 0 && (
                <div className="combo-empty">{emptyHint ?? tr("没有匹配的模型，可以直接手输模型名")}</div>
              )}
              {shown.map((m, i) => (
                <button
                  type="button"
                  key={m}
                  data-i={i}
                  className={`combo-item ${i === hi ? 'hi' : ''} ${m === value ? 'sel' : ''}`}
                  onMouseEnter={() => setHi(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commit(m)}
                  title={m}
                >
                  <span className="combo-item-text">{label(m)}</span>
                  {m === value && <span className="combo-item-check">{tr("当前")}</span>}
                </button>
              ))}
            </div>
            {footer ? <div className="combo-foot">{footer}</div> : null}
          </div>,
          document.body
        )}
    </div>
  )
}
