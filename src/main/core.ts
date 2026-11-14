import fs from 'node:fs/promises'
import path from 'node:path'
import { downloadToFile, headSize, humanSize, speedMeter } from './dl'
import { loadConfig, saveConfig } from './config'
import {
  cancelLlamaInstall,
  configureLlama,
  coreRoot,
  detectBackend,
  installLlama,
  launchKvType,
  llamaInstances,
  llamaServerExe,
  startLlama,
  statusLlama
} from './llama'
import { fitForLaunch } from './vramfit'
import { detectGpuPreference } from './gpuplan'
import type {
  CorePhase,
  CoreProgress,
  CoreSetupResult,
  CoreStep,
  LlamaErrorCode,
  ProviderConfig
} from '../shared/types'

/**
 * 简易核心：点一下就把「能对话的本地核心」装好。
 *
 * 六步按依赖顺序走：建目录 → 下模型 → 装 llama.cpp → 写配置 → 加载模型 → 自检。
 * 每一步都把结论带回界面；某一步失败就停在那里说清原因，不往下假装成功
 * （后面几步依赖前面的产物，硬跑只会得到更难懂的报错）。
 */

/** 目录名固定英文：core/，放在软件根目录下（便携版就是 exe 旁边） */
export const CORE_DIR_NAME = 'core'

/**
 * 核心模型的文件名固定成这两个。
 *
 * 好处不止好看：`mmproj-Core.gguf` 和 `Core.gguf` 同目录同前缀，启动时的
 * 投影器配对（findMmprojFor）按这个固定名一眼就能配上；用户换了哪个模型当下核心，
 * 文件名都不变，「兜底用哪个文件」永远是确定的，不依赖当初下载时的那串版本名。
 *
 * 注意：llama-server 用 -m 加载本地 GGUF 时**不会**自己去目录里找投影器
 * （--mmproj-auto 只对 -hf 在线下载生效），必须由本程序算出路径、显式传 --mmproj，
 * 否则 Qwen3-VL 这类视觉主模型会被当成纯文本模型启动，发过去的图片直接被忽略。
 */
export const CORE_MODEL_NAME = 'Core.gguf'
export const CORE_MMPROJ_NAME = 'mmproj-Core.gguf'

/** 核心模型在配置里的供应商 id：和用户的 llamacpp 分开，才能各跑一个实例 */
export const CORE_PROVIDER_ID = 'core'

/**
 * 核心模型专用的本地端口。
 *
 * 以前和 llamacpp 一样写死 8080：两条配置指向同一个地址，谁后启动谁占坑，
 * 另一条的请求就会打到**别人的模型**上（llama-server 不校验 model 名）。
 * 用户看到的是「明明选的是 9B，回答却像小模型」——最难查的那种错。
 * 8188 和 llama.cpp / Ollama / LM Studio 的默认端口都不重叠。
 */
export const CORE_PORT = 8188

/**
 * 核心模型的下载地址（直链）——**待填**。
 *
 * 留空时这一步会跳过：目录照样建好、llama.cpp 照样装好，只是不下载模型；
 * 想临时用也可以自己把 .gguf 丢进 core/（文件名随便，能找到就用）。
 * 填上以后（形如 https://.../xxx-Q4_K_M.gguf）就能一路下载 → 加载 → 自检，
 * 落盘时统一改名成 `Core.gguf`。
 */
const CORE_MODEL_URL = ''

/** 配套的多模态投影器地址；留空就不下（纯文字模型本来也没有） */
const CORE_MMPROJ_URL = ''

/** 落盘文件名；留空就用固定的 Core.gguf，一般不用动 */
const CORE_MODEL_FILE = ''


/** 正在进行的准备（用于「取消」） */
let coreAbort: AbortController | null = null

/**
 * 最近一次准备进度 + 是否还在跑。
 * 面板切走再回来时靠它把进度条接上：核心准备里最长的一段就是下载，
 * 它跑在主进程，跟界面在看哪个面板无关。
 */
let coreLast: CoreProgress | null = null

