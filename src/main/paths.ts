import { app } from 'electron'
import os from 'node:os'
import path from 'node:path'

/**
 * 用户主目录。
 *
 * 正常运行时走 Electron 的 app.getPath('home')（它认的是登录用户，
 * 不是进程被启动时继承的 USERPROFILE）；单独跑测试 / 命令行自检时
 * 没有 app，退回 os.homedir()，这样扫描 .roroto/ 的逻辑可以被单测覆盖。
 */
export function homeDir(): string {
  try {
    const h = app?.getPath?.('home')
    if (h) return h
  } catch {
    // 不在 Electron 里
  }
  return os.homedir()
}

/**
 * 应用数据目录（Electron 的 userData）。
 *
 * agent.ts 刻意不 import electron —— 它要能被单测和命令行自检直接跑。
 * 需要落盘缓存的地方（比如工具输出溢出）从这里拿路径，兜底到 ~/.roroto。
 */
export function userDataDir(): string {
  try {
    const d = app?.getPath?.('userData')
    if (d) return d
  } catch {
    // 不在 Electron 里
  }
  return path.join(os.homedir(), '.roroto')
}
