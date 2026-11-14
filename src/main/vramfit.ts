import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import type { AgentHeadroom, VramfitReport, VramfitResult } from '../shared/types'

/**
 * agent 负载的固定开销假设。
 *
 * 为什么需要它：`ctxMax` 只回答「上下文最多能开多大」，不回答「够不够用」。
 * 一个 coding agent 每轮都要带着系统提示、工具定义、技能索引跑，这部分是死开销，
 * 剩下的才轮到对话历史。所以真正该报的是「扣掉死开销后还能跑几轮」。
 *
 * 数值来源是本程序自己的提示构成：systemPrompt（十余条规则 + 环境信息）
 * 加上全部工具定义，实测在 5~7K token 量级；一轮工具往返（用户消息 + 工具结果 + 回复）
 * 约 1.5~2K。这里取中位数，宁可乐观点也别吓人 —— 真跑起来还会遇到压缩。
 */
export const AGENT_ASSUMPTION = {
  systemTokens: 6000,
  turnTokens: 1100,
  replyTokens: 700
} as const

/** 给定上下文，算还能装下几轮 agent 交互；ctx 缺失返回 null，不编数 */
export function agentHeadroomOf(
  ctx: number | null,
  a: { systemTokens: number; turnTokens: number; replyTokens: number } = AGENT_ASSUMPTION
): AgentHeadroom | null {
  if (!ctx || ctx <= 0) return null
  const perRoundTokens = a.turnTokens + a.replyTokens
  return {
    ctx,
    systemTokens: a.systemTokens,
    perRoundTokens,
    rounds: Math.max(0, Math.floor((ctx - a.systemTokens) / perRoundTokens))
  }
}

/**
 * vramfit 接入层：启动本地模型之前，先说清楚「这个文件在你这台机器上跑不跑得动」。
 *
 * 为什么走子进程而不是 import：
 * - vramfit 是 ESM，主进程编译成 CommonJS，直接 import 得绕过一堆打包限制；
 * - 它是独立仓库、自带测试和版本号，把它当命令行用，升级时只换目录、不动这里；
 * - `--json` 在 vramfit 里就是给脚本消费的稳定契约（verdict 是稳定标识、不跟语言走），
 *   这正是接入应该依赖的接口，而不是它的中文文案。
 *
 * 用 process.execPath + ELECTRON_RUN_AS_NODE 跑：安装包不带 node.exe，
 * 但 Electron 自己就是 Node，这样打包后也不用用户另外装 Node。
 */

/** 结果缓存：同一个文件（大小 + 修改时间没变）不重复读盘 */
const cache = new Map<string, { key: string; report: VramfitReport }>()
/** 同一文件并发请求合并成一次，避免连点按钮起一堆进程 */
const inflight = new Map<string, Promise<VramfitResult>>()

/**
 * 开发态的项目根。
 *
 * `app.getAppPath()` 在源码运行（`electron .`）时返回的是**入口文件所在目录**，
 * 也就是 `dist/main` —— 不是仓库根。以前直接拿它拼 `tools/vramfit`，
 * 于是「源码运行 + 体检」永远报「未找到 vramfit」，而打包版又是另一条路径，
 * 缺陷在打包环境里根本复现不了。
 */
function devRoot(): string {
  const candidates = [
    path.resolve(app.getAppPath(), '..', '..'), // dist/main → 仓库根
    process.cwd(),
    app.getAppPath()
  ]
  for (const c of candidates) {
    if (existsSync(path.join(c, 'tools', 'vramfit', 'check.mjs'))) return c
  }
  return process.cwd()
}

/** 脚本位置：开发态在仓库里，打包后由 extraResources 放到 resources/vramfit */
export function vramfitScript(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'vramfit', 'check.mjs')]
    : [path.join(devRoot(), 'tools', 'vramfit', 'check.mjs')]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

/** 模型路径可能来自界面（相对程序根目录），也可能是绝对路径 */
function resolveModel(input: string): string {
  if (!input) return ''
  if (path.isAbsolute(input)) return input
  /**
   * 相对路径先按当前工作目录解析：源码运行、命令行、脚本里传 `models/x.gguf`
   * 都是这个直觉。以前一律拼程序根目录，于是 `release/models/x.gguf` 会被
   * 拼成 `release/release/models/x.gguf`，报「模型文件不存在」。
   */
  const fromCwd = path.resolve(input)
  if (existsSync(fromCwd)) return fromCwd
  const base =
    process.env.PORTABLE_EXECUTABLE_DIR ||
    (app.isPackaged ? path.dirname(app.getPath('exe')) : devRoot())
  return path.join(base, input)
}