export function coreSetupSnapshot(): { running: boolean; progress: CoreProgress | null } {
  return { running: !!coreAbort, progress: coreLast }
}

export function cancelCoreSetup(): { ok: boolean; message: string } {
  if (!coreAbort) return { ok: false, message: '当前没有正在进行的准备' }
  coreAbort.abort()
  // 装 llama.cpp 走的是另一条下载链路，一起叫停，否则取消以后它还在后台拉 300MB
  cancelLlamaInstall()
  return { ok: true, message: '正在取消…' }
}

function fileNameOf(url: string): string {
  if (CORE_MODEL_FILE.trim()) return CORE_MODEL_FILE.trim()
  try {
    // 地址能解析就说明不是坏链接；文件名仍然固定，保证 core/ 里永远只有一份「核心」
    void new URL(url)
  } catch {
    // 解析不了也照下，落盘名固定，不影响
  }
  return CORE_MODEL_NAME
}

/**
 * core/ 里已有的主模型：优先固定名 `Core.gguf`，其次任意一个不是投影器的 .gguf。
 * 用户以前下载 / 手动放进去的老名字（比如 Qwen3VL-…gguf）照样认，不用改名。
 */
async function existingGguf(dir: string): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const files = entries.filter((e) => e.isFile() && /\.gguf$/i.test(e.name)).map((e) => e.name)
  const exact = files.find((n) => n.toLowerCase() === CORE_MODEL_NAME.toLowerCase())
  if (exact) return path.join(dir, exact)
  const other = files.find((n) => !/mmproj|projector/i.test(n))
  return other ? path.join(dir, other) : null
}

/** 核心模型文件（不存在就 null）：兜底、体检、加载都从这里取路径 */
export async function coreModelFile(): Promise<string | null> {
  return await existingGguf(coreRoot())
}

