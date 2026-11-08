import { t as tr } from '../i18n'
import { useEffect, useState } from 'react'
import type { ChangeDetail, FileChange } from '../../shared/types'
import { DiffView } from './DiffView'

interface Props {
  sessionId: string | null
  /** 变化时重新拉取（收到 file_change 事件、切换会话） */
  refreshKey: number
  onNotify: (message: string, kind?: 'info' | 'warn' | 'error') => void
  /** 撤销后让外层刷新一下产出列表 */
  onReverted?: () => void
}

/**
 * 变更面板：本次会话里模型改过的每个文件都留了一条可撤销的快照。
 * 点一行看 diff，点「撤销」把文件恢复成改之前的样子。
 */
export function ChangesPanel({ sessionId, refreshKey, onNotify, onReverted }: Props) {
  const [list, setList] = useState<FileChange[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ChangeDetail | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    if (!sessionId) {
      setList([])
      return
    }
    void window.pico.changes
      .list(sessionId)
      .then((items) => {
        if (alive) setList(items)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [sessionId, refreshKey])

  async function toggle(id: string) {
    if (openId === id) {
      setOpenId(null)
      setDetail(null)
      return
    }
    setOpenId(id)
    setDetail(null)
    if (!sessionId) return
    const d = await window.pico.changes.detail(sessionId, id)
    setDetail(d)
  }

  async function revertOne(id: string) {
    if (!sessionId) return
    setBusy(true)
    try {
      const r = await window.pico.changes.revert(sessionId, id)
      onNotify(r.message, r.ok ? 'info' : 'error')
      if (r.ok) {
        setOpenId(null)
        setDetail(null)
        setList(await window.pico.changes.list(sessionId))
        onReverted?.()
      }
    } finally {
      setBusy(false)
    }
  }

  async function revertAll() {
    if (!sessionId) return
    setBusy(true)
    try {
      const r = await window.pico.changes.revertAll(sessionId)
      onNotify(r.message, r.ok ? 'info' : 'error')
      setList(await window.pico.changes.list(sessionId))
      setOpenId(null)
      setDetail(null)
      onReverted?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="changes">
      <div className="changes-head">
        <span>{list.length ? tr("本次会话改了 {length} 处", { length: list.length }) : tr("本次会话还没有文件改动")}</span>
        {list.length > 0 && (
          <button className="btn sm danger" disabled={busy} onClick={() => void revertAll()}>
            {tr("全部撤销")}</button>
        )}
      </div>

      {list.length === 0 ? (
        <div className="panel-empty">
          {tr("每次改文件前都留快照，改坏了点撤销。")}</div>
      ) : (
        <div className="change-list">
          {list.map((c) => (
            <div className={`change-item ${openId === c.id ? 'open' : ''}`} key={c.id}>
              <button className="change-row" onClick={() => void toggle(c.id)}>
                <span className={`change-kind ${c.kind}`}>
                  {c.kind === 'create' ? tr("新建") : c.kind === 'delete' ? tr("删除") : tr("修改")}
                </span>
                <span className="change-path" title={c.path}>
                  {c.path}
                </span>
                <span className="change-stat">
                  {c.added ? <em className="add">+{c.added}</em> : null}
                  {c.removed ? <em className="del">−{c.removed}</em> : null}
                </span>
                <span className="change-time">
                  {new Date(c.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </button>
              {openId === c.id && (
                <div className="change-body">
                  {detail ? (
                    <DiffView lines={detail.lines} max={300} />
                  ) : (
                    <div className="panel-empty">{tr("正在读取改动…")}</div>
                  )}
                  <div className="change-actions">
                    <button
                      className="btn sm"
                      disabled={busy || detail?.revertable === false}
                      title={detail?.revertable === false ? tr("文件太大没有保存原文") : tr("恢复成改之前的内容")}
                      onClick={() => void revertOne(c.id)}
                    >
                      {tr("撤销这处改动")}</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
