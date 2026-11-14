import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { loadConfig, effectiveWorkspace } from './config'
import { findFreePort } from './portprobe'
import { isLoopbackUrl } from './providers/base'
import { llamaInstances, startLlama, statusLlama, stopLlama } from './llama'
import { listAgents, removeAgent, upsertAgent } from './agents'
import { listRoutines, removeRoutine, runRoutine, upsertRoutine } from './routines'
import { cancelHandoff, listHandoffs, runHandoff } from './handoff'
import { listSessions } from './store'
import { classifyRisk, executeTool, hardBlockReason } from './tools'
import { toolSpecs } from './tools/spec'
import type { AgentEvent, AgentProfile, LlamaStatus, ProviderConfig, Routine, RunningRun } from '../shared/types'
import { MAX_CONCURRENT_RUNS } from '../shared/runqueue'

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

/**
 * 无头 agent 接口（最小可用）。
 *
 * 由 main.ts 通过 `setChatHandler` 注入，让控制面能驱动同一个 AgentEngine：
 * - chat.send(sessionId, text, options) —— 发一条消息，非交互模式下跑完自动决策；
 * - chat.abort(sessionId) —— 停止；
 * - chat.createSession(workspace?) —— 建/续会话，返回 sessionId。
 * 事件通过 `subscribe(sessionId, cb)` 把 AgentEvent 转成 SSE 推给客户端。
 */
export interface ChatHandler {
  createSession(workspace?: string | null, agentId?: string | null): Promise<string>
  send(sessionId: string, text: string, options?: { approvalPolicy?: 'deny' | 'allow' }): Promise<void>
  abort(sessionId: string): void
  subscribe(sessionId: string, cb: (event: AgentEvent) => void): () => void
  isRunning(sessionId: string): boolean
  /** 正在跑的会话清单；不给就只报数量（老版本的注入方没有这个方法） */
  running?: () => RunningRun[]
}

let chatHandler: ChatHandler | null = null

/** 由 main.ts 在引擎创建后注入，控制面才能驱动 agent */
export function setChatHandler(h: ChatHandler): void {
  chatHandler = h
}

/** SSE 订阅者表：sessionId -> 回调集合（一个会话可能有多个客户端在听） */
const chatSubs = new Map<string, Set<(event: AgentEvent) => void>>()

/**
 * 广播一个 agent 事件给该会话的所有 SSE 订阅者。
 * main.ts 的 emit() 在发 GUI 的同时也调这里，两边共用同一份事件。
 */
export function broadcastAgentEvent(sessionId: string, event: AgentEvent): void {
  const subs = chatSubs.get(sessionId)
  if (!subs) return
  for (const cb of subs) {
    try {
      cb(event)
    } catch {
      // 订阅者回调自己失败不该影响其它订阅者
    }
  }
}

