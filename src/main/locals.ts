import { promises as fs, type Dirent } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { dialog, shell } from 'electron'
import type {
  LocalGgufFile,
  LocalRuntimeKind,
  LocalRuntimeStatus,
  ProviderConfig,
  SetupProgress
} from '../shared/types'
import { loadConfig, saveConfig } from './config'
import { headSize } from './dl'
import { modelfileTemplate, readGgufMeta } from './gguf'
import { localGgufFiles } from './llama'
import { scanOllamaDisk, isGgufFile, ollamaModelsRoot } from './ollamadir'
import { downloadResumable } from './resume'
import { mt } from './i18n'

/**
 * Ollama / LM Studio 的本机托管：和 llama.cpp 一样，
 * 检测「装了没 / 服务起没起 / 有哪些模型」，能替用户拉起服务、写配置、选模型。
 * 这两家都是常驻 HTTP 服务，不归本程序创建进程，所以只负责启停命令与探测。
 */

interface Spec {
  kind: LocalRuntimeKind
  label: string
  providerId: string
  providerName: string
  apiKey: string
  port: number
  /** 服务根地址（不带 /v1） */
  origin: string
  /** 解析模型 id */
  parseModels: (json: unknown) => string[]
  /** 可执行文件名（PATH 里找） */
  exe: string[]
  /** 图形主程序（LM Studio 的 CLI 起服务前要求主程序在运行） */
  appCandidates?: () => string[]
  /** 常见安装位置（PATH 里找不到时兜底） */
  candidates: () => string[]
  /** 启动服务的参数 */
  startArgs: string[]
  /** 装都没装时的提示 */
  installHint: string
  /** 常见位置都找不到时再扫一遍目录（LM Studio 的安装目录不固定） */
  discover?: () => Promise<string[]>
}

const parseOllama = (json: unknown): string[] => {
  const list = (json as { models?: Array<{ name?: string; model?: string }> })?.models ?? []
  return list.map((m) => m.name || m.model || '').filter(Boolean)
}

const parseOpenAI = (json: unknown): string[] => {
  const list = (json as { data?: Array<{ id?: string }> })?.data ?? []
  return list.map((m) => m.id ?? '').filter(Boolean)
}

const SPECS: Record<LocalRuntimeKind, Spec> = {
  ollama: {
    kind: 'ollama',
    label: 'Ollama',
    providerId: 'ollama',
    providerName: 'Ollama 本地',
    apiKey: 'ollama',
    port: 11434,
    origin: 'http://127.0.0.1:11434',
    parseModels: parseOllama,
    exe: ['ollama'],
    candidates: () => {
      const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
      return [
        path.join(local, 'Programs', 'Ollama', 'ollama.exe'),
        path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Ollama', 'ollama.exe')
      ]
    },
    startArgs: ['serve'],
    installHint: '未检测到 ollama 命令，请先安装 Ollama（安装包会自动把命令加到 PATH）'
  },
  lmstudio: {
    kind: 'lmstudio',
    label: 'LM Studio',
    providerId: 'lmstudio',
    providerName: 'LM Studio 本地',
    apiKey: 'lm-studio',
    port: 1234,
    origin: 'http://127.0.0.1:1234',
    parseModels: parseOpenAI,
    exe: ['lms'],
    candidates: () => {
      const home = os.homedir()
      const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
      return [
        path.join(home, '.lmstudio', 'bin', 'lms.exe'),
        path.join(home, '.cache', 'lm-studio', 'bin', 'lms.exe'),
        path.join(local, 'LM-Studio', 'lms.exe'),
        path.join(local, 'Programs', 'lm-studio', 'lms.exe'),
        path.join(local, 'Programs', 'LM Studio', 'lms.exe'),
        // 新版安装包改名 Bionic，装到这里
        path.join(local, 'Programs', 'Bionic', 'lms.exe'),
        path.join(local, 'Bionic', 'lms.exe')
      ]
    },
    discover: async () => {
      const home = os.homedir()
      const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
      return scanFor(['lms.exe'], [
        path.join(home, '.lmstudio'),
        path.join(local, 'LM-Studio'),
        path.join(local, 'Programs')
      ], 3)
    },
    appCandidates: () => {
      const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
      return [
        // 1.x 起安装包改名 Bionic，主程序也叫 Bionic.exe
        path.join(local, 'Programs', 'Bionic', 'Bionic.exe'),
        path.join(local, 'Programs', 'LM Studio', 'LM Studio.exe'),
        path.join(local, 'LM-Studio', 'LM Studio.exe'),
        path.join(local, 'lm-studio', 'LM Studio.exe')
      ]
    },
    startArgs: ['server', 'start'],
    installHint: '未检测到 lms 命令：请先安装 LM Studio（1.x 的安装包叫 Bionic）'
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** 在若干根目录下按层数找指定文件名（只看几层，不会把整个磁盘翻一遍） */
async function scanFor(names: string[], roots: string[], depth: number): Promise<string[]> {
  const wanted = new Set(names.map((n) => n.toLowerCase()))
  const out: string[] = []
  const walk = async (dir: string, left: number): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isFile()) {
        if (wanted.has(e.name.toLowerCase())) out.push(full)
      } else if (e.isDirectory() && left > 0) {
        await walk(full, left - 1)
      }
    }
  }
  for (const root of roots) await walk(root, depth)
  return out
}

