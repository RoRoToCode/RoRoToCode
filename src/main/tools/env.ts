/**
 * 传给子进程的环境变量：白名单，不是黑名单。
 *
 * `{ ...process.env }` 会把用户 shell 里的云厂商密钥、token、私有 registry 凭据
 * 一并交给「模型生成的命令」。这一步不需要任何技巧就能拿到，所以要收窄。
 * 真需要某个变量时，在 EXTRA 里显式加，别图省事全放开。
 */

const PASS = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'TEMP',
  'TMP',
  'ComSpec',
  'USERPROFILE',
  'HOME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramData',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS'
]

/** 工具链需要、且不含凭据的补充项 */
const EXTRA: Array<[string, string]> = [
  ['GIT_PAGER', 'cat'],
  ['PAGER', 'cat'],
  // 别让 npm / git 卡在交互式提示上
  ['CI', '1'],
  ['NO_COLOR', '1'],
  /**
   * 不生成 `__pycache__`。
   *
   * 模型每次跑 `python gen.py` / `python -m pytest` 都会在交付目录旁边留下一堆
   * `__pycache__`，实测里它们最后和成果文件混在一起。这个变量让解释器不落字节码缓存，
   * 从源头就不产生垃圾（同时也能少写几个文件、跑得略快一点）。
   */
  ['PYTHONDONTWRITEBYTECODE', '1'],
  /**
   * Python 子进程的输出编码。
   *
   * Windows 下 cmd 里的 Python 默认按系统代码页（中文机器上是 GBK）输出，
   * 而我们用 utf8 解码 stdout —— 测试断言里的中文全变成「??」，模型既读不懂
   * 断言失败的原因，也分不清是自己写错还是编码问题。这个变量只影响
   * stdin/stdout/stderr 的编码，不改变任何行为，也不含凭据。
   */
  ['PYTHONIOENCODING', 'utf-8'],
  // 别让 pip 每 24 小时往 stderr 打一行「有新版本」，那行会被模型当成错误去追
  ['PIP_DISABLE_PIP_VERSION_CHECK', '1']
]

export function safeEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of PASS) {
    const v = process.env[key]
    if (v) out[key] = v
  }
  for (const [k, v] of EXTRA) if (!out[k]) out[k] = v
  return out
}

/** 供界面说明用：当前被过滤掉的敏感变量个数（只报数量，不报名字与值） */
export function filteredSecretCount(): number {
  return Object.keys(process.env).filter((k) =>
    /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i.test(k) && !PASS.includes(k)
  ).length
}
