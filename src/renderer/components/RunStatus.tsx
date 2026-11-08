import { t as tr } from '../i18n'
import { useEffect, useRef, useState } from 'react'

/** 三个跳动的点，表示「还在跑」 */
export function Dots() {
  return (
    <span className="run-dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  )
}

function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return tr("{s} 秒", { s: s })
  const m = Math.floor(s / 60)
  const rest = s % 60
  return tr("{m} 分 {1} 秒", { m: m, "1": String(rest).padStart(2, '0') })
}

/**
 * 执行中的状态条：只要助手还在跑就一直挂在输入框上方并闪烁。
 * 之前回车后界面没有任何反馈，用户不知道是卡住了还是在干活。
 */
export function RunStatus({ note, startedAt }: { note?: string; startedAt: number }) {
  const begin = useRef(startedAt || Date.now())
  const [elapsed, setElapsed] = useState(() => Date.now() - begin.current)

  useEffect(() => {
    if (startedAt) begin.current = startedAt
    setElapsed(Date.now() - begin.current)
    const timer = window.setInterval(() => setElapsed(Date.now() - begin.current), 500)
    return () => window.clearInterval(timer)
  }, [startedAt])

  return (
    <div className="run-status" role="status" aria-live="polite">
      <Dots />
      <span className="run-status-text">{tr("执行中，请稍等")}</span>
      {note ? <span className="run-status-note">{note}</span> : null}
      <span className="run-status-time">{elapsedText(elapsed)}</span>
    </div>
  )
}