/** 找 CLI：先看常见安装位置，再扫 PATH（便携版不一定继承用户 PATH），最后才扫目录 */
async function findCli(spec: Spec): Promise<string | null> {
  const seen = new Set<string>()
  for (const cand of spec.candidates()) {
    seen.add(cand.toLowerCase())
    if (await exists(cand)) return cand
  }
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const name of spec.exe) {
      for (const ext of exts) {
        const p = path.join(dir, name + ext.toLowerCase())
        if (await exists(p)) return p
      }
    }
  }
  if (spec.discover) {
    for (const p of await spec.discover()) {
      if (!seen.has(p.toLowerCase()) && (await exists(p))) return p
    }
  }
  return null
}

/** 找 LM Studio 的图形主程序（CLI 起服务前它必须在运行） */
async function findAppExe(spec: Spec): Promise<string | null> {
  for (const p of spec.appCandidates?.() ?? []) {
    if (await exists(p)) return p
  }
  return null
}

/**
 * 子进程环境。
 *
 * 必须抹掉 ELECTRON_RUN_AS_NODE：LM Studio 主程序（Bionic.exe）是 Electron 应用，
 * 一旦继承这个变量就会以纯 Node 模式跑一下就退出，`lms server start` 随即报
 * “no valid installation” / “No running LM Studio or Bionic app”，服务永远起不来。
 * 从带这个变量的终端（不少开发环境会设）启动本程序时就会踩到。
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

/** 拉起一个进程就撒手（GUI 或常驻服务），不接管它的生命周期 */
function launchDetached(exe: string, args: string[]): void {
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.dirname(exe),
    env: childEnv()
  })
  child.unref()
}

interface Probe {
  ok: boolean
  models: string[]
  error?: string
  /** 实际生效的根地址与端口（LM Studio 可能不在默认端口上） */
  origin: string
  port: number
}

const portOf = (origin: string): number => Number(new URL(origin).port)

/** 缓存在 5 秒内复用：启动时每 1.2 秒轮询一次，别每次都拉一个进程 */
let lmsPortCache: { port: number; at: number } | null = null

/**
 * LM Studio 的真实端口。
 * 1234 被别的程序占着、或用户在 LM Studio 里改过端口时，服务会起在别的端口（实测本机是 1235），
 * 只看 1234 就会「启动失败」。`lms server status --json` 会直接报 `{"running":true,"port":1235}`。
 */
async function lmstudioPort(): Promise<number | null> {
  if (lmsPortCache && Date.now() - lmsPortCache.at < 5000) return lmsPortCache.port
  const cli = await findCli(SPECS.lmstudio)
  if (!cli) return null
  const r = await runCli(cli, ['server', 'status', '--json'], 8000)
  if (r.code !== 0) return null
  try {
    const line = r.out.trim().split(/\r?\n/).filter(Boolean).pop() ?? '{}'
    const j = JSON.parse(line) as { running?: boolean; port?: number }
    if (j.running && j.port) {
      lmsPortCache = { port: j.port, at: Date.now() }
      return j.port
    }
  } catch {
    // 输出不是预期 JSON，就按默认端口处理
  }
  return null
}

async function probeOrigin(spec: Spec, origin: string): Promise<Probe> {
  const url = `${origin}${spec.kind === 'lmstudio' ? '/v1/models' : '/api/tags'}`
  const port = portOf(origin)
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return { ok: false, models: [], origin, port, error: `HTTP ${res.status}` }
    return { ok: true, models: spec.parseModels(await res.json()), origin, port }
  } catch (err) {
    return { ok: false, models: [], origin, port, error: (err as Error).message }
  }
}

/**
 * LM Studio 自己记录的端口。服务没开时 `lms server status` 不报端口，
 * 但它的配置里存着（默认 1234，用户改过就是改过的值，实测本机是 1235）。
 * 读它可以让「服务还没启动」时写进配置的 Base URL 也是对的。
 */
async function lmstudioConfiguredPort(): Promise<number | null> {
  const home = os.homedir()
  const files = [
    path.join(home, '.lmstudio', 'apps', 'bionic', '.internal', 'http-server-config.json'),
    path.join(home, '.lmstudio', '.internal', 'http-server-config.json')
  ]
  for (const f of files) {
    try {
      const j = JSON.parse(await fs.readFile(f, 'utf8')) as { port?: number }
      if (j.port && j.port > 0 && j.port < 65536) return j.port
    } catch {
      // 文件不存在或不是 JSON：试下一个
    }
  }
  return null
}

/** 探测顺序：默认端口 → lms 自报的端口 → 配置里写的端口 */
async function probe(spec: Spec, opts?: { skipCli?: boolean }): Promise<Probe> {
  if (spec.kind !== 'lmstudio') return probeOrigin(spec, spec.origin)

  const ports = [spec.port]
  // skipCli：只读文件 + 发 HTTP（毫秒级）。界面加载路径用它，避免为了问端口去拉一个进程
  const live = opts?.skipCli ? null : await lmstudioPort()
  if (live) ports.push(live)
  const configured = await lmstudioConfiguredPort()
  if (configured) ports.push(configured)

  let fallback: Probe | null = null
  for (const port of Array.from(new Set(ports))) {
    const r = await probeOrigin(spec, `http://127.0.0.1:${port}`)
    if (r.ok) return r
    fallback = fallback ?? r
  }

  // 全都没通：地址仍指向它配置的端口，这样服务一起来就能直接用
  const preferred = ports[ports.length - 1]
  return {
    ok: false,
    models: [],
    origin: `http://127.0.0.1:${preferred}`,
    port: preferred,
    error: fallback?.error
  }
}

/** 真实根地址的短期缓存：探测每几秒跑一次，不必每次都发 HTTP / 拉进程 */
const originCache = new Map<LocalRuntimeKind, { origin: string; at: number }>()

