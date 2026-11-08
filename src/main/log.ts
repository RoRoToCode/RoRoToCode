import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { redact, redactError } from './redact'

/**
 * 主进程日志。
 *
 * 刻意用同步写：崩在 `uncaughtException` 里时，异步写很可能永远落不了盘，
 * 而「崩溃那一刻的日志」恰恰是唯一有用的东西。日志量本来就小，同步足够。
 *
 * 滚动策略：单文件 5MB，保留 3 份历史（main.log / main.1.log / main.2.log）。
 */

const MAX_BYTES = 5 * 1024 * 1024
const KEEP = 3

let cachedDir = ''

export function logDir(): string {
  if (cachedDir) return cachedDir
  try {
    cachedDir = path.join(app.getPath('userData'), 'logs')
  } catch {
    // app 还没 ready：退到临时目录，至少别把日志丢了
    cachedDir = path.join(process.cwd(), 'logs')
  }
  return cachedDir
}

export function logPath(): string {
  return path.join(logDir(), 'main.log')
}

function rotate(): void {
  const file = logPath()
  if (!existsSync(file)) return
  try {
    if (statSync(file).size < MAX_BYTES) return
  } catch {
    return
  }
  try {
    rmSync(`${logDir()}/main.${KEEP - 1}.log`, { force: true })
    for (let i = KEEP - 2; i >= 1; i--) {
      const from = path.join(logDir(), `main.${i}.log`)
      if (existsSync(from)) renameSync(from, path.join(logDir(), `main.${i + 1}.log`))
    }
    renameSync(file, path.join(logDir(), 'main.1.log'))
  } catch {
    // 滚动失败就把当前文件清空，别让磁盘被日志吃满
    try {
      rmSync(file, { force: true })
    } catch {
      // 实在不行就继续往里追加
    }
  }
}

type Level = 'info' | 'warn' | 'error'

export function log(level: Level, scope: string, message: string, err?: unknown): void {
  const line =
    `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${redact(message)}` +
    (err === undefined ? '' : `\n  ${redactError(err).split('\n').join('\n  ')}`) +
    '\n'
  try {
    mkdirSync(logDir(), { recursive: true })
    rotate()
    appendFileSync(logPath(), line, 'utf8')
  } catch {
    // 日志写不进去也不能影响主流程
  }
  // 开发时终端里也能看到
  if (level === 'error') console.error(line.trimEnd())
  else if (level === 'warn') console.warn(line.trimEnd())
}
