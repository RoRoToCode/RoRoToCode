export interface DataRootInput {
  env: Record<string, string | undefined>
  /** 持久数据目录：app.getPath('userData')，跨版本升级不会变 */
  userDataDir: string
  /** exe 所在目录：便携版传统落盘位置 */
  exeDir: string
  /** 判断某个候选根目录下是否已有数据（由主进程用 fs 实现） */
  hasData: (base: string) => boolean
  /** 把 ROROTO_DATA_DIR 规范化成绝对路径（由主进程用 node:path 实现） */
  resolve: (p: string) => string
}

/**
 * 决定 llama.cpp 运行库 / GGUF 模型 / 简易核心放在哪里。
 *
 * 为什么需要这个函数：便携版历史上把这些数据写在 exe 同目录（appBase）。
 * 用 winget / scoop 之类的包管理器分发时，每次升级都会换一个安装目录，
 * 用户下载的 llama.cpp、CUDA dll 和几 GB 的模型会全部「消失」。
 * 配置、会话、日志本来就在 userData，只有这几类大文件跟着安装目录走。
 *
 * 优先级：
 *   1. ROROTO_DATA_DIR 显式指定（CI / smoke / 自定义位置，建议给绝对路径）
 *   2. ROROTO_PORTABLE=1 真便携模式（U 盘、想把模型跟 exe 放一起）
 *   3. 老用户兼容：exe 同目录已有数据、持久目录还没有 → 继续用老位置
 *   4. 其余情况用持久目录（新安装、winget 升级都走这里）
 *
 * 不迁移、不复制文件：几 GB 的模型自动搬动风险远大于收益，
 * 老用户保持原位，新安装从一开始就用对位置。
 *
 * 刻意不 import node:path —— 这个文件被主进程和渲染层共用，
 * 渲染层 tsconfig 里没有 node 类型（和 modelpath.ts 同样的取舍）。
 * 路径操作全部由调用方注入，这里只做纯决策。
 */
export function resolveDataRoot(input: DataRootInput): string {
  const { env, userDataDir, exeDir, hasData, resolve } = input

  const override = env.ROROTO_DATA_DIR?.trim()
  if (override) return resolve(override)

  if (env.ROROTO_PORTABLE === '1') return exeDir

  if (hasData(exeDir) && !hasData(userDataDir)) return exeDir
  return userDataDir
}
