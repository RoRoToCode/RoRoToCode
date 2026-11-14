import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { TerminalInfo } from '../../shared/types'
import { t as tr } from '../i18n'

interface Props {
  workspace: string | null
  /** 面板当前是否可见：不可见时不轮询，省得后台一直读 */
  active: boolean
  onNotify: (message: string, kind?: 'info' | 'warn' | 'error') => void
}

const MAX_KEEP = 120_000

/**
 * 交互式终端面板。
 * 和「变更 / Git」同一个右侧抽屉，只是多一个 tab：
 * 打开后是一个常驻 shell，可以连续输入、连续看输出（npm init / vite 提示 / REPL 这类）。
 */
export function TerminalPanel({ workspace, active, onNotify }: Props) {
  const [session, setSession] = useState<TerminalInfo | null>(null)
  const [output, setOutput] = useState('')
  const [input, setInput] = useState('')
  const [shell, setShell] = useState<'cmd' | 'powershell' | 'bash'>('cmd')
  const since = useRef<number | undefined>(undefined)
  const boxRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number | null>(null)
  const history = useRef<string[]>([])
  const historyAt = useRef(-1)

  const stop = () => {
    if (timer.current !== null) {
      window.clearInterval(timer.current)
      timer.current = null
    }
  }

  useEffect(() => stop, [])

  useEffect(() => {
    if (!active || !session || session.status !== 'running') {
      stop()
      return
    }
    let cancelled = false
    const pump = async () => {
      try {
        const r = await window.pico.terminal.read(session.id, since.current)
        if (cancelled) return
        since.current = r.seq
        if (r.text) setOutput((prev) => (prev + r.text).slice(-MAX_KEEP))
        if (r.status === 'exited') {
          setSession((prev) => (prev ? { ...prev, status: 'exited', exitCode: r.exitCode } : prev))
          stop()
        }
      } catch {
        // 会话被关掉是正常情况，不打扰用户
      }
    }
    void pump()
    timer.current = window.setInterval(() => void pump(), 500)
    return () => {
      cancelled = true
      stop()
    }
  }, [active, session?.id, session?.status])

  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [output])

  const open = async () => {
    if (!workspace) {
      onNotify(tr('先选择一个工作区'), 'warn')
      return
    }
    try {
      const s = await window.pico.terminal.open(workspace, shell)
      since.current = undefined
      setOutput('')
      setSession(s)
    } catch (err) {
      onNotify((err as Error).message, 'error')
    }
  }

  const close = async () => {
    if (!session) return
    try {
      await window.pico.terminal.close(session.id)
    } catch {
      // 已经退出就算了
    }
    stop()
    setSession(null)
  }

  const send = async () => {
    if (!session || session.status !== 'running') return
    const data = `${input}\n`
    if (input.trim()) {
      history.current.push(input)
      historyAt.current = history.current.length
    }
    setInput('')
    try {
      await window.pico.terminal.write(session.id, data)
    } catch (err) {
      onNotify((err as Error).message, 'error')
    }
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void send()
    } else if (e.key === 'ArrowUp') {
      if (!history.current.length) return
      e.preventDefault()
      historyAt.current = Math.max(0, (historyAt.current < 0 ? history.current.length : historyAt.current) - 1)
      setInput(history.current[historyAt.current] ?? '')
    } else if (e.key === 'ArrowDown') {
      if (!history.current.length) return
      e.preventDefault()
      historyAt.current = Math.min(history.current.length, historyAt.current + 1)
      setInput(historyAt.current >= history.current.length ? '' : history.current[historyAt.current] ?? '')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 2px 8px' }}>
        {!session ? (
          <>
            <select
              value={shell}
              onChange={(e) => setShell(e.target.value as 'cmd' | 'powershell' | 'bash')}
              style={{ fontSize: 12 }}
            >
              <option value="cmd">cmd</option>
              <option value="powershell">PowerShell</option>
              <option value="bash">bash</option>
            </select>
            <button className="btn sm" onClick={() => void open()} disabled={!workspace}>
              {tr('打开终端')}
            </button>
          </>
        ) : (
          <>
            <span style={{ fontSize: 12, opacity: 0.7 }}>
              {session.shell} · {session.status === 'running' ? tr('运行中') : tr('已退出')}
              {session.exitCode !== null ? ` (${session.exitCode})` : ''}
            </span>
            <button className="btn sm" onClick={() => void close()}>
              {tr('关闭')}
            </button>
          </>
        )}
      </div>

      <div
        ref={boxRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          padding: '8px 10px',
          borderRadius: 6,
          background: 'rgba(127,127,127,0.10)'
        }}
      >
        {session ? output || tr('（等待输出…）') : tr('打开一个终端后，可以在这里连续输入命令。它不是完整 PTY，vim/top 这类全屏程序不支持。')}
      </div>

      <div style={{ display: 'flex', gap: 6, paddingTop: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder={session?.status === 'running' ? tr('输入命令，回车发送') : tr('终端未打开')}
          disabled={!session || session.status !== 'running'}
          style={{ flex: 1, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
        />
        <button
          className="btn sm"
          onClick={() => void send()}
          disabled={!session || session.status !== 'running'}
        >
          {tr('发送')}
        </button>
      </div>
    </div>
  )
}
