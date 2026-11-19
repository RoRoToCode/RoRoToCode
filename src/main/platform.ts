import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

/**
 * 跨平台原语层。
 *
 * 这个程序最早是「Windows 本地 coding agent」：进程管理走 taskkill、装包只认
 * `-bin-win-*.zip`、显卡探测走 WMI。要把同一套体验搬到 macOS / Linux，散落各处的
 * `process.platform === 'win32'` 判断会迅速失控，所以把「什么是平台相关的」集中到这里：
 *
 *  - 可执行文件名 / 动态库扩展名 / 压缩包格式
 *  - llama.cpp 官方产物命名（Win 是 zip，Linux/macOS 是 tar.gz；后端矩阵也不同）
 *  - 进程树查询与终止（taskkill ↔ ps/kill）
 *  - shell 选择（cmd.exe / PowerShell ↔ $SHELL）
 *  - 解压（Expand-Archive ↔ tar / unzip）
 *
 * 这里只依赖 node 标准库，不 import electron —— 单测可以在没有 Electron 的环境里跑。
 */

export type OsKind = 'win32' | 'darwin' | 'linux'
export type ShellKind = 'cmd' | 'powershell' | 'bash'
export type LlamaBackend = 'cuda' | 'vulkan' | 'rocm' | 'metal' | 'cpu'

export const OS: OsKind =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'

export const isWin = OS === 'win32'
export const isMac = OS === 'darwin'
export const isLinux = OS === 'linux'

export function platformLabel(): string {
  return isWin ? 'Windows' : isMac ? 'macOS' : 'Linux'
}

/** `arm64` / `x64`，用于挑 llama.cpp 官方产物 */
export function archTag(arch: string = process.arch): string {
  return /arm64|aarch64/i.test(arch) ? 'arm64' : 'x64'
}

export function exeSuffix(): string {
  return isWin ? '.exe' : ''
}

/** `llama-server` / `llama-server.exe` */
export function serverFileName(): string {
  return `llama-server${exeSuffix()}`
}

/** 动态库扩展名：Windows `.dll`、macOS `.dylib`、Linux `.so` */
export function libExt(): string {
  return isWin ? '.dll' : isMac ? '.dylib' : '.so'
}

/** llama.cpp 在 macOS 上没有 CUDA，也没有 Vulkan；显卡能力来自系统内置的 Metal */
export function supportsCuda(): boolean {
  return !isMac
}
export function supportsVulkan(): boolean {
  return !isMac
}

/* ------------------------------------------------------------------ *
 * llama.cpp 官方产物命名
 *
 * 实测（b12375）：
 *   win   : llama-b12375-bin-win-cuda-12.4-x64.zip / -bin-win-vulkan-x64.zip
 *   linux : llama-b12375-bin-ubuntu-cuda-12.8-x64.tar.gz / -bin-ubuntu-vulkan-x64.tar.gz
 *   macos : llama-b12375-bin-macos-arm64.tar.gz（Metal 编进包内，无单独后端包）
 *   cudart: win 无 tag（cudart-llama-bin-win-cuda-12.4-x64.zip）
 *           linux 带 tag（cudart-llama-b12375-bin-ubuntu-cuda-12.8-x64.tar.gz）
 * ------------------------------------------------------------------ */

/** 镜像兜底时按这个顺序试的 CUDA 运行时版本（各平台官方产物里的常见值） */
export function knownCudaVersions(): string[] {
  if (isWin) return ['12.4', '13.4']
  if (isLinux) return ['12.8', '13.5']
  return []
}

export function defaultCudaVersion(): string {
  return isWin ? '12.4' : '12.8'
}

export interface AssetNameOptions {
  /** CUDA 运行时版本，如 12.8 */
  cudaVer?: string
  /** 目标架构，默认按本机 process.arch */
  arch?: string
}