/**
 * 本地运行时的真实根地址（含真实端口）。
 *
 * 存在的意义：配置里可能存着过期端口（LM Studio 默认 1234，被占用时它自己换到 1235），
 * 直接拿配置去请求就会一直是「不可用」。任何要用本地地址的地方都应该先问这里。
 */
export async function localOrigin(kind: LocalRuntimeKind): Promise<string> {
  const hit = originCache.get(kind)
  if (hit && Date.now() - hit.at < 15000) return hit.origin
  const p = await probe(SPECS[kind], { skipCli: true })
  originCache.set(kind, { origin: p.origin, at: Date.now() })
  return p.origin
}

/** 已经加载进显存的模型（Ollama 看 /api/ps，LM Studio 看 state=loaded） */
export async function loadedModels(kind: LocalRuntimeKind): Promise<string[]> {
  const origin = await localOrigin(kind).catch(() => '')
  if (!origin) return []
  try {
    if (kind === 'ollama') {
      const res = await fetch(`${origin}/api/ps`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) return []
      const j = (await res.json()) as { models?: Array<{ name?: string; model?: string }> }
      return (j.models ?? []).map((m) => m.name || m.model || '').filter(Boolean)
    }
    const res = await fetch(`${origin}/api/v0/models`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return []
    const j = (await res.json()) as { data?: Array<{ id?: string; state?: string }> }
    return (j.data ?? [])
      .filter((m) => m.state === 'loaded')
      .map((m) => m.id ?? '')
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 把某个运行时里已加载的模型全部卸掉，释放显存。
 *
 * 显卡只有 8 GB 时，LM Studio 里放一个 7B、Ollama 里再放一个 7B 会直接爆显存，
 * 所以切换模型时必须主动卸载「这次用不到的那一边」，不能指望用户自己去点。
 */
export async function unloadRuntime(
  kind: LocalRuntimeKind
): Promise<{ ok: boolean; released: string[]; message: string }> {
  const spec = SPECS[kind]
  const models = await loadedModels(kind)
  if (!models.length) return { ok: true, released: [], message: `${spec.label} 当前没有加载模型` }

  const cli = await findCli(spec)
  if (!cli) {
    return { ok: false, released: [], message: `找不到 ${spec.label} 的命令行，无法卸载它的模型` }
  }

  try {
    if (kind === 'lmstudio') {
      // --all 一次性卸掉，避免逐个触发交互选择
      const r = await runCli(cli, ['unload', '--all'], 60000)
      if (r.code !== 0) {
        return { ok: false, released: [], message: `卸载 ${spec.label} 模型失败：${tailOf(r.out) || r.error || '未知原因'}` }
      }
    } else {
      for (const m of models) {
        // ollama stop 会把模型移出显存；已经不在的直接忽略
        await runCli(cli, ['stop', m], 30000)
      }
    }
  } catch (err) {
    return { ok: false, released: [], message: `卸载 ${spec.label} 模型失败：${(err as Error).message}` }
  }

  // 卸载是异步生效的，等一下再确认，别把「还在退」当成失败
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    if ((await loadedModels(kind)).length === 0) {
      return { ok: true, released: models, message: `已卸载 ${spec.label} 的 ${models.join('、')}` }
    }
  }
  const left = await loadedModels(kind)
  return {
    ok: left.length < models.length,
    released: models.filter((m) => !left.includes(m)),
    message: left.length ? `${spec.label} 仍有模型在显存里：${left.join('、')}` : `已卸载 ${spec.label} 的模型`
  }
}

export async function localStatus(kind: LocalRuntimeKind): Promise<LocalRuntimeStatus> {
  const spec = SPECS[kind]
  if (!spec) {
    return {
      kind,
      label: kind,
      providerId: kind,
      baseUrl: '',
      installed: false,
      running: false,
      models: [],
      message: '不支持的本地服务'
    }
  }
  const [cli, p] = await Promise.all([findCli(spec), probe(spec)])
  const message = p.ok
    ? `${spec.label} 服务运行中（端口 ${p.port}），已安装 ${p.models.length} 个模型`
    : cli
      ? `已安装 ${spec.label}，服务未启动`
      : spec.installHint
  return {
    kind,
    label: spec.label,
    providerId: spec.providerId,
    baseUrl: `${p.origin}/v1`,
    installed: Boolean(cli),
    cliPath: cli ?? undefined,
    running: p.ok,
    port: p.ok ? p.port : undefined,
    models: p.models,
    message
  }
}

/** 拉起服务（已在跑就直接返回），最多等 25 秒 */
export async function startLocal(
  kind: LocalRuntimeKind
): Promise<{ ok: boolean; message: string; models?: string[] }> {
  const spec = SPECS[kind]
  if (!spec) return { ok: false, message: '不支持的本地服务' }

  const first = await probe(spec)
  if (first.ok) {
    return {
      ok: true,
      models: first.models,
      message: `${spec.label} 已在运行（端口 ${first.port}）`
    }
  }

  const cli = await findCli(spec)
  if (!cli) return { ok: false, message: spec.installHint }

  let pre = ''
  let cliError = ''
  try {
    if (kind === 'lmstudio') {
      // `lms server start` 会很快返回，输出里直接写着失败原因，比干等 25 秒有用得多。
      // 已知坑：主程序没在运行时它只会报 “No running LM Studio or Bionic app”，
      // 这时先把主程序拉起来（用户没开也能用），再重试一次。
      let run = await runCli(cli, spec.startArgs, 45000)
      if (run.code !== 0 && /no running|failed to connect to a local app/i.test(`${run.out} ${run.error ?? ''}`)) {
        const app = await findAppExe(spec)
        if (app) {
          pre = 'LM Studio 主程序没在运行，已帮你启动它（首次启动要十几秒）'
          launchDetached(app, [])
          await sleep(9000)
          run = await runCli(cli, spec.startArgs, 45000)
        }
      }
      if (run.code !== 0) cliError = tailOf(run.out) || run.error || ''
    } else {
      launchDetached(cli, spec.startArgs)
    }
  } catch (err) {
    return { ok: false, message: `启动失败：${(err as Error).message}` }
  }

  // LM Studio 刚拉起主程序时启动更慢，多等一会儿
  const deadline = Date.now() + (kind === 'lmstudio' ? 45000 : 25000)
  while (Date.now() < deadline) {
    await sleep(1200)
    const p = await probe(spec)
    if (p.ok) {
      return {
        ok: true,
        models: p.models,
        message: `${
          kind === 'lmstudio'
            ? `LM Studio 服务已启动（端口 ${p.port}），已加载 ${p.models.length} 个模型`
            : `Ollama 服务已启动（端口 ${p.port}），已安装 ${p.models.length} 个模型`
        }${pre ? `。${pre}` : ''}`
      }
    }
  }

  const now = await probe(spec)
  const portHint =
    kind === 'lmstudio' ? `默认 ${spec.port}，被占用时它会自己换端口` : `${spec.port}`

  if (now.ok) {
    return {
      ok: false,
      message: `${spec.label} 已就绪（端口 ${now.port}），但模型列表没读出来：${now.error ?? '未知原因'}`
    }
  }

  // 这条是 LM Studio 自己安装状态的问题：主程序文件在，但它的 CLI 认不出来（常见于升级中断/改名后）
  if (kind === 'lmstudio' && /no valid installation/i.test(cliError)) {
    return {
      ok: false,
      message: `LM Studio 的安装没被它自己的命令行识别（主程序在，但 lms 报 “no valid installation”），这种状态 CLI 起不了服务。建议点上面的「一键安装 / 下载」重装一次；不重装的话，直接用 llama.cpp 方式运行同一个模型也可以。`
    }
  }

  return {
    ok: false,
    message: `${
      cliError
        ? `启动 ${spec.label} 失败：${cliError}`
        : `已执行启动命令，但没等到 ${spec.label} 服务就绪（端口 ${portHint}）`
    }。${
      kind === 'lmstudio'
        ? '可以先手动打开 LM Studio，在 Developer 面板点「Start Server」，回来再点本按钮。'
        : '请检查 Ollama 是否运行正常。'
    }`
  }
}

/** 写入（或新建）对应供应商配置，并设为当前使用 */
export async function configureLocal(
  kind: LocalRuntimeKind,
  model?: string
): Promise<{ ok: boolean; message: string; model?: string; providerId?: string; created?: boolean }> {
  const spec = SPECS[kind]
  if (!spec) return { ok: false, message: '不支持的本地服务' }

  // 先探一次：LM Studio 的端口可能不是默认的 1234，Base URL 要跟着真实端口走
  const live = await probe(spec)

  const config = await loadConfig()
  const providers: ProviderConfig[] = config.providers.map((p) => ({ ...p }))
  let target = providers.find((p) => p.id === spec.providerId)
  const created = !target
  if (!target) {
    target = {
      id: spec.providerId,
      name: spec.providerName,
      kind: 'ollama',
      baseUrl: `${live.origin}/v1`,
      apiKey: spec.apiKey,
      model: model ?? '',
      contextWindow: 32768,
      temperature: 0.2
    }
    providers.push(target)
  } else {
    target.baseUrl = `${live.origin}/v1`
    target.kind = 'ollama'
    if (!target.apiKey) target.apiKey = spec.apiKey
    if (model) target.model = model
  }

  // 没指定模型时挑本机已装的第一个，避免条目永远是「未选择模型」
  if (!target.model) {
    const p = await probe(spec)
    if (p.models[0]) target.model = p.models[0]
  }

  await saveConfig({ ...config, providers, activeId: target.id })
  const label = target.model || '未选择模型'
  return {
    ok: true,
    message: created ? `已新建本地模型：${label}` : model ? `已更新本地模型：${label}` : `本地模型已就绪：${label}`,
    model: target.model || undefined,
    providerId: target.id,
    created
  }
}

/** ollama pull：后台下载，完成后刷新面板即可看到 */
export async function pullOllama(name: string): Promise<{ ok: boolean; message: string }> {
  const spec = SPECS.ollama
  const model = name.trim()
  if (!model) return { ok: false, message: '请填写模型名，如 qwen2.5-coder:7b' }
  const cli = await findCli(spec)
  if (!cli) return { ok: false, message: spec.installHint }
  try {
    const child = spawn(cli, ['pull', model], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: path.dirname(cli)
    })
    child.unref()
    return {
      ok: true,
      message: `已在后台拉取 ${model}（体积通常 4~5 GB，耗时取决于网速），完成后点「刷新」查看`
    }
  } catch (err) {
    return { ok: false, message: `拉取失败：${(err as Error).message}` }
  }
}

/**
 * 一键安装 / 下载：和 llama.cpp 的「一键安装 / 下载」对齐。
 * Ollama 有稳定直链，官方直链失败会自动换 GitHub 镜像（下的是同一个官方安装包）；
 * LM Studio 的安装包叫 Bionic，靠 `lmstudio.ai/download/bionic/latest/...` 302 到当前版本 CDN，
 * 没有国内镜像，所以失败时退回 winget。
 * 这里列出的源和界面「下载地址」面板一致，方便用户自己手动下。
 */
interface SetupPlan {
  /** 保存到临时目录用的文件名 */
  file: string
  /** 网页入口：全部都下不动时打开它 */
  page: string
  /** 安装包候选：官方直链在前，镜像在后，按顺序回退 */
  urls: Array<{ label: string; url: string }>
  /** 有的地址要现场解析（比如 LM Studio 的 latest 会 302 到带版本号的 CDN 直链） */
  resolve?: () => Promise<Array<{ label: string; url: string }>>
}

const OLLAMA_GH_SETUP = 'https://github.com/ollama/ollama/releases/latest/download/OllamaSetup.exe'

/**
 * LM Studio 现在的安装包叫 Bionic，且没有单独的 `installers.../latest` 入口了。
 * 这条 latest 会 302 到当前版本的 CDN 直链（实测 783 MB），永远指向最新版。
 */
const LMSTUDIO_LATEST = 'https://lmstudio.ai/download/bionic/latest/win32/x64'

/** 跟一次 302，拿到带版本号的直链；失败就算了，不影响主流程 */
async function followOnce(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(15000)
    })
    const loc = res.headers.get('location')
    return loc ? new URL(loc, url).toString() : null
  } catch {
    return null
  }
}

