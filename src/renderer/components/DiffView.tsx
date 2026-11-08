import { t as tr } from '../i18n'
import type { DiffLine } from '../../shared/types'

/** 统一的 diff 渲染：加号绿、减号红，行号靠左 */
export function DiffView({
  lines,
  max = 400,
  empty = tr("没有差异")
}: {
  lines: DiffLine[]
  max?: number
  empty?: string
}) {
  if (!lines.length) return <div className="diff-empty">{empty}</div>
  const shown = lines.length > max ? lines.slice(0, max) : lines
  return (
    <div className="diff">
      {shown.map((l, i) => (
        <div key={i} className={`diff-line ${l.kind}`}>
          <span className="diff-no">{l.kind === 'add' ? l.after ?? '' : l.before ?? ''}</span>
          <span className="diff-sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
          <span className="diff-text">{l.text === '' ? ' ' : l.text}</span>
        </div>
      ))}
      {lines.length > max && <div className="diff-more">{tr("…还有")}{lines.length - max} {tr("行没显示")}</div>}
    </div>
  )
}
