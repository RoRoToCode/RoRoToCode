/**
 * RoRoToCode 控制面客户端（零依赖，Node 18+ / 现代浏览器）。
 *
 * 它只做一件事：把本机 daemon 的那几个 HTTP 端点包成好调的方法，
 * 让外部脚本 / CI / 别的编辑器不用自己拼 fetch、自己解析 SSE。
 *
 *   import { RorotoClient } from './sdk/roroto.mjs'
 *   const client = await RorotoClient.fromDaemonFile()
 *   for await (const ev of client.chat({ text: '看看这个报错' })) {
 *     if (ev.type === 'delta') process.stdout.write(ev.text)
 *   }
 *
 * 端口和 token 存在 userData/daemon.json（Windows 默认
 * %APPDATA%/RoRoToCode/daemon.json），每次启动会换 token，
 * 所以不要在脚本里写死 —— 要么走 fromDaemonFile()，要么显式传。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/** Windows: %APPDATA%\RoRoToCode；macOS: ~/Library/Application Support/RoRoToCode */
export function defaultDaemonFile() {
  const app = 'RoRoToCode'
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), app, 'daemon.json')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', app, 'daemon.json')
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), app, 'daemon.json')
}

export class RorotoError extends Error {
  constructor(message, status, body) {
    super(message)
    this.name = 'RorotoError'
    this.status = status
    this.body = body
  }
}

export class RorotoClient {
  /**
   * @param {{ port?: number, token?: string, baseUrl?: string, timeoutMs?: number }} opts
   */
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || `http://127.0.0.1:${opts.port || 7788}`).replace(/\/+$/, '')
    this.token = opts.token || ''
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this._info = null
  }

  /** 直接读 daemon.json 拿到端口和 token */
  static async fromDaemonFile(file = defaultDaemonFile()) {
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (err) {
      throw new Error(
        `读不到 ${file}：先启动 RoRoToCode（控制面会自己写好这个文件）。原始错误：${err.message}`
      )
    }
    const info = JSON.parse(raw)
    if (!info?.port || !info?.token) throw new Error(`${file} 内容不完整（缺 port 或 token）`)
    const client = new RorotoClient({ port: info.port, token: info.token })
    client._info = info
    return client
  }

  get info() {
    return this._info
  }

  async _fetch(pathname, { method = 'GET', body, timeoutMs, raw = false } = {}) {
    const url = `${this.baseUrl}${pathname}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        headers: {
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      })
      if (raw) return res
      const text = await res.text()
      const data = text ? safeJson(text) : null
      if (!res.ok) {
        const message = data?.message || data?.error?.message || text.slice(0, 200) || res.statusText
        throw new RorotoError(`${res.status} ${message}`, res.status, data)
      }
      return data
    } finally {
      clearTimeout(timer)
    }
  }

  /* ---------------- 基础 ---------------- */

  /** 探活，不需要 token */
  health() {
    return this._fetch('/health')
  }

  status(providerId) {
    return this._fetch(`/status${providerId ? `?provider=${encodeURIComponent(providerId)}` : ''}`)
  }

  start(opts = {}) {
    return this._fetch('/start', { method: 'POST', body: opts })
  }

  stop(providerId) {
    return this._fetch('/stop', { method: 'POST', body: providerId ? { providerId } : {} })
  }

  openapi() {
    return this._fetch('/openapi.json')
  }

  /* ---------------- 会话 ---------------- */

  async createSession({ workspace, agentId } = {}) {
    const r = await this._fetch('/chat/session', {
      method: 'POST',
      body: { ...(workspace ? { workspace } : {}), ...(agentId ? { agentId } : {}) }
    })
    return r.sessionId
  }

  /** 发消息。这个调用立刻返回，真正的输出在事件流里 */
  send(sessionId, text, { approvalPolicy = 'deny' } = {}) {
    return this._fetch('/chat/send', {
      method: 'POST',
      body: { sessionId, text, approvalPolicy }
    })
  }

  abort(sessionId) {
    return this._fetch('/chat/abort', { method: 'POST', body: { sessionId } })
  }

  /**
   * 订阅会话事件（SSE）。
   * 返回异步迭代器，调用方 `for await` 即可；break 会自动断开连接。
   *
   *   for await (const ev of client.events(id)) console.log(ev.type)
   */
  async *events(sessionId, { signal } = {}) {
    const res = await this._fetch(
      `/chat/events?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(this.token)}`,
      { raw: true, timeoutMs: 0 }
    )
    if (!res.ok || !res.body) throw new RorotoError(`事件流连接失败：${res.status}`, res.status, null)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        if (signal?.aborted) break
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE：事件之间用空行分隔，data 行可能有多行
        let cut
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          const data = chunk
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n')
          if (!data) continue
          const parsed = safeJson(data)
          if (parsed) yield parsed
        }
      }
    } finally {
      try {
        await reader.cancel()
      } catch {
        // 已经断了
      }
    }
  }

  /**
   * 一步到位：建会话 → 订阅 → 发消息 → 收到 done 结束。
   * 每类事件都通过 onEvent 回调（也可以只看返回的最终文本）。
   *
   * @returns {Promise<{ sessionId: string, text: string, events: object[] }>}
   */
  async run({ text, workspace, agentId, approvalPolicy = 'deny', onEvent, signal } = {}) {
    const sessionId = await this.createSession({ workspace, agentId })
    const events = []
    let output = ''
    const done = (async () => {
      for await (const ev of this.events(sessionId, { signal })) {
        events.push(ev)
        if (ev.type === 'delta' && ev.text) output += ev.text
        if (ev.type === 'error') throw new RorotoError(ev.message || 'agent 报错', 0, ev)
        onEvent?.(ev)
        if (ev.type === 'done') break
      }
    })()
    await this.send(sessionId, text, { approvalPolicy })
    await done
    return { sessionId, text: output, events }
  }

  /* ---------------- 档案 / 定时任务 ---------------- */

  agents() {
    return this._fetch('/agents')
  }

  saveAgent(agent) {
    return this._fetch('/agents', { method: 'POST', body: agent })
  }

  removeAgent(id) {
    return this._fetch(`/agents?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  routines() {
    return this._fetch('/routines')
  }

  runRoutine(id) {
    return this._fetch('/routines/run', { method: 'POST', body: { id } })
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export default RorotoClient
