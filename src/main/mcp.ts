import { app, shell } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { McpServerStatus } from '../shared/types'
import type { ToolSpec } from './tools/spec'

/**
 * 极简 MCP（Model Context Protocol）客户端。
 *
 * 只做最常用的 stdio 传输：读 userData/mcp.json 里的 mcpServers，
 * 连上之后问 tools/list，把每个工具挂成 mcp__<服务名>__<工具名> 交给模型。
 *
 * 设计上「失败不影响主流程」：某个服务起不来只是标红，不会拖慢发送消息。
 */

interface ServerConf {
  command: string
  args?: string[]
  env?: Record<string, string>
  disabled?: boolean
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

interface Conn {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  proc: ChildProcessWithoutNullStreams | null
  /** ready = 完成 initialize 且拿到工具清单 */
  ready: boolean
  error?: string
  tools: Array<{ name: string; description?: string; inputSchema?: ToolSpec['parameters'] }>
  pending: Map<number, Pending>
  nextId: number
  buffer: string
}

let conns: Conn[] = []
let loaded = false
let configPath = ''

function confFile(): string {
  if (!configPath) configPath = path.join(app.getPath('userData'), 'mcp.json')
  return configPath
}

const sanitize = (s: string) => s.replace(/[^\w-]/g, '_').slice(0, 40)

async function readConfig(): Promise<Record<string, ServerConf>> {
  try {
    const raw = await fs.readFile(confFile(), 'utf8')
    const json = JSON.parse(raw) as { mcpServers?: Record<string, ServerConf> }
    return json.mcpServers ?? {}
  } catch {
    return {}
  }
}

/** 按行喂 JSON：MCP 的 stdio 传输就是一行一条消息 */
function feed(conn: Conn, chunk: string): void {
  conn.buffer += chunk
  let idx = conn.buffer.indexOf('\n')
  while (idx >= 0) {
    const line = conn.buffer.slice(0, idx).trim()
    conn.buffer = conn.buffer.slice(idx + 1)
    if (line) handleMessage(conn, line)
    idx = conn.buffer.indexOf('\n')
  }
}

function handleMessage(conn: Conn, line: string): void {
  let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (typeof msg.id === 'number' && conn.pending.has(msg.id)) {
    const p = conn.pending.get(msg.id)!
    conn.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(msg.error.message || 'MCP 调用失败'))
    else p.resolve(msg.result)
    return
  }
  // 服务端反向请求：一律不处理，但必须回一个，否则它会等
  if (typeof msg.id === 'number' && msg.method) {
    write(conn, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not supported' } })
  }
}

function write(conn: Conn, payload: unknown): void {
  if (!conn.proc?.stdin.writable) return
  try {
    conn.proc.stdin.write(`${JSON.stringify(payload)}\n`)
  } catch {
    // 进程已退出，等 exit 事件处理
  }
}

function request(conn: Conn, method: string, params: unknown, timeout = 20000): Promise<unknown> {
  if (!conn.proc?.stdin.writable) return Promise.reject(new Error('MCP 服务未运行'))
  const id = conn.nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pending.delete(id)
      reject(new Error(`MCP 请求超时（${method}）`))
    }, timeout)
    conn.pending.set(id, { resolve, reject, timer })
    write(conn, { jsonrpc: '2.0', id, method, params })
  })
}

async function connect(name: string, conf: ServerConf): Promise<Conn> {
  const conn: Conn = {
    name,
    command: conf.command,
    args: conf.args ?? [],
    env: conf.env ?? {},
    proc: null,
    ready: false,
    tools: [],
    pending: new Map(),
    nextId: 1,
    buffer: ''
  }
  try {
    const env = { ...process.env, ...conf.env }
    delete env.ELECTRON_RUN_AS_NODE
    const proc = spawn(conf.command, conf.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(conf.command)
    }) as ChildProcessWithoutNullStreams

    conn.proc = proc
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => feed(conn, chunk))
    proc.stderr.on('data', () => undefined)
    proc.on('error', (err) => {
      conn.error = (err as Error).message
      conn.ready = false
    })
    proc.on('exit', (code) => {
      conn.ready = false
      if (!conn.error) conn.error = `进程已退出（code ${code ?? '-'}）`
      for (const [, p] of conn.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(conn.error))
      }
      conn.pending.clear()
    })

    await request(
      conn,
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'RoRoToCode', version: '0.1.1' }
      },
      15000
    )
    write(conn, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    const listed = (await request(conn, 'tools/list', {}, 15000)) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: ToolSpec['parameters'] }>
    }
    conn.tools = listed.tools ?? []
    conn.ready = true
  } catch (err) {
    conn.error = (err as Error).message
    try {
      conn.proc?.kill()
    } catch {
      // 已经退了
    }
  }
  return conn
}

