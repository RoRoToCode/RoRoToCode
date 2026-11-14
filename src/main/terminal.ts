/**
 * 常驻交互式终端会话。
 *
 * 和 run_shell 的区别：run_shell 是「发一条命令、等它跑完、拿全部输出」，
 * 遇到会等输入的程序（npm init、vite 的交互提示、ssh、REPL）就卡死。
 * 这里保留一个长期存活的 shell，把 stdin 一直开着，模型可以分多次写、分多次读。
 *
 * 实现取舍：
 * - 用 `spawn` + 管道，不是完整 PTY。理由是 Windows 上要真 PTY 得引 node-pty
 *   原生模块（要按 Electron ABI 重编译），为了这个功能把打包链搞复杂不划算。
 *   管道模式对「命令行程序 + 逐行输入」够用；全屏 TUI（vim、top）不支持。
 * - 输出保留最近 200KB。终端会一直吐提示符和进度条，不设上限迟早吃光内存。
 * - 每个会话有单调递增的 seq。客户端（工具/界面）传 since 就能只拿增量，
 *   不用每次把整屏重读一遍。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { TerminalInfo, TerminalRead, TerminalShell } from '../shared/types'
import { safeEnv } from './tools/env'

export type { TerminalInfo, TerminalRead, TerminalShell }

interface Session {
  id: string
  shell: TerminalShell
  cwd: string
  proc: ChildProcessWithoutNullStreams
  buffer: string
  seq: number
  status: 'running' | 'exited'
  exitCode: number | null
  startedAt: number
}

const sessions = new Map<string, Session>()
const MAX_BUFFER = 200_000
const MAX_SESSIONS = 3

function pickShell(shell?: string): { bin: string; args: string[]; kind: TerminalShell } {
  const kind: TerminalShell = shell === 'powershell' || shell === 'bash' ? shell : 'cmd'
  if (kind === 'powershell') {
    return {
      bin: 'powershell.exe',
      // 输入/输出都切到 UTF-8，再留在交互模式
      args: [
        '-NoLogo', '-NoProfile', '-NoExit', '-Command',
        '[Console]::InputEncoding=[System.Text.Encoding]::UTF8; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8'
      ],
      kind
    }
  }
  if (kind === 'bash') {
    return { bin: 'bash.exe', args: ['-i'], kind }
  }
  // 中文 Windows 的 cmd 默认按 GBK 输出，/k chcp 65001 先切码页再进交互
  return { bin: process.env.ComSpec || 'cmd.exe', args: ['/k', 'chcp', '65001'], kind }
}

function append(s: Session, chunk: string): void {
  s.buffer += chunk
  s.seq += chunk.length
  if (s.buffer.length > MAX_BUFFER) {
    s.buffer = s.buffer.slice(s.buffer.length - MAX_BUFFER)
  }
}

/** 打开一个会话。同一工作区重复打开会复用一个还活着的会话，避免越开越多。 */
export function openTerminal(workspace: string, shell?: string): TerminalInfo {
  if (!workspace || !existsSync(workspace)) {
    throw new Error(`工作区不存在：${workspace}`)
  }

  for (const s of sessions.values()) {
    if (s.status === 'running' && s.cwd === workspace && s.shell === (shell as TerminalShell || 'cmd')) {
      return info(s)
    }
  }

  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()]
      .filter((s) => s.status === 'exited')
      .sort((a, b) => a.startedAt - b.startedAt)[0]
    if (oldest) {
      sessions.delete(oldest.id)
    } else {
      throw new Error(`最多同时保留 ${MAX_SESSIONS} 个终端会话，请先关闭一个`)
    }
  }

  const { bin, args, kind } = pickShell(shell)
  const proc = spawn(bin, args, {
    cwd: workspace,
    env: {
      ...safeEnv(),
      TERM: 'xterm-256color',
      CLICOLOR_FORCE: '1',
      // 让子进程知道自己在管道里，别试图弹 GUI
      ROROTO_TERMINAL: '1'
    },
    windowsHide: true,
    stdio: 'pipe'
  })

  const id = randomUUID().slice(0, 8)
  const s: Session = {
    id,
    shell: kind,
    cwd: workspace,
    proc,
    buffer: '',
    seq: 0,
    status: 'running',
    exitCode: null,
    startedAt: Date.now()
  }
  sessions.set(id, s)

  proc.stdout?.on('data', (d: Buffer) => append(s, d.toString('utf8')))
  proc.stderr?.on('data', (d: Buffer) => append(s, d.toString('utf8')))
  proc.on('error', (err) => {
    append(s, `\n[终端启动失败] ${err.message}\n`)
    s.status = 'exited'
    s.exitCode = -1
  })
  proc.on('close', (code) => {
    s.status = 'exited'
    s.exitCode = code ?? null
    append(s, `\n[终端已退出，退出码 ${code ?? 'null'}]\n`)
  })

  return info(s)
}

