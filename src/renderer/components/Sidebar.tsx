import { t as tr } from '../i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
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
  runningId = null
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
  const timer = useRef<number | null>(null)

  useEffect(() => {
    let alive = true
    void window.pico.app
      .info()
      .then((i) => {
        if (alive) setVersion(i.version)
      })
      .catch(() => undefined)
    // 轮询而不是订阅：引擎里就是一个 Map，5 秒问一次比铺一条事件通道划算，
    // 而且定时任务是后台跑的，界面没收到事件也必须能亮灯
    const tick = (): void => {
      void window.pico.agents
        .running()
        .then((runs) => {
          if (!alive) return
          const nextSessions = new Map<string, 'running' | 'queued'>()
          for (const r of runs) {
            // 会话维度：不看 agentId，用户自己发的对话也要亮机器人
            if (!r.sessionId) continue
            const st: 'running' | 'queued' = r.state === 'queued' ? 'queued' : 'running'
            // 同一条会话既有在跑的又有排队的（少见）：绿灯优先，排队不能把它压暗
            if (!(st === 'queued' && nextSessions.get(r.sessionId) === 'running')) {
              nextSessions.set(r.sessionId, st)
            }
          }
          setLiveSessions(nextSessions)
        })
        .catch(() => undefined)
    }
    tick()
    const poll = window.setInterval(tick, 5000)
    return () => {
      alive = false
      window.clearInterval(poll)
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
                      className={`ws-live-badge ${groupLive}`}
                      title={groupLive === 'running' ? tr("这个工作区有会话正在工作") : tr("这个工作区有会话在排队")}
                      aria-label={groupLive === 'running' ? tr("正在工作") : tr("排队中")}
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
        <button
          className="new-btn"
          onClick={() => onNewIn(currentWorkspace)}
          title={tr("在当前工作区下新建会话")}
        >
          {tr("+ 新建对话")}</button>
        <button className="new-ws-btn" onClick={onNewWorkspace} title={tr("选择一个新目录，并在其中开始会话")}>
          {tr("+ 新的工作区")}</button>

        <div className="foot-meta">
          <span>{tr("本地模型 · 线上 API")}</span>
          <span>{version ? `v${version}` : ''}</span>
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
                {live && <span className={`rail-robot ${live}`}><RobotIcon /></span>}
              </span>
            )
          })}
          {groups.length > 6 && <span className="rail-more">+{groups.length - 6}</span>}
        </span>
        <span className="rail-title-v">{tr("会话列表")}</span>
      </button>
    </aside>
  )
}
