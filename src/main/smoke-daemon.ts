import { app } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { daemonInfo, startDaemon, stopDaemon } from './daemon'

/**
 * 控制面自检：不依赖界面、不碰真实模型进程。
 *
 * userData 指向临时目录，配置为空，因此 statusLlama 只会去探一个没人监听的端口，
 * 得到 idle —— 正好用来验证四态里的「没跑」分支。真崩溃、真加载要走人工验证。
 */

app.setPath('userData', path.join(os.tmpdir(), 'rorotocode-daemon-smoke'))

const PORT = Number(process.env.SMOKE_PORT || 7791)
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`PASS  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name}${detail ? `  ::  ${detail}` : ''}`)
  }
}

void app.whenReady().then(async () => {
  try {
    const d = await startDaemon({ port: PORT })
    const base = `http://127.0.0.1:${d.port}`
    const auth = { authorization: `Bearer ${d.token}` }

    const health = await fetch(`${base}/health`)
    const healthBody = (await health.json()) as { ok?: boolean }
    check('GET /health 免鉴权返回 200', health.status === 200 && healthBody.ok === true, String(health.status))

    const noToken = await fetch(`${base}/status`)
    check('GET /status 无 token 返回 401', noToken.status === 401, String(noToken.status))

    const badToken = await fetch(`${base}/status`, { headers: { authorization: 'Bearer wrong' } })
    check('GET /status 错误 token 返回 401', badToken.status === 401, String(badToken.status))

    const status = await fetch(`${base}/status`, { headers: auth })
    const st = (await status.json()) as {
      ok?: boolean
      llama?: { state?: string; code?: string }
      openai?: unknown[]
    }
    check('GET /status 带 token 返回 200', status.status === 200 && st.ok === true, String(status.status))
    check(
      'status.llama.state 是四态之一',
      ['idle', 'loading', 'ready', 'error'].includes(String(st.llama?.state)),
      String(st.llama?.state)
    )
    check('status.llama.code 存在', typeof st.llama?.code === 'string', String(st.llama?.code))
    check('status.openai 是数组', Array.isArray(st.openai))

    // SSE：读到第一帧就算通，不用等状态变化
    const ctrl = new AbortController()
    const es = await fetch(`${base}/events?token=${encodeURIComponent(d.token)}`, { signal: ctrl.signal })
    const reader = es.body?.getReader()
    const first = reader ? await reader.read() : null
    const text = first ? Buffer.from(first.value ?? new Uint8Array()).toString('utf8') : ''
    check('GET /events 推得动 SSE', es.status === 200 && /(event: status|: ping)/.test(text), text.slice(0, 60))
    ctrl.abort()

    const notFound = await fetch(`${base}/nope`, { headers: auth })
    check('未知路径返回 404', notFound.status === 404, String(notFound.status))

    // ---- MCP server：把工具反过来暴露给 Cursor / Cline ----
    const rpc = async (body: unknown) =>
      await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })

    const noAuthMcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    })
    check('POST /mcp 无 token 返回 401', noAuthMcp.status === 401, String(noAuthMcp.status))

    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const initBody = (await init.json()) as {
      result?: { protocolVersion?: string; serverInfo?: { name?: string }; capabilities?: { tools?: unknown } }
    }
    check(
      'MCP initialize 返回协议版本与服务名',
      init.status === 200 && !!initBody.result?.protocolVersion && initBody.result?.serverInfo?.name === 'rorotocode',
      JSON.stringify(initBody).slice(0, 120)
    )
    check('MCP 声明 tools 能力', !!initBody.result?.capabilities?.tools)

    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const listBody = (await list.json()) as { result?: { tools?: Array<{ name?: string; inputSchema?: unknown }> } }
    const names = (listBody.result?.tools ?? []).map((t) => String(t.name))
    check('MCP tools/list 有工具', names.length > 0, String(names.length))
    check('暴露了 read_file 与 repo_map', names.includes('read_file') && names.includes('repo_map'), names.join(','))
    check('不暴露需要界面的 question', !names.includes('question'))
    check(
      '每个工具都带 inputSchema',
      (listBody.result?.tools ?? []).every((t) => !!t.inputSchema)
    )

    const bogus = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'no_such_tool', arguments: {} }
    })
    const bogusBody = (await bogus.json()) as { result?: { isError?: boolean } }
    check('不认识的工具返回 isError', bogusBody.result?.isError === true)

    const notify = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
    check('通知类消息返回 202 且无正文', notify.status === 202, String(notify.status))

    const unknownMethod = await rpc({ jsonrpc: '2.0', id: 4, method: 'nope/nope' })
    const unknownBody = (await unknownMethod.json()) as { error?: { code?: number } }
    check('未知方法返回 -32601', unknownBody.error?.code === -32601, JSON.stringify(unknownBody).slice(0, 80))

    const stop = await fetch(`${base}/stop`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{}'
    })
    const stopBody = (await stop.json()) as { ok?: boolean }
    check('POST /stop 可用', stop.status === 200 && stopBody.ok === true, String(stop.status))

    check('daemonInfo 可读', daemonInfo()?.port === d.port)

    stopDaemon()
    const afterStop = await fetch(`${base}/health`).then(() => true).catch(() => false)
    check('stopDaemon 后端口关闭', afterStop === false)

    console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
    app.exit(failed ? 1 : 0)
  } catch (err) {
    console.error('FAIL 未捕获异常：', err)
    app.exit(1)
  }
})