/** 用 winget 兜底安装：不需要用户点向导，但拿不到下载进度 */
function wingetInstall(id: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        'winget',
        [
          'install',
          '--id',
          id,
          '-e',
          '--silent',
          '--accept-package-agreements',
          '--accept-source-agreements'
        ],
        { windowsHide: true, stdio: 'ignore' }
      )
    } catch (err) {
      resolve({ ok: false, message: (err as Error).message })
      return
    }
    const timer = setTimeout(
      () => {
        child.kill()
        resolve({ ok: false, message: 'winget 安装超时（20 分钟）' })
      },
      20 * 60 * 1000
    )
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, message: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        ok: code === 0,
        message: code === 0 ? 'winget 安装完成' : `winget 退出码 ${code}`
      })
    })
  })
}

const SETUP: Record<LocalRuntimeKind, SetupPlan> = {
  ollama: {
    file: 'OllamaSetup.exe',
    page: 'https://ollama.com/download/windows',
    urls: [
      { label: '官方直链', url: 'https://ollama.com/download/OllamaSetup.exe' },
      { label: 'gh-proxy 镜像', url: `https://gh-proxy.com/${OLLAMA_GH_SETUP}` },
      { label: 'ghproxy.net 镜像', url: `https://ghproxy.net/${OLLAMA_GH_SETUP}` }
    ]
  },
  lmstudio: {
    file: 'LM-Studio-Setup.exe',
    page: 'https://lmstudio.ai/download',
    urls: [{ label: '官方直链（最新版）', url: LMSTUDIO_LATEST }],
    resolve: async () => {
      const list = [{ label: '官方直链（最新版）', url: LMSTUDIO_LATEST }]
      const direct = await followOnce(LMSTUDIO_LATEST)
      if (direct && direct !== LMSTUDIO_LATEST) {
        list.push({ label: '官方 CDN 直链', url: direct })
      }
      return list
    }
  }
}

