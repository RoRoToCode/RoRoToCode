import { app, BrowserWindow } from 'electron'
import fsSync, { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import type { LlamaErrorCode, LlamaStatus, LlamaUpdateInfo, ProviderConfig, SetupProgress } from '../shared/types'
import { LLAMA_PORT, LLAMA_PORTS, deviceIndex, isLlamaProvider, llamaPortOf } from '../shared/providers'
import { ggufLooksVision } from '../shared/vision'
import { isInsideAnyRoot, isModelFileName } from '../shared/modelpath'
import { resolveDataRoot } from '../shared/datadir'
import { findFreePort, waitPortFree } from './portprobe'
import { CONTEXT_RANGE, loadConfig, saveConfig } from './config'
import { fitForLaunch, type VramfitKv } from './vramfit'
import { gpuUsedMiB, sampleUsedMiB } from './vramprobe'
import {
  bestTier,
  classifyLoadFailure,
  fingerprintOf,
  fitTargetMiB,
  MIN_AGENT_SLOT_TOKENS,
  partialModeOf,
  probeStartTier,
  sameFingerprint,
  shouldPartialOffload,
  shouldProbeChain,
  slotWindowOk
} from '../shared/ctxtune'
import { probeBudget, runProbeChain, type ProbeProgress, type ProbeVerify } from './ctxprobe'
import { createIdleWatcher } from './idleunload'
import { readGgufMeta } from './gguf'
import { isLoopbackUrl } from './providers/base'
import { MIRRORS, downloadFromGithub } from './ghdl'
import { queueInfoOf } from './gate'
import { resolveGpuProfile, type GpuProfile } from '../shared/gpuprofile'
import {
  candidateNames,
  detectGpuPreference,
  nvidiaGpuInfo,
  hintsOf,
  isMainPackage,
  planFromAssets,
  type InstallPlan,
  type PackageHints,
  type ReleaseAsset
} from './gpuplan'

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
  /** 部分层在 CPU 上跑（装不下时的降级），界面据此标注「速度会慢」 */
  partial: boolean
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

/**
 * 主动停止的具体进程号。
 *
 * 只按 providerId 记是不够的：停止后 15 秒内又启动同一个供应商（换视觉模式、
 * 换模型都会这么做），新进程如果立刻崩，`stopping` 里那条旧标记还在，这次崩溃
 * 就被当成「主动停止」吞掉了 —— 界面只看到「服务未运行」，完全看不出崩过。
 * 按 pid 判定才是准的：新进程是新 pid，不会命中旧标记。
 */
const stoppingPids = new Set<number>()

/** 崩溃自愈的待执行定时器：用户点停止时要能取消，否则停了它还会自己起来 */
const restartTimers = new Map<string, NodeJS.Timeout>()

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

/**
 * 「端口已经 listen、但一直在 503 加载中」的绝对上限。
 *
 * STARTUP_GRACE_MS 只管「端口还没通」那一段。模型在慢盘上、显存不够卡在分配阶段时，
 * 端口是通的、状态是 loading，可以一直这么挂下去：进程和显存被永久占住，
 * 界面上只有一句「已 600 秒」。所以这条也要有上限，到点杀进程并报超时。
 */
const LOAD_TIMEOUT_MS = 10 * 60_000

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

/**
 * 探测时给桌面合成器留的余量（MiB）。和 tuneAfterReady 用同一个口径：
 * WDDM 下显存被榨到极限不会崩，而是悄悄换页，速度断崖式下跌。
 */
const PROBE_RESERVE_MIB = 320

/**
 * 探测判据里的速度下限（tok/s）。
 *
 * 「服务能应答」不等于「跑得动」：显存不够时 llama.cpp 有时不退出，而是把部分层
 * 落到 CPU、或者被系统换页 —— 两者都照样返回 200，只是吞吐掉到个位数。
 * 5 tok/s 是「这台机器明显不正常」的保守线（3050 上 7B Q4 实测 22 tok/s，
 * 纯 CPU 也有 5~8，且纯 CPU 本来就不探测）。
 */
const MIN_PROBE_TOK_PER_SEC = 5
/** 探测判据的超时：长上下文首次加载在机械盘上可能慢，但超过它就是真卡住了 */
const PROBE_READY_MS = 60_000

/**
 * 低于这个显存预算就不开多槽（MiB）。
 *
 * 多槽不会减少总计算量，只是把 GPU 切片，每个请求都变慢；每个槽还要多一份
 * 计算缓冲。8 GB 卡上实测 4 槽并发把 decode 从 13 tok/s 打到 1.55 tok/s，
 * 而 12 GB 以上才有富余做到「真并发」。10 GB 是这两者之间的分界。
 */
const MULTI_SLOT_MIN_MIB = 10 * 1024

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
  /** 是否按「部分层在 CPU」的方式启动（装不下时的降级，界面要标出来） */
  partial?: boolean
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
    parallel: spec.parallel ?? 0,
    partial: spec.partial === true
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

/**
 * 正在探测的实例 key。
 *
 * 探测是一个「多次停止 + 启动」的长事务，期间必须压住自愈重启（见 handleExit），
 * 否则同一档会被原参数重试 3 次，和探测链的降档逻辑互相踩。
 */
const probingKeys = new Set<string>()

/**
 * 正在跑的探测链（防重入）。
 *
 * 和 probingKeys 的区别：probingKeys 是「这条实例的自愈被压制」，由启动方在
 * spawn 之后就加上（否则首档崩掉的瞬间就会被 handleExit 原参数重试 3 次）；
 * probeRunning 是「已经有一条探测链在跑」，只用于防重入。
 */
const probeRunning = new Set<string>()

/**
 * 探测代号。
 *
 * 用户中途手点某一档、或主动点「启动并使用」时 +1。正在跑的探测每一步都检查
 * 代号有没有变，变了就立刻收手 —— 否则它会在几秒后重启到自己的目标档，
 * 把用户刚选的那个覆盖掉，表现就是「我点了 8K，过一会儿又变回 64K」。
 */
let probeGen = 0

/** 探测串行链：同一条配置上不允许两条探测同时起停 */
let probeSerial: Promise<unknown> = Promise.resolve()

/** 用户主动启动 / 手选档位时调用：叫停正在跑的自动探测 */
export function cancelContextProbe(): void {
  probeGen++
}

/** 探测进度广播：界面据此显示「正在校准 2/4」 */
function emitProbe(p: ProbeProgress): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    try {
      w.webContents.send('llama:probe', p)
    } catch {
      // 窗口正在销毁：进度丢了不影响探测本身
    }
  }
}

/**
 * 等一小会儿，看进程有没有在「还没进入正常加载」的阶段就退掉。
 *
 * 返回 null 表示没秒退（正常启动流程）；返回字符串是已经翻译成人话的失败原因。
 * 只读 crashes（handleExit 写的那份），不自己 spawn 也不碰实例表 —— 调用它不会
 * 改变任何状态，纯粹是「早一点知道结果」。
 */
async function quickExitReason(key: string, waitMs: number): Promise<string | null> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const c = crashes.get(key)
    if (c) {
      const hint = explainCrashTail(c.tail ?? '')
      if (hint) return hint
      const lines = (c.tail ?? '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
      return lines.slice(-3).join('\n') || `退出码 ${c.code ?? '未知'}`
    }
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, 120))
  }
}

function handleExit(inst: LlamaInstance, code: number | null, signal: string | null): void {
  const key = inst.key
  // 主动杀的不算崩溃；只有非零退出才记现场，否则「切模型」也会被记成崩溃
  const byPid = inst.pid != null && stoppingPids.delete(inst.pid)
  const intentional = byPid || stopping.delete(key)
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
  /**
   * 探测期间禁止自愈。
   *
   * 探测链自己会按失败原因决定降几档；这里的「原参数重试」只会把同一个装不下的
   * 档再撞 3 次（2s/6s/18s，每次还要重新加载模型），而且和探测链的重启互相踩，
   * 最后谁都算不清当前是哪一档。探测结束时由探测链自己清理。
   */
  if (probingKeys.has(key)) return
  // 外部认领的服务没有启动参数，重启不了
  if (!inst.exe) return

  const attempt = (restartCounts.get(key) ?? 0) + 1
  if (attempt > RESTART_DELAYS_MS.length) return
  restartCounts.set(key, attempt)
  // 同一条实例只允许有一个待执行的重启，别叠起来
  const prev = restartTimers.get(key)
  if (prev) clearTimeout(prev)
  const timer = setTimeout(() => {
    restartTimers.delete(key)
    // 用户可能已经手动重启、或者切了模型，这时别再插一脚
    if (instances.has(key)) return
    /**
     * 端口必须重新确认。崩溃后实例已经从表里删掉，别的供应商可能刚好把这个端口
     * 挑走（pickPort 只遍历 instances）；照旧端口盲起就是两个 llama-server 抢一个
     * 端口，抢输的再崩一次，三次之后这个模型就永久停在 error。
     */
    const portTaken = [...instances.values()].some((i) => i.port === inst.port)
    launch({
      key,
      exe: inst.exe,
      args: inst.args,
      port: portTaken ? pickPort() : inst.port,
      model: inst.model,
      mmproj: inst.mmproj,
      device: inst.device,
      ctx: inst.ctx
    })
  }, RESTART_DELAYS_MS[attempt - 1])
  timer.unref?.()
  restartTimers.set(key, timer)
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


/**
 * 杀一个进程，返回「它确实不在了」。
 *
 * 以前不看 taskkill 的结果：被杀软拦下、或者进程属于另一个权限级别时，
 * 命令静默失败，调用方照样把实例从表里删掉并回报「显存已释放」——
 * 结果是一个谁都不认识的 llama-server 长期占着显存，再也没人管。
 * 另外 spawnSync 没有超时，进程挂起时会把主进程一起冻住。
 */
function killPidSync(pid: number): boolean {
  try {
    const r = spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      timeout: 8000,
      encoding: 'utf8'
    })
    if (r.status === 0) return true
    // 非 0 常见于「进程已经不在了」：那也算成功，用 tasklist 复核一次
    return !isLlamaPid(pid)
  } catch {
    return !isLlamaPid(pid)
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

/**
 * 大文件（llama.cpp 运行库 / GGUF 模型 / 简易核心）的根目录。
 *
 * 默认落在 userData：用 winget / scoop 安装时升级会换一个安装目录，
 * 数据跟着 exe 走会让用户几 GB 的模型凭空消失。配置、会话、日志一直在 userData，
 * 只有这几类大文件原先挂在 appBase() 下，这里把它们对齐过去。
 * 老便携版已有的数据仍在 exe 同目录，resolveDataRoot 检测到会自动沿用，不搬动。
 */
function dataRoot(): string {
  return resolveDataRoot({
    env: process.env,
    userDataDir: app.getPath('userData'),
    exeDir: appBase(),
    resolve: (p) => path.resolve(p),
    hasData: (base) =>
      ['llama.cpp', 'models', 'core'].some((d) => fsSync.existsSync(path.join(base, d)))
  })
}

/** llama.cpp 可执行文件目录 */
export function llamaRoot(): string {
  return path.join(dataRoot(), 'llama.cpp')
}

/** 模型目录 */
export function modelsRoot(): string {
  return path.join(dataRoot(), 'models')
}

/**
 * 每张卡的 CUDA compute capability（2080 = 7.5，3080 = 8.6）；查不到给 null。
 *
 * 为什么要问这个：`-fa on` 会走 `flash_attn_ext_f16` 的 MMA kernel，而这个
 * 官方 CUDA 构建里**没有 Turing（arch 750）的设备代码**。2080 上实测：
 * 模型能加载、`/v1/models` 也正常应答，第一次生成就抛
 * `CUDA error: unspecified launch failure`，进程直接崩，界面表现为
 * 「连接失败 → 已切到核心模型」。光看 build 版本号看不出这个坑。
 *
 * 为什么要**按卡**取而不是只取第一张：双卡混搭（4090 + 2080）时，模型可能绑在
 * 第二张上；按第一张的 8.9 判就会给 2080 加 `-fa on`，第一次生成就崩。
 */
let ccGate: Promise<Array<number | null>> | null = null
function gpuComputeCaps(): Promise<Array<number | null>> {
  if (!ccGate) {
    ccGate = Promise.resolve().then(() => {
      const candidates = ['nvidia-smi']
      // 打包后的主进程 PATH 里不一定有 nvidia-smi：它常年待在 System32
      if (process.platform === 'win32' && process.env.SystemRoot) {
        candidates.push(path.join(process.env.SystemRoot, 'System32', 'nvidia-smi.exe'))
      }
      for (const exe of candidates) {
        try {
          const r = spawnSync(exe, ['--query-gpu=compute_cap', '--format=csv,noheader'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 4000
          })
          if (r.status !== 0) continue
          const list = `${r.stdout ?? ''}`
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => {
              const v = Number(s)
              return Number.isFinite(v) && v > 0 ? v : null
            })
          if (list.length) return list
        } catch {
          // 这个路径不行，换下一个
        }
      }
      // 非 N 卡 / 没装驱动：交给 build 版本判定，别在这里一刀切
      return []
    })
  }
  return ccGate
}

/** 取第 index 张卡的算力；绑定的卡不存在时退回第一张能读到的 */
async function gpuComputeCap(index = 0): Promise<number | null> {
  const caps = await gpuComputeCaps()
  if (!caps.length) return null
  const picked = caps[Number.isFinite(index) && index >= 0 ? index : 0]
  return picked ?? caps.find((c): c is number => c !== null) ?? null
}

/**
 * 显卡分档策略。
 *
 * 同一个探测结果（build 号 + CUDA 算力 + 后端）驱动一整套「按卡分档」的启动参数，
 * 而不是一个布尔开关。不同显卡能跑的参数差异很大，一刀切要么崩要么慢：
 *
 *   - Turing（cc 7.5，如 RTX 2080）：官方 CUDA 构建缺 FA 的 MMA kernel，开 `-fa on`
 *     首次生成即 CUDA error 崩进程。但 KV 量化里的 **K cache 量化（-ctk）不依赖 FA**，
 *     白拿一半 K cache 空间——对 8GB 小卡最值钱。所以 cc<8 时只关 FA + V 量化，保留 K。
 *   - Ampere 及更新（cc≥8.0，如 30/40/50 系）：FA + KV 量化全开。
 *   - Vulkan / CPU：FA 与 KV 量化要么不支持要么无意义，一律不加。
 *
 * 后端来源：`detectGpuPreference()`（gpuplan.ts）已经用 nvidia-smi + WMI 三层探出
 * cuda/vulkan/cpu，这里只负责「同一张 N 卡内部再按算力分档」。build 号与算力任一
 * 探不出来都收敛到最保守档（什么都不加），绝不赌。分档决策是纯函数
 * `resolveGpuProfile`（shared/gpuprofile.ts），可独立单测。
 */

/**
 * 探测本机硬件并算出一档策略。按卡缓存，多次启动 / 同一张卡只探一次。
 * 决策本身在 `resolveGpuProfile`（纯函数），这里只负责探测 + 缓存 + 兜底。
 *
 * 缓存键是**卡号**：双卡机器上「绑 0 号卡」和「绑 1 号卡」是两份不同的策略
 * （一张 4090 一张 2080 时，一个能开 FA 一个不能）。旧版只缓存一份，谁先启动谁定调，
 * 后启动的那张卡就继承了前一张的结论。
 */
const profileGates = new Map<number, Promise<GpuProfile>>()
function gpuProfile(index = 0): Promise<GpuProfile> {
  const n = Number.isFinite(index) && index >= 0 ? Math.round(index) : 0
  const hit = profileGates.get(n)
  if (hit) return hit
  const p = (async (): Promise<GpuProfile> => {
    const [build, cc, pref] = await Promise.all([
      installedLlamaBuild(),
      gpuComputeCap(n),
      Promise.resolve(detectGpuPreference().preference)
    ])
    return resolveGpuProfile({
      build,
      cc,
      pref,
      noFa: process.env.ROROTO_LLAMA_NO_FA === '1',
      forceFa: process.env.ROROTO_LLAMA_FORCE_FA === '1',
      vulkanPerf: process.env.ROROTO_LLAMA_VULKAN_PERF === '1'
    })
  })().catch(() => {
    return {
      fa: false,
      ctk: false,
      ctv: false,
      ub: 0,
      reason: '策略探测失败，退回保守档',
      tier: 'unknown' as const
    }
  })
  profileGates.set(n, p)
  return p
}

