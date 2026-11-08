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
  for (const g of groups) g.sessions.sort((a, b) => b.updatedAt - a.updatedAt)

  groups.sort((a, b) => {
    if (a.workspace && a.workspace === currentWorkspace) return -1
    if (b.workspace && b.workspace === currentWorkspace) return 1
    if (!a.workspace) return 1
    if (!b.workspace) return -1
    return b.latest - a.latest
  })
  return groups
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
  onOpenSkills
}: Props) {
  const groups = groupSessions(sessions, currentWorkspace)
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)
  // 会话搜索：标题和正文一起搜，输入 250ms 后才查，避免每敲一个字就读全部文件
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SessionHit[]>([])
  const [searching, setSearching] = useState(false)
  // 版本号跟着 package.json 走，避免写死后和实际发布的版本对不上
  const [version, setVersion] = useState('')
  const timer = useRef<number | null>(null)

  useEffect(() => {
    let alive = true
    void window.pico.app
      .info()
      .then((i) => {
        if (alive) setVersion(i.version)
      })
      .catch(() => undefined)
    return () => {
      alive = false
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

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
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
    <aside className="sidebar">
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
                <span className="ws-icon">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M1.6 4.3c0-.6.5-1.1 1.1-1.1h3l1.3 1.6h6.3c.6 0 1.1.5 1.1 1.1v5.8c0 .6-.5 1.1-1.1 1.1H2.7c-.6 0-1.1-.5-1.1-1.1V4.3Z"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinejoin="round"
                    />
                  </svg>
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
                  {g.sessions.map((s) => (
                    <div
                      key={s.id}
                      className={`session-item ${s.id === currentId ? 'active' : ''}`}
                      onClick={() => onSelect(s.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') onSelect(s.id)
                      }}
                    >
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
                  ))}
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
    </aside>
  )
}
