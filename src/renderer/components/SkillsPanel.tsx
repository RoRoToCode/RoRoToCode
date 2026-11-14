import { t as tr } from '../i18n'
import { isPlainEnter } from '../keyboard'
import { useEffect, useMemo, useState } from 'react'
import type { RemoteSkill, Skill, SkillSource } from '../../shared/types'
import type { SkillDepReport } from '../../shared/skilldeps'

interface Props {
  onClose: () => void
  /** 点「调用」：把指令填进输入框 */
  onUse: (skill: Skill) => void
  notify: (message: string) => void
}

interface Draft {
  id?: string
  name: string
  desc: string
  prompt: string
}

const EMPTY: Draft = { name: '', desc: '', prompt: '' }

export function SkillsPanel({ onClose, onUse, notify }: Props) {
  const [skills, setSkills] = useState<Skill[]>([])
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [tab, setTab] = useState<'installed' | 'hub'>('installed')

  // 在线技能源
  const [sources, setSources] = useState<SkillSource[]>([])
  const [repoInput, setRepoInput] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scan, setScan] = useState<{ repo: string; ref: string; skills: RemoteSkill[]; offline: boolean } | null>(null)
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [hubError, setHubError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)

  /** 离线技能靠 Python 脚本干活，装之前替用户查一次依赖，别等跑一半才报 ModuleNotFoundError */
  const [deps, setDeps] = useState<SkillDepReport | null>(null)
  const [checkingDeps, setCheckingDeps] = useState(false)

  const runDepsCheck = async () => {
    setCheckingDeps(true)
    try {
      setDeps(await window.pico.skills.checkDeps())
    } catch (err) {
      setHubError(tr("依赖检查失败：{0}", { "0": (err as Error).message }))
    } finally {
      setCheckingDeps(false)
    }
  }

  /** 6 个离线技能一次装齐（重复装是覆盖更新）。开关仍默认关，不悄悄占用上下文 */
  const installOfflinePack = async () => {
    setInstalling(true)
    try {
      const found = await window.pico.skills.scan({ sourceId: 'offline' })
      if (!found.ok || !found.skills.length) {
        notify(tr("没读到离线技能包"))
        return
      }
      const r = await window.pico.skills.install(found.skills)
      setSkills(r.skills)
      setTab('installed')
      notify(
        tr("已装好 {0} 个离线技能。到「已安装」页把要用的打开自动调用开关即可。", {
          "0": String(found.skills.length)
        })
      )
    } catch (err) {
      notify(tr("安装离线技能失败：{0}", { "0": (err as Error).message }))
    } finally {
      setInstalling(false)
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        setSkills(await window.pico.skills.list())
      } catch (err) {
        setError(tr("读取技能失败：{0}", { "0": (err as Error).message }))
      } finally {
        setLoaded(true)
      }
      try {
        setSources(await window.pico.skills.sources())
      } catch {
        /* 源列表拿不到也不影响已安装技能的使用 */
      }
    })()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (draft) setDraft(null)
        else onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [draft, onClose])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return skills
    return skills.filter((s) => `${s.name} ${s.desc} ${s.prompt}`.toLowerCase().includes(q))
  }, [skills, query])

  const mine = filtered.filter((s) => !s.builtin).length
  /** 打开了自动调用的技能数：面板上要能一眼看出「现在有几个会自动上场」 */
  const autoCount = skills.filter((s) => s.enabled).length

  async function submit() {
    if (!draft || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.pico.skills.save({
        id: draft.id,
        name: draft.name,
        desc: draft.desc,
        prompt: draft.prompt
      })
      setSkills(r.skills)
      if (!r.ok) {
        setError(r.message)
      } else {
        notify(r.message)
        setDraft(null)
      }
    } catch (err) {
      setError(tr("保存失败：{0}", { "0": (err as Error).message }))
    } finally {
      setBusy(false)
    }
  }

  async function remove(skill: Skill) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.pico.skills.remove(skill.id)
      setSkills(r.skills)
      if (!r.ok) setError(r.message)
      else notify(tr("已删除「{name}」", { name: skill.name }))
    } catch (err) {
      setError(tr("删除失败：{0}", { "0": (err as Error).message }))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 开关自动调用。
   * 先改本地再发请求：这个开关的反馈必须跟手，等一次 IPC 往返再变色会显得卡。
   * 请求失败就把它翻回去，别让界面停在一个主进程并不知道的状态上。
   */
  async function toggle(skill: Skill, next: boolean) {
    if (busy) return
    const patch = (on: boolean): void =>
      setSkills((prev) => prev.map((s) => (s.id === skill.id ? { ...s, enabled: on } : s)))
    patch(next)
    setError(null)
    try {
      const r = await window.pico.skills.toggle(skill.id, next)
      setSkills(r.skills)
      if (!r.ok) {
        setError(r.message)
        return
      }
      notify(r.message)
    } catch (err) {
      patch(!next)
      setError(tr("切换失败：{0}", { "0": (err as Error).message }))
    }
  }

  async function runScan(input: { repo?: string; sourceId?: string }) {
    if (scanning) return
    setScanning(true)
    setHubError(null)
    setScan(null)
    setPicked({})
    try {
      const r = await window.pico.skills.scan(input)
      if (!r.ok) {
        setHubError(r.message ?? tr("没有读到技能"))
        if (r.skills.length) setScan({ repo: r.repo, ref: r.ref, skills: r.skills, offline: r.offline })
      } else {
        setScan({ repo: r.repo, ref: r.ref, skills: r.skills, offline: r.offline })
      }
    } catch (err) {
      setHubError(tr("扫描失败：{0}", { "0": (err as Error).message }))
    } finally {
      setScanning(false)
    }
  }

  async function installPicked() {
    if (!scan || installing) return
    const items = scan.skills.filter((s) => picked[s.key])
    if (items.length === 0) return
    setInstalling(true)
    setHubError(null)
    try {
      const r = await window.pico.skills.install(items)
      setSkills(r.skills)
      if (r.ok) {
        notify(r.message)
        setScan({
          ...scan,
          skills: scan.skills.map((s) =>
            picked[s.key] ? { ...s, installed: true } : s
          )
        })
        setPicked({})
      } else {
        setHubError(r.message)
      }
    } catch (err) {
      setHubError(tr("安装失败：{0}", { "0": (err as Error).message }))
    } finally {
      setInstalling(false)
    }
  }

  const pickedCount = Object.values(picked).filter(Boolean).length
  const allPicked = Boolean(scan) && scan!.skills.length > 0 && pickedCount === scan!.skills.length

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal skills-modal" onClick={(e) => e.stopPropagation()}>
        <div className="skills-head">
          <div className="skills-head-text">
            <h2>{tr("技能")}</h2>
            <span className="skills-sub">
              {tr("点「调用」把指令填进输入框；打开开关后，模型在合适的任务里会自己用上它。")}</span>
          </div>
          <button className="icon-btn" onClick={onClose} title={tr("关闭")}>
            {tr("关闭")}</button>
        </div>

        {!draft && (
          <div className="skills-tabs">
            <button
              className={`skills-tab${tab === 'installed' ? ' active' : ''}`}
              onClick={() => setTab('installed')}
            >
              {tr("已安装")}{skills.length}
            </button>
            <button
              className={`skills-tab${tab === 'hub' ? ' active' : ''}`}
              onClick={() => setTab('hub')}
            >
              {tr("从 GitHub 获取")}</button>
          </div>
        )}

        {!draft && tab === 'installed' && (
          <p className="skills-hint">
            {tr("刚干完一件漂亮活？在对话里输入 /learn，助手会把这次的操作轨迹蒸馏成一条技能。")}
          </p>
        )}

        {draft ? (
          <div className="skill-form">
            <label className="skill-field">
              <span>{tr("名称")}</span>
              <input
                className="skill-input"
                autoFocus
                value={draft.name}
                maxLength={30}
                placeholder={tr("例如：接口压测")}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="skill-field">
              <span>{tr("一句话说明")}</span>
              <input
                className="skill-input"
                value={draft.desc}
                maxLength={60}
                placeholder={tr("选填，面板上显示这行")}
                onChange={(e) => setDraft({ ...draft, desc: e.target.value })}
              />
            </label>
            <label className="skill-field">
              <span>{tr("指令内容")}</span>
              <textarea
                className="skill-textarea"
                rows={10}
                value={draft.prompt}
                placeholder={tr("写给模型的具体要求。例如：给 src/api 每个接口补压测脚本，测 P95。")}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              />
            </label>
            {error && <div className="skill-error">{error}</div>}
            <div className="skill-form-foot">
              <button className="btn" onClick={() => setDraft(null)} disabled={busy}>
                {tr("取消")}</button>
              <button
                className="btn primary"
                onClick={() => void submit()}
                disabled={busy || !draft.name.trim() || !draft.prompt.trim()}
              >
                {busy ? tr("保存中…") : tr("保存技能")}
              </button>
            </div>
          </div>
        ) : tab === 'installed' ? (
          <>
            <div className="skills-toolbar">
              <input
                className="specs-search"
                value={query}
                placeholder={tr("搜索技能名称或内容")}
                onChange={(e) => setQuery(e.target.value)}
              />
              <span className="skills-count">
                {tr("共")}{skills.length} {tr("个")}{query.trim() ? tr("，匹配 {length} 个", { length: filtered.length }) : ''}
                {mine > 0 ? tr("（自定义 {mine}）", { mine: mine }) : ''}
                {autoCount > 0 ? tr("（自动调用 {n}）", { n: autoCount }) : ''}
              </span>
            </div>

            <div className="skill-list">
              {!loaded && <div className="skill-empty">{tr("正在读取…")}</div>}
              {loaded && filtered.length === 0 && (
                <div className="skill-empty">
                  {query.trim() ? tr("没有匹配的技能") : tr("还没有技能，点下面「新建技能」加一个")}
                </div>
              )}
              {filtered.map((s) => (
                <div className="skill-row" key={s.id}>
                  <div className="skill-main">
                    <div className="skill-name">
                      {s.name}
                      {s.builtin ? <span className="skill-tag">{tr("内置")}</span> : null}
                      {s.source === 'workbuddy' ? (
                        <span className="skill-tag hub" title={s.localPath || ''}>
                          {tr("本机")}
                        </span>
                      ) : s.source ? (
                        <span className="skill-tag hub" title={s.sourcePath || s.source}>
                          {tr("来自")}{s.source}
                        </span>
                      ) : null}
                      {s.enabled ? <span className="skill-tag auto">{tr("自动")}</span> : null}
                    </div>
                    <div className="skill-desc">{s.desc || s.prompt.slice(0, 48)}</div>
                  </div>
                  <div className="skill-ops">
                    <span className="skill-toggle">
                      <button
                        role="switch"
                        aria-checked={s.enabled === true}
                        aria-label={tr("自动调用")}
                        className={`aset-switch ${s.enabled ? 'on' : ''}`}
                        title={
                          s.enabled
                            ? tr("已开启自动调用：模型在合适的任务里会自己取用这个技能。点击关闭")
                            : tr("打开后模型能自己调用它（名称和说明会进系统提示）。关闭时只能手动点「调用」")
                        }
                        onClick={() => void toggle(s, !s.enabled)}
                      >
                        <i />
                      </button>
                    </span>
                    <button
                      className="btn primary sm"
                      onClick={() => onUse(s)}
                      title={tr("把这段指令填进输入框")}
                    >
                      {tr("调用")}</button>
                    {!s.builtin && (
                      <button
                        className="btn sm"
                        disabled={busy}
                        onClick={() =>
                          setDraft({ id: s.id, name: s.name, desc: s.desc, prompt: s.prompt })
                        }
                      >
                        {tr("编辑")}</button>
                    )}
                    {!s.builtin && (
                      <button
                        className="btn sm danger"
                        disabled={busy}
                        onClick={() => void remove(s)}
                      >
                        {tr("删除")}</button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="skills-foot">
              <button className="btn" onClick={() => setDraft({ ...EMPTY })}>
                {tr("+ 新建技能")}</button>
              <button className="btn primary" onClick={() => setTab('hub')}>
                {tr("从 GitHub 获取")}</button>
              {error && <span className="skill-error">{error}</span>}
            </div>
          </>
        ) : (
          <>
            <div className="hub-body">
              <div className="hub-sources">
                {sources.map((s) => (
                  <button
                    key={s.id}
                    className="hub-chip"
                    disabled={scanning}
                    onClick={() => {
                      setRepoInput(s.offline ? '' : `${s.repo}`)
                      void runScan({ sourceId: s.id })
                    }}
                    title={s.offline ? tr(s.desc) : `${s.repo} · ${tr(s.desc)}`}
                  >
                    {tr(s.label)}
                  </button>
                ))}
              </div>

              <div className="hub-custom">
                <input
                  className="skill-input"
                  value={repoInput}
                  placeholder={tr("也可以填任意仓库：owner/repo 或 GitHub 链接（会自动找里面的 SKILL.md）")}
                  onChange={(e) => setRepoInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (isPlainEnter(e) && repoInput.trim()) void runScan({ repo: repoInput })
                  }}
                />
                <button
                  className="btn"
                  disabled={scanning || !repoInput.trim()}
                  onClick={() => void runScan({ repo: repoInput })}
                >
                  {tr("扫描")}</button>
              </div>

              <div className="hub-hint">
                {tr("技能源是 GitHub 上的仓库，每个")}<code>xxx/SKILL.md</code> {tr("算一个技能。扫描只读文件，装进本地后随时可改可删。")}</div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                <button className="btn" disabled={checkingDeps} onClick={() => void runDepsCheck()}>
                  {checkingDeps ? tr("检查中…") : tr("检查本机依赖")}</button>
                <button className="btn primary" disabled={installing} onClick={() => void installOfflinePack()}>
                  {installing ? tr("安装中…") : tr("一键装齐离线技能包")}</button>
                <span className="hub-hint">
                  {tr("PDF / Word / Excel / PPT 这类离线技能靠 Python 跑，先看缺不缺包。只读检查，不装东西、不联网。")}
                </span>
              </div>

              {deps && (
                <div style={{ marginTop: 8, padding: '8px 10px', border: '1px solid var(--border, #444)', borderRadius: 8 }}>
                  <div className={deps.ok ? 'hub-hint' : 'hub-error'}>{tr(deps.message)}</div>
                  {deps.installCmd && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' }}>
                      <code style={{ flex: 1, overflowWrap: 'anywhere' }}>{deps.installCmd}</code>
                      <button
                        className="btn"
                        onClick={() => {
                          void navigator.clipboard
                            ?.writeText(deps.installCmd)
                            .then(() => notify(tr("已复制安装命令")))
                            .catch(() => notify(tr("复制失败，请手动选中这行命令")))
                        }}
                      >
                        {tr("复制")}</button>
                    </div>
                  )}
                  <div style={{ display: 'grid', gap: 4 }}>
                    {deps.items.map((it) => (
                      <div key={it.skill} className="hub-hint" style={{ display: 'flex', gap: 8 }}>
                        <span style={{ minWidth: 110 }}>{tr(it.skill)}</span>
                        <span>
                          {it.ok
                            ? tr("依赖齐备")
                            : tr("缺 {0}", { "0": it.missing.join('、') || tr("Python") })}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {scanning && <div className="skill-empty">{tr("正在从 GitHub 读取技能清单…（技能多的仓库要十几秒）")}</div>}
              {!scanning && !scan && !hubError && (
                <div className="skill-empty">{tr("点上面任意一个源，或填一个仓库地址开始扫描")}</div>
              )}
              {hubError && <div className="hub-error">{hubError}</div>}

              {scan && (
                <>
                  <div className="hub-result-head">
                    <span className="skills-count">
                      {scan.offline ? tr("本机内置") : `${scan.repo}${scan.ref ? ` @ ${scan.ref}` : ''}`} ·{' '}
                      {scan.skills.length} {tr("个技能")}</span>
                    <button
                      className="link-btn"
                      onClick={() =>
                        setPicked(
                          allPicked
                            ? {}
                            : Object.fromEntries(scan.skills.map((s) => [s.key, true]))
                        )
                      }
                    >
                      {allPicked ? tr("取消全选") : tr("全选")}
                    </button>
                  </div>
                  <div className="skill-list">
                    {scan.skills.map((s) => (
                      <div
                        className={`skill-row hub-row${picked[s.key] ? ' on' : ''}`}
                        key={s.key}
                        onClick={() => setPicked((prev) => ({ ...prev, [s.key]: !prev[s.key] }))}
                      >
                        <span className={`hub-check${picked[s.key] ? ' on' : ''}`}>
                          {picked[s.key] ? '✓' : ''}
                        </span>
                        <div className="skill-main">
                          <div className="skill-name">
                            {s.name}
                            {s.installed ? <span className="skill-tag ok">{tr("已安装")}</span> : null}
                          </div>
                          <div className="skill-desc">{s.desc || s.prompt.slice(0, 60)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="skills-foot">
              <button
                className="btn primary"
                disabled={installing || pickedCount === 0}
                onClick={() => void installPicked()}
              >
                {installing ? tr("安装中…") : tr("安装选中{0}", { "0": pickedCount ? `（${pickedCount}）` : '' })}
              </button>
              {scan && scan.skills.some((s) => s.installed) && (
                <span className="skills-count">{tr("已装过的再装一次就是更新内容")}</span>
              )}
              <span className="hub-spacer" />
              <button className="btn" onClick={() => setTab('installed')}>
                {tr("返回已安装")}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
