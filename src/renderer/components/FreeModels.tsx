import { t as tr } from '../i18n'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FreeCatalog, FreeModel, FreeSource } from '../../shared/types'

interface Props {
  /** 把一个来源（可选具体模型）加成供应商；Settings 负责去重和写进草稿 */
  onAdd: (source: FreeSource, model?: FreeModel) => void
}

const k = (n: number): string => (n >= 1024 ? `${Math.round(n / 1024)}K` : n > 0 ? String(n) : '—')

/**
 * 「模型 API」页里的免费模型清单。
 *
 * OpenRouter 走公开目录（不需要 key），其余几家只能给地址和申请入口——
 * 它们的模型列表必须填了 key 才读得到，所以这里不硬编模型名，免得写死一个已经下线的。
 */
export function FreeModels({ onAdd }: Props) {
  const [cat, setCat] = useState<FreeCatalog | null>(null)
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')
  const [expand, setExpand] = useState(false)

  const load = useCallback(async (refresh: boolean) => {
    setBusy(true)
    try {
      const list = await window.pico.free.list({ refresh })
      setCat(list)
    } catch (err) {
      setCat({ sources: [], fetchedAt: 0, error: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  const openrouter = cat?.sources.find((s) => s.id === 'openrouter')
  const others = cat?.sources.filter((s) => s.id !== 'openrouter') ?? []

  const models = useMemo(() => {
    const list = openrouter?.models ?? []
    const key = q.trim().toLowerCase()
    if (!key) return list
    return list.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(key))
  }, [openrouter, q])

  const shown = expand ? models : models.slice(0, 10)
  const freeWithTools = models.filter((m) => m.tools).length
  const when = cat?.fetchedAt ? new Date(cat.fetchedAt).toLocaleString('zh-CN') : ''

  return (
    <div className="free-box">
      <div className="free-head">
        <div>
          <h3>{tr("免费模型")}</h3>
          <p className="free-sub">
            {tr("额度不够或连不上时，把某个供应商勾成「备用」即可自动切换。")}</p>
        </div>
        <button className="btn" disabled={busy} onClick={() => void load(true)}>
          {busy ? tr("拉取中…") : tr("刷新目录")}
        </button>
      </div>

      {cat?.error && <div className="free-error">{cat.error}</div>}

      {openrouter && (
        <div className="free-src">
          <div className="free-src-head">
            <span className="free-name">OpenRouter</span>
            <span className="free-meta">
              {busy && !cat?.sources.length
                ? tr("正在拉取…")
                : tr("{length} 个免费模型 · {freeWithTools} 个支持工具调用", { length: models.length, freeWithTools: freeWithTools })}
              {when ? tr(" · 更新于 {when}", { when: when }) : ''}
            </span>
            <a className="free-link" href={openrouter.keyUrl} target="_blank" rel="noreferrer">
              {tr("申请 Key")}</a>
          </div>
          <p className="free-hint">{openrouter.hint}</p>

          <div className="free-tools-row">
            <input
              className="free-search"
              value={q}
              placeholder={tr("筛选模型名，如 coder / qwen / deepseek")}
              onChange={(e) => {
                setQ(e.target.value)
                setExpand(false)
              }}
            />
            {models.length > 10 && (
              <button className="btn sm" onClick={() => setExpand((v) => !v)}>
                {expand ? tr("只看前 10 个") : tr("显示全部 {length} 个", { length: models.length })}
              </button>
            )}
          </div>

          {openrouter.error && <div className="free-error">{openrouter.error}</div>}

          <div className="free-list">
            {shown.map((m) => (
              <div className="free-row" key={m.id}>
                <div className="free-row-main">
                  <span className="free-model">{m.name}</span>
                  <span className="free-id">{m.id}</span>
                </div>
                <span className={`free-tag ${m.tools ? 'ok' : 'off'}`}>{m.tools ? tr("支持工具") : tr("仅对话")}</span>
                <span className="free-ctx">{k(m.context)}</span>
                <button className="btn sm" onClick={() => onAdd(openrouter, m)}>
                  {tr("使用")}</button>
              </div>
            ))}
            {!shown.length && !busy && (
              <div className="free-empty">
                {q.trim() ? tr("没有匹配的模型") : tr("目录里暂时没有免费模型，过一会儿再刷新试试")}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="free-others">
        {others.map((s) => (
          <div className="free-card" key={s.id}>
            <div className="free-card-top">
              <span className="free-name">{s.name}</span>
              <button className="btn sm" onClick={() => onAdd(s)}>
                {tr("添加")}</button>
            </div>
            <p className="free-hint">{s.hint}</p>
            <a className="free-link" href={s.keyUrl} target="_blank" rel="noreferrer">
              {tr("去申请 Key")}</a>
          </div>
        ))}
      </div>
    </div>
  )
}