/**
 * 清掉所有「探一次就记住」的结论。
 *
 * 换显卡、插拔 eGPU、装完新包、更新驱动之后必须重新探：
 * 旧实现只清了一处探测缓存，`ccGate` / `profileGate` 还留着旧结论，
 * 于是「换了卡但 FA 还是按老卡判」这种问题查起来毫无头绪。
 */
export function clearGpuProbeCache(): void {
  ccGate = null
  profileGates.clear()
  detectGpuPreference({ refresh: true })
}

/** 启动参数里的「白拿速度」部分；按显卡分档输出，不再是一条写死的三元组 */
async function perfArgs(index = 0): Promise<string[]> {
  if (process.env.ROROTO_LLAMA_NO_FA === '1') return []
  const p = await gpuProfile(index)
  const args: string[] = []
  if (p.fa) args.push('-fa', 'on')
  if (p.ctk) args.push('-ctk', 'q8_0')
  if (p.ctv) args.push('-ctv', 'q8_0')
  return args
}

/**
 * 这次启动实际用到的 KV 精度档，喂给体检用。
 *
 * 体检必须按真实参数算：Turing（cc<8）上只有 `-ctk q8_0`，V 仍是 f16，
 * 对应 `k8v16`（每元素 1.53 字节）。按 f16 估会少算 25% 的能力 ——
 * 实际能开 64K 的模型被判成 32K，用户看到「显存才用 6.6G」自然觉得算错了。
 */
export async function launchKvType(index = 0): Promise<VramfitKv> {
  if (process.env.ROROTO_LLAMA_NO_FA === '1') return 'f16'
  const p = await gpuProfile(index)
  if (p.ctk && p.ctv) return 'q8_0'
  if (p.ctk) return 'k8v16'
  return 'f16'
}

/** micro-batch（-ub）：按显卡分档，环境变量 ROROTO_LLAMA_UB 仍是最终出口 */
async function ubArgs(index = 0): Promise<string[]> {
  const env = Number(process.env.ROROTO_LLAMA_UB)
  if (Number.isFinite(env) && env >= 32) return ['-ub', String(Math.round(env))]
  const p = await gpuProfile(index)
  if (p.ub >= 32) return ['-ub', String(p.ub)]
  return ['-ub', '512']
}

/** 当前显卡策略档位的一句话说明，写进启动日志给用户看（诊断用） */
async function gpuProfileNote(index = 0): Promise<string> {
  const p = await gpuProfile(index)
  return p.reason
}

/**
 * 推理模型思考预算（--reasoning-budget）。
 * 环境变量 ROROTO_LLAMA_REASONING 覆盖：0 = 关闭（-1 让 llama.cpp 不限），
 * 正数 = 封顶 token。默认 512。非推理模型不受此参数影响。
 */
function reasoningBudget(): number {
  const env = Number(process.env.ROROTO_LLAMA_REASONING)
  if (Number.isFinite(env)) {
    if (env <= 0) return 0
    return Math.max(0, Math.round(env))
  }
  return 512
}

/**
 * 投机解码参数。
 *
 * 把草稿模型放到 `llama.cpp/draft.gguf` 就自动启用：agent 的活儿高度可预测
 * （读文件 → 写回几乎一样的补丁、按模板生成命令），草稿命中的时候输出能快 1.5～2 倍，
 * 而最终每个 token 仍由主模型校验，质量不会变差。草稿的 vocab 必须和主模型同源
 * （同一系列的小号版本），否则 llama.cpp 会自己放弃投机，最坏情况是启动报错。
 *
 * 没有草稿模型就返回空数组，行为和以前完全一样。这里不做 ngram / lookup 投机：
 * 那需要先用 llama-lookup-create 从语料离线建缓存文件，不适合在启动路径上自动生成。
 *
 * `mainModel` 是本次要跑的主模型绝对路径：草稿 vocab 必须和主模型同源（同一架构），
 * 否则 llama.cpp 会自己放弃投机（等于白占一份显存），最坏情况是启动报错。读到架构不一致
 * 就静默关闭，宁可少拿这点速度，也不能把「能用」的模型搞到「起不来」。
 */
async function draftArgs(mainModel?: string): Promise<string[]> {
  const draft = path.join(llamaRoot(), 'draft.gguf')
  try {
    if (!fsSync.existsSync(draft)) return []
  } catch {
    return []
  }
  // 架构校验：两者都读得到且不一致时关闭；读不到（缺元数据）不阻断，交给 llama.cpp 自己判定
  if (mainModel) {
    try {
      const [mainMeta, draftMeta] = await Promise.all([readGgufMeta(mainModel), readGgufMeta(draft)])
      if (
        mainMeta.architecture &&
        draftMeta.architecture &&
        mainMeta.architecture !== draftMeta.architecture
      ) {
        return []
      }
    } catch {
      return []
    }
  }
  return ['-md', draft, '--draft-max', '8', '--draft-min', '2']
}

/**
 * 长会话的 KV 复用（--cache-reuse）。
 *
 * agent 的活儿是高度重复的「读文件 → 跑命令 → 拿输出 → 改代码」循环，每轮对话
 * 历史都在增长；当 agent 层按窗口裁剪丢掉早期轮次、插入新轮次时（见 agent.ts 的
 * dropOldestTurns），llama-server 默认会把整段 prompt 从头 re-prefill 一遍。
 * 开 `--cache-reuse 256` 后，服务端通过 KV 移位复用旧缓存里「没变的那部分 token」，
 * 只重新计算新增的部分 —— 长会话越往后，省下的 prefill 越多。
 *
 * 几个边界：
 * - 需要 prompt caching 开启（llama-server 默认就开，我们没有显式关过）。
 * - 依赖 RoPE 位置编码；绝大多数现代模型（Qwen/Llama/DeepSeek/GLM）都是 RoPE，
 *   个别不兼容的架构 llama.cpp 会自己降级（忽略该参数），不会崩、不影响正确性。
 * - 值 256 是官方推荐的最小 chunk 长度：太小的块复用省不了多少，太大则难命中。
 * - 与「上下文移位」不是一回事：`--context-shift` 针对单个请求内的无限文本生成
 *   （写完窗口继续写），而我们 agent 是多轮短请求，要的是「跨请求的 KV 复用」，
 *   所以这里用的是 `--cache-reuse` 而不是 `--context-shift`。
 * - 环境变量 ROROTO_LLAMA_NO_CACHE_REUSE=1 关掉（个别构建不认这个参数时兜底）。
 */
function cacheReuseArgs(): string[] {
  if (process.env.ROROTO_LLAMA_NO_CACHE_REUSE === '1') return []
  return ['--cache-reuse', '256']
}

/**
 * 「简易核心」自己的目录：软件根目录下的 core/。
 *
 * 单独开一个英文目录，而不是混进 models/：一键核心下载的模型是这套流程自己管的东西，
 * 用户往里扔别的 .gguf 也不会互相顶掉；扫描时一起认，界面上照样能选。
 */