/** 登记一个会话的 SSE 订阅者，返回取消订阅函数 */
export function subscribeChat(sessionId: string, cb: (event: AgentEvent) => void): () => void {
  let subs = chatSubs.get(sessionId)
  if (!subs) {
    subs = new Set()
    chatSubs.set(sessionId, subs)
  }
  subs.add(cb)
  return () => {
    const set = chatSubs.get(sessionId)
    if (!set) return
    set.delete(cb)
    if (set.size === 0) chatSubs.delete(sessionId)
  }
}

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
  /** 「有几个 agent、几个在干活」——外部脚本和界面共用这一份口径 */
  runtime: {
    agents: number
    routines: { total: number; enabled: number }
    running: RunningRun[]
    /** 全局并发闸门：在跑几个、排队几个、上限多少。外部脚本不用自己数 */
    queue: { active: number; queued: number; limit: number }
  }
}> {
  const [st, cfg, profiles, routineList] = await Promise.all([
    statusLlama(providerId),
    loadConfig(),
    listAgents(),
    listRoutines()
  ])
  // 排队位置只在引擎里现算，这里按快照数一遍就够了
  const runs = chatHandler?.running?.() ?? []
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
    openai: cfg.providers.map(openAiEntry).filter((x): x is Record<string, unknown> => x !== null),
    runtime: {
      agents: profiles.length,
      routines: {
        total: routineList.length,
        enabled: routineList.filter((r) => r.enabled).length
      },
      running: runs,
      queue: {
        active: runs.filter((r) => r.state !== 'queued').length,
        queued: runs.filter((r) => r.state === 'queued').length,
        limit: MAX_CONCURRENT_RUNS
      }
    }
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

/**
 * agent 事件 SSE：把一个会话的 AgentEvent 流原样推给客户端。
 * 事件格式：`event: <type>\ndata: <json>\n\n`；订阅是带心跳的（每 15s 一条注释）。
 */
function chatEvents(req: IncomingMessage, res: ServerResponse, sessionId: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  })
  const send = (type: string, payload: unknown): void => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  send('ready', { sessionId })

  // 订阅该会话的所有事件
  const unsubscribe = chatHandler!.subscribe(sessionId, (event) => {
    send(event.type, event)
  })

  // 心跳：15s 一条注释，让中间代理知道连接还活着
  const timer = setInterval(() => {
    res.write(': ping\n\n')
  }, 15000)

  let closed = false
  req.on('close', () => {
    if (closed) return
    closed = true
    clearInterval(timer)
    unsubscribe()
    res.end()
  })
}

/**
 * OpenAPI 3.1 描述。
 *
 * 手写而不是从路由反射生成：控制面就十来个端点，手写能把
 * 「这条是异步的、结果走 SSE」这种路由看不出来的语义写进去，
 * 客户端生成器也就能生成对的签名。
 */
