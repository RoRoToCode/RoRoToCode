import { t as tr } from '../i18n'
import { useState } from 'react'
import type { ChatMessage, SubAgentTask } from '../../shared/types'
import { RichText } from './Markdown'
import { Dots } from './RunStatus'

function fmtMs(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return tr("{0} 分 {1} 秒", { "0": Math.floor(s / 60), "1": Math.round(s % 60) })
}

/**
 * 子 agent 的卡片。
 * 运行中显示它走到第几步、调了哪些工具；结束后折叠成一行结论，
 * 中间几十次读文件的过程默认收起，不占聊天版面。
 */
export function SubAgentCard({
  message,
  task,
  onDelete
}: {
  message: ChatMessage
  task?: SubAgentTask
  onDelete?: (messageId: string) => void
}) {
  const [open, setOpen] = useState(false)

  const title =
    task?.description || String(message.toolArgs?.description ?? '').trim() || tr("子任务")
  const status: SubAgentTask['status'] = task?.status ?? (message.content ? 'ok' : 'running')
  const steps = task?.steps ?? 0
  const tools = task?.tools ?? []
  const startedAt = task?.startedAt ?? message.createdAt
  const elapsed = (task?.endedAt ?? Date.now()) - startedAt

  // 重开会话时没有实时状态，只剩工具结果那一段文本，直接当正文显示
  const body = task ? task.summary : message.content
  const failed = status === 'fail'

  return (
    <div className="msg">
      <div className={`subagent ${status}`}>
        <div className="subagent-head">
          <span className="subagent-mark" aria-hidden />
          <span className="subagent-title">{title}</span>
          <span className={`subagent-state ${status}`}>
            {status === 'running' ? (
              <>
                <Dots />
                {steps > 0 ? tr("第 {steps} 步", { steps: steps }) : tr("启动中")}
              </>
            ) : failed ? (
              tr("失败")
            ) : (
              fmtMs(elapsed)
            )}
          </span>
          {onDelete && (
            <button
              type="button"
              className="turn-del"
              title={tr("删除这一轮对话（含回答和工具输出），给上下文减负")}
              onClick={() => onDelete(message.id)}
            >
              {tr("删除")}
            </button>
          )}
        </div>

        <div className="subagent-meta">
          <span>{steps} {tr("步")}</span>
          <span className="subagent-dot">·</span>
          <span>{tools.length} {tr("次工具调用")}</span>
          {task?.model ? (
            <>
              <span className="subagent-dot">·</span>
              <span title={tr("这个子任务实际用的模型")}>{task.model}</span>
            </>
          ) : null}
          {task?.endedAt ? (
            <>
              <span className="subagent-dot">·</span>
              <span>{tr("用时")}{fmtMs(elapsed)}</span>
            </>
          ) : null}
          {tools.length > 0 && (
            <button className="subagent-toggle" onClick={() => setOpen((v) => !v)}>
              {open ? tr("收起过程") : tr("查看过程")}
            </button>
          )}
        </div>

        {task?.note ? <div className="subagent-note">{task.note}</div> : null}

        {open && tools.length > 0 && (
          <div className="subagent-tool-list">
            {tools.map((t, i) => (
              <div className="subagent-tool" key={`${t.tool}-${i}`}>
                <span className={`subagent-tool-name ${t.ok ? 'ok' : 'err'}`}>{t.tool}</span>
                <span className="subagent-tool-note">{t.note}</span>
                <span className="subagent-tool-time">{t.durationMs}ms</span>
              </div>
            ))}
          </div>
        )}

        {failed && task?.error ? <div className="subagent-error">{task.error}</div> : null}

        <div className="subagent-body">
          {body ? (
            <RichText text={body} />
          ) : (
            <span className="subagent-wait">
              <Dots />
              {tr("子 agent 正在独立处理，完成后会把结论交回来")}</span>
          )}
        </div>
      </div>
    </div>
  )
}