export function coreRoot(): string {
  return path.join(dataRoot(), 'core')
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

type Backend = 'cuda' | 'vulkan' | 'hip' | 'cpu'

export interface BackendInfo {
  backend: Backend
  gpuReady: boolean
  installed: boolean
  /** 后端文件在、但显卡用不上时的原因（给界面直接显示一句话） */
  note?: string
  /** 缺的运行时文件，用户照着补 */
  missing?: string[]
}

/**
 * 检查 llama.cpp 目录里装的是哪个后端（决定会不会占用显存）。
 *
 * `installed` 单独报一次：目录不存在、或者里面没有 llama-server.exe 时，
 * 这是「没装」，不是「装了 CPU 版」——界面必须能分清，否则首次运行会误报 CPU 版。
 *
 * CUDA 光有 `ggml-cuda.dll` 不算数：cuBLAS / cudart 是**另一个安装包**
 * （cudart-llama-bin-win-cuda-*.zip，373MB）。只有主包时，llama.cpp 加载
 * ggml-cuda.dll 失败会**静默退回 CPU** —— 界面上写着「GPU · CUDA」，跑起来显存一动不动，
 * 生成速度掉到 1/5。这是 v0.1.2 上一版真实踩到的坑，所以这里必须把运行库一起验。
 */
export async function detectBackend(): Promise<BackendInfo> {
  // 主程序不在就当没装，连带文件清单都不用看
  const installed = (await llamaServerExe()) !== null
  if (!installed) return { backend: 'cpu', gpuReady: false, installed: false }
  const files = await fs.readdir(llamaRoot()).catch(() => [] as string[])
  const has = (re: RegExp) => files.some((f) => re.test(f))

  if (has(/^ggml-cuda.*\.dll$/i)) {
    // 版本号不写死：按目录里实际有什么认，缺哪几个就报哪几个
    const missing: string[] = []
    if (!has(/^cudart64_\d+\.dll$/i)) missing.push('cudart64_12.dll')
    if (!has(/^cublas64_\d+\.dll$/i)) missing.push('cublas64_12.dll')
    if (!has(/^cublasLt64_\d+\.dll$/i)) missing.push('cublasLt64_12.dll')
    if (missing.length) {
      return {
        backend: 'cpu',
        gpuReady: false,
        installed: true,
        missing,
        note:
          `CUDA 版缺运行库（${missing.join('、')}），llama.cpp 会退回 CPU 跑：` +
          '不占显存、速度只有显卡的 1/5～1/10。点「一键安装」补齐（会单独下载 cudart 包），' +
          '或手动把 cudart-llama-bin-win-cuda-*.zip 解压到 llama.cpp/ 目录。'
      }
    }
    return { backend: 'cuda', gpuReady: true, installed: true }
  }
  if (has(/^ggml-vulkan\.dll$/i)) return { backend: 'vulkan', gpuReady: true, installed: true }
  if (has(/^ggml-hip.*\.dll$/i)) return { backend: 'hip', gpuReady: true, installed: true }
  return { backend: 'cpu', gpuReady: false, installed: true }
}

/**
 * 问 llama.cpp 自己「你能用哪些设备」。
 *
 * 返回空数组 = 只有 CPU（或者显卡后端根本没加载起来）。
 * 这是唯一可信的判断依据：靠文件名猜会像上面那样猜错，
 * 而 `--list-devices` 给出的是 llama.cpp 真正准备好的后端列表。
 */
async function llamaDeviceIds(): Promise<string[]> {
  return (await listLlamaDevices()).map((d) => d.id)
}

/**
 * 直连 GitHub API 取产物清单（被墙 / 限流时返回 null）。
 *
 * 挑包交给 gpuplan：那里会先探显卡（nvidia-smi → WMI），
 * 有 N 卡选 CUDA、A 卡 / 核显选 Vulkan，只有确实没有可用显卡才落到 CPU 包。
 */
async function planViaApi(): Promise<InstallPlan | null> {
  try {
    const res = await fetchWithTimeout(RELEASE_API, 15000, {
      headers: { 'user-agent': 'roroto-code', accept: 'application/vnd.github+json' }
    })
    if (!res.ok) return null
    const releases = (await res.json()) as Array<{ assets?: ReleaseAsset[] }>
    const probe = detectGpuPreference()
    const hints: PackageHints = hintsOf(probe)
    for (const rel of releases) {
      const plan = planFromAssets(rel.assets ?? [], probe.preference, hints)
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

/**
 * 已装 llama.cpp 自己报的 build 数。
 *
 * `llama-server --version` 输出形如 `version: 0.9.0-dev (build 12211, commit ...)`，
 * 这是最可靠的「已装版本」来源：不用落版本标记文件，手动解压安装的目录也能识别。
 * 老版本 llama.cpp 可能没有 --version 或输出格式不同——识别不出就返回 null，
 * 上层宁可不报更新，也不能拿不准的版本号误报。
 */
export async function installedLlamaBuild(): Promise<number | null> {
  const exe = await llamaServerExe()
  if (!exe) return null
  try {
    const r = spawnSync(exe, ['--version'], {
      windowsHide: true,
      timeout: 15000,
      encoding: 'utf8',
      cwd: path.dirname(exe)
    })
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    const m = out.match(/build\s+(\d{3,6})/i)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

/**
 * API 直连时的最新构建版 build 数。
 *
 * 坑：不能拿 `releases/latest` 当最新——llama.cpp 会把某个版本号 release
 * （如 v0.9.0）标成 latest，而每天发布的构建版（b12211 这种）不带 latest 标记。
 * /releases 列表按时间倒序，第一个 `b\d+` tag 就是最新构建。
 */
async function latestBuildViaApi(): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(RELEASE_API, 15000, {
      headers: { 'user-agent': 'roroto-code', accept: 'application/vnd.github+json' }
    })
    if (!res.ok) return null
    const releases = (await res.json()) as Array<{ tag_name?: string }>
    for (const rel of releases) {
      const m = rel.tag_name?.match(/^b(\d{3,6})$/i)
      if (m) return Number(m[1])
    }
    return null
  } catch {
    return null
  }
}

/**
 * 检查 llama.cpp 有没有新版本：已装 build < GitHub 最新 build 即「可更新」。
 *
 * 只在面板打开时由界面定期调用，主进程不做定时器——避免为没人看的面板
 * 后台常驻打 GitHub（被墙环境下每次探测都要试好几个镜像）。
 */
export async function checkLlamaUpdate(): Promise<LlamaUpdateInfo> {
  const installed = (await llamaServerExe()) !== null
  if (!installed) return { installed: false, updateAvailable: false }
  const installedBuild = await installedLlamaBuild()
  // 优先 API 直连；镜像页缓存常滞后好几天，只能当兜底
  const viaTag = await latestBuildViaApi()
  const tag = viaTag !== null ? `b${viaTag}` : await latestTag()
  if (!installedBuild || !tag) {
    return {
      installed: true,
      installedBuild: installedBuild ?? undefined,
      updateAvailable: false,
      note: !installedBuild ? '识别不出已装版本号' : '取不到最新版本号（GitHub 与镜像都不通）'
    }
  }
  const latestBuild = Number(tag.replace(/^b/i, ''))
  return { installed: true, installedBuild, latestBuild, updateAvailable: latestBuild > installedBuild }
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
 *
 * 候选顺序跟着本机显卡走（见 gpuplan）：有 N 卡先试 CUDA，A 卡 / 核显试 Vulkan，
 * 确实没有显卡才落到 CPU 包 —— 别让「API 不通」这条路径变成默认装 CPU 版的原因。
 */
async function planViaMirror(): Promise<InstallPlan | null> {
  const tag = await latestTag()
  if (!tag) return null
  const probe = detectGpuPreference()
  const hints = hintsOf(probe)
  const candidates = candidateNames(tag, probe.preference, hints)

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
    const plan = planFromAssets(assets, probe.preference, hints)
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
export async function findMmprojFor(
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

/**
 * 最近一次安装进度：面板被卸载/重开时靠它把进度条接回来。
 * 下载本身在主进程里跑，跟哪个面板在前台毫无关系。
 */
let lastSetup: SetupProgress | null = null

export function llamaSetupSnapshot(): SetupProgress | null {
  return lastSetup
}

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
  // 已经有安装在下：直接告诉用户在跑，别起第二份把同一个 zip 写坏
  if (installAbort) {
    return {
      ok: false,
      message: 'llama.cpp 正在下载中，进度在面板上；等它下完再点（不用担心切走页面，下载不会中断）',
      dir
    }
  }
  const signal = new AbortController()
  installAbort = signal
  lastSetup = null
  // 进度回调只当「播报」用：界面抛错（面板卸载、窗口刷新）绝不能让下载失败
  const emit = (p: SetupProgress): void => {
    lastSetup = p
    try {
      onProgress?.(p)
    } catch {
      // 没人收进度就算了，字节照下
    }
  }
  try {
    await fs.mkdir(dir, { recursive: true })

    // 版本信息可能要试直连 + 镜像，先给个阶段提示，别让界面像卡死
    emit({ kind: 'llama', receivedBytes: 0, totalBytes: 0, state: 'preparing', message: '正在获取最新版本信息…' })
    const plan = await latestAsset()
    if (!isMainPackage(plan.main.name)) {
      throw new Error(`获取到的安装包不是主程序包（${plan.main.name}），请稍后重试或手动下载`)
    }
    const all = [plan.main, ...plan.extras]
    // 把「为什么选这个包」说出来：用户看到 cuda-12.4 才知道显卡真的会被用上，
    // 看到 cpu 也知道是确实没探到显卡，而不是程序随便下的
    const probe = detectGpuPreference()
    emit({
      kind: 'llama',
      receivedBytes: 0,
      totalBytes: 0,
      state: 'preparing',
      message: `将下载 ${all.map((a) => a.name).join('、')}（${probe.reason}）`
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
    const info = await detectBackend()
    /**
     * 换了一整套二进制（可能从 CUDA 换成 Vulkan、也可能 build 升级），
     * 之前缓存的「算力 / 分档 / 能不能看到 GPU」全部作废，重新探一次。
     * 不清的话诊断面板会拿旧 build 的结论说「不支持 -fa on」，而新包明明支持。
     */
    clearGpuProbeCache()
    const kind =
      info.backend === 'cuda'
        ? 'CUDA 版（会使用显卡）'
        : info.backend === 'vulkan'
          ? 'Vulkan 版（会使用显卡）'
          : info.backend === 'hip'
            ? 'ROCm 版（会使用显卡）'
            : 'CPU 版（不使用显卡）'
    /**
     * 装完自证：确认 llama.cpp 真的能列出显卡。
     *
     * 「文件都在」不等于「能用」—— 主包装好了、cudart 包没下成功时就是这样：
     * 界面写着 CUDA 版，一跑却全在 CPU 上。这里用 --list-devices 实测一次，
     * 不合格就当场说清楚，别让用户过几天自己发现显存没动。
     */
    const gpuPkg = /-cuda-|-vulkan-|-hip-/i.test(plan.main.name)
    const devices = gpuPkg ? await llamaDeviceIds() : []
    let warn = ''
    if (info.missing?.length) {
      warn =
        `\n⚠ ${info.note}\n` +
        '如果点「一键安装」仍然缺，说明该版本没有配套的 cudart 包：手动下载 cudart-llama-bin-win-cuda-*.zip 解压到本目录即可。'
    } else if (gpuPkg && !devices.length) {
      warn =
        '\n⚠ 装的是显卡版，但 llama.cpp 现在列不出任何 GPU：多半是显卡驱动太旧，或运行库没解压到同一目录。' +
        '在修好之前启动会退回 CPU（不占显存、明显更慢）。'
    }
    const msg = `安装完成：${kind}${warn}`
    emit({ kind: 'llama', receivedBytes: 0, totalBytes: 0, state: 'done', message: msg })
    return {
      ok: true,
      message:
        `已安装 llama.cpp 到 ${dir}\n后端：${kind}` +
        `\n选择依据：${probe.reason}` +
        (devices.length ? `\n可用设备：${devices.join('、')}` : '') +
        `\n来源：${used.join('、')}${warn}`,
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
  port?: number,
  activate?: boolean,
  /**
   * 是否把本次的 ctx 写回 `contextWindow`。
   *
   * 探测链会在 4~5 个档位之间反复起停，中间态写进配置只会让界面数字乱跳、
   * 还会覆盖别处刚改的设置。所以探测内部的重启传 false，定档后由探测链
   * 自己写一次最终值。
   */
  writeCtx = true
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
    // 服务端按 ctx 开了多大，配置就记多大：写小了预算跟着缩水，白开那么多显存。
    // 探测内部重启传 writeCtx=false：中间档位不是最终结论。
    if (writeCtx && ctx && ctx >= 2048) target.contextWindow = Math.min(Math.round(ctx), CONTEXT_RANGE.max)
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

  // 三种情形，别混在一起：
  // ① 用户主动「启动并使用」→ 切过去（activate）；
  // ② 后台自动拉起（兜底 / 工人模型）指定了 providerId → 保持用户当前选择；
  // ③ 老的单实例路径 / 自动创建 → 顺手切过去。
  const nextActive = activate ? target.id : providerId ? config.activeId ?? target.id : target.id
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
  const base = dataRoot()
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
  /** 相对路径 → 文件字节数（读不到的文件不出现在这里） */
  sizes?: Record<string, number>
}> {
  const abs = await allGgufs()
  const base = dataRoot()

  /**
   * 同名模型只留一条。
   *
   * 三个扫描根目录（models/、llama.cpp/models/、core/）里很容易出现同一份权重：
   * 老版本下到 `llama.cpp/models/`、新版本又下到 `models/`，用户自己再拷一份也是常事。
   * 它们在列表里长得一模一样，唯一差别是**投影器只跟其中一份放在同一目录**，
   * 于是界面出现「两个同名模型，一个可看图、一个缺投影器」——用户没法判断该点哪个，
   * 点错就是「看图功能突然没了」。
   *
   * 判据按文件名（大小写不敏感）归并，保留信息最全的那一份：有配套投影器优先，
   * 其次在 models/ 下（新下载都落这里），最后比体积大的。
   */
  type ScanEntry = { abs: string; rel: string; size: number; vision: 'ready' | 'missing' | 'text' }
  const scanned: ScanEntry[] = await Promise.all(
    abs.map(async (f) => {
      const rel0 = path.relative(base, f)
      const rel = rel0 && !rel0.startsWith('..') ? rel0.replace(/\\/g, '/') : f
      let size = 0
      try {
        size = (await fs.stat(f)).size
      } catch {
        // 扫描到一半文件被外面删了：不显示体积即可，不能让整个列表挂掉
      }
      // 每个模型都算一次「能不能看图」。读的是 GGUF 文件头和目录列表，不加载权重，
      // 十个模型也就几十毫秒。ignoreConfig：这里问的是模型自己有没有配套投影器，
      // 不该被某条配置里的显式覆盖带偏。
      let vision: ScanEntry['vision'] = 'text'
      if (await findMmprojFor(f, undefined, { ignoreConfig: true })) {
        vision = 'ready'
      } else {
        const meta = await readGgufMeta(f).catch(() => null)
        vision = meta && ggufLooksVision(meta.architecture, meta.name) ? 'missing' : 'text'
      }
      return { abs: f, rel, size, vision }
    })
  )

  /** 保留优先级：能看图 > 缺投影器 > 文本；同档比目录（models/ 优先）再比体积 */
  const rank = (e: ScanEntry): number =>
    (e.vision === 'ready' ? 4 : e.vision === 'missing' ? 2 : 0) +
    (e.rel.startsWith('models/') ? 1 : 0)
  const kept: ScanEntry[] = []
  const byName = new Map<string, ScanEntry>()
  for (const e of scanned) {
    const key = path.basename(e.rel).toLowerCase()
    const prev = byName.get(key)
    if (!prev) {
      byName.set(key, e)
      kept.push(e)
      continue
    }
    // 同名：换掉信息更差的那份，但位置不变（列表顺序保持原样）
    if (rank(e) > rank(prev) || (rank(e) === rank(prev) && e.size > prev.size)) {
      byName.set(key, e)
      kept[kept.indexOf(prev)] = e
    }
  }
  const files = kept.map((e) => e.rel)

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

  // 体积与看图状态直接取前面扫出来的结论：同名模型已经归并过，
  // 这里只保留最终留下的那一份（hidden 副本的 rel 不会出现在 files 里）
  const vision: Record<string, 'ready' | 'missing' | 'text'> = {}
  /** 相对路径 → 字节数。删不删、还剩多少空间，用户得有数才谈得上「清理」 */
  const sizes: Record<string, number> = {}
  for (const e of kept) {
    vision[e.rel] = e.vision
    if (e.size > 0) sizes[e.rel] = e.size
  }

  return {
    ok: true,
    models,
    dir: modelsRoot(),
    vision,
    sizes,
    message: models.length
      ? `找到 ${models.length} 个模型`
      : '未找到 .gguf 模型。可放在 llama.cpp/ 或 models/ 目录下'
  }
}

/**
 * 删掉一个本地模型文件。
 *
 * 三道闸，缺一不可：
 * - 只能删 `.gguf`，且必须落在本程序自己的模型目录里（llama.cpp / models / core）。
 *   界面传来的路径是不可信输入，`../` 之类必须在这里挡掉，不能靠前端自觉。
 * - 正在跑的实例不管：Windows 会锁住文件，删出来只有半个残骸，还可能把进程搞崩。
 * - 配套投影器一起删。它不出现在模型列表里（扫描时就被过滤了），单独留下
 *   就是永远不会被发现的垃圾 —— 用户以为清理干净了，其实还占着几百 MB。
 */
export async function deleteLocalModel(
  rel: string
): Promise<{ ok: boolean; message: string; freedBytes?: number }> {
  const wanted = (rel || '').trim()
  if (!wanted) return { ok: false, message: '没指定要删哪个模型' }

  const abs = await resolveModelPath(wanted, true)
  if (!abs) return { ok: false, message: `找不到这个模型：${wanted}` }
  if (!isModelFileName(abs)) return { ok: false, message: '只允许删除 .gguf 文件' }

  if (!isInsideAnyRoot([llamaRoot(), modelsRoot(), coreRoot()], abs)) {
    return { ok: false, message: '这个文件不在本地模型目录里，程序不碰目录外的文件' }
  }

  const target = path.resolve(abs).toLowerCase()
  const busy = [...instances.values()].find((i) => path.resolve(i.model).toLowerCase() === target)
  if (busy) {
    return { ok: false, message: `「${path.basename(abs)}」正在运行，先点「停止服务」再删` }
  }

  const targets = [abs]
  const mm = await findMmprojFor(abs, undefined, { ignoreConfig: true }).catch(() => null)
  if (mm) targets.push(mm)

  let freed = 0
  for (const t of targets) {
    // .part 是下载中断留下的半截文件，一并清掉
    for (const f of [t, `${t}.part`]) {
      try {
        const st = await fs.stat(f)
        await fs.rm(f, { force: true })
        if (f === t) freed += st.size
      } catch {
        // 不存在就跳过；删不掉（被别的程序占用）留给下面统一判断
      }
    }
  }

  let still = false
  try {
    await fs.access(abs)
    still = true
  } catch {
    still = false
  }
  if (still) {
    return { ok: false, message: `删除失败：${path.basename(abs)} 可能正被别的程序占用` }
  }

  const mmNote = mm ? `，同时删掉配套投影器 ${path.basename(mm)}` : ''
  return {
    ok: true,
    message: `已删除 ${path.basename(abs)}（释放 ${(freed / 1024 ** 3).toFixed(1)} GB）${mmNote}`,
    freedBytes: freed
  }
}

/**
 * 把界面传来的模型名/路径解析成绝对路径。
 *
 * `strict` 决定「点名要 A、A 却不在」时怎么办：
 * - 非严格（默认）：退回第一个本地 .gguf，保证「随便点一个」也能起得来
 * - 严格：返回空串，由调用方明确报「找不到这个模型」
 *
 * 启动必须走严格模式。以前的静默退回制造过很难查的现场：参数写的是 3B，
 * 实际加载的是目录里排第一的那个（恰好是个当前版本不认的架构），llama-server
 * 秒退，而界面只显示「服务未运行」—— 用户完全看不出「跑的根本不是他要的模型」。
 */
async function resolveModelPath(wantedModel?: string, strict = false): Promise<string> {
  const ggufs = await allGgufs()
  const wanted = wantedModel?.trim() ?? ''
  if (wanted) {
    const candidates = path.isAbsolute(wanted)
      ? [wanted]
      : [path.join(dataRoot(), wanted), path.join(llamaRoot(), wanted), path.join(modelsRoot(), wanted)]
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
    // 点名了一个不存在的模型：严格模式下如实返回「没有」
    if (strict) return ''
  }
  return ggufs[0] ?? ''
}

/**
 * 设备参数。
 *
 * 关键就是 `-dev`：只把层放到指定那一张卡上，llama.cpp 就不会去做跨卡切分，
 * 两张卡各跑一个模型才能真正并行（这是「双卡双模型」而不是「一个模型切两半」）。
 *
 * `-ngl` 分两种口径：
 * - `all`（默认）：写死 999。不写的话不同版本默认值不一样，可能出现「只放了一半层」。
 * - `auto`：整模型装不下时交给 llama.cpp 自己分配 —— 它会按每层的真实张量大小
 *   逐层试装，装到放不下为止，剩下的层留在 CPU。我们自己的静态估算做不到这么细
 *   （输出层、token_embd 往往单独成 buffer），所以这一档不自己算层数。
 *
 * 没绑卡（设置里选「自动」）时不能直接 return []：那样既没有 `-dev` 也没有 `-ngl auto`，
 * 项目自己的分层分支就永远不生效，只能靠 llama.cpp 内置的 `--fit` 兜着。
 * 这时只给 `-ngl auto`（不带 `-dev`），多卡机器仍会按所有卡逐层分配。
 */
function deviceArgs(device: string, ngl: 'all' | 'auto' = 'all'): string[] {
  const d = device.trim()
  if (!d) return ngl === 'auto' ? ['-ngl', 'auto'] : []
  if (/^cpu$/i.test(d)) return ['-ngl', '0']
  return ['-dev', d, '-ngl', ngl === 'auto' ? 'auto' : '999']
}

export interface LlamaStartOptions {
  /** 属于哪个供应商：不同供应商各自一个实例，互不干扰 */
  providerId?: string
  /** 绑定显卡（覆盖配置里的值）；传空字符串表示不绑定 */
  device?: string | null
  /** 指定端口（覆盖配置里的值） */
  port?: number
  /**
   * 同时把这条设为「当前使用的模型」（写 activeId）。
   *
   * 只有用户主动点「启动并使用」时才传 true：后台兜底（核心模型、工人模型、
   * 定时任务）拉起实例时必须保持用户原本选中的模型，否则跑一次子任务就把
   * 对话界面顶栏的模型换掉了。
   */
  activate?: boolean
  /**
   * 这次要不要挂视觉投影器（--mmproj）。
   *
   * 默认 **不挂**：投影器一挂上，文本解码会掉到原来的 1/3～1/4（实测同一台机器
   * 55 t/s → 16～24 t/s），代价远超收益。只有在用户真的发了图片时才由
   * setLlamaVision(true) 显式要求挂上。设了环境变量 LLAMA_ARG_MMPROJ 的仍然常开。
   */
  vision?: boolean
  /**
   * 切换视觉时不要顺手清掉别的实例。
   *
   * 默认行为是「换模型就把没绑卡的实例都停掉」——对用户主动切模型是对的，
   * 但为了一张图重启，把正在给子 agent 干活的工人模型一起干掉就太粗暴了。
   */
  keepSiblings?: boolean
  /**
   * 本次启动是不是「实测调档」触发的那一次重启。
   *
   * 调档要先启动一次量占用、再按结果重启到更大的档位；重启那次必须带上这个标记，
   * 否则量完又会想再调一档，变成无限重启。
   */
  tuned?: boolean
  /**
   * 用户在「本地模型」面板里点名了某一档上下文（4K / 8K / 16K / 32K …）。
   *
   * 显式选择必须照办：启动时本来就会跳过 ctxOverride 的自动定档，但就绪后
   * tuneAfterReady() 还会按实测显存自动升/降档（16K → 64K），结果是「点了 8K
   * 却跑在 64K」。带这个标记时只记录实测占用，绝不自动改档、也不再重启。
   * 「自动」按钮和后台兜底不带它，仍按原来的自愈逻辑挑最合适的档。
   */
  ctxExplicit?: boolean
  /**
   * 探测链内部发起的重启。
   *
   * 带这个标记时：不写 `contextWindow`（探测会在 4~5 个档位之间来回起停，
   * 每写一次都会让界面上的数字跳一遍，而且中间态没有任何意义）、
   * 不再触发新的探测（否则递归），只负责把一个档位拉起来。
   */
  internal?: boolean
  /**
   * 覆盖槽位数。探测时固定传 0（单槽）：
   * 多槽会把 KV 池按槽切分，64K/4 槽 = 16K/槽，判据会误判成「窗口不够」，
   * 而真实原因是槽位数而不是显存。
   */
  parallel?: number
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
  /** 部分层在 CPU：界面要提示「能跑但更慢」，别让人以为显卡没生效 */
  partial: boolean
}> {
  return [...instances.values()].map((i) => ({
    key: i.key,
    port: i.port,
    model: path.basename(i.model),
    device: i.device,
    pid: i.pid,
    ctx: i.ctx,
    partial: i.partial
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
  /**
   * 用户主动启动 / 手点档位 → 立刻叫停正在跑的自动探测。
   *
   * 探测链会在几秒后重启到它自己算出的档位。如果用户在这期间点了 8K，
   * 不打断的话过一会儿又会被抬回 64K —— 用户看到的就是「点了没反应」。
   * 探测内部的重启带 internal 标记，不算用户意图，不能自己取消自己。
   */
  if (!opts?.internal && (opts?.ctxExplicit || opts?.activate)) cancelContextProbe()

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
  /**
   * 槽位数覆盖：探测链固定传 0（单槽）。
   * 多槽会把 KV 池按槽切分，64K/4 = 16K/槽，判据会误判成「窗口不够」，
   * 而真实原因只是槽位数。探测只关心「这一档装不装得下」。
   */
  const parallelOverride = Number(opts?.parallel)
  let parallel = Number.isFinite(parallelOverride)
    ? Math.max(0, Math.min(8, Math.round(parallelOverride)))
    : wantParallel >= 2 && wantParallel <= 8
      ? wantParallel
      : 0
  /**
   * 规范化：0 和 1 都是「单槽」，统一成 1。
   *
   * 0 的旧语义是「不传 -np，让 llama.cpp 自己决定」，而 b12110 自己决定的是 **4 槽**。
   * 8 GB 卡上实测：单请求 13 tok/s，4 槽下两个请求并发 decode 掉到 1.55 tok/s。
   * 所以「不传」不再是选项，永远显式告诉服务端要几个槽。
   */
  if (parallel <= 1) parallel = 1
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

  const full = await resolveModelPath(model, true)
  if (!full) {
    const want = (model ?? '').trim()
    return {
      ok: false,
      code: 'MODEL_MISSING',
      message: want
        ? `找不到模型「${want}」：models/ 目录里没有这个文件。换个模型，或把对应的 .gguf 放回 ${modelsRoot()}。`
        : '未找到 .gguf 模型，请先获取模型'
    }
  }

  /**
   * 找配套的多模态投影器。必须在判断「能否复用旧进程」之前算出来：
   * 同一个主模型，从「纯文字」换成「带投影器」也必须重启 llama-server。
   *
   * 注意这里分两步：`available` 只是「这个模型配不配得上投影器」，
   * 真正要不要挂由 vision 决定 —— 默认纯文本，发图时才按需重启挂上。
   */
  const availableMmproj = await findMmprojFor(full, provider?.id)
  const wantVision = opts?.vision === true || Boolean(process.env.LLAMA_ARG_MMPROJ?.trim())
  const mmproj = wantVision ? availableMmproj : null

  /**
   * 这次启动的看图状态，三种情况分开说：
   * 真挂上了 / 有投影器但按需（默认）/ 压根没投影器。
   * 混成一句「没找到投影器」，按需模式下每次启动都会误报成模型有问题。
   */
  const visionNote = async (): Promise<string> => {
    if (mmproj) return `\n视觉投影器：${path.basename(mmproj)}（已挂到主模型，可以看图）`
    if (availableMmproj)
      return `\n视觉按需加载：当前是纯文本模式（解码最快），发图片时会自动重启服务挂上 ${path.basename(availableMmproj)}（约 10 秒）`
    return missingProjectorNote(full)
  }

  // 同一个供应商、同模型、同投影器、同显卡、同上下文 → 直接复用，不重启
  const running = instances.get(key)
  const wantCtx = Number(ctxOverride)
  const ctxSame = !(Number.isFinite(wantCtx) && wantCtx >= 2048) || Math.round(wantCtx) === running?.ctx
  const sameShape =
    !!running &&
    running.model === full &&
    (running.mmproj ?? '') === (mmproj ?? '') &&
    running.device === device &&
    // 槽位规范化后旧状态文件里的 0 等于 1，别为了这个数字白重启一次
    (running.parallel || 1) === parallel &&
    ctxSame

  if (running && sameShape) {
    // 先证明它还活着，再决定复用 —— 不验证就会把请求发到死端口上。
    // 外部认领进来的实例（pid 为 null）同样适用：服务健康就直接用，别杀掉重启。
    const probe = await probeInstance(running)
    if (probe.alive) {
      const applied = await applyLlamaConfig(
        provider?.id,
        path.basename(full),
        undefined,
        Boolean(mmproj),
        running.port,
        opts?.activate
      )
      // 复用旧进程时也要说清楚看图状态：否则用户看到「已在运行」就以为一切正常
      const reuseNote = await visionNote()
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

  // 再清别的实例：绑了不同显卡的留着，其余停掉。
  // keepSiblings 用于「只是为了一张图重启」——那时把工人模型一起杀掉太粗暴。
  for (const other of [...instances.values()]) {
    if (other.key === key) continue
    if (opts?.keepSiblings) continue
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
          parallel: 0,
          // 外部拉起的实例：是不是部分卸载只有它自己知道，不臆测
          partial: false
        })
        await persistState()
        const applied = await applyLlamaConfig(
          provider?.id,
          same,
          undefined,
          Boolean(mmproj),
          port,
          opts?.activate
        )
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

  /**
   * 起进程前先问一句「这次到底有没有显卡可用」。
   *
   * 缺 CUDA 运行库时 llama.cpp 不报错，只是安静地用 CPU —— 用户看到的是
   * 「模型加载好了、也能回答，可显存一动不动」。这种沉默最难查，所以在启动路径上明说，
   * 而不是等他去任务管理器里发现。
   */
  const devices = await llamaDeviceIds()
  /**
   * 这次要算哪张卡：绑了就用绑的，没绑（「自动」）就是第一张。
   * 体检、KV 精度、性能分档三处都按这个号取，才不会出现
   * 「按 0 号卡算显存、按 1 号卡定 FA」这种自相矛盾的组合。
   */
  const gpuIdx = deviceIndex(device)
  let gpuNote = ''
  if (!devices.length) {
    const info = await detectBackend()
    const why = info.missing?.length
      ? `缺 CUDA 运行库（${info.missing.join('、')}）`
      : info.installed
        ? '显卡后端没加载起来（驱动太旧，或目录里只有 CPU 版文件）'
        : '还没装 llama.cpp'
    // 用户明确要把模型钉在某张卡上：做不到就别假装启动了
    if (device) {
      return {
        ok: false,
        code: 'GPU_UNAVAILABLE',
        message:
          `llama.cpp 看不到任何 GPU（${why}），无法按你的要求绑到 ${device}。\n` +
          '先把运行库补齐，或到「软件设置 → 模型」把「显卡」改成自动 / CPU。'
      }
    }
    gpuNote = `\n⚠ 这台机器上 llama.cpp 没有可用 GPU（${why}），本次是纯 CPU 运行：不占显存，速度慢 5～10 倍。`
  } else if (device && !devices.some((d) => d.toLowerCase() === device.toLowerCase())) {
    return {
      ok: false,
      code: 'GPU_UNAVAILABLE',
      message: `llama.cpp 只认到 ${devices.join('、')}，没有 ${device}。请在设置里重新选一张卡，或改成自动。`
    }
  } else {
    // 有 GPU：把按显卡分档的策略说明写进日志，让「为什么这卡没开 FA」这类问题有据可查
    const note = await gpuProfileNote(gpuIdx)
    if (note) gpuNote = `\n性能档位：${note}`
    /**
     * 驱动 / 包不匹配这类问题要在**装之前**说，而不是等 `--list-devices` 空掉再猜。
     * 典型两种：驱动只支持到 CUDA 11.x 却装了 CUDA 12 包；RTX 50 配了 12.4 的运行时。
     */
    const probe = detectGpuPreference()
    if (probe.warnings?.length) gpuNote += `\n⚠ ${probe.warnings.join('\n⚠ ')}`
  }

  try {
    // 上下文长度定夺，优先级：调用方点名 > 实测过的档位 > 体检建议 > 配置上限。
    //
    // 体检要按「这次绑的那张卡」算：双卡机器上拿 GPU0 的余量去估 GPU1 上的模型，
    // 算出来的档位必然偏大（或者偏小），启动时就可能 OOM 或白白浪费显存。
    const want = Number(ctxOverride)
    let ctx: number
    let ctxNote = ''
    /**
     * 体检结论要留给「就绪后实测」用，所以提到 try 外层的作用域。
     * 之前它只在 else 分支里活着，导致只有「没点名 ctx」的路径能拿到档位信息。
     */
    let fitInfo: Awaited<ReturnType<typeof fitForLaunch>> = null
    /**
     * 这次启动要不要接探测链：首次装、换了模型、或者环境指纹变了。
     *
     * 一旦接了探测链，就绪后就不能再跑 tuneAfterReady —— 两条链都会重启服务，
     * 互相把对方的档位覆盖掉。二选一，由这里决定。
     */
    let probeSeed: { fp: string; maxCtx: number; minCtx: number } | null = null
    /**
     * 本次启动的环境指纹。提到外层是因为 tuneAfterReady 也要写它 ——
     * 以前只有探测链成功那一支才落盘指纹，走「就绪后实测调档」这条快路径时
     * 结论存了、指纹没存，下次启动 sameFingerprint(undefined, fp) 恒为 false，
     * 于是每次都重新探测，白花 10~40 秒。
     */
    let fingerprint: string | undefined
    if (Number.isFinite(want) && want >= 2048) {
      ctx = Math.min(Math.round(want), CONTEXT_RANGE.max)
      /**
       * 手点档位也要体检，理由只有一个：决定「能不能部分 offload」。
       *
       * 这条分支以前完全不体检（只有一个 ctx 数字要什么体检），于是 `-ngl 999`
       * 无条件生效 —— 用户点一个装不下的档，进程直接 OOM 退出，界面上只看到
       * 「启动后立刻退出」，看不出是显存问题。多花这 200 毫秒换来一句准确的原因。
       */
      fitInfo = await fitForLaunch(full, gpuIdx, await launchKvType(gpuIdx), availableMmproj).catch(() => null)
    } else {
      ctx = await serverCtx(provider?.id)
      // KV 精度必须和真正要启动的参数一致，否则体检会低估一档（详见 launchKvType）
      const kvType = await launchKvType(gpuIdx)
      /**
       * 体检带上投影器：默认是纯文本启动，但用户随时可能发一张图，
       * 那时会自动重启挂上 mmproj，多出来的 300~700 MiB 会把「32K 装得下」变成 OOM。
       */
      const fit = await fitForLaunch(full, gpuIdx, kvType, availableMmproj).catch(() => null)
      fitInfo = fit

      /**
       * 环境指纹：决定「上次的实测结论还能不能用」。
       *
       * 只比模型名是不够的 —— 同名不同量化、重新下载过的文件都会被误判成同一个模型。
       * 所以把文件体积 + mtime、KV 精度、槽位数、FA、EXTRA 参数、显存预算全都算进去。
       */
      const modelFile = path.basename(full)
      const st = await fs.stat(full).catch(() => null)
      const cfgNow = await loadConfig()
      fingerprint = fingerprintOf({
        gpuName: fit?.gpuName ?? device ?? 'cpu',
        vramMiB: fit?.limitMiB ?? 0,
        // 驱动版本进指纹：换驱动后旧卡的实测占用/速度结论就不可信了
        driver: detectGpuPreference().driver ?? '',
        model: modelFile,
        modelBytes: st?.size ?? 0,
        modelMtimeMs: st?.mtimeMs ?? 0,
        kvType,
        parallel,
        flashAttn: process.env.ROROTO_LLAMA_NO_FA !== '1',
        extra: (process.env.ROROTO_LLAMA_EXTRA ?? '').trim(),
        contextLimit: cfgNow.contextLimit === true
      })
      const fp = fingerprint
      const cached = provider?.ctxProbe
      const fingerprintHit = sameFingerprint(provider?.ctxFingerprint, fp) && cached?.model === modelFile

      /**
       * 原生窗口缺失（GGUF 元数据不全）时不能按 128K 兜底：那等于让探测从最高档
       * 开始撞墙，白白多一次 10 秒重载。保守取 32K，够大多数指令模型用。
       */
      const nativeNum = Number(fit?.nativeCtx ?? 0)
      const nativeCap = nativeNum >= 2048 ? nativeNum : null
      const maxCtx = Math.min(CONTEXT_RANGE.max, nativeCap ?? 32768)

      if (!fingerprintHit) {
        /**
         * 首次 / 换模型 / 环境变了：以「体检算出的最大可装档」为起点。
         *
         * 以前这里只会往下压（`recommendedCtx < ctx` 才采用），默认配置是 16384，
         * 于是一台能装 64K 的机器首次也必然 16K 起步，再靠就绪后实测重载抬上去 ——
         * 白多一次 10 秒加载。现在改成直接采用，失败由探测链降档兜底。
         */
        /**
         * 权重本身就装不下时，别拿「原生窗口」当起点。
         *
         * probeStartTier 在没有推荐档时会退回 nativeCap（40960 / 256K）——
         * 那是一个 8.38 GB 的 14B 在 8 GB 卡上永远到不了的档位。它还会连带
         * 启动探测链，从最高档一路往下撞墙，白等好几分钟，最后报「跑不动」，
         * 而实际上分层是能跑的。这里直接沿用用户配置的窗口，交给分层处理。
         */
        const start = fit && fit.fits === false && !fit.recommendedCtx
          ? Math.min(ctx, maxCtx)
          : probeStartTier({
            recommendedCtx: fit?.recommendedCtx ?? null,
            nativeCtx: nativeCap,
            maxCtx,
            minCtx: 4096,
            /**
             * 贴边（need > limit × 0.85）时主动降一档。
             * 这一步以前是空的：参数算了却没传，于是 8 GB 卡上 9B 模型算出 64K
             * 就直接按 64K 起，装不下再花 10 秒重载降档 —— 白白多一次失败。
             */
            tight: fit?.tightAtStart === true
          })
        if (start !== ctx) {
          ctxNote = fit?.tightAtStart
            ? `\n体检：${Math.round((fit.recommendedCtx ?? start) / 1024)}K 的占用贴着显存上限（容易 OOM），已降一档按 ${Math.round(start / 1024)}K 启动`
            : `\n体检：这台机器上最多装得下 ${Math.round(start / 1024)}K，本次直接按该档启动（配置值 ${Math.round(ctx / 1024)}K）`
          ctx = start
        }
        /**
         * 只有「自动档 + 有 GPU + 权重装得下」才探测。判据见 shouldProbeChain：
         * 装不下的模型每一档都起不来，探测只会报「跑不动」，把分层挡在门外。
         */
        if (
          shouldProbeChain({
            weightFits: fit?.fits,
            hasBudget: Boolean(fit?.limitMiB),
            gpuAvailable: devices.length > 0,
            internal: opts?.internal,
            ctxExplicit: opts?.ctxExplicit,
            tuned: opts?.tuned
          })
        ) {
          probeSeed = { fp, maxCtx, minCtx: 4096 }
        }
      } else {
        /**
         * 指纹命中：上次的实测数据仍然可信，沿用原来的「ceiling 压 + probe 抬」。
         * 这段是快路径：不重载、不探测，直接算出最合适的档位。
         */
        const ceiling = provider?.ctxCeiling
        const cap = Math.min(Number(ceiling ?? Infinity) || Infinity, Number(fit?.nativeCtx ?? Infinity) || Infinity)
        if (Number.isFinite(cap) && ctx > cap) {
          ctxNote += `\n实测：这个模型在 ${Math.round(cap / 1024)}K 以上装不下，已从 ${Math.round(ctx / 1024)}K 压下来`
          ctx = cap
        }
        const probe = provider?.ctxProbe
        if (probe && probe.model === path.basename(full) && probe.footMiB > 0 && fit?.limitMiB && fit.kvMiBPerKToken) {
          const pick = bestTier({
            probe: { ctx: probe.ctx, footMiB: probe.footMiB },
            kvMiBPerK: fit.kvMiBPerKToken,
            limitMiB: fit.limitMiB,
            reserveMiB: PROBE_RESERVE_MIB,
            nativeCtx: Number.isFinite(cap) ? cap : fit.nativeCtx
          })
          if (pick.ctx > ctx) {
            ctxNote += `\n实测：上次在 ${Math.round(probe.ctx / 1024)}K 下占用 ${probe.footMiB} MiB，按每 1K tokens ${fit.kvMiBPerKToken.toFixed(0)} MiB 算能开到 ${Math.round(pick.ctx / 1024)}K，已抬上去`
            ctx = pick.ctx
          }
        }
      }
      // 多槽与显存联动：权重本身就装不下（部分层要落到 CPU）时，多槽只会让每个请求
      // 都更慢（KV 被按槽切分 + CPU 分担），强制回到单槽并说明，而不是「照用户配置硬开」。
      if (fit && parallel >= 2 && !fit.fits) {
        ctxNote += `\n体检：${fit.gpuName ?? '显卡'} 装不下这个模型的全部权重，多槽会拖慢速度，已从 ${parallel} 槽降回单槽`
        parallel = 1
      }
      /**
       * 小显存机器上多槽并不划算：并发不减少总计算量，只是把 GPU 时间切片，
       * 每个请求都变慢；而每多一个槽就多一份计算缓冲，进一步挤压本就紧张的余量。
       * 实测 8 GB 卡 + 9B 模型：单槽单请求 13 tok/s，4 槽下两个请求并发 1.55 tok/s。
       * 10 GB 以下统一单槽，让「慢一点但可用」取代「看起来并发其实是假死」。
       */
      if (fit?.limitMiB && parallel >= 2 && fit.limitMiB < MULTI_SLOT_MIN_MIB) {
        ctxNote += `\n体检：可用显存只有 ${(fit.limitMiB / 1024).toFixed(1)} GB，多槽并发会让每个请求都变慢，已改为单槽`
        parallel = 1
      }
    }
    /**
     * 这次真的要挂投影器（看图模式）时，窗口必须按「带图」的预算收一收。
     *
     * 以前切视觉是拿纯文本时的 ctx 原样重启：32K 文本实例的占用正好贴着上限，
     * 加上投影器（实测 680 MiB，大投影器能到 1.3 GB）就直接 OOM，
     * 而用户看到的只是「切视觉失败」。宁可窗口小一档，也要让图能看。
     *
     * 放在两个分支都收敛之后：手点档位和自动定档都可能算出比带图预算更大的窗口。
     */
    if (mmproj && fitInfo?.visionExtraMiB) {
      if (fitInfo.visionCtx && ctx > fitInfo.visionCtx) {
        ctxNote +=
          `\n看图模式：挂上投影器要多占 ${fitInfo.visionExtraMiB} MiB，` +
          `显存只够 ${Math.round(fitInfo.visionCtx / 1024)}K，已从 ${Math.round(ctx / 1024)}K 降到这一档`
        ctx = fitInfo.visionCtx
      } else if (!fitInfo.visionCtx) {
        ctxNote +=
          `\n看图模式：挂上投影器要多占 ${fitInfo.visionExtraMiB} MiB，` +
          '这个窗口一档都装不下，会按显存逐层分配（明显变慢）；想快就把上下文调小一档'
      }
    }
    /**
     * 分层模式：默认 `auto` —— 按这个模型自己判，装得下就全放显存，装不下才逐层分担。
     *
     * 为什么不再是一个全局开关：旧开关把「允许」当成了「总是」，界面永远显示「开」，
     * 用户看不出自己的模型会不会被拆层；要关还得去设置页翻。现在判据跟模型绑定，
     * 普通模型的行为完全不变。
     *
     * 判据见 shouldPartialOffload：模式没关 / 装不下（体检判定，或文件比预算还大）/
     * 真有显卡 / 不是探测链（探测链要的是「这一档行不行」的干净结论，混进分层会把
     * 速度判据带偏，把能用的档位误判成不可用）。
     *
     * 旧参数组合是「`-ngl 999` + 显式 `-c`」，两者都是显式值，llama.cpp 的 `--fit`
     * 无权改动它们 —— 于是装不下就等于 OOM、进程秒退。分层就是为了给 llama.cpp
     * 一个「按显存逐层分配」的机会：慢，但能跑。
     */
    const layerMode = partialModeOf({
      mode: cfg.llamaPartialOffloadMode,
      enabled: cfg.llamaPartialOffload
    })
    const modelStat = await fs.stat(full).catch(() => null)
    /**
     * 体检缺席时的显存预算兜底。
     *
     * vramfit 缺失 / 元数据读不懂时 `fitInfo.limitMiB` 是 null，于是
     * 「文件比预算大就分层」这条硬判据会静默失效 —— 8.38 GB 的 14B 在 8 GB 卡上
     * 直接按 `-ngl all` 起，OOM。这里用 nvidia-smi 按体检同一套系数
     * （(总量 − 已用) × 0.92，拿不到已用就按总量 × 0.8）补一个，判据就不会空转。
     */
    let devBudgetMiB: number | null = null
    if (!fitInfo?.limitMiB && devices.length) {
      const nv = nvidiaGpuInfo()
      const card = nv.gpus[gpuIdx] ?? nv.gpus[0] ?? null
      const totalMiB = card?.vramMB ?? null
      if (totalMiB) {
        const used = await sampleUsedMiB(gpuIdx).catch(() => null)
        devBudgetMiB = used?.usedMiB != null
          ? Math.round((totalMiB - used.usedMiB) * 0.92)
          : Math.round(totalMiB * 0.8)
      }
    }
    /**
     * `fits` 只回答「权重能不能全进显存」，不回答「这一档上下文装不装得下」。
     *
     * 手点一个高档时这两件事会分叉：7B 权重 4.5 GB 在 8 GB 卡上 fits=true，
     * 但 64K 的 KV 加起来就超预算。旧判据只看 fits，于是不分层、直接
     * `-ngl all` + 显式 `-c 65536` → OOM。所以这里补一条：
     * 这次的 ctx 超过体检给的「最大可装档」，同样要分层。
     */
    const ctxOverBudget = Boolean(fitInfo?.recommendedCtx && ctx > fitInfo.recommendedCtx)
    const partialOffload = shouldPartialOffload({
      mode: layerMode,
      fits: fitInfo ? fitInfo.fits && !ctxOverBudget : undefined,
      device,
      probing: !!probeSeed,
      gpuAvailable: devices.length > 0,
      // 体检缺席（没装 vramfit / 元数据不全）时的硬判据：文件比预算大就必然装不下
      modelBytes: modelStat?.size ?? null,
      budgetMiB: fitInfo?.limitMiB ?? devBudgetMiB
    })
    if (partialOffload) {
      ctxNote += ctxOverBudget
        ? `\n部分卸载：${Math.round(ctx / 1024)}K 这一档的上下文超出可用显存` +
          `（体检建议最大 ${Math.round((fitInfo?.recommendedCtx ?? ctx) / 1024)}K），已改为按显存逐层分配。` +
          '\n想全部放显存（最快）就点小一档；点了大档又不想慢，只能换小一点的模型或量化。'
        : `\n部分卸载：${fitInfo?.gpuName ?? (device || devices[0] || '显卡')} 放不下这个模型的全部权重，已改为按显存逐层分配` +
          `（约占 ${Math.round((fitInfo?.limitMiB ?? 0) / 1024)} GB 显存，其余层留在内存/CPU）。` +
          '\n速度取决于有多少层落到 CPU：留得越多越慢。实测 9B 只放 2.5 GB 上卡时约 3 tok/s，' +
          '放得多会明显好转；想稳定快就换更小的量化或模型。'
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
      // 模型 id 用文件名，见上面的说明
      '-a',
      path.basename(full),
      /**
       * 防「整段复读」的采样参数。
       *
       * 低温度（默认 0.2，接近贪心）+ 长输出预算下，小模型一旦开始重复
       * 某个段落就会一直重复到 max_tokens 耗尽——用户看到的是同一节标题
       * 和条目滚十几屏。这不是提示词能治的，得在解码层拦：
       *  - repeat-penalty 温和压一下连续 token 重复（代码/术语不受影响）；
       *  - DRY 专门罚「前面出现过的序列」，dry-penalty-last-n 必须放大到
       *    2048，默认的 64 太短，看不到一整段之前的重复块；
       *  - 中文一字一 token，allowed-length 从默认 2 提到 3，避免误伤
       *    「支持」「下载」这类两字词。
       * 客户端还有一层流式熔断（shared/degenerate.ts）兜外部启动的服务。
       */
      '--repeat-penalty',
      '1.05',
      '--repeat-last-n',
      '256',
      '--dry-multiplier',
      '0.8',
      '--dry-allowed-length',
      '3',
      '--dry-penalty-last-n',
      '2048',
      /**
       * 给推理模型的「思考」封顶。
       *
       * MiMo / DeepSeek-R1 蒸馏这类模型把 `<think>` 内容放在 reasoning_content，
       * 思考可以轻松写掉三四千 tokens。输出预算被吃光时正文为空（finish=length），
       * 界面表现为「一直转 / 空回复 / 隔一会儿又来一段」。实测同一道题：
       * 不封顶 → 思考 4164 字、正文 0 字；封 512 → 正文 1348 字、正常 stop。
       * 非推理模型没有 thought 标签，这个参数不会改变它们的行为。
       *
       * 预算值可由环境变量 ROROTO_LLAMA_REASONING 覆盖（想深推理时调大，0 表示关闭）。
       * 默认 512 是「够用 + 不拖慢」的折中：太大时推理模型每轮都先想几百字才动。
       */
      '--reasoning-budget',
      String(reasoningBudget()),
      /**
       * 性能参数：这几项和「回答质量」无关，全是白拿的速度。
       *
       * - `-fa on`：flash attention。prefill 快一截，KV 显存也小 —— 省下来的显存
       *   正好给更大的 batch 或更多层上卡。个别老构建不认这个值，用
       *   `ROROTO_LLAMA_NO_FA=1` 关掉（此时也不会开 KV 量化，V 量化依赖它）。
       * - `-ctk q8_0 -ctv q8_0`：KV cache 量化到 8 bit，显存约减半，质量差异在代码场景
       *   基本看不出来。16K 窗口的 7B 模型因此能多放几层上卡，或者把窗口开到 32K。
       * - `-ub 1024`：micro-batch 从默认 512 提到 1024，长 prompt 的 prefill 明显更快；
       *   多占的那点计算缓冲被上面省下的 KV 显存抵回来了。显存吃紧时用
       *   `ROROTO_LLAMA_UB=512` 退回默认。
       *
       *   这三项（以及 -ub）现在统一由 `gpuProfile()` 按显卡分档：cc≥8 全开 + ub 1024；
       *   Turing（cc<8）只保留 -ctk；Vulkan/CPU 全不加。环境变量仍可覆盖。
       */
      ...(await perfArgs(gpuIdx)),
      ...(await ubArgs(gpuIdx)),
      ...(await draftArgs(full)),
      ...cacheReuseArgs(),
      /**
       * 自己的构建 / 自己想试的参数：空格分隔，直接拼进启动命令。
       * 自动判定总有覆盖不到的情况，留个出口比让用户改代码强。
       */
      ...(process.env.ROROTO_LLAMA_EXTRA ?? '').trim().split(/\s+/).filter(Boolean),
      ...deviceArgs(device, partialOffload ? 'auto' : 'all')
    ]
    /**
     * `--fit` 默认就是 on，但显式写出来：
     * 用户的 `ROROTO_LLAMA_EXTRA` 或以后的默认值改动都可能把它关掉，
     * 而「部分卸载」完全依赖它按显存逐层分配。`--fit-target` 给系统留余量，
     * 太小会被 WDDM 的桌面占用挤掉，太大等于白少放几层 ——
     * 小卡按 15%（下限 640 MiB）：10% 的方案在 8 GB 卡上实测加载完只剩 124 MiB。
     */
    if (partialOffload) {
      args.push('--fit', 'on', '--fit-target', String(fitTargetMiB(fitInfo?.limitMiB, { totalMiB: fitInfo?.totalMiB })))
    }
    // 视觉投影器：不传这个参数，主模型就只当纯文本模型用，
    // 发过去的 image_url 会被忽略或直接报错。
    if (mmproj) args.push('--mmproj', mmproj)
    // 槽位数恒定显式传（parallel 已在上面规范化成 1 或 N），覆盖服务端默认的 4 槽。
    args.push('-np', String(parallel))
    // -kvu 只在真多槽时要：显式槽位数会让 llama.cpp 改成按槽切分上下文，
    // 每槽只剩 1/N，30K 的 agent prompt 会直接超出槽窗口；共享 KV 池下 -c 是总量。
    // 单槽没有这个问题，加了反而多一层间接。
    if (parallel >= 2) args.push('-kvu')

    /**
     * 起进程前先量一次「别人占了多少显存」。
     *
     * 就绪后再量一次，两次的差值就是这个模型真实吃掉的那部分 —— 比任何估算都准。
     * 采样要在旧实例已经停掉之后：否则量到的是新旧两份模型的叠加大头。
     */
    const baseUse = devices.length ? await sampleUsedMiB(gpuIdx).catch(() => null) : null

    const inst = launch({ key, exe, args, port, model: full, mmproj, device, ctx, parallel, partial: partialOffload })
    // 手动启动，说明「已空闲卸载」这条记录过期了
    forgetIdleUnload(key)
    await persistState()
    /**
     * 秒退检测：spawn 成功不等于模型能加载。
     *
     * 架构不认识、文件损坏、缺 cudart DLL、显存不够这四类失败都在一秒内退出，
     * 而下面会立刻返回「已启动，模型加载中」—— 要等下一次状态轮询才发现进程没了，
     * 中间那几秒用户以为它在跑。这里只等一小会儿拦秒退，正常加载（几秒到几十秒）不受影响。
     *
     * 探测路径不做：探测链本来就预期首档可能起不来，由它按失败原因降档。
     */
    if (!probeSeed) {
      const why = await quickExitReason(key, 1500)
      if (why) {
        /**
         * 同时掐掉自愈。同一个文件、同一份参数，2s/6s/18s 后重试三次的结果完全一样，
         * 只会把「一次失败」拖成「一分钟失败」，还多加载三遍模型。
         * 用户换模型或改参数后再启动时会重新开始，不受这个计数影响。
         */
        restartCounts.set(key, RESTART_DELAYS_MS.length + 1)
        return {
          ok: false,
          code: 'CRASHED',
          message: `llama-server 启动后立刻退出了：\n${why}`,
          port,
          device
        }
      }
    }
    /**
     * 这里**不能**清空重试计数。
     *
     * 「spawn 了」不等于「跑起来了」：模型文件损坏时进程一秒内就退出，
     * 上层每次请求都会再调一次 startLlama，一清空预算就变成永动机 ——
     * 崩、2s 后重来、再崩、6s、18s，无限循环，每轮还要完整加载一次模型。
     * 只有服务真的应答（下面那个 waitForServer 分支）才算成功，那时再清零。
     */

    // 立刻用文件名写入配置，让界面马上能看到这条模型（不等服务加载）
    const fallback = path.basename(full)
    const applied = await applyLlamaConfig(
      provider?.id,
      fallback,
      ctx,
      Boolean(mmproj),
      port,
      opts?.activate,
      // 探测路径下这个 ctx 只是起点，不是最终结论：等探测定档后由探测链写一次
      !probeSeed
    )

    /**
     * 需要探测时，自愈从这一刻起就要压住。
     *
     * 首档可能根本起不来（估算偏乐观），而 handleExit 看到崩溃会立刻按原参数
     * 重试 3 次 —— 那正是探测链要接管的事。等后台块再标记就已经晚了。
     */
    if (probeSeed) probingKeys.add(key)

    // 服务就绪后再用真实模型 id 校正配置；不阻塞本次返回
    void (async () => {
      /**
       * 探测路径不在外面 waitForServer：首档起不来正是探测链要处理的第一个分支。
       * 在这里等一次会让「降档重试」多花 45 秒，还会和探测链的判据重复。
       */
      if (probeSeed && fitInfo?.limitMiB) {
        await startProbeChain({
          key,
          inst,
          model: full,
          providerId: provider?.id,
          fit: fitInfo,
          seed: probeSeed,
          firstPort: port,
          firstCtx: ctx,
          firstBaseUsed: baseUse?.usedMiB ?? null
        }).catch(() => undefined)
        probingKeys.delete(key)
        return
      }

      const served = await waitForServer(port, 45000)
      if (!served?.length || instances.get(key) !== inst) return
      // 服务真的应答了：重试计数归零，下次崩溃还有 3 次自愈机会
      restartCounts.delete(key)

      /**
       * 服务端会悄悄把 `-c` 改小。
       *
       * llama.cpp 发现请求的窗口超过模型训练窗口时，会直接 cap 回原生值
       * （日志：`the slot context (65536) exceeds the training context (32768) - capping`）。
       * 这时实例里记的还是「请求值」，界面就一直显示 64K，用户以为窗口有 64K，
       * 直到长对话突然报超窗 —— 所以以 /props 回的真值为准，并留一句解释。
       */
      const props = await probeServerProps(port).catch(() => null)
      if (props?.nCtx && props.nCtx < ctx * 0.9) {
        inst.ctx = props.nCtx
        tuneNotes.set(
          key,
          `窗口被服务端从 ${Math.round(ctx / 1024)}K 裁到 ${Math.round(props.nCtx / 1024)}K：模型训练窗口只有这么多`
        )
        void persistState()
      }

      const picked = pickServedModel(served, full)
      if (picked && picked !== fallback)
        await applyLlamaConfig(provider?.id, picked, undefined, undefined, port, opts?.activate)

      await tuneAfterReady({
        key,
        inst,
        model: full,
        ctx,
        providerId: provider?.id,
        fit: fitInfo,
        baseUsedMiB: baseUse?.usedMiB ?? null,
        fingerprint,
        opts
      })
    })()

    // 视觉模型没配上投影器时说清原因和补救办法。以前这里静默留空，
    // 用户只看到「已启动」，直到发图片没反应才发现看不了图。
    const mmNote = await visionNote()
    // 实际在哪跑写清楚：没绑卡时是 auto，用 list-devices 的第一块报出来，别再含糊
    const devNote = device ? `，显卡 ${device}` : devices[0] ? `，显卡 ${devices[0]}（自动）` : ''
    const multi = instances.size > 1 ? `\n当前共 ${instances.size} 个本地实例在跑：${[...instances.values()].map((i) => `${path.basename(i.model)}@${i.port}`).join('、')}` : ''
    return {
      ok: true,
      message: `${applied.message}\n已启动 llama-server（端口 ${port}${devNote}，上下文 ${ctx} tokens），模型加载中，就绪后自动校正…${autoPortNote}${ctxNote}${mmNote}${multi}${gpuNote}`,
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
 * 最近一次实测调档的结论，给状态查询拼进提示。
 * 放在内存里就够了：它描述的是「这一次启动发生了什么」，重启程序就该重新量。
 */
const tuneNotes = new Map<string, string>()

/** 状态查询用：这次启动的实测结论（没量过就是空串） */
export function tuneNoteOf(providerId?: string): string {
  if (providerId) return tuneNotes.get(providerId) ?? ''
  return [...tuneNotes.values()][0] ?? ''
}

/** 把实测占用写回配置，下次启动直接按它定档，不必再试错重启 */
async function saveCtxProbe(
  providerId: string | undefined,
  file: string,
  ctx: number,
  footMiB: number,
  ceiling?: number,
  fingerprint?: string,
  tokPerSec?: number
): Promise<void> {
  try {
    const cfg = await loadConfig()
    const p = providerId
      ? cfg.providers.find((x) => x.id === providerId)
      : cfg.providers.find((x) => x.id === 'llamacpp') || cfg.providers.find((x) => isLlamaProvider(x))
    if (!p) return
    const prev = p.ctxProbe
    p.ctxProbe = {
      model: path.basename(file),
      ctx,
      footMiB: Math.round(footMiB),
      at: Date.now(),
      // 只有探测链能测出速度；调档那条路径测不到，就沿用上一次的值，别把它冲掉
      ...(typeof tokPerSec === 'number' && tokPerSec > 0
        ? { tokPerSec: Math.round(tokPerSec * 10) / 10 }
        : prev?.tokPerSec
          ? { tokPerSec: prev.tokPerSec }
          : {})
    }
    if (typeof ceiling === 'number' && ceiling >= 2048) p.ctxCeiling = Math.round(ceiling)
    // 指纹必须跟着结论一起存：没有它，下次启动无法判断这份实测数据还算不算数
    if (fingerprint) p.ctxFingerprint = fingerprint
    await saveConfig(cfg)
  } catch {
    // 存不下不影响这次运行，下次再量一遍就是
  }
}

/**
 * 就绪后实测显存，并按结果决定「升一档 / 降一档 / 保持」。
 *
 * 为什么必须实测：体检是「权重 + KV + 缓冲」三段估算，每段都有假设
 * （hybrid 架构还有一块与上下文无关的 recurrent state、部分层可能落在 CPU），
 * 实测值能把三段误差一次性消掉。实测之后「再开一档要多少显存」只需加上
 * KV 的线性增量，不用真去试错。
 *
 * 只动一档、只动一次：升档的代价是一次 10 秒的模型重载，跨档跳或反复试探都不划算。
 * 结论写进 provider.ctxProbe，下次启动直接命中，不再重启。
 */
async function tuneAfterReady(a: {
  key: string
  inst: LlamaInstance
  model: string
  ctx: number
  providerId?: string
  fit: Awaited<ReturnType<typeof fitForLaunch>> | null
  baseUsedMiB: number | null
  /** 本次启动的环境指纹：和实测结论一起落盘，否则下次无法判断这份数据还算不算数 */
  fingerprint?: string
  opts?: LlamaStartOptions
}): Promise<void> {
  if (process.env.ROROTO_LLAMA_AUTOTUNE === '0') return
  if (!a.providerId || a.opts?.tuned) return
  if (a.baseUsedMiB === null || !a.fit?.limitMiB || !a.fit.kvMiBPerKToken) return
  /** 留一点余量给桌面合成器：WDDM 下显存被榨到极限不会崩，而是悄悄换页，速度断崖式下跌 */
  const RESERVE_MIB = 320
  try {
    // 分配有先后：权重、KV、计算缓冲不是同一刻申请的，等服务应答后稍等一下再量才准
    await new Promise((r) => setTimeout(r, 1500))
    const after = await sampleUsedMiB(deviceIndex(a.inst.device)).catch(() => null)
    if (!after || instances.get(a.key) !== a.inst) return
    const footMiB = after.usedMiB - a.baseUsedMiB
    // 差值必须显著大于噪声：别的进程刚好退出会让差值变小甚至为负
    if (!Number.isFinite(footMiB) || footMiB < 256) return

    await saveCtxProbe(a.providerId, a.model, a.ctx, footMiB, undefined, a.fingerprint)

    /**
     * 用户手选的档位就按这一档跑完，不替他「优化」。
     * 实测占用照样记下来：下次点「自动」时这份数据仍能让定档更准。
     */
    if (a.opts?.ctxExplicit) {
      tuneNotes.set(
        a.providerId,
        `按选择的 ${Math.round(a.ctx / 1024)}K 启动（实测占用 ${footMiB} MiB，不自动调档）`
      )
      return
    }

    const pick = bestTier({
      probe: { ctx: a.ctx, footMiB },
      kvMiBPerK: a.fit.kvMiBPerKToken,
      limitMiB: a.fit.limitMiB,
      reserveMiB: RESERVE_MIB,
      nativeCtx: a.fit.nativeCtx
    })
    if (pick.ctx === a.ctx) {
      const room = a.fit.limitMiB - footMiB - RESERVE_MIB
      /**
       * 体检的「预算」和真实剩余显存要分开看。
       *
       * `limitMiB` 是启动前的 free×0.92；模型跑起来之后桌面合成器还会继续涨，
       * 实测 8 GB 卡分层加载后只剩 124 MiB —— 这时 WDDM 不会崩，而是悄悄换页，
       * 表现为速度从 5 tok/s 掉到 1.x。所以这里量一次真实空闲，低于 384 MiB 就明说。
       */
      const freeMiB = Math.max(0, (after.totalMiB || 0) - after.usedMiB)
      const tightNote =
        after.totalMiB > 0 && freeMiB < 384
          ? `\n⚠ 显存只剩 ${Math.round(freeMiB)} MiB（${Math.round((freeMiB / after.totalMiB) * 100)}%）：` +
            '桌面程序一多就会被系统驱逐，速度会突然掉下来。可以调小一档上下文，或关掉占显存的程序后重启模型。'
          : ''
      tuneNotes.set(
        a.providerId,
        `实测：${Math.round(a.ctx / 1024)}K 占用 ${footMiB} MiB，显存余量 ${Math.max(0, Math.round(room))} MiB，已是最合适的档位` +
          tightNote
      )
      return
    }

    const up = pick.ctx > a.ctx
    tuneNotes.set(
      a.providerId,
      `${up ? '升档' : '降档'}：实测 ${Math.round(a.ctx / 1024)}K 占用 ${footMiB} MiB，` +
        `按每 1K tokens ${a.fit.kvMiBPerKToken.toFixed(0)} MiB 算，` +
        `${Math.round(pick.ctx / 1024)}K 预计 ${Math.round(pick.footMiB)} MiB / 上限 ${a.fit.limitMiB} MiB，正在重启…`
    )
    // 重启这条路必须自己先停：同一个端口上不能有两个 server
    await stopLlama(a.providerId)
    const r = await startLlama(a.model, pick.ctx, { ...a.opts, providerId: a.providerId, tuned: true })
    /**
     * startLlama 只保证「进程拉起来了」，加载失败（显存不够时 llama.cpp 会直接退出）
     * 要到就绪探测才能看出来。所以这里必须等到应答，没应答就退回原档 ——
     * 否则用户会遇到「升档后模型一直加载不出来」，而日志里只有一次退出码。
     */
    const ready = r.ok && r.port ? await waitForServer(r.port, 45000) : null
    if (!ready?.length) {
      tuneNotes.set(
        a.providerId,
        `${up ? '升到' : '降到'} ${Math.round(pick.ctx / 1024)}K 没起来（显存不够或加载失败），已退回 ${Math.round(a.ctx / 1024)}K`
      )
      // 记下「这一档装不下」：下次启动不再拿一次重载去撞同一堵墙
      await saveCtxProbe(a.providerId, a.model, a.ctx, footMiB, a.ctx, a.fingerprint)
      if (r.ok) await stopLlama(a.providerId)
      await startLlama(a.model, a.ctx, { ...a.opts, providerId: a.providerId, tuned: true })
      return
    }
    await saveCtxProbe(a.providerId, a.model, a.ctx, footMiB, pick.ctx, a.fingerprint)
    tuneNotes.set(
      a.providerId,
      `实测：${Math.round(a.ctx / 1024)}K 占用 ${footMiB} MiB → 已${up ? '升' : '降'}到 ${Math.round(pick.ctx / 1024)}K` +
        `（预计 ${Math.round(pick.footMiB)} MiB / 上限 ${a.fit.limitMiB} MiB）`
    )
  } catch {
    // 调档是锦上添花：任何一步失败都不能影响已经跑起来的服务
  }
}

/**
 * 读 `/props`：服务端真实的窗口与槽位数。
 *
 * 为什么不信自己的参数：llama.cpp 在「显存不够」时会把请求的 `-c` 悄悄降下来
 * （或者按槽切分），启动命令里写的 65536 不代表真的开了 65536。这里拿到实际值，
 * 才谈得上「判据」。
 */
async function probeServerProps(port: number): Promise<{ nCtx: number | null; slots: number }> {
  try {
    const root = baseUrlOf(port).replace(/\/v1\/?$/, '')
    const res = await fetchWithTimeout(`${root}/props`, 4000)
    if (!res.ok) return { nCtx: null, slots: 0 }
    const json = (await res.json()) as {
      default_generation_settings?: { n_ctx?: number }
      n_ctx?: number
      total_slots?: number
    }
    const n = Number(json.default_generation_settings?.n_ctx ?? json.n_ctx ?? 0)
    const s = Number(json.total_slots ?? 0)
    return {
      nCtx: Number.isFinite(n) && n > 0 ? Math.round(n) : null,
      slots: Number.isFinite(s) && s > 0 ? Math.round(s) : 0
    }
  } catch {
    return { nCtx: null, slots: 0 }
  }
}

/**
 * 一次最小推理请求。
 *
 * 「服务应答」只证明 HTTP 活着；KV 量化不被支持、CUDA kernel 不匹配这类问题
 * 要到第一次 decode 才会炸。所以判据必须真的让它吐几个 token。
 */
async function probeInfer(port: number): Promise<{ ok: boolean; tokPerSec: number | null }> {
  try {
    const res = await fetchWithTimeout(`${baseUrlOf(port)}/chat/completions`, 30_000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer no-key' },
      body: JSON.stringify({
        model: 'local',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 8,
        temperature: 0,
        stream: false
      })
    })
    if (!res.ok) return { ok: false, tokPerSec: null }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      timings?: { predicted_n?: number; predicted_ms?: number }
    }
    const choices = json.choices ?? []
    if (!choices.length) return { ok: false, tokPerSec: null }
    const t = json.timings
    const speed = t?.predicted_n && t?.predicted_ms ? t.predicted_n / (t.predicted_ms / 1000) : null
    return { ok: true, tokPerSec: speed }
  } catch {
    return { ok: false, tokPerSec: null }
  }
}

/**
 * 等显存回落到安静状态。
 *
 * OOM 退出后显存不会立刻回收。紧接着量基线，会量到上一轮的残留，
 * 于是 `footMiB` 偏小 → 误判「还能再高一档」→ 再崩一次。连续两次采样
 * 变化小于 200 MiB 才认为稳定。
 */
async function waitGpuQuiet(gpuIdx: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let prev: number | null = null
  let stable = 0
  while (Date.now() < deadline) {
    const s = await sampleUsedMiB(gpuIdx).catch(() => null)
    if (s) {
      if (prev !== null && Math.abs(s.usedMiB - prev) < 200) stable++
      else stable = 0
      prev = s.usedMiB
      if (stable >= 2) return
    }
    await new Promise((r) => setTimeout(r, 350))
  }
}

/**
 * 三重判据：服务应答 + 窗口真的生效 + 单槽够 agent 用 + 能出 token。
 *
 * 顺序有讲究：先等就绪（最慢），再读 /props（便宜），最后跑一次最小推理（略贵）。
 * 任何一步失败都带上归因，交给探测链决定「降档」还是「直接报错」。
 *
 * `alive` 用来「快速失败」：进程已经因为 OOM 退出了，就没必要把 60 秒等满 ——
 * 那会让「降一档」看起来像卡死。每秒查一次，进程没了立刻读日志归因。
 */
async function verifyLlamaReady(
  port: number,
  wantCtx: number,
  alive?: () => boolean,
  cancel?: () => boolean
): Promise<ProbeVerify> {
  const deadline = Date.now() + PROBE_READY_MS
  let served: string[] | null = null
  while (Date.now() < deadline) {
    if (alive && !alive()) break
    // 用户中途点了别的档位：别再占着等待时间，交给探测链统一收尾
    if (cancel?.()) break
    const st = await statusByPort(port).catch(() => null)
    if (st?.running && st.models?.length) {
      served = st.models
      break
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (!served?.length) {
    const tail = readLogTail(logFileOf(port))
    const kind = classifyLoadFailure(tail)
    const brief = tail.split(/\r?\n/).filter(Boolean).slice(-3).join(' / ').slice(0, 300)
    const gone = !alive || !alive()
    return {
      ok: false,
      nCtx: null,
      slots: 0,
      tokPerSec: null,
      // 日志里明确是显存/窗口问题才允许降档；其余按超时处理，不当成「装不下」
      failure: kind === 'vram' || kind === 'native' ? kind : 'timeout',
      message: gone ? `进程已退出：${brief || '没有日志'}` : brief || `${Math.round(PROBE_READY_MS / 1000)} 秒内没有应答`
    }
  }

  const props = await probeServerProps(port)
  // 服务端可能把 -c 悄悄改小（显存不够时常见）。差 10% 以上就认为没按请求开
  if (props.nCtx && props.nCtx < wantCtx * 0.9) {
    return {
      ok: false,
      nCtx: props.nCtx,
      slots: props.slots,
      tokPerSec: null,
      failure: 'native',
      message: `请求 ${Math.round(wantCtx / 1024)}K，服务端只开了 ${Math.round(props.nCtx / 1024)}K`
    }
  }
  if (!slotWindowOk(wantCtx, props.slots)) {
    return {
      ok: false,
      nCtx: props.nCtx,
      slots: props.slots,
      tokPerSec: null,
      failure: 'slot',
      message: `${Math.round(wantCtx / 1024)}K 分到 ${props.slots} 个槽后，每槽不足 ${Math.round(MIN_AGENT_SLOT_TOKENS / 1024)}K，agent 跑不动`
    }
  }

  const inf = await probeInfer(port)
  if (!inf.ok) {
    return {
      ok: false,
      nCtx: props.nCtx,
      slots: props.slots,
      tokPerSec: null,
      failure: 'other',
      message: '服务能应答，但一次最小推理没有返回内容（KV 精度或 kernel 可能不兼容）'
    }
  }
  if (inf.tokPerSec !== null && inf.tokPerSec < MIN_PROBE_TOK_PER_SEC) {
    return {
      ok: false,
      nCtx: props.nCtx,
      slots: props.slots,
      tokPerSec: inf.tokPerSec,
      failure: 'speed',
      message: `推理只有 ${inf.tokPerSec.toFixed(1)} tok/s，疑似显存被换页`
    }
  }
  return {
    ok: true,
    nCtx: props.nCtx,
    slots: props.slots,
    tokPerSec: inf.tokPerSec,
    failure: null,
    message: inf.tokPerSec ? `就绪，${inf.tokPerSec.toFixed(1)} tok/s` : '就绪'
  }
}

/** 只写 ceiling，不动已有的 ctxProbe（探测全失败时用） */
async function saveCtxCeiling(providerId: string | undefined, ceiling: number, fingerprint?: string): Promise<void> {
  try {
    const cfg = await loadConfig()
    const p = providerId
      ? cfg.providers.find((x) => x.id === providerId)
      : cfg.providers.find((x) => x.id === 'llamacpp') || cfg.providers.find((x) => isLlamaProvider(x))
    if (!p) return
    p.ctxCeiling = Math.max(2048, Math.round(ceiling))
    if (fingerprint) p.ctxFingerprint = fingerprint
    await saveConfig(cfg)
  } catch {
    // 存不下不影响本次运行
  }
}

/**
 * 启动探测链。
 *
 * 与 tuneAfterReady 的分工：
 * - 指纹命中（同一台机器、同一个模型、同一套参数）→ 走 tuneAfterReady，快路径；
 * - 指纹不命中（首次 / 换模型 / 环境变了）→ 走这里，真的起停几次来确认。
 *
 * 同一 provider 上串行执行，且探测期间压住自愈重启（probingKeys）。
 */
async function startProbeChain(a: {
  key: string
  inst: LlamaInstance
  model: string
  providerId?: string
  fit: NonNullable<Awaited<ReturnType<typeof fitForLaunch>>>
  seed: { fp: string; maxCtx: number; minCtx: number }
  firstPort: number | null
  firstCtx: number
  firstBaseUsed: number | null
}): Promise<void> {
  if (probeRunning.has(a.key)) {
    probingKeys.delete(a.key)
    return
  }
  probeRunning.add(a.key)
  probingKeys.add(a.key)
  const gen = ++probeGen
  const gpuIdx = deviceIndex(a.inst.device)
  const noteKey = a.providerId ?? a.key
  /** 探测链当前请求的档位：verify 要用它和 /props 的真实值比对 */
  let wantCtx = a.firstCtx
  /** 每次重启前重新采的基线：OOM 残留会让 footMiB 偏小 */
  let baseUsed = a.firstBaseUsed
  const nativeNum = Number(a.fit.nativeCtx ?? 0)

  const plan = {
    providerId: a.providerId,
    nativeCtx: nativeNum >= 2048 ? nativeNum : null,
    maxCtx: a.seed.maxCtx,
    minCtx: a.seed.minCtx,
    kvMiBPerK: a.fit.kvMiBPerKToken,
    limitMiB: a.fit.limitMiB ?? 0,
    reserveMiB: PROBE_RESERVE_MIB,
    // 降两档（估算偏乐观的常见幅度）、升一档（外推已经能算准，不必逐档试）
    downBudget: 2,
    // 起点是「贴边降一档」得来的就不再升：升回去窗口翻倍但速度砍半
    upBudget: a.fit.tightAtStart ? 0 : 1,
    noUpgrade: a.fit.tightAtStart === true
  }

  const deps = {
    firstPort: a.firstPort,
    firstCtx: a.firstCtx,
    restart: async (nextCtx: number) => {
      wantCtx = nextCtx
      // 自己先停：restart 可能在 ctx 相同（回滚）时被 startLlama 当成「复用」，
      // 那样等于没重启，判据还会对着旧进程算
      await stopLlama(a.key)
      await waitGpuQuiet(gpuIdx)
      const sample = await sampleUsedMiB(gpuIdx).catch(() => null)
      baseUsed = sample?.usedMiB ?? null
      const r = await startLlama(a.model, nextCtx, {
        providerId: a.providerId,
        internal: true,
        tuned: true,
        parallel: 0
      })
      if (!r.ok || !r.port) return { ok: false, port: null, message: r.message }
      return { ok: true, port: r.port, message: r.message }
    },
    verify: (port: number) =>
      verifyLlamaReady(port, wantCtx, () => instances.has(a.key), () => gen !== probeGen),
    measure: async () => {
      const sample = await sampleUsedMiB(gpuIdx).catch(() => null)
      if (!sample || baseUsed === null) return null
      const foot = sample.usedMiB - baseUsed
      // 差值太小说明量到的是噪声（别的进程刚好退出），这份数据不能用来外推
      return foot > 256 ? foot : null
    },
    quiet: () => waitGpuQuiet(gpuIdx),
    stop: async () => {
      await stopLlama(a.key)
    },
    note: (msg: string, p: ProbeProgress) => {
      tuneNotes.set(noteKey, msg)
      emitProbe(p)
    },
    cancelled: () => gen !== probeGen,
    save: async (probe: { ctx: number; footMiB: number; tokPerSec?: number } | null, ceiling?: number) => {
      const port = instances.get(a.key)?.port
      if (probe) {
        await saveCtxProbe(
          a.providerId,
          a.model,
          probe.ctx,
          probe.footMiB,
          ceiling,
          a.seed.fp,
          probe.tokPerSec
        )
        // 最终档位只写一次，探测期间的中间档位一律不写配置
        await applyLlamaConfig(a.providerId, path.basename(a.model), probe.ctx, undefined, port, undefined, true)
      } else if (ceiling) {
        await saveCtxCeiling(a.providerId, ceiling, a.seed.fp)
      }
    }
  }

  try {
    const chained = probeSerial.then(
      () => runProbeChain(plan, deps),
      () => runProbeChain(plan, deps)
    )
    probeSerial = chained.catch(() => undefined)
    const out = await chained

    if (out.cancelled) {
      tuneNotes.set(noteKey, '自动校准已取消（你手动选了档位）')
      return
    }
    tuneNotes.set(noteKey, out.message)
    emitProbe({
      providerId: a.providerId,
      phase: out.ok ? 'done' : 'fail',
      ctx: out.ctx,
      attempt: out.attempts,
      budget: probeBudget(plan),
      message: out.message
    })
    if (out.ok) {
      // 探测成功：重启计数归零，最终实例仍然享有完整自愈预算
      restartCounts.delete(a.key)

      /**
       * 探测全程按单槽跑（多槽会把 KV 池切分，判据会失真）。
       * 但用户本来就配了多槽时必须还回去 —— 静默把并发改掉同样是个 bug。
       * 只有「切分后每槽还够 agent 用」才恢复；不够就保持单槽并说明原因。
       */
      const cfg = await loadConfig().catch(() => null)
      const wantP = Math.round(Number(cfg?.llamaParallel ?? 0) || 0)
      if (wantP >= 2 && wantP <= 8 && !deps.cancelled()) {
        const perSlot = Math.round(out.ctx / wantP)
        if (a.fit.limitMiB && a.fit.limitMiB < MULTI_SLOT_MIN_MIB) {
          // 显存不够时「还回去」等于把刚校准好的单槽又换回会互相拖慢的多槽
          tuneNotes.set(
            noteKey,
            `${out.message}；可用显存只有 ${(a.fit.limitMiB / 1024).toFixed(1)} GB，多槽并发会让每个请求都变慢，按单槽运行`
          )
        } else if (!slotWindowOk(out.ctx, wantP)) {
          tuneNotes.set(
            noteKey,
            `${out.message}；${Math.round(out.ctx / 1024)}K 开 ${wantP} 槽后每槽只有 ${Math.round(perSlot / 1024)}K（低于 agent 需要的 ${Math.round(MIN_AGENT_SLOT_TOKENS / 1024)}K），已按单槽运行`
          )
        } else {
          await stopLlama(a.key)
          await waitGpuQuiet(gpuIdx)
          const r = await startLlama(a.model, out.ctx, {
            providerId: a.providerId,
            internal: true,
            tuned: true
          })
          const v =
            r.ok && r.port
              ? await verifyLlamaReady(r.port, out.ctx, () => instances.has(a.key), () => gen !== probeGen)
              : null
          if (!v?.ok) {
            // 多槽起不来就退回单槽：宁可少并发，也不能让用户没有服务
            await stopLlama(a.key)
            await waitGpuQuiet(gpuIdx)
            await startLlama(a.model, out.ctx, {
              providerId: a.providerId,
              internal: true,
              tuned: true,
              parallel: 0
            }).catch(() => undefined)
            tuneNotes.set(noteKey, `${out.message}；恢复 ${wantP} 槽失败，已退回单槽运行`)
          }
        }
      }
    }
  } finally {
    probeRunning.delete(a.key)
    probingKeys.delete(a.key)
  }
}

/**
 * 视觉开关的串行锁。
 *
 * 两个会话同时发图片时，各自都会算出「现在没挂投影器」然后动手重启，
 * 第二个就会把第一个刚起来的实例再杀一次 —— 结果是两个都失败。
 * 用一条 promise 链把切换串起来，后到的那个进去时会看到「已经挂上了」直接返回。
 */
let visionSwitchQueue: Promise<unknown> = Promise.resolve()
function serializeVisionSwitch<T>(fn: () => Promise<T>): Promise<T> {
  const run = visionSwitchQueue.then(fn, fn)
  visionSwitchQueue = run.catch(() => undefined)
  return run
}

/** 这个实例现在是不是挂上了视觉投影器（没在跑就是 false） */
export function llamaVisionLoaded(providerId?: string): boolean {
  const inst = providerId ? instances.get(providerId) : [...instances.values()][0]
  return Boolean(inst?.mmproj)
}

/**
 * 按需切换视觉投影器。
 *
 * `--mmproj` 只能作为启动参数传，运行时没法热挂 / 热卸，所以「发图才加载」的
 * 本质就是按需重启。这里把重启、等就绪、串行化收在一处，
 * 上层（agent）只要在检测到图片时调一次 on=true 就行。
 *
 * changed 表示真的重启过；调用方据此决定要不要重新读配置里的 llamaVision。
 */
export async function setLlamaVision(
  providerId: string | undefined,
  on: boolean,
  modelOverride?: string
): Promise<{ ok: boolean; changed: boolean; message: string }> {
  return serializeVisionSwitch(async () => {
    const cfg = await loadConfig()
    const provider = providerId
      ? cfg.providers.find((p) => p.id === providerId) ?? null
      : cfg.providers.find((p) => p.id === 'llamacpp') || cfg.providers.find((p) => isLlamaProvider(p)) || null
    if (!provider) return { ok: false, changed: false, message: '配置里找不到本地模型，无法切换看图能力' }

    const inst = instances.get(provider.id)

    if (on) {
      // 已经在视觉模式：什么都不用做（并发的第二个请求会走到这里）
      if (inst?.mmproj) return { ok: true, changed: false, message: '视觉投影器已经在加载' }
      const full = inst?.model ?? (await resolveModelPath((modelOverride || provider.model || '').trim()))
      if (!full) return { ok: false, changed: false, message: '找不到这个模型的 .gguf 文件，没法加载视觉投影器' }
      const projector = await findMmprojFor(full, provider.id)
      if (!projector) {
        return {
          ok: false,
          changed: false,
          message: '这个模型没有配套的视觉投影器（mmproj），看不了图。要看得换一个带投影器的视觉模型。'
        }
      }
      const r = await startLlama(full, inst?.ctx, {
        providerId: provider.id,
        vision: true,
        keepSiblings: true
      })
      if (!r.ok) {
        /**
         * 切视觉失败不能把用户留在「服务没了」的状态：旧实例已经被停掉，
         * 赶紧按纯文本重新拉起来，至少还能继续用文字干活。
         */
        await startLlama(full, inst?.ctx, {
          providerId: provider.id,
          vision: false,
          keepSiblings: true
        }).catch(() => undefined)
        return { ok: false, changed: false, message: `加载视觉投影器失败：${r.message}` }
      }
      // 等它真能接请求再返回：否则这一轮发图会先撞上 503
      const served = r.port ? await waitForServer(r.port, 180000) : null
      if (!served) {
        // 同上：加载不出来就退回纯文本，别让本地模型彻底不可用
        await startLlama(full, inst?.ctx, {
          providerId: provider.id,
          vision: false,
          keepSiblings: true
        }).catch(() => undefined)
        return {
          ok: false,
          changed: true,
          message:
            '视觉模型起来了，但 3 分钟内一直没就绪（多半是显存不够，或投影器和主模型不配套）。已退回纯文本模式，这一轮先按文字处理。'
        }
      }
      return { ok: true, changed: true, message: '已切换到视觉模型，现在可以看图' }
    }

    // 切回纯文本：本来就没挂投影器就不用动
    if (!inst?.mmproj) return { ok: true, changed: false, message: '当前已经是纯文本模式' }
    const r = await startLlama(inst.model, inst.ctx, {
      providerId: provider.id,
      vision: false,
      keepSiblings: true
    })
    if (!r.ok) return { ok: false, changed: false, message: `切回纯文本失败：${r.message}` }
    const served = r.port ? await waitForServer(r.port, 120000) : null
    if (!served) return { ok: false, changed: true, message: '已按纯文本重启，但服务还没就绪' }
    return { ok: true, changed: true, message: '已切回纯文本模式，解码速度恢复' }
  })
}

/**
 * 把崩溃日志尾巴翻译成「下一步该干什么」。
 *
 * 认不出来就返回 null —— 宁可让用户看原文，也不要编一个听起来像真的的原因。
 */
function explainCrashTail(tail: string): string | null {
  if (!tail) return null
  const arch = tail.match(/unknown model architecture:\s*'([^']+)'/i)
  if (arch) {
    return (
      `这个模型文件的架构（${arch[1]}）当前 llama.cpp 版本不认，所以一开始加载就退出了。\n` +
      '换一个模型，或先更新 llama.cpp 再试（架构支持是跟着 llama.cpp 版本走的）。'
    )
  }
  if (/out of memory|failed to allocate|ggml_backend_alloc|cuda error: out of memory/i.test(tail)) {
    return (
      '显存或内存不够，模型没装下。\n' +
      '可调小「上下文窗口」一档、关掉别的占显存的程序，或换更小的量化（Q4_K_M → Q3_K_M）。'
    )
  }
  const dll = tail.match(/\b(cublasLt64_\d+|cublas64_\d+|cudart64_\d+)\.dll/i)
  if (dll) {
    return (
      `缺 CUDA 运行库 ${dll[1]}.dll：只有 ggml-cuda.dll 是不够的。\n` +
      '点「一键安装」会单独下载 cudart 包补齐；也可以手动解压到 llama.cpp/ 目录。'
    )
  }
  if (/error loading model|failed to load model/i.test(tail)) {
    return '模型文件读不出来：多半是下载不完整或文件损坏，重新下载这个模型。'
  }
  if (/address already in use|port .*in use/i.test(tail)) {
    return '实例端口被别的程序占用了：到设置里换个端口，或把「实例端口」留空让程序自动选。'
  }
  return null
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
   * 用户手动停掉之后，「已空闲卸载」这条说明就不该再挂着。
   *
   * 它本来是用来说明「不是我崩了，是我主动放掉的」，前提是用户没插手。
   * 用户点了停止，界面必须回到干净的「未运行」；否则下次刷新还会显示
   * 「下次发消息自动加载」，而他刚刚明确表达了相反的意思。
   */
  if (providerId) forgetIdleUnload(providerId)
  else idleWatcher.forget()
  /**
   * 杀一个实例。pid 已知就直接杀；
   * 外部认领进来的实例没有 pid，只能按进程名清 —— 但必须跳过其它实例的 pid，
   * 否则「停这一个」会顺手把另一张卡上的模型一起干掉。
   */
  const kill = (inst: LlamaInstance): boolean => {
    // 待执行的自愈重启先取消：否则点了停止，2~18 秒后它自己又起来了
    const pending = restartTimers.get(inst.key)
    if (pending) {
      clearTimeout(pending)
      restartTimers.delete(inst.key)
    }
    if (inst.pid) {
      stoppingPids.add(inst.pid)
      // 进程可能早就不在了，exit 不会再来 —— 到点自动消掉标记，别把以后的崩溃也吞掉
      setTimeout(() => stoppingPids.delete(inst.pid as number), 15000).unref?.()
      return killPidSync(inst.pid)
    }
    stopping.add(inst.key)
    setTimeout(() => stopping.delete(inst.key), 15000).unref?.()
    const others = new Set(
      [...instances.values()].filter((i) => i !== inst && i.pid).map((i) => i.pid as number)
    )
    for (const pid of listLlamaPids()) if (!others.has(pid)) killPidSync(pid)
    return true
  }

  if (providerId) {
    const inst = instances.get(providerId)
    if (!inst) return { ok: true, message: '这个本地模型没有在运行', stopped: [] }
    if (!kill(inst)) {
      /**
       * 没杀掉就别把它从表里删掉：删了之后 stopLlama 的兜底分支也不会再管它，
       * 那个进程就成了谁都认不出的孤儿，一直占着显存。
       */
      return {
        ok: false,
        message: `停止失败：llama-server（pid ${inst.pid ?? '未知'}）仍在运行，可能是权限不足或被安全软件拦下。请在任务管理器里结束它。`,
        stopped: []
      }
    }
    instances.delete(providerId)
    vramGate.delete(providerId)
    await persistState()
    return {
      ok: true,
      message: `已停止 ${path.basename(inst.model)}（端口 ${inst.port}），显存已释放`,
      stopped: [`${path.basename(inst.model)}@${inst.port}`]
    }
  }

  const list = [...instances.values()]
  if (list.length) {
    const failed: string[] = []
    for (const inst of list) {
      if (kill(inst)) {
        instances.delete(inst.key)
        vramGate.delete(inst.key)
      } else failed.push(`${path.basename(inst.model)}@${inst.port}`)
    }
    await persistState()
    if (failed.length) {
      return {
        ok: false,
        message: `有 ${failed.length} 个实例没能停掉（权限不足或被安全软件拦下）：${failed.join('、')}。请在任务管理器里结束 llama-server.exe。`,
        stopped: list.filter((i) => !failed.includes(`${path.basename(i.model)}@${i.port}`)).map((i) => `${path.basename(i.model)}@${i.port}`)
      }
    }
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
    // 同 stopLlama：先撤掉待执行的自愈重启，再杀进程
    const pending = restartTimers.get(inst.key)
    if (pending) {
      clearTimeout(pending)
      restartTimers.delete(inst.key)
    }
    let ok = true
    if (inst.pid) {
      stoppingPids.add(inst.pid)
      setTimeout(() => stoppingPids.delete(inst.pid as number), 15000).unref?.()
      ok = killPidSync(inst.pid)
    } else {
      stopping.add(inst.key)
      setTimeout(() => stopping.delete(inst.key), 15000).unref?.()
      const others = new Set(
        [...instances.values()].filter((i) => i !== inst && i.pid).map((i) => i.pid as number)
      )
      for (const pid of listLlamaPids()) if (!others.has(pid)) killPidSync(pid)
    }
    // 没杀掉就留在表里：删了之后没人再认领这个进程
    if (!ok) continue
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

/* ============================ 空闲卸载与按需唤醒 ============================ */

/**
 * 问服务端「现在有没有在算」。
 *
 * `/slots` 比 `/props` 多一个 `is_processing`，是唯一能直接看出「空闲还是在生成」
 * 的端点。探不到（对外服务、老版本、端口没人听）就返回 null —— 调用方会把它
 * 当成「不确定」而不卸载，宁可多占显存，也不要在生成途中把服务杀掉。
 */
async function slotsBusy(port: number): Promise<boolean | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 1500)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/slots`, { signal: ctl.signal })
    if (!res.ok) return null
    const json = (await res.json()) as Array<{ is_processing?: boolean }> | null
    if (!Array.isArray(json)) return null
    return json.some((s) => s?.is_processing === true)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const idleWatcher = createIdleWatcher({
  list: () =>
    [...instances.values()]
      /**
       * 探测中的实例不参与空闲卸载。
       *
       * 探测链会在几秒内反复起停，实例的 startedAt 一直在变；保护期虽然能挡住
       * 大部分情况，但赶上「某一档加载特别慢」时仍可能被当成闲置停掉，
       * 于是探测失败、定档结论错。这一条比调大保护期更准。
       */
      .filter((i) => !probingKeys.has(i.key))
      .map((i) => ({
        key: i.key,
        port: i.port,
        model: path.basename(i.model),
        startedAt: i.startedAt,
        partial: i.partial
      })),
  busy: slotsBusy,
  // 闸门里的活跃 / 排队请求比 /slots 更早：请求刚进来还没到服务端时就已经算上了
  pending: (port) => {
    const q = queueInfoOf(`http://127.0.0.1:${port}`)
    return q ? q.active + q.queued : 0
  },
  stop: async (key) => {
    const r = await stopLlama(key)
    return r.ok
  },
  ttlMs: async () => {
    const cfg = await loadConfig().catch(() => null)
    // 0 = 关闭；其它值按分钟换算。读到配置失败时按「不卸载」处理，避免误杀
    const min = cfg ? Number(cfg.llamaIdleMin ?? 10) : 0
    return Number.isFinite(min) && min > 0 ? min * 60_000 : 0
  }
})

/** 应用启动时调用一次。幂等。 */
export function startIdleUnload(): void {
  idleWatcher.start()
}

export function stopIdleUnload(): void {
  idleWatcher.stop()
}

/** 被空闲回收的实例（界面显示「已卸载，下次发消息自动加载」用） */
export function idleUnloadedList(): Array<{ key: string; model: string; at: number; idleMin: number }> {
  return idleWatcher.unloaded()
}

/** 手动启动成功后清掉「已卸载」记录 */
function forgetIdleUnload(key: string): void {
  idleWatcher.forget(key)
}

/**
 * 空闲卸载后的「叫醒」。
 *
 * 由 providers 层在发请求前调用：实例不在就按上次的参数重新拉起，
 * 拉起来之后请求照常发（服务加载模型期间会先拒绝连接，所以这里要等就绪）。
 *
 * 三个约束：
 * - 只对 llama.cpp 供应商生效。Ollama / LM Studio 自己管进程，不该被我们拉。
 * - 并发唤醒合并成一个 Promise：一次对话可能同时有主请求和标题生成两个请求，
 *   都发现「没在跑」，不能各起一个进程抢同一个端口。
 * - 唤醒用 `internal: true` 跳过探测链。定档结论上次已经算过了，为了叫醒再跑
 *   一遍 10~40 秒的探测链，比冷加载还慢。
 */
const waking = new Map<string, Promise<boolean>>()

/** 端口有没有应答（不关心状态码：llama.cpp 的 `/` 会 404，但进程活着） */
async function llamaHttpAlive(port: number, timeoutMs = 1500): Promise<boolean> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    await fetch(`http://127.0.0.1:${port}/props`, { signal: ctl.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** 等端口应答。加载大模型能到几十秒，所以上限给得比加载超时还宽一点 */
async function waitLlamaHttp(port: number, timeoutMs: number, stillAlive?: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await llamaHttpAlive(port, 2000)) return true
    // 进程已经退了就别再等三分钟：早点失败，让上层报真实原因
    if (stillAlive && !stillAlive()) return false
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

/**
 * 返回值语义：**true = 可以继续发请求**（不归我管 / 已经在跑 / 唤醒成功），
 * **false = 该唤醒但失败了**。调用方据此决定是继续还是报一句人话。
 */
export async function wakeLlama(provider: ProviderConfig): Promise<boolean> {
  if (!isLlamaProvider(provider)) return true
  /**
   * 只处理本机服务。
   *
   * `runtime: 'llama'` 也用于「别人家的 llama.cpp 服务」（局域网 / 服务器），
   * 那种情况我们既不该、也没能力去拉起一个进程 —— 探活失败就让它照常报错。
   */
  if (!isLoopbackUrl(provider.baseUrl)) return true
  const key = provider.id
  const port = llamaPortOf(provider)
  // 已经能应答：最常见的情况（服务正常在跑），一次本地 HTTP 的成本，别省
  if (await llamaHttpAlive(port)) return true

  const inFlight = waking.get(key)
  if (inFlight) return inFlight.catch(() => false)

  const run = (async () => {
    if (!instances.has(key)) {
      /**
       * 用配置里记下的窗口启动，并且当作用户手选档（ctxExplicit）。
       *
       * 「叫醒」的语义是「恢复上次的样子」，不是「重新定档」：
       * 不传 ctx 就会走自动定档，探测链按体检推荐值把 4K 抬回 32K ——
       * 用户手点过的档位在睡一觉之后自己变了，比不叫醒更让人困惑。
       */
      const keep = Number(provider.contextWindow)
      const ctx = Number.isFinite(keep) && keep >= 2048 ? Math.round(keep) : undefined
      const r = await startLlama(provider.model || undefined, ctx, {
        providerId: key,
        internal: true,
        ctxExplicit: ctx !== undefined
      }).catch(() => null)
      if (!r?.ok) return false
    }
    return await waitLlamaHttp(port, 180_000, () => instances.has(key))
  })()
  waking.set(key, run)
  try {
    return await run
  } finally {
    waking.delete(key)
  }
}

/** 启动时清理上次异常退出遗留的 llama-server（校验进程名，避免误杀） */
export function cleanupStaleLlama(): void {  // 新格式：多实例状态文件
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
  /**
   * 空闲卸载的状态说明。
   *
   * 卸载后实例表里已经没有它了，`statusLlamaBase` 只能报「未运行」——
   * 这和「崩溃退出」「用户手动停止」在界面上长得一模一样。补一条 idle，
   * 让界面能区分「我主动放掉的」和「它自己挂了的」。
   */
  if (providerId && st.state !== 'ready') {
    const hit = idleWatcher.unloaded().find((u) => u.key === providerId)
    if (hit) {
      return {
        ...st,
        idle: { model: hit.model, at: hit.at, idleMin: hit.idleMin },
        message: `已空闲卸载（闲置超过 ${hit.idleMin} 分钟，显存已释放）。下次发消息会自动重新加载 ${hit.model}。`
      }
    }
  }
  const q = queueInfoOf(`http://127.0.0.1:${st.port ?? LLAMA_PORT}`)
  if (!q) return st
  // 排队时把话说明白：不然用户看到「运行中」却一动不动，只会以为程序卡了
  const note = q.queued > 0 ? `，${q.queued} 个请求在排队（并发上限 ${q.limit}）` : ''
  return { ...st, queue: q, message: st.message + note }
}

/**
 * 运行中实例的实时显存采样，带节流。
 *
 * 界面轮询 status 时每 2~3 秒就会来一次，而每次 spawn nvidia-smi 要几十毫秒、
 * 且会打断它的计时中位数口径（这里只取单次，不做三次中位数）。所以按实例
 * key 缓存，3 秒内的查询直接复用。纯 CPU 实例、Vulkan/AMD 卡、没装 nvidia-smi
 * 都会返回 null —— 这时界面不显示仪表，而不是显示一个假的 0。
 */
const vramGate = new Map<string, { usedMiB: number; totalMiB: number; at: number }>()
const VRAM_TTL_MS = 3000

async function liveVramOf(key: string, device: string): Promise<LlamaStatus['vram']> {
  const hit = vramGate.get(key)
  if (hit && Date.now() - hit.at < VRAM_TTL_MS) return hit
  // 只有 CUDA 后端才问 nvidia-smi；Vulkan/CPU/自动选卡都拿不到准确数字，别硬报
  const d = device.trim().toLowerCase()
  if (d && !d.startsWith('cuda')) return undefined
  const idx = deviceIndex(device)
  const s = await gpuUsedMiB(idx).catch(() => null)
  if (!s) return undefined
  const out = { usedMiB: s.usedMiB, totalMiB: s.totalMiB, at: Date.now() }
  vramGate.set(key, out)
  return out
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

  /**
   * 崩溃记录按「实例 key」存：有 provider 时是 provider.id，没有时是 `port:8080`。
   *
   * 进程一退出，实例就从 instances 里删掉；这时候不带 providerId 来查状态，
   * 旧代码把 key 退化成空串，`crashes.get('')` 永远拿不到东西 —— 于是「模型架构不支持」
   * 「缺 cudart64_12.dll」「显存不够」这些已经抓到日志里的原因全部被吞，界面只剩
   * 一句「服务未运行」。用户以为自己点漏了，实际是启动失败。
   * 所以这里必须按端口回退到与启动时完全相同的 key 口径。
   */
  const key = inst?.key ?? providerId ?? `port:${port}`
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
    const vram = await liveVramOf(key, device)
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
      vram,
      // 实测调档的结论挂在这里：界面刷新状态时能顺带看到「为什么是 64K」
      message: tuneNoteOf(inst?.key) ? `服务运行中（${tuneNoteOf(inst?.key)}）` : '服务运行中'
    }
  }

  // 端口答 503：llama-server 已经 listen，正在加载模型 —— 这是正常中间态
  if (r.loading) {
    if ((elapsedMs ?? 0) > LOAD_TIMEOUT_MS) {
      // 到点就别再等了：先把进程收掉，再如实报超时，别让「加载中」变成永久状态
      if (inst?.pid) {
        killPidSync(inst.pid)
        crashes.set(key, {
          code: null,
          signal: null,
          at: Date.now(),
          tail: readLogTail(inst.logFile)
        })
        if (instances.get(key) === inst) instances.delete(key)
        void persistState()
      }
      return {
        ok: false,
        state: 'error',
        running: false,
        loading: false,
        code: 'START_TIMEOUT',
        phase: 'load',
        elapsedMs,
        port,
        device,
        crash: crashOut,
        message: `模型加载超过 ${Math.round(LOAD_TIMEOUT_MS / 60_000)} 分钟仍未完成，已停止进程。多半是模型太大、显存不足或模型文件损坏，换更小的量化再试。`
      }
    }
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
    /**
     * 只报「退出码 + 看日志」等于把排查推给用户。
     * llama.cpp 的失败原因高度集中在几句话里，这里认出来就直接说人话。
     */
    const hint = explainCrashTail(crash.tail ?? '')
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
      message:
        `llama-server 已退出（退出码 ${crash.code ?? '未知'}${crash.signal ? `，信号 ${crash.signal}` : ''}）` +
        (hint ? `\n${hint}` : '，日志尾部见 crash.tail')
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
