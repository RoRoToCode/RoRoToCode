import { t as tr } from '../i18n'
import { isPlainEnter } from '../keyboard'
import { useEffect, useRef, useState } from 'react'
import type { CatalogModality, CatalogModel, DownloadProgress, SystemSpecs } from '../../shared/types'

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

/** 音频 / 图像模型能下，但 llama.cpp 加载不了：列表里必须一眼看出来 */
const MODALITY_LABEL: Record<CatalogModality, string> = {
  text: '文本',
  vision: '视觉',
  audio: '音频',
  image: '图像/视频',
  other: '其他'
}
const MODALITY_TIP: Record<CatalogModality, string> = {
  text: '文本模型，可交给 llama.cpp / Ollama 直接加载',
  vision: '视觉语言模型，需要配套的 mmproj 投影器才能看图',
  audio: '音频模型，llama.cpp 无法加载，需要 whisper.cpp 等专用运行时',
  image: '图像 / 视频生成模型，llama.cpp 无法加载，需要 ComfyUI 等专用运行时',
  other: '非文本模型，本地运行时可能不兼容'
}
/** 排序时把不能直接跑的模型放到后面，别让它们盖住文本模型 */
const MODALITY_ORDER: Record<CatalogModality, number> = {
  text: 0,
  vision: 0,
  other: 1,
  audio: 1,
  image: 1
}

/** 标题后面的四个分类按钮；label / tip 存中文原文，渲染时才翻译（切换语言会重算） */
type CatFilter = 'all' | 'chat' | 'image' | 'audio'
interface CatTab {
  key: CatFilter
  label: string
  tip: string
}
const CAT_TABS: CatTab[] = [
  { key: 'all', label: '全部', tip: '显示全部已获取的模型' },
  {
    key: 'chat',
    label: '对话（含视觉）',
    tip: '文本 / 视觉对话模型，可交给 llama.cpp / Ollama 直接加载'
  },
  {
    key: 'image',
    label: '图像/视频',
    tip: '图像、视频生成模型：llama.cpp 无法加载，需 ComfyUI 等专用运行时'
  },
  {
    key: 'audio',
    label: '音频',
    tip: '语音 / 音频模型：llama.cpp 无法加载，需 whisper.cpp 等专用运行时'
  }
]

/**
 * 模态 → 分类。other 是任务标签认不出来的杂项模型，既不是图像也不是音频，
 * 归到对话组，保证「对话 + 图像/视频 + 音频」的数量加起来正好等于「全部」。
 */