/** 当前正在下载的安装包，用于「取消下载」 */
let setupAbort: AbortController | null = null

/** 取消安装包下载（用户点了进度条上的取消） */
export function cancelLocalInstall(): boolean {
  if (!setupAbort) return false
  setupAbort.abort()
  setupAbort = null
  return true
}

export async function installLocal(
  kind: LocalRuntimeKind,
  onProgress?: (p: SetupProgress) => void
): Promise<{ ok: boolean; message: string; path?: string; launched?: boolean }> {
  const spec = SPECS[kind]
  const setup = SETUP[kind]

  // 理论上每个运行时都有源；真没有就开网页，别假装在下东西
  const urls = setup.resolve ? await setup.resolve() : setup.urls
  if (!urls.length) {
    try {
      await shell.openExternal(setup.page)
      return {
        ok: true,
        launched: true,
        message: `已在浏览器打开 ${spec.label} 官方下载页。装完回来点「检测状态」即可。`
      }
    } catch (err) {
      return { ok: false, message: `打开下载页失败：${(err as Error).message}` }
    }
  }

  const dir = path.join(os.tmpdir(), 'roro-setup')
  const target = path.join(dir, setup.file)

  // 安装包动辄 1 GB 以上，先问一句再下，别让人误触烧流量
  const size = await headSize(urls[0].url)
  const sizeMb = size > 0 ? Math.round(size / 1024 / 1024) : 0
  const ask = await dialog.showMessageBox({
    type: 'question',
    buttons: [mt('下载并安装'), mt('打开官网'), mt('取消')],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: mt('安装 {label}', { label: spec.label }),
    message: sizeMb > 0
      ? mt('将下载 {label} 官方安装包（约 {size} MB）', { label: spec.label, size: sizeMb })
      : mt('将下载 {label} 官方安装包', { label: spec.label }),
    detail:
      urls.length > 1
        ? mt('下载失败会自动换源（共 {n} 个：{list}）。安装包放在系统临时目录，不会占用软件目录。', {
            n: urls.length,
            list: urls.map((u) => u.label).join(' → ')
          })
        : mt('{label} 只有官方 CDN 一个下载源（国内无镜像）。安装包放在系统临时目录，下载失败时可改用 winget 自动安装。', {
            label: spec.label
          })
  })
  if (ask.response === 1) {
    await shell.openExternal(setup.page).catch(() => undefined)
    return { ok: false, message: `已打开 ${spec.label} 官方下载页，可手动下载安装。` }
  }
  if (ask.response === 2) return { ok: false, message: '已取消安装' }

  await fs.mkdir(dir, { recursive: true }).catch(() => undefined)
  let used = ''
  const failures: string[] = []
  const abort = new AbortController()
  setupAbort = abort

  try {
    onProgress?.({
      kind,
      receivedBytes: 0,
      totalBytes: size > 0 ? size : 0,
      state: 'downloading',
      source: urls[0].label,
      file: setup.file,
      message: `正在下载 ${setup.file}…`
    })
    // 多个源共用同一个目标文件：中途断流换源时用 Range 续传，不会从头再来
    const r = await downloadResumable(
      urls.map((u) => ({ label: u.label, url: u.url })),
      target,
      {
        signal: abort.signal,
        headerMs: 20 * 1000,
        idleMs: 45 * 1000,
        // 安装包可能七八百 MB，慢网要下两小时，别被总超时砍掉
        totalMs: 4 * 60 * 60 * 1000,
        minBytes: 1024 * 1024,
        onTick: (t) =>
          onProgress?.({
            kind,
            receivedBytes: t.received,
            totalBytes: t.total,
            bytesPerSec: t.speed,
            state: 'downloading',
            source: t.source,
            file: setup.file,
            message: t.resumed && t.received > 0 ? `从 ${(t.received / 1024 / 1024).toFixed(0)} MB 处续传` : undefined
          })
      }
    )
    used = r.label
  } catch (err) {
    if (!abort.signal.aborted) failures.push((err as Error).message)
  }

  const cancelled = abort.signal.aborted
  setupAbort = null

  if (cancelled) {
    // 已下载部分保留，重新点「一键安装」会从断点继续
    const kept = fs.stat(target).then((s) => s.size).catch(() => 0)
    const mb = ((await kept) / 1024 / 1024).toFixed(0)
    onProgress?.({
      kind,
      receivedBytes: 0,
      totalBytes: 0,
      state: 'error',
      message: `已取消下载（已保留 ${mb} MB，下次从断点继续）`
    })
    return { ok: false, message: `已取消下载（已保留 ${mb} MB，重新点击会从断点继续）。` }
  }

  if (!used) {
    onProgress?.({
      kind,
      receivedBytes: 0,
      totalBytes: 0,
      state: 'error',
      message: '所有下载源都失败'
    })

    // 官方 CDN 下不动时，winget 走的是另一条链路，值得试一把
    const alt = await dialog.showMessageBox({
      type: 'warning',
      buttons: [mt('用 winget 自动安装'), mt('打开官网'), mt('取消')],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: mt('{label} 下载失败', { label: spec.label }),
      message: mt('安装包没下下来'),
      detail:
        `${failures.join('\n')}\n\n` +
        mt('可以改用 winget 自动安装（系统自带，会自己下载，但不显示进度），或者打开官网手动下载。')
    })
    if (alt.response === 0) {
      onProgress?.({
        kind,
        receivedBytes: 0,
        totalBytes: 0,
        state: 'downloading',
        source: 'winget',
        message: '正在通过 winget 安装，这一步不显示进度，通常要几分钟…'
      })
      const r = await wingetInstall('ElementLabs.LMStudio')
      onProgress?.({
        kind,
        receivedBytes: 0,
        totalBytes: 0,
        state: r.ok ? 'done' : 'error',
        message: r.message
      })
      return {
        ok: r.ok,
        message: r.ok
          ? 'winget 已装好 LM Studio。装完首次启动一次（它会生成 lms 命令），再回来点「检测状态」。'
          : `winget 也没成功（${r.message}），已打开官网，可手动下载安装。`
      }
    }
    await shell.openExternal(setup.page).catch(() => undefined)
    return {
      ok: false,
      message: `所有下载源都失败（${failures.join('；')}）。已打开官方下载页，也可以展开卡片里的「下载地址」手动下载。`
    }
  }

  onProgress?.({ kind, receivedBytes: 0, totalBytes: 0, state: 'done' })

  // 安装包落在了系统临时目录，启动它按向导装
  const openErr = await shell.openPath(target)
  if (openErr) {
    await shell.openExternal(setup.page).catch(() => undefined)
    return {
      ok: false,
      path: target,
      message: `安装包已从${used}下载到 ${target}，但启动安装程序失败（${openErr}），可手动双击安装。`
    }
  }
  return {
    ok: true,
    path: target,
    launched: true,
    message: `安装包已从${used}下载（${target}）并启动安装程序，按向导装完后回到这里点「检测状态」。`
  }
}