async function freeBytes(dir: string): Promise<number> {
  try {
    const st = await fs.statfs(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return 0
  }
}

export async function setupCore(
  onProgress?: (p: CoreProgress) => void
): Promise<CoreSetupResult> {
  const stepList: CoreStep[] = []
  const emit = (p: CoreProgress) => {
    coreLast = p
    try {
      onProgress?.(p)
    } catch {
      // 窗口关了，进度没人收，不影响流程
    }
  }
  const add = (id: CorePhase, label: string, state: CoreStep['state'], message: string) => {
    stepList.push({ id, label, state, message })
  }

  const dir = coreRoot()
  const checks: CoreSetupResult['checks'] = {}
  const ctrl = new AbortController()
  coreAbort = ctrl
  let modelFile = ''
  let providerId = ''

  const done = (ok: boolean, message: string): CoreSetupResult => ({
    ok,
    message,
    dir,
    modelFile: modelFile || undefined,
    providerId: providerId || undefined,
    steps: stepList,
    checks
  })

  try {
    // ① 目录
    emit({ phase: 'dir', message: '正在创建核心目录…' })
    try {
      await fs.mkdir(dir, { recursive: true })
      add('dir', '核心目录', 'ok', dir)
    } catch (e) {
      const msg = `建目录失败：${(e as Error).message}`
      add('dir', '核心目录', 'error', msg)
      return done(false, msg)
    }

    // ② 模型
    emit({ phase: 'model', message: '正在准备核心模型…' })
    const existing = await existingGguf(dir)
    if (existing) {
      modelFile = existing
      add('model', '核心模型', 'skip', `已在 core/ 里找到：${path.basename(existing)}`)
    } else if (!CORE_MODEL_URL.trim()) {
      add('model', '核心模型', 'skip', '下载地址待填，本轮跳过（也可自己把 .gguf 放进 core/）')
    } else {
      const url = CORE_MODEL_URL.trim()
      const dest = path.join(dir, fileNameOf(url))
      const total = await headSize(url)
      const free = await freeBytes(dir)
      if (free > 0 && total > 0 && free < total + 1024 ** 3) {
        const msg = `磁盘空间不足：需要约 ${humanSize(total)}，${dir} 所在盘只剩 ${humanSize(free)}`
        add('model', '核心模型', 'error', msg)
        return done(false, msg)
      }
      const meter = speedMeter()
      let lastEmit = 0
      emit({ phase: 'model', receivedBytes: 0, totalBytes: total, message: `正在下载 ${path.basename(dest)}…` })
      try {
        await downloadToFile(
          url,
          dest,
          (received, tot) => {
            const now = Date.now()
            // 250ms 一次就够界面刷新了，太频繁反而卡
            if (now - lastEmit < 250 && (!tot || received < tot)) return
            lastEmit = now
            emit({
              phase: 'model',
              receivedBytes: received,
              totalBytes: tot || total,
              bytesPerSec: meter(received),
              message: `正在下载 ${path.basename(dest)}…`
            })
          },
          { signal: ctrl.signal, expectedBytes: total || undefined }
        )
      } catch (e) {
        const cancelled = ctrl.signal.aborted
        const msg = cancelled ? '已取消下载' : `模型下载失败：${(e as Error).message}`
        add('model', '核心模型', 'error', msg)
        return done(false, msg)
      }
      modelFile = dest
      add('model', '核心模型', 'ok', total > 0 ? `${path.basename(dest)}（${humanSize(total)}）` : path.basename(dest))
    }

    // ②b 投影器（可选）：和 Core.gguf 同目录、同前缀，启动时会显式挂 --mmproj。
    // 下载地址留空也要走这一步：本地已经放好了投影器就该报告出来，
    // 否则界面上永远没有「视觉投影器」这一项，用户会以为模型本来就看不了图。
    if (modelFile) {
      const mmDest = path.join(dir, CORE_MMPROJ_NAME)
      const hasMm = await fs
        .stat(mmDest)
        .then((st) => st.size > 0)
        .catch(() => false)
      if (hasMm) {
        add('mmproj', '视觉投影器', 'skip', `已有：${CORE_MMPROJ_NAME}（可看图，启动时会挂上）`)
      } else if (!CORE_MMPROJ_URL.trim()) {
        add('mmproj', '视觉投影器', 'skip', `没有 ${CORE_MMPROJ_NAME}，本次按纯文本模型加载`)
      } else {
        emit({ phase: 'model', message: `正在下载 ${CORE_MMPROJ_NAME}…` })
        let lastMmEmit = 0
        try {
          await downloadToFile(
            CORE_MMPROJ_URL.trim(),
            mmDest,
            (received, tot) => {
              const now = Date.now()
              if (now - lastMmEmit < 500 && (!tot || received < tot)) return
              lastMmEmit = now
              emit({
                phase: 'model',
                receivedBytes: received,
                totalBytes: tot,
                message: `正在下载 ${CORE_MMPROJ_NAME}…`
              })
            },
            { signal: ctrl.signal }
          )
          add('mmproj', '视觉投影器', 'ok', `${CORE_MMPROJ_NAME}（可看图）`)
        } catch (e) {
          // 投影器只影响看图，缺了照样能对话，不该拦住整条流程
          add('mmproj', '视觉投影器', 'skip', `下载失败，先跳过：${(e as Error).message}`)
        }
      }
    }

    // ③ llama.cpp
    emit({ phase: 'llama', message: '正在检查 llama.cpp…' })
    const exe = await llamaServerExe()
    if (exe) {
      // 老用户机器上可能早就装过 CPU 版：这一步以前只说「已安装」，
      // 于是明明有显卡也一直跑在 CPU 上。现在把差别说出来并给条路。
      const cur = await detectBackend()
      const want = detectGpuPreference()
      if (cur.backend === 'cpu' && want.preference !== 'cpu') {
        add(
          'llama',
          'llama.cpp',
          'skip',
          `已装的是 CPU 版（${want.reason}）：想用显卡，到「② 本地模型 → 一键安装」重装一次即可换成显卡版`
        )
      } else {
        add('llama', 'llama.cpp', 'skip', `已安装：${exe}`)
      }
    } else {
      const r = await installLlama((p) =>
        emit({
          phase: 'llama',
          receivedBytes: p.receivedBytes,
          totalBytes: p.totalBytes,
          bytesPerSec: p.bytesPerSec,
          message: p.message
        })
      )
      if (!r.ok) {
        add('llama', 'llama.cpp', 'error', r.message)
        return done(false, r.message)
      }
      add('llama', 'llama.cpp', 'ok', r.message.split('\n')[0])
    }
    const backend = await detectBackend()
    checks.backend = backend.backend
    checks.gpuReady = backend.gpuReady

    // ④ 配置：有核心模型就写一条**专门的** core 供应商，和用户自己的 llamacpp 分开，
    // 这样用户切到别的本地模型时，核心模型还能单独起一个实例兜底
    emit({ phase: 'config', message: '正在写入本地模型配置…' })
    const cfg = modelFile ? await ensureCoreProvider(modelFile) : await configureLlama()
    if (!cfg.ok) {
      add('config', '本地配置', 'error', cfg.message)
      return done(false, cfg.message)
    }
    providerId = cfg.providerId ?? ''
    add('config', '本地配置', 'ok', cfg.message)

    // ⑤ 加载：先体检拿「这台机器能开多大上下文」，再按它启动
    if (!modelFile) {
      add('start', '加载模型', 'skip', '没有核心模型，先不加载')
      add('check', '自检', 'ok', `llama.cpp 后端：${checks.backend}${checks.gpuReady ? '（会用显卡）' : '（CPU）'}`)
      return done(
        true,
        `核心目录已就绪：${dir}\nllama.cpp 已安装并配置好；核心模型下载地址还没填，填上后再点一次即可加载。`
      )
    }

    emit({ phase: 'start', message: `正在体检 ${path.basename(modelFile)}…` })
    /**
     * 核心模型带投影器时也要把它算进预算：发图会挂上，体检漏算就是「一开图就崩」。
     * 这里重新 stat 一次，不复用上面那个 hasMm —— 它在上一个 if 块里，作用域不到这里。
     */
    const coreMm = path.join(dir, CORE_MMPROJ_NAME)
    const hasCoreMm = await fs.stat(coreMm).then((s) => s.size > 0).catch(() => false)
    const fit = await fitForLaunch(modelFile, 0, await launchKvType(), hasCoreMm ? coreMm : null).catch(() => null)
    if (fit) checks.fit = fit.summary

    emit({ phase: 'start', message: '正在加载核心模型（首次要几十秒）…' })
    const r = await startLlama(modelFile, fit?.recommendedCtx ?? undefined, {
      providerId: providerId || undefined
    })
    if (!r.ok) {
      add('start', '加载模型', 'error', r.message)
      return done(false, r.message)
    }
    add('start', '加载模型', 'ok', r.message.split('\n')[0])

    // ⑥ 自检：等它真能应答，而不是「进程起来了就算成功」
    emit({ phase: 'check', message: '正在等待模型加载完成…' })
    const deadline = Date.now() + 90_000
    let st = await statusLlama(providerId)
    while (st.state === 'loading' && !ctrl.signal.aborted && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 2500))
      const secs = st.elapsedMs ? Math.round(st.elapsedMs / 1000) : 0
      emit({ phase: 'check', message: `模型正在加载${secs ? `（已 ${secs} 秒）` : ''}…` })
      st = await statusLlama(providerId)
    }
    checks.running = st.state === 'ready'
    checks.port = st.port
    if (st.state === 'ready') {
      add('check', '自检', 'ok', `服务已在端口 ${st.port ?? '?'} 上应答`)
    } else if (st.state === 'error') {
      // 崩了就别再等：把 code 和日志尾部直接摆出来，省掉一次盲猜
      add('check', '自检', 'error', `${st.code}: ${st.message}`)
      return done(false, `${st.message}${st.crash?.tail ? `\n\n日志尾部：\n${st.crash.tail}` : ''}`)
    } else {
      // 加载没等到回应不算失败：模型越大越慢，进程可能还在读盘
      add('check', '自检', 'skip', '还没等到回应，可能仍在加载；稍后到「② 本地模型」点「自动配置」即可看到状态')
    }

    const parts = [`核心已就绪：${path.basename(modelFile)}`]
    if (checks.backend) parts.push(`llama.cpp：${checks.backend}${checks.gpuReady ? '（GPU）' : '（CPU）'}`)
    if (st.running) parts.push(`端口 ${st.port ?? '?'}`)
    if (checks.fit) parts.push(checks.fit)
    parts.push(`模型在 ${dir}`)
    return done(true, parts.join('\n'))
  } catch (e) {
    const msg = `准备失败：${(e as Error).message}`
    add('check', '自检', 'error', msg)
    return done(false, msg)
  } finally {
    if (coreAbort === ctrl) {
      coreAbort = null
      // 跑完就别留旧进度了：面板重新挂载时不会误以为还在准备
      coreLast = null
    }
  }
}

