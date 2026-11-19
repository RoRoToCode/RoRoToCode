import { t as tr } from '../i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SessionHit, SessionMeta } from '../../shared/types'

interface Props {
  sessions: SessionMeta[]
  currentId: string | null
  currentWorkspace: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  /** 删除整个工作区分组（会连带删除该分组下的所有会话） */
  onDeleteWorkspace: (workspace: string | null) => void
  onNewIn: (workspace: string | null) => void
  onNewWorkspace: () => void
  /** 打开技能面板 */
  onOpenSkills: () => void
  /**
   * 正在跑的那条会话（由主界面直接传进来）。
   * 侧栏自己的轮询是 5 秒一次，用户刚发出消息时还没轮到下一次，
   * 传这个值就能让机器人图标「立刻」亮起来，不必等轮询。
   */
  runningId?: string | null
  /** 侧栏底部版本号右侧的自定义操作区（语言切换、软件设置等） */
  footActions?: ReactNode
  /** 通知（打开工作区文件夹失败时用） */
  onNotify?: (message: string, kind?: 'info' | 'warn' | 'error') => void
}

interface Group {
  key: string
  workspace: string | null
  label: string
  full: string
  sessions: SessionMeta[]
  latest: number
}

const COLLAPSE_KEY = 'roroto.collapsedGroups'
/** 左侧整条侧栏的开合状态：和右侧成果面板一样记在 localStorage */
const SIDEBAR_OPEN_KEY = 'roroto.sidebarOpen'

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return tr("刚刚")
  if (min < 60) return tr("{min} 分钟前", { min: min })
  const hour = Math.floor(min / 60)
  if (hour < 24) return tr("{hour} 小时前", { hour: hour })
  const day = Math.floor(hour / 24)
  if (day < 30) return tr("{day} 天前", { day: day })
  return new Date(ts).toLocaleDateString('zh-CN')
}

function baseName(full: string): string {
  const parts = full.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || full
}

/**
 * 每个工作区一个固定颜色：同一个目录每次打开都是同一个色，
 * 一眼就能看出「这几条对话属于同一个工作区」。
 */
const WS_HUES = [210, 168, 275, 24, 336, 96, 190, 45]

function wsHue(key: string): number {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return WS_HUES[h % WS_HUES.length]
}

/** 线框机器人：14px 下还能认出是「一台机器」而不是一个圆点 */
function RobotIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.6" y="4.5" width="10.8" height="8.1" rx="2.4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 4.5V2.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="1.75" r="0.85" fill="currentColor" />
      <circle cx="5.9" cy="8.2" r="0.95" fill="currentColor" />
      <circle cx="10.1" cy="8.2" r="0.95" fill="currentColor" />
      <path d="M6.5 10.7h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