/** 生成 llama.cpp 主程序包候选名（按当前平台） */
export function llamaAssetName(
  tag: string,
  backend: LlamaBackend,
  opts: AssetNameOptions = {}
): string {
  const a = archTag(opts.arch)
  if (isWin) {
    if (backend === 'cuda') return `llama-${tag}-bin-win-cuda-${opts.cudaVer ?? defaultCudaVersion()}-${a}.zip`
    if (backend === 'vulkan') return `llama-${tag}-bin-win-vulkan-${a}.zip`
    if (backend === 'rocm') return `llama-${tag}-bin-win-rocm-10.0-${a}.zip`
    return `llama-${tag}-bin-win-cpu-${a}.zip`
  }
  if (isMac) {
    // macOS 只有一种包：Metal + CPU 一起编进去
    return `llama-${tag}-bin-macos-${a}.tar.gz`
  }
  if (backend === 'cuda') return `llama-${tag}-bin-ubuntu-cuda-${opts.cudaVer ?? defaultCudaVersion()}-${a}.tar.gz`
  if (backend === 'vulkan') return `llama-${tag}-bin-ubuntu-vulkan-${a}.tar.gz`
  if (backend === 'rocm') return `llama-${tag}-bin-ubuntu-rocm-10.0-${a}.tar.gz`
  return `llama-${tag}-bin-ubuntu-${a}.tar.gz`
}

/** 生成 CUDA 运行库包名（Windows 不含 tag，Linux 含 tag） */
export function cudartAssetName(tag: string, cudaVer: string, arch: string = process.arch): string {
  const a = archTag(arch)
  if (isWin) return `cudart-llama-bin-win-cuda-${cudaVer}-${a}.zip`
  return `cudart-llama-${tag}-bin-ubuntu-cuda-${cudaVer}-${a}.tar.gz`
}

/* ------------------------------------------------------------------ *
 * 压缩包
 * ------------------------------------------------------------------ */

export function isArchiveName(name: string): boolean {
  return /\.(zip|tar\.gz|tgz)$/i.test(name)
}

/** 校验下载到的确实是压缩包：zip 包头 `PK`，gzip 包头 `1f 8b` */
export async function looksLikeArchive(file: string): Promise<boolean> {
  try {
    const fh = await fs.promises.open(file, 'r')
    try {
      const buf = Buffer.alloc(4)
      const { bytesRead } = await fh.read(buf, 0, 4, 0)
      if (bytesRead < 2) return false
      const zip = buf[0] === 0x50 && buf[1] === 0x4b
      const gz = buf[0] === 0x1f && buf[1] === 0x8b
      return zip || gz
    } finally {
      await fh.close()
    }
  } catch {
    return false
  }
}

/** 解压：Windows 用 PowerShell Expand-Archive（zip），POSIX 用 tar / unzip */
export function expandArchive(file: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const isZip = /\.zip$/i.test(file)
    let bin: string
    let args: string[]
    if (isZip) {
      if (isWin) {
        const q = (s: string) => s.replace(/'/g, "''")
        bin = 'powershell.exe'
        args = [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `Expand-Archive -LiteralPath '${q(file)}' -DestinationPath '${q(dest)}' -Force`
        ]
      } else {
        bin = 'unzip'
        args = ['-o', file, '-d', dest]
      }
    } else {
      // Windows 10+ 自带 bsdtar，macOS / Linux 也都有 tar
      bin = 'tar'
      args = ['-xzf', file, '-C', dest]
    }
    const child = spawn(bin, args, { windowsHide: true })
    let err = ''
    child.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`解压失败（退出码 ${code}）：${err.trim()}`))
    })
  })
}

/* ------------------------------------------------------------------ *
 * 进程：查询 / 终止
 * ------------------------------------------------------------------ */

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = 进程在，只是没权限发信号
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface PsRow {
  pid: number
  ppid: number
  comm: string
}

/** POSIX 进程表（macOS / Linux 都支持 `ps -A -o pid=,ppid=,comm=`） */
function posixProcesses(): PsRow[] {
  try {
    const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], {
      encoding: 'utf8',
      timeout: 5000
    })
    if (r.status !== 0 || !r.stdout) return []
    const rows: PsRow[] = []
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3].trim() })
    }
    return rows
  } catch {
    return []
  }
}