/* ------------------------------------------------------------------ *
 * 默认核心：用户自己的模型好用就用他的，不好使自动落到 core/Core.gguf
 * ------------------------------------------------------------------ */

interface CoreProviderResult {
  ok: boolean
  message: string
  providerId?: string
  created?: boolean
}

/**
 * 确保配置里有那条「核心模型」供应商（id 固定 core）。
 *
 * 单独一条而不是复用 llamacpp：用户切到别的本地模型时，那是另一条配置、
 * 另一个实例；核心模型要能自己起、自己停，互不干扰。**不动 activeId** ——
 * 建这条只是备着，不能把用户正在用的模型换掉。
 */
export async function ensureCoreProvider(modelFile: string): Promise<CoreProviderResult> {
  try {
    const config = await loadConfig()
    const providers: ProviderConfig[] = config.providers.map((p) => ({ ...p }))
    const model = path.basename(modelFile)
    // core/ 的固定命名：只要 mmproj-Core.gguf 在，就显式写进配置。
    // 不能只靠 findMmprojFor 的文件名打分 —— Core.gguf 只有一个身份 token，
    // 老规则要求 >=2 个共享 token，结果每次都以纯文本模式启动（看不了图）。
    const mmFile = path.join(path.dirname(modelFile), CORE_MMPROJ_NAME)
    const hasMm = await fs
      .stat(mmFile)
      .then((st) => st.size > 0)
      .catch(() => false)
    let target = providers.find((p) => p.id === CORE_PROVIDER_ID)
    const created = !target
    if (!target) {
      target = {
        id: CORE_PROVIDER_ID,
        name: '核心模型（默认兜底）',
        kind: 'openai',
        baseUrl: `http://127.0.0.1:${CORE_PORT}/v1`,
        apiKey: 'no-key',
        model,
        contextWindow: 16384,
        temperature: 0.2,
        runtime: 'llama',
        // 标记成备用：用户自己那条好使时轮不到它，不好使时才顶上
        fallback: true
      }
      providers.push(target)
    } else {
      target.kind = 'openai'
      target.runtime = 'llama'
      target.model = model
      if (!target.apiKey) target.apiKey = 'no-key'
      target.fallback = true
      if (!target.name) target.name = '核心模型（默认兜底）'
    }
    // 显式指定优先于自动配对；投影器没了就把自己写的那条清掉，别留个死路径。
    // 用户手动填过的其它路径不覆盖。
    if (hasMm) target.mmproj = target.mmproj || CORE_MMPROJ_NAME
    else if (target.mmproj === CORE_MMPROJ_NAME) delete target.mmproj
    await saveConfig({ ...config, providers })
    return {
      ok: true,
      created,
      providerId: CORE_PROVIDER_ID,
      message: created ? `已新建核心模型：${model}` : `核心模型已就绪：${model}`
    }
  } catch (err) {
    return { ok: false, message: `写入核心配置失败：${(err as Error).message}` }
  }
}

