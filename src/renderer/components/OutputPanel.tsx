import { t as tr } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../shared/types'
import {
  baseName,
  finalResultFiles,
  keepFinalWrites,
  type ResultFile
} from '../../shared/resultfiles'

/**
 * 「成果」和「过程」要分开：用户要能直接拿走的文档、表格、图片、压缩包，
 * agent 顺手写的脚本是中间产物。判定规则放在 shared/resultfiles.ts，
 * 主进程扫盘（run_shell / 技能生成的文件）和这个面板共用同一份，不会各判各的。
 */
export type OutputFile = ResultFile

const OPEN_KEY = 'roroto.outputOpen'

/**
 * 成果区只收「本次新建成功、且是最终版」的文件：
 * - 只认 write_file —— edit_file / patch 改的是已有文件，属于「修改的」，不算交付物；
 * - 同一路径写多次只留最后一次成功的，中间那几版是半成品，不进名单；
 * - 写失败的结果直接跳过，不让坏文件混进成果。
 */
export function collectOutputs(messages: ChatMessage[]): OutputFile[] {
  const writes: OutputFile[] = []
  for (const m of messages) {
    if (m.role !== 'tool' || m.toolName !== 'write_file') continue
    if (m.content && /^(执行失败|失败|错误|error)/i.test(m.content.trim())) continue
    const raw = m.toolArgs?.path
    if (typeof raw !== 'string' || !raw.trim()) continue
    writes.push({ path: raw.trim(), action: 'created', at: m.createdAt, writes: 1 })
  }
  return filterOutputs(keepFinalWrites(writes))
}

/**
 * 成果区的最终名单。
 * 严格只留成果类扩展名（脚本、临时文件一律不进），且刻意不做
 * 「没有成果就退回显示全部」的兜底 —— 那正是半成品 / 中间脚本
 * 混进成果区、让人误以为也是交付物的原因。
 */
export function filterOutputs(items: OutputFile[]): OutputFile[] {
  return finalResultFiles(items)
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

interface Props {
  files: OutputFile[]
  workspace: string | null
  onNotify: (message: string, kind?: 'info' | 'warn' | 'error') => void
}

export function OutputPanel({ files, workspace, onNotify }: Props) {
  const [open, setOpen] = useState<boolean>(() => readOpen() ?? false)
  // 用户手动开合过就尊重记忆，否则有成果时自动展开一次
  const touched = useRef<boolean>(readOpen() !== null)

  useEffect(() => {
    if (!touched.current && files.length > 0) setOpen(true)
  }, [files.length])

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

  const count = files.length

  return (
    <aside className={`output-side ${open ? '' : 'collapsed'}`}>
      {/* 顶部只显示标题：它和标题栏的「关闭 ×」并排，不能再当折叠热区 */}
      <div className="output-titlebar">
        {open && (
          <>
            <span className="output-title">{tr("成果文件")}</span>
            {count > 0 && <span className="output-count has">{count}</span>}
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
            {count > 0 && <span className="output-count has">{count}</span>}
            <span className="output-title-v">{tr("成果文件")}</span>
          </>
        )}
      </button>

      {open && (
        <div className="output-body">
          <div className="output-sub">
            {count ? tr("本次会话新建的成果，点名字直接打开") : tr("本次会话还没有产出成果文件")}
          </div>
          {count === 0 ? (
            <div className="output-empty">
              {tr("本次会话新建的成果文件会列在这里，点文件名打开，点「目录」定位。")}</div>
          ) : (
            <div className="output-list">
              {files.map((f) => (
                <div className="output-row" key={f.path}>
                  <button className="output-open" onClick={() => void openFile(f.path)} title={f.path}>
                    <span className="output-name">{baseName(f.path)}</span>
                    {dirOf(f.path) && <span className="output-dir">{dirOf(f.path)}</span>}
                  </button>
                  <div className="output-meta">
                    <span className="output-badge created">{tr("新建")}</span>
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
        </div>
      )}
    </aside>
  )
}
