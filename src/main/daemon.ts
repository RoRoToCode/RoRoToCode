import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { loadConfig } from './config'
import { findFreePort } from './portprobe'
import { isLoopbackUrl } from './providers/base'
import { llamaInstances, startLlama, statusLlama, stopLlama } from './llama'
import type { LlamaStatus, ProviderConfig } from '../shared/types'

/**
 * 本地 HTTP 控制面。
 *
 * 存在的理由：llama-server 自己只给数据面（OpenAI 兼容 /v1），
 * 「模型到底加载完没有」「崩溃了为什么崩」「现在有哪几个实例」这些问题它答不了。
 * 以前这些答案只能通过 Electron IPC 问主进程，外部脚本、Claude Code、Cline、CI
 * 一律够不着 —— 于是本程序只能是一个「人坐在屏幕前点」的桌面应用。
 *
 * 这里只暴露只读查询 + 启停，不改任何现有 IPC 的行为：
 * GUI 照旧走 IPC，外部走 HTTP，两边读的是同一个 statusLlama()，不会出现两份状态。
 */

export interface DaemonInfo {
  port: number
  token: string
  pid: number
  startedAt: number
  version: string
}

const DEFAULT_PORT = 7788
/** 每次启动换一个 token：写在 userData/daemon.json 里，本机其它用户读不到 */
let token = ''
let server: Server | null = null
let info: DaemonInfo | null = null
const startedAt = Date.now()

function infoFile(): string {
  return path.join(app.getPath('userData'), 'daemon.json')
}

/** 客户端（GUI 另一形态 / 外部脚本 / 配置模板）按这个文件直连，不用每次扫端口 */
export function daemonInfo(): DaemonInfo | null {
  return info
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store'
  })
  res.end(text)
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { ok: false, code, message })
}

/** token 比对走定长比较，别让响应时间泄露前缀 */
function tokenOk(given: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b)
}

function authorized(req: IncomingMessage, url: URL): boolean {
  const header = String(req.headers.authorization ?? '')
  if (header.startsWith('Bearer ')) return tokenOk(header.slice(7))
  // EventSource 不能带自定义头，所以 query 也认
  const q = url.searchParams.get('token')
  return q ? tokenOk(q) : false
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    // 控制面只收几个字段，超过 64KB 一定不是正常请求
    if (size > 64 * 1024) throw new Error('请求体过大')
    chunks.push(chunk as Buffer)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

/**
 * 给外部用的 OpenAI 兼容入口：只暴露必要字段，key 一律不外泄。
 *
 * 只列本机服务。远端供应商（api.openai.com、Anthropic 等）不放进来：
 * 它们的 key 不能外泄，用假的 "local" 顶替又等于教外部工具填错 —— 照着这份
 * 列表配过去只会得到 401，比不提供更误导。Anthropic 协议本来也不是 OpenAI 兼容。
 */
function openAiEntry(p: ProviderConfig): Record<string, unknown> | null {
  if (!p.baseUrl) return null
  if (p.kind === 'anthropic') return null
  if (!isLoopbackUrl(p.baseUrl)) return null
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    model: p.model ?? '',
    // 本地服务不校验 key，但多数客户端要求填一个非空值
    apiKey: 'local'
  }
}

async function snapshot(providerId?: string): Promise<{
  daemon: Record<string, unknown>
  llama: LlamaStatus
  instances: Array<Record<string, unknown>>
  openai: Array<Record<string, unknown>>
}> {
  const [st, cfg] = await Promise.all([statusLlama(providerId), loadConfig()])
  return {
    daemon: {
      pid: process.pid,
      version: app.getVersion(),
      uptimeMs: Date.now() - startedAt,
      headless: process.argv.includes('--headless')
    },
    llama: st,
    instances: llamaInstances().map((i) => ({
      key: i.key,
      port: i.port,
      model: path.basename(i.model),
      device: i.device,
      ctx: i.ctx,
      pid: i.pid
    })),
    openai: cfg.providers.map(openAiEntry).filter((x): x is Record<string, unknown> => x !== null)
  }
}

