import { t as tr } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import type { BaseToolStatus, ToolSetupProgress } from '../../shared/types'
import { Chevron, useCollapse } from './Collapse'

/**
 * 基础核心库：检测 Node.js / Git / Python 装了没，
 * 一次点击把缺的官方安装包下回来并静默装好（安装时弹一次管理员授权）。
 */
export function BaseTools() {
  const [open, toggle] = useCollapse('base-tools-card', true)
  const [tools, setTools] = useState<BaseToolStatus[] | null>(null)
  const [busy, setBusy] = useState<'check' | 'install' | null>(null)
  const [msg, setMsg] = useState('')
  const [prog, setProg] = useState<ToolSetupProgress | null>(null)
  const alive = useRef(true)

  useEffect(
    () => () => {
      alive.current = false
    },
    []
  )

  useEffect(() => {
    void refresh(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const off = window.pico.tools.onProgress((p) => {
      if (alive.current) setProg(p)
    })
    return off
  }, [])

  async function refresh(verbose: boolean) {
    setBusy('check')
    try {
      const list = await window.pico.tools.check()
      if (!alive.current) return
      setTools(list)
      if (verbose) {
        const miss = list.filter((t) => !t.installed)
        setMsg(miss.length === 0 ? tr("基础环境齐全，可以直接用。") : tr("还差 {length} 项：{1}", { length: miss.length, "1": miss.map((m) => m.label).join('、') }))
      }
    } catch (err) {
      if (alive.current) setMsg(tr("检测失败：{0}", { "0": (err as Error).message }))
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  async function install() {
    if (busy) return
    const missing = (tools ?? []).filter((t) => !t.installed)
    if (missing.length === 0) {
      setMsg(tr("三项都已经装好了，不需要再装。"))
      return
    }
    setBusy('install')
    setMsg(tr("正在准备安装包…"))
    try {
      const r = await window.pico.tools.install(missing.map((t) => t.id))
      if (!alive.current) return
      setMsg(r.message)
      if (r.tools) setTools(r.tools)
    } catch (err) {
      if (alive.current) setMsg(tr("安装失败：{0}", { "0": (err as Error).message }))
    } finally {
      if (alive.current) {
        setBusy(null)
        setProg(null)
      }
    }
  }

  const missingCount = (tools ?? []).filter((t) => !t.installed).length
  const allOk = tools !== null && missingCount === 0

  const progressText = (() => {
    if (busy !== 'install' || !prog) return ''
    if (prog.phase === 'download') {
      const pct = prog.totalBytes > 0 ? Math.round((prog.receivedBytes / prog.totalBytes) * 100) : 0
      return tr("正在下载 {label}{1}", { label: prog.label, "1": prog.totalBytes > 0 ? ` ${pct}%` : '' })
    }
    if (prog.phase === 'install') return tr("正在静默安装，可能需要几分钟…")
    return ''
  })()

  return (
    <div className={`guide-card ${open ? '' : 'collapsed'}`}>
      <div
        className="guide-card-head"
        onClick={toggle}
        title={open ? tr("收起") : tr("展开")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') toggle()
        }}
      >
        <h3>{tr("本机基础环境")}</h3>
        {tools === null ? (
          <span className="guide-badge cpu">{tr("检测中…")}</span>
        ) : allOk ? (
          <span className="guide-badge">{tr("已就绪")}</span>
        ) : (
          <span className="guide-badge cpu">{missingCount} {tr("项未装")}</span>
        )}
        <Chevron open={open} />
      </div>

      <p className="guide-lead">
        {tr("点「一键安装」会自动从官网下载安装包并静默装好，安装过程会弹一次管理员授权窗口；装完重启本程序即可生效。")}</p>

      <ul className="tool-list">
        {(tools ?? []).map((t) => (
          <li key={t.id} className="tool-row">
            <span className="tool-name">{t.label}</span>
            <span className={`tool-state ${t.installed ? 'ok' : 'miss'}`}>
              {t.installed ? tr("已安装 {0}", { "0": t.version ?? '' }).trim() : tr("未安装")}
            </span>
          </li>
        ))}
        {tools === null && <li className="tool-row">{tr("正在检测本机环境…")}</li>}
      </ul>

      <div className="guide-actions">
        <button
          className="btn primary"
          disabled={!!busy || allOk}
          onClick={() => void install()}
          title={allOk ? tr("三项都已安装") : tr("将安装 {missingCount} 个缺失组件", { missingCount: missingCount })}
        >
          {busy === 'install' ? progressText || tr("安装中…") : missingCount > 0 ? tr("一键安装（{missingCount} 项）", { missingCount: missingCount }) : tr("一键安装")}
        </button>
        <button className="btn" disabled={!!busy} onClick={() => void refresh(true)}>
          {busy === 'check' ? tr("检测中…") : tr("重新检测")}
        </button>
      </div>

      {busy === 'install' && progressText && <div className="guide-msg">{progressText}</div>}
      {msg && <div className="guide-msg">{msg}</div>}
    </div>
  )
}
