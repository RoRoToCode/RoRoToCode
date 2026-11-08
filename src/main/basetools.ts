import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dialog } from 'electron'
import type { BaseToolId, BaseToolStatus, ToolSetupProgress } from '../shared/types'
import { downloadToFile, headSize, humanSize } from './dl'
import { mt } from './i18n'

/**
 * 基础核心库：Node.js（含 npm）、Git for Windows、Python。
 * 检测 → 下载官方安装包 → 一次提权静默装完，省得用户自己找下载链接。
 */

interface ToolSpec {
  id: BaseToolId
  label: string
  /** PATH 里的命令名 */
  bins: string[]
  /** PATH 里没有时按顺序试这些绝对路径 */
  candidates: () => string[] | Promise<string[]>
  versionArgs: string[]
  /** 安装包落地文件名 */
  file: string
  /** 静默安装命令（PowerShell 里执行） */
  silent: (file: string) => string
  /** 解析安装包直链 */
  resolve: () => Promise<string>
  /** 解析不出来时给用户的下载页 */
  page: string
  optional?: boolean
}

const PF = process.env.ProgramFiles ?? 'C:\\Program Files'
const PF86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
const LOCAL = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')

/** 常见 Python 安装目录（Program Files\Python3xx 与 用户目录两套） */
async function pythonDirs(): Promise<string[]> {
  const out: string[] = []
  for (const base of [PF, path.join(LOCAL, 'Programs', 'Python')]) {
    try {
      const entries = await fs.readdir(base, { withFileTypes: true })
      for (const e of entries) {
        if (e.isDirectory() && /^Python3\d+$/.test(e.name)) out.push(path.join(base, e.name, 'python.exe'))
      }
    } catch {
      /* 目录不存在就算了 */
    }
  }
  return out.reverse()
}

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url, {
    redirect: 'follow',
    headers: { accept: 'application/json', 'user-agent': 'RoRoToCode' },
    signal: AbortSignal.timeout(20 * 1000)
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()) as T
}

const SPECS: Record<BaseToolId, ToolSpec> = {
  node: {
    id: 'node',
    label: 'Node.js LTS（含 npm）',
    bins: ['node'],
    candidates: () => [path.join(PF, 'nodejs', 'node.exe')],
    versionArgs: ['-v'],
    file: 'node-lts-x64.msi',
    // MSI 静默安装，/norestart 避免自动重启打断用户
    silent: (f) => `Start-Process msiexec.exe -ArgumentList '/i "${f}" /qn /norestart' -Wait`,
    page: 'https://nodejs.org/zh-cn/download',
    resolve: async () => {
      // index.json 里第一条 lts 非 false 的就是当前 LTS
      const list = await json<Array<{ version: string; lts: string | boolean; files: string[] }>>(
        'https://nodejs.org/dist/index.json'
      )
      const hit = list.find((v) => v.lts !== false && v.files.includes('win-x64-msi'))
      if (!hit) throw new Error('没找到 Node.js LTS 的 Windows 安装包')
      return `https://nodejs.org/dist/${hit.version}/node-${hit.version}-x64.msi`
    }
  },
  git: {
    id: 'git',
    label: 'Git for Windows',
    bins: ['git'],
    candidates: () => [path.join(PF, 'Git', 'cmd', 'git.exe'), path.join(PF86, 'Git', 'cmd', 'git.exe')],
    versionArgs: ['--version'],
    file: 'git-setup-64.exe',
    // Inno Setup 的静默参数
    silent: (f) => `Start-Process "${f}" -ArgumentList '/VERYSILENT /NORESTART /NOCANCEL /SP- /CLOSEAPPLICATIONS' -Wait`,
    page: 'https://git-scm.com/download/win',
    resolve: async () => {
      const rel = await json<{ assets?: Array<{ name: string; browser_download_url: string }> }>(
        'https://api.github.com/repos/git-for-windows/git/releases/latest'
      )
      const asset = rel.assets?.find((a) => /^Git-.*-64-bit\.exe$/i.test(a.name))
      if (!asset) throw new Error('没找到 Git 的 64 位安装包')
      return asset.browser_download_url
    }
  },
  python: {
    id: 'python',
    label: 'Python 3（可选）',
    bins: ['python'],
    candidates: pythonDirs,
    versionArgs: ['--version'],
    file: 'python-setup-amd64.exe',
    // 装到机器级并写进 PATH，勾上 py launcher
    silent: (f) =>
      `Start-Process "${f}" -ArgumentList '/quiet InstallAllUsers=1 PrependPath=1 Include_test=0 Include_launcher=1' -Wait`,
    page: 'https://www.python.org/downloads/windows/',
    optional: true,
    resolve: async () => {
      const r = await fetch('https://www.python.org/downloads/', {
        redirect: 'follow',
        signal: AbortSignal.timeout(20 * 1000)
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const html = await r.text()
      // 取页面上第一个 3.x 的 amd64 安装包，就是当前最新稳定版
      const m = html.match(/python-(3\.\d+\.\d+)-amd64\.exe/)
      if (!m) throw new Error('没找到 Python 的 Windows 安装包')
      return `https://www.python.org/ftp/python/${m[1]}/python-${m[1]}-amd64.exe`
    }
  }
}

const ORDER: BaseToolId[] = ['node', 'git', 'python']

/** 跑一条命令拿版本号；拿不到返回 null */
function runVersion(exe: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => {
      const text = `${stdout || ''}${stderr || ''}`.trim()
      if (!text) {
        resolve(err ? null : '已安装')
        return
      }
      resolve(text.split(/\r?\n/)[0].trim() || '已安装')
    })
  })
}

