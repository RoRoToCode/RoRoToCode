import { app } from 'electron'
import os from 'node:os'

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