function info(s: Session): TerminalInfo {
  return {
    id: s.id,
    shell: s.shell,
    cwd: s.cwd,
    status: s.status,
    exitCode: s.exitCode,
    seq: s.seq,
    startedAt: s.startedAt
  }
}

export function listTerminals(): TerminalInfo[] {
  return [...sessions.values()].map(info)
}

export function getTerminal(id: string): TerminalInfo | null {
  const s = sessions.get(id)
  return s ? info(s) : null
}

export function writeTerminal(id: string, data: string): TerminalInfo {
  const s = sessions.get(id)
  if (!s) throw new Error(`没有这个终端会话：${id}`)
  if (s.status !== 'running') throw new Error(`终端已退出（退出码 ${s.exitCode ?? 'null'}），请重新打开`)
  // cmd 在管道模式下仍按系统代码页（中文 Windows 是 936）解码 stdin，
  // 我们发的是 UTF-8，中文会被解成乱码、甚至触发 "More?" 卡住。
  // 与其让人以为终端坏了，不如明确拒绝并给出替代方案。
  if (s.shell === 'cmd' && /[^\x00-\x7F]/.test(data)) {
    throw new Error('cmd 会话的管道输入不支持中文（会被按 GBK 解码成乱码）。请改用 PowerShell / bash 会话，或把内容写进文件再执行。')
  }
  s.proc.stdin.write(data)
  return info(s)
}

/** 去掉 ANSI 颜色/光标控制，模型读日志不需要这些 */
function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r/g, '')
}

export type TerminalReadResult = TerminalRead

/**
 * 读增量。since 传上次拿到的 seq；不传则返回最后 tail 个字符。
 * waitMs > 0 时会等到有新输出或超时，省得模型写完立刻读、读到空。
 */
export async function readTerminal(
  id: string,
  since?: number,
  opts: { tail?: number; waitMs?: number } = {}
): Promise<TerminalRead> {
  const s = sessions.get(id)
  if (!s) throw new Error(`没有这个终端会话：${id}`)

  const waitMs = Math.min(Math.max(Number(opts.waitMs) || 0, 0), 15_000)
  if (waitMs > 0) {
    const deadline = Date.now() + waitMs
    const startSeq = s.seq
    while (s.seq === startSeq && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  const start = s.seq - s.buffer.length
  const truncated = since !== undefined && since < start
  let raw: string
  if (since === undefined) {
    const tail = Math.min(Math.max(Number(opts.tail) || 8000, 500), MAX_BUFFER)
    raw = s.buffer.slice(Math.max(0, s.buffer.length - tail))
  } else {
    raw = s.buffer.slice(Math.max(0, since - start))
  }

  return {
    text: stripAnsi(raw),
    seq: s.seq,
    status: s.status,
    exitCode: s.exitCode,
    truncated
  }
}

export function closeTerminal(id: string): TerminalInfo | null {
  const s = sessions.get(id)
  if (!s) return null
  if (s.status === 'running') {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(s.proc.pid), '/t', '/f'], { windowsHide: true })
      } else {
        s.proc.kill()
      }
    } catch {
      s.proc.kill()
    }
  }
  const out = info(s)
  sessions.delete(id)
  return out
}

export function disposeAllTerminals(): void {
  for (const id of [...sessions.keys()]) closeTerminal(id)
}
