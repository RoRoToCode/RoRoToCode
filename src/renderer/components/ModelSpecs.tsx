import { t as tr } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import type { CatalogModel, DownloadProgress, SystemSpecs } from '../../shared/types'

interface Props {
  onClose: () => void
}

function gb(bytes: number): string {
  if (!bytes || bytes < 0) return tr("未知")
  const n = bytes / 1024 ** 3
  return n >= 100 ? `${Math.round(n)} GB` : `${n.toFixed(1)} GB`
}

function mbps(bps: number): string {
  if (!bps) return ''
  return `${(bps / 1024 / 1024).toFixed(1)} MB/s`
}

/** 常见量化（Q4_K_M）大致占用：权重 + 少量上下文开销 */
const TIERS = [
  { get label() { return tr("3B 及以下") }, need: 2.5 },
  { label: '7B / 8B', need: 5 },
  { label: '14B', need: 9.5 },
  { label: '32B', need: 20 },
  { label: '70B', need: 43 }
]

/** 可用显存优先；没有独显时退回内存（CPU 推理约留 45% 余量给系统和上下文） */
function budgetOf(specs: SystemSpecs): { bytes: number; on: 'gpu' | 'cpu' } {
  const vram = specs.gpus.reduce((max, g) => Math.max(max, g.vramBytes), 0)
  if (vram >= 2 * 1024 ** 3) return { bytes: vram * 0.9, on: 'gpu' }
  return { bytes: specs.memory.totalBytes * 0.55, on: 'cpu' }
}

type FitKey = 'great' | 'ok' | 'slow' | 'no'

const FIT_LABEL: Record<FitKey, string> = {
  get great() { return tr("推荐") },
  get ok() { return tr("可跑") },
  get slow() { return tr("勉强 · 会变慢") },
  get no() { return tr("不适合") }
}

const FIT_ORDER: Record<FitKey, number> = { great: 0, ok: 1, slow: 2, no: 3 }

function fitOf(sizeBytes: number, budgetBytes: number): FitKey {
  const s = sizeBytes / 1024 ** 3
  const b = budgetBytes / 1024 ** 3
  if (s <= b * 0.8) return 'great'
  if (s <= b) return 'ok'
  if (s <= b * 1.8) return 'slow'
  return 'no'
}