/** 配置里的核心供应商（没有就返回 null；不会写盘） */
export async function coreProvider(): Promise<ProviderConfig | null> {
  const config = await loadConfig()
  return config.providers.find((p) => p.id === CORE_PROVIDER_ID) ?? null
}

/**
 * 兜底链要用的核心供应商：有 Core.gguf 才返回。
 *
 * 只在用户自己那条失败时才被调用，所以这里顺手「没有就补一条」是安全的：
 * 装过简易核心但配置被清掉的机器也能兜住。
 */
export async function coreFallbackProvider(): Promise<ProviderConfig | null> {
  const file = await coreModelFile()
  if (!file) return null
  const found = await coreProvider()
  if (found?.model) return found
  const r = await ensureCoreProvider(file)
  if (!r.ok) return null
  return await coreProvider()
}

export interface CoreReady {
  ok: boolean
  /** 就绪后重新读出来的供应商（baseUrl / 端口是最新的） */
  provider: ProviderConfig | null
  message: string
  /** 机器可读的失败原因：调用方据此决定是重试、换模型还是提示用户 */
  code?: LlamaErrorCode
}

/** 同一个时刻只允许一个「拉起核心」在跑：主对话和子 agent 可能同时要兜底 */
let coreStarting: Promise<CoreReady> | null = null

