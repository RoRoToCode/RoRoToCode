import { app } from 'electron'
import fsSync, { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import type { LlamaErrorCode, LlamaStatus, ProviderConfig, SetupProgress } from '../shared/types'
import { LLAMA_PORT, LLAMA_PORTS, deviceIndex, isLlamaProvider, llamaPortOf } from '../shared/providers'
import { ggufLooksVision } from '../shared/vision'
import { findFreePort, waitPortFree } from './portprobe'
import { CONTEXT_RANGE, loadConfig, saveConfig } from './config'
import { fitForLaunch } from './vramfit'
import { readGgufMeta } from './gguf'
import { MIRRORS, downloadFromGithub } from './ghdl'
import { queueInfoOf } from './gate'

const RELEASE_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10'
const RELEASES_LATEST = 'https://github.com/ggml-org/llama.cpp/releases/latest'

/**
 * llama.cpp 实例表。
 *
 * 以前这里是三个全局变量（pid / model / mmproj）加一个写死的端口 8080，
 * 一台机器只能挂一个模型 —— 双卡机器上一张卡空着也用不上，因为「再起一个就得先把前一个杀掉」。
 * 现在按供应商建实例：每个实例有自己的端口、自己绑的显卡、自己的 PID，互不干扰。
 *
 * key 用 providerId；确实没有归属的（外部手动启动的服务）用 `port:<端口>`。
 */
interface LlamaInstance {
  key: string
  port: number
  /** 主模型绝对路径 */
  model: string
  mmproj: string | null
  /** 绑定的设备：CUDA0 / Vulkan1 / CPU…；空字符串表示交给 llama.cpp 自己挑 */
  device: string
  ctx: number
  pid: number | null
  proc: ChildProcess | null
  /** 进程拉起时刻（ms）。用于区分「还在启动」和「僵死」——只看 pid 在不在是不够的 */
  startedAt: number
  /** 这个实例的 stdout/stderr 落到哪个文件（父进程退出后子进程还能继续写） */
  logFile: string
  /** 重启要用的启动参数：崩溃自愈时原样再拉一次，不能靠猜 */
  exe: string
  args: string[]
  /** 并发槽位数；0 表示没显式指定（由 llama.cpp 自行决定） */
  parallel: number
}

const instances = new Map<string, LlamaInstance>()

/**
 * 最近一次异常退出。以前 `stdio: 'ignore'` 一开，llama-server 崩了不留任何
 * 线索，只能靠猜是显存、参数还是模型文件坏了。现在退出码 + 日志尾部都留着。
 */
interface CrashInfo {
  code: number | null
  signal: string | null
  at: number
  /** 日志尾部若干行：真正的死因通常就在最后几行 */
  tail: string
}
const crashes = new Map<string, CrashInfo>()

/** 主动停止的实例：exit 事件要用它区分「我们杀的」和「它自己崩了」 */
const stopping = new Set<string>()

/** 已经上报过一次的崩溃，避免反复弹同一份日志 */
export function lastCrashOf(key: string): CrashInfo | undefined {
  return crashes.get(key)
}

function baseUrlOf(port: number): string {
  return `http://127.0.0.1:${port}/v1`
}

/** 老版本只记一个 pid，保留读取：升级后第一次启动能把残留进程清掉 */
function pidFile(): string {
  return path.join(app.getPath('userData'), 'llama.pid')
}

/** 多实例状态文件：进程崩溃后下次启动据此清理，别让僵尸进程占着显存 */
function stateFile(): string {
  return path.join(app.getPath('userData'), 'llama.json')
}

/** 把当前所有实例写进状态文件（进程自己崩了也能被下次启动收拾干净） */
async function persistState(): Promise<void> {
  const rows = [...instances.values()].map((i) => ({
    pid: i.pid,
    port: i.port,
    model: i.model,
    device: i.device,
    ctx: i.ctx
  }))
  await fs.writeFile(stateFile(), JSON.stringify(rows, null, 2), 'utf8').catch(() => undefined)
}

/** 端口上有没有服务在应答（本程序之外的实例，比如用户手动起的） */
async function statusByPort(port: number): Promise<{
  running: boolean
  loading?: boolean
  models?: string[]
  message: string
}> {
  try {
    const res = await fetchWithTimeout(`${baseUrlOf(port)}/models`, 2500)
    if (!res.ok) {
      // llama-server 加载模型期间会返回 503，这不是故障
      const loading = res.status === 503
      return {
        running: false,
        loading,
        message: loading ? '模型加载中…' : `端口已占用但返回 HTTP ${res.status}`
      }
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }> }
    const models = (json.data ?? []).map((m) => m.id ?? '').filter(Boolean)
    return { running: true, models, message: '服务运行中' }
  } catch {
    return { running: false, message: '服务未运行' }
  }
}

/** 每个实例一份日志，放在 userData/logs 下，按端口区分 */
function logFileOf(port: number): string {
  return path.join(app.getPath('userData'), 'logs', `llama-${port}.log`)
}

const LOG_MAX_BYTES = 8 * 1024 * 1024

/**
 * 打开日志 fd 交给子进程直接写。
 *
 * 不用 `stdio: 'pipe'` 是有意的：子进程是 detached + unref 的，父进程一退出管道就断，
 * llama-server 再写一行日志就可能 EPIPE。直接把文件句柄继承给子进程，父子谁死都不影响。
 */
function openLogFd(file: string): number | null {
  try {
    fsSync.mkdirSync(path.dirname(file), { recursive: true })
    try {
      if (fsSync.statSync(file).size > LOG_MAX_BYTES) {
        const old = `${file}.1`
        try {
          fsSync.unlinkSync(old)
        } catch {
          // 没有旧归档
        }
        fsSync.renameSync(file, old)
      }
    } catch {
      // 文件还不存在
    }
    return fsSync.openSync(file, 'a')
  } catch {
    return null
  }
}