function categoryOf(mod: CatalogModality): CatFilter {
  if (mod === 'image') return 'image'
  if (mod === 'audio') return 'audio'
  return 'chat'
}

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
  // 标题后的分类按钮：默认全部，切换只改前端筛选，不重新联网检索
  const [catFilter, setCatFilter] = useState<CatFilter>('all')
  /** 只看这台机器跑得动的：几百条结果里，装不下的那些只会干扰判断 */
  const [onlyFit, setOnlyFit] = useState(false)

  const alive = useRef(true)
  /** 每次检索一个编号：旧的检索迟到的条目会被丢掉，不会串进新列表 */
  const runSeq = useRef(0)
  const activeRun = useRef('')
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

  /**
   * 流式目录：主进程解析出一个模型就发一条。
   * 先到先显示，体积探测完成后会再发同 id 的一条，这里原地替换而不是整表重建。
   */
  useEffect(() => {
    const off = window.pico.models.onCatalogItem((item) => {
      if (!alive.current || !activeRun.current || item.runId !== activeRun.current) return
      if (item.dir) setCatDir(item.dir)
      setCatalog((prev) => {
        const list = prev ?? []
        const at = list.findIndex((m) => m.id === item.model.id)
        if (at < 0) return [...list, item.model]
        const next = list.slice()
        // 体积探测完成的更新不要覆盖掉界面上已经标记的「正在下载」
        const old = next[at]
        next[at] = { ...item.model, downloading: item.model.downloading || old.downloading }
        return next
      })
    })
    return off
  }, [])

  // 订阅下载进度（主进程按 id 广播）
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
    // 面板可能是切走又切回来的：下载一直在主进程里跑，先把当前进度接上
    void window.pico.downloads
      .snapshot()
      .then((s) => {
        if (!alive.current || !s.models.length) return
        setDl((prev) => {
          const next = { ...prev }
          for (const p of s.models) {
            const old = next[p.id]
            // 快照比手上的旧进度更新才覆盖，避免把刚收到的新进度退回去
            if (!old || old.state !== 'running' || p.receivedBytes >= old.receivedBytes) next[p.id] = p
          }
          return next
        })
      })
      .catch(() => undefined)
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
    const runId = String(++runSeq.current)
    activeRun.current = runId
    setCatBusy(true)
    setCatErr('')
    setCatOrigin('')
    // 清空后由流式事件一条条填回来：解析出一个就显示一个，不用等 300 条全探测完
    setCatalog([])
    try {
      if (!specs) await detect()
      const r = await window.pico.models.catalog({ ...opts, runId })
      if (!alive.current || activeRun.current !== runId) return
      // 收尾用完整结果覆盖一遍，保证顺序、去重和体积最终一致
      setCatalog(r.models)
      setCatDir(r.dir)
      setCatOrigin(r.origin ?? '')
      if (!r.ok) setCatErr(r.message ?? tr("获取失败"))
      else if (r.message) setCatErr(r.message)
    } catch (e) {
      if (alive.current && activeRun.current === runId) {
        setCatErr(tr("获取失败：{0}", { "0": (e as Error).message }))
      }
    } finally {
      if (alive.current && activeRun.current === runId) setCatBusy(false)
    }
  }

  /** 只原地刷新本地状态，不重跑网络检索，也不改变列表内容与顺序 */
  async function refreshInstalled() {
    try {
      const c = await window.pico.models.catalog({ localOnly: true })
      if (!alive.current) return
      const fresh = new Map(c.models.map((m) => [m.id, m]))
      setCatalog((prev) =>
        prev?.map((m) => {
          const f = fresh.get(m.id)
          return f
            ? { ...m, installed: f.installed, mmprojInstalled: f.mmprojInstalled, downloading: f.downloading }
            : m
        }) ?? prev
      )
    } catch {
      // 状态刷新失败不影响下载结果本身
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
        // 下载成功后只重读本地状态，不再触发一次 300 条的联网检索
        await refreshInstalled()
      }
    } catch (e) {
      if (alive.current) {
        setCatErr(tr("下载失败：{0}", { "0": (e as Error).message }))
        setCatalog((prev) => prev?.map((m) => (m.id === id ? { ...m, downloading: false } : m)) ?? prev)
      }
    }
  }

  /** 删掉本地模型文件：坏了要重下、想腾磁盘时用得上（以前只能去资源管理器翻） */
  async function removeModel(id: string) {
    setCatErr('')
    try {
      const r = await window.pico.models.remove(id)
      if (!alive.current) return
      if (!r.ok) {
        setCatErr(r.message)
        return
      }
      await refreshInstalled()
    } catch (e) {
      if (alive.current) setCatErr(tr("删除失败：{0}", { "0": (e as Error).message }))
    }
  }

  const budget = specs ? budgetOf(specs) : null
  const best = budget ? [...TIERS].reverse().find((t) => t.need <= budget.bytes / 1024 ** 3) : null

  // 分类按钮上的数字徽标：按完整目录统计，不受当前选中的分类影响
  const catCounts: Record<CatFilter, number> = { all: catalog?.length ?? 0, chat: 0, image: 0, audio: 0 }
  for (const m of catalog ?? []) catCounts[categoryOf(m.modality ?? 'text')]++
  const activeCat = CAT_TABS.find((tab) => tab.key === catFilter) ?? CAT_TABS[0]

  /**
   * 「装得下」沿用列表上那个标记：只有 no（超过预算 1.8 倍）才藏起来。
   * slow 那档（≤1.8 倍）现在有部分 offload 兜着，确实能跑 —— 把它也藏掉
   * 等于告诉用户「8G 卡什么都别想下」，那是假话。
   */
  const fitsHere = (m: CatalogModel): boolean =>
    !budget || m.sizeBytes <= 0 || fitOf(m.sizeBytes, budget.bytes) !== 'no'

  // 适合本机的排前面，同档内优先更大的（质量更高）
  const byCat = catalog
    ? // 分类按钮只做前端筛选，切换时不用重新联网检索
      catalog.filter((m) => catFilter === 'all' || categoryOf(m.modality ?? 'text') === catFilter)
    : null
  const hiddenByFit = onlyFit ? (byCat ?? []).filter((m) => !fitsHere(m)).length : 0
  const items = byCat
    ? [...byCat]
        .filter((m) => !onlyFit || fitsHere(m))
        .sort((a, b) => {
          // 文本 / 视觉排前面，音频 / 图像往后放，避免列表被专用模型刷满
          const ma = MODALITY_ORDER[a.modality ?? 'text']
          const mb = MODALITY_ORDER[b.modality ?? 'text']
          if (ma !== mb) return ma - mb
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
          {/* 拿到目录后才出现；流式检索期间数字会随条目一起涨 */}
          {catalog && (
            <div className="specs-cats" role="group" aria-label={tr("模型分类")}>
              {CAT_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  className={`guide-tab specs-cat ${catFilter === tab.key ? 'on' : ''}`}
                  aria-pressed={catFilter === tab.key}
                  title={tr(tab.tip)}
                  onClick={() => setCatFilter(tab.key)}
                >
                  {tr(tab.label)}
                  <span className="specs-cat-count">{catCounts[tab.key]}</span>
                </button>
              ))}
            </div>
          )}
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
                if (isPlainEnter(e) && !catBusy) void loadCatalog({ query, refresh: true })
              }}
            />
            {/* 切到需要专用运行时的分类时，把限制直接写在按钮旁边 */}
            {(catFilter === 'image' || catFilter === 'audio') && (
              <span className="specs-cat-hint" role="note">{tr(activeCat.tip)}</span>
            )}
          </div>

          {/* 联网检索慢时给出持续的动态反馈，别让用户以为界面卡住了 */}
          {catBusy && (
            <div className="specs-fetching" role="status" aria-live="polite">
              <div className="specs-fetching-row">
                <span className="specs-pulse" aria-hidden="true" />
                <b>
                  {tr("正在联网检索可用模型…")}
                  {catalog?.length ? tr(" 已显示 {length} 个", { length: catalog.length }) : ''}
                </b>
                {/* 秒数只给人看，别让读屏每秒念一次 */}
                <span className="specs-elapsed" aria-hidden="true">{tr("已等待 {0} 秒", { "0": catElapsed })}</span>
              </div>
              <div className="specs-fetching-track" aria-hidden="true"><i /></div>
              <p className="guide-note">{tr("模型会边解析边显示，体积随后逐个补齐；网络慢时会退回内置清单。")}</p>
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
              <h3>
                {tr("可下载模型（")}{items.length} {tr("个）")}
                {catFilter !== 'all' ? ` · ${tr(activeCat.label)}` : ''}
                {catBusy ? tr(" · 边解析边显示，已获取 {total} 个", { total: catalog?.length ?? 0 }) : ''}
              </h3>
              <div className="specs-filter">
                <label title={tr("只留下这台机器装得下的；标着「勉强」的仍会显示，它们可以靠部分卸载跑起来")}>
                  <input
                    type="checkbox"
                    checked={onlyFit}
                    onChange={(e) => setOnlyFit(e.target.checked)}
                    style={{ width: 'auto' }}
                  />
                  {tr("只看这台机器跑得动的")}
                </label>
                {onlyFit && hiddenByFit > 0 && (
                  <span className="note">
                    {tr("已隐藏 {0} 个装不下的模型", { "0": String(hiddenByFit) })}
                  </span>
                )}
              </div>
              <p className="guide-lead">
                {catOrigin === 'builtin' ? tr("内置清单") : tr("实时检索")}
                {catOrigin !== 'builtin' ? tr(" · 目录来自 HF 镜像 / HF 官方 / 魔搭") : ''}
                {catDir ? (
                  <>
                    {tr(" · 下载到 ")}
                    <code>{catDir}</code>
                  </>
                ) : null}
                {tr(" · 已按本机配置排序")}
                {catFilter !== 'chat' ? tr(" · 音频 / 图像模型已标注，需专用运行时") : ''}
              </p>

              {items.length === 0 && !catBusy && (
                <p className="guide-note specs-cats-empty">
                  {tr("该分类下暂无模型。")}
                  <button className="link-btn" onClick={() => setCatFilter('all')}>{tr("查看全部")}</button>
                </p>
              )}

              <div className="dl-list">
                {items.map((m) => {
                  // 体积还没探测出来时不给「推荐 / 不适合」结论，免得误导
                  const fit = budget && m.sizeBytes > 0 ? fitOf(m.sizeBytes, budget.bytes) : null
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
                          {m.modality && m.modality !== 'text' && (
                            <span
                              className={`dl-fit mod-${m.modality}`}
                              title={tr(MODALITY_TIP[m.modality])}
                            >
                              {tr(MODALITY_LABEL[m.modality])}
                            </span>
                          )}
                          {m.probing && <span className="dl-fit probing">{tr("体积探测中")}</span>}
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
                          {m.probing ? tr("体积探测中") : m.sizeBytes > 0 ? gb(m.sizeBytes) : tr("体积未知")} ·{' '}
                          {m.sources.length} {tr("个源")}
                          {m.sourceSite ? tr(" · 目录 {site}", { site: m.sourceSite }) : ''}
                          {running && p?.source ? tr(" · 正在用 {source}", { source: p.source }) : ''}
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
                                {p?.phase === 'mmproj'
                                  ? `${tr("投影器")} `
                                  : p?.phase === 'verify'
                                    ? `${tr("校验")} `
                                    : ''}
                                {pct}%{p?.speedBps ? ` · ${mbps(p.speedBps)}` : ''}
                              </span>
                              <button className="dl-cancel" onClick={() => window.pico.models.cancel(m.id)}>
                                {tr("取消")}</button>
                            </div>
                          </>
                        ) : (
                          <>
                            <button
                              className="btn"
                              disabled={!!m.installed && !needProjector}
                              onClick={() => void startDownload(m.id)}
                            >
                              {needProjector ? tr("补投影器") : m.installed ? tr("已就绪") : tr("下载")}
                            </button>
                            {/* 磁盘腾地方 / 文件坏了要重下：本地删掉再下，不用去翻资源管理器 */}
                            {m.installed && (
                              <button className="dl-cancel" onClick={() => void removeModel(m.id)}>
                                {tr("删除")}
                              </button>
                            )}
                          </>
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
          {catBusy && (!items || items.length === 0) && (
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
