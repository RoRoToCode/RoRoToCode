import { t as tr } from '../i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentProfile, BoardInfo, Handoff, ProviderConfig, Routine, RoutineTrigger } from '../../shared/types'

interface Props {
  onClose: () => void
  notify: (message: string, kind?: 'info' | 'warn' | 'error') => void
  providers: ProviderConfig[]
  currentWorkspace: string | null
  /** 从侧栏点某个头像进来时带上它：面板直接停在这个档案上，不用再找一遍 */
  initialAgentId?: string | null
  /**
   * 用户明确说「用它开始一个任务」时才回调。
   * 点头像、看档案都不该顺手建会话 —— 会话是用户要发起的一件任务。
   */
  onStartTask?: (agent: AgentProfile) => void
}

type Tab = 'agents' | 'routines' | 'handoffs' | 'board'

interface AgentDraft {
  id?: string
  name: string
  role: string
  /** false = 不限制（除编排工具外全开）；true = 只给勾选的那些 */
  restrict: boolean
  tools: string[]
  workspace: string | null
  ownMemory: boolean
  modelId: string | null
}

interface RoutineDraft {
  id?: string
  name: string
  agentId: string
  prompt: string
  mode: 'daily' | 'interval'
  hour: number
  minute: number
  minutes: number
  approvalPolicy: 'deny' | 'allow'
  enabled: boolean
}

const EMPTY_AGENT: AgentDraft = {
  name: '',
  role: '',
  restrict: true,
  tools: ['read_file', 'list_dir', 'glob', 'grep', 'run_shell'],
  workspace: null,
  ownMemory: true,
  modelId: null
}

function draftFrom(a: AgentProfile): AgentDraft {
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    restrict: Array.isArray(a.tools),
    tools: a.tools ?? [],
    workspace: a.workspace ?? null,
    ownMemory: a.ownMemory !== false,
    modelId: a.modelId ?? null
  }
}

function triggerOf(d: RoutineDraft): RoutineTrigger {
  return d.mode === 'daily'
    ? { kind: 'cron', expr: `${d.minute} ${d.hour} * * *` }
    : { kind: 'interval', minutes: d.minutes }
}

function describeTrigger(t: RoutineTrigger): string {
  if (t.kind === 'interval') return t.minutes % 60 === 0 ? tr("每 {0} 小时", { "0": t.minutes / 60 }) : tr("每 {0} 分钟", { "0": t.minutes })
  const parts = t.expr.trim().split(/\s+/)
  const min = Number(parts[0])
  const hour = Number(parts[1])
  if (parts.length === 5 && Number.isInteger(min) && Number.isInteger(hour)) {
    return tr("每天 {0}", { "0": `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}` })
  }
  return t.expr
}

function whenText(ts?: number): string {
  if (!ts) return tr("还没排期")
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? tr("今天 {0}", { "0": hm }) : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/** 回执里的 token 要一眼能比大小，不需要精确到个位 */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
}

const STATUS_LABEL: Record<string, string> = {
  ok: tr("上次成功"),
  fail: tr("上次失败"),
  running: tr("正在跑"),
  skipped: tr("已跳过")
}

const HANDOFF_LABEL: Record<string, string> = {
  pending: tr("排队中"),
  running: tr("正在跑"),
  ok: tr("已完成"),
  fail: tr("失败"),
  canceled: tr("已取消")
}

