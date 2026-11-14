import { t as tr } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../shared/types'
import {
  baseName,
  isNoisePath,
  isResultFile,
  type ResultFile
} from '../../shared/resultfiles'
import { ChangesPanel } from './ChangesPanel'
import { GitPanel } from './GitPanel'
import { TerminalPanel } from './TerminalPanel'

/**
 * 「成果」和「过程」要分开：用户要能直接拿走的文档、表格、图片、压缩包，
 * agent 顺手写的脚本是中间产物。判定规则放在 shared/resultfiles.ts，
 * 主进程扫盘（run_shell / 技能生成的文件）和这个面板共用同一份，不会各判各的。
 */
export type OutputFile = ResultFile

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'patch'])
const OPEN_KEY = 'roroto.outputOpen'
const TAB_KEY = 'roroto.outputTab'

type Tab = 'files' | 'changes' | 'git' | 'terminal'

/**
 * 一次工具调用写到的文件。
 * write_file / edit_file 只有单个 path；patch 是多文件工具，要展开 edits 数组，
 * 删除操作不算产出。patch 的 unified-diff 文本形态不解析 —— 那种输入很少见，
 * 硬解析反而容易把 +++ 行号当成路径。
 */
function writtenFiles(m: ChatMessage): Array<{ path: string; created: boolean }> {
  if (m.toolName === 'patch') {
    const edits = m.toolArgs?.edits
    if (!Array.isArray(edits)) return []
    const out: Array<{ path: string; created: boolean }> = []
    for (const e of edits) {
      if (!e || typeof e !== 'object') continue
      const row = e as { path?: unknown; op?: unknown; new_path?: unknown }
      if (row.op === 'delete') continue
      if (typeof row.path === 'string' && row.path.trim()) {
        out.push({ path: row.path.trim(), created: row.op === 'create' })
      }
      if (row.op === 'move' && typeof row.new_path === 'string' && row.new_path.trim()) {
        out.push({ path: row.new_path.trim(), created: false })
      }
    }
    return out
  }
  const raw = m.toolArgs?.path
  if (typeof raw !== 'string' || !raw.trim()) return []
  return [{ path: raw.trim(), created: m.toolName === 'write_file' }]
}

/** 从会话消息里挑出「产出过的东西」：write_file 记新建，edit_file / patch 记修改，同一路径合并 */
export function collectOutputs(messages: ChatMessage[]): OutputFile[] {
  const map = new Map<string, OutputFile>()
  for (const m of messages) {
    if (m.role !== 'tool' || !m.toolName || !WRITE_TOOLS.has(m.toolName)) continue
    // 写失败时不记进成果（agent 的错误结果是「执行失败：…」）
    if (m.content && /^(执行失败|失败|错误|error)/i.test(m.content.trim())) continue

    for (const f of writtenFiles(m)) {
      const prev = map.get(f.path)
      map.set(f.path, {
        path: f.path,
        // 本次会话里新建过就标「新建」，后面再改也不改标签，否则会看不出哪个文件是新加的
        action: prev?.action === 'created' || f.created ? 'created' : 'edited',
        at: Math.max(prev?.at ?? 0, m.createdAt),
        writes: (prev?.writes ?? 0) + 1
      })
    }
  }
  return filterOutputs([...map.values()])
}

/**
 * 成果区的最终名单。
 * - 临时文件先剔掉（tmp_netdisk.py、~$报告.docx、node_modules 里的东西）
 * - 再只留成果类扩展名，脚本一律不进
 * - 纯编码的会话里成果类文件一个都没有，这时退回显示全部（临时文件仍排除），
 *   否则面板永远空着，用户会以为 agent 根本没干活
 */
export function filterOutputs(items: OutputFile[]): OutputFile[] {
  const sorted = [...items].sort((a, b) => b.at - a.at)
  const clean = sorted.filter((f) => !isNoisePath(f.path))
  const results = clean.filter((f) => isResultFile(f.path))
  return results.length ? results : clean
}

function dirOf(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 1) return ''
  const dir = parts.slice(0, -1).join('\\')
  return dir.length > 46 ? `…\\${parts.slice(-2, -1).join('\\')}` : dir
}

function resolvePath(p: string, workspace: string | null): string {
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')) return p
  if (!workspace) return p
  return `${workspace.replace(/[\\/]+$/, '')}\\${p.replace(/^[\\/]+/, '')}`
}

function readOpen(): boolean | null {
  try {
    const raw = localStorage.getItem(OPEN_KEY)
    return raw === null ? null : raw === '1'
  } catch {
    return null
  }
}

function readTab(): Tab {
  try {
    const raw = localStorage.getItem(TAB_KEY)
    return raw === 'changes' || raw === 'git' || raw === 'terminal' ? raw : 'files'
  } catch {
    return 'files'
  }
}

interface Props {
  files: OutputFile[]
  workspace: string | null
  sessionId: string | null
  /** 变更条数（由 App 通过事件维护，用来在标签上显示角标） */
  changeCount: number
  /** 每次收到 file_change 递增，触发变更面板重新拉取 */
  changesKey: number
  onNotify: (message: string, kind?: 'info' | 'warn' | 'error') => void
  onReverted?: () => void
}

