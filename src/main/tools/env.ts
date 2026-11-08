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
  ['NO_COLOR', '1']
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