export function openapiSpec(): Record<string, unknown> {
  const obj = (props: Record<string, unknown>, required: string[] = []) => ({
    type: 'object',
    properties: props,
    ...(required.length ? { required } : {})
  })
  const str = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) })
  const ok = { description: '成功', content: { 'application/json': { schema: { type: 'object' } } } }

  return {
    openapi: '3.1.0',
    info: {
      title: 'RoRoToCode 控制面',
      // 单独跑测试时没有 Electron 的 app，别在这里抛错
      version: (() => {
        try {
          return app?.getVersion?.() ?? '0.0.0'
        } catch {
          return '0.0.0'
        }
      })(),
      description:
        '本机 HTTP 控制面。除 /health 与 /openapi.json 外都需要 Bearer token（读 userData/daemon.json）。'
    },
    servers: [{ url: `http://127.0.0.1:${info?.port ?? DEFAULT_PORT}` }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        tokenQuery: { type: 'apiKey', in: 'query', name: 'token' }
      }
    },
    paths: {
      '/health': {
        get: { summary: '探活（免鉴权）', responses: { 200: ok } }
      },
      '/openapi.json': {
        get: { summary: '本描述（免鉴权）', responses: { 200: ok } }
      },
      '/status': {
        get: {
          summary: 'llama.cpp 实例状态',
          parameters: [{ name: 'provider', in: 'query', schema: { type: 'string' } }],
          responses: { 200: ok }
        }
      },
      '/events': {
        get: { summary: '进程事件流（SSE）', responses: { 200: { description: 'text/event-stream' } } }
      },
      '/start': {
        post: {
          summary: '启动本地 llama-server',
          requestBody: {
            content: {
              'application/json': {
                schema: obj({
                  model: str('模型文件名'),
                  ctx: { type: 'integer' },
                  providerId: str(),
                  device: str(),
                  port: { type: 'integer' }
                })
              }
            }
          },
          responses: { 200: ok, 400: { description: '启动失败' } }
        }
      },
      '/stop': {
        post: {
          summary: '停止本地 llama-server（释放显存）',
          requestBody: {
            content: { 'application/json': { schema: obj({ providerId: str() }) } }
          },
          responses: { 200: ok }
        }
      },
      '/chat/session': {
        post: {
          summary: '建一个 agent 会话',
          requestBody: {
            content: {
              'application/json': {
                schema: obj({ workspace: str('工作区绝对路径'), agentId: str('常驻档案 id') })
              }
            }
          },
          responses: { 200: ok }
        }
      },
      '/chat/send': {
        post: {
          summary: '发一条消息（异步，结果走 /chat/events）',
          requestBody: {
            content: {
              'application/json': {
                schema: obj(
                  {
                    sessionId: str(),
                    text: str(),
                    approvalPolicy: { type: 'string', enum: ['deny', 'allow'] }
                  },
                  ['sessionId', 'text']
                )
              }
            }
          },
          responses: { 202: { description: '已接收' }, 400: { description: '参数缺失' } }
        }
      },
      '/chat/abort': {
        post: {
          summary: '停止当前这一轮',
          requestBody: {
            content: { 'application/json': { schema: obj({ sessionId: str() }, ['sessionId']) } }
          },
          responses: { 200: ok }
        }
      },
      '/chat/events': {
        get: {
          summary: '会话事件流（SSE，text/event-stream）',
          parameters: [
            { name: 'session', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'token', in: 'query', schema: { type: 'string' } }
          ],
          responses: { 200: { description: '事件流' } }
        }
      },
      '/agents': {
        get: { summary: '档案列表', responses: { 200: ok } },
        post: { summary: '新建 / 修改档案', responses: { 200: ok } },
        delete: {
          summary: '删除档案',
          parameters: [{ name: 'id', in: 'query', required: true, schema: { type: 'string' } }],
          responses: { 200: ok }
        }
      },
      '/agents/usage': { get: { summary: '各档案的用量', responses: { 200: ok } } },
      '/routines': {
        get: { summary: '定时任务列表', responses: { 200: ok } },
        post: { summary: '新建 / 修改定时任务', responses: { 200: ok } },
        delete: {
          summary: '删除定时任务',
          parameters: [{ name: 'id', in: 'query', required: true, schema: { type: 'string' } }],
          responses: { 200: ok }
        }
      },
      '/routines/run': { post: { summary: '立刻跑一次', responses: { 200: ok } } },
      '/handoffs': { get: { summary: '交接队列', responses: { 200: ok } } },
      '/handoffs/run': { post: { summary: '执行交接', responses: { 200: ok } } },
      '/handoffs/cancel': { post: { summary: '取消交接', responses: { 200: ok } } }
    }
  }
}

/**
 * MCP server：把本程序的工具反过来暴露给别的编辑器用。
 *
 * 为什么值得做：这个程序最值钱的不是界面，是「本地模型 + 一整套带安全边界的
 * 文件/命令工具」。做成 MCP server 之后，Cursor / Cline / VS Code 不用换模型，
 * 就能直接用这套工具干活 —— 比自己写 IDE 插件便宜一个数量级。
 *
 * 传输用 MCP 的 Streamable HTTP：单端点 POST，请求/响应各一条 JSON，
 * 不开 SSE。够 Cursor、Cline 这类客户端用，也省掉长连接的生命周期管理。
 */
const MCP_TOOL_NAMES = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'patch',
  'list_dir',
  'glob',
  'grep',
  'repo_map',
  'run_shell',
  'shell_bg',
  'terminal',
  'git',
  'format',
  'web_search',
  'web_fetch'
])

interface RpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

function rpcOk(id: RpcRequest['id'], result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

function rpcErr(id: RpcRequest['id'], code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

/**
 * MCP 通道默认不放行高危操作（删除 / 联网 / 越界写）。
 *
 * 原因很直接：MCP 调用来自别的编辑器，这边没有窗口可以弹确认框。
 * 想放开就在 userData/daemon.json 里加 `"mcpAllowHigh": true`（等于你明确授权）。
 */
function mcpAllowsHigh(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(infoFile(), 'utf8')) as { mcpAllowHigh?: boolean }
    return raw.mcpAllowHigh === true
  } catch {
    return false
  }
}

