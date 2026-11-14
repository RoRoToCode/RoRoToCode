import { app } from 'electron'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { ensureMcp, mcpStatus } from './mcp'

app.setPath('userData', path.join(os.tmpdir(), 'rorotocode-mcp-oauth-smoke'))

/**
 * MCP remote/OAuth smoke：内联起一个 mock MCP 服务器，验证
 * 1) OAuth2 client credentials 自动换 token；
 * 2) 请求带 Authorization: Bearer <token>；
 * 3) initialize 响应返回 Mcp-Session-Id，后续请求带上。
 */

let tokenIssued = 0
let sawBearer = false
let sawSessionId = false
let sawRefreshRetry = false

const mockServer = http.createServer((req, res) => {
  const url = req.url ?? ''

  // OAuth token endpoint：第一次返回 token-v1（很快过期），之后返回 token-v2
  if (url.startsWith('/oauth/token')) {
    const auth = req.headers.authorization ?? ''
    if (!auth.startsWith('Basic ')) {
      res.writeHead(401).end()
      return
    }
    tokenIssued++
    const token = tokenIssued === 1 ? 'token-v1' : 'token-v2'
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 3600 }))
    return
  }

  // MCP endpoint
  if (url.startsWith('/mcp')) {
    if (req.headers.authorization === 'Bearer token-v1' || req.headers.authorization === 'Bearer token-v2') sawBearer = true
    if (req.headers['mcp-session-id'] === 'mock-session-123') sawSessionId = true

    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let msg: { method?: string; id?: number } = {}
      try {
        msg = JSON.parse(body)
      } catch {
        // ignore
      }
      // 模拟 token-v1 已过期：带 v1 的 tools/list 返回 401，触发客户端刷新重试
      if (msg.method === 'tools/list' && req.headers.authorization === 'Bearer token-v1') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid_token' }))
        return
      }
      const isSse = (req.headers.accept ?? '').includes('text/event-stream')

      const respond = (payload: unknown, sessionId?: string) => {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (sessionId) headers['mcp-session-id'] = sessionId
        if (isSse) {
          headers['content-type'] = 'text/event-stream'
          res.writeHead(200, headers)
          res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
        } else {
          res.writeHead(200, headers)
          res.end(JSON.stringify(payload))
        }
      }

      if (msg.method === 'initialize') {
        respond(
          { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {} } },
          'mock-session-123'
        )
        return
      }
      if (msg.method === 'notifications/initialized') {
        res.writeHead(202).end()
        return
      }
      if (msg.method === 'tools/list') {
        // 走到这里说明已经用 token-v2 重试成功
        if (req.headers.authorization === 'Bearer token-v2') sawRefreshRetry = true
        respond({
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools: [{ name: 'echo', description: 'mock echo tool', inputSchema: { type: 'object', properties: {} } }] }
        })
        return
      }
      respond({ jsonrpc: '2.0', id: msg.id, result: {} })
    })
    return
  }

  res.writeHead(404).end()
})

void app.whenReady().then(async () => {
  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve))
  const addr = mockServer.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const baseUrl = `http://127.0.0.1:${port}`

  // 写 mcp.json，指向 mock 服务器 + OAuth 配置
  const userData = app.getPath('userData')
  await fs.mkdir(userData, { recursive: true })
  await fs.writeFile(
    path.join(userData, 'mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          oauthRemote: {
            url: `${baseUrl}/mcp`,
            auth: {
              type: 'oauth2',
              tokenUrl: `${baseUrl}/oauth/token`,
              clientId: 'client-1',
              clientSecret: 'secret-1',
              scope: 'read'
            }
          }
        }
      },
      null,
      2
    )
  )

  const conns = await ensureMcp()
  const status = await mcpStatus()
  console.log('--- mcp status ---')
  for (const s of status) {
    console.log(`${s.name}: ok=${s.ok} tools=${s.tools.map((t) => t.name).join(',')} error=${s.error ?? '-'}`)
  }

  console.log('--- assertions ---')
  console.log(`tokenIssued=${tokenIssued} (expect >=2，第二次是 401 触发刷新)`)
  console.log(`sawBearer=${sawBearer} (expect true)`)
  console.log(`sawSessionId=${sawSessionId} (expect true)`)
  console.log(`sawRefreshRetry=${sawRefreshRetry} (expect true)`)
  console.log(`ready=${conns[0]?.ready} (expect true)`)

  const pass =
    tokenIssued >= 2 &&
    sawBearer &&
    sawSessionId &&
    sawRefreshRetry &&
    conns[0]?.ready === true &&
    conns[0]?.tools.length === 1
  console.log(pass ? 'SMOKE_MCP_OAUTH PASS' : 'SMOKE_MCP_OAUTH FAIL')

  mockServer.close()
  app.exit(pass ? 0 : 1)
})