/* ------------------------------------------------------------------ *
 * 复用本程序已下载的 GGUF：导入到 Ollama / LM Studio
 *
 * 为什么不直接让它们读 models/ 目录：
 *   Ollama 的模型是「manifest + blob」，必须 `ollama create` 写进自己的库；
 *   LM Studio 只把登记在模型目录里的文件暴露给 /v1/models。
 * 两个 CLI 都支持从本地文件导入，所以不需要重新下载几个 GB：
 *   Ollama     → 临时 Modelfile（FROM 本地绝对路径 + 从 GGUF 读出的 chat 模板）+ ollama create
 *   LM Studio  → lms import --hard-link（同盘零拷贝；跨盘退回复制）
 * ------------------------------------------------------------------ */

/** 把 GGUF 名字转成合法模型名：小写、只留 [a-z0-9._-]，全中文名时加短哈希防撞车 */
function modelSlug(file: string, label?: string): string {
  // Ollama blob 的文件名是 sha256-xxxx，拿它命名会得到一串哈希；有别名就用别名
  const base = label?.trim() || path.basename(file).replace(/\.gguf$/i, '')
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 60)
  if (slug) return slug
  let h = 5381
  for (let i = 0; i < base.length; i++) h = ((h << 5) + h + base.charCodeAt(i)) >>> 0
  return `model-${h.toString(16).slice(0, 6)}`
}