async function mcpCallTool(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const name = String(params.name ?? '')
  const args = (params.arguments ?? {}) as Record<string, unknown>
  if (!MCP_TOOL_NAMES.has(name)) {
    return { content: [{ type: 'text', text: `不支持的工具：${name}` }], isError: true }
  }

  const config = await loadConfig()
  const workspace = (await effectiveWorkspace(config)) ?? ''
  if (!workspace) {
    return { content: [{ type: 'text', text: '本机还没有选择工作区，先在程序里打开一个目录' }], isError: true }
  }

  // 硬拦截只针对命令：它检查的是「这条 shell 命令绝对不能跑」
  const blocked = name === 'run_shell' || name === 'shell_bg' || name === 'terminal'
    ? hardBlockReason(String(args.command ?? args.data ?? ''))
    : null
  if (blocked) return { content: [{ type: 'text', text: blocked }], isError: true }

  const risk = classifyRisk(name, args, workspace)
  if (risk?.high && !mcpAllowsHigh()) {
    return {
      content: [
        {
          type: 'text',
          text: `这个操作被拦下了：${risk.reason}。MCP 通道没有确认框，默认不执行高危操作；确认安全的话，在 daemon.json 里加 "mcpAllowHigh": true 再来。`
        }
      ],
      isError: true
    }
  }

  try {
    const text = await executeTool(name, args, { workspace, signal: new AbortController().signal })
    return { content: [{ type: 'text', text: text || '（没有输出）' }], isError: false }
  } catch (err) {
    return { content: [{ type: 'text', text: `执行失败：${(err as Error).message}` }], isError: true }
  }
}

async function handleRpc(req: RpcRequest): Promise<Record<string, unknown> | null> {
  const method = String(req.method ?? '')
  // 通知没有 id，也不需要回包
  if (method.startsWith('notifications/')) return null

  if (method === 'initialize') {
    return rpcOk(req.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'rorotocode', version: app.getVersion() }
    })
  }

  if (method === 'ping') return rpcOk(req.id, {})

  if (method === 'tools/list') {
    const tools = toolSpecs
      .filter((t) => MCP_TOOL_NAMES.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }))
    return rpcOk(req.id, { tools })
  }

  if (method === 'tools/call') {
    return rpcOk(req.id, await mcpCallTool((req.params ?? {}) as Record<string, unknown>))
  }

  if (method === 'resources/list') return rpcOk(req.id, { resources: [] })
  if (method === 'prompts/list') return rpcOk(req.id, { prompts: [] })

  return rpcErr(req.id, -32601, `不认识的方法：${method}`)
}

