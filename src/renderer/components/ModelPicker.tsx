import { t as tr } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import type { ProviderConfig } from '../../shared/types'

export type ProbeState = 'checking' | 'ok' | 'fail'

export interface ProbeInfo {
  state: ProbeState
  error?: string
}

export function StatusDot({ state, error }: { state: ProbeState; error?: string }) {
  if (state === 'ok') {
    return <span className="dot ok" title={tr("可用")} />
  }
  if (state === 'fail') {
    return (
      <span className="dot fail" title={error ? tr("不可用：{error}", { error: error }) : tr("不可用")}>
        <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M1.8 1.8l6.4 6.4M8.2 1.8l-6.4 6.4"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
      </span>
    )
  }
  return <span className="dot checking" title={tr("检测中")} />
}

interface Props {
  providers: ProviderConfig[]
  activeId: string | null
  probes: Record<string, ProbeInfo>
  onSelect: (id: string) => void
  onRefresh: () => void
  /** 一个模型都没有时，引导去模型设置 */
  onOpenSettings?: () => void
}

export function ModelPicker({ providers, activeId, probes, onSelect, onRefresh, onOpenSettings }: Props) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const empty = providers.length === 0
  const active = providers.find((p) => p.id === activeId) ?? providers[0] ?? null
  const activeProbe = probes[active?.id ?? ''] ?? { state: 'checking' as ProbeState }

  return (
    <div className="model-picker" ref={boxRef}>
      <button
        className={`model-trigger ${open ? 'open' : ''}`}
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) onRefresh()
        }}
        title={tr("切换模型")}
      >
        {empty ? (
          <span className="model-trigger-warn">!</span>
        ) : (
          <StatusDot state={activeProbe.state} error={activeProbe.error} />
        )}
        <span className="model-trigger-text">
          {empty ? tr("还没有模型 · 点这里添加") : active ? tr("{name} · {1}", { name: active.name, "1": active.model || tr("未选择模型") }) : tr("未配置模型")}
        </span>
        <svg className="chev" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="model-menu">
          <div className="model-menu-head">
            <span>{tr("选择模型")}</span>
            <button
              className="model-menu-refresh"
              onClick={() => onRefresh()}
              title={tr("重新检测可用性")}
            >
              {tr("重新检测")}</button>
          </div>
          {empty && (
            <div className="model-menu-empty">
              <div className="model-menu-empty-title">{tr("还没有任何模型")}</div>
              <div className="model-menu-empty-tip">{tr("请点击模型设置 添加模型")}</div>
              {onOpenSettings && (
                <button
                  className="btn primary sm"
                  onClick={() => {
                    setOpen(false)
                    onOpenSettings()
                  }}
                >
                  {tr("打开模型设置")}</button>
              )}
            </div>
          )}
          {providers.map((p) => {
            const probe = probes[p.id] ?? { state: 'checking' as ProbeState }
            return (
              <button
                key={p.id}
                className={`model-item ${p.id === active?.id ? 'active' : ''}`}
                onClick={() => {
                  onSelect(p.id)
                  setOpen(false)
                }}
              >
                <StatusDot state={probe.state} error={probe.error} />
                <span className="model-item-body">
                  <span className="model-item-name">
                    {p.name}
                    <span className="model-item-id">{p.model || tr("未选择模型")}</span>
                  </span>
                  {probe.state === 'checking' && (
                    <span className="model-item-state checking">{probe.error ?? tr("正在检测…")}</span>
                  )}
                  {probe.state === 'ok' && <span className="model-item-state ok">{tr("可用")}</span>}
                  {probe.state === 'fail' && probe.error && (
                    <span className="model-item-error">{probe.error}</span>
                  )}
                </span>
                {p.id === active?.id && <span className="model-item-check">{tr("当前")}</span>}
              </button>
            )
          })}
          {!empty && (
            <div className="model-menu-foot">{tr("绿点表示当前可用，红叉表示连不上或模型不存在")}</div>
          )}
        </div>
      )}
    </div>
  )
}
