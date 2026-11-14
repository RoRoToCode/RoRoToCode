import { t as tr } from '../i18n'
import type { SessionPlan } from '../../shared/types'
import { Chevron, useCollapse } from './Collapse'

/**
 * 计划模式下产出的方案卡。
 *
 * 和 PlanCard 的分工：PlanCard 是「已经在做的事」（update_todos 的待办），
 * 这里 是「还没被允许做的事」（只读阶段写下的方案）。批准之后会话切成 build，
 * 这张卡保留但变成已批准状态，方便回头对照实际做了什么。
 */
export function PlanApproval({
  plan,
  running,
  onApprove
}: {
  plan: SessionPlan | null
  running: boolean
  onApprove: () => void
}) {
  const [open, toggle] = useCollapse('plan-approval', true)
  if (!plan) return null

  const approved = plan.approved

  return (
    <div className={`plan-approval ${approved ? 'approved' : ''}`}>
      <div className="pa-head">
        <button className="pa-title" onClick={toggle} title={open ? tr('收起方案') : tr('展开方案')}>
          <span className={`pa-badge ${approved ? 'ok' : ''}`}>{approved ? tr('已批准') : tr('待批准')}</span>
          <span>{tr('执行方案')}</span>
          <Chevron open={open} />
        </button>
        {!approved && (
          <button className="btn primary sm" onClick={onApprove} disabled={running}>
            {running ? tr('等这一轮跑完') : tr('批准并执行')}
          </button>
        )}
      </div>

      {open && (
        <div className="pa-body">
          <pre className="pa-text">{plan.text}</pre>
          {plan.steps.length > 0 && (
            <ol className="pa-steps">
              {plan.steps.map((s, i) => (
                <li key={`${i}-${s}`}>{s}</li>
              ))}
            </ol>
          )}
          {!approved && (
            <div className="pa-hint">
              {tr('不满意可以直接在下面说，模型会重写这份方案；批准后才会真正改文件。')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
