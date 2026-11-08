import { t as tr } from '../i18n'
import type { TodoItem } from '../../shared/types'
import { Chevron, useCollapse } from './Collapse'

/**
 * 执行计划卡片：贴在消息区上方，显示模型当前的多步计划。
 * 计划由 update_todos 工具维护，全部完成后自动淡化，不挡视线。
 */
export function PlanCard({ items, running }: { items: TodoItem[]; running?: boolean }) {
  const [open, toggle] = useCollapse('plan-card', true)
  if (!items.length) return null

  const done = items.filter((i) => i.status === 'completed').length
  const allDone = done === items.length
  const pct = Math.round((done / items.length) * 100)

  return (
    <div className={`plan-card ${allDone ? 'all-done' : ''}`}>
      <button className="plan-head" onClick={toggle} title={open ? tr("收起计划") : tr("展开计划")}>
        <span className="plan-title">{allDone ? tr("计划已完成") : tr("执行计划")}</span>
        <span className="plan-count">
          {done}/{items.length}
        </span>
        <span className="plan-bar" aria-hidden="true">
          <i style={{ width: `${pct}%` }} />
        </span>
        <Chevron open={open} />
      </button>

      {open && (
        <ul className="plan-list">
          {items.map((item, i) => (
            <li key={`${i}-${item.content}`} className={`plan-item ${item.status}`}>
              <span className="plan-mark" aria-hidden="true">
                {item.status === 'completed' ? '✓' : item.status === 'in_progress' ? (
                  <span className={`plan-dot ${running ? 'pulse' : ''}`} />
                ) : (
                  '○'
                )}
              </span>
              <span className="plan-text">{item.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
