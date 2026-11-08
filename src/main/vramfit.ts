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

/** 脚本位置：开发态在仓库里，打包后由 extraResources 放到 resources/vramfit */
export function vramfitScript(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'vramfit', 'check.mjs')]
    : [path.join(app.getAppPath(), 'tools', 'vramfit', 'check.mjs')]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

/** 模型路径可能来自界面（相对程序根目录），也可能是绝对路径 */
function resolveModel(input: string): string {
  if (!input) return ''
  if (path.isAbsolute(input)) return input
  const base =
    process.env.PORTABLE_EXECUTABLE_DIR ||
    (app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath())
  return path.join(base, input)
}

interface RunOut {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function runJson(script: string, file: string, timeoutMs: number, gpuIndex = 0): Promise<RunOut> {
  return new Promise((resolve) => {
    const args = [script, '--json']
    // 双卡机器上「这个模型跑不跑得动」要按它实际绑的那张卡算，
    // 不指定的话 vramfit 只看第一块，第二个模型永远拿到错结论。
    if (gpuIndex > 0) args.push('--gpu', String(gpuIndex))
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
export async function checkModel(input: string, gpuIndex = 0): Promise<VramfitResult> {
  const file = resolveModel(input)
  if (!file) return { ok: false, message: '没有指定模型文件' }

  const st = await fs.stat(file).catch(() => null)
  if (!st || !st.isFile()) return { ok: false, message: `模型文件不存在：${input}` }
  if (st.size === 0) return { ok: false, message: '模型文件是空的（可能还没下载完）' }

  const card = Math.max(0, Math.round(Number(gpuIndex) || 0))
  const key = `${st.size}:${Math.round(st.mtimeMs)}`
  // 同一个文件在两块卡上的结论不一样（可用显存不同），缓存与并发合并都得带上卡号
  const slot = `${file}|gpu${card}`
  const hit = cache.get(slot)
  if (hit && hit.key === key) return { ok: true, report: hit.report }

  const running = inflight.get(slot)
  if (running) return running

  const task = (async (): Promise<VramfitResult> => {
    const script = vramfitScript()
    if (!script) return { ok: false, message: '未找到 vramfit，无法体检（缺 tools/vramfit/check.mjs）' }

    const out = await runJson(script, file, 90_000, card)
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
export async function fitForLaunch(input: string, gpuIndex = 0): Promise<{
  verdict: VramfitReport['verdict']
  recommendedCtx: number | null
  fits: boolean
  gpuName: string | null
  summary: string
  /** 扣掉系统提示与工具定义后还能跑几轮：决定「够不够用」的是它，不是 ctxMax */
  agentRounds: number | null
} | null> {
  const r = await checkModel(input, gpuIndex).catch(() => null)
  if (!r?.ok) return null
  const rep = r.report
  const fits = rep.verdict !== 'not-recommended' && rep.verdict !== 'unknown'
  const gpu = rep.gpu ? `${rep.gpu.name}（${(rep.budget.limitBytes / 1024 ** 3).toFixed(1)} GB 可用）` : 'CPU 推理'
  const ctx = rep.recommendedCtx
  const rounds = rep.agent?.rounds ?? null
  const roundsNote = rounds !== null && fits ? `，装下系统提示后约 ${rounds} 轮` : ''
  const summary = fits
    ? `装得下：建议上下文 ${ctx ? `${Math.round(ctx / 1024)}K` : '未知'}，约 ${rep.genTokPerSec ?? rep.genTokPerSecOnCpu ?? '?'} tok/s${roundsNote}`
    : rep.verdict === 'unknown'
      ? '元数据不全，算不出上下文'
      : '装不下：权重本身就超过可用显存'
  return { verdict: rep.verdict, recommendedCtx: ctx, fits, gpuName: gpu, summary, agentRounds: rounds }
}
