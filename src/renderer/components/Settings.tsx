import { t as tr } from '../i18n'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppConfig, FreeModel, FreeSource, ProviderConfig, ProviderKind, WorkerPlan } from '../../shared/types'
import { isLlamaProvider, llamaPortOf, runtimeKindOf } from '../../shared/providers'
import { StatusDot, type ProbeInfo, type ProbeState } from './ModelPicker'
import { LocalModels, type LocalModelsHandle } from './LocalModels'
import { ModelSpecs } from './ModelSpecs'
import { BaseTools } from './BaseTools'
import { SimpleCore } from './SimpleCore'
import { ExternalAccess } from './ExternalAccess'
import { Chevron, useCollapse } from './Collapse'
import { ModelCombo } from './ModelCombo'
import { FreeModels } from './FreeModels'

/** 四个标签页：原来「模型引导」里的三块并入设置，原供应商列表变成第 4 页 */
const TABS = [
  { key: 'base', get label() { return tr("① 基础核心") } },
  { key: 'local', get label() { return tr("② 本地模型") } },
  { key: 'api', get label() { return tr("③ 模型 API") } },
  { key: 'list', get label() { return tr("④ 模型列表") } }
] as const
export type TabKey = (typeof TABS)[number]['key']

/** 设置页里的大段说明默认收起，点标题展开：不占地方，需要时还能查到 */
function Fold({
  id,
  title,
  children
}: {
  id: string
  title: string
  children: ReactNode
}) {
  const [open, toggle] = useCollapse(`settings-${id}`, false)
  return (
    <div className={`guide-fold ${open ? 'open' : ''}`}>
      <button type="button" className="guide-fold-head" onClick={toggle} title={open ? tr("收起") : tr("展开")}>
        <span>{title}</span>
        <Chevron open={open} />
      </button>
      {open && <div className="guide-fold-body">{children}</div>}
    </div>
  )
}

function Code({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    const clip = navigator.clipboard
    if (!clip) return
    void clip.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <div className="guide-code">
      <code>{text}</code>
      <button className="guide-copy" onClick={copy}>
        {copied ? tr("已复制") : tr("复制")}
      </button>
    </div>
  )
}

function Link({ href }: { href: string }) {
  return (
    <a className="guide-link" href={href} target="_blank" rel="noreferrer">
      {href}
    </a>
  )
}

interface Props {
  config: AppConfig
  probes: Record<string, ProbeInfo>
  modelCache: Record<string, string[]>
  onRefresh: () => void
  onConfigChanged: () => void | Promise<void>
  onClose: () => void
  onSave: (config: AppConfig) => Promise<void>
  /** 打开时默认停在哪个标签页（首次运行引导会直接落到「① 基础核心」） */
  initialTab?: TabKey
}

const KIND_LABEL: Record<ProviderKind, string> = {
  get openai() { return tr("OpenAI 兼容") },
  anthropic: 'Anthropic',
  ollama: 'Ollama / LM Studio'
}

// 每个供应商一个可辨识的颜色（按原始顺序分配，排序后不变）
const PALETTE = ['#7c9cf5', '#4ec9b0', '#e0a458', '#c586c0', '#6ec1e4', '#d7ba7d', '#8fd16b', '#f07178']

const RANK: Record<ProbeState, number> = { ok: 0, checking: 1, fail: 2 }

/** 只看文件名：配置里存的、扫描到的可能是绝对路径 */
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p

/** 本地运行的三家：llama.cpp 自己管进程，Ollama / LM Studio 是常驻服务 */
type RtKind = 'llama' | 'ollama' | 'lmstudio'

const RT_LABEL: Record<RtKind, string> = { llama: 'llama.cpp', ollama: 'Ollama', lmstudio: 'LM Studio' }
const RT_PORT: Record<RtKind, number> = { llama: 8080, ollama: 11434, lmstudio: 1234 }

/** 供应商 → 本地运行环境（远程 API 返回 null） */
function runtimeOf(p: ProviderConfig): RtKind | null {
  if (isLlamaProvider(p)) return 'llama'
  const kind = runtimeKindOf(p)
  if (kind) return kind
  // 老配置里 kind='ollama' 但 id 是自定义名的，仍按 Ollama 处理
  return p.kind === 'ollama' ? 'ollama' : null
}

interface RtState {
  models: string[]
  running: boolean
  installed: boolean
  /** LM Studio 的真实端口可能是 1235（1234 被占用时它会自己换） */
  port?: number
}

/**
 * 把磁盘上的配置合并进当前草稿：
 * 新增的供应商（如引导面板一键创建的本地方案）直接补进来，
 * 已有的只补空字段，避免覆盖用户正在编辑的内容。
 *
 * 例外是「模型名」：在「② 本地模型」页点选并启动后会直接写盘，
 * 这时磁盘才是最新状态，除非用户在本面板里刚手动改过这一项（`touched`）。
 */