async function runEnsureCore(): Promise<CoreReady> {
  const file = await coreModelFile()
  if (!file) {
    return { ok: false, provider: null, message: '没有核心模型（core/Core.gguf 不存在），先点一次「简易核心」' }
  }
  const made = await ensureCoreProvider(file)
  if (!made.ok) return { ok: false, provider: null, message: made.message }

  // 只看「我们自己那条实例」，不要拿端口探：8080 上很可能跑着用户自己的模型，
  // 按端口判会把别人的服务当成核心模型，发过去模型名对不上
  const ours = llamaInstances().find((i) => i.key === CORE_PROVIDER_ID)
  // 实例表里有记录不代表还活着：statusLlama 会做真实端口探测，
  // 死掉/僵死的实例在这里被判成 idle 或 error，于是重新拉起 —— 而不是让请求打到死端口。
  let live = ours ? await statusLlama(CORE_PROVIDER_ID) : null
  if (!live || live.state === 'idle' || live.state === 'error') {
    // 体检只是为了让上下文开得合适；失败也不拦着启动。带投影器时一并算进预算
    const mmNext = path.join(path.dirname(file), CORE_MMPROJ_NAME)
    const hasMmNext = await fs.stat(mmNext).then((s) => s.size > 0).catch(() => false)
    const fit = await fitForLaunch(file, 0, await launchKvType(), hasMmNext ? mmNext : null).catch(() => null)
    const r = await startLlama(file, fit?.recommendedCtx ?? undefined, {
      providerId: CORE_PROVIDER_ID,
      // 专用端口：和用户自己的 llama.cpp 实例分开，避免两条配置指同一个地址
      port: CORE_PORT
    })
    if (!r.ok) {
      const tip = /llama-server\.exe/.test(r.message) ? '（兜底要用本机 llama.cpp，先点一次「简易核心」）' : ''
      return { ok: false, provider: null, message: r.message + tip, code: r.code }
    }
    live = await statusLlama(CORE_PROVIDER_ID)
  }
  // 等它真能应答：大模型首次加载要几十秒，这里给足时间
  const deadline = Date.now() + 90_000
  while (live.state === 'loading' && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 2000))
    live = await statusLlama(CORE_PROVIDER_ID)
  }
  if (live.state !== 'ready') {
    return {
      ok: false,
      provider: null,
      message: live.message,
      code: live.code
    }
  }
  const fresh = await coreProvider()
  return { ok: true, provider: fresh, message: '核心模型已就绪' }
}

/**
 * 保证核心模型此刻能接请求：没在跑就拉起来，并等它应答。
 * 并发调用共用同一个 Promise，不会重复起进程。
 */
export async function ensureCoreReady(): Promise<CoreReady> {
  if (coreStarting) return await coreStarting
  const task = runEnsureCore()
  coreStarting = task
  try {
    return await task
  } finally {
    if (coreStarting === task) coreStarting = null
  }
}
