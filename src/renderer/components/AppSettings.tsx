import { t as tr } from '../i18n'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppConfig, AppInfo, ApprovalMode, McpServerStatus, PermissionRule, PermRuleWithSource, ProviderConfig, ThemeKey, TrashEntry } from '../../shared/types'
import { isLlamaProvider } from '../../shared/providers'
import {
  applyFontScale,
  applyTheme,
  clampFontScale,
  FONT_PRESETS,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
  isTheme,
  storedFontScale,
  storedTheme,
  THEMES
} from '../theme'
import { Chevron, useCollapse } from './Collapse'
import {
  comboFromEvent,
  DEFAULT_KEYS,
  findConflict,
  formatCombo,
  KEY_ACTIONS,
  normalizeKeys,
  type KeyAction
} from '../../shared/keys'

interface Props {
  config: AppConfig
  onSave: (config: AppConfig) => Promise<void>
  onClose: () => void
  notify: (text: string) => void
}

const ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.5]

/** 作者联系方式，显示在「关于」里 */
const AUTHOR_EMAIL = 'su@RoRoTo.com'

/** 快捷键动作的中文名与说明（渲染时再翻译，避免模块加载时就固化语言） */
const KEY_META: Record<KeyAction, { get label(): string; get desc(): string }> = {
  search: {
    get label() { return tr("搜索会话") },
    get desc() { return tr("把焦点放到左侧的会话搜索框") }
  },
  newSession: {
    get label() { return tr("新建会话") },
    get desc() { return tr("在当前工作区开一个新对话") }
  },
  export: {
    get label() { return tr("导出对话") },
    get desc() { return tr("把当前会话导出成 Markdown") }
  },
  settings: {
    get label() { return tr("打开软件设置") },
    get desc() { return tr("就是现在这个面板") }
  }
}

/** 上下文长度的常用档位（tokens） */
const CTXS = [8192, 16384, 32768, 65536, 131072, 262144]

/** 本地运行的模型，全局上下文长度直接作用于它们 */
function isLocal(p: { kind: string; baseUrl: string }): boolean {
  return p.kind === 'ollama' || /(127\.0\.0\.1|localhost|0\.0\.0\.0)/i.test(p.baseUrl)
}

/**
 * 会跟着全局值走的本地模型：Ollama 每次请求都能带 num_ctx，LM Studio 按模型自身上限加载。
 * llama.cpp 例外——它的 -c 直接决定显存占用，7B 在 8GB 卡上 16K 已经很满，
 * 跟着全局调到 32K 会启动失败，所以仍以「模型设置」里那一项为准。
 */
function followsGlobal(p: { id: string; kind: string; baseUrl: string }): boolean {
  if (isLlamaProvider(p as unknown as ProviderConfig)) return false
  return isLocal(p)
}

const ctxLabel = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n))

const APPROVALS: Array<{ key: ApprovalMode; label: string; desc: string }> = [
  { key: 'ask', get label() { return tr("每次询问") }, get desc() { return tr("写文件、删东西、跑命令前都先弹确认") } },
  { key: 'auto', get label() { return tr("自动执行") }, get desc() { return tr("不再逐条确认，速度快但风险高；删除、越界、外部工具仍会拦住") } },
  { key: 'readonly', get label() { return tr("只读模式") }, get desc() { return tr("只许查看和搜索：写文件、跑命令、联网一律拒绝") } }
]

/**
 * 一个可折叠的设置分组：点标题收起，收起后只留一行标题 + 右侧摘要。
 * 内容不卸载，只靠 CSS 隐藏，收起来再展开不会丢输入。
 */
function Sec({
  id,
  title,
  summary,
  children
}: {
  id: string
  title: string
  summary?: string
  children: ReactNode
}) {
  const [open, toggle] = useCollapse(`aset-${id}`)
  return (
    <section className={`aset-sec ${open ? '' : 'folded'}`}>
      <button
        className="aset-sec-head"
        onClick={toggle}
        title={open ? tr("收起「{title}」", { title: title }) : tr("展开「{title}」", { title: title })}
        aria-expanded={open}
      >
        <Chevron open={open} />
        <h3>{title}</h3>
        {summary && <span className="aset-sec-sum">{summary}</span>}
      </button>
      <div className="aset-sec-body">{children}</div>
    </section>
  )
}

/** 回收站里的时间显示：只到分钟，够用又不占宽度 */
function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return ''
  }
}