/** 读日志尾部：崩溃现场的最后几十行比任何猜测都有用 */
function readLogTail(file: string, lines = 40): string {
  try {
    const size = fsSync.statSync(file).size
    const start = Math.max(0, size - 16 * 1024)
    const fd = fsSync.openSync(file, 'r')
    const buf = Buffer.alloc(size - start)
    fsSync.readSync(fd, buf, 0, buf.length, start)
    fsSync.closeSync(fd)
    return buf
      .toString('utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(-lines)
      .join('\n')
  } catch {
    return ''
  }
}

/**
 * 「以为它还活着」是这个文件里最难查的 bug。
 *
 * 实例表只记得我们 spawn 过一个 pid，但进程可能早就没了：崩了、被任务管理器杀了、
 * 切模型时 taskkill 没退净、甚至 pid 被系统回收给了别的程序。原来复用前只看
 * `running.pid` 是否为真，于是请求打到死端口上，前端会一直停在「生成中」，
 * 直到 openai.ts 那 10 分钟超时才报一个与真实原因无关的网络错误。
 *
 * 这里做一次端到端回验：端口能应答（含 503 加载中）就算活；端口不通再看进程，
 * 仍在启动宽限期内算活（llama-server 从 spawn 到 listen 之间要加载模型）。
 */
const STARTUP_GRACE_MS = 120_000

async function probeInstance(inst: LlamaInstance): Promise<{ alive: boolean; reason: string }> {
  const st = await statusByPort(inst.port)
  if (st.running) return { alive: true, reason: 'running' }
  if (st.loading) return { alive: true, reason: 'loading' }
  if (inst.pid && isLlamaPid(inst.pid)) {
    const age = Date.now() - (inst.startedAt || 0)
    if (age < STARTUP_GRACE_MS) return { alive: true, reason: 'starting' }
    return { alive: false, reason: `进程 ${inst.pid} 存活但端口 ${inst.port} 超过 120 秒无应答（僵死）` }
  }
  return { alive: false, reason: st.message }
}

/**
 * 崩溃自愈：限 3 次、指数退避。
 *
 * 不设上限的重启只会把「一次报错」变成「崩溃→重启→再崩」烧一晚上机器，
 * 而 llama-server 崩溃绝大多数是显存不足、模型文件损坏或参数非法 —— 重启不会自愈。
 * 所以超过次数就停在 error 态，把退出码和日志尾部交给状态查询去报。
 */
const RESTART_DELAYS_MS = [2_000, 6_000, 18_000]
const restartCounts = new Map<string, number>()

/** 已经重试了几次（状态查询用：0 表示没崩过，等于上限表示已经放弃自愈） */
export function restartCountOf(key: string): number {
  return restartCounts.get(key) ?? 0
}

interface LaunchSpec {
  key: string
  exe: string
  args: string[]
  port: number
  model: string
  mmproj: string | null
  device: string
  ctx: number
  parallel?: number
}

function launch(spec: LaunchSpec): LlamaInstance {
  const logFile = logFileOf(spec.port)
  const logFd = openLogFd(logFile)
  const stdio: 'ignore' | Array<'ignore' | number> = logFd === null ? 'ignore' : ['ignore', logFd, logFd]
  const child = spawn(spec.exe, spec.args, {
    cwd: path.dirname(spec.exe),
    detached: true,
    stdio,
    windowsHide: true
  })
  // 子进程已经继承了这两个句柄，父进程这份要立刻关掉，否则日志删不掉、轮转也会失败
  if (logFd !== null) {
    try {
      fsSync.closeSync(logFd)
    } catch {
      // 忽略
    }
  }
  child.unref()

  const inst: LlamaInstance = {
    key: spec.key,
    port: spec.port,
    model: spec.model,
    mmproj: spec.mmproj,
    device: spec.device,
    ctx: spec.ctx,
    pid: child.pid ?? null,
    proc: child,
    startedAt: Date.now(),
    logFile,
    exe: spec.exe,
    args: spec.args,
    parallel: spec.parallel ?? 0
  }
  instances.set(spec.key, inst)
  void persistState()

  // spawn 本身失败（exe 不存在、权限不足）不会触发 exit，只会触发 error
  child.on('error', (err) => {
    crashes.set(spec.key, {
      code: null,
      signal: null,
      at: Date.now(),
      tail: `spawn error: ${err.message}`
    })
    if (instances.get(spec.key) === inst) {
      instances.delete(spec.key)
      void persistState()
    }
  })

  child.on('exit', (code, signal) => handleExit(inst, code, signal))
  return inst
}

function handleExit(inst: LlamaInstance, code: number | null, signal: string | null): void {
  const key = inst.key
  // 主动杀的不算崩溃；只有非零退出才记现场，否则「切模型」也会被记成崩溃
  const intentional = stopping.delete(key)
  const crashed = !intentional && (code ?? 0) !== 0
  if (crashed) {
    crashes.set(key, {
      code: code ?? null,
      signal: signal ?? null,
      at: Date.now(),
      tail: readLogTail(inst.logFile)
    })
  }
  // 只清自己这条：另一个实例的 pid 和端口不能跟着没
  if (instances.get(key) === inst) {
    instances.delete(key)
    void persistState()
  }
  if (!crashed) return
  // 外部认领的服务没有启动参数，重启不了
  if (!inst.exe) return

  const attempt = (restartCounts.get(key) ?? 0) + 1
  if (attempt > RESTART_DELAYS_MS.length) return
  restartCounts.set(key, attempt)
  const timer = setTimeout(() => {
    // 用户可能已经手动重启、或者切了模型，这时别再插一脚
    if (instances.has(key)) return
    launch({
      key,
      exe: inst.exe,
      args: inst.args,
      port: inst.port,
      model: inst.model,
      mmproj: inst.mmproj,
      device: inst.device,
      ctx: inst.ctx
    })
  }, RESTART_DELAYS_MS[attempt - 1])
  timer.unref?.()
}

/** 挑一个没被本程序实例占用的端口：优先用指定的，其次 8080 往后 */
function pickPort(preferred?: number, busy?: Set<number>): number {
  const used = new Set([...instances.values()].map((i) => i.port))
  if (busy) for (const p of busy) used.add(p)
  const own = Number(preferred)
  if (Number.isFinite(own) && own >= 1024 && own <= 65535 && !used.has(Math.round(own))) {
    return Math.round(own)
  }
  for (const p of LLAMA_PORTS) if (!used.has(p)) return p
  let p = LLAMA_PORTS[LLAMA_PORTS.length - 1] + 1
  while (used.has(p)) p++
  return p
}


function killPidSync(pid: number): void {
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true })
  } catch {
    // 进程可能已退出
  }
}

function isLlamaPid(pid: number): boolean {
  try {
    const out =
      spawnSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], {
        encoding: 'utf8',
        windowsHide: true
      }).stdout ?? ''
    return /llama-server\.exe/i.test(out)
  } catch {
    return false
  }
}

function listLlamaPids(): number[] {
  try {
    const out =
      spawnSync('tasklist', ['/fi', 'IMAGENAME eq llama-server.exe', '/fo', 'csv', '/nh'], {
        encoding: 'utf8',
        windowsHide: true
      }).stdout ?? ''
    const pids: number[] = []
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/"llama-server\.exe","(\d+)"/i)
      if (m) pids.push(Number(m[1]))
    }
    return pids
  } catch {
    return []
  }
}

/** 程序所在根目录：便携版为 exe 所在目录，开发态为仓库根目录 */
function appBase(): string {
  return (
    process.env.PORTABLE_EXECUTABLE_DIR ||
    (app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath())
  )
}

/** llama.cpp 可执行文件目录 */
export function llamaRoot(): string {
  return path.join(appBase(), 'llama.cpp')
}

/** 模型目录：可放在软件根目录的 models/ 下 */
export function modelsRoot(): string {
  return path.join(appBase(), 'models')
}

/**
 * 「简易核心」自己的目录：软件根目录下的 core/。
 *
 * 单独开一个英文目录，而不是混进 models/：一键核心下载的模型是这套流程自己管的东西，
 * 用户往里扔别的 .gguf 也不会互相顶掉；扫描时一起认，界面上照样能选。
 */
export function coreRoot(): string {
  return path.join(appBase(), 'core')
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
}

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** 本机是否有 NVIDIA 显卡（决定安装 CPU 版还是 CUDA 版） */
function hasNvidiaGpu(): boolean {
  try {
    const r = spawnSync('nvidia-smi', ['-L'], { windowsHide: true, timeout: 5000, encoding: 'utf8' })
    return r.status === 0 && /GPU\s+\d+/i.test(r.stdout ?? '')
  } catch {
    return false
  }
}

type Backend = 'cuda' | 'vulkan' | 'hip' | 'cpu'

/**
 * 检查 llama.cpp 目录里装的是哪个后端（决定会不会占用显存）。
 *
 * `installed` 单独报一次：目录不存在、或者里面没有 llama-server.exe 时，
 * 这是「没装」，不是「装了 CPU 版」——界面必须能分清，否则首次运行会误报 CPU 版。
 */
export async function detectBackend(): Promise<{ backend: Backend; gpuReady: boolean; installed: boolean }> {
  // 主程序不在就当没装，连带文件清单都不用看
  const installed = (await llamaServerExe()) !== null
  if (!installed) return { backend: 'cpu', gpuReady: false, installed: false }
  const files = await fs.readdir(llamaRoot()).catch(() => [] as string[])
  const has = (re: RegExp) => files.some((f) => re.test(f))
  if (has(/^ggml-cuda.*\.dll$/i)) return { backend: 'cuda', gpuReady: true, installed: true }
  if (has(/^ggml-vulkan\.dll$/i)) return { backend: 'vulkan', gpuReady: true, installed: true }
  if (has(/^ggml-hip.*\.dll$/i)) return { backend: 'hip', gpuReady: true, installed: true }
  return { backend: 'cpu', gpuReady: false, installed: true }
}

interface InstallPlan {
  main: ReleaseAsset
  /** cudart 运行库是独立包，需要和主包解压到同一目录 */
  extras: ReleaseAsset[]
}

/** 只有 `llama-*` 开头的是主程序包 */
function isMainPackage(name: string): boolean {
  return /^llama-[^/]+-bin-win-/i.test(name) && !/^cudart-/i.test(name)
}

/**
 * 按本机有没有 N 卡，从某个版本的产物里挑主包 + 配套 cudart。
 *
 * 坑：`cudart-llama-bin-win-cuda-12.4-x64.zip` 的名字同样以
 * `-bin-win-cuda-12.4-x64.zip` 结尾，且在 GitHub 的资产列表里永远排最前
 * （它体积 373MB，比主包还大）。如果不过滤前缀，它会被当成主包下载解压，
 * 结果目录里只有 cublas/cudart 三个 dll，永远找不到 llama-server.exe。
 */
function planFromAssets(assets: ReleaseAsset[], gpu: boolean): InstallPlan | null {
  const pool = assets.filter((a) => isMainPackage(a.name))
  const main = gpu
    ? // 官方包名：llama-bXXXX-bin-win-cuda-12.4-x64.zip / -cuda-13.4- / -vulkan- / -cpu-
      pool.find((a) => /-bin-win-cuda-12\.\d+-x64\.zip$/i.test(a.name)) ||
      pool.find((a) => /-bin-win-cuda-[^/]+-x64\.zip$/i.test(a.name)) ||
      pool.find((a) => /-bin-win-vulkan-x64\.zip$/i.test(a.name)) ||
      pool.find((a) => /-bin-win-cpu-x64\.zip$/i.test(a.name))
    : pool.find((a) => /-bin-win-vulkan-x64\.zip$/i.test(a.name)) ||
      pool.find((a) => /-bin-win-cpu-x64\.zip$/i.test(a.name))
  if (!main) return null

  const extras: ReleaseAsset[] = []
  const cudaVer = main.name.match(/-bin-win-cuda-([\d.]+)-x64\.zip$/i)?.[1]
  if (cudaVer) {
    const cudart = assets.find((a) => {
      const m = a.name.match(/^cudart-llama-bin-win-cuda-([\d.]+)-x64\.zip$/i)
      return m && m[1] === cudaVer
    })
    if (cudart) extras.push(cudart)
  }
  return { main, extras }
}

