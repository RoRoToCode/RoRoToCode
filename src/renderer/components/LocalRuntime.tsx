import { t as tr } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import type { LocalGgufFile, LocalRuntimeKind, LocalRuntimeStatus, SetupProgress } from '../../shared/types'
import { Chevron, useCollapse } from './Collapse'
import { DownloadBar } from './DownloadBar'

interface Props {
  kind: LocalRuntimeKind
  /** 「方式 B」这类序号前缀 */
  step: string
  title: string
  /** 一句话说明 */
  desc: string
  port: number
  /** 配置里这个供应商当前用的模型 */
  currentModel?: string
  onSelectModel?: (model: string) => void
  onConfigChanged?: () => void | Promise<void>
  /** 只有 Ollama 支持命令行拉取 */
  canPull?: boolean
}

const sameModel = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** 1.4 GB / 986 MB，用于模型体积提示 */
const fmtSize = (n: number): string =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} GB`
    : `${Math.max(1, Math.round(n / 1024 / 1024))} MB`

/**
 * Ollama / LM Studio 的本地服务卡片：和 llama.cpp 一样，
 * 能检测安装与服务状态、替用户拉起服务、写配置、把已装模型列出来供选择。
 */
export function LocalRuntime({
  kind,
  step,
  title,
  desc,
  port,
  currentModel,
  onSelectModel,
  onConfigChanged,
  canPull
}: Props) {
  const [st, setSt] = useState<LocalRuntimeStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [open, toggle] = useCollapse(`rt-${kind}`, true)
  const [msg, setMsg] = useState('')
  const [picked, setPicked] = useState('')
  const [pullName, setPullName] = useState('')
  /** 本程序 models/ 里已下载的 GGUF：可直接导入，不用在 Ollama / LM Studio 里再下一遍 */
  const [ggufs, setGgufs] = useState<LocalGgufFile[]>([])
  const [ggufPath, setGgufPath] = useState('')
  const [setupPct, setSetupPct] = useState<number | null>(null)
  /** 下载进度（带速度 / 来源） */
  const [setup, setSetup] = useState<SetupProgress | null>(null)
  const alive = useRef(true)

  useEffect(
    () => () => {
      alive.current = false
    },
    []
  )

  async function refresh() {
    try {
      const s = await window.pico.local.status(kind)
      if (!alive.current) return s
      setSt(s)
      // 顺手刷新「可导入的 GGUF」：模型面板里刚下完的模型，刷一次状态就会出现在下拉里
      const g = await window.pico.local.ggufs().catch(() => null)
      if (g && alive.current) {
        setGgufs(g.files)
        setGgufPath((prev) =>
          prev && g.files.some((f) => f.path === prev) ? prev : (g.files[0]?.path ?? '')
        )
      }
      return s
    } catch (err) {
      if (alive.current) setMsg(tr("检测失败：{0}", { "0": (err as Error).message }))
      return null
    }
  }

  // 打开面板就探一次，省得用户先手动刷新
  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  // 安装包下载进度（只有直链下载的运行时才会推）：画进度条 + 每秒速度
  useEffect(() => {
    const off = window.pico.local.onSetupProgress((p) => {
      if (p.kind !== kind || !alive.current) return
      setSetup(p)
      if (p.state === 'downloading') {
        const pct = p.totalBytes > 0 ? Math.min(99, Math.round((p.receivedBytes / p.totalBytes) * 100)) : 0
        setSetupPct(pct)
        setMsg(p.message ?? '')
      } else if (p.state === 'done') {
        setSetupPct(100)
      } else {
        setSetupPct(null)
        setMsg(p.message ?? '')
      }
    })
    return off
  }, [kind])

  /** 把选中的本地 GGUF 导入到当前运行时（Ollama / LM Studio 各自的方式） */
  async function importGguf() {
    if (busy || !ggufPath) return
    setBusy('import')
    setMsg(tr("正在导入到 {title}…大模型要写一份文件，可能需要一两分钟", { title: title }))
    try {
      // Ollama 的 blob 文件名是 sha256-xxx，直接拿它命名会得到一串哈希：
      // 把界面上的展示名（qwen2.5-coder:7b）当别名传下去
      const pick = ggufs.find((f) => f.path === ggufPath)
      const label = pick?.source === 'ollama' ? pick.name.replace(/\s*·\s*Ollama$/, '') : undefined
      const r = await window.pico.local.importModel(kind, ggufPath, label)
      if (!alive.current) return
      setMsg(r.message)
      if (r.ok) {
        await refresh()
        if (r.model) setPicked(r.model)
      }
    } catch (err) {
      if (alive.current) setMsg(tr("导入失败：{0}", { "0": (err as Error).message }))
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  /** 一键安装 / 下载：下官方安装包、带进度与速度，下完拉起安装程序 */
  async function install() {
    if (busy) return
    setBusy('install')
    setSetup(null)
    setMsg(tr("正在准备安装包…"))
    try {
      const r = await window.pico.local.install(kind)
      if (!alive.current) return
      setMsg(r.message)
      if (r.ok) await refresh()
      window.setTimeout(() => {
        if (alive.current) setSetup(null)
      }, 5000)
    } catch (err) {
      if (alive.current) {
        setMsg(tr("安装失败：{0}", { "0": (err as Error).message }))
      }
    } finally {
      if (alive.current) {
        setBusy(null)
        setSetupPct(null)
      }
    }
  }

  const models = st?.models ?? []

  // 选中的模型：保留用户的点选 → 配置里的当前模型 → 第一个
  useEffect(() => {
    setPicked((prev) => {
      if (prev && models.some((m) => sameModel(m, prev))) return prev
      const cur = models.find((m) => sameModel(m, currentModel))
      return cur ?? models[0] ?? ''
    })
  }, [models, currentModel])

  /** 自动配置：写模型配置 + 顺手报服务状态（原「检测状态」按钮已删，并到这里） */
  async function configOnly() {
    if (busy) return
    setBusy('config')
    setMsg(tr("正在写入模型配置…"))
    try {
      const r = await window.pico.local.configure(kind, picked || undefined)
      if (r.ok) await onConfigChanged?.()
      const s = await window.pico.local.status(kind).catch(() => null)
      if (!alive.current) return
      if (s) setSt(s)
      setMsg(s ? `${r.message}\n${s.message}` : r.message)
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  /** 一键启动：确保服务在跑 → 用选中模型写配置 → 设为当前使用 */
  async function startAll() {
    if (busy) return
    setBusy('apply')
    setMsg(tr("正在启动 {title} 并应用模型…", { title: title }))
    try {
      const s = await window.pico.local.start(kind)
      if (!alive.current) return
      if (!s.ok) {
        setMsg(s.message)
        return
      }
      const c = await window.pico.local.configure(kind, picked || undefined)
      if (!alive.current) return
      setMsg(`${s.message}\n${c.message}`)
      if (c.ok) await onConfigChanged?.()
      await refresh()
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  async function pull() {
    if (busy) return
    const name = pullName.trim()
    if (!name) return
    setBusy('pull')
    try {
      const r = await window.pico.local.pull(name)
      if (!alive.current) return
      setMsg(r.message)
      if (r.ok) setPullName('')
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  const running = Boolean(st?.running)
  const installed = st?.installed ?? false
  const pickedGguf = ggufs.find((f) => f.path === ggufPath)
  /** 服务实际端口：LM Studio 的 1234 被占用时会换端口 */
  const livePort = st?.port ?? port

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
        <h3>
          {step}：{title}{tr("（本机）")}</h3>
        {running ? (
          <span className="guide-badge">{tr("运行中")}</span>
        ) : (
          <span className="guide-badge cpu">{installed ? tr("服务未启动") : tr("未安装")}</span>
        )}
        <Chevron open={open} />
      </div>
      <p className="guide-lead">{desc}</p>
      <div className="guide-actions">
        <button
          className="btn"
          disabled={!!busy}
          onClick={() => void install()}
          title={
            kind === 'ollama'
              ? tr("下载 Ollama 官方安装包并启动安装程序")
              : tr("下载 LM Studio 安装包并启动安装程序")
          }
        >
          {busy === 'install'
            ? setupPct !== null
              ? tr("下载中 {setupPct}%", { setupPct: setupPct })
              : tr("准备中…")
            : installed
              ? tr("重新下载安装")
              : tr("一键安装 / 下载")}
        </button>
        <button
          className="btn"
          disabled={!!busy}
          onClick={() => void configOnly()}
          title={tr("写入模型配置，并顺手报一次服务状态")}
        >
          {busy === 'config' ? tr("配置中…") : tr("自动配置")}
        </button>
        {/* 启动服务与检测状态都并进了「一键启动」和「自动配置」：
            服务没起来时一键启动会先拉起来，再写配置并设为当前使用 */}
        <button
          className="btn primary"
          disabled={!!busy || !installed}
          onClick={() => void startAll()}
          title={
            !installed
              ? tr("还没装 {title}，先点左边的「一键安装 / 下载」", { title: title })
              : picked
                ? tr("使用并设为当前：{picked}", { picked: picked })
                : tr("先拉起服务，再从已装模型里挑一个设为当前")
          }
        >
          {busy === 'apply' ? tr("应用中…") : tr("一键启动")}
        </button>
      </div>
      {setup && (
        <DownloadBar
          p={setup}
          onCancel={
            busy === 'install' ? () => void window.pico.local.cancelInstall() : undefined
          }
        />
      )}
      {msg && <div className="guide-msg">{msg}</div>}

      {models.length > 0 ? (
        <div className="guide-pick">
          <div className="guide-pick-head">
            <b>{tr("使用哪个本地模型")}</b>
            <span className="guide-pick-hint">{tr("共")}{models.length} {tr("个，点一下选中")}</span>
          </div>
          <div className="guide-models">
            {models.map((m) => {
              const on = sameModel(m, picked)
              const active = sameModel(m, currentModel)
              return (
                <button
                  key={m}
                  type="button"
                  className={`guide-model ${on ? 'on' : ''}`}
                  onClick={() => {
                    setPicked(m)
                    onSelectModel?.(m)
                  }}
                  title={m}
                >
                  <span className="guide-model-dot" />
                  <span className="guide-model-name">{m}</span>
                  {active && running && <span className="guide-model-tag run">{tr("当前")}</span>}
                </button>
              )
            })}
          </div>
          {picked && (
            <div className="guide-pick-picked">
              {tr("将使用")}<b>{picked}</b>
              {running ? tr("（点「一键启动」写入配置并设为当前使用）") : tr("（会先启动服务）")}
            </div>
          )}
        </div>
      ) : (
        <p className="guide-note">
          {running
            ? tr("{title} 里还没有模型，", { title: title })
            : installed
              ? tr("服务还没启动，")
              : tr("还没装好 {title}，", { title: title })}
          {kind === 'ollama'
            ? tr("用下面的输入框拉取，或用本程序已下载的模型直接导入。")
            : tr("在 LM Studio 里下一个，或用下面已下载的模型导入。")}
        </p>
      )}

      {installed && ggufs.length > 0 && (
        <div className="guide-import">
          <div className="guide-pick-head">
            <b>{tr("用本程序已下载的模型")}</b>
            <span className="guide-pick-hint">{tr("共")}{ggufs.length} {tr("个 .gguf，不用重新下载")}</span>
          </div>
          <div className="guide-pull">
            <select
              value={ggufPath}
              disabled={!!busy}
              onChange={(e) => setGgufPath(e.target.value)}
              title={ggufPath || tr("程序 models/ 目录里的模型文件")}
            >
              {ggufs.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.name}（{fmtSize(f.sizeBytes)}）
                </option>
              ))}
            </select>
            <button className="btn" disabled={!!busy || !ggufPath} onClick={() => void importGguf()}>
              {busy === 'import' ? tr("导入中…") : tr("导入到 {title}", { title: title })}
            </button>
          </div>
          <p className="guide-note">
            {kind === 'lmstudio'
              ? tr("硬链接导入，同盘不额外占空间。")
              : tr("Ollama 会把模型复制进库，额外占约 {0}。", { "0": pickedGguf ? fmtSize(pickedGguf.sizeBytes) : tr("一份") })}
          </p>
        </div>
      )}

      {canPull && (
        <div className="guide-pull">
          <input
            value={pullName}
            placeholder={tr("拉取模型，如 qwen2.5-coder:7b")}
            onChange={(e) => setPullName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void pull()
            }}
          />
          <button className="btn" disabled={!!busy || !pullName.trim()} onClick={() => void pull()}>
            {busy === 'pull' ? tr("拉取中…") : tr("拉取")}
          </button>
        </div>
      )}

      <p className="guide-note">
        {tr("端口")}{livePort}{tr("。一键启动会自动新建「")}{title} {tr("本地」并设为当前使用。")}</p>
    </div>
  )
}