function mergeDraft(prev: AppConfig, disk: AppConfig, touched: Set<string>): AppConfig {
  const known = new Set(prev.providers.map((p) => p.id))
  const providers = prev.providers.map((p) => {
    const d = disk.providers.find((x) => x.id === p.id)
    if (!d) return p
    const model = touched.has(p.id) ? p.model || d.model : d.model || p.model
    return { ...p, model, baseUrl: p.baseUrl || d.baseUrl }
  })
  for (const d of disk.providers) if (!known.has(d.id)) providers.push({ ...d })
  return { ...prev, providers, activeId: disk.activeId ?? prev.activeId }
}

export function Settings({
  config,
  probes,
  modelCache,
  onRefresh,
  onConfigChanged,
  onClose,
  onSave,
  initialTab = 'list'
}: Props) {
  const [draft, setDraft] = useState<AppConfig>(() => JSON.parse(JSON.stringify(config)) as AppConfig)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)
  // 用户在本面板手动「拉取模型列表」后追加的缓存（优先于全局探测缓存）
  const [modelList, setModelList] = useState<Record<string, string[]>>({})
  // 每个供应商面板是否展开（默认全部折叠）
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  /** 当前标签页：默认落在「模型列表」，和以前打开设置就看到列表一致 */
  const [tab, setTab] = useState<TabKey>(initialTab)
  /** 「获取模型」面板（读本机参数、下载模型） */
  const [specsOpen, setSpecsOpen] = useState(false)
  /** 本地模型页的句柄：顶部「刷新」按钮直接调它重扫 */
  const localRef = useRef<LocalModelsHandle>(null)
  /** 顶部「刷新」进行中 */
  const [refreshing, setRefreshing] = useState(false)
  // 各供应商的本地运行状态（模型列表 / 服务是否在跑 / 装了没）。
  // 按 providerId 存而不是按运行时类型：双卡双模型时两台 llama.cpp 各跑各的，
  // 用类型当 key 会让两个卡片显示同一个实例的状态。
  const [rt, setRt] = useState<Record<string, RtState>>({})
  const [rtBusy, setRtBusy] = useState<string | null>(null)
  /** 各 llama.cpp 实例当前实际加载的模型文件名 */
  const [served, setServed] = useState<Record<string, string>>({})
  /** 工人模型的并行判定结果（按「主模型 id」缓存，点「检查」才求值） */
  const [wplan, setWplan] = useState<Record<string, WorkerPlan | null>>({})
  const [wplanBusy, setWplanBusy] = useState(false)
  /** 可绑定的设备（值就是 -dev 认的名字：CUDA0 / CUDA1 / Vulkan1 …） */
  const [devices, setDevices] = useState<Array<{ id: string; name: string; vramMiB?: number }>>([])

  // 始终指向最新的草稿，供异步回调读取（避免闭包拿到旧值）
  const draftRef = useRef(draft)
  draftRef.current = draft
  // 本面板里用户手动改过模型名的供应商：合并磁盘配置时不覆盖它
  const touchedModels = useRef<Set<string>>(new Set())

  // 「② 本地模型」页的「自动配置 / 一键启动」会直接写盘，这里把结果合并进草稿，
  // 让新建的本地模型立刻出现在列表里（并滚动过去）
  async function syncFromDisk() {
    await onConfigChanged()
    const disk = await window.pico.config.get()
    const known = new Set(draftRef.current.providers.map((p) => p.id))
    const added = disk.providers.filter((p) => !known.has(p.id)).map((p) => p.id)
    setDraft((prev) => mergeDraft(prev, disk, touchedModels.current))
    // 本地服务可能换了模型 / 换了服务，重新读一次状态，两边标记才一致
    void refreshAllRuntimes()
    if (added.length) {
      setExpanded((prev) => ({ ...prev, ...Object.fromEntries(added.map((id) => [id, true])) }))
      window.setTimeout(() => {
        document.getElementById(`prov-${added[0]}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }, 100)
    }
  }

  // 模型列表：手动拉取的优先，其次用全局探测时顺带拿到的
  const modelsFor = (id: string): string[] | undefined => modelList[id] ?? modelCache[id]

  function patchProvider(id: string, patch: Partial<ProviderConfig>) {
    setDraft((prev) => ({
      ...prev,
      providers: prev.providers.map((p) => (p.id === id ? { ...p, ...patch } : p))
    }))
  }

  function addProvider(): string {
    const id = `p_${Date.now().toString(36)}`
    setDraft((prev) => ({
      ...prev,
      providers: [
        ...prev.providers,
        {
          id,
          name: tr("自定义"),
          kind: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKey: '',
          model: '',
          contextWindow: 32768,
          temperature: 0.2
        }
      ]
    }))
    setExpanded((prev) => ({ ...prev, [id]: true }))
    return id
  }

  /** 「模型 API」页的「我有 API，添加」：新增供应商，切到模型列表并滚动到它 */
  function addProviderFromApi() {
    const id = addProvider()
    setTab('list')
    window.setTimeout(() => {
      document.getElementById(`prov-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 80)
  }

  /**
   * 从「免费模型」清单里加一家：模型名和 Base URL 都填好，只留 API Key 让用户自己粘。
   * 默认勾上「备用」——免费模型大多限速，当主力不稳，当兜底正好。
   */
  function addFreeProvider(source: FreeSource, model?: FreeModel) {
    const taken = new Set(draftRef.current.providers.map((p) => p.id))
    let id = `free_${source.id}`
    let n = 2
    while (taken.has(id)) id = `free_${source.id}_${n++}`

    // 同一个接口地址已经有条目填过 Key，就直接沿用。
    // 「免费模型」每加一个模型就新建一条供应商，用户只会在第一次粘 Key；
    // 后来加的几条空白着，切过去就是 401 —— 那种「我明明配好了却用不了」最难查。
    const norm = (u: string) => (u || '').trim().replace(/\/+$/, '').toLowerCase()
    const inherited =
      draftRef.current.providers.find(
        (p) => norm(p.baseUrl) === norm(source.baseUrl) && (p.apiKey ?? '').trim()
      )?.apiKey ?? ''

    const short = model ? (model.name.length > 26 ? `${model.name.slice(0, 26)}…` : model.name) : ''
    const name = model ? `${source.name} · ${short}` : source.name
    setDraft((prev) => ({
      ...prev,
      providers: [
        ...prev.providers,
        {
          id,
          name,
          kind: source.kind,
          baseUrl: source.baseUrl,
          apiKey: inherited,
          model: model?.id ?? '',
          contextWindow: model?.context && model.context > 2048 ? model.context : 32768,
          temperature: 0.2,
          fallback: true
        }
      ]
    }))
    setExpanded((prev) => ({ ...prev, [id]: true }))
    setNote({
      text: inherited
        ? model
          ? tr("已加入「{name}」，沿用了同一接口已填的 API Key（默认作为备用模型）", { name: name })
          : tr("已加入「{name}」，沿用了同一接口已填的 API Key", { name: source.name })
        : model
          ? tr("已加入「{name}」，粘上 API Key 后保存即可（默认作为备用模型）", { name: name })
          : tr("已加入「{name}」，粘上 API Key 后点「拉取模型列表」选具体模型", { name: source.name }),
      kind: 'ok'
    })
    setTab('list')
    window.setTimeout(() => {
      document.getElementById(`prov-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 80)
  }

  /** 顶部「刷新」：重扫本地模型 + 各供应商状态，任何标签页都可用 */
  async function refreshAll() {
    setRefreshing(true)
    setNote({ text: tr("正在刷新本地模型与供应商状态…"), kind: 'ok' })
    try {
      onRefresh()
      await refreshAllRuntimes()
      if (localRef.current) await localRef.current.refresh()
      setNote({ text: tr("已刷新：本地模型与供应商状态都是最新的"), kind: 'ok' })
    } finally {
      setRefreshing(false)
    }
  }

  function removeProvider(id: string) {
    setDraft((prev) => {
      const providers = prev.providers.filter((p) => p.id !== id)
      return {
        ...prev,
        providers,
        activeId: prev.activeId === id ? (providers[0]?.id ?? null) : prev.activeId
      }
    })
  }

  async function fetchModels(provider: ProviderConfig) {
    setNote({ text: tr("正在读取 {name} 的模型列表…", { name: provider.name }), kind: 'ok' })
    const result = await window.pico.models.listDraft(provider)
    if (!result.ok) {
      setNote({ text: tr("读取失败：{0}", { "0": result.error ?? tr("未知错误") }), kind: 'err' })
      return
    }
    if (!result.models.length) {
      setNote({ text: tr("该端点没有返回可用模型"), kind: 'err' })
      return
    }
    setModelList((prev) => ({ ...prev, [provider.id]: result.models }))
    if (!provider.model) {
      patchProvider(provider.id, { model: result.models[0] })
    }
    setNote({
      text: tr("已拉取 {length} 个模型，点击「模型名」右侧箭头即可下拉选取", { length: result.models.length }),
      kind: 'ok'
    })
  }

  /** 刷新某个本地环境：llama 扫描 .gguf，Ollama / LM Studio 探服务 + 已装模型 */
  async function refreshRuntime(p: ProviderConfig, verbose = false) {
    const kind = runtimeOf(p)
    if (!kind) return
    setRtBusy(p.id)
    try {
      if (kind === 'llama') {
        const r = await window.pico.llama.models()
        const names = Array.from(new Set(r.models.map(baseName)))
        const s = await window.pico.llama.status(p.id)
        setRt((prev) => ({
          ...prev,
          [p.id]: { models: names, running: s.running, installed: true, port: s.port ?? p.port }
        }))
        setServed((prev) => ({ ...prev, [p.id]: s.running ? baseName(s.models?.[0] ?? '') : '' }))
        if (verbose) {
          setNote({
            text: names.length ? tr("找到 {length} 个本地模型，可在下拉框中选择", { length: names.length }) : r.message,
            kind: names.length ? 'ok' : 'err'
          })
        }
        return
      }
      const s = await window.pico.local.status(kind)
      setRt((prev) => ({
        ...prev,
        [p.id]: { models: s.models, running: s.running, installed: s.installed, port: s.port }
      }))
      if (verbose) {
        setNote({ text: s.message, kind: s.installed || s.running ? 'ok' : 'err' })
      }
    } catch (err) {
      setNote({ text: tr("检测失败：{0}", { "0": (err as Error).message }), kind: 'err' })
    } finally {
      setRtBusy(null)
    }
  }

  /**
   * 工人模型到底能不能和当前对话模型并行。
   * 传的是「主模型」的 id —— 能不能并行取决于两边各自的显卡绑定，不是工人模型自己说了算。
   */
  async function checkWorker() {
    const mainId = draftRef.current.activeId
    if (!mainId) {
      setNote({ text: tr("先选择一个对话模型"), kind: 'err' })
      return
    }
    setWplanBusy(true)
    try {
      const plan = await window.pico.worker.plan(mainId)
      setWplan((prev) => ({ ...prev, [mainId]: plan }))
      if (plan) setNote({ text: plan.reason, kind: plan.provider ? 'ok' : 'err' })
    } catch (err) {
      setNote({ text: tr("检查失败：{0}", { "0": (err as Error).message }), kind: 'err' })
    } finally {
      setWplanBusy(false)
    }
  }

  async function refreshAllRuntimes() {
    for (const p of draftRef.current.providers) {
      if (runtimeOf(p)) await refreshRuntime(p)
    }
  }

  /** 拉起 Ollama / LM Studio 的服务（llama.cpp 由引导面板的「一键启动」负责） */
  async function startRuntime(kind: RtKind, providerId: string) {
    if (kind === 'llama' || rtBusy) return
    setRtBusy(providerId)
    setNote({ text: tr("正在启动 {0} 服务…", { "0": RT_LABEL[kind] }), kind: 'ok' })
    try {
      const r = await window.pico.local.start(kind)
      setNote({ text: r.message, kind: r.ok ? 'ok' : 'err' })
      if (r.ok) {
        setRt((prev) => ({
          ...prev,
          [providerId]: {
            models: r.models ?? prev[providerId]?.models ?? [],
            running: true,
            installed: true
          }
        }))
      }
    } catch (err) {
      setNote({ text: tr("启动失败：{0}", { "0": (err as Error).message }), kind: 'err' })
    } finally {
      setRtBusy(null)
    }
  }

  // 面板一打开就把各本地环境的模型列表准备好，不用再点一次按钮
  useEffect(() => {
    void refreshAllRuntimes()
    // 只在挂载时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 设备清单也顺手问一次：双卡机器上「绑定显卡」要能选到 CUDA1
  useEffect(() => {
    void (async () => {
      try {
        const list = await window.pico.llama.devices()
        setDevices(list)
      } catch {
        // 没装 llama.cpp 时没有设备可选，退化成「自动」
      }
    })()
  }, [])

  /** 「② 本地模型」页点选模型 → 同步到模型列表的草稿（反过来也成立，见 currentModels） */
  function pickLocalModel(model: string, providerId?: string) {
    const list = draftRef.current.providers
    // 引导面板传的是 'llamacpp' / 'ollama' / 'lmstudio'，先按 id 找，
    // 找不到再按「运行时类型」找（用户可能把供应商改成自定义名字了）
    const kind: RtKind | undefined =
      providerId === 'llamacpp'
        ? 'llama'
        : providerId === 'ollama' || providerId === 'lmstudio'
          ? providerId
          : undefined
    const target =
      (providerId ? list.find((p) => p.id === providerId) : undefined) ??
      (kind ? list.find((p) => runtimeOf(p) === kind) : undefined) ??
      list.find((p) => runtimeOf(p) === 'llama')
    if (!target) return
    touchedModels.current.add(target.id)
    patchProvider(target.id, { model })
  }

  async function handleSave() {
    setBusy(true)
    try {
      await onSave(draft)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  // 颜色按原始顺序分配，避免排序后颜色跳动
  const colorMap: Record<string, string> = {}
  draft.providers.forEach((p, i) => {
    colorMap[p.id] = PALETTE[i % PALETTE.length]
  })

  // 可用置顶（绿），不可用沉底（红），探测中居中
  const ordered = [...draft.providers].sort((a, b) => {
    const ra = RANK[probes[a.id]?.state ?? 'checking']
    const rb = RANK[probes[b.id]?.state ?? 'checking']
    return ra - rb
  })

  return (
    <>
      <div className="overlay" onClick={onClose}>
        <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>{tr("模型设置")}</h2>
          <button className="icon-btn" onClick={onClose} title={tr("关闭")}>
            {tr("关闭")}</button>
        </div>

        <div className="guide-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`guide-tab ${tab === t.key ? 'on' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
          <div className="guide-head-actions">
            <button
              className="btn primary guide-getmodels"
              onClick={() => setSpecsOpen(true)}
              title={tr("读取本机显卡 / CPU / 内存，按本机能力推荐并下载模型")}
            >
              {tr("获取模型")}</button>
            <button
              className="btn guide-getmodels"
              disabled={refreshing}
              onClick={() => void refreshAll()}
              title={tr("重新扫描本地 .gguf 模型与各供应商可用状态")}
            >
              {refreshing ? tr("刷新中…") : tr("刷新")}
            </button>
          </div>
        </div>

        {tab === 'list' ? (
        <div className="settings-body">
          {ordered.map((p) => {
            const isOpen = Boolean(expanded[p.id])
            const probe = probes[p.id] ?? { state: 'checking' as ProbeState }
            const color = colorMap[p.id]
            const models = modelsFor(p.id)
            const rtKind = runtimeOf(p)
            const rtState = rtKind ? rt[p.id] : undefined
            const servedName = served[p.id] ?? ''
            // 端口留空时，实际用的端口记在 baseUrl 里，给用户一个可见反馈
            const autoPort = Number(/:(\d+)(?:\/|$)/.exec(p.baseUrl || '')?.[1] ?? 0)
            // 本地模型下拉：扫描到的全部列出来；配置里存着但盘上已删的，补一条标「本地未找到」
            const localName = p.model ? baseName(p.model) : ''
            const localList = rtState?.models ?? []
            const localOptions =
              localName && !localList.includes(localName) ? [localName, ...localList] : localList
            return (
              <div
                key={p.id}
                id={`prov-${p.id}`}
                className={`provider ${draft.activeId === p.id ? 'active' : ''} ${isOpen ? 'open' : ''}`}
                style={{ borderLeftColor: color }}
              >
                <div
                  className="prov-head"
                  onClick={() => setExpanded((prev) => ({ ...prev, [p.id]: !prev[p.id] }))}
                >
                  <span className="prov-color" style={{ background: color }} />
                  <StatusDot state={probe.state} error={probe.error} />
                  <div className="prov-title">
                    <span className="prov-tname">{p.name || tr("未命名")}</span>
                    <span className="prov-tsub">{p.model || tr("未选择模型")}</span>
                  </div>
                  <span className={`prov-state ${probe.state}`}>
                    {probe.state === 'ok' ? tr("可用") : probe.state === 'checking' ? tr("检测中") : tr("不可用")}
                  </span>
                  {draft.activeId === p.id && <span className="prov-badge">{tr("当前使用")}</span>}
                  <button
                    className="btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      setDraft((prev) => ({ ...prev, activeId: p.id }))
                    }}
                    disabled={draft.activeId === p.id}
                  >
                    {tr("使用")}</button>
                  <button
                    className="btn danger"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeProvider(p.id)
                    }}
                  >
                    {tr("删除")}</button>
                  <svg
                    className={`chev ${isOpen ? 'open' : ''}`}
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    aria-hidden="true"
                  >
                    <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
                  </svg>
                </div>
                {isOpen && (
                  <div className="prov-body">
                    <div className="grid2">
                      <div className="field">
                        <label>{tr("名称")}</label>
                        <input value={p.name} onChange={(e) => patchProvider(p.id, { name: e.target.value })} />
                      </div>
                      <div className="field">
                        <label>{tr("接口类型")}</label>
                        <select
                          value={p.kind}
                          onChange={(e) => patchProvider(p.id, { kind: e.target.value as ProviderKind })}
                        >
                          {(Object.keys(KIND_LABEL) as ProviderKind[]).map((k) => (
                            <option key={k} value={k}>
                              {KIND_LABEL[k]}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label>Base URL</label>
                        <input value={p.baseUrl} onChange={(e) => patchProvider(p.id, { baseUrl: e.target.value })} />
                      </div>
                      <div className="field">
                        <label>{tr("API Key（本地模型可留空）")}</label>
                        <input
                          type="password"
                          value={p.apiKey ?? ''}
                          onChange={(e) => patchProvider(p.id, { apiKey: e.target.value })}
                          placeholder="sk-..."
                        />
                        {config.undecryptable?.includes(p.id) && (
                          <p className="field-warn">
                            {tr("这个密钥在本机解密失败（换过机器或系统账户），请重新填写。")}</p>
                        )}
                      </div>
                      <div className="field">
                        <label>{tr("上下文窗口（tokens）")}</label>
                        <input
                          type="number"
                          value={p.contextWindow}
                          onChange={(e) => patchProvider(p.id, { contextWindow: Number(e.target.value) })}
                        />
                      </div>
                      <div className="field">
                        <label>{tr("温度")}</label>
                        <input
                          type="number"
                          step="0.1"
                          value={p.temperature ?? 0.2}
                          onChange={(e) => patchProvider(p.id, { temperature: Number(e.target.value) })}
                        />
                      </div>
                    </div>
                    {rtKind === 'llama' && (
                      <div className="grid2">
                        <div className="field">
                          <label title={tr("留空即可：启动时自动探测空闲端口（默认从 8080 起）。填了值就锁定这个端口，被占用会直接报错")}>
                            {tr("实例端口")}
                          </label>
                          <input
                            type="number"
                            placeholder={tr("留空自动")}
                            value={p.port ?? ''}
                            onChange={(e) => {
                              const v = e.target.value.trim()
                              patchProvider(p.id, { port: v ? Number(v) : undefined })
                            }}
                          />
                          {!p.port && (
                            <span className="note">
                              {autoPort >= 1024
                                ? tr("留空 = 自动探测空闲端口；当前使用 {port}", { port: autoPort })
                                : tr("留空 = 自动探测空闲端口（默认 8080）")}
                            </span>
                          )}
                        </div>
                        <div className="field">
                          <label title={tr("选定后这个实例只占那一张卡（不跨卡切分），另一张卡留给另一个模型")}>
                            {tr("绑定显卡")}
                          </label>
                          <select
                            value={p.device ?? ''}
                            onChange={(e) => patchProvider(p.id, { device: e.target.value || undefined })}
                          >
                            <option value="">{tr("自动（交给 llama.cpp 分配）")}</option>
                            {devices.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.id} · {d.name}
                                {d.vramMiB ? `（${(d.vramMiB / 1024).toFixed(0)} GB）` : ''}
                              </option>
                            ))}
                            <option value="CPU">{tr("只用 CPU（不占显存）")}</option>
                          </select>
                        </div>
                      </div>
                    )}
                    {rtKind ? (
                      <div className="field model-field">
                        <label>
                          {tr("本地模型")}{rtState
                            ? tr("（共 {length} 个，下拉选择）", { length: rtState.models.length })
                            : rtKind === 'llama'
                              ? tr("（点右侧按钮扫描 models/ 与 llama.cpp/）")
                              : tr("（点右侧按钮检测 {0}）", { "0": RT_LABEL[rtKind] })}
                        </label>
                        <div className="model-row">
                          <ModelCombo
                            value={p.model ? baseName(p.model) : ''}
                            options={localOptions}
                            placeholder={tr("（未选择模型）")}
                            title={p.model || undefined}
                            labelOf={(m) =>
                              rtKind === 'llama' && m === servedName
                                ? tr("{m} · 运行中", { m: m })
                                : localName && m === localName && !localList.includes(m)
                                  ? tr("{m}（本地未找到）", { m: m })
                                  : m
                            }
                            emptyHint={
                              rtState
                                ? tr("没有扫描到本地模型：先到「② 本地模型」页下载或导入一个")
                                : tr("正在扫描本地模型…")
                            }
                            onChange={(v) => {
                              touchedModels.current.add(p.id)
                              patchProvider(p.id, { model: v })
                            }}
                          />
                          <button
                            className="btn"
                            disabled={rtBusy === p.id}
                            onClick={() => void refreshRuntime(p, true)}
                          >
                            {rtBusy === p.id ? tr("检测中…") : tr("刷新")}
                          </button>
                          {rtKind !== 'llama' && rtState && !rtState.running && (
                            <button
                              className="btn"
                              disabled={rtBusy === p.id}
                              onClick={() => void startRuntime(rtKind, p.id)}
                            >
                              {tr("启动服务")}</button>
                          )}
                        </div>
                        <div className="model-hint">
                          {rtKind === 'llama'
                            ? !rtState
                              ? tr("正在扫描本地模型…")
                              : rtState.models.length === 0
                                ? tr("还没有本地模型：点顶部「获取模型」下载一个，或手动放进 models/ 目录。")
                                : draft.activeId !== p.id
                                  ? tr("这个供应商不是当前使用的：先点卡片右侧的「使用」再保存，才会让 llama-server 加载它。")
                                  : p.model && baseName(p.model) !== servedName
                                    ? servedName
                                      ? tr("保存后会重启这个实例（正在跑 {served}）并加载所选模型，需要几十秒。", { served: servedName })
                                      : tr("保存后会启动 llama-server 加载这个模型。")
                                    : servedName
                                      ? tr("llama-server 正在运行：{served}", { served: servedName })
                                      : tr("保存后会启动 llama-server 加载这个模型。")
                            : !rtState
                              ? tr("正在检测 {0}…", { "0": RT_LABEL[rtKind] })
                              : !rtState.installed && !rtState.running
                                ? tr("未检测到 {0}：请先安装（「② 本地模型」页可一键安装），再点「启动服务」。", { "0": RT_LABEL[rtKind] })
                                : !rtState.running
                                  ? tr("{0} 服务未启动：点「启动服务」，或到「② 本地模型」页一键启动。", { "0": RT_LABEL[rtKind] })
                                  : draft.activeId !== p.id
                                    ? tr("{0} 运行中（端口 {1}）；这个供应商不是当前使用的，先点「使用」再保存。", { "0": RT_LABEL[rtKind], "1": rtState.port ?? RT_PORT[rtKind] })
                                    : tr("{0} 运行中（端口 {1}）· 已装 {length} 个模型；保存后即用所选模型对话。", { "0": RT_LABEL[rtKind], "1": rtState.port ?? RT_PORT[rtKind], length: rtState.models.length })}
                        </div>
                      </div>
                    ) : (
                      <div className="field model-field">
                        <label>
                          {tr("模型名")}{models ? tr("（已拉取 {length} 个，可下拉选取）", { length: models.length }) : ''}
                        </label>
                        <div className="model-row">
                          <ModelCombo
                            value={p.model}
                            options={models ?? []}
                            placeholder={tr("如 qwen2.5-coder:7b")}
                            title={p.model || undefined}
                            emptyHint={tr("还没有拉取模型列表：点右侧「拉取模型列表」，也可以直接手输模型名")}
                            onChange={(v) => patchProvider(p.id, { model: v })}
                          />
                          <button className="btn" onClick={() => void fetchModels(p)}>
                            {tr("拉取模型列表")}</button>
                        </div>
                      </div>
                    )}
                    <div className="row">
                      <label
                        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'calc(12px * var(--fs, 1))', color: '#8b8b95' }}
                      >
                        {tr("看图能力")}<select
                          value={p.vision ?? 'auto'}
                          onChange={(e) =>
                            patchProvider(p.id, { vision: e.target.value as 'auto' | 'on' | 'off' })
                          }
                          style={{ width: 120 }}
                        >
                          <option value="auto">{tr("自动判断")}</option>
                          <option value="on">{tr("支持看图")}</option>
                          <option value="off">{tr("不支持")}</option>
                        </select>
                      </label>
                      <span className="note">
                        {tr("自动按模型名判断；模型名判断错时手动改。上传图片要选「支持看图」的模型才看得见。")}</span>
                    </div>
                    <div className="row">
                      <label
                        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'calc(12px * var(--fs, 1))', color: '#8b8b95' }}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(p.noTools)}
                          onChange={(e) => patchProvider(p.id, { noTools: e.target.checked })}
                          style={{ width: 'auto' }}
                        />
                        {tr("模型不支持原生工具调用（改用文本协议）")}</label>
                      {p.kind === 'ollama' && <span className="note">{tr("需先启动 Ollama 或 LM Studio")}</span>}
                    </div>
                    <div className="row">
                      <label
                        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'calc(12px * var(--fs, 1))', color: '#8b8b95' }}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(p.fallback)}
                          onChange={(e) => patchProvider(p.id, { fallback: e.target.checked })}
                          style={{ width: 'auto' }}
                        />
                        {tr("作为备用模型")}</label>
                      <span className="note">
                        {tr("主模型额度用完（429/402）、断网或服务 5xx 时自动切到它；同一条回答中途已输出内容则不切换。")}</span>
                    </div>
                    <div className="row">
                      <label
                        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'calc(12px * var(--fs, 1))', color: '#8b8b95' }}
                      >
                        {tr("用途")}
                        <select
                          value={p.role ?? 'main'}
                          onChange={(e) =>
                            patchProvider(p.id, { role: e.target.value === 'worker' ? 'worker' : undefined })
                          }
                          style={{ width: 150 }}
                        >
                          <option value="main">{tr("主模型（对话）")}</option>
                          <option value="worker">{tr("工作模型（子代理）")}</option>
                        </select>
                      </label>
                      <span className="note">
                        {tr("选「工作模型」后，派出去的子代理用它干活：双卡机器上主模型占一张卡、它占另一张，两边才是真并行。全局只设一个。")}</span>
                    </div>
                    {p.role === 'worker' && (
                      <div className="row">
                        <button type="button" disabled={wplanBusy} onClick={() => void checkWorker()}>
                          {wplanBusy ? tr("检查中…") : tr("检查能否并行")}
                        </button>
                        <span className="note">
                          {wplan[draftRef.current.activeId ?? '']?.reason ??
                            tr("点「检查能否并行」看它和当前对话模型能不能同时驻留。")}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        ) : (
        <div className="guide-body">
          {tab === 'base' && (
            <div className="guide-section">
              {/* 一键把 core/ + 模型 + llama.cpp 备齐：给「先能聊起来」的人走的直线 */}
              <SimpleCore onChanged={syncFromDisk} />
              <BaseTools />
              {/* 开源后最常见的问题：「怎么让别的工具用上这台机器的模型」 */}
              <Fold id="external-access" title={tr("外部接入（Cline / Cursor / 脚本）")}>
                <ExternalAccess providers={draft.providers} />
              </Fold>
              <Fold id="base-doc" title={tr("手动安装说明")}>
              <p className="guide-lead">
                {tr("本工具基于 Electron，本地运行依赖以下基础环境。上面没装全的话，点「一键安装」会自己下载并装好；手动装也可以，装完请重启本程序。")}</p>
              <h3>{tr("必装")}</h3>
              <ul className="guide-list">
                <li>
                  <b>{tr("Node.js LTS（含 npm）")}</b> —— <Link href="https://nodejs.org/zh-cn" />
                  <span className="note">　{tr("国内备选：")}</span>
                  <Link href="https://npmmirror.com/mirrors/node/" />
                </li>
                <li>
                  <b>Git for Windows</b> —— <Link href="https://git-scm.com/download/win" />
                  <span className="note">　{tr("国内备选：")}</span>
                  <Link href="https://npmmirror.com/mirrors/git-for-windows/" />
                </li>
              </ul>
              <h3>{tr("可选")}</h3>
              <ul className="guide-list">
                <li>
                  <b>Python 3.10+</b>{tr("（部分本地模型工具需要）——")}{' '}
                  <Link href="https://www.python.org/downloads/" />
                  <span className="note">　{tr("国内备选：")}</span>
                  <Link href="https://mirrors.huaweicloud.com/python/" />
                </li>
              </ul>
              <h3>{tr("安装后验证")}</h3>
              <Code text="node -v" />
              <Code text="npm -v" />
              <Code text="git --version" />
              </Fold>
            </div>
          )}

          {tab === 'local' && (
            <LocalModels
              ref={localRef}
              // 用草稿而不是磁盘配置：本面板里刚选的模型，切过来就应该已经是选中的
              currentModels={Object.fromEntries(draft.providers.map((p) => [p.id, p.model || '']))}
              onSelectModel={pickLocalModel}
              onConfigChanged={syncFromDisk}
            />
          )}

          {tab === 'api' && (
            <div className="guide-section">
              <p className="guide-lead">
                {tr("使用云端模型只需一个 Base URL 和 API Key。点下面的按钮新增一个供应商，填地址与 Key，拉取模型列表后保存即可（在「④ 模型列表」里编辑）。")}</p>
              <div className="guide-actions">
                <button className="btn primary" onClick={() => addProviderFromApi()}>
                  {tr("我有 API，添加")}</button>
              </div>

              <div className="auto-fallback">
                <label>
                  <input
                    type="checkbox"
                    checked={draft.autoFallback !== false}
                    onChange={(e) => setDraft((d) => ({ ...d, autoFallback: e.target.checked }))}
                    style={{ width: 'auto' }}
                  />
                  {tr("额度用完 / 连不上时自动切换")}</label>
                <span className="note">
                  {tr("按「④ 模型列表」的顺序，依次尝试勾了「备用」的供应商；已经输出一半内容时不切换，避免重复。")}</span>
              </div>

              <FreeModels onAdd={addFreeProvider} />

              <Fold id="api-doc" title={tr("常见端点与安全提示")}>
              <h3>{tr("常见端点")}</h3>
              <ul className="guide-list">
                <li>
                  <b>OpenAI</b>：<code>https://api.openai.com/v1</code>{tr("，模型如")}<code>gpt-4o-mini</code>
                </li>
                <li>
                  <b>Anthropic</b>：<code>https://api.anthropic.com</code>{tr("，模型如")}{' '}
                  <code>claude-sonnet-4-20250514</code>
                </li>
                <li>
                  <b>DeepSeek</b>：<code>https://api.deepseek.com/v1</code>
                </li>
                <li>{tr("其他 OpenAI 兼容服务同理，填对应的 Base URL 即可。")}</li>
              </ul>
              <h3>{tr("安全提示")}</h3>
              <ul className="guide-list">
                <li>{tr("API Key 仅保存在本机配置文件中，不会上传。")}</li>
                <li>{tr("不要把 Key 提交到代码仓库或分享给他人。")}</li>
              </ul>
              </Fold>
            </div>
          )}
        </div>
        )}
        <div className="settings-foot">
          {note && <div className={`note ${note.kind}`}>{note.text}</div>}
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn"
                onClick={() => {
                  addProvider()
                  setTab('list')
                }}
              >
                {tr("+ 添加供应商")}</button>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={onClose}>
                {tr("取消")}</button>
              <button className="btn primary" onClick={() => void handleSave()} disabled={busy}>
                {busy ? tr("保存中…") : tr("保存")}
              </button>
            </div>
          </div>
        </div>
      </div>
      </div>
      {specsOpen && <ModelSpecs onClose={() => setSpecsOpen(false)} />}
    </>
  )
}