async function probeTool(spec: ToolSpec): Promise<{ exe: string; version: string } | null> {
  // 先认 PATH，再认常见安装目录（刚装完 PATH 还没刷新时靠后者兜底）
  for (const bin of spec.bins) {
    const v = await runVersion(bin, spec.versionArgs)
    if (v) return { exe: bin, version: v }
  }
  for (const exe of await spec.candidates()) {
    const v = await runVersion(exe, spec.versionArgs)
    if (v) return { exe, version: v }
  }
  return null
}

export async function checkTools(): Promise<BaseToolStatus[]> {
  const out: BaseToolStatus[] = []
  for (const id of ORDER) {
    const spec = SPECS[id]
    const hit = await probeTool(spec)
    out.push({
      id,
      label: spec.label,
      command: `${spec.bins[0]} ${spec.versionArgs.join(' ')}`,
      installed: Boolean(hit),
      // git 会输出 "git version 2.x"，去掉前缀好看些
      version: hit?.version.replace(/^git version\s+/i, ''),
      optional: spec.optional,
      page: spec.page
    })
  }
  return out
}

export interface InstallResult {
  ok: boolean
  message: string
  installed?: string[]
  failed?: Array<{ label: string; reason: string }>
  tools?: BaseToolStatus[]
}

/** 生成提权后执行的安装脚本；单独抽出来便于做语法校验 */
export function buildInstallScript(ready: Array<{ spec: ToolSpec; file: string }>, logFile: string): string {
  const q = (v: string) => v.replace(/'/g, "''")
  const log = (text: string, append = true) =>
    `"${text}" | Out-File -LiteralPath $log${append ? ' -Append' : ''} -Encoding utf8`
  return [
    `$ErrorActionPreference = 'Continue'`,
    `$log = '${q(logFile)}'`,
    log(`[$(Get-Date -Format 'HH:mm:ss')] 开始安装`, false),
    ...ready.flatMap(({ spec, file }) => [
      log(`[$(Get-Date -Format 'HH:mm:ss')] 安装 ${spec.label}`),
      spec.silent(file),
      log(`   ${spec.label} 已执行`),
      ''
    ]),
    log(`[$(Get-Date -Format 'HH:mm:ss')] DONE`)
  ].join('\n')
}

export async function installTools(
  ids: BaseToolId[],
  onProgress: (p: ToolSetupProgress) => void
): Promise<InstallResult> {
  const targets = ORDER.filter((id) => ids.includes(id))
  if (targets.length === 0) return { ok: false, message: '没有需要安装的组件' }

  // 1) 解析直链
  const plans: Array<{ spec: ToolSpec; url: string; size: number }> = []
  const failed: Array<{ label: string; reason: string }> = []
  for (const id of targets) {
    const spec = SPECS[id]
    try {
      const url = await spec.resolve()
      const size = await headSize(url)
      plans.push({ spec, url, size })
    } catch (err) {
      failed.push({ label: spec.label, reason: (err as Error).message })
    }
  }
  if (plans.length === 0) {
    return {
      ok: false,
      message: `安装包地址解析失败：${failed.map((f) => `${f.label}（${f.reason}）`).join('；')}`
    }
  }

  // 2) 上机前确认一次，别让人莫名被装软件
  const total = plans.reduce((n, p) => n + p.size, 0)
  const ask = await dialog.showMessageBox({
    type: 'question',
    buttons: [mt('下载并安装'), mt('取消')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: mt('安装基础核心'),
    message: mt('将安装 {n} 个组件（共约 {size}）', { n: plans.length, size: humanSize(total) }),
    detail:
      `${plans.map((p) => `· ${mt(p.spec.label)}  ${p.size ? humanSize(p.size) : ''}`).join('\n')}\n\n` +
      mt('安装过程需要管理员权限，会弹出一次系统授权窗口；确认后全程静默安装，不会打断你正在做的事。')
  })
  if (ask.response === 1) return { ok: false, message: '已取消安装' }

  // 3) 逐个下载
  const dir = path.join(os.tmpdir(), 'roro-tools')
  await fs.mkdir(dir, { recursive: true })
  const ready: Array<{ spec: ToolSpec; file: string }> = []

  for (const plan of plans) {
    const file = path.join(dir, plan.spec.file)
    try {
      await downloadToFile(plan.url, file, (received, total) =>
        onProgress({
          id: plan.spec.id,
          label: plan.spec.label,
          phase: 'download',
          receivedBytes: received,
          totalBytes: total
        })
      )
      ready.push({ spec: plan.spec, file })
    } catch (err) {
      failed.push({ label: plan.spec.label, reason: `下载失败：${(err as Error).message}` })
    }
  }

  if (ready.length === 0) {
    return { ok: false, message: '安装包下载失败，请检查网络后重试', failed }
  }

  // 4) 写脚本：一次提权，把所有静默安装串起来
  const logFile = path.join(dir, 'install.log')
  const script = path.join(dir, 'install.ps1')
  // 必须带 BOM：PowerShell 5.1 读无 BOM 的 UTF-8 会按本地代码页解码，中文字符串会把语句拆坏
  await fs.writeFile(script, `\ufeff${buildInstallScript(ready, logFile)}`, 'utf8')

  onProgress({ id: ready[0].spec.id, label: '安装', phase: 'install', receivedBytes: 0, totalBytes: 0 })

  // 外层进程只干一件事：以管理员身份跑 install.ps1，并等它结束
  const launcher =
    `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -PassThru -Wait ` +
    `-ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${script.replace(/'/g, "''")}"'; exit $p.ExitCode`

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', launcher],
      { windowsHide: true }
    )
    const timer = setTimeout(() => {
      child.kill()
      resolve(-1)
    }, 20 * 60 * 1000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code ?? -1)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(-1)
    })
  })

  const tools = await checkTools()
  const nowOk = tools.filter((t) => ready.some((r) => r.spec.id === t.id) && t.installed)

  // 用户点了「否」取消授权时，脚本根本没跑起来
  if (exitCode !== 0 && nowOk.length === 0) {
    return {
      ok: false,
      message: '安装没有完成：可能取消了管理员授权，或安装程序被系统拦下。可重试，或到对应官网手动安装。',
      failed
    }
  }

  const names = nowOk.map((t) => `${t.label.replace(/（可选）/, '')} ${t.version ?? ''}`.trim())
  return {
    ok: nowOk.length > 0,
    message:
      nowOk.length > 0
        ? `已安装：${names.join('、')}。新装的环境需要重启本程序才会在终端里生效。`
        : '安装程序已执行完毕，但没有检测到新版本，请重启本程序后再看。',
    installed: names,
    failed,
    tools
  }
}
