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
 * 执行中的状态：固定在输入区上方那一行的左侧，和右边的上下文占用同一栏。
 *
 * 运行中这一格始终占着：有具体进度（正在执行 run_shell、自动验证…）就显示进度，
 * 没有就显示「正在思考，请稍等」。以前「正在思考」是消息区里的一条占位消息，
 * 和这里的状态条交替出现，看着像在对话窗口和上下文栏之间来回跳。
 */
export function RunStatus({
  note,
  startedAt,
  queued = false
}: {
  note?: string
  startedAt: number
  /** 排队等全局并发槽位：还没开始烧算力，所以不显示「已跑多久」 */
  queued?: boolean
}) {
  const begin = useRef(startedAt || Date.now())
  const [elapsed, setElapsed] = useState(() => Date.now() - begin.current)

  useEffect(() => {
    if (!note || queued) return
    if (startedAt) begin.current = startedAt
    setElapsed(Date.now() - begin.current)
    const timer = window.setInterval(() => setElapsed(Date.now() - begin.current), 500)
    return () => window.clearInterval(timer)
  }, [startedAt, note, queued])

  const label = note || `RoRoTo Code · ${tr("正在思考，请稍等")}`

  return (
    <div className={`run-status ${queued ? 'queued' : ''} ${note ? '' : 'idle'}`} role="status" aria-live="polite">
      <Dots />
      <span className="run-status-note">{label}</span>
      {note && !queued && <span className="run-status-time">{elapsedText(elapsed)}</span>}
    </div>
  )
}