/** SSE：状态变化推给订阅者，省掉外部反复轮询 */
function events(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  })
  let last = ''
  let closed = false
  const tick = async (): Promise<void> => {
    if (closed) return
    try {
      const st = await statusLlama()
      const payload = JSON.stringify(st)
      if (payload !== last) {
        last = payload
        res.write(`event: status\ndata: ${payload}\n\n`)
      } else {
        // 心跳：让客户端和中间的代理知道连接还活着
        res.write(': ping\n\n')
      }
    } catch {
      // 状态查询失败不该掐断订阅
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), 2000)
  req.on('close', () => {
    closed = true
    clearInterval(timer)
    res.end()
  })
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const pathname = url.pathname.replace(/\/+$/, '') || '/'

  // 健康检查不需要 token：只报活着，不泄露任何配置
  if (pathname === '/health') {
    json(res, 200, { ok: true, name: 'rorotocode', version: app.getVersion(), uptimeMs: Date.now() - startedAt })
    return
  }

  if (!authorized(req, url)) {
    fail(res, 401, 'UNAUTHORIZED', '缺少或错误的 token：读 userData/daemon.json 里的 token')
    return
  }

  const providerId = url.searchParams.get('provider') ?? undefined

  if (req.method === 'GET' && pathname === '/status') {
    json(res, 200, { ok: true, ...(await snapshot(providerId)) })
    return
  }

  if (req.method === 'GET' && pathname === '/events') {
    events(req, res)
    return
  }

  if (req.method === 'POST' && pathname === '/start') {
    const body = await readBody(req)
    const r = await startLlama(
      typeof body.model === 'string' ? body.model : undefined,
      typeof body.ctx === 'number' ? body.ctx : undefined,
      {
        providerId: typeof body.providerId === 'string' ? body.providerId : undefined,
        device: typeof body.device === 'string' ? body.device : null,
        port: typeof body.port === 'number' ? body.port : undefined
      }
    )
    json(res, r.ok ? 200 : 400, r)
    return
  }

  if (req.method === 'POST' && pathname === '/stop') {
    const body = await readBody(req)
    const r = await stopLlama(typeof body.providerId === 'string' ? body.providerId : undefined)
    json(res, 200, r)
    return
  }

  fail(res, 404, 'NOT_FOUND', `没有这个接口：${req.method} ${pathname}`)
}

/**
 * 起控制面。端口被占就顺延，绝不因为端口冲突让整个程序起不来。
 * 只绑 127.0.0.1：控制面能启停模型、能读配置，不能暴露到局域网。
 */
export async function startDaemon(opts?: { port?: number; headless?: boolean }): Promise<DaemonInfo> {
  if (server) return info as DaemonInfo
  token = randomBytes(24).toString('hex')
  const want = Number(opts?.port ?? process.env.RORO_DAEMON_PORT ?? DEFAULT_PORT)
  const port = Number.isFinite(want) ? await findFreePort(want) : await findFreePort(DEFAULT_PORT)
  if (port === null) throw new Error('找不到可用端口，无法启动 HTTP 控制面')

  server = createServer((req, res) => {
    void route(req, res).catch((err) => {
      fail(res, 500, 'INTERNAL', (err as Error).message)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject)
    server?.listen(port, '127.0.0.1', () => resolve())
  })

  info = {
    port,
    token,
    pid: process.pid,
    startedAt,
    version: app.getVersion()
  }
  try {
    // 只给当前用户读：token 就是控制面的凭据
    fs.writeFileSync(infoFile(), JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch {
    // 写不了就只在日志里留一行，控制面照样能用
  }
  return info
}

export function stopDaemon(): void {
  server?.close()
  server = null
  info = null
  try {
    fs.unlinkSync(infoFile())
  } catch {
    // 文件可能已经不在了
  }
}