export function ModelSpecs({ onClose }: Props) {
  const [specs, setSpecs] = useState<SystemSpecs | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const [catalog, setCatalog] = useState<CatalogModel[] | null>(null)
  const [catDir, setCatDir] = useState('')
  const [catOrigin, setCatOrigin] = useState<'remote' | 'builtin' | ''>('')
  const [catBusy, setCatBusy] = useState(false)
  // 联网检索可能要等很久，把等待秒数显示出来，用户才知道程序没卡死
  const [catElapsed, setCatElapsed] = useState(0)
  const [catErr, setCatErr] = useState('')
  const [query, setQuery] = useState('')
  const [dl, setDl] = useState<Record<string, DownloadProgress>>({})

  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    []
  )

  // 检索期间每秒刷新一次等待时长；结束（或关闭面板）时自动停表
  useEffect(() => {
    if (!catBusy) return
    setCatElapsed(0)
    const timer = window.setInterval(() => setCatElapsed((s) => s + 1), 1000)
    return () => window.clearInterval(timer)
  }, [catBusy])

  // 订阅下载进度（主进程按 id 推送）
  useEffect(() => {
    const off = window.pico.models.onProgress((p) => {
      if (!alive.current) return
      setDl((prev) => ({ ...prev, [p.id]: p }))
      if (p.state === 'done') {
        setCatalog((prev) => prev?.map((m) => (m.id === p.id ? { ...m, installed: true, downloading: false } : m)) ?? prev)
      }
      if (p.state === 'error' || p.state === 'cancelled') {
        setCatalog((prev) => prev?.map((m) => (m.id === p.id ? { ...m, downloading: false } : m)) ?? prev)
      }
    })
    return off
  }, [])

  async function detect(): Promise<SystemSpecs | null> {
    if (busy) return specs
    setBusy(true)
    setErr('')
    try {
      const s = await window.pico.system.specs()
      if (alive.current) setSpecs(s)
      return s
    } catch (e) {
      if (alive.current) setErr(tr("获取失败：{0}", { "0": (e as Error).message }))
      return null
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  // 打开面板就自动读本机硬件，不再需要单独点按钮
  useEffect(() => {
    void detect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 拉取可下载模型列表；没有硬件信息时先自动检测，才能排序和标注是否适合 */
  async function loadCatalog(opts?: { query?: string; refresh?: boolean }) {
    if (catBusy) return
    setCatBusy(true)
    setCatErr('')
    try {
      if (!specs) await detect()
      const r = await window.pico.models.catalog(opts)
      if (!alive.current) return
      setCatalog(r.models)
      setCatDir(r.dir)
      setCatOrigin(r.origin ?? '')
      if (!r.ok) setCatErr(r.message ?? tr("获取失败"))
      else if (r.message) setCatErr(r.message)
    } catch (e) {
      if (alive.current) setCatErr(tr("获取失败：{0}", { "0": (e as Error).message }))
    } finally {
      if (alive.current) setCatBusy(false)
    }
  }

  async function startDownload(id: string) {
    setCatErr('')
    setCatalog((prev) => prev?.map((m) => (m.id === id ? { ...m, downloading: true } : m)) ?? prev)
    try {
      const r = await window.pico.models.download(id)
      if (!alive.current) return
      if (!r.ok) {
        setCatErr(r.message)
        setCatalog((prev) => prev?.map((m) => (m.id === id ? { ...m, downloading: false } : m)) ?? prev)
      } else {
        // 下载成功后刷新一遍「已下载」状态
        const c = await window.pico.models.catalog()
        if (alive.current) setCatalog(c.models)
      }
    } catch (e) {
      if (alive.current) {
        setCatErr(tr("下载失败：{0}", { "0": (e as Error).message }))
        setCatalog((prev) => prev?.map((m) => (m.id === id ? { ...m, downloading: false } : m)) ?? prev)
      }
    }
  }

  const budget = specs ? budgetOf(specs) : null
  const best = budget ? [...TIERS].reverse().find((t) => t.need <= budget.bytes / 1024 ** 3) : null

  // 适合本机的排前面，同档内优先更大的（质量更高）
  const items = catalog
    ? [...catalog].sort((a, b) => {
        if (!budget) return a.sizeBytes - b.sizeBytes
        const fa = FIT_ORDER[fitOf(a.sizeBytes, budget.bytes)]
        const fb = FIT_ORDER[fitOf(b.sizeBytes, budget.bytes)]
        if (fa !== fb) return fa - fb
        return b.sizeBytes - a.sizeBytes
      })
    : null

  return (
    <div className="overlay guide-overlay specs-overlay" onClick={onClose}>
      <div className="modal guide-modal specs-modal" onClick={(e) => e.stopPropagation()}>
        <div className="guide-head">
          <h2>{tr("获取模型")}</h2>
          <button className="icon-btn" onClick={onClose} title={tr("关闭")}>
            {tr("关闭")}</button>
        </div>

        <div className="guide-body">
          <p className="guide-lead">
            {tr("按本机显存 / 内存挑选跑得动的模型，量化建议选")}<code>Q4_K_M</code>。
          </p>

          <div className="guide-actions specs-actions">
            <button
              className={`btn primary specs-fetch ${catBusy ? 'busy' : ''}`}
              disabled={catBusy}
              aria-busy={catBusy}
              onClick={() => void loadCatalog({ query, refresh: !!catalog })}
            >
              {catBusy && <span className="specs-spinner" aria-hidden="true" />}
              {catBusy ? tr("获取中…") : catalog ? tr("重新获取") : tr("获取可用模型")}
            </button>
            <input
              className="specs-search"
              value={query}
              placeholder={tr("搜索模型，如 qwen3 / gemma / coder")}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !catBusy) void loadCatalog({ query, refresh: true })
              }}
            />
          </div>

          {/* 联网检索慢时给出持续的动态反馈，别让用户以为界面卡住了 */}
          {catBusy && (
            <div className="specs-fetching" role="status" aria-live="polite">
              <div className="specs-fetching-row">
                <span className="specs-pulse" aria-hidden="true" />
                <b>{tr("正在联网检索可用模型…")}</b>
                {/* 秒数只给人看，别让读屏每秒念一次 */}
                <span className="specs-elapsed" aria-hidden="true">{tr("已等待 {0} 秒", { "0": catElapsed })}</span>
              </div>
              <div className="specs-fetching-track" aria-hidden="true"><i /></div>
              <p className="guide-note">{tr("首次检索可能要等几十秒，网络慢时会自动退回内置清单，请保持窗口打开。")}</p>
            </div>
          )}

          <p className="guide-warn specs-warn">
            {tr("下载会消耗较多流量与磁盘空间，可随时取消。")}</p>

          {err && <div className="guide-msg">{err}</div>}

          {busy && (
            <p className="guide-note specs-reading">
              <span className="specs-spinner" aria-hidden="true" />
              {tr("正在读取本机参数…")}
            </p>
          )}

          {specs && (
            <>
              <div className="specs-grid">
                <div className="specs-item">
                  <div className="k">CPU</div>
                  <div className="v">{specs.cpu.model}</div>
                  <div className="s">
                    {specs.cpu.physicalCores > 0 ? tr("{physicalCores} 核 ", { physicalCores: specs.cpu.physicalCores }) : ''}
                    {specs.cpu.logicalCores} {tr("线程")}{specs.cpu.speedGHz > 0 ? ` · ${specs.cpu.speedGHz} GHz` : ''}
                  </div>
                </div>

                <div className="specs-item">
                  <div className="k">{tr("内存")}</div>
                  <div className="v">{gb(specs.memory.totalBytes)}</div>
                  <div className="s">{tr("当前可用")}{gb(specs.memory.freeBytes)}</div>
                </div>

                {specs.gpus.length === 0 && (
                  <div className="specs-item">
                    <div className="k">{tr("显卡")}</div>
                    <div className="v">{tr("未检测到独立显卡")}</div>
                    <div className="s">{tr("将使用 CPU 推理，速度较慢")}</div>
                  </div>
                )}

                {specs.gpus.map((g) => (
                  <div className="specs-item" key={g.name}>
                    <div className="k">{tr("显卡")}</div>
                    <div className="v">{g.name}</div>
                    <div className="s">
                      {tr("显存")}{g.vramBytes > 0 ? gb(g.vramBytes) : tr("未知")}
                      {g.driver ? tr(" · 驱动 {driver}", { driver: g.driver }) : ''}
                    </div>
                  </div>
                ))}

                {specs.disk && (
                  <div className="specs-item">
                    <div className="k">{tr("磁盘（")}{specs.disk.path}）</div>
                    <div className="v">{tr("可用")}{gb(specs.disk.freeBytes)}</div>
                    <div className="s">{tr("共")}{gb(specs.disk.totalBytes)}</div>
                  </div>
                )}

                <div className="specs-item">
                  <div className="k">{tr("系统")}</div>
                  <div className="v">{specs.os.platform}</div>
                  <div className="s">{specs.os.arch}</div>
                </div>
              </div>

              <h3>{tr("可运行的模型规模")}</h3>
              <p className="guide-lead">
                {tr("按")}{budget?.on === 'gpu' ? tr("显存") : tr("内存")}{tr("估算（预留上下文与系统开销）")}{budget ? tr("，预算约 {0}", { "0": gb(budget.bytes) }) : ''}。
              </p>
              <div className="specs-tiers">
                {TIERS.map((t) => {
                  const fit = budget ? t.need <= budget.bytes / 1024 ** 3 : false
                  return (
                    <span key={t.label} className={`specs-tier ${fit ? 'on' : ''}`}>
                      {fit ? '✓' : '—'} {t.label}
                      <b>{t.need}GB</b>
                    </span>
                  )
                })}
              </div>
              {best && (
                <p className="guide-note">
                  {tr("建议从")}<b>{best.label}</b> {tr("的 Q4_K_M 量化版开始；更大的模型需要多卡或大内存。")}</p>
              )}
            </>
          )}

          {catErr && <div className="guide-msg">{catErr}</div>}

          {items && (
            <>
              <h3>{tr("可下载模型（")}{items.length} {tr("个）")}</h3>
              <p className="guide-lead">
                {catOrigin === 'builtin' ? tr("内置清单") : tr("实时检索")}
                {catDir ? (
                  <>
                    {tr(" · 下载到 ")}
                    <code>{catDir}</code>
                  </>
                ) : null}
                {tr(" · 已按本机配置排序")}
              </p>

              <div className="dl-list">
                {items.map((m) => {
                  const fit = budget ? fitOf(m.sizeBytes, budget.bytes) : null
                  const p = dl[m.id]
                  const running = p?.state === 'running' || !!m.downloading
                  // 主权重已在、投影器缺（老版本下的）：按钮要能点，且只补那一份
                  const needProjector = !!m.mmproj && m.mmprojInstalled === false
                  const pct =
                    p && p.totalBytes > 0 ? Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100)) : 0
                  return (
                    <div className={`dl-item ${m.installed ? 'installed' : ''}`} key={m.id}>
                      <div className="dl-main">
                        <div className="dl-title">
                          <b>{m.name}</b>
                          {fit && <span className={`dl-fit ${fit}`}>{FIT_LABEL[fit]}</span>}
                          {m.installed && !needProjector && <span className="dl-fit ok">{tr("已下载")}</span>}
                          {m.installed && needProjector && <span className="dl-fit slow">{tr("缺投影器")}</span>}
                          {m.mmproj && (
                            <span
                              className="dl-fit vision"
                              title={tr("下载时会一并下载视觉投影器")}
                            >
                              {tr("含视觉投影器")}
                            </span>
                          )}
                        </div>
                        <div className="dl-meta">
                          {m.family} · {m.paramsB > 0 ? `${m.paramsEstimated ? '≈' : ''}${m.paramsB}B` : tr("参数量未知")} · {m.quant} ·{' '}
                          {gb(m.sizeBytes)} · {m.sources.length} {tr("个源")}{running && p?.source ? tr(" · 正在用 {source}", { source: p.source }) : ''}
                        </div>
                        <div className="dl-note">{m.note}</div>
                      </div>

                      <div className="dl-act">
                        {running ? (
                          <>
                            <div className="dl-bar">
                              <i style={{ width: `${pct}%` }} />
                            </div>
                            <div className="dl-progress">
                              <span>
                                {p?.phase === 'mmproj' ? `${tr("投影器")} ` : ''}
                                {pct}%{p?.speedBps ? ` · ${mbps(p.speedBps)}` : ''}
                              </span>
                              <button className="dl-cancel" onClick={() => window.pico.models.cancel(m.id)}>
                                {tr("取消")}</button>
                            </div>
                          </>
                        ) : (
                          <button
                            className="btn"
                            disabled={!!m.installed && !needProjector}
                            onClick={() => void startDownload(m.id)}
                          >
                            {needProjector ? tr("补投影器") : m.installed ? tr("已就绪") : tr("下载")}
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>

              <p className="guide-note">
                {tr("下载完成后回到「本地模型」页点顶部")}<b>{tr("「刷新」")}</b>{tr("，再「一键启动」即可使用。")}</p>
            </>
          )}

          {/* 还没拿到列表时给几行占位骨架，避免长时间一片空白 */}
          {catBusy && !items && (
            <div className="specs-skeleton" aria-hidden="true">
              <div className="specs-skeleton-row" />
              <div className="specs-skeleton-row" />
              <div className="specs-skeleton-row" />
            </div>
          )}

          {!items && !catBusy && (
            <p className="guide-note">
              {tr("模型文件（.gguf）也可手动放到")}<code>models/</code> {tr("或")}<code>llama.cpp/</code> {tr("目录，回到「本地模型」页点「刷新」识别。")}</p>
          )}
        </div>
      </div>
    </div>
  )
}