export function OutputPanel({
  files,
  workspace,
  sessionId,
  changeCount,
  changesKey,
  onNotify,
  onReverted
}: Props) {
  const [open, setOpen] = useState<boolean>(() => readOpen() ?? false)
  const [tab, setTab] = useState<Tab>(readTab)
  // 用户手动开合过就尊重记忆，否则有内容时自动展开一次
  const touched = useRef<boolean>(readOpen() !== null)

  useEffect(() => {
    if (!touched.current && (files.length > 0 || changeCount > 0)) setOpen(true)
  }, [files.length, changeCount])

  const toggle = () => {
    touched.current = true
    setOpen((prev) => {
      try {
        localStorage.setItem(OPEN_KEY, prev ? '0' : '1')
      } catch {
        // 存不下就只在本次运行内生效
      }
      return !prev
    })
  }

  const pick = (next: Tab) => {
    setTab(next)
    setOpen(true)
    try {
      localStorage.setItem(TAB_KEY, next)
    } catch {
      // 忽略
    }
  }

  async function openFile(p: string) {
    const target = resolvePath(p, workspace)
    try {
      const r = await window.pico.shell.openPath(target)
      if (!r.ok) onNotify(tr("打不开 {0}：{1}", { "0": baseName(target), "1": r.message ?? tr("路径可能已不存在") }), 'error')
    } catch (err) {
      onNotify(tr("打不开 {0}：{1}", { "0": baseName(target), "1": (err as Error).message }), 'error')
    }
  }

  function revealFile(p: string) {
    window.pico.shell.showItemInFolder(resolvePath(p, workspace))
  }

  const label: Record<Tab, string> = {
    files: tr('成果文件'),
    changes: tr('变更'),
    git: 'Git',
    terminal: tr('终端')
  }
  const badge = tab === 'files' ? files.length : tab === 'changes' ? changeCount : 0

  return (
    <aside className={`output-side ${open ? '' : 'collapsed'} ${open && tab !== 'files' ? 'wide' : ''}`}>
      {/* 顶部只显示标题：它和标题栏的「关闭 ×」并排，不能再当折叠热区 */}
      <div className="output-titlebar">
        {open && (
          <>
            <span className="output-title">{label[tab]}</span>
            {badge > 0 && <span className="output-count has">{badge}</span>}
          </>
        )}
      </div>

      {/* 折叠按钮下移到面板垂直中间，远离右上角的窗口按钮 */}
      <button
        className="output-toggle"
        onClick={toggle}
        aria-expanded={open}
        aria-label={open ? tr("收起右侧面板") : tr("展开右侧面板")}
        title={open ? tr("收起右侧面板") : tr("展开右侧面板")}
      >
        <span className={`output-chev ${open ? 'to-right' : 'to-left'}`}>
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
        {!open && (
          <>
            {badge > 0 && <span className="output-count has">{badge}</span>}
            <span className="output-title-v">{label[tab]}</span>
          </>
        )}
      </button>

      {open && (
        <div className="output-body">
          <div className="side-tabs">
            <button className={`side-tab ${tab === 'files' ? 'on' : ''}`} onClick={() => pick('files')}>
              {tr("成果")}{files.length ? ` ${files.length}` : ''}
            </button>
            <button className={`side-tab ${tab === 'changes' ? 'on' : ''}`} onClick={() => pick('changes')}>
              {tr("变更")}{changeCount ? ` ${changeCount}` : ''}
            </button>
            <button className={`side-tab ${tab === 'git' ? 'on' : ''}`} onClick={() => pick('git')}>
              Git
            </button>
            <button className={`side-tab ${tab === 'terminal' ? 'on' : ''}`} onClick={() => pick('terminal')}>
              {tr('终端')}
            </button>
          </div>

          {tab === 'files' && (
            <>
              <div className="output-sub">
                {files.length ? tr("本次会话产出的成果，点名字直接打开") : tr("本次会话还没有产出成果文件")}
              </div>
              {files.length === 0 ? (
                <div className="output-empty">
                  {tr("助手写过的文件会列在这里，点文件名打开，点「目录」定位。")}</div>
              ) : (
                <div className="output-list">
                  {files.map((f) => (
                    <div className="output-row" key={f.path}>
                      <button className="output-open" onClick={() => void openFile(f.path)} title={f.path}>
                        <span className="output-name">{baseName(f.path)}</span>
                        {dirOf(f.path) && <span className="output-dir">{dirOf(f.path)}</span>}
                      </button>
                      <div className="output-meta">
                        <span className={`output-badge ${f.action}`}>
                          {f.action === 'created' ? tr("新建") : tr("修改")}
                        </span>
                        {f.writes > 1 && <span className="output-writes">×{f.writes}</span>}
                        <button
                          className="output-act"
                          onClick={() => revealFile(f.path)}
                          title={tr("在资源管理器中显示")}
                        >
                          {tr("目录")}</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {tab === 'changes' && (
            <ChangesPanel
              sessionId={sessionId}
              refreshKey={changesKey}
              onNotify={onNotify}
              onReverted={onReverted}
            />
          )}

          {tab === 'git' && <GitPanel workspace={workspace} active={tab === 'git'} onNotify={onNotify} />}

          {tab === 'terminal' && (
            <TerminalPanel workspace={workspace} active={tab === 'terminal'} onNotify={onNotify} />
          )}
        </div>
      )}
    </aside>
  )
}
