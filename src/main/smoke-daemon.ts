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
