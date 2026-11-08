import { app } from 'electron'
import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import { safeEnv } from './env'

/**
 * 后台命令：解决「长任务一次收 stdout 必超时」这个实际问题。
 *
 * 不引入 PTY / 终端 UI —— 绝大多数场景要的是「跑完把日志给我看」，
 * 而不是「像终端一样交互」。真要交互，用户在本地终端里跑更顺手。
 */

export interface BgJob {
  id: string
  command: string
  shell: string
  cwd: string
  startedAt: number
  logPath: string
  status: 'running' | 'exited'
  exitCode?: number | null
  pid?: number
}

const jobs = new Map<string, BgJob>()
const children = new Map<string, ChildProcess>()

function logDir(): string {
  return path.join(app.getPath('userData'), 'logs', 'shell')
}

function shellBin(shell: string): string {
  if (shell === 'powershell') return 'powershell.exe'
  if (shell === 'bash') return 'bash.exe'
  return process.env.ComSpec || 'cmd.exe'
}

function argvFor(shell: string, command: string): string[] {
  if (shell === 'powershell') return ['-NoProfile', '-Command', command]
  if (shell === 'bash') return ['-lc', command]
  return ['/d', '/s', '/c', command]
}

export async function startBackground(
  root: string,
  command: string,
  shell = 'cmd'
): Promise<BgJob> {
  await fs.mkdir(logDir(), { recursive: true })
  const id = crypto.randomBytes(4).toString('hex')
  const logPath = path.join(logDir(), `${id}.log`)
  const bin = shellBin(shell)

  const child = spawn(bin, argvFor(shell, command), {
    cwd: root,
    windowsHide: true,
    env: safeEnv()
  })
  children.set(id, child)

  const job: BgJob = {
    id,
    command,
    shell,
    cwd: root,
    startedAt: Date.now(),
    logPath,
    status: 'running',
    pid: child.pid
  }
  jobs.set(id, job)

  const stream = createWriteStream(logPath, { flags: 'a' })
  stream.write(`$ ${command}\n\n`)
  child.stdout?.pipe(stream, { end: false })
  child.stderr?.pipe(stream, { end: false })

  child.on('error', (err) => {
    job.status = 'exited'
    job.exitCode = -1
    stream.write(`\n[启动失败] ${err.message}\n`)
    stream.end()
  })
  child.on('close', (code) => {
    job.status = 'exited'
    job.exitCode = code
    stream.write(`\n[退出码 ${code ?? 'null'}]\n`)
    stream.end()
  })

  return job
}

export function listJobs(): BgJob[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)
}

export function getJob(id: string): BgJob | undefined {
  return jobs.get(id)
}

/** 读日志尾部：长任务动辄几万行，只回最后一段 */
export async function tailLog(id: string, tail = 80): Promise<string> {
  const job = jobs.get(id)
  if (!job) throw new Error(`没有这个后台任务：${id}`)
  let text = ''
  try {
    text = await fs.readFile(job.logPath, 'utf8')
  } catch {
    return '（日志文件还不存在，命令可能刚启动）'
  }
  const lines = text.split(/\r?\n/)
  const n = Math.min(Math.max(tail, 10), 2000)
  const part = lines.length > n ? lines.slice(-n).join('\n') : text
  const head = `# ${job.id} ${job.status === 'running' ? '运行中' : `已结束（退出码 ${job.exitCode ?? 'null'}）`}\n`
  return head + part.trim()
}

export function killJob(id: string): string {
  const job = jobs.get(id)
  if (!job) throw new Error(`没有这个后台任务：${id}`)
  if (job.status !== 'running') return `任务 ${id} 早就结束了（退出码 ${job.exitCode ?? 'null'}）`
  const child = children.get(id)
  if (child?.pid) {
    // Windows 上 child.kill 杀不掉子进程树，构建脚本会留一堆 node.exe
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
    } catch {
      child.kill()
    }
  }
  job.status = 'exited'
  return `已结束任务 ${id}`
}