/** 目录所在磁盘的可用字节；目录不存在就往上找，实在拿不到返回 0 */
async function freeSpaceAt(dir: string): Promise<number> {
  let d = path.resolve(dir)
  for (let i = 0; i < 4; i++) {
    try {
      const st = await fs.statfs(d)
      return Number(st.bavail) * Number(st.bsize)
    } catch {
      const up = path.dirname(d)
      if (up === d) break
      d = up
    }
  }
  return 0
}

/** 体积文案：大于 1 GB 按 GB，否则按 MB（模型小的时候不会出现「0.0 GB」） */
const gb = (n: number) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} GB`
    : `${Math.max(1, Math.round(n / 1024 / 1024))} MB`

/** 跑一个 CLI 并收集输出；超时直接杀掉，避免界面一直转圈 */
function runCli(
  cli: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; out: string; error?: string }> {
  return new Promise((resolve) => {
    let done = false
    const finish = (r: { code: number | null; out: string; error?: string }): void => {
      if (done) return
      done = true
      resolve(r)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cli, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // lms 会再去拉起 LM Studio 主程序，环境要干净
        env: childEnv()
      })
    } catch (err) {
      finish({ code: null, out: '', error: (err as Error).message })
      return
    }

    let out = ''
    const take = (b: Buffer): void => {
      out += b.toString('utf8')
      if (out.length > 40000) out = out.slice(-40000)
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 杀不掉也没关系，下面照样返回超时
      }
      finish({ code: null, out, error: `命令执行超时（${Math.round(timeoutMs / 1000)} 秒）` })
    }, timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ code: null, out, error: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ code, out })
    })
  })
}

/** CLI 的输出通常最后一行才是原因，取尾部几行给用户看 */
function tailOf(s: string, lines = 3): string {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\d+%$/.test(l))
    .slice(-lines)
    .join(' ')
    .slice(0, 300)
}

/** 本程序模型目录里可导入的 .gguf */
export async function listImportableGgufs(): Promise<{
  ok: boolean
  files: LocalGgufFile[]
  message?: string
}> {
  const all = await localGgufFiles()
  const files: LocalGgufFile[] = all.map((f) => ({
    path: f.path,
    name: f.name,
    sizeBytes: f.sizeBytes,
    rel: f.rel,
    source: 'local' as const
  }))
  /**
   * 顺带把「Ollama 里已经下好的模型」也列出来。
   *
   * 它们的 blob 没有 .gguf 后缀，按扩展名扫盘永远扫不到，所以只能离线解析
   * Ollama 的 manifests。价值很直接：用户为了试 Ollama 下过的 4~28G 模型，
   * 不用再下一遍就能搬过来用。旧的 GGML blob（不是 GGUF）不列，免得导入了也起不来。
   */
  const ollama = await scanOllamaDisk().catch(() => null)
  for (const m of ollama?.models ?? []) {
    if (!m.gguf) continue
    files.push({
      path: m.blob,
      name: `${m.name} · Ollama`,
      sizeBytes: m.sizeBytes,
      rel: m.blob,
      source: 'ollama'
    })
  }
  files.sort((a, b) => b.sizeBytes - a.sizeBytes)
  const extra = files.length - all.length
  return {
    ok: true,
    files,
    message: files.length
      ? `找到 ${files.length} 个本地 GGUF${extra > 0 ? `（其中 ${extra} 个来自 Ollama）` : ''}`
      : '还没有下载过模型。先在「模型」里下载一个，或用下面的输入框拉取。'
  }
}

/** Ollama：写 Modelfile → ollama create（模型会被复制进 ~/.ollama/models） */
async function importToOllama(abs: string, label?: string): Promise<{ ok: boolean; message: string; model?: string }> {
  const spec = SPECS.ollama
  const cli = await findCli(spec)
  if (!cli) return { ok: false, message: spec.installHint }

  // `ollama create` 要连上服务才能用：没在跑就先替用户拉起来，省得只报「连接被拒绝」
  if (!(await probe(spec)).ok) {
    const s = await startLocal('ollama')
    if (!s.ok) return { ok: false, message: `${s.message}（导入需要 Ollama 服务在运行）` }
  }

  const st = await fs.stat(abs)
  const storeDir = process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models')
  const free = await freeSpaceAt(storeDir)
  if (free > 0 && free < st.size * 1.05 + 1024 ** 3) {
    return {
      ok: false,
      message: `Ollama 的模型库只剩 ${gb(free)}，导入要在库里再存一份（约 ${gb(
        st.size
      )}），空间不够。可先清理 Ollama 里不用的模型，或直接改用 llama.cpp 方式。`
    }
  }

  const meta = await readGgufMeta(abs)
  const name = `roro-${modelSlug(abs, label)}`
  const tpl = modelfileTemplate(meta.chatTemplate)
  const from = `FROM ${abs.replace(/\\/g, '/')}`

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roro-modelfile-')).catch(() => '')
  if (!dir) return { ok: false, message: '无法创建临时目录，导入中止' }
  const mf = path.join(dir, 'Modelfile')

  let note = ''
  try {
    // 先带着 GGUF 里的对话模板建一次：新版 Ollama 如果能认，效果最好
    await fs.writeFile(mf, tpl ? `${from}\n${tpl}\n` : `${from}\n`, 'utf8')
    let r = await runCli(cli, ['create', name, '-f', mf], 15 * 60 * 1000)

    // Ollama 的 TEMPLATE 是 Go 模板语法，而 GGUF 里存的是 Jinja（`{% for %}`、`message['role']`），
    // 直接塞进去会被判 template error。去掉模板重试一次，至少模型能用。
    if (r.code !== 0 && tpl && /template/i.test(r.out)) {
      await fs.writeFile(mf, `${from}\n`, 'utf8')
      r = await runCli(cli, ['create', name, '-f', mf], 15 * 60 * 1000)
      if (r.code === 0) {
        note =
          '。注意：Ollama 不认这个 GGUF 里的 Jinja 对话模板，已退回它自带的默认模板，多轮对话格式可能不标准；' +
          '要最稳妥的效果，建议直接选 llama.cpp 方式运行同一个模型'
      }
    }
    if (r.code !== 0) {
      const raw = `${r.out} ${r.error ?? ''}`
      if (/could not connect|connection refused|ollama app|econnrefused|12029/i.test(raw)) {
        return { ok: false, message: 'Ollama 服务没连上：先点卡片上的「启动服务」，再回来导入。' }
      }
      return { ok: false, message: `导入 Ollama 失败：${r.error || tailOf(r.out) || '未知原因'}` }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }

  const p = await probe(spec)
  const hit = p.models.find((m) => m.toLowerCase() === name || m.toLowerCase().startsWith(`${name}:`))
  const noTpl = !tpl ? '。这个 GGUF 里没有对话模板，会用 Ollama 默认模板' : ''
  return {
    ok: true,
    model: hit ?? name,
    message: `已导入为 Ollama 模型 ${hit ?? name}（在 Ollama 库里多占约 ${gb(st.size)}）${note}${noTpl}`
  }
}

/** LM Studio：lms import --hard-link（同盘不拷贝），跨盘失败时退回复制 */
async function importToLmStudio(
  abs: string,
  label?: string
): Promise<{ ok: boolean; message: string; model?: string }> {
  const spec = SPECS.lmstudio
  const cli = await findCli(spec)
  if (!cli) return { ok: false, message: spec.installHint }

  const slug = modelSlug(abs, label)
  const repo = `roro/${slug}`
  const common = ['import', '--user-repo', repo, '-y']

  let r = await runCli(cli, [...common, '--hard-link', abs], 10 * 60 * 1000)
  let via = '硬链接，不额外占空间'

  if (r.code !== 0) {
    // 模型在 D 盘、LM Studio 库在 C 盘时硬链接建不了（EXDEV），只能复制
    const st = await fs.stat(abs).catch(() => null)
    const free = await freeSpaceAt(path.join(os.homedir(), '.lmstudio', 'models'))
    if (st && free > 0 && free < st.size + 1024 ** 3) {
      return {
        ok: false,
        message: `硬链接失败（模型和 LM Studio 库不在同一个盘），改成复制又放不下：需要约 ${gb(
          st.size
        )}，只剩 ${gb(free)}。`
      }
    }
    r = await runCli(cli, [...common, '--copy', abs], 10 * 60 * 1000)
    via = '复制（跨盘无法硬链接，多占一份空间）'
  }

  if (r.code !== 0) {
    return { ok: false, message: `导入 LM Studio 失败：${r.error || tailOf(r.out) || '未知原因'}` }
  }

  const p = await probe(spec)
  const found = p.models.find((m) => m.toLowerCase().includes(slug))
  const hit = found ?? repo
  return {
    ok: true,
    model: hit,
    message: `已导入 LM Studio：${hit}（${via}）${
      found ? '' : '；模型列表还没刷新，点一次「启动服务」即可看到'
    }`
  }
}

/** 把本程序下载的 GGUF 导入到 Ollama / LM Studio，不用重新下载 */
export async function importLocalModel(
  kind: LocalRuntimeKind,
  file: string,
  label?: string
): Promise<{ ok: boolean; message: string; model?: string }> {
  const spec = SPECS[kind]
  if (!spec) return { ok: false, message: '不支持的本地服务' }
  if (!file) return { ok: false, message: '请选择一个 .gguf 模型文件' }

  const abs = path.resolve(file)
  const st = await fs.stat(abs).catch(() => null)
  if (!st || !st.isFile() || st.size === 0) {
    return { ok: false, message: `找不到模型文件：${abs}（可能已被移动或删除）` }
  }
  // Ollama 的 blob 没有 .gguf 后缀，按扩展名拦会把这些合法模型全挡在外面。
  // 没有后缀就靠文件头确认，别把路过的任意文件当成模型导进去。
  if (!/\.gguf$/i.test(abs) && !(await isGgufFile(abs))) {
    return { ok: false, message: '这个文件开头不是 GGUF 标记，不是可用的模型权重（可能已损坏）' }
  }
  // 它本来就躺在 Ollama 库里，再「导入到 Ollama」只会白复制一份 4G
  if (kind === 'ollama' && abs.startsWith(path.join(ollamaModelsRoot(), 'blobs'))) {
    return {
      ok: false,
      message: '这个模型已经在 Ollama 库里了，不用再导入一次。要用它请直接在「本地模型」里选 Ollama；想换到 LM Studio 就把目标改成 LM Studio。'
    }
  }

  return kind === 'ollama' ? await importToOllama(abs, label) : await importToLmStudio(abs, label)
}