/** pid 对应的进程名是否等于 name（忽略 .exe 后缀） */
export function isPidNamed(pid: number, name: string): boolean {
  const want = name.replace(/\.exe$/i, '')
  if (isWin) {
    try {
      const out =
        spawnSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 5000
        }).stdout ?? ''
      return new RegExp(`^"${escapeRe(want)}(\\.exe)?"`, 'im').test(out)
    } catch {
      return false
    }
  }
  const row = posixProcesses().find((p) => p.pid === pid)
  if (!row) return false
  return path.basename(row.comm).replace(/\.exe$/i, '') === want
}

/** 所有叫 name 的进程（Windows 走 tasklist 镜像名，POSIX 走 ps 精确匹配） */
export function listPidsNamed(name: string): number[] {
  const want = name.replace(/\.exe$/i, '')
  if (isWin) {
    try {
      const out =
        spawnSync('tasklist', ['/fi', `IMAGENAME eq ${want}.exe`, '/fo', 'csv', '/nh'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 5000
        }).stdout ?? ''
      const pids: number[] = []
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(new RegExp(`"${escapeRe(want)}\\.exe","(\\d+)"`, 'i'))
        if (m) pids.push(Number(m[1]))
      }
      return pids
    } catch {
      return []
    }
  }
  return posixProcesses()
    .filter((p) => path.basename(p.comm).replace(/\.exe$/i, '') === want)
    .map((p) => p.pid)
}

/**
 * 同步终止进程树，返回「它确实不在了」。
 * 调用方（llama.ts）依赖这个返回值决定要不要把实例从表里删掉。
 */
export function killTreeSync(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true
  if (isWin) {
    try {
      const r = spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        timeout: 8000,
        encoding: 'utf8'
      })
      // 非 0 常见于「进程已经不在了」：那也算成功
      return r.status === 0 || !isPidAlive(pid)
    } catch {
      return !isPidAlive(pid)
    }
  }
  try {
    const all = posixProcesses()
    const victims = new Set<number>()
    const collect = (p: number): void => {
      if (victims.has(p)) return
      victims.add(p)
      for (const c of all) if (c.ppid === p) collect(c.pid)
    }
    collect(pid)
    // 先杀子孙，再杀父进程，避免父进程退出后子进程被 init 收养而漏杀
    for (const p of [...victims].reverse()) {
      try {
        process.kill(p, 'SIGKILL')
      } catch {
        // 已经没了
      }
    }
    return !isPidAlive(pid)
  } catch {
    return !isPidAlive(pid)
  }
}

/** 异步、fire-and-forget 版本（工具超时 / 取消时用） */
export function killTree(pid: number | undefined | null): void {
  if (!pid) return
  if (isWin) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true })
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 忽略
      }
    }
    return
  }
  // POSIX：用同步的树终止，避免只杀父进程、构建脚本留下孤儿 node
  killTreeSync(pid)
}

/** nvidia-smi 可能出现的位置（各平台） */
export function nvidiaSmiPaths(): string[] {
  if (isWin) {
    const sys = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    return [
      'nvidia-smi',
      path.join(sys, 'System32', 'nvidia-smi.exe'),
      'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'
    ]
  }
  return ['nvidia-smi', '/usr/bin/nvidia-smi', '/usr/local/bin/nvidia-smi', '/usr/lib/wsl/lib/nvidia-smi']
}

/* ------------------------------------------------------------------ *
 * shell
 * ------------------------------------------------------------------ */

export function defaultShellKind(): ShellKind {
  return isWin ? 'cmd' : 'bash'
}

/** 用户默认交互 shell：Windows 是 ComSpec，macOS / Linux 优先 $SHELL */
export function userShell(): string {
  if (isWin) return process.env.ComSpec || 'cmd.exe'
  if (process.env.SHELL) return process.env.SHELL
  return fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash'
}