export function AgentPanel({ onClose, notify, providers, currentWorkspace, initialAgentId, onStartTask }: Props) {
  const [tab, setTab] = useState<Tab>('agents')
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [routines, setRoutines] = useState<Routine[]>([])
  const [handoffs, setHandoffs] = useState<Handoff[]>([])
  const [board, setBoard] = useState<BoardInfo | null>(null)
  const [tools, setTools] = useState<Array<{ name: string; desc: string }>>([])
  const [draft, setDraft] = useState<AgentDraft | null>(null)
  const [rdraft, setRdraft] = useState<RoutineDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<{ a: AgentProfile[]; r: Routine[] }> => {
    const [a, r, h, b] = await Promise.all([
      window.pico.agents.list(),
      window.pico.routines.list(),
      window.pico.handoffs.list(),
      // 黑板是一个小文件，跟着一起读，省得切 tab 时再等一次
      window.pico.board.get().catch(() => null)
    ])
    setAgents(a)
    setRoutines(r)
    setHandoffs(h)
    setBoard(b)
    return { a, r }
  }, [])

  // 定时任务和交接都在后台自己跑，面板开着的时候得跟着主进程的通知刷新，
  // 否则徽章永远停在打开面板那一刻
  useEffect(() => {
    const offA = window.pico.onChange('routines', () => void reload().catch(() => undefined))
    const offB = window.pico.onChange('handoffs', () => void reload().catch(() => undefined))
    return () => {
      offA()
      offB()
    }
  }, [reload])

  useEffect(() => {
    void reload().catch(() => undefined)
    void window.pico.agents
      .tools()
      .then(setTools)
      .catch(() => undefined)
  }, [reload])

  /**
   * 从侧栏点进来的那个档案：列表拉回来之后再定位。
   * 只做一次 —— 用户自己点了别的档案之后，不能被重新拉回去。
   */
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || !initialAgentId) return
    const target = agents.find((a) => a.id === initialAgentId)
    if (!target) return
    seeded.current = true
    setDraft(draftFrom(target))
    setTab('agents')
  }, [agents, initialAgentId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (draft || rdraft) {
        setDraft(null)
        setRdraft(null)
      } else {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draft, rdraft, onClose])

  const saveAgent = async (): Promise<void> => {
    if (!draft) return
    if (!draft.name.trim()) return setError(tr("先给它起个名字"))
    // 岗位描述允许留空：留空就是不注入角色，行为跟普通会话一致（内置的「主控」就是这样）
    if (draft.restrict && draft.tools.length === 0) return setError(tr("选了「只给这些工具」，至少勾一个"))

    setBusy(true)
    setError(null)
    try {
      const saved = await window.pico.agents.save({
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name.trim(),
        role: draft.role.trim(),
        // 空数组 = 不限制，和后端语义一致
        tools: draft.restrict ? draft.tools : [],
        workspace: draft.workspace,
        ownMemory: draft.ownMemory,
        modelId: draft.modelId
      })
      await reload()
      setDraft(draftFrom(saved))
      notify(tr("已保存「{0}」", { "0": saved.name }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const removeAgent = async (a: AgentProfile): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.pico.agents.remove(a.id)
      if (!r.removed) {
        notify(r.reason ?? tr("删不掉"), 'warn')
        return
      }
      setDraft(null)
      await reload()
      notify(tr("已删除「{0}」", { "0": a.name }))
    } catch (err) {
      notify((err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  /** 黑板整页清空：便签是「这摊活」的，活干完就该扔，不留考古层 */
  const clearBoardNow = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.pico.board.clear()
      await reload()
      notify(tr("黑板已清空"))
    } catch (err) {
      notify((err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const saveRoutine = async (): Promise<void> => {
    if (!rdraft) return
    if (!rdraft.name.trim()) return setError(tr("任务需要名字"))
    if (!rdraft.prompt.trim()) return setError(tr("写一句要它做的事"))
    setBusy(true)
    setError(null)
    try {
      await window.pico.routines.save({
        ...(rdraft.id ? { id: rdraft.id } : {}),
        name: rdraft.name.trim(),
        agentId: rdraft.agentId,
        prompt: rdraft.prompt.trim(),
        trigger: triggerOf(rdraft),
        approvalPolicy: rdraft.approvalPolicy,
        enabled: rdraft.enabled
      })
      setRdraft(null)
      await reload()
      notify(tr("任务已保存"))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const runHandoff = async (h: Handoff): Promise<void> => {
    try {
      const res = await window.pico.handoffs.run(h.id)
      if (!res.ok) notify(tr("没能放行：{0}", { "0": res.error ?? '未知原因' }), 'error')
      else notify(tr("已放行，跑完在会话列表里看结果"))
    } catch (err) {
      notify((err as Error).message, 'error')
    }
    await reload().catch(() => undefined)
  }

  const cancelHandoff = async (h: Handoff): Promise<void> => {
    try {
      await window.pico.handoffs.cancel(h.id)
    } catch {
      // 取消失败不影响界面：列表会跟着刷新，用户看得到它还在
    }
    await reload().catch(() => undefined)
  }

  const runNow = (r: Routine): void => {
    notify(tr("「{0}」已开始运行，完成后会在会话列表里出现", { "0": r.name }))
    // 不 await：一次真实运行可能要几分钟，界面不该卡在这里
    void window.pico.routines
      .run(r.id)
      .then((res) => {
        if (!res.ok) notify(tr("运行失败：{0}", { "0": res.error ?? '未知原因' }), 'error')
        else void reload()
      })
      .catch((err) => notify((err as Error).message, 'error'))
  }

  const pickWorkspace = async (): Promise<void> => {
    const dir = await window.pico.workspace.choose()
    if (dir && draft) setDraft({ ...draft, workspace: dir })
  }

  const agentName = (id: string): string => agents.find((a) => a.id === id)?.name ?? (id ? tr("已删除的档案") : tr("普通会话"))

  return (
    <div className="overlay" onClick={onClose}>
      <div className="agent-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="agent-panel-head">
          <div className="agent-tabs">
            <button className={tab === 'agents' ? 'on' : ''} onClick={() => setTab('agents')}>
              {tr("Agent 档案")}
            </button>
            <button className={tab === 'routines' ? 'on' : ''} onClick={() => setTab('routines')}>
              {tr("定时任务")}
            </button>
            <button className={tab === 'handoffs' ? 'on' : ''} onClick={() => setTab('handoffs')}>
              {tr("交接")}
            </button>
            <button className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>
              {tr("共享黑板")}
            </button>
          </div>
          <button className="agent-close" onClick={onClose} title={tr("关闭")}>
            ×
          </button>
        </header>

        {tab === 'agents' ? (
          <div className="agent-cols">
            <aside className="agent-list">
              {agents.map((a) => (
                <button
                  key={a.id}
                  className={`agent-list-item ${draft?.id === a.id ? 'on' : ''}`}
                  onClick={() => {
                    setDraft(draftFrom(a))
                    setError(null)
                  }}
                >
                  <span className="agent-list-name">
                    {a.name}
                    {a.builtin ? <span className="agent-badge">{tr("内置")}</span> : null}
                  </span>
                  <span className="agent-list-sub">
                    {Array.isArray(a.tools) ? tr("{0} 个工具", { "0": a.tools.length }) : tr("全部工具")}
                  </span>
                </button>
              ))}
              <button
                className="agent-list-new"
                onClick={() => {
                  setDraft({ ...EMPTY_AGENT, workspace: currentWorkspace })
                  setError(null)
                }}
              >
                {tr("+ 新建档案")}
              </button>
            </aside>

            <section className="agent-form">
              {!draft ? (
                <div className="agent-empty">
                  <p>{tr("左边选一个档案，或者新建一个。")}</p>
                  <p className="agent-empty-sub">
                    {tr("档案 = 一个固定的岗位：叫什么、负责什么、能碰哪些工具、用哪份记忆。")}
                    <br />
                    {tr("用它开会话时，这些都自动生效，你不用每次重复交代。")}
                  </p>
                </div>
              ) : (
                <>
                  <div className="agent-form-scroll">
                  <div className="agent-field">
                    <label>{tr("名字")}</label>
                    <input
                      value={draft.name}
                      placeholder={tr("比如：巡检、审查、文档")}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    />
                  </div>

                  <div className="agent-field">
                    <label>
                      {tr("岗位描述")}
                      <span className="agent-label-hint">{tr("原样注入系统提示；留空 = 不注入角色，跟普通会话一致")}</span>
                    </label>
                    <textarea
                      className="agent-role"
                      value={draft.role}
                      placeholder={tr("你负责……\n每次先看……\n输出格式：……")}
                      onChange={(e) => setDraft({ ...draft, role: e.target.value })}
                    />
                  </div>

                  <div className="agent-field">
                    <label>{tr("工具")}</label>
                    <div className="agent-tool-mode">
                      <button
                        className={draft.restrict ? 'on' : ''}
                        onClick={() => setDraft({ ...draft, restrict: true })}
                      >
                        {tr("只给勾选的")}
                      </button>
                      <button
                        className={!draft.restrict ? 'on' : ''}
                        onClick={() => setDraft({ ...draft, restrict: false })}
                      >
                        {tr("全部允许")}
                      </button>
                    </div>
                    {draft.restrict ? (
                      <div className="agent-tools">
                        {tools.map((t) => {
                          const on = draft.tools.includes(t.name)
                          return (
                            <button
                              key={t.name}
                              className={`tool-chip ${on ? 'on' : ''}`}
                              title={t.desc}
                              onClick={() =>
                                setDraft({
                                  ...draft,
                                  tools: on ? draft.tools.filter((x) => x !== t.name) : [...draft.tools, t.name]
                                })
                              }
                            >
                              {t.name}
                            </button>
                          )
                        })}
                      </div>
                    ) : (
                      <p className="agent-note">
                        {tr("除编排工具（task / update_todos）外全部可用。高危操作仍然会要你确认。")}
                      </p>
                    )}
                  </div>

                  <div className="agent-field">
                    <label>
                      {tr("默认工作区")}
                      <span className="agent-label-hint">{tr("留空 = 跟随当前工作区")}</span>
                    </label>
                    <div className="agent-ws">
                      <span className="agent-ws-path" title={draft.workspace ?? ''}>
                        {draft.workspace || tr("跟随当前工作区")}
                      </span>
                      <button className="btn" onClick={() => void pickWorkspace()}>
                        {tr("选择")}
                      </button>
                      {draft.workspace && (
                        <button className="btn" onClick={() => setDraft({ ...draft, workspace: null })}>
                          {tr("清除")}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="agent-field">
                    <label>{tr("默认模型")}</label>
                    <select
                      value={draft.modelId ?? ''}
                      onChange={(e) => setDraft({ ...draft, modelId: e.target.value || null })}
                    >
                      <option value="">{tr("跟随全局")}</option>
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} · {p.model}
                        </option>
                      ))}
                    </select>
                  </div>

                  <label className="agent-check">
                    <input
                      type="checkbox"
                      checked={draft.ownMemory}
                      onChange={(e) => setDraft({ ...draft, ownMemory: e.target.checked })}
                    />
                    {tr("使用独立记忆（推荐）：这个档案的经验不会和工作区里的普通对话混在一起")}
                  </label>

                  {error && <div className="agent-error">{error}</div>}
                  </div>

                  <div className="agent-actions">
                    <button className="btn primary" disabled={busy} onClick={() => void saveAgent()}>
                      {busy ? tr("保存中…") : tr("保存")}
                    </button>
                    {draft.id && (
                      <button
                        className="btn danger"
                        disabled={busy}
                        onClick={() => {
                          const a = agents.find((x) => x.id === draft.id)
                          if (a) void removeAgent(a)
                        }}
                      >
                        {tr("删除档案")}
                      </button>
                    )}
                    <span className="agent-spacer" />
                    {draft.id && onStartTask && (
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          const a = agents.find((x) => x.id === draft.id)
                          if (a) onStartTask(a)
                        }}
                        title={tr("建一个属于它的会话，然后你来说要做什么")}
                      >
                        {tr("用它开始一个任务")}
                      </button>
                    )}
                    {draft.id && (
                      <button
                        className="btn"
                        onClick={() => {
                          setRdraft({
                            name: draft.name,
                            agentId: draft.id ?? '',
                            prompt: '',
                            mode: 'daily',
                            hour: 9,
                            minute: 0,
                            minutes: 60,
                            approvalPolicy: 'deny',
                            enabled: true
                          })
                          setTab('routines')
                        }}
                      >
                        {tr("给它排个定时任务")}
                      </button>
                    )}
                  </div>
                </>
              )}
            </section>
          </div>
        ) : tab === 'routines' ? (
          <div className="routine-view">
            {rdraft ? (
              <section className="agent-form routine-form">
                <div className="agent-form-scroll">
                <div className="agent-field">
                  <label>{tr("任务名")}</label>
                  <input value={rdraft.name} onChange={(e) => setRdraft({ ...rdraft, name: e.target.value })} />
                </div>

                <div className="agent-field">
                  <label>
                    {tr("交给谁")}
                    <span className="agent-label-hint">{tr("醒来的是这个档案，它的工具和记忆都生效")}</span>
                  </label>
                  <select value={rdraft.agentId} onChange={(e) => setRdraft({ ...rdraft, agentId: e.target.value })}>
                    <option value="">{tr("普通会话（不带档案）")}</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="agent-field">
                  <label>
                    {tr("要做的事")}
                    <span className="agent-label-hint">{tr("要写成自包含的：它看不到你之前的对话")}</span>
                  </label>
                  <textarea
                    className="agent-role"
                    value={rdraft.prompt}
                    placeholder={tr("看一眼昨天改了什么，有没有没跑完的活")}
                    onChange={(e) => setRdraft({ ...rdraft, prompt: e.target.value })}
                  />
                </div>

                <div className="agent-field">
                  <label>{tr("什么时候跑")}</label>
                  <div className="agent-tool-mode">
                    <button className={rdraft.mode === 'daily' ? 'on' : ''} onClick={() => setRdraft({ ...rdraft, mode: 'daily' })}>
                      {tr("每天一次")}
                    </button>
                    <button
                      className={rdraft.mode === 'interval' ? 'on' : ''}
                      onClick={() => setRdraft({ ...rdraft, mode: 'interval' })}
                    >
                      {tr("每隔一段")}
                    </button>
                  </div>
                  {rdraft.mode === 'daily' ? (
                    <div className="routine-time">
                      <span>{tr("每天")}</span>
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={rdraft.hour}
                        onChange={(e) => setRdraft({ ...rdraft, hour: Math.max(0, Math.min(23, Number(e.target.value) || 0)) })}
                      />
                      <span>{tr("点")}</span>
                      <input
                        type="number"
                        min={0}
                        max={59}
                        value={rdraft.minute}
                        onChange={(e) =>
                          setRdraft({ ...rdraft, minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) })
                        }
                      />
                      <span>{tr("分")}</span>
                    </div>
                  ) : (
                    <div className="routine-time">
                      <span>{tr("每")}</span>
                      <input
                        type="number"
                        min={1}
                        value={rdraft.minutes}
                        onChange={(e) => setRdraft({ ...rdraft, minutes: Math.max(1, Number(e.target.value) || 1) })}
                      />
                      <span>{tr("分钟")}</span>
                    </div>
                  )}
                  <p className="agent-note">
                    {tr("同一时间只会跑一个任务：本地一份模型被两个长任务抢，两个都会变慢。")}
                  </p>
                </div>

                <div className="agent-field">
                  <label>
                    {tr("需要确认的操作")}
                    <span className="agent-label-hint">{tr("没人看着的时候，写文件要不要放行")}</span>
                  </label>
                  <select
                    value={rdraft.approvalPolicy}
                    onChange={(e) => setRdraft({ ...rdraft, approvalPolicy: e.target.value as 'deny' | 'allow' })}
                  >
                    <option value="deny">{tr("全部拒绝（只读，最安全）")}</option>
                    <option value="allow">{tr("允许普通写操作（高危仍然拒绝）")}</option>
                  </select>
                </div>

                <label className="agent-check">
                  <input
                    type="checkbox"
                    checked={rdraft.enabled}
                    onChange={(e) => setRdraft({ ...rdraft, enabled: e.target.checked })}
                  />
                  {tr("启用这个任务")}
                </label>

                {error && <div className="agent-error">{error}</div>}
                </div>

                <div className="agent-actions">
                  <button className="btn primary" disabled={busy} onClick={() => void saveRoutine()}>
                    {busy ? tr("保存中…") : tr("保存")}
                  </button>
                  <button className="btn" onClick={() => setRdraft(null)}>
                    {tr("取消")}
                  </button>
                  <span className="agent-spacer" />
                  {rdraft.id && (
                    <button
                      className="btn danger"
                      disabled={busy}
                      onClick={() => {
                        const id = rdraft.id
                        if (!id) return
                        void window.pico.routines
                          .remove(id)
                          .then(async () => {
                            setRdraft(null)
                            await reload()
                            notify(tr("任务已删除"))
                          })
                          .catch((err) => notify((err as Error).message, 'error'))
                      }}
                    >
                      {tr("删除任务")}
                    </button>
                  )}
                </div>
              </section>
            ) : (
              <>
                <div className="routine-list">
                  {routines.length === 0 && (
                    <div className="agent-empty">
                      <p>{tr("还没有定时任务。")}</p>
                      <p className="agent-empty-sub">
                        {tr("建一条之后，即使关掉软件它也会在下次启动时补算排期；软件开着的时候到点就干。")}
                      </p>
                    </div>
                  )}
                  {routines.map((r) => (
                    <div className="routine-item" key={r.id}>
                      <div className="routine-main">
                        <div className="routine-title">
                          {r.name}
                          <span className={`routine-badge ${r.enabled ? '' : 'off'}`}>
                            {r.enabled ? describeTrigger(r.trigger) : tr("已停用")}
                          </span>
                          {r.lastStatus && <span className={`routine-badge st-${r.lastStatus}`}>{STATUS_LABEL[r.lastStatus]}</span>}
                          {(r.consecutiveFails ?? 0) > 0 && (
                            <span className="routine-badge st-fail" title={r.lastError ?? ''}>
                              {tr("连续失败 {0} 次", { "0": r.consecutiveFails ?? 0 })}
                            </span>
                          )}
                        </div>
                        <div className="routine-sub">
                          {agentName(r.agentId)} · {tr("下次 {0}", { "0": whenText(r.nextRunAt) })}
                          {r.lastError ? ` · ${r.lastError.slice(0, 60)}` : ''}
                        </div>
                      </div>
                      <div className="routine-acts">
                        <button className="btn" onClick={() => runNow(r)}>
                          {tr("运行")}
                        </button>
                        <button
                          className="btn"
                          onClick={() =>
                            void window.pico.routines
                              .enable(r.id, !r.enabled)
                              .then(() => reload())
                              .catch((err) => notify((err as Error).message, 'error'))
                          }
                        >
                          {r.enabled ? tr("停用") : tr("启用")}
                        </button>
                        <button
                          className="btn"
                          onClick={() =>
                            setRdraft({
                              id: r.id,
                              name: r.name,
                              agentId: r.agentId,
                              prompt: r.prompt,
                              mode: r.trigger.kind === 'cron' ? 'daily' : 'interval',
                              hour: r.trigger.kind === 'cron' ? Number(r.trigger.expr.split(/\s+/)[1]) || 0 : 9,
                              minute: r.trigger.kind === 'cron' ? Number(r.trigger.expr.split(/\s+/)[0]) || 0 : 0,
                              minutes: r.trigger.kind === 'interval' ? r.trigger.minutes : 60,
                              approvalPolicy: r.approvalPolicy === 'allow' ? 'allow' : 'deny',
                              enabled: r.enabled
                            })
                          }
                        >
                          {tr("编辑")}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="routine-foot">
                  <button
                    className="btn primary"
                    onClick={() => {
                      setError(null)
                      setRdraft({
                        name: '',
                        agentId: agents[0]?.id ?? '',
                        prompt: '',
                        mode: 'daily',
                        hour: 9,
                        minute: 0,
                        minutes: 60,
                        approvalPolicy: 'deny',
                        enabled: true
                      })
                    }}
                  >
                    {tr("+ 新建任务")}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : tab === 'handoffs' ? (
          <div className="routine-view">
            <div className="routine-list">
              {handoffs.length === 0 && (
                <div className="agent-empty">
                  {tr("还没有交接")}
                  <div className="agent-empty-sub">
                    {tr("让 agent 自己判断该交给谁：巡检发现问题后，它会用 handoff 把活交给审查")}
                  </div>
                </div>
              )}
              {handoffs.map((h) => (
                <div key={h.id} className="routine-item">
                  <div className="routine-main">
                    <div className="routine-title">
                      <span>
                        {h.fromName || tr("普通会话")} → {h.toName || h.toAgentId}
                      </span>
                      <span className={`routine-badge st-${h.status === 'ok' ? 'ok' : h.status === 'fail' ? 'fail' : h.status === 'pending' ? 'skipped' : 'running'}`}>
                        {HANDOFF_LABEL[h.status] ?? h.status}
                      </span>
                      {h.approvalPolicy === 'allow' && (
                        <span className="routine-badge">{tr("可写")}</span>
                      )}
                    </div>
                    <div className="routine-sub" title={h.task}>
                      {h.task}
                    </div>
                    {h.error && (
                      <div className="routine-sub" style={{ color: 'var(--danger)' }}>
                        {h.error}
                      </div>
                    )}
                    {h.status === 'ok' && h.result?.summary && (
                      <div className="routine-sub handoff-result" title={h.result.summary}>
                        {h.result.summary}
                      </div>
                    )}
                    <div className="routine-sub">
                      {whenText(h.createdAt)}
                      {h.depth > 0 ? ` · ${tr("第 {0} 手", { "0": h.depth })}` : ''}
                      {h.result && h.result.tokens.prompt + h.result.tokens.completion > 0
                        ? ` · ${fmtTokens(h.result.tokens.prompt + h.result.tokens.completion)} token`
                        : ''}
                      {h.result?.files?.length ? ` · ${tr("动了 {0} 个文件", { "0": h.result.files.length })}` : ''}
                      {h.sessionId ? ` · ${h.sessionId.slice(0, 8)}` : ''}
                    </div>
                  </div>
                  <div className="routine-acts">
                    <button
                      className="btn"
                      disabled={h.status === 'running'}
                      onClick={() => void runHandoff(h)}
                    >
                      {tr("运行")}
                    </button>
                    {h.status === 'pending' && (
                      <button className="btn" onClick={() => void cancelHandoff(h)}>
                        {tr("取消")}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="routine-foot">
              <span className="agent-note">
                {tr("交接由 agent 自己发起：队列里一次只放一条，等当前任务跑完自动接手")}
              </span>
            </div>
          </div>
        ) : (
          <div className="routine-view">
            <div className="board-head">
              <span className="agent-note">
                {board && board.items > 0 ? tr("{0} 条便签", { "0": board.items }) : tr("现在还是空的")}
              </span>
              <span className="agent-spacer" />
              <button className="btn" disabled={busy || !board || board.items === 0} onClick={() => void clearBoardNow()}>
                {tr("清空")}
              </button>
            </div>
            <pre className="board-text">
              {board && board.items > 0
                ? board.text
                : tr("还没有便签。agent 碰到「跨会话还有效、但这摊活干完就该扔」的事，会用 board 工具写一条，比如「测试跑 npm run verify，别动 legacy/」。")}
            </pre>
            <div className="routine-foot">
              <span className="agent-note" title={board?.path ?? ''}>
                {tr("同一个工作区的所有档案共用这一页，每条会随系统提示注入；文件存在用户数据目录，不进代码库")}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