/** 直连 GitHub API 取产物清单（被墙 / 限流时返回 null） */
async function planViaApi(): Promise<InstallPlan | null> {
  try {
    const res = await fetchWithTimeout(RELEASE_API, 15000, {
      headers: { 'user-agent': 'roroto-code', accept: 'application/vnd.github+json' }
    })
    if (!res.ok) return null
    const releases = (await res.json()) as Array<{ assets?: ReleaseAsset[] }>
    const gpu = hasNvidiaGpu()
    for (const rel of releases) {
      const plan = planFromAssets(rel.assets ?? [], gpu)
      if (plan) return plan
    }
    return null
  } catch {
    return null
  }
}

/** 从（可能是镜像的）发布页扒出最新版本号 bXXXXX */
async function latestTag(): Promise<string | null> {
  for (const m of MIRRORS) {
    try {
      const res = await fetchWithTimeout(`${m.prefix}${RELEASES_LATEST}`, 20000, {
        redirect: 'follow',
        headers: { 'user-agent': 'roroto-code' }
      })
      if (!res.ok) continue
      const html = await res.text()
      const hit = html.match(/releases\/tag\/(b\d{3,6})/i) ?? html.match(/\b(b\d{4,6})\b/i)
      if (hit) return hit[1]
    } catch {
      // 换下一个镜像
    }
  }
  return null
}