/** `run_shell` / `shell_bg` 用的可执行文件 */
export function shellBin(kind: string): string {
  if (isWin) {
    if (kind === 'powershell') return 'powershell.exe'
    if (kind === 'bash') return 'bash.exe'
    return process.env.ComSpec || 'cmd.exe'
  }
  return userShell()
}

/** 执行一条命令的参数（POSIX 统一用 `-lc`，让 $SHELL 读登录环境） */
export function shellArgs(kind: string, command: string): string[] {
  if (isWin) {
    if (kind === 'powershell') return ['-NoProfile', '-Command', command]
    if (kind === 'bash') return ['-lc', command]
    return ['/d', '/s', '/c', command]
  }
  return ['-lc', command]
}

/**
 * 这个 shell 是否需要用 `windowsVerbatimArguments` 起进程。
 *
 * 只有 Windows 的 cmd.exe 需要。原因：我们传给 shell 的是一条「已经写好的整行命令」
 * （`python -c "..."`、`echo a && echo b`），它本来就该由 shell 自己解析引号。
 * 但 Node 在 Windows 上默认会对每个 argv 做 Windows 命令行转义（加引号、`"` → `\"`），
 * cmd.exe 只认双引号配对、不认反斜杠转义，于是 `python -c "import os; print(1)` 里的
 * 内层双引号被剥成 `"import` → `SyntaxError: unterminated string literal`。
 *
 * verbatim 让 argv 原样拼进命令行，cmd 拿到完整引号就正常了。
 * 反例：powershell / bash 自己会处理转义，开了 verbatim 反而坏（bash 会把带空格的可执行
 * 路径拆开、powershell 会把 `;` 当命令分隔符）—— 所以只对 cmd 开。
 */
export function shellNeedsVerbatim(kind: string): boolean {
  return isWin && kind === 'cmd'
}

/** 常驻交互式终端：bin + args + 归一化后的 kind */
export function interactiveShell(kind?: string): { bin: string; args: string[]; kind: ShellKind } {
  if (isWin) {
    const k: ShellKind = kind === 'powershell' || kind === 'bash' ? kind : 'cmd'
    if (k === 'powershell') {
      return {
        bin: 'powershell.exe',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NoExit',
          '-Command',
          '[Console]::InputEncoding=[System.Text.Encoding]::UTF8; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8'
        ],
        kind: k
      }
    }
    if (k === 'bash') return { bin: 'bash.exe', args: ['-i'], kind: k }
    return { bin: process.env.ComSpec || 'cmd.exe', args: ['/k', 'chcp', '65001'], kind: k }
  }
  return { bin: userShell(), args: ['-i'], kind: 'bash' }
}

/* ------------------------------------------------------------------ *
 * 后端动态库
 * ------------------------------------------------------------------ */

export interface BackendLibs {
  cuda: RegExp
  vulkan: RegExp
  rocm: RegExp
  metal: RegExp
}

/** 目录里出现哪些后端动态库，就说明装的是哪个后端 */
export function backendLibs(): BackendLibs {
  const ext = libExt().replace('.', '\\.')
  const prefix = isWin ? 'ggml-' : 'libggml-'
  return {
    cuda: new RegExp(`^${prefix}cuda.*${ext}$`, 'i'),
    vulkan: new RegExp(`^${prefix}vulkan.*${ext}$`, 'i'),
    rocm: new RegExp(`^${prefix}(hip|rocm).*${ext}$`, 'i'),
    metal: new RegExp(`^${prefix}metal.*${ext}$`, 'i')
  }
}

/** CUDA 运行库文件名模式（Windows 是 cudart64_*.dll，Linux 是 libcudart.so.*） */
export function cudaRuntimeRegexes(): RegExp[] {
  if (isWin) {
    return [/^cudart64_\d+\.dll$/i, /^cublas64_\d+\.dll$/i, /^cublasLt64_\d+\.dll$/i]
  }
  return [/^libcudart\.so(\.\d+)?$/i, /^libcublas\.so(\.\d+)?$/i, /^libcublasLt\.so(\.\d+)?$/i]
}
