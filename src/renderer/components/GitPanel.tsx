import { t as tr } from '../i18n'
import { isPlainEnter } from '../keyboard'
import { useCallback, useEffect, useState } from 'react'
import type { GitStatus } from '../../shared/types'

interface Props {
  workspace: string | null
  active: boolean
  onNotify: (message: string, kind?: 'info' | 'warn' | 'error') => void
}

/** 工作区 Git：看改了哪些文件、看 diff、写一句提交信息直接提交 */
export function GitPanel({ workspace, active, onNotify }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!workspace) {
      setStatus({ ok: false, files: [], message: tr("还没有选择工作区") })
      return
    }
    try {
      const st = await window.pico.git.status(workspace)
      setStatus(st)
      if (!st.files.some((f) => f.path === selected)) {
        setSelected(null)
        setDiff('')
      }
    } catch (err) {
      setStatus({ ok: false, files: [], message: (err as Error).message })
    }
  }, [workspace, selected])

  useEffect(() => {
    if (!active) return
    void refresh()
    // 只在切到本标签页时拉一次，避免每次切会话都跑 git
  }, [active, workspace]) // eslint-disable-line react-hooks/exhaustive-deps

  async function showDiff(file: string) {
    if (!workspace) return
    setSelected(file)
    setDiff('')
    const r = await window.pico.git.diff(workspace, file)
    setDiff(r.ok ? r.text : r.message ?? tr("读取失败"))
  }

  async function commit() {
    if (!workspace) return
    setBusy(true)
    try {
      const r = await window.pico.git.commit(workspace, message)
      onNotify(r.message, r.ok ? 'info' : 'error')
      if (r.ok) setMessage('')
      await refresh()
    } catch (err) {
      // git 不在 PATH / 目录被占用时 IPC 会直接 reject，不接住就是「点了没反应」
      onNotify(tr("提交失败：{0}", { "0": (err as Error).message }), 'error')
    } finally {
      setBusy(false)
    }
  }

  if (!status) return <div className="panel-empty">{tr("正在读取 git 状态…")}</div>

  if (!status.ok) {
    return (
      <div className="git">
        <div className="panel-empty">{status.message ?? tr("git 不可用")}</div>
        <div className="git-foot">
          <button className="btn sm" onClick={() => void refresh()}>
            {tr("重试")}</button>
        </div>
      </div>
    )
  }

  return (
    <div className="git">
      <div className="git-head">
        <span className="git-branch" title={tr("当前分支")}>
          {status.branch || '(no branch)'}
        </span>
        <span className="git-count">{status.files.length} {tr("个改动")}</span>
        <button className="btn sm" onClick={() => void refresh()}>
          {tr("刷新")}</button>
      </div>

      {status.files.length === 0 ? (
        <div className="panel-empty">{tr("工作区是干净的，没有未提交的改动。")}</div>
      ) : (
        <div className="git-files">
          {status.files.map((f) => (
            <button
              key={f.path}
              className={`git-file ${selected === f.path ? 'on' : ''}`}
              onClick={() => void showDiff(f.path)}
              title={f.path}
            >
              <span className={`git-code ${f.untracked ? 'new' : 'mod'}`}>{f.status}</span>
              <span className="git-path">{f.path}</span>
            </button>
          ))}
        </div>
      )}

      {selected && <pre className="git-diff">{diff || tr("（没有差异内容）")}</pre>}

      <div className="git-commit">
        <input
          value={message}
          placeholder={tr("提交信息，例如：修复导出按钮")}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (isPlainEnter(e) && message.trim()) void commit()
          }}
        />
        <button
          className="btn primary sm"
          disabled={busy || !message.trim() || status.files.length === 0}
          onClick={() => void commit()}
        >
          {busy ? tr("提交中…") : tr("提交全部")}
        </button>
      </div>
      <div className="git-note">{tr("等于 git add -A 后 commit，只影响本地，不会 push。")}</div>
    </div>
  )
}