/** 软件设置：外观、工作区、审批、数据目录、关于。跟模型无关的东西都放这里。 */
export function AppSettings({ config, onSave, onClose, notify }: Props) {
  const [draft, setDraft] = useState<AppConfig>(() => ({
    ...config,
    contextLimit: config.contextLimit === true,
    contextWindow: config.contextWindow || 32768,
    autoCompact: config.autoCompact !== false,
    autoVerify: config.autoVerify !== false,
    webSearch: config.webSearch !== false,
    memory: config.memory !== false
  }))
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [mem, setMem] = useState<{ path: string; items: number; chars: number } | null>(null)
  const [instr, setInstr] = useState<{ path: string | null; text: string; truncated: boolean; name: string | null } | null>(null)
  /** 项目级权限规则（roroto.json 的 permissions）：带来源标注的规则 + 来源文件列表 */
  const [perms, setPerms] = useState<PermRuleWithSource[] | null>(null)
  const [permsPath, setPermsPath] = useState<string | null>(null)
  const [permFiles, setPermFiles] = useState<string[]>([])
  const [permBusy, setPermBusy] = useState(false)
  const [permDraft, setPermDraft] = useState<{ action: string; resource: string; effect: 'allow' | 'deny' }>({
    action: '',
    resource: '',
    effect: 'deny'
  })
  const [zoom, setZoom] = useState(1)
  const [theme, setTheme] = useState<ThemeKey>(storedTheme())
  /** 字号：ui 管所有界面文字，chat 为 null 时对话正文跟着 ui 走 */
  const initialFont = useRef(storedFontScale()).current
  const [fontScale, setFontScale] = useState(initialFont.ui)
  const [chatFontScale, setChatFontScale] = useState<number | null>(initialFont.chat)
  // 拖动滑块时始终有最新值可用，防抖写盘不会拿到旧闭包
  const fontRef = useRef({ fontScale: initialFont.ui, chatFontScale: initialFont.chat })
  const fontTimer = useRef<number | null>(null)
  /** prefs 还没读回来时用户已经动过滑块：就别再用旧值盖掉他的操作 */
  const fontTouched = useRef(false)
  const [busy, setBusy] = useState(false)
  const [mcp, setMcp] = useState<McpServerStatus[] | null>(null)
  const [mailCopied, setMailCopied] = useState(false)
  /** 回收站里的已删除会话 */
  const [trash, setTrash] = useState<TrashEntry[] | null>(null)
  const [trashBusy, setTrashBusy] = useState(false)
  /** 快捷键绑定；recording 表示正在等待用户按下新的组合键 */
  const [keys, setKeys] = useState<Record<KeyAction, string>>(() => normalizeKeys(null))
  const [recording, setRecording] = useState<KeyAction | null>(null)

  async function loadTrash() {
    try {
      setTrash(await window.pico.sessions.trash())
    } catch {
      setTrash([])
    }
  }

  async function restoreTrash(file: string) {
    setTrashBusy(true)
    try {
      await window.pico.sessions.restore(file)
      await loadTrash()
      notify(tr("会话已恢复"))
    } catch (err) {
      notify(tr("恢复失败：{0}", { "0": (err as Error).message }))
    } finally {
      setTrashBusy(false)
    }
  }

  async function purgeTrash(file: string, title: string) {
    if (!window.confirm(tr("永久删除「{title}」？删除后无法恢复。", { title }))) return
    setTrashBusy(true)
    try {
      await window.pico.sessions.purgeTrash(file)
      await loadTrash()
    } catch (err) {
      notify(tr("删除失败：{0}", { "0": (err as Error).message }))
    } finally {
      setTrashBusy(false)
    }
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [i, p, m] = await Promise.all([
          window.pico.app.info(),
          window.pico.app.prefs(),
          window.pico.memory.info().catch(() => null)
        ])
        if (!alive) return
        setInfo(i)
        if (m) setMem(m)
        void window.pico.instructions
          .info()
          .then((r) => {
            if (alive) setInstr(r)
          })
          .catch(() => undefined)
        void window.pico.permissions
          .info()
          .then((r) => {
            if (alive) {
              setPerms(Array.isArray(r.detailed) ? r.detailed : (r.rules ?? []).map((x: PermissionRule) => ({ ...x, from: r.path ?? '' })))
              setPermsPath(r.path)
              setPermFiles(Array.isArray(r.files) ? r.files : [])
            }
          })
          .catch(() => undefined)
        setZoom(p.zoom)
        setKeys(normalizeKeys(p.keys))
        // 主进程里的记录为准（换过机器 / 清了 localStorage 时靠它恢复）
        if (isTheme(p.theme)) {
          setTheme(p.theme)
          applyTheme(p.theme)
        }
        if (!fontTouched.current) {
          const f = {
            fontScale: clampFontScale(p.fontScale),
            chatFontScale: p.chatFontScale == null ? null : clampFontScale(p.chatFontScale)
          }
          fontRef.current = f
          setFontScale(f.fontScale)
          setChatFontScale(f.chatFontScale)
          applyFontScale(f.fontScale, f.chatFontScale)
        }
      } catch {
        // 主进程是旧版本时不支持这些接口，界面照常显示
      }
    })()
    // 回收站只在打开设置时读一次，改完（恢复/永久删除）就地刷新
    void loadTrash()
    void window.pico.mcp
      .status()
      .then((list) => {
        if (alive) setMcp(list)
      })
      .catch(() => {
        if (alive) setMcp([])
      })
    return () => {
      alive = false
      // 面板关掉时防抖还没触发：立刻把最后一次调整写盘，别丢设置
      if (fontTimer.current) {
        window.clearTimeout(fontTimer.current)
        fontTimer.current = null
        void window.pico.app.setPrefs(fontRef.current).catch(() => undefined)
      }
    }
  }, [])

  async function changeTheme(next: ThemeKey) {
    setTheme(next)
    applyTheme(next)
    try {
      await window.pico.app.setPrefs({ theme: next })
    } catch (err) {
      notify(tr("配色保存失败：{0}", { "0": (err as Error).message }))
    }
  }

  /** 快捷键整表落盘，并通知主界面立即换绑定 */
  async function persistKeys(next: Record<KeyAction, string>) {
    setKeys(next)
    try {
      const p = await window.pico.app.setPrefs({ keys: next })
      const saved = normalizeKeys(p.keys)
      setKeys(saved)
      window.dispatchEvent(new CustomEvent('roroto:prefs', { detail: p }))
    } catch (err) {
      notify(tr("快捷键保存失败：{0}", { "0": (err as Error).message }))
    }
  }

  async function bindKey(action: KeyAction, combo: string) {
    const conflict = findConflict(keys, action, combo)
    if (conflict) {
      notify(tr("「{combo}」已经被「{action}」占用，请先改那一个", { combo, action: KEY_META[conflict].label }))
      return
    }
    await persistKeys({ ...keys, [action]: combo })
  }

  // 录入组合键：捕获阶段拦下来，别让主界面的全局快捷键同时触发
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        return
      }
      const combo = comboFromEvent(e)
      // 只按了 Ctrl / Shift 这种，继续等真正的主键
      if (!combo) return
      const action = recording
      setRecording(null)
      void bindKey(action, formatCombo(combo))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  async function changeZoom(v: number) {
    setZoom(v)
    try {
      const p = await window.pico.app.setZoom(v)
      setZoom(p.zoom)
    } catch (err) {
      notify(tr("缩放失败：{0}", { "0": (err as Error).message }))
    }
  }

  /** 字号立即生效；写盘防抖，避免拖一次滑块就把 prefs.json 写十几遍 */
  function updateFont(patch: { fontScale?: number; chatFontScale?: number | null }) {
    fontTouched.current = true
    const next = {
      fontScale:
        patch.fontScale === undefined ? fontRef.current.fontScale : clampFontScale(patch.fontScale),
      chatFontScale:
        'chatFontScale' in patch
          ? patch.chatFontScale === null
            ? null
            : clampFontScale(patch.chatFontScale)
          : fontRef.current.chatFontScale
    }
    fontRef.current = next
    setFontScale(next.fontScale)
    setChatFontScale(next.chatFontScale)
    applyFontScale(next.fontScale, next.chatFontScale)

    if (fontTimer.current) window.clearTimeout(fontTimer.current)
    fontTimer.current = window.setTimeout(() => {
      fontTimer.current = null
      void window.pico.app
        .setPrefs(fontRef.current)
        .catch((err) => notify(tr("字号保存失败：{0}", { "0": (err as Error).message })))
    }, 250)
  }

  async function pickWorkspace() {
    const dir = await window.pico.workspace.choose()
    if (!dir) return
    setDraft((d) => ({ ...d, workspace: dir }))
  }

  async function clearMem() {
    try {
      await window.pico.memory.clear()
      const m = await window.pico.memory.info()
      setMem(m)
      notify(tr("长期记忆已清空"))
    } catch (err) {
      notify(tr("清空失败：{0}", { "0": (err as Error).message }))
    }
  }

  async function initInstr() {
    try {
      const r = await window.pico.instructions.init()
      setInstr(await window.pico.instructions.info())
      notify(r.created ? tr("已生成 AGENTS.md") : tr("AGENTS.md 已存在，未覆盖"))
    } catch (err) {
      notify(tr("生成失败：{0}", { "0": (err as Error).message }))
    }
  }

  /** 保存权限规则：把「工作区根」的规则整体写回 roroto.json（主进程侧校验 + 原子写）。
   *  父目录里继承来的规则只读，不参与保存。 */
  async function savePerms(next: PermissionRule[]) {
    setPermBusy(true)
    try {
      const r = await window.pico.permissions.save(next)
      // 重新读回完整结果（含父目录继承的规则），保持列表一致
      const info = await window.pico.permissions.info()
      setPerms(Array.isArray(info.detailed) ? info.detailed : info.rules.map((x: PermissionRule) => ({ ...x, from: info.path ?? '' })))
      setPermsPath(info.path)
      setPermFiles(Array.isArray(info.files) ? info.files : [])
      notify(r.created ? tr("已生成 roroto.json") : tr("权限规则已保存"))
    } catch (err) {
      notify(tr("保存失败：{0}", { "0": (err as Error).message }))
    } finally {
      setPermBusy(false)
    }
  }

  /** 追加一条规则（清空输入框，回填默认 effect） */
  async function addPerm() {
    const a = permDraft.action.trim()
    const res = permDraft.resource.trim()
    if (!a || !res) {
      notify(tr("请先填写工具名和匹配目标"))
      return
    }
    const rule: PermissionRule = { action: a, resource: res, effect: permDraft.effect }
    const next = [...(perms ?? []).filter((r) => r.from === permsPath).map(({ from: _f, ...x }) => x), rule]
    await savePerms(next)
    setPermDraft({ action: '', resource: '', effect: 'deny' })
  }

  /** 删除一条规则并保存（只删除工作区根的规则） */
  async function removePerm(idx: number) {
    const next = (perms ?? []).filter((_, i) => i !== idx).filter((r) => r.from === permsPath).map(({ from: _f, ...x }) => x)
    await savePerms(next)
  }

  /** 邮箱没法直接点击时（部分环境 mailto 不生效）至少能一键复制 */
  function copyMail() {
    void navigator.clipboard
      ?.writeText(AUTHOR_EMAIL)
      .then(() => {
        setMailCopied(true)
        window.setTimeout(() => setMailCopied(false), 1400)
      })
      .catch(() => notify(tr("复制失败，请手动选中邮箱")))
  }

  async function save() {
    if (busy) return
    setBusy(true)
    try {
      // 开了「限制上下文」才把全局值同步给本地模型条目；不限制时让各条目用自己的值，
      // 否则「关掉开关」这一步等于把本地模型的窗口改成了下面那个数
      const next: AppConfig = {
        ...draft,
        providers: draft.providers.map((p) =>
          draft.contextLimit && followsGlobal(p) ? { ...p, contextWindow: draft.contextWindow } : p
        )
      }
      await onSave(next)
      notify(tr("设置已保存"))
      onClose()
    } catch (err) {
      notify(tr("保存失败：{0}", { "0": (err as Error).message }))
    } finally {
      setBusy(false)
    }
  }

  const themeLabel = THEMES.find((t) => t.key === theme)?.label ?? tr("默认")
  const approvalLabel = APPROVALS.find((a) => a.key === draft.approvalMode)?.label ?? tr("每次询问")
  const dirShort = draft.workspace ? draft.workspace.split(/[\\/]/).filter(Boolean).pop() ?? draft.workspace : tr("默认")

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal settings-modal aset-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>{tr("软件设置")}</h2>
          <button className="icon-btn" onClick={onClose} title={tr("关闭")}>
            {tr("关闭")}</button>
        </div>

        <div className="settings-body">
          <Sec
            id="look"
            title={tr("外观")}
            summary={`${themeLabel} · ${tr("缩放 {zoom}% · 字号 {font}%", { zoom: Math.round(zoom * 100), font: Math.round(fontScale * 100) })}`}
          >
            <div className="aset-row">
              <span className="aset-label">{tr("界面配色")}</span>
              <div className="aset-themes">
                {THEMES.map((t) => (
                  <button
                    key={t.key}
                    className={`aset-theme ${theme === t.key ? 'on' : ''}`}
                    onClick={() => void changeTheme(t.key)}
                    title={tr("{label}配色", { label: t.label })}
                  >
                    <span className="aset-theme-chip" aria-hidden="true">
                      <span style={{ background: t.swatch[0] }} />
                      <span style={{ background: t.swatch[1] }} />
                      <span style={{ background: t.swatch[2] }} />
                    </span>
                    <span className="aset-theme-name">{t.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <p className="aset-hint">{tr("立即生效。白色适合白天投屏，大条纹是深色底。")}</p>

            <div className="aset-row" style={{ marginTop: 12 }}>
              <span className="aset-label">{tr("界面缩放")}</span>
              <div className="aset-zooms">
                {ZOOMS.map((z) => (
                  <button
                    key={z}
                    className={`aset-zoom ${Math.abs(zoom - z) < 0.001 ? 'on' : ''}`}
                    onClick={() => void changeZoom(z)}
                    title={`${Math.round(z * 100)}%`}
                  >
                    {Math.round(z * 100)}%
                  </button>
                ))}
              </div>
            </div>
            <p className="aset-hint">
              {tr("字太小可调到 110%～125%，缩放会被记住。")}</p>

            {/* 字号独立于缩放：只改文字，不动按钮尺寸与间距 */}
            <div className="aset-row" style={{ marginTop: 16 }}>
              <span className="aset-label">{tr("字体大小")}</span>
              <div className="aset-fonts">
                <input
                  className="aset-range"
                  type="range"
                  min={FONT_SCALE_MIN}
                  max={FONT_SCALE_MAX}
                  step={FONT_SCALE_STEP}
                  value={fontScale}
                  onChange={(e) => updateFont({ fontScale: Number(e.target.value) })}
                  aria-label={tr("界面字体大小")}
                />
                <span className="aset-font-num">{Math.round(fontScale * 100)}%</span>
              </div>
            </div>
            <div className="aset-font-presets">
              {FONT_PRESETS.map((p) => (
                <button
                  key={p.value}
                  className={`aset-zoom ${Math.abs(fontScale - p.value) < 0.001 ? 'on' : ''}`}
                  onClick={() => updateFont({ fontScale: p.value })}
                >
                  {p.label} · {Math.round(p.value * 100)}%
                </button>
              ))}
              <button
                className="btn sm"
                disabled={Math.abs(fontScale - 1) < 0.001}
                onClick={() => updateFont({ fontScale: 1 })}
              >
                {tr("恢复默认")}
              </button>
            </div>
            <p className="aset-hint">
              {tr("只放大文字，不动按钮和间距；可与「界面缩放」叠加。")}</p>

            <div className="aset-row" style={{ marginTop: 12 }}>
              <span className="aset-label">{tr("对话正文")}</span>
              <label className="aset-follow">
                <input
                  type="checkbox"
                  checked={chatFontScale === null}
                  onChange={(e) =>
                    updateFont({ chatFontScale: e.target.checked ? null : fontScale })
                  }
                />
                {tr("跟随界面字体")}
              </label>
            </div>
            {chatFontScale !== null && (
              <div className="aset-row">
                <span className="aset-label" />
                <div className="aset-fonts">
                  <input
                    className="aset-range"
                    type="range"
                    min={FONT_SCALE_MIN}
                    max={FONT_SCALE_MAX}
                    step={FONT_SCALE_STEP}
                    value={chatFontScale}
                    onChange={(e) => updateFont({ chatFontScale: Number(e.target.value) })}
                    aria-label={tr("对话正文字号")}
                  />
                  <span className="aset-font-num">{Math.round(chatFontScale * 100)}%</span>
                </div>
              </div>
            )}
            <p className="aset-hint">
              {tr("只调消息、代码块和工具结果；读长回答可再大一号。")}</p>

            <div className="aset-font-preview">
              <div className="aset-preview-ui">
                <b>{tr("界面文字预览")}</b>
                <span>{tr("模型选择 · 工作区 · 发送 · 设置")}</span>
              </div>
              <div className="aset-preview-chat">
                <b>{tr("对话正文预览")}</b>
                <p>{tr("把这段回答调到你看着舒服的大小就好。")}</p>
                <code>npm run build</code>
              </div>
            </div>
          </Sec>

          <Sec id="workspace" title={tr("工作区")} summary={dirShort}>
            <div className="aset-row">
              <span className="aset-label">{tr("默认目录")}</span>
              <code className="aset-path" title={draft.workspace ?? ''}>
                {draft.workspace || tr("（未设置，默认用软件目录下的 workspace/）")}
              </code>
            </div>
            <div className="aset-actions">
              <button className="btn sm" onClick={() => void pickWorkspace()}>
                {tr("选择目录")}</button>
              <button
                className="btn sm"
                disabled={!draft.workspace}
                onClick={() => setDraft((d) => ({ ...d, workspace: null }))}
              >
                {tr("清除")}</button>
            </div>
            <p className="aset-hint">
              {tr("新会话默认在此读写；已有会话保留原目录。")}</p>
          </Sec>

          <Sec id="approval" title={tr("审批与执行")} summary={tr("{approvalLabel} · {maxSteps} 步", { approvalLabel: approvalLabel, maxSteps: draft.maxSteps })}>
            <div className="aset-radios">
              {APPROVALS.map((a) => (
                <label key={a.key} className={`aset-radio ${draft.approvalMode === a.key ? 'on' : ''}`}>
                  <input
                    type="radio"
                    name="approval"
                    checked={draft.approvalMode === a.key}
                    onChange={() => setDraft((d) => ({ ...d, approvalMode: a.key }))}
                  />
                  <span className="aset-radio-main">
                    <b>{a.label}</b>
                    <span>{a.desc}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="aset-row">
              <span className="aset-label">{tr("单轮最大步数")}</span>
              <input
                className="aset-num"
                type="number"
                min={5}
                max={100}
                value={draft.maxSteps}
                onChange={(e) => setDraft((d) => ({ ...d, maxSteps: Number(e.target.value) || 30 }))}
              />
              <span className="aset-unit">{tr("步")}</span>
            </div>
            <p className="aset-hint">{tr("一次提问最多连续做多少步（读文件、改代码、跑命令），5～100。")}</p>

            <label className="aset-check">
              <input
                type="checkbox"
                checked={draft.autoContinue !== false}
                onChange={(e) => setDraft((d) => ({ ...d, autoContinue: e.target.checked }))}
              />
              <span className="aset-check-main">
                <b>{tr("任务没做完就自动接着做")}</b>
                <span>
                  {tr("计划没做完、或助手只说不动手，就自动再推一轮；做完才交回控制权。")}</span>
              </span>
            </label>
          </Sec>

          <Sec
            id="ability"
            title={tr("联网与记忆")}
            summary={tr("联网{0} · 验证{1} · 记忆{2}", { "0": draft.webSearch !== false ? tr("开") : tr("关"), "1": draft.autoVerify !== false ? tr("开") : tr("关"), "2": draft.memory !== false ? tr("开") : tr("关") })}
          >
            <label className="aset-check">
              <input
                type="checkbox"
                checked={draft.webSearch !== false}
                onChange={(e) => setDraft((d) => ({ ...d, webSearch: e.target.checked }))}
              />
              <span className="aset-check-main">
                <b>{tr("允许联网搜索与读取网页")}</b>
                <span>
                  {tr("开启后可查文档、报错、库版本；关闭后只用本地文件，需要联网会直说。")}</span>
              </span>
            </label>

            <label className="aset-check">
              <input
                type="checkbox"
                checked={draft.autoVerify !== false}
                onChange={(e) => setDraft((d) => ({ ...d, autoVerify: e.target.checked }))}
              />
              <span className="aset-check-main">
                <b>{tr("自动验证结果")}</b>
                <span>
                  {tr("改完代码自动跑测试 / 构建，失败就继续修，最多两轮。")}</span>
              </span>
            </label>

            <label className="aset-check">
              <input
                type="checkbox"
                checked={draft.memory !== false}
                onChange={(e) => setDraft((d) => ({ ...d, memory: e.target.checked }))}
              />
              <span className="aset-check-main">
                <b>{tr("跨对话记忆")}</b>
                <span>
                  {tr("记下构建命令和约定，新会话自动带上；关闭后不再记录。")}</span>
              </span>
            </label>
            <p className="aset-hint">
              {tr("已记内容不会因关闭丢失，可在「数据」里清空。")}</p>
          </Sec>

          <Sec
            id="context"
            title={tr("上下文")}
            summary={
              draft.contextLimit
                ? tr("上限 {0} · {1}", { "0": ctxLabel(draft.contextWindow), "1": draft.autoCompact !== false ? tr("自动压缩") : tr("不压缩") })
                : tr("不限制 · {0}", { "0": draft.autoCompact !== false ? tr("自动压缩") : tr("不压缩") })
            }
          >
            <div className="aset-row">
              <span className="aset-label">{tr("限制上下文长度")}</span>
              <button
                role="switch"
                aria-checked={draft.contextLimit === true}
                className={`aset-switch ${draft.contextLimit ? 'on' : ''}`}
                title={draft.contextLimit ? tr("点击改为不限制") : tr("点击设置上限")}
                onClick={() => setDraft((d) => ({ ...d, contextLimit: !d.contextLimit }))}
              >
                <i />
              </button>
            </div>
            <p className="aset-hint">
              {tr("默认不限制，直到窗口装不下；开启只为省显存和 token。")}</p>

            <div className={`aset-row ${draft.contextLimit ? '' : 'off'}`} style={{ marginTop: 12 }}>
              <span className="aset-label">{tr("上限值")}</span>
              <div className="aset-zooms">
                {CTXS.map((n) => (
                  <button
                    key={n}
                    className={`aset-zoom ${draft.contextWindow === n ? 'on' : ''}`}
                    disabled={!draft.contextLimit}
                    onClick={() => setDraft((d) => ({ ...d, contextWindow: n }))}
                    title={`${n} tokens`}
                  >
                    {ctxLabel(n)}
                  </button>
                ))}
              </div>
            </div>
            <p className="aset-hint">
              {draft.contextLimit
                ? tr("越大记得越多也越占显存（7B 每 1K tokens 约 60MB）。llama.cpp 按此上限启动。")
                : tr("不限制时灰显：实际按模型自己的窗口跑。")}
            </p>

            <label className="aset-check">
              <input
                type="checkbox"
                checked={draft.autoCompact !== false}
                onChange={(e) => setDraft((d) => ({ ...d, autoCompact: e.target.checked }))}
              />
              <span className="aset-check-main">
                <b>{tr("自动压缩早期对话")}</b>
                <span>{tr("占到窗口 75% 就把前段压成摘要再继续。")}</span>
              </span>
            </label>
            <p className="aset-hint">
              {tr("后台自动压缩，只留目标、结论、改过的文件和待办；会多花一次模型调用。")}</p>

            <div className="aset-row" style={{ marginTop: 12 }}>
              <span className="aset-label">{tr("并发槽位")}</span>
              <div className="aset-zooms">
                {[0, 2, 3, 4].map((n) => (
                  <button
                    key={n}
                    className={`aset-zoom ${(draft.llamaParallel ?? 0) === n ? 'on' : ''}`}
                    onClick={() => setDraft((d) => ({ ...d, llamaParallel: n || undefined }))}
                    title={n ? tr("{0} 个槽位", { "0": n }) : tr("交给 llama.cpp 按可用显存决定")}
                  >
                    {n || tr("自动")}
                  </button>
                ))}
              </div>
            </div>
            <p className="aset-hint">
              {tr("llama.cpp 同时处理几个请求。子代理并行时调 2 以上；不改就按显存自动。")}</p>
          </Sec>

          <Sec
            id="net"
            title={tr("网络与扩展")}
            summary={tr("{0} · MCP {1}", { "0": draft.proxyUrl ? tr("代理") : tr("直连"), "1": draft.mcpEnabled !== false ? (mcp?.length ? `${mcp.filter((s) => s.ok).length}/${mcp.length}` : tr("开")) : tr("关") })}
          >
            <div className="aset-row">
              <span className="aset-label">{tr("HTTP 代理")}</span>
              <input
                className="aset-input"
                value={draft.proxyUrl ?? ''}
                placeholder={tr("http://127.0.0.1:7890（留空直连）")}
                onChange={(e) => setDraft((d) => ({ ...d, proxyUrl: e.target.value }))}
              />
            </div>
            <p className="aset-hint">
              {tr("搜网页、抓文档、下模型都走它；本地模型不受影响。")}</p>

            <label className="aset-check">
              <input
                type="checkbox"
                checked={draft.mcpEnabled !== false}
                onChange={(e) => setDraft((d) => ({ ...d, mcpEnabled: e.target.checked }))}
              />
              <span className="aset-check-main">
                <b>{tr("启用 MCP 外部工具")}</b>
                <span>{tr("读 mcp.json，把外部服务的工具挂给模型。")}</span>
              </span>
            </label>

            <div className="mcp-box">
              <div className="mcp-head">
                <span>{mcp === null ? tr("正在读取…") : mcp.length ? tr("{length} 个服务", { length: mcp.length }) : tr("还没有配置服务")}</span>
                <span className="spacer" />
                <button
                  className="btn sm"
                  onClick={async () => {
                    const r = await window.pico.mcp.openConfig()
                    notify(r.message ?? tr("配置文件：{path}", { path: r.path }))
                  }}
                >
                  {tr("编辑 mcp.json")}</button>
                <button
                  className="btn sm"
                  onClick={async () => {
                    const list = await window.pico.mcp.reload()
                    setMcp(list)
                    notify(
                      list.length ? tr("已重新连接：{0}/{length} 个服务可用", { "0": list.filter((s) => s.ok).length, length: list.length })  : tr("mcp.json 里没有启用的服务")
                    )
                  }}
                >
                  {tr("重新连接")}</button>
              </div>
              {mcp?.map((s) => (
                <div className={`mcp-row ${s.ok ? 'ok' : 'fail'}`} key={s.name}>
                  <span className={`mcp-dot ${s.ok ? 'ok' : 'fail'}`} />
                  <span className="mcp-name">{s.name}</span>
                  <span className="mcp-detail">
                    {s.ok ? tr("{length} 个工具", { length: s.tools.length }) : s.error || tr("连接失败")}
                  </span>
                </div>
              ))}
              <p className="aset-hint">
                {tr("改完点「重新连接」生效；外部工具仍按「执行命令」审批。")}</p>
            </div>
          </Sec>

          <Sec
            id="keys"
            title={tr("快捷键")}
            summary={
              KEY_ACTIONS.filter((a) => keys[a])
                .map((a) => keys[a])
                .join(' · ') || tr("未绑定")
            }
          >
            {KEY_ACTIONS.map((action) => (
              <div className="aset-row key-row" key={action}>
                <span className="aset-label">
                  {KEY_META[action].label}
                  <span className="aset-sub">{KEY_META[action].desc}</span>
                </span>
                <button
                  className={`key-combo ${recording === action ? 'recording' : ''} ${keys[action] ? '' : 'unbound'}`}
                  onClick={() => setRecording(recording === action ? null : action)}
                  title={tr("点一下，然后按下新的组合键；Esc 取消")}
                >
                  {recording === action ? tr("请按下组合键…") : keys[action] || tr("未绑定")}
                </button>
              </div>
            ))}
            <div className="aset-actions">
              <button className="btn sm" onClick={() => void persistKeys(DEFAULT_KEYS)}>
                {tr("恢复默认快捷键")}</button>
            </div>
            <p className="aset-hint">
              {tr("只支持带 Ctrl 的组合，改完立即生效。")}</p>
          </Sec>

          <Sec id="data" title={tr("数据")} summary={tr("{0} 条会话", { "0": info?.sessionCount ?? 0 })}>
            <div className="aset-row">
              <span className="aset-label">{tr("数据目录")}</span>
              <code className="aset-path" title={info?.dataDir ?? ''}>
                {info?.dataDir ?? tr("读取中…")}
              </code>
            </div>
            <div className="aset-actions">
              <button className="btn sm" onClick={() => void window.pico.app.openDataDir()}>
                {tr("打开数据目录")}</button>
              <button className="btn sm" onClick={() => void window.pico.app.openLogs()}>
                {tr("打开日志目录")}</button>
            </div>
            <p className="aset-hint">
              {tr("里面有 config.json、sessions/（当前")}{info?.sessionCount ?? 0} {tr("条会话）、prefs.json。卸载不会删这里；要清干净请手动删。")}</p>

            <div className="aset-row" style={{ marginTop: 12 }}>
              <span className="aset-label">{tr("长期记忆")}</span>
              <code className="aset-path" title={mem?.path ?? ''}>
                {mem ? tr("{items} 条 · {1} KB", { items: mem.items, "1": (mem.chars / 1024).toFixed(1) }) : tr("读取中…")}
              </code>
            </div>
            <div className="aset-actions">
              <button className="btn sm" disabled={!mem?.items} onClick={() => void clearMem()}>
                {tr("清空记忆")}</button>
            </div>
            <p className="aset-hint">
              {tr("remember 记下的项目约定，每次对话自动带上；按工作区存在 memory/ 下。")}</p>

            <div className="aset-row" style={{ marginTop: 16 }}>
              <span className="aset-label">{tr("项目规则")}</span>
              <code className="aset-path" title={instr?.path ?? ''}>
                {instr
                  ? instr.path
                    ? instr.name + (instr.truncated ? tr("（已截断）") : "")
                    : tr("未设置")
                  : tr("读取中…")}
              </code>
            </div>
            <div className="aset-actions">
              <button className="btn sm" onClick={() => void initInstr()}>
                {instr?.path ? tr("重新读取") : tr("生成 AGENTS.md")}</button>
            </div>
            <p className="aset-hint">
              {tr("随仓库提交的 AGENTS.md / CLAUDE.md，向上逐层查找，每次对话都注入。")}</p>
          </Sec>

          <Sec
            id="permissions"
            title={tr("项目权限")}
            summary={perms ? tr("{0} 条规则", { "0": perms.length }) : tr("读取中…")}
          >
            {permsPath && (
              <div className="aset-row">
                <span className="aset-label">{tr("规则文件")}</span>
                <code className="aset-path" title={permsPath}>{permsPath}</code>
              </div>
            )}

            {permFiles.length > 1 && (
              <p className="aset-hint">
                {tr("已合并 {0} 份 roroto.json，越近优先级越高；标「继承」的要去父目录改。", { "0": permFiles.length })}
              </p>
            )}

            {perms && perms.length === 0 && (
              <p className="aset-hint">
                {tr("还没有规则。deny 用来收紧，allow 让常用命令少点确认。")}</p>
            )}

            {perms && perms.length > 0 && (
              <div className="perm-list">
                {perms.map((r, i) => {
                  const inherited = r.from !== permsPath
                  return (
                    <div className="perm-item" key={`${i}-${r.action}-${r.resource}`}>
                      <span className={`perm-effect ${r.effect}`}>
                        {r.effect === 'deny' ? tr("拒绝") : tr("放行")}
                      </span>
                      <code className="perm-action" title={r.action}>{r.action}</code>
                      <code className="perm-resource" title={r.resource}>{r.resource}</code>
                      {inherited && (
                        <span className="skill-tag hub" title={r.from}>
                          {tr("继承")}
                        </span>
                      )}
                      <button
                        className="btn sm danger"
                        disabled={permBusy || inherited}
                        onClick={() => void removePerm(i)}
                        title={inherited ? tr("这条规则继承自父目录，请到 {0} 里修改", { "0": r.from }) : tr("删除这条规则")}
                      >
                        {tr("删除")}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            <div className="perm-add">
              <div className="perm-add-head">{tr("新增规则")}</div>
              <div className="perm-add-fields">
                <input
                  className="aset-input perm-input"
                  placeholder={tr("工具名，如 run_shell / patch / *")}
                  value={permDraft.action}
                  onChange={(e) => setPermDraft((d) => ({ ...d, action: e.target.value }))}
                />
                <input
                  className="aset-input perm-input perm-input-wide"
                  placeholder={tr("匹配目标，如 npm / src/secrets* / *")}
                  value={permDraft.resource}
                  onChange={(e) => setPermDraft((d) => ({ ...d, resource: e.target.value }))}
                />
                <select
                  className="aset-input perm-select"
                  value={permDraft.effect}
                  onChange={(e) =>
                    setPermDraft((d) => ({ ...d, effect: e.target.value as 'allow' | 'deny' }))
                  }
                >
                  <option value="deny">{tr("拒绝")}</option>
                  <option value="allow">{tr("放行")}</option>
                </select>
                <button className="btn sm primary" disabled={permBusy} onClick={() => void addPerm()}>
                  {tr("添加")}
                </button>
              </div>
            </div>

            <p className="aset-hint">
              {tr("规则按顺序匹配，写在 roroto.json 的 permissions 里。")}</p>
          </Sec>

          <Sec id="trash" title={tr("回收站")} summary={trash ? tr("{0} 条", { "0": trash.length }) : tr("读取中…")}>
            {trash && trash.length === 0 && (
              <p className="aset-hint">
                {tr("没有已删除的会话；这里保留 7 天，超期自动清理。")}</p>
            )}
            {trash && trash.length > 0 && (
              <div className="trash-list">
                {trash.map((t) => (
                  <div className="trash-item" key={t.file}>
                    <div className="trash-main">
                      <span className="trash-title" title={t.title}>{t.title}</span>
                      <span className="trash-meta">
                        {fmtTime(t.deletedAt)} · {tr("{0} 条消息", { "0": t.messages })} ·{' '}
                        {t.workspace ? t.workspace.split(/[\\/]/).filter(Boolean).pop() : tr("未指定工作区")}
                      </span>
                    </div>
                    <div className="trash-actions">
                      <button className="btn sm" disabled={trashBusy} onClick={() => void restoreTrash(t.file)}>
                        {tr("恢复")}</button>
                      <button
                        className="btn sm danger"
                        disabled={trashBusy}
                        onClick={() => void purgeTrash(t.file, t.title)}
                      >
                        {tr("永久删除")}</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="aset-hint">
              {tr("删除只是移到这里，项目文件不受影响；存放在 sessions/.trash/。")}</p>
          </Sec>

          <Sec id="about" title={tr("关于")} summary={info?.version ? `v${info.version}` : undefined}>
            <div className="aset-about">
              <div>
                <span className="aset-k">{tr("版本")}</span>
                <span className="aset-v">v{info?.version ?? '—'}</span>
              </div>
              <div>
                <span className="aset-k">{tr("运行环境")}</span>
                <span className="aset-v">
                  Electron {info?.electron ?? '—'} · Chromium {info?.chrome ?? '—'} · Node {info?.node ?? '—'}
                </span>
              </div>
              <div>
                <span className="aset-k">{tr("平台")}</span>
                <span className="aset-v">{info?.platform ?? '—'}</span>
              </div>
              <div>
                <span className="aset-k">{tr("联系作者")}</span>
                <span className="aset-v aset-mail">
                  <a href={`mailto:${AUTHOR_EMAIL}?subject=RoRoTo%20Code%20%E5%8F%8D%E9%A6%88`}>
                    {AUTHOR_EMAIL}
                  </a>
                  <button className="aset-copy" onClick={copyMail} title={tr("复制邮箱地址")}>
                    {mailCopied ? tr("已复制") : tr("复制")}
                  </button>
                </span>
              </div>
            </div>
            <p className="aset-hint">
              {tr("遇到 bug 或模型跑不起来，把复现步骤和报错发上面邮箱。")}</p>
          </Sec>
        </div>

        <div className="settings-foot">
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" onClick={onClose}>
              {tr("取消")}</button>
            <button className="btn primary" onClick={() => void save()} disabled={busy}>
              {busy ? tr("保存中…") : tr("保存")}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