/** POST /mcp：一条或一批 JSON-RPC 消息 */
async function mcpEndpoint(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req)
  const single = !Array.isArray(body)
  const list = (single ? [body] : body) as RpcRequest[]

  const results: Array<Record<string, unknown> | null> = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    results.push(await handleRpc(item).catch((err) => rpcErr(item?.id, -32603, (err as Error).message)))
  }

  const out = results.filter(Boolean) as Array<Record<string, unknown>>
  // 全是通知：按 MCP 规范回 202、无正文
  if (!out.length) {
    res.statusCode = 202
    res.end()
    return
  }
  json(res, 200, single ? out[0] : out)
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const pathname = url.pathname.replace(/\/+$/, '') || '/'

  // 健康检查不需要 token：只报活着，不泄露任何配置
  if (pathname === '/health') {
    json(res, 200, { ok: true, name: 'rorotocode', version: app.getVersion(), uptimeMs: Date.now() - startedAt })
    return
  }

  // OpenAPI 描述本身不含密钥，放在鉴权之前：别人拿到它才知道要带 token 怎么调
  if (req.method === 'GET' && (pathname === '/openapi.json' || pathname === '/openapi')) {
    json(res, 200, openapiSpec())
    return
  }

  if (!authorized(req, url)) {
    fail(res, 401, 'UNAUTHORIZED', '缺少或错误的 token：读 userData/daemon.json 里的 token')
    return
  }

  const providerId = url.searchParams.get('provider') ?? undefined

  // ---- MCP server（给 Cursor / Cline / VS Code 反过来调用本程序的工具） ----
  if (pathname === '/mcp') {
    if (req.method === 'POST') {
      await mcpEndpoint(req, res)
      return
    }
    if (req.method === 'GET') {
      json(res, 200, { ok: true, protocolVersion: '2025-06-18', transport: 'streamable-http' })
      return
    }
    res.statusCode = 405
    res.end()
    return
  }

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
        port: typeof body.port === 'number' ? body.port : undefined,
        // 外部脚本显式要求「启动并使用」时才切当前模型，默认只起服务
        activate: typeof body.activate === 'boolean' ? body.activate : undefined
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

  // ---- 无头 agent 接口 ----

  // 建会话：POST /chat/session  body: { workspace? } -> { ok, sessionId }
  if (req.method === 'POST' && pathname === '/chat/session') {
    if (!chatHandler) {
      fail(res, 503, 'NO_CHAT', 'agent 引擎尚未注入')
      return
    }
    const body = await readBody(req)
    const sessionId = await chatHandler.createSession(
      typeof body.workspace === 'string' ? body.workspace : null,
      typeof body.agentId === 'string' ? body.agentId : null
    )
    json(res, 200, { ok: true, sessionId })
    return
  }

  // 发消息：POST /chat/send  body: { sessionId, text, approvalPolicy? }
  // 非交互运行，事件走 SSE（/chat/events），这里只同步回「已接收」
  if (req.method === 'POST' && pathname === '/chat/send') {
    if (!chatHandler) {
      fail(res, 503, 'NO_CHAT', 'agent 引擎尚未注入')
      return
    }
    const body = await readBody(req)
    const sessionId = String(body.sessionId ?? '')
    const text = String(body.text ?? '')
    if (!sessionId || !text) {
      fail(res, 400, 'BAD_REQUEST', '需要 sessionId 和 text')
      return
    }
    const policy = body.approvalPolicy === 'allow' ? 'allow' : 'deny'
    // 发消息是异步的：不在这里 await（会阻塞直到整轮跑完），交给 SSE 推结果
    void chatHandler
      .send(sessionId, text, { approvalPolicy: policy })
      .then(() => undefined)
      .catch((err) => broadcastAgentEvent(sessionId, { type: 'error', message: (err as Error).message }))
    json(res, 202, { ok: true, sessionId, accepted: true })
    return
  }

  // 停止：POST /chat/abort  body: { sessionId }
  if (req.method === 'POST' && pathname === '/chat/abort') {
    if (!chatHandler) {
      fail(res, 503, 'NO_CHAT', 'agent 引擎尚未注入')
      return
    }
    const body = await readBody(req)
    const sessionId = String(body.sessionId ?? '')
    if (!sessionId) {
      fail(res, 400, 'BAD_REQUEST', '需要 sessionId')
      return
    }
    chatHandler.abort(sessionId)
    json(res, 200, { ok: true, aborted: true })
    return
  }

  // 事件流：GET /chat/events?session=<id> -> SSE
  if (req.method === 'GET' && pathname === '/chat/events') {
    if (!chatHandler) {
      fail(res, 503, 'NO_CHAT', 'agent 引擎尚未注入')
      return
    }
    const sessionId = url.searchParams.get('session') ?? ''
    if (!sessionId) {
      fail(res, 400, 'BAD_REQUEST', '需要 session 参数')
      return
    }
    chatEvents(req, res, sessionId)
    return
  }

  // ---- 常驻档案与定时任务 ----
  // 这两组接口让「外部脚本建一个每天 9 点的巡检」成为可能，
  // 不需要人坐在界面前面点一遍。

  if (pathname === '/agents' && req.method === 'GET') {
    json(res, 200, { ok: true, agents: await listAgents() })
    return
  }

  /**
   * 每个档案的使用情况：开过几次会话、挂了几条定时任务、现在是否在跑。
   *
   * 单独一个接口而不是塞进 /status：这个要扫全部会话文件（每个都完整 parse），
   * 贵；轮询状态的客户端不该为它付代价。
   */
  if (pathname === '/agents/usage' && req.method === 'GET') {
    const [profiles, routineList, sessions] = await Promise.all([
      listAgents(),
      listRoutines(),
      listSessions()
    ])
    const running = chatHandler?.running?.() ?? []
    const rows = profiles.map((p) => {
      // sessions 已按 updatedAt 降序，取第一条即最近一次
      const mine = sessions.filter((s) => s.agentId === p.id)
      const runs = routineList.filter((r) => r.agentId === p.id)
      return {
        id: p.id,
        name: p.name,
        sessions: mine.length,
        lastUsedAt: mine[0]?.updatedAt ?? null,
        routines: runs.length,
        enabledRoutines: runs.filter((r) => r.enabled).length,
        running: running.filter((r) => r.agentId === p.id).length
      }
    })
    json(res, 200, {
      ok: true,
      agents: rows,
      // 不属于任何档案的普通会话：用界面手动聊的那些
      plainSessions: sessions.filter((s) => !s.agentId).length,
      running: running.length
    })
    return
  }

  if (pathname === '/agents' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      json(res, 200, { ok: true, agent: await upsertAgent(body as unknown as Partial<AgentProfile>) })
    } catch (err) {
      fail(res, 400, 'BAD_REQUEST', (err as Error).message)
    }
    return
  }

  if (pathname === '/agents' && req.method === 'DELETE') {
    const id = url.searchParams.get('id') ?? ''
    if (!id) {
      fail(res, 400, 'BAD_REQUEST', '需要 id 参数')
      return
    }
    json(res, 200, { ok: true, ...(await removeAgent(id)) })
    return
  }

  if (pathname === '/routines' && req.method === 'GET') {
    json(res, 200, { ok: true, routines: await listRoutines() })
    return
  }

  if (pathname === '/routines' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      json(res, 200, { ok: true, routine: await upsertRoutine(body as unknown as Partial<Routine>) })
    } catch (err) {
      fail(res, 400, 'BAD_REQUEST', (err as Error).message)
    }
    return
  }

  if (pathname === '/routines' && req.method === 'DELETE') {
    const id = url.searchParams.get('id') ?? ''
    if (!id) {
      fail(res, 400, 'BAD_REQUEST', '需要 id 参数')
      return
    }
    json(res, 200, { ok: await removeRoutine(id) })
    return
  }

  // 立即跑一次：同步等它跑完再回（长任务会等很久，客户端要自己设超时）
  if (pathname === '/routines/run' && req.method === 'POST') {
    const id = url.searchParams.get('id') ?? String((await readBody(req)).id ?? '')
    if (!id) {
      fail(res, 400, 'BAD_REQUEST', '需要 id 参数')
      return
    }
    const r = await runRoutine(id)
    json(res, r.ok ? 200 : 400, r)
    return
  }

  // 交接：agent 之间转交的活。GET 看队列，run 手动放行，cancel 取消还在排队的
  if (pathname === '/handoffs' && req.method === 'GET') {
    json(res, 200, { ok: true, handoffs: await listHandoffs() })
    return
  }

  if (pathname === '/handoffs/run' && req.method === 'POST') {
    const id = url.searchParams.get('id') ?? String((await readBody(req)).id ?? '')
    if (!id) {
      fail(res, 400, 'BAD_REQUEST', '需要 id 参数')
      return
    }
    const r = await runHandoff(id)
    json(res, r.ok ? 200 : 400, r)
    return
  }

  if (pathname === '/handoffs/cancel' && req.method === 'POST') {
    const id = url.searchParams.get('id') ?? String((await readBody(req)).id ?? '')
    if (!id) {
      fail(res, 400, 'BAD_REQUEST', '需要 id 参数')
      return
    }
    json(res, 200, await cancelHandoff(id))
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