/** 用 HEAD 探一下某个产物在哪个源上存在；返回官方地址（下载时再套镜像前缀） */
async function probeAsset(tag: string, name: string): Promise<string | null> {
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${name}`
  for (const m of MIRRORS) {
    try {
      const res = await fetchWithTimeout(`${m.prefix}${url}`, 15000, {
        method: 'HEAD',
        redirect: 'follow',
        headers: { 'user-agent': 'roroto-code' }
      })
      if (!res.ok) continue
      const len = Number(res.headers.get('content-length') ?? 0)
      if (len === 0 || len > 1024 * 1024) return url
    } catch {
      // 换下一个镜像
    }
  }
  return null
}

/**
 * API 不通时的兜底：拿最新 tag，按官方命名规则拼产物地址，逐个探。
 * 内地经常连不上 api.github.com，但镜像能打开发布页，这条路比直接放弃强。
 */
async function planViaMirror(): Promise<InstallPlan | null> {
  const tag = await latestTag()
  if (!tag) return null
  const gpu = hasNvidiaGpu()
  const candidates = gpu
    ? [
        `llama-${tag}-bin-win-cuda-12.4-x64.zip`,
        `llama-${tag}-bin-win-cuda-13.4-x64.zip`,
        `llama-${tag}-bin-win-vulkan-x64.zip`,
        `llama-${tag}-bin-win-cpu-x64.zip`
      ]
    : [`llama-${tag}-bin-win-vulkan-x64.zip`, `llama-${tag}-bin-win-cpu-x64.zip`]

  for (const name of candidates) {
    const url = await probeAsset(tag, name)
    if (!url) continue
    const assets: ReleaseAsset[] = [{ name, browser_download_url: url }]
    const cudaVer = name.match(/-bin-win-cuda-([\d.]+)-x64\.zip$/i)?.[1]
    if (cudaVer) {
      const cname = `cudart-llama-bin-win-cuda-${cudaVer}-x64.zip`
      const curl = await probeAsset(tag, cname)
      if (curl) assets.push({ name: cname, browser_download_url: curl })
    }
    const plan = planFromAssets(assets, gpu)
    if (plan) return plan
  }
  return null
}

async function latestAsset(): Promise<InstallPlan> {
  const plan = (await planViaApi()) ?? (await planViaMirror())
  if (!plan) {
    throw new Error(
      '取不到 llama.cpp 版本信息（GitHub API 和镜像都不通）。请展开「下载地址」用浏览器手动下载 zip，解压到 llama.cpp/ 目录后再点「自动配置」。'
    )
  }
  return plan
}

/** 校验下载到的是不是 zip：前两个字节应为 `PK`，防止把镜像的错误页当安装包解压 */
async function looksLikeZip(file: string): Promise<boolean> {
  try {
    const fh = await fs.open(file, 'r')
    try {
      const buf = Buffer.alloc(4)
      const { bytesRead } = await fh.read(buf, 0, 4, 0)
      return bytesRead >= 2 && buf[0] === 0x50 && buf[1] === 0x4b
    } finally {
      await fh.close()
    }
  } catch {
    return false
  }
}

function expandArchive(zip: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const q = (s: string) => s.replace(/'/g, "''")
    const ps = `Expand-Archive -LiteralPath '${q(zip)}' -DestinationPath '${q(dest)}' -Force`
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true }
    )
    let err = ''
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`解压失败（退出码 ${code}）：${err.trim()}`))
    })
  })
}

async function findServer(dir: string, depth = 0): Promise<string | null> {
  if (depth > 4) return null
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    if (e.isFile() && /^llama-server\.exe$/i.test(e.name)) return path.join(dir, e.name)
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = await findServer(path.join(dir, e.name), depth + 1)
      if (found) return found
    }
  }
  return null
}

async function walkGguf(dir: string, acc: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 6) return acc
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) await walkGguf(full, acc, depth + 1)
    else if (/\.gguf$/i.test(e.name)) acc.push(full)
  }
  return acc
}

/** 文件名里属于「格式 / 量化 / 用途」的词，配对投影器时不算模型身份 */
const NAME_NOISE = new Set([
  'gguf', 'mmproj', 'projector', 'vision', 'clip', 'model', 'it', 'instruct', 'chat',
  'bf16', 'f16', 'f32', 'fp16', 'q4', 'q5', 'q6', 'q8', 'k', 'm', 's', 'l',
  '0', '1', 'unsloth', 'imatrix', 'quantized'
])

/** gemma-4-12b-it-Q4_K_M.gguf → [gemma, 4, 12b] */
function identityTokens(name: string): string[] {
  return path
    .basename(name)
    .replace(/\.gguf$/i, '')
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((t) => t && !NAME_NOISE.has(t))
}

/** 参数规模 token：12b / 9b / e4b。用来避免把 12B 的投影器配给 E4B 主模型 */
function sizeToken(tokens: string[]): string | undefined {
  return tokens.find((t) => /^[a-z]?\d+(?:\.\d+)?b$/.test(t))
}

/** 这个 .gguf 是不是多模态投影器（不是能单独加载的主模型） */
async function isMmprojPath(file: string): Promise<boolean> {
  if (/mmproj|projector/i.test(path.basename(file))) return true
  const meta = await readGgufMeta(file)
  return meta.type === 'mmproj' || meta.architecture === 'clip'
}

/**
 * 给主模型找配套的 mmproj；找不到就返回 null（宁可不传，也不能配错）。
 *
 * llama-server 用 -m 加载本地 GGUF 时，不会自己去 models/ 里找同目录的投影器，
 * --mmproj-auto 只对 -hf 在线下载生效，所以必须由本程序显式传 --mmproj。
 *
 * 优先级：环境变量 LLAMA_ARG_MMPROJ > 配置里 llamacpp 的 mmproj 字段 > 同目录按名字自动配对。
 */
async function findMmprojFor(
  modelPath: string,
  providerId?: string,
  opts?: { ignoreConfig?: boolean }
): Promise<string | null> {
  const dir = path.dirname(modelPath)
  // 列表标注用 ignoreConfig：那里问的是「这个模型自己有没有配套投影器」，
  // 不该被环境变量或某条配置的显式覆盖带偏。
  const envPath = opts?.ignoreConfig ? '' : process.env.LLAMA_ARG_MMPROJ?.trim()
  let cfgPath = ''
  if (!opts?.ignoreConfig) {
    try {
      const cfg = await loadConfig()
      // 只读「这个实例自己的」配置：多实例下按 8080 猜供应商会读错人
      const p = providerId
        ? cfg.providers.find((x) => x.id === providerId)
        : cfg.providers.find((x) => x.id === 'llamacpp') || cfg.providers.find((x) => isLlamaProvider(x))
      cfgPath = p?.mmproj?.trim() ?? ''
    } catch {
      // 配置读不到就走自动配对
    }
  }

  // 显式指定：信任用户，只校验文件存在
  for (const raw of [envPath, cfgPath]) {
    if (!raw) continue
    const cand = path.isAbsolute(raw) ? raw : path.join(dir, raw)
    try {
      await fs.access(cand)
      return cand
    } catch {
      // 路径无效就继续往下找
    }
  }

  // 「同目录同前缀」硬配对：core/ 刻意把两个文件叫 Core.gguf / mmproj-Core.gguf，
  // 主模型名只有一个身份 token，下面的打分规则再怎么放宽，也不如名字严格对应准。
  // 命中后还要读元数据确认确实是投影器，避免把同名主模型当投影器挂上去。
  const base = path.basename(modelPath)
  const stem = base.replace(/\.gguf$/i, '')
  const exactNames = new Set([`mmproj-${base}`, `mmproj-${stem}.gguf`, `${stem}-mmproj.gguf`])
  for (const name of exactNames) {
    const cand = path.join(dir, name)
    if (cand.toLowerCase() === modelPath.toLowerCase()) continue
    try {
      await fs.access(cand)
    } catch {
      continue
    }
    const meta = await readGgufMeta(cand)
    if (meta.type === 'mmproj' || meta.architecture === 'clip') return cand
  }

  const mainTokens = identityTokens(path.basename(modelPath))
  const mainSize = sizeToken(mainTokens)
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  let best: { file: string; score: number } | null = null

  for (const name of entries) {
    if (!/\.gguf$/i.test(name) || !/mmproj|projector/i.test(name)) continue
    const file = path.join(dir, name)
    const meta = await readGgufMeta(file)
    if (meta.type !== 'mmproj' && meta.architecture !== 'clip') continue

    const tokens = identityTokens(name)
    const shared = mainTokens.filter((t) => tokens.includes(t))
    // 名字短到只剩一个身份 token 时（core/ 的 Core.gguf 就是这种情况），
    // 「两边完全一致」已经足够确定，别再要求 >=2 个共享 token —— 那条门槛
    // 会让固定名的核心模型永远配不上投影器，静默退化成纯文本模式。
    const exactIdentity =
      mainTokens.length === 1 && tokens.length === 1 && mainTokens[0] === tokens[0]
    if (shared.length < 2 && !exactIdentity) continue
    // 两边都读得出参数规模时必须一致；读不出时要求身份覆盖率够高
    const projSize = sizeToken(tokens)
    if (mainSize && projSize && mainSize !== projSize) continue
    if ((!mainSize || !projSize) && shared.length / Math.max(1, mainTokens.length) < 0.7) continue
    const score = shared.length / Math.max(1, Math.max(mainTokens.length, tokens.length))
    if (!best || score > best.score) best = { file, score }
  }
  return best?.file ?? null
}

/**
 * 没找到投影器时给一句人话，只对**确定是视觉模型**的主模型说。
 *
 * 纯文本模型（qwen2 / qwen35 / gemma4 的文本权重）不说 —— 那种「看不了图」
 * 是正常状态，天天提示只会变成噪音。两种情况给不同补救办法：
 * 目录里有投影器但名字对不上 vs 压根没有。
 */
async function missingProjectorNote(modelPath: string): Promise<string> {
  const meta = await readGgufMeta(modelPath).catch(() => null)
  if (!meta || !ggufLooksVision(meta.architecture, meta.name)) return ''
  const stem = path.basename(modelPath).replace(/\.gguf$/i, '')
  const dir = path.dirname(modelPath)
  const others = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) =>
    /mmproj|projector/i.test(n)
  )
  if (others.length) {
    return `\n注意：${stem} 是视觉模型，同目录有投影器（${others[0]}）但没能和它对上。把它改名成 ${stem}-mmproj.gguf 再启动，就能看图。`
  }
  return `\n注意：${stem} 是视觉模型，但没找到配套的投影器（mmproj），本次按纯文本加载，图片会被忽略。补救办法：把 ${stem}-mmproj.gguf 放到同一目录，或到「② 本地模型 → 获取模型」重新下载这个模型（会连带下载投影器）。`
}

/** 汇总两个模型目录（llama.cpp/ 与 models/）下的所有主模型 .gguf 绝对路径（排除 mmproj） */
async function allGgufs(): Promise<string[]> {
  const [a, b, c] = await Promise.all([
    walkGguf(llamaRoot()),
    walkGguf(modelsRoot()),
    // 简易核心下到 core/ 的模型也要能被识别/启动，否则「装好了却选不到」
    walkGguf(coreRoot())
  ])
  const files = Array.from(new Set([...a, ...b, ...c]))
  const flags = await Promise.all(files.map(isMmprojPath))
  return files.filter((_, i) => !flags[i])
}

/** llama-server.exe 的绝对路径（没装返回 null）：简易核心据此决定要不要下载 */
export async function llamaServerExe(): Promise<string | null> {
  return await findServer(llamaRoot())
}

/** 正在进行的安装（用于「取消下载」） */
let installAbort: AbortController | null = null

export function cancelLlamaInstall(): { ok: boolean; message: string } {
  if (!installAbort) return { ok: false, message: '当前没有正在进行的下载' }
  installAbort.abort()
  return { ok: true, message: '正在取消下载…' }
}

/** 目标目录里是否已经有该大版本的 cudart 运行库（有就不再重复下 373MB） */
async function hasCudart(dir: string, ver: string): Promise<boolean> {
  const major = ver.split('.')[0]
  const files = await fs.readdir(dir).catch(() => [] as string[])
  const has = (re: RegExp) => files.some((f) => re.test(f))
  return has(new RegExp(`^cudart64_${major}\\.dll$`, 'i')) && has(new RegExp(`^cublas64_${major}\\.dll$`, 'i'))
}

export async function installLlama(
  onProgress?: (p: SetupProgress) => void
): Promise<{ ok: boolean; message: string; dir?: string; exe?: string }> {
  const dir = llamaRoot()
  const tmp: string[] = []
  const signal = new AbortController()
  installAbort = signal
  const emit = (p: SetupProgress) => onProgress?.(p)
  try {
    await fs.mkdir(dir, { recursive: true })

    // 版本信息可能要试直连 + 镜像，先给个阶段提示，别让界面像卡死
    emit({ kind: 'llama', receivedBytes: 0, totalBytes: 0, state: 'preparing', message: '正在获取最新版本信息…' })
    const plan = await latestAsset()
    if (!isMainPackage(plan.main.name)) {
      throw new Error(`获取到的安装包不是主程序包（${plan.main.name}），请稍后重试或手动下载`)
    }
    const all = [plan.main, ...plan.extras]
    emit({
      kind: 'llama',
      receivedBytes: 0,
      totalBytes: 0,
      state: 'preparing',
      message: `将下载 ${all.map((a) => a.name).join('、')}`
    })

    const used: string[] = []
    // 下载到固定的临时目录：中途失败时文件会保留，下次点「一键安装」直接从断点续传，
    // 不再像以前那样每次换源 / 重试都从 0 开始。
    const dlDir = path.join(os.tmpdir(), 'roro-dl')
    await fs.mkdir(dlDir, { recursive: true }).catch(() => undefined)
    for (const asset of all) {
      if (signal.signal.aborted) throw new Error('已取消下载')
      // CUDA 运行库体积比主包还大，目录里已经有了就跳过
      const cudartVer = asset.name.match(/^cudart-llama-bin-win-cuda-([\d.]+)-x64\.zip$/i)?.[1]
      if (cudartVer && (await hasCudart(dir, cudartVer))) {
        emit({
          kind: 'llama',
          receivedBytes: 0,
          totalBytes: 0,
          state: 'extracting',
          file: asset.name,
          message: `CUDA ${cudartVer} 运行库已存在，跳过下载 ${asset.name}`
        })
        continue
      }
      const zip = path.join(dlDir, asset.name)
      tmp.push(zip)
      const source = await downloadFromGithub(asset.browser_download_url, zip, {
        signal: signal.signal,
        onTick: (t) =>
          emit({
            kind: 'llama',
            receivedBytes: t.received,
            totalBytes: t.total,
            bytesPerSec: t.speed,
            source: t.source,
            file: asset.name,
            state: 'downloading',
            message: t.resumed && t.received > 0 ? `从 ${(t.received / 1024 / 1024).toFixed(0)} MB 处续传` : undefined
          })
      })
      used.push(`${asset.name}（${source}）`)
      // 有些镜像会把错误页当成 200 返回，解压前先确认确实是个 zip
      if (!(await looksLikeZip(zip))) {
        await fs.unlink(zip).catch(() => undefined)
        throw new Error(`${asset.name} 下载内容不是有效的压缩包（源：${source}），已丢弃，请重试`)
      }
      emit({
        kind: 'llama',
        receivedBytes: 0,
        totalBytes: 0,
        state: 'extracting',
        file: asset.name,
        source,
        message: `正在解压 ${asset.name}…`
      })
      await expandArchive(zip, dir)
    }
    for (const z of tmp) await fs.unlink(z).catch(() => undefined)
    const exe = await findServer(dir)
    if (!exe) {
      const files = await fs.readdir(dir).catch(() => [] as string[])
      // 只解出 cublas/cudart 这类运行库，说明拿到的不是主程序包
      const onlyRuntime =
        files.some((f) => /^cublas/i.test(f)) && !files.some((f) => /^llama-.*\.exe$/i.test(f))
      const msg = onlyRuntime
        ? `解压后只有 CUDA 运行库、没有 llama-server.exe。请重试；若仍失败，展开「下载地址」手动下载主程序包解压到 ${dir}`
        : `解压完成，但未找到 llama-server.exe（${dir} 下共 ${files.length} 个文件）`
      emit({ kind: 'llama', receivedBytes: 0, totalBytes: 0, state: 'error', message: msg })
      return { ok: false, message: msg, dir }
    }
    const { backend } = await detectBackend()
    const kind =
      backend === 'cuda'
        ? 'CUDA 版（会使用显卡）'
        : backend === 'vulkan'
          ? 'Vulkan 版（会使用显卡）'
          : backend === 'hip'
            ? 'ROCm 版（会使用显卡）'
            : 'CPU 版（不使用显卡）'
    emit({ kind: 'llama', receivedBytes: 0, totalBytes: 0, state: 'done', message: `安装完成：${kind}` })
    return {
      ok: true,
      message: `已安装 llama.cpp 到 ${dir}\n后端：${kind}\n来源：${used.join('、')}`,
      dir,
      exe
    }
  } catch (err) {
    // 故意不删临时文件：已下载的字节要留着，下次点安装才能断点续传
    const msg = (err as Error).message
    const cancelled = signal.signal.aborted || /已取消/.test(msg)
    emit({
      kind: 'llama',
      receivedBytes: 0,
      totalBytes: 0,
      state: 'error',
      message: cancelled ? '已取消下载（已下载部分已保留，下次会从断点继续）' : msg
    })
    return {
      ok: false,
      message: cancelled ? '已取消下载（已下载部分已保留，重新点击会从断点继续）' : `安装失败：${msg}`,
      dir
    }
  } finally {
    if (installAbort === signal) installAbort = null
  }
}

interface ApplyResult {
  ok: boolean
  message: string
  model?: string
  providerId: string
  created: boolean
}

/**
 * 启动 llama-server 时用的上下文长度。
 *
 * 以前写死 8192，但配置里记的是 16384，程序按 16384 的 70% 给对话留预算，
 * 服务端却只认 8K，超出的部分被静默截断。现在直接读配置，两边对齐；
 * 用户想放大就到「模型设置 → llama.cpp → 上下文窗口」改。
 */
async function serverCtx(providerId?: string): Promise<number> {
  try {
    const cfg = await loadConfig()
    const p = providerId
      ? cfg.providers.find((x) => x.id === providerId)
      : cfg.providers.find((x) => x.id === 'llamacpp') || cfg.providers.find((x) => isLlamaProvider(x))
    // 「限制上下文」关掉时只认这一条自己的上限，不再被软件设置里的那个数压住
    const own = Math.round(p?.contextWindow || 16384)
    // 软件设置里的全局值优先（仅当开了限制），但不能超过这个条目自己写的上限
    const n = cfg.contextLimit === true ? Math.min(Math.round(cfg.contextWindow || 32768), own) : own
    if (n >= 2048) return Math.min(n, CONTEXT_RANGE.max)
  } catch {
    // 读不到配置就用默认值，不能因为这个起不来
  }
  return 16384
}

/**
 * 把这次启动的结果写回配置。
 *
 * 和以前的关键差别：**指定了 providerId 就不动 activeId**。
 * 老逻辑每次启动都把 activeId 设成自己，双实例下起第二个模型会把用户正在聊的模型切走。
 */
async function applyLlamaConfig(
  providerId?: string,
  model?: string,
  ctx?: number,
  llamaVision?: boolean,
  port?: number
): Promise<ApplyResult> {
  const config = await loadConfig()
  const providers: ProviderConfig[] = config.providers.map((p) => ({ ...p }))
  const url = baseUrlOf(port ?? LLAMA_PORT)
  let target = providerId
    ? providers.find((p) => p.id === providerId)
    : providers.find((p) => p.id === 'llamacpp') || providers.find((p) => isLlamaProvider(p))

  // 点名要的供应商不存在了（配置被改过）：不要凭空造一个 id 对不上的条目
  if (providerId && !target) {
    return { ok: false, message: `配置里找不到供应商 ${providerId}，请重新创建`, providerId, created: false }
  }

  const created = !target
  if (!target) {
    target = {
      id: 'llamacpp',
      name: 'llama.cpp 本地',
      kind: 'openai',
      baseUrl: url,
      apiKey: 'no-key',
      model: model ?? '',
      contextWindow: ctx ?? 16384,
      temperature: 0.2,
      runtime: 'llama'
      // 不写 port：留空才是「自动探测」。实际端口记在 baseUrl 里，
      // 下次启动 llamaPortOf() 会从这里读回同一个起点，端口不会漂移。
    }
    providers.push(target)
  } else {
    target.baseUrl = url
    target.kind = 'openai'
    target.runtime = 'llama'
    // 自动选中的端口只落到 baseUrl，绝不写进 port —— 否则界面输入框会冒出一个
    // 「用户从没填过」的值，下次启动就被当成手动指定，自动探测再也轮不到。
    // 只有用户本来就在设置里填了端口时，才把实际值同步回去。
    if (port && typeof target.port === 'number') target.port = port
    if (!target.apiKey) target.apiKey = 'no-key'
    if (model) target.model = model
    // 服务端按 ctx 开了多大，配置就记多大：写小了预算跟着缩水，白开那么多显存
    if (ctx && ctx >= 2048) target.contextWindow = Math.min(Math.round(ctx), CONTEXT_RANGE.max)
  }

  // 本地服务有没有真的挂上 mmproj，写进配置：auto 判定直接读这个字段，
  // 不再靠模型名猜（gemma-4-E4B 名字像视觉模型，但并没有配套投影器）。
  if (llamaVision !== undefined) target.llamaVision = llamaVision

  // 没有指定模型、也没有已选模型时，自动挑一个本地 .gguf，
  // 避免新建出来的条目永远是「未选择模型」
  if (!target.model) {
    const ggufs = await allGgufs()
    if (ggufs[0]) target.model = path.basename(ggufs[0])
  }

  // 只有「自动创建 / 老的单实例路径」才顺手切过去；指定 providerId 时保持用户当前选择
  const nextActive = providerId ? config.activeId ?? target.id : target.id
  await saveConfig({ ...config, providers, activeId: nextActive })
  const label = target.model || '未选择模型'
  return {
    ok: true,
    message: created
      ? `已新建本地模型：${label}`
      : model
        ? `已更新本地模型：${label}`
        : `本地模型已就绪：${label}`,
    model: target.model || undefined,
    providerId: target.id,
    created
  }
}

export async function configureLlama(): Promise<{
  ok: boolean
  message: string
  model?: string
  providerId?: string
  created?: boolean
}> {
  try {
    return await applyLlamaConfig()
  } catch (err) {
    return { ok: false, message: `配置失败：${(err as Error).message}` }
  }
}

/** 轮询某个实例，返回 /v1/models 的模型 id 列表；超时返回 null */
async function waitForServer(port: number, ms: number): Promise<string[] | null> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(`${baseUrlOf(port)}/models`, 2000)
      if (res.ok) {
        const json = (await res.json()) as { data?: Array<{ id?: string }> }
        return (json.data ?? []).map((m) => m.id ?? '').filter(Boolean)
      }
    } catch {
      // 服务尚未就绪，继续等待
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return null
}

function pickServedModel(served: string[], fullPath: string): string | undefined {
  const base = path.basename(fullPath).toLowerCase()
  const exact = served.find((m) => m.toLowerCase() === base || path.basename(m).toLowerCase() === base)
  return exact ?? served[0]
}

/**
 * 本程序模型目录里的 .gguf（绝对路径 + 体积），供「导入到 Ollama / LM Studio」用。
 * 和 listLocalModels 的区别：这里只认真实存在的文件，且给的是绝对路径。
 */
export async function localGgufFiles(): Promise<
  Array<{ path: string; name: string; sizeBytes: number; rel: string }>
> {
  const base = appBase()
  const abs = await allGgufs()
  const out: Array<{ path: string; name: string; sizeBytes: number; rel: string }> = []
  for (const f of abs) {
    const st = await fs.stat(f).catch(() => null)
    if (!st || !st.isFile() || st.size === 0) continue
    const rel = path.relative(base, f)
    out.push({
      path: f,
      name: path.basename(f),
      sizeBytes: st.size,
      rel: rel && !rel.startsWith('..') ? rel.replace(/\\/g, '/') : f
    })
  }
  return out.sort((a, b) => b.sizeBytes - a.sizeBytes)
}

export async function listLocalModels(): Promise<{
  ok: boolean
  models: string[]
  dir?: string
  message: string
  /** 相对路径 → 看图状态：ready 有配套投影器，missing 视觉模型缺投影器，text 普通文本模型 */
  vision?: Record<string, 'ready' | 'missing' | 'text'>
}> {
  const abs = await allGgufs()
  const base = appBase()
  const files = abs.map((f) => {
    const rel = path.relative(base, f)
    return rel && !rel.startsWith('..') ? rel.replace(/\\/g, '/') : f
  })
  // 每个成员实例都要问一遍：双卡双模型时，两个模型分别挂在两个端口上
  const ports = new Set<number>([...instances.values()].map((i) => i.port))
  if (!ports.size) ports.add(LLAMA_PORT)
  const server: string[] = []
  for (const port of ports) {
    try {
      const res = await fetchWithTimeout(`${baseUrlOf(port)}/models`, 2000)
      if (!res.ok) continue
      const json = (await res.json()) as { data?: Array<{ id?: string }> }
      server.push(...(json.data ?? []).map((m) => m.id ?? '').filter(Boolean))
    } catch {
      // 这个实例没起来，继续看下一个
    }
  }
  // 服务端返回的 id 可能是绝对路径（同一模型会与 files 重复），按文件名去重
  const seen = new Set(files.map((f) => path.basename(f).toLowerCase()))
  const extra: string[] = []
  for (const m of server) {
    const b = path.basename(m).toLowerCase()
    if (seen.has(b)) continue
    seen.add(b)
    extra.push(m)
  }
  const models = [...files, ...extra]

  // 每个模型都算一次「能不能看图」。读的是 GGUF 文件头和目录列表，不加载权重，
  // 十个模型也就几十毫秒。ignoreConfig：这里问的是模型自己有没有配套投影器，
  // 不该被某条配置里的显式覆盖带偏。
  const vision: Record<string, 'ready' | 'missing' | 'text'> = {}
  await Promise.all(
    files.map(async (rel, i) => {
      const file = abs[i]
      if (!file) return
      if (await findMmprojFor(file, undefined, { ignoreConfig: true })) {
        vision[rel] = 'ready'
        return
      }
      const meta = await readGgufMeta(file).catch(() => null)
      vision[rel] = meta && ggufLooksVision(meta.architecture, meta.name) ? 'missing' : 'text'
    })
  )

  return {
    ok: true,
    models,
    dir: modelsRoot(),
    vision,
    message: models.length
      ? `找到 ${models.length} 个模型`
      : '未找到 .gguf 模型。可放在 llama.cpp/ 或 models/ 目录下'
  }
}

/** 把界面传来的模型名/路径解析成绝对路径；解析不出来时退回第一个本地 .gguf */
async function resolveModelPath(wantedModel?: string): Promise<string> {
  const ggufs = await allGgufs()
  const wanted = wantedModel?.trim() ?? ''
  if (wanted) {
    const candidates = path.isAbsolute(wanted)
      ? [wanted]
      : [path.join(appBase(), wanted), path.join(llamaRoot(), wanted), path.join(modelsRoot(), wanted)]
    for (const cand of candidates) {
      try {
        await fs.access(cand)
        return cand
      } catch {
        // 继续尝试下一个目录
      }
    }
    // 传入的可能是服务端返回的模型 id，按文件名匹配本地 gguf
    const base = path.basename(wanted).toLowerCase()
    const hit = ggufs.find((g) => path.basename(g).toLowerCase() === base)
    if (hit) return hit
  }
  return ggufs[0] ?? ''
}

/**
 * 设备参数。
 *
 * 关键就是 `-dev`：只把层放到指定那一张卡上，llama.cpp 就不会去做跨卡切分，
 * 两张卡各跑一个模型才能真正并行（这是「双卡双模型」而不是「一个模型切两半」）。
 * 顺带把 `-ngl` 写死成 999：不写的话不同版本默认值不一样，可能出现「只放了一半层」。
 */
function deviceArgs(device: string): string[] {
  const d = device.trim()
  if (!d) return []
  if (/^cpu$/i.test(d)) return ['-ngl', '0']
  return ['-dev', d, '-ngl', '999']
}

export interface LlamaStartOptions {
  /** 属于哪个供应商：不同供应商各自一个实例，互不干扰 */
  providerId?: string
  /** 绑定显卡（覆盖配置里的值）；传空字符串表示不绑定 */
  device?: string | null
  /** 指定端口（覆盖配置里的值） */
  port?: number
}

/**
 * 本机能给 llama.cpp 用的设备清单（`llama-server --list-devices`）。
 *
 * 为什么不直接用显卡信息拼：`-dev` 认的是 llama.cpp 自己的设备名（CUDA0 / Vulkan1），
 * 而系统里显卡的排列顺序不一定和它一致。界面让用户从这份清单里选，就不会选错卡。
 */
export async function listLlamaDevices(): Promise<
  Array<{ id: string; name: string; vramMiB?: number; freeMiB?: number }>
> {
  const exe = await findServer(llamaRoot())
  if (!exe) return []
  try {
    const r = spawnSync(exe, ['--list-devices'], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    const rows: Array<{ id: string; name: string; vramMiB?: number; freeMiB?: number }> = []
    for (const line of out.split(/\r?\n/)) {
      // 形如：  CUDA0: NVIDIA GeForce RTX 2080 (8191 MiB, 7113 MiB free)
      const m = line.match(/^\s*([A-Za-z]+\d+):\s*(.+?)\s*(?:\((\d+)\s*MiB,\s*(\d+)\s*MiB free\))?\s*$/)
      if (!m) continue
      rows.push({
        id: m[1],
        name: m[2].trim(),
        vramMiB: m[3] ? Number(m[3]) : undefined,
        freeMiB: m[4] ? Number(m[4]) : undefined
      })
    }
    return rows
  } catch {
    return []
  }
}

/** 当前所有实例（界面展示与「释放显存」逻辑都读它） */
export function llamaInstances(): Array<{
  key: string
  port: number
  model: string
  device: string
  pid: number | null
  ctx: number
}> {
  return [...instances.values()].map((i) => ({
    key: i.key,
    port: i.port,
    model: path.basename(i.model),
    device: i.device,
    pid: i.pid,
    ctx: i.ctx
  }))
}

/**
 * 启动一个 llama.cpp 实例。
 *
 * 和以前的差别：不再「换模型就先杀进程」。判断依据是显卡绑定：
 * - 两个实例都绑了卡、且绑的不是同一张 → 允许并存（双卡双模型）
 * - 其余情况（尤其是都没绑卡）→ 先停掉别的实例，老的单卡行为不变
 */
export async function startLlama(
  model?: string,
  ctxOverride?: number,
  opts?: LlamaStartOptions
): Promise<{
  ok: boolean
  message: string
  model?: string
  loading?: boolean
  port?: number
  device?: string
  code?: LlamaErrorCode
}> {
  const dir = llamaRoot()
  const exe = await findServer(dir)
  if (!exe) return { ok: false, code: 'BINARY_MISSING', message: '未找到 llama-server.exe，请先点「一键安装」' }

  const cfg = await loadConfig()
  const provider = opts?.providerId
    ? cfg.providers.find((p) => p.id === opts.providerId) ?? null
    : cfg.providers.find((p) => p.id === 'llamacpp') || cfg.providers.find((p) => isLlamaProvider(p)) || null
  if (opts?.providerId && !provider) {
    return { ok: false, message: `配置里找不到供应商「${opts.providerId}」，请先在设置里重建` }
  }

  const key = provider?.id ?? `port:${LLAMA_PORT}`
  /**
   * 并发槽位：默认 0 = 不传参，交给 llama.cpp 的 auto（它会按可用显存适配）。
   * 用户明确填了 2~8 才显式指定 —— 多槽能吃满显卡，但也会挤压每槽的上下文预算。
   */
  const wantParallel = Math.round(Number(cfg.llamaParallel) || 0)
  const parallel = wantParallel >= 2 && wantParallel <= 8 ? wantParallel : 0
  const device = (opts?.device !== undefined ? opts.device ?? '' : provider?.device ?? '').trim()
  const wantPort = opts?.port ?? (provider ? llamaPortOf(provider) : LLAMA_PORT)
  /**
   * 「手动指定端口」只有两种来源：IPC 点名，或用户在设置页「实例端口」里填了值。
   * 程序自动选中的端口只写 baseUrl、不写 provider.port，所以这里判得准 —— 留空
   * 就一直是自动模式，重启应用也不会因为上次自动选过一次就变成「手动」。
   */
  const manualPort =
    opts?.port !== undefined ||
    (typeof provider?.port === 'number' && provider.port >= 1024 && provider.port <= 65535)

  const full = await resolveModelPath(model)
  if (!full) return { ok: false, message: '未找到 .gguf 模型，请先获取模型' }

  // 找配套的多模态投影器。必须在判断「能否复用旧进程」之前算出来：
  // 同一个主模型，从「纯文字」换成「带投影器」也必须重启 llama-server。
  const mmproj = await findMmprojFor(full, provider?.id)

  // 同一个供应商、同模型、同投影器、同显卡、同上下文 → 直接复用，不重启
  const running = instances.get(key)
  const wantCtx = Number(ctxOverride)
  const ctxSame = !(Number.isFinite(wantCtx) && wantCtx >= 2048) || Math.round(wantCtx) === running?.ctx
  const sameShape =
    !!running &&
    running.model === full &&
    (running.mmproj ?? '') === (mmproj ?? '') &&
    running.device === device &&
    (running.parallel || 0) === parallel &&
    ctxSame

  if (running && sameShape) {
    // 先证明它还活着，再决定复用 —— 不验证就会把请求发到死端口上。
    // 外部认领进来的实例（pid 为 null）同样适用：服务健康就直接用，别杀掉重启。
    const probe = await probeInstance(running)
    if (probe.alive) {
      const applied = await applyLlamaConfig(provider?.id, path.basename(full), undefined, Boolean(mmproj), running.port)
      // 复用旧进程时也要说清楚看图状态：否则用户看到「已在运行」就以为一切正常
      const reuseNote = mmproj ? '' : await missingProjectorNote(full)
      return {
        ok: true,
        message: `本地模型已在运行：${path.basename(full)}（端口 ${running.port}${running.device ? `，显卡 ${running.device}` : ''}）\n${applied.message}${reuseNote}`,
        model: path.basename(full),
        port: running.port,
        device: running.device
      }
    }
    // 回验失败：实例表已不可信。清掉记录和残存进程，走完整启动流程
    if (running.pid && isLlamaPid(running.pid)) {
      stopping.add(key)
      killPidSync(running.pid)
    }
    instances.delete(key)
    await persistState()
  }

  // 同一个供应商但模型 / 投影器 / 显卡 / 上下文变了：先停掉它自己那个旧实例。
  // 不这么做的话，后面实例表按 key 覆盖，旧进程就成了没人认领的孤儿，显存一直占着。
  // 注意用 instances.has 判：上面的存活回验失败时已经把这条记录删了，再停是空转。
  if (instances.has(key)) {
    await stopLlama(key)
    await new Promise((r) => setTimeout(r, 400))
  }

  // 再清别的实例：绑了不同显卡的留着，其余停掉
  for (const other of [...instances.values()]) {
    if (other.key === key) continue
    if (device && other.device && other.device.toLowerCase() !== device.toLowerCase()) continue
    await stopLlama(other.key)
    // 给端口释放留一点时间
    await new Promise((r) => setTimeout(r, 400))
  }

  let port = pickPort(wantPort)
  // 端口上可能有本程序没记录的服务（上次崩溃残留 / 用户手动启动的）
  if (!instances.has(key)) {
    const st = await statusByPort(port)
    if (st.running) {
      const served = st.models ?? []
      const want = path.basename(full).toLowerCase()
      const same = served.find((m) => path.basename(m).toLowerCase() === want)
      if (same) {
        // 认领它：之后能按实例停止（pid 未知，只能按进程名清）
        instances.set(key, {
          key,
          port,
          model: full,
          mmproj,
          device,
          ctx: await serverCtx(provider?.id),
          pid: null,
          proc: null,
          // 外部服务：没有 pid，存活只靠端口探测，宽限期用不上
          startedAt: Date.now(),
          // 日志不在我们手里（它自己起的），只占个路径位置，崩溃时 tail 会为空
          logFile: logFileOf(port),
          // 不是我们拉起的，无从重启：留空让 handleExit 的重启分支自然跳过
          exe: '',
          args: [],
          // 槽位数由它自己决定，只能从 /props 探，这里不假设
          parallel: 0
        })
        await persistState()
        const applied = await applyLlamaConfig(provider?.id, same, undefined, Boolean(mmproj), port)
        const note = mmproj
          ? '\n（这是外部启动的服务：若它没自行加载投影器，请重启或在设置里关掉看图）'
          : ''
        return {
          ok: true,
          message: `检测到已运行的服务，直接复用：${same}（端口 ${port}）\n${applied.message}${note}`,
          model: same,
          port,
          device
        }
      }
      // 端口上是别的模型：本程序还没有任何实例时才敢按进程名清场；
      // 已经有实例在跑的话绝不按名字杀，否则会把另一张卡上的模型一起干掉 —— 换个端口
      if (!instances.size) {
        for (const pid of listLlamaPids()) killPidSync(pid)
        await new Promise((r) => setTimeout(r, 600))
      } else {
        port = pickPort(undefined, new Set([port]))
      }
    }
  }

  // 起进程前做一次真实探测：能在 127.0.0.1 上 bind 才算这个端口可用。
  // 以前只查自己维护的实例表，别的软件占了端口时 llama-server 会直接退出，
  // 界面却一直停在「加载中」，用户完全看不出是端口冲突。
  let autoPortNote = ''
  if (!(await waitPortFree(port))) {
    if (manualPort) {
      return {
        ok: false,
        message: `端口 ${port} 已被其它程序占用，无法启动。请把「实例端口」留空（自动选择空闲端口），或改填一个空闲端口。`
      }
    }
    const usedPorts = new Set([...instances.values()].map((i) => i.port))
    const alt = await findFreePort(port + 1, usedPorts)
    if (alt === null) {
      return {
        ok: false,
        message: `从端口 ${port} 起连续 64 个端口都被占用，找不到可用端口。请关掉占用程序，或在设置里手动指定端口。`
      }
    }
    autoPortNote = `\n端口 ${port} 已被占用，已自动改用 ${alt}`
    port = alt
  }

  try {
    // 上下文长度定夺，优先级：调用方点名 > 体检建议 > 配置上限。
    //
    // 体检要按「这次绑的那张卡」算：双卡机器上拿 GPU0 的余量去估 GPU1 上的模型，
    // 算出来的档位必然偏大（或者偏小），启动时就可能 OOM 或白白浪费显存。
    const want = Number(ctxOverride)
    let ctx: number
    let ctxNote = ''
    if (Number.isFinite(want) && want >= 2048) {
      ctx = Math.min(Math.round(want), CONTEXT_RANGE.max)
    } else {
      ctx = await serverCtx(provider?.id)
      const fit = await fitForLaunch(full, deviceIndex(device)).catch(() => null)
      if (fit?.recommendedCtx && fit.recommendedCtx < ctx) {
        const before = ctx
        ctx = fit.recommendedCtx
        ctxNote = `\n体检：这台机器上最多装得下 ${Math.round(ctx / 1024)}K，已从配置的 ${Math.round(before / 1024)}K 降下来`
      }
    }
    const args = [
      '-m',
      full,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '-c',
      String(ctx),
      // 用文件名作为模型 id。否则 /v1/models 会返回 -m 的绝对路径，
      // 与配置里保存的文件名对不上，探测会一直判定失败（红叉）。
      '-a',
      path.basename(full),
      ...deviceArgs(device)
    ]
    // 视觉投影器：不传这个参数，主模型就只当纯文本模型用，
    // 发过去的 image_url 会被忽略或直接报错。
    if (mmproj) args.push('--mmproj', mmproj)
    // 多槽必须配 -kvu：显式指定槽位数之后，llama.cpp 默认改成按槽切分上下文，
    // 每槽只剩 1/N，一个 30K 的 agent prompt 会直接超出槽窗口报错。
    // 共享 KV 池下 -c 是总量，开槽不额外吃 KV 显存（只多一点计算缓冲）。
    if (parallel) args.push('-np', String(parallel), '-kvu')

    const inst = launch({ key, exe, args, port, model: full, mmproj, device, ctx, parallel })
    await persistState()
    // 新起的进程重新计数：上一轮的重试次数不该影响这一次
    restartCounts.delete(key)

    // 立刻用文件名写入配置，让界面马上能看到这条模型（不等服务加载）
    const fallback = path.basename(full)
    const applied = await applyLlamaConfig(provider?.id, fallback, ctx, Boolean(mmproj), port)

    // 服务就绪后再用真实模型 id 校正配置；不阻塞本次返回
    void (async () => {
      const served = await waitForServer(port, 45000)
      if (!served?.length || instances.get(key) !== inst) return
      // 服务真的应答了：重试计数归零，下次崩溃还有 3 次自愈机会
      restartCounts.delete(key)
      const picked = pickServedModel(served, full)
      if (picked && picked !== fallback) await applyLlamaConfig(provider?.id, picked, undefined, undefined, port)
    })()

    // 视觉模型没配上投影器时说清原因和补救办法。以前这里静默留空，
    // 用户只看到「已启动」，直到发图片没反应才发现看不了图。
    const mmNote = mmproj
      ? `\n视觉投影器：${path.basename(mmproj)}（已挂到主模型，可看图）`
      : await missingProjectorNote(full)
    const devNote = device ? `，显卡 ${device}` : ''
    const multi = instances.size > 1 ? `\n当前共 ${instances.size} 个本地实例在跑：${[...instances.values()].map((i) => `${path.basename(i.model)}@${i.port}`).join('、')}` : ''
    return {
      ok: true,
      message: `${applied.message}\n已启动 llama-server（端口 ${port}${devNote}，上下文 ${ctx} tokens），模型加载中，就绪后自动校正…${autoPortNote}${ctxNote}${mmNote}${multi}`,
      model: fallback,
      loading: true,
      port,
      device
    }
  } catch (err) {
    return { ok: false, message: `启动失败：${(err as Error).message}` }
  }
}

/**
 * 停止实例。
 *
 * 传 providerId 只停那一个；不传则全停（老行为）。
 * 注意别再用 `listLlamaPids()` 通杀：那张表里可能躺着另一张卡上的模型。
 */
export async function stopLlama(
  providerId?: string
): Promise<{ ok: boolean; message: string; stopped?: string[] }> {
  /**
   * 杀一个实例。pid 已知就直接杀；
   * 外部认领进来的实例没有 pid，只能按进程名清 —— 但必须跳过其它实例的 pid，
   * 否则「停这一个」会顺手把另一张卡上的模型一起干掉。
   */
  const kill = (inst: LlamaInstance) => {
    stopping.add(inst.key)
    // 进程可能早就不在了，exit 不会再来 —— 到点自动消掉标记，别把以后的崩溃也吞掉
    setTimeout(() => stopping.delete(inst.key), 15000).unref?.()
    if (inst.pid) {
      killPidSync(inst.pid)
      return
    }
    const others = new Set(
      [...instances.values()].filter((i) => i !== inst && i.pid).map((i) => i.pid as number)
    )
    for (const pid of listLlamaPids()) if (!others.has(pid)) killPidSync(pid)
  }

  if (providerId) {
    const inst = instances.get(providerId)
    if (!inst) return { ok: true, message: '这个本地模型没有在运行', stopped: [] }
    kill(inst)
    instances.delete(providerId)
    await persistState()
    return {
      ok: true,
      message: `已停止 ${path.basename(inst.model)}（端口 ${inst.port}），显存已释放`,
      stopped: [`${path.basename(inst.model)}@${inst.port}`]
    }
  }

  const list = [...instances.values()]
  if (list.length) {
    for (const inst of list) kill(inst)
    instances.clear()
    await persistState()
    return {
      ok: true,
      message: '已停止本地模型，释放显存',
      stopped: list.map((i) => `${path.basename(i.model)}@${i.port}`)
    }
  }

  // 本程序没记录，但可能仍有 llama-server 占用显存
  const st = await statusLlama()
  if (st.running || st.loading) {
    let hit = false
    for (const pid of listLlamaPids()) {
      killPidSync(pid)
      hit = true
    }
    return { ok: true, message: hit ? '已停止本地模型，释放显存' : '当前没有运行中的本地模型' }
  }
  return { ok: true, message: '当前没有运行中的本地模型', stopped: [] }
}

/**
 * 只释放「没绑显卡」的实例（切换到别的模型时调用）。
 *
 * 绑了卡的实例属于「双卡双模型」：用户明确指定了它占哪张卡，
 * 切换对话模型不该把它卸掉 —— 否则第二张卡又白空着了。
 */
/**
 * 按条件停实例。外部认领的实例没有 pid，只能按进程名清 —— 但必须跳过其它实例的 pid，
 * 否则「停这一个」会顺手把另一张卡上的模型一起干掉。
 */
async function stopInstances(should: (inst: LlamaInstance) => boolean): Promise<string[]> {
  const stopped: string[] = []
  for (const inst of [...instances.values()]) {
    if (!should(inst)) continue
    stopping.add(inst.key)
    setTimeout(() => stopping.delete(inst.key), 15000).unref?.()
    if (inst.pid) {
      killPidSync(inst.pid)
    } else {
      const others = new Set(
        [...instances.values()].filter((i) => i !== inst && i.pid).map((i) => i.pid as number)
      )
      for (const pid of listLlamaPids()) if (!others.has(pid)) killPidSync(pid)
    }
    instances.delete(inst.key)
    stopped.push(`${path.basename(inst.model)}@${inst.port}`)
  }
  if (stopped.length) await persistState()
  return stopped
}

/** 只保留绑了显卡的实例（切换对话模型时用：绑卡的双卡实例不动） */
export async function releaseUnpinnedLlama(keepId: string | null): Promise<{ stopped: string[] }> {
  return { stopped: await stopInstances((inst) => inst.key !== keepId && !inst.device) }
}

/**
 * 停掉除这些 key 之外的所有实例。
 * 切到远端模型时用：本地主模型该让出显存，但工人模型还要留着给子代理用。
 */
export async function stopLlamaExcept(keepKeys: string[]): Promise<{ stopped: string[] }> {
  return { stopped: await stopInstances((inst) => !keepKeys.includes(inst.key)) }
}

/** 同步停止（用于应用退出时，不能 await） */
export function stopLlamaSync(): void {
  if (!instances.size) return
  for (const inst of instances.values()) {
    stopping.add(inst.key)
    if (inst.pid) killPidSync(inst.pid)
  }
  // 收尾：外部认领的实例没有 pid，按进程名再清一遍（这时候全都在停，不用再区分）
  for (const pid of listLlamaPids()) killPidSync(pid)
  instances.clear()
  try {
    fsSync.unlinkSync(stateFile())
  } catch {
    // 忽略
  }
  try {
    fsSync.unlinkSync(pidFile())
  } catch {
    // 忽略
  }
}

/** 启动时清理上次异常退出遗留的 llama-server（校验进程名，避免误杀） */
export function cleanupStaleLlama(): void {
  // 新格式：多实例状态文件
  try {
    const raw = fsSync.readFileSync(stateFile(), 'utf8')
    const rows = JSON.parse(raw) as Array<{ pid?: number }>
    for (const row of rows) {
      const pid = Number(row?.pid)
      if (pid && isLlamaPid(pid)) killPidSync(pid)
    }
  } catch {
    // 没有状态文件
  }
  // 老格式：单 pid 文件（升级后第一次启动还留着）
  try {
    const pid = Number(fsSync.readFileSync(pidFile(), 'utf8').trim())
    if (pid && isLlamaPid(pid)) killPidSync(pid)
  } catch {
    // 无残留文件
  }
  try {
    fsSync.unlinkSync(stateFile())
  } catch {
    // 忽略
  }
  try {
    fsSync.unlinkSync(pidFile())
  } catch {
    // 忽略
  }
}

/**
 * 查某个实例（不传则查第一个 / 默认端口）的状态。
 *
 * 返回四态而不是三个布尔：外部调用要能区分「还没开始」「正在加载」「好了」「坏了」，
 * 坏了还要知道是崩溃、超时还是端口被占。所有消费方（IPC、未来的 HTTP 控制面、
 * core.ts 的轮询）读的都是这一份，避免各自再猜一遍。
 */
export async function statusLlama(providerId?: string): Promise<LlamaStatus> {
  const st = await statusLlamaBase(providerId)
  const q = queueInfoOf(`http://127.0.0.1:${st.port ?? LLAMA_PORT}`)
  if (!q) return st
  // 排队时把话说明白：不然用户看到「运行中」却一动不动，只会以为程序卡了
  const note = q.queued > 0 ? `，${q.queued} 个请求在排队（并发上限 ${q.limit}）` : ''
  return { ...st, queue: q, message: st.message + note }
}