/** 工作区文件夹：展开态的分组头、收起态的窄条共用同一个图形 */
function FolderIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.6 4.3c0-.6.5-1.1 1.1-1.1h3l1.3 1.6h6.3c.6 0 1.1.5 1.1 1.1v5.8c0 .6-.5 1.1-1.1 1.1H2.7c-.6 0-1.1-.5-1.1-1.1V4.3Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function groupSessions(sessions: SessionMeta[], currentWorkspace: string | null): Group[] {
  const map = new Map<string, Group>()
  for (const s of sessions) {
    const ws = s.workspace ?? null
    const key = ws ?? '__none__'
    let group = map.get(key)
    if (!group) {
      group = {
        key,
        workspace: ws,
        label: ws ? baseName(ws) : tr("未指定工作区"),
        full: ws ?? tr("这些会话还没有绑定目录"),
        sessions: [],
        latest: 0
      }
      map.set(key, group)
    }
    group.sessions.push(s)
    group.latest = Math.max(group.latest, s.updatedAt)
  }

  const groups = Array.from(map.values())
  /**
   * 组内排序：先把「分叉出来的会话」挂到父会话后面，再按时间排。
   *
   * 不搞真正的缩进树：会话可能分叉多次、父会话还可能被删。
   * 只做一层「跟着父走」，视觉上能看出血缘，列表也不会退化成难读的森林。
   */
  for (const g of groups) {
    const byId = new Map(g.sessions.map((s) => [s.id, s]))
    const children = new Map<string, SessionMeta[]>()
    for (const s of g.sessions) {
      if (s.forkedFrom && byId.has(s.forkedFrom)) {
        const list = children.get(s.forkedFrom) ?? []
        list.push(s)
        children.set(s.forkedFrom, list)
      }
    }
    const seen = new Set<string>()
    const ordered: SessionMeta[] = []
    const push = (s: SessionMeta) => {
      if (seen.has(s.id)) return
      seen.add(s.id)
      ordered.push(s)
      for (const child of (children.get(s.id) ?? []).sort((a, b) => b.updatedAt - a.updatedAt)) push(child)
    }
    // 父会话优先：被分叉的那条排在自己分支前面
    const roots = g.sessions
      .filter((s) => !s.forkedFrom || !byId.has(s.forkedFrom))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    for (const r of roots) push(r)
    for (const s of g.sessions) push(s)
    g.sessions = ordered
  }

  groups.sort((a, b) => {
    if (a.workspace && a.workspace === currentWorkspace) return -1
    if (b.workspace && b.workspace === currentWorkspace) return 1
    if (!a.workspace) return 1
    if (!b.workspace) return -1
    return b.latest - a.latest
  })
  return groups
}