interface RunOut {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** KV 精度档：和 llama.cpp 启动参数一一对应，决定体检算出来的 KV 有多大 */
export type VramfitKv = 'f16' | 'q8_0' | 'q4_0' | 'k8v16'

function runJson(
  script: string,
  file: string,
  timeoutMs: number,
  gpuIndex = 0,
  kv: VramfitKv = 'f16',
  mmproj: string | null = null
): Promise<RunOut> {
  return new Promise((resolve) => {
    const args = [script, '--json']
    // 双卡机器上「这个模型跑不跑得动」要按它实际绑的那张卡算，
    // 不指定的话 vramfit 只看第一块，第二个模型永远拿到错结论。
    if (gpuIndex > 0) args.push('--gpu', String(gpuIndex))
    /**
     * KV 精度必须跟着真正启动时用的参数走。
     *
     * 以前这里不传，体检一律按 f16 算：Turing 上用 `-ctk q8_0` 起的实例 KV 只有 f16 的
     * 76%，体检却按 100% 报，于是一个能装 64K 的模型被判成只能装 32K —— 用户看到的是
     * 「显存才用 6.6G，为什么不给我更大的窗口」。
     */
    if (kv !== 'f16') args.push('--kv', kv)
    /**
     * 视觉投影器：这个模型一旦发图片就会挂上它，而它自己要吃 300~700 MiB。
     * 以前完全不传，于是「体检说 32K 装得下 → 发第一张图就 OOM」。
     */
    if (mmproj) args.push('--mmproj', mmproj)
    args.push(file)
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VRAMFIT_LANG: 'zh' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString('utf8')
      // 头部元数据只有几十 KB，输出不该无限增长；异常时直接掐掉
      if (stdout.length > 8 * 1024 * 1024) child.kill()
    })
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString('utf8')
      if (stderr.length > 256 * 1024) stderr = stderr.slice(0, 256 * 1024)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: String(err.message ?? err), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

/** 空目录 / 没装 vramfit 时的统一答复，界面据此隐藏入口 */
export function vramfitAvailable(): { ok: boolean; path?: string; message: string } {
  const script = vramfitScript()
  return script
    ? { ok: true, path: script, message: 'vramfit 可用' }
    : { ok: false, message: '未找到 vramfit（tools/vramfit/check.mjs）' }
}

/**
 * 给一个 .gguf 出体检报告。
 *
 * 失败分三种，界面要区别对待，所以 message 里写清是哪一种：
 * 文件读不到 / 元数据解析失败（vramfit 返回 error 项）/ 进程本身起不来。
 */
export async function checkModel(
  input: string,
  gpuIndex = 0,
  kv: VramfitKv = 'f16',
  /** 这个模型的视觉投影器（一旦发图片就会挂上）：有就必须算进预算 */
  mmproj?: string | null
): Promise<VramfitResult> {
  const file = resolveModel(input)
  if (!file) return { ok: false, message: '没有指定模型文件' }

  const st = await fs.stat(file).catch(() => null)
  if (!st || !st.isFile()) return { ok: false, message: `模型文件不存在：${input}` }
  if (st.size === 0) return { ok: false, message: '模型文件是空的（可能还没下载完）' }

  /**
   * 投影器只认真实存在的文件：配错路径时按纯文本算，比拿一个不存在的文件
   * 让 vramfit 报错更好 —— 体检的结论仍然有效，只是少了那 300~700 MiB 的预留。
   */
  const mm = mmproj && path.isAbsolute(mmproj) ? mmproj : mmproj ? resolveModel(mmproj) : ''
  const mmStat = mm ? await fs.stat(mm).catch(() => null) : null
  const mmPath = mmStat?.isFile() ? mm : null

  const card = Math.max(0, Math.round(Number(gpuIndex) || 0))
  // 投影器换了（同名不同量化、重新下载）结论也会变，所以它的体积和 mtime 必须进缓存键
  const mmKey = mmPath ? `${path.basename(mmPath)}:${mmStat?.size ?? 0}:${Math.round(mmStat?.mtimeMs ?? 0)}` : ''
  const key = `${st.size}:${Math.round(st.mtimeMs)}:${kv}:${mmKey}`
  // 同一个文件在两块卡上的结论不一样（可用显存不同），缓存与并发合并都得带上卡号和 KV 精度
  const slot = `${file}|gpu${card}|kv${kv}|mm${mmKey}`
  const hit = cache.get(slot)
  if (hit && hit.key === key) return { ok: true, report: hit.report }

  const running = inflight.get(slot)
  if (running) return running

  const task = (async (): Promise<VramfitResult> => {
    const script = vramfitScript()
    if (!script) return { ok: false, message: '未找到 vramfit，无法体检（缺 tools/vramfit/check.mjs）' }

    const out = await runJson(script, file, 90_000, card, kv, mmPath)
    if (out.timedOut) return { ok: false, message: '体检超时（90 秒），文件可能太大或磁盘繁忙' }

    const text = out.stdout.trim()
    if (!text) {
      const hint = out.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? ''
      return { ok: false, message: `体检没跑起来${out.code != null ? `（退出码 ${out.code}）` : ''}${hint ? `：${hint}` : ''}` }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, message: '体检输出不是合法 JSON，可能是 vramfit 版本不匹配' }
    }
    const rows = Array.isArray(parsed) ? (parsed as Array<VramfitReport | { file?: string; error?: string }>) : []
    const first = rows[0]
    if (!first) return { ok: false, message: '体检没有返回结果' }
    if ('error' in first && first.error) return { ok: false, message: `读不懂这个 GGUF：${first.error}` }

    const report = first as VramfitReport
    if (typeof report.verdict !== 'string' || !Array.isArray(report.tiers)) {
      return { ok: false, message: '体检结果字段不全，可能是 vramfit 版本不匹配' }
    }
    // 只在能算出建议上下文时补一段 agent 余量：算不出来就别硬凑一个 0
    const headroom = agentHeadroomOf(report.recommendedCtx)
    if (headroom) report.agent = headroom
    cache.set(slot, { key, report })
    return { ok: true, report }
  })()

  inflight.set(slot, task)
  try {
    return await task
  } finally {
    inflight.delete(slot)
  }
}

/**
 * 启动前用一次：只要「建议上下文」和一句结论，不渲染整张表。
 * 没有 vramfit、或算不出来时返回 null —— 不给调用方制造假结论。
 *
 * gpuIndex 是「这次要放到哪张卡上」：双卡机器上两个模型各算各的，
 * 拿第一块卡的余量去估第二块卡上的模型只会得出错结论。
 */
export async function fitForLaunch(
  input: string,
  gpuIndex = 0,
  kv: VramfitKv = 'f16',
  /** 这个模型的视觉投影器：有就按「会挂投影器」算，避免发图片时才发现装不下 */
  mmproj?: string | null
): Promise<{
  verdict: VramfitReport['verdict']
  recommendedCtx: number | null
  fits: boolean
  gpuName: string | null
  summary: string
  /** 扣掉系统提示与工具定义后还能跑几轮：决定「够不够用」的是它，不是 ctxMax */
  agentRounds: number | null
  /** 显存预算上限（MiB）：实测调档时拿它当边界 */
  limitMiB: number | null
  /**
   * 显卡总显存（MiB）。
   *
   * 和 limitMiB 不是一回事：limit 是「这次能用多少」（已经扣掉桌面占用），
   * total 是物理容量。小卡判定（`--fit-target` 的留白比例）只能用 total，
   * 用 limit 会把 8 GB 卡上的 6.3 GB 预算当成 6 GB 卡。
   */
  totalMiB: number | null
  /**
   * 每 1000 tokens 的 KV 占用（MiB）。由最高两档的估算差值反推：
   * need = 权重 + KV + 缓冲，前后两档只有 KV 在变，所以差值就是 KV 的斜率。
   */
  kvMiBPerKToken: number | null
  /** 模型训练窗口（n_ctx_train），调档时不能越过 */
  nativeCtx: number | null
  /**
   * 挂上视觉投影器之后还能开的最大档；没有投影器 / 没传时为 null。
   *
   * 切视觉是按需重启（`--mmproj` 只能启动时传），那一刻必须用这个值而不是
   * 纯文本的 recommendedCtx —— 否则 32K 的纯文本实例挂上投影器就会 OOM。
   */
  visionCtx: number | null
  /** 投影器带来的额外占用（MiB）；没有投影器时为 null */
  visionExtraMiB: number | null
  /**
   * 推荐档本身是否「贴着预算上限」（need > limit × 0.85）。
   *
   * 贴边意味着估算误差稍微偏一点就会 OOM，也就是必然会多花一次 10 秒重载。
   * 启动时据此主动降一档，拿 10% 的窗口换一次成功的启动 —— 以前这个标记
   * 体检算了、单测也覆盖了，但调用方根本没往下传，等于从没生效过。
   */
  tightAtStart: boolean
} | null> {
  const r = await checkModel(input, gpuIndex, kv, mmproj).catch(() => null)
  if (!r?.ok) return null
  const rep = r.report
  const fits = rep.verdict !== 'not-recommended' && rep.verdict !== 'unknown'
  const gpu = rep.gpu ? `${rep.gpu.name}（${(rep.budget.limitBytes / 1024 ** 3).toFixed(1)} GB 可用）` : 'CPU 推理'
  const ctx = rep.recommendedCtx
  const rounds = rep.agent?.rounds ?? null
  const roundsNote = rounds !== null && fits ? `，装下系统提示后约 ${rounds} 轮` : ''
  /**
   * 看图开销要写在结论里，否则用户会奇怪「同一个模型，昨天推荐 32K，发张图就崩」。
   * 主结论仍是纯文本口径 —— 默认启动不会挂投影器。
   */
  const visionNote = rep.vision
    ? `；发图片要挂投影器，多占 ${Math.round(rep.vision.totalBytes / (1024 * 1024))} MiB` +
      (rep.vision.recommendedCtx
        ? `，那时建议 ${Math.round(rep.vision.recommendedCtx / 1024)}K`
        : '，那时一档都装不下（会退回纯文本或按层分担）')
    : ''
  const summary = fits
    ? `装得下：建议上下文 ${ctx ? `${Math.round(ctx / 1024)}K` : '未知'}，参考速度约 ${rep.genTokPerSec ?? rep.genTokPerSecOnCpu ?? '?'} tok/s（零上下文理论上限，非实测）${roundsNote}${visionNote}`
    : rep.verdict === 'unknown'
      ? '元数据不全，算不出上下文'
      : `装不下：权重本身就超过可用显存${visionNote}`

  // KV 斜率：取最高两个算得出体积的档位。高处的斜率才代表「再往上开一档」的真实代价，
  // 滑窗架构在低档位上 KV 被窗口截断，用低档位的差值会高估。
  const known = rep.tiers.filter((t) => typeof t.needBytes === 'number') as Array<{ ctx: number; needBytes: number }>
  let kvMiBPerKToken: number | null = null
  if (known.length >= 2) {
    const hi = known[known.length - 1]
    const lo = known[known.length - 2]
    const delta = hi.needBytes - lo.needBytes
    if (delta > 0 && hi.ctx > lo.ctx) kvMiBPerKToken = (delta / (hi.ctx - lo.ctx)) * 1000 / (1024 * 1024)
  }

  return {
    verdict: rep.verdict,
    recommendedCtx: ctx,
    fits,
    gpuName: gpu,
    summary,
    agentRounds: rounds,
    limitMiB: rep.gpu ? Math.round(rep.budget.limitBytes / (1024 * 1024)) : null,
    totalMiB: rep.gpu?.totalBytes ? Math.round(rep.gpu.totalBytes / (1024 * 1024)) : null,
    kvMiBPerKToken,
    nativeCtx: rep.nativeContext ?? null,
    // 切视觉重启时按这个档定上下文，不能用纯文本的 recommendedCtx
    visionCtx: rep.vision?.recommendedCtx ?? null,
    visionExtraMiB: rep.vision ? Math.round(rep.vision.totalBytes / (1024 * 1024)) : null,
    // 只有「体检自己算出这一档」时 tight 才有意义；算不出档位就没有贴边一说
    tightAtStart: ctx !== null && rep.tiers.some((t) => t.ctx === ctx && t.tight === true)
  }
}