async function load(force = false): Promise<Conn[]> {
  if (loaded && !force) return conns
  if (force) {
    for (const c of conns) {
      try {
        c.proc?.kill()
      } catch {
        // 忽略
      }
    }
  }
  const servers = await readConfig()
  const list = Object.entries(servers).filter(([, c]) => c && c.command && !c.disabled)
  conns = await Promise.all(list.map(([name, conf]) => connect(name, conf)))
  loaded = true
  return conns
}

export async function ensureMcp(): Promise<Conn[]> {
  return load(false)
}

export async function reloadMcp(): Promise<McpServerStatus[]> {
  await load(true)
  return mcpStatus()
}

export async function mcpStatus(): Promise<McpServerStatus[]> {
  const list = await ensureMcp()
  return list.map((c) => ({
    name: c.name,
    command: [c.command, ...c.args].join(' '),
    ok: c.ready,
    tools: c.tools.map((t) => ({ name: t.name, description: t.description })),
    error: c.error
  }))
}

export function mcpFullName(server: string, tool: string): string {
  return `mcp__${sanitize(server)}__${sanitize(tool)}`
}

/** 所有已连接服务暴露的工具，转成模型能看的函数定义 */
export async function mcpToolSpecs(): Promise<ToolSpec[]> {
  const list = await ensureMcp()
  const out: ToolSpec[] = []
  for (const c of list) {
    if (!c.ready) continue
    for (const t of c.tools) {
      out.push({
        name: mcpFullName(c.name, t.name),
        description: `[MCP·${c.name}] ${t.description ?? t.name}`.slice(0, 500),
        parameters: t.inputSchema ?? { type: 'object', properties: {} }
      })
    }
  }
  return out
}

export function isMcpTool(name: string): boolean {
  return name.startsWith('mcp__')
}

/** 调用 MCP 工具，把返回的 content 拼成纯文本 */
export async function callMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
  const list = await ensureMcp()
  for (const c of list) {
    if (!c.ready) continue
    const tool = c.tools.find((t) => mcpFullName(c.name, t.name) === name)
    if (!tool) continue
    const res = (await request(c, 'tools/call', { name: tool.name, arguments: args }, 120000)) as {
      content?: Array<{ type?: string; text?: string }>
      isError?: boolean
    }
    const text = (res?.content ?? [])
      .map((p) => (p.type === 'text' ? p.text ?? '' : `[${p.type ?? '内容'}]`))
      .join('\n')
      .trim()
    const out = text || '（工具没有返回内容）'
    if (res?.isError) throw new Error(out)
    return out.length > 20000 ? `${out.slice(0, 20000)}\n…（已截断）` : out
  }
  throw new Error('找不到这个 MCP 工具，可能服务已断开')
}

export async function openMcpConfig(): Promise<{ ok: boolean; path: string; message?: string }> {
  const file = confFile()
  try {
    await fs.access(file)
  } catch {
    const tpl = {
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/your/workspace']
        }
      }
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(tpl, null, 2), 'utf8')
  }
  shell.showItemInFolder(file)
  return { ok: true, path: file, message: '改完 mcp.json 后点「重新连接」即可生效' }
}

export function shutdownMcp(): void {
  for (const c of conns) {
    try {
      c.proc?.kill()
    } catch {
      // 忽略
    }
  }
  conns = []
  loaded = false
}