/** 没手动折叠过就默认展开，别把老用户的布局悄悄改掉 */
function readSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY)
    if (!raw) return new Set()
    const list = JSON.parse(raw) as unknown
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function Sidebar({
  sessions,
  currentId,
  currentWorkspace,
  onSelect,
  onDelete,
  onDeleteWorkspace,
  onNewIn,
  onNewWorkspace,
  onOpenSkills,
  runningId = null,
  footActions,
  onNotify
}: Props) {
  const groups = groupSessions(sessions, currentWorkspace)
  /** 左侧整条侧栏是否展开；收起后只留一条竖排文件夹的窄边 */
  const [open, setOpen] = useState<boolean>(readSidebarOpen)
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)
  // 会话搜索：标题和正文一起搜，输入 250ms 后才查，避免每敲一个字就读全部文件
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SessionHit[]>([])
  const [searching, setSearching] = useState(false)
  // 版本号跟着 package.json 走，避免写死后和实际发布的版本对不上
  const [version, setVersion] = useState('')
  /** 哪条会话在跑（key 是 sessionId）：列表里给那条加个机器人，一眼看出谁在干活 */
  const [liveSessions, setLiveSessions] = useState<Map<string, 'running' | 'queued'>>(new Map())
  /** 哪些会话此刻有子 agent 在跑：这些会话在绿色主机器人旁再挂一枚紫色机器人 */
  const [subAgentSessions, setSubAgentSessions] = useState<Set<string>>(new Set())
  const timer = useRef<number | null>(null)
  /** 工作区右键菜单：记录点的是哪个分组 + 鼠标屏幕坐标 */
  const [wsMenu, setWsMenu] = useState<{
    group: Group
    x: number
    y: number
  } | null>(null)
  const wsMenuRef = useRef<HTMLDivElement | null>(null)

  // 右键菜单：点菜单外、按 Esc、滚动或窗口变化时关掉
  useEffect(() => {
    if (!wsMenu) return
    const onDown = (e: MouseEvent) => {
      if (wsMenuRef.current?.contains(e.target as Node)) return
      setWsMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWsMenu(null)
    }
    const close = () => setWsMenu(null)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('contextmenu', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('contextmenu', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [wsMenu])

  /** 打开工作区文件夹：用系统文件管理器打开这个工作区目录 */
  const openWorkspaceFolder = useCallback(
    async (ws: string | null) => {
      if (!ws) return
      try {
        const r = await window.pico.shell.openPath(ws)
        if (!r.ok) onNotify?.(tr("打不开文件夹 {0}：{1}", { "0": baseName(ws), "1": r.message ?? tr("路径可能已不存在") }), 'error')
      } catch (err) {
        onNotify?.(tr("打不开文件夹 {0}：{1}", { "0": baseName(ws), "1": (err as Error).message }), 'error')
      }
    },
    [onNotify]
  )

  useEffect(() => {
    let alive = true
    void window.pico.app
      .info()
      .then((i) => {
        if (alive) setVersion(i.version)
      })
      .catch(() => undefined)
    // 状态以轮询为准：引擎里就是一个 Map，5 秒问一次比铺一条事件通道划算，
    // 而且定时任务是后台跑的，界面没收到事件也必须能亮灯。
    // 只有「子 agent 启停」额外借事件触发一次即时复查（见下面的 off）。
    const tick = (): void => {
      void window.pico.agents
        .running()
        .then((runs) => {
          if (!alive) return
          const nextSessions = new Map<string, 'running' | 'queued'>()
          const nextSub = new Set<string>()
          for (const r of runs) {
            // 会话维度：不看 agentId，用户自己发的对话也要亮机器人
            if (!r.sessionId) continue
            const st: 'running' | 'queued' = r.state === 'queued' ? 'queued' : 'running'
            // 同一条会话既有在跑的又有排队的（少见）：绿灯优先，排队不能把它压暗
            if (!(st === 'queued' && nextSessions.get(r.sessionId) === 'running')) {
              nextSessions.set(r.sessionId, st)
            }
            // 子 agent 借父会话的锁跑，引擎把它记在同一条 run 上
            if ((r.subagents ?? 0) > 0) nextSub.add(r.sessionId)
          }
          setLiveSessions(nextSessions)
          setSubAgentSessions(nextSub)
        })
        .catch(() => undefined)
    }
    tick()
    const poll = window.setInterval(tick, 5000)
    // 子 agent 常常只跑几秒，干等下一次轮询会看不见。启停事件一到就补一次查询：
    // 引擎那边是先改计数再发事件，所以查到的肯定是最新状态。
    const off = window.pico.onEvent(({ event }) => {
      if (event.type === 'subagent_start' || event.type === 'subagent_end') tick()
    })
    return () => {
      alive = false
      window.clearInterval(poll)
      off()
    }
  }, [])

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current)
    const query = q.trim()
    if (!query) {
      setHits([])
      setSearching(false)
      return
    }
    setSearching(true)
    timer.current = window.setTimeout(() => {
      void window.pico.sessions
        .search(query)
        .then((list) => setHits(list))
        .catch(() => setHits([]))
        .finally(() => setSearching(false))
    }, 250)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [q])

  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      try {
        localStorage.setItem(SIDEBAR_OPEN_KEY, prev ? '0' : '1')
      } catch {
        // 存不下就只在本次运行内生效
      }
      return !prev
    })
  }, [])

  /** 一条会话的运行状态：主界面直接传的 runningId 立刻亮，其余靠 5 秒轮询兜底 */
  const liveOf = (id: string): 'running' | 'queued' | undefined =>
    id === runningId ? 'running' : liveSessions.get(id)

  /**
   * 把组里会话的运行状态汇总到文件夹上。
   * 分组折叠 / 整条侧栏收起时看不到会话行，机器人就闪在文件夹上；绿灯优先于排队。
   */
  const liveOfGroup = (g: Group): 'running' | 'queued' | undefined => {
    let queued = false
    for (const s of g.sessions) {
      const st = liveOf(s.id)
      if (st === 'running') return 'running'
      if (st === 'queued') queued = true
    }
    return queued ? 'queued' : undefined
  }

  /** 组里有没有子 agent 在跑：分组折叠 / 侧栏收起时也要把第二枚机器人带出来 */
  const subOfGroup = (g: Group): boolean => g.sessions.some((s) => subAgentSessions.has(s.id))

  /** 窄条放不下所有工作区时，优先摆「有会话在跑」的组，别把闪烁机器人挤没了 */
  const railGroups = groups.length <= 6
    ? groups
    : [...groups.filter((g) => liveOfGroup(g)), ...groups.filter((g) => !liveOfGroup(g))].slice(0, 6)

  const toggle = useCallback((key: string) => {    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]))
      } catch {
        // 存不下就只在本次会话内生效
      }
      return next
    })
  }, [])

  return (
    <aside className={`sidebar ${open ? '' : 'collapsed'}`}>
      <div className="brand">
        <span className="brand-dot" />
        <span className="brand-name">
          R<span className="brand-o o1">o</span>R<span className="brand-o o2">o</span>T
          <span className="brand-o o3">o</span> Code
        </span>
      </div>

      <button className="skill-btn" onClick={onOpenSkills} title={tr("打开技能面板：用本地技能，或从 GitHub 拉取常用技能")}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 1.8 9.7 6l4.2 1.7-4.2 1.7L8 13.6 6.3 9.4 2.1 7.7 6.3 6 8 1.8Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
        {tr("添加技能")}</button>

      <div className="session-search">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.4" />
          <path d="m10.4 10.4 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <input
          id="session-search"
          value={q}
          placeholder={tr("搜索会话")}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQ('')
          }}
        />
        {q && (
          <button className="search-clear" onClick={() => setQ('')} title={tr("清空")}>
            ×
          </button>
        )}
      </div>

      <div className="session-list">
        {q.trim() ? (
          <div className="search-results">
            {searching && hits.length === 0 && <div className="ws-empty">{tr("正在搜索…")}</div>}
            {!searching && hits.length === 0 && <div className="ws-empty">{tr("没有匹配的会话")}</div>}
            {hits.map((h) => (
              <button
                key={h.id}
                className={`search-hit ${h.id === currentId ? 'active' : ''}`}
                onClick={() => onSelect(h.id)}
                title={h.snippet}
              >
                <span className="search-hit-title">{h.title}</span>
                <span className="search-hit-snippet">{h.snippet}</span>
                <span className="search-hit-meta">
                  {h.hits} {tr("处命中 ·")}{timeAgo(h.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <>
        {groups.length === 0 && <div className="ws-empty">{tr("还没有会话")}</div>}

        {groups.map((g) => {
          const active = (g.workspace ?? null) === (currentWorkspace ?? null)
          const isCollapsed = collapsed.has(g.key)
          // 分组收起后会话行看不见了，机器人改挂在文件夹图标上闪
          const groupLive = isCollapsed ? liveOfGroup(g) : undefined
          return (
            <div className="ws-group" key={g.key} style={{ '--ws-hue': wsHue(g.key) } as CSSProperties}>
              <div
                className={`ws-group-head ${active ? 'active' : ''}`}
                title={tr("{full}\n点击{1}", { full: g.full, "1": isCollapsed ? tr("展开") : tr("折叠") })}
                onClick={() => toggle(g.key)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  // 菜单 portal 到 body：按视窗边界收一下，靠右/靠下时不会被裁出屏幕
                  const PAD = 8
                  const EST_W = 168
                  const EST_H = 158
                  setWsMenu({
                    group: g,
                    x: Math.max(PAD, Math.min(e.clientX, window.innerWidth - EST_W - PAD)),
                    y: Math.max(PAD, Math.min(e.clientY, window.innerHeight - EST_H - PAD))
                  })
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    toggle(g.key)
                  }
                }}
              >
                <span className={`ws-chevron ${isCollapsed ? 'collapsed' : ''}`}>
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M4 6.5 8 10.5l4-4"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <span className={`ws-icon ${groupLive ? 'has-live' : ''}`}>
                  <FolderIcon />
                  {groupLive && (
                    <span
                      className={`ws-live-badge ${groupLive} ${subOfGroup(g) ? 'has-sub' : ''}`}
                      title={groupLive === 'running' ? tr("这个工作区有会话正在工作") : tr("这个工作区有会话在排队")}
                      aria-label={groupLive === 'running' ? tr("正在工作") : tr("排队中")}
                    >
                      <RobotIcon />
                    </span>
                  )}
                  {groupLive && subOfGroup(g) && (
                    <span
                      className="ws-sub-badge"
                      title={tr("这个工作区有子 agent 在工作")}
                      aria-label={tr("子 agent 正在工作")}
                    >
                      <RobotIcon />
                    </span>
                  )}
                </span>
                <span className="ws-group-name">{g.label}</span>
                <span className="ws-group-count">{g.sessions.length}</span>
                <div className="ws-actions">
                  {g.workspace && (
                    <button
                      className="ws-add"
                      title={tr("在 {label} 新建会话", { label: g.label })}
                      onClick={(e) => {
                        e.stopPropagation()
                        onNewIn(g.workspace)
                      }}
                    >
                      +
                    </button>
                  )}
                  <button
                    className="ws-del"
                    title={tr("删除「{label}」下的 {length} 个会话", { label: g.label, length: g.sessions.length })}
                    aria-label={tr("删除工作区 {label}", { label: g.label })}
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteWorkspace(g.workspace)
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>

              {!isCollapsed && (
                <div className="ws-sessions">
                  {g.sessions.map((s) => {
                    // 正在跑：机器人图标 + 闪烁；排队：同一个机器人，换琥珀色且不闪
                    const live = liveOf(s.id)
                    return (
                      <div
                        key={s.id}
                        className={`session-item ${s.id === currentId ? 'active' : ''} ${s.forkedFrom ? 'forked' : ''} ${live ? 'busy' : ''}`}
                        onClick={() => onSelect(s.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') onSelect(s.id)
                        }}
                      >
                        {live && (
                          <span
                            className={`session-live ${live}`}
                            title={
                              live === 'running'
                                ? tr("这条会话正在工作")
                                : tr("这条会话在排队等模型")
                            }
                            aria-label={live === 'running' ? tr("正在工作") : tr("排队中")}
                          >
                            <RobotIcon />
                          </span>
                        )}
                        {/* 主 agent 的绿色机器人照旧，子 agent 在旁边再挂一枚紫色的。
                            类名别用 subagent：那会撞上聊天区子 agent 卡片的样式，给图标套个大框 */}
                        {live && subAgentSessions.has(s.id) && (
                          <span
                            className="session-live is-sub"
                            title={tr("这条会话有子 agent 在独立工作")}
                            aria-label={tr("子 agent 正在工作")}
                          >
                            <RobotIcon />
                          </span>
                        )}
                        {s.forkedFrom && (
                          <span
                            className="session-fork"
                            title={tr("从另一个会话分叉出来")}
                            aria-label={tr("分叉")}
                          >
                            ⑂
                          </span>
                        )}
                        <span className="session-title">{s.title}</span>
                        <span className="session-time">{timeAgo(s.updatedAt)}</span>
                        <button
                          className="session-del"
                          title={tr("删除会话")}
                          onClick={(e) => {
                            e.stopPropagation()
                            onDelete(s.id)
                          }}
                        >
                          ×
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
          </>
        )}
      </div>

      <div className="sidebar-foot">
        <div className="sidebar-new-row">
          <button
            className="new-btn"
            onClick={() => onNewIn(currentWorkspace)}
            title={tr("在当前工作区下新建会话")}
            aria-label={tr("在当前工作区下新建会话")}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className="new-ws-btn"
            onClick={onNewWorkspace}
            title={tr("选择一个新目录，并在其中开始会话")}
            aria-label={tr("选择一个新目录，并在其中开始会话")}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M1.6 4.3c0-.6.5-1.1 1.1-1.1h3l1.3 1.6h6.3c.6 0 1.1.5 1.1 1.1v5.8c0 .6-.5 1.1-1.1 1.1H2.7c-.6 0-1.1-.5-1.1-1.1V4.3Z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
              <path d="M8 7v3.2M6.4 8.6h3.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="foot-meta">
          <span>{tr("本地模型 · 线上 API")}</span>
          <span className="foot-meta-right">
            <span>{version ? `v${version}` : ''}</span>
            {footActions}
          </span>
        </div>
      </div>

      {/* 展开态：折叠把手贴在侧栏右缘、垂直居中，尺寸和右侧「成果文件」那条把手一样，
          不再挤在 RoRoToCode 旁边当一个小方块 */}
      <button
        className="sidebar-handle"
        onClick={toggleOpen}
        aria-expanded={true}
        aria-label={tr("收起左侧面板")}
        title={tr("收起左侧面板")}
      >
        <span className="sidebar-chev to-left">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M4 6.5 8 10.5l4-4"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      {/* 收起态：整条窄边就是「展开」按钮。按工作区竖排文件夹，
          哪一组有会话在跑，机器人就叠在那个文件夹上闪。 */}
      <button
        className="sidebar-rail"
        onClick={toggleOpen}
        aria-expanded={false}
        aria-label={tr("展开左侧面板")}
        title={tr("展开左侧面板 · 工作目录 / 会话 / 新建对话")}
      >
        <span className="rail-top"><span className="brand-dot" /></span>
        <span className="sidebar-chev to-right">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M4 6.5 8 10.5l4-4"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="rail-folders">
          {groups.length === 0 && (
            <span className="rail-folder"><FolderIcon size={16} /></span>
          )}
          {railGroups.map((g) => {
            const live = liveOfGroup(g)
            return (
              <span
                key={g.key}
                className={`rail-folder ${live ? 'is-live' : ''}`}
                style={{ '--ws-hue': wsHue(g.key) } as CSSProperties}
                title={`${g.full}${live === 'running' ? `\n${tr("这个工作区有会话正在工作")}` : live === 'queued' ? `\n${tr("这个工作区有会话在排队")}` : ''}`}
              >
                <FolderIcon size={16} />
                {live && <span className={`rail-robot ${live} ${subOfGroup(g) ? 'has-sub' : ''}`}><RobotIcon /></span>}
                {live && subOfGroup(g) && (
                  <span className="rail-sub" aria-label={tr("子 agent 正在工作")}><RobotIcon /></span>
                )}
              </span>
            )
          })}
          {groups.length > 6 && <span className="rail-more">+{groups.length - 6}</span>}
        </span>
        <span className="rail-title-v">{tr("会话列表")}</span>
      </button>

      {wsMenu &&
        createPortal(
          <div
            className="ws-ctx-menu"
            ref={wsMenuRef}
            style={{ left: wsMenu.x, top: wsMenu.y }}
            role="menu"
            onContextMenu={(e) => e.preventDefault()}
          >
            <div className="ws-ctx-title" title={wsMenu.group.full}>{wsMenu.group.label}</div>
            <button
              type="button"
              role="menuitem"
              className="ws-ctx-item"
              disabled={!wsMenu.group.workspace}
              onClick={() => {
                void openWorkspaceFolder(wsMenu.group.workspace)
                setWsMenu(null)
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2 4.2h4l1.3 1.6H14v6.2H2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
              </svg>
              <span>{tr("打开文件夹")}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="ws-ctx-item"
              onClick={() => {
                onNewIn(wsMenu.group.workspace)
                setWsMenu(null)
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              <span>{tr("新建对话")}</span>
            </button>
            <div className="ws-ctx-sep" />
            <button
              type="button"
              role="menuitem"
              className="ws-ctx-item danger"
              onClick={() => {
                onDeleteWorkspace(wsMenu.group.workspace)
                setWsMenu(null)
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3.5 5h9M6 5V3.5h4V5M4.5 5l.6 8h5.8l.6-8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>{tr("删除工作区")}</span>
            </button>
          </div>,
          document.body
        )}
    </aside>
  )
}
