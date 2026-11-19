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

/** 生成量的紧凑写法：3200 → 3.1K，和底部的用量口径保持一致（1024 进制） */
function genText(n: number): string {
  if (n >= 10240) return `${Math.round(n / 1024)}K`
  if (n >= 1024) return `${(n / 1024).toFixed(1)}K`
  return String(n)
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
  queued = false,
  generated = null
}: {
  note?: string
  startedAt: number
  /** 排队等全局并发槽位：还没开始烧算力，所以不显示「已跑多久」 */
  queued?: boolean
  /**
   * 这一次调用已经生成出来的量（近似 token）。
   *
   * 写大文件时一整次调用能跑几分钟，期间正文和用量数字都不动 —— 没有这个数字，
   * 界面看起来就是「在转圈但什么都没产出」。有它就一眼能看出模型确实在吐东西。
   */
  generated?: number | null
}) {
  const begin = useRef(startedAt || Date.now())
  const [elapsed, setElapsed] = useState(() => Date.now() - begin.current)

  useEffect(() => {
    if (queued) return
    if (startedAt) begin.current = startedAt
    setElapsed(Date.now() - begin.current)
    const timer = window.setInterval(() => setElapsed(Date.now() - begin.current), 500)
    return () => window.clearInterval(timer)
  }, [startedAt, queued])

  const label = note || `RoRoTo Code · ${tr("正在思考，请稍等")}`

  return (
    <div className={`run-status ${queued ? 'queued' : ''} ${note ? '' : 'idle'}`} role="status" aria-live="polite">
      <Dots />
      <span className="run-status-note">
        {/*
          逐字跃动：把整段文案拆成单个字符，每个字用同一条关键帧，靠递增的
          animation-delay 错开相位，看起来就是一个字接一个字地波浪式往上跳，
          和前面三个点从左到右依次亮的节奏呼应。空格换成不换行空格，
          否则 inline-block 的空字符会被折叠掉。
        */}
        {Array.from(label).map((ch, i) => (
          <span className="run-note-ch" key={i} style={{ animationDelay: `${i * 0.06}s` }}>
            {ch === ' ' ? '\u00A0' : ch}
          </span>
        ))}
      </span>
      {/*
        只等模型（没有具体工具在跑）时，以前这一行是完全静止的：没有计时、没有数字，
        一次大文件生成要几分钟，看起来就是卡死了。所以这里把「已经跑了多久」
        和「已经生成多少」都显出来 —— 只要在动，用户就能确认它没死。
      */}
      {generated ? (
        <span className="run-status-gen" title={tr("这一次调用已经生成的内容量（约等于 token 数）")}>
          {tr("已生成")} ≈{genText(generated)}
        </span>
      ) : null}
      {!queued && <span className="run-status-time">{elapsedText(elapsed)}</span>}
    </div>
  )
}