async function statusLlamaBase(providerId?: string): Promise<LlamaStatus> {
  let port = LLAMA_PORT
  let device = ''
  const inst = providerId ? instances.get(providerId) : [...instances.values()][0]
  if (inst) {
    port = inst.port
    device = inst.device
  } else if (providerId) {
    const p = (await loadConfig()).providers.find((x) => x.id === providerId)
    port = p ? llamaPortOf(p) : LLAMA_PORT
    device = p?.device ?? ''
  }

  const key = inst?.key ?? providerId ?? ''
  const crash = key ? crashes.get(key) : undefined
  const crashOut = crash
    ? {
        code: crash.code,
        signal: crash.signal,
        at: crash.at,
        tail: crash.tail,
        logFile: inst?.logFile ?? logFileOf(port)
      }
    : undefined
  const elapsedMs = inst ? Date.now() - inst.startedAt : undefined

  const r = await statusByPort(port)
  if (r.running) {
    // 服务真的起来了：清掉重试计数，下次崩溃还有 3 次机会
    restartCounts.delete(key)
    return {
      ok: true,
      state: 'ready',
      running: true,
      loading: false,
      code: 'NONE',
      phase: 'ready',
      elapsedMs,
      models: r.models,
      port,
      device,
      crash: crashOut,
      message: '服务运行中'
    }
  }

  // 端口答 503：llama-server 已经 listen，正在加载模型 —— 这是正常中间态
  if (r.loading) {
    return {
      ok: true,
      state: 'loading',
      running: false,
      loading: true,
      code: 'NONE',
      phase: 'load',
      elapsedMs,
      port,
      device,
      crash: crashOut,
      message: `模型加载中${elapsedMs ? `（已 ${Math.round(elapsedMs / 1000)} 秒）` : ''}…`
    }
  }

  // 端口不通：进程还在就是「刚开始加载还没 listen」，否则就是真没跑起来
  if (inst?.pid && isLlamaPid(inst.pid)) {
    if ((elapsedMs ?? 0) < STARTUP_GRACE_MS) {
      return {
        ok: true,
        state: 'loading',
        running: false,
        loading: true,
        code: 'NONE',
        phase: 'spawn',
        elapsedMs,
        port,
        device,
        crash: crashOut,
        message: `进程已启动，正在加载模型（已 ${Math.round((elapsedMs ?? 0) / 1000)} 秒）…`
      }
    }
    return {
      ok: true,
      state: 'error',
      running: false,
      loading: false,
      code: 'START_TIMEOUT',
      phase: 'spawn',
      elapsedMs,
      port,
      device,
      crash: crashOut,
      message: `进程存活但 ${Math.round((elapsedMs ?? 0) / 1000)} 秒内端口没有应答，多半是模型太大或显存不足`
    }
  }

  if (crash) {
    return {
      ok: true,
      state: 'error',
      running: false,
      loading: false,
      code: 'CRASHED',
      elapsedMs,
      port,
      device,
      crash: crashOut,
      message: `llama-server 已退出（退出码 ${crash.code ?? '未知'}${crash.signal ? `，信号 ${crash.signal}` : ''}），日志尾部见 crash.tail`
    }
  }

  return {
    ok: true,
    state: 'idle',
    running: false,
    loading: false,
    code: 'NONE',
    elapsedMs,
    port,
    device,
    message: '服务未运行'
  }
}
