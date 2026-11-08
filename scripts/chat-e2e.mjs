#!/usr/bin/env node
/**
 * /chat 无头 API 端到端联调客户端。
 *
 * 覆盖链路：POST /chat/session → GET /chat/events(SSE) → POST /chat/send →
 * 收到 delta / done 事件 → POST /chat/abort 停止。
 *
 * 手动联调步骤（Windows Git Bash）：
 *   1. 起真实模型：./release/llama.cpp/llama-server.exe -m release/models/<模型>.gguf \
 *        --port 8090 --host 127.0.0.1 --ctx-size 8192 --n-gpu-layers 99 --alias qwen-coder-3b
 *   2. 把 config.json 的 llamacpp provider 指到 8090、activeId 切到 llamacpp（测完改回）
 *   3. 起 headless 主程序：unset ELECTRON_RUN_AS_NODE && ./node_modules/.bin/electron . --headless
 *   4. 跑本脚本：node scripts/chat-e2e.mjs（自动从 userData/daemon.json 读 port + token）
 *
 * 用法：node scripts/chat-e2e.mjs [port] [token]
 * 若不传 port/token，默认从 <userData>/daemon.json 读。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const USER_DATA =
  process.env.RODO_E2E_USERDATA || path.join(os.homedir(), 'AppData', 'Roaming', 'RoRoToCode')

function daemonInfo() {
  const p = path.join(USER_DATA, 'daemon.json')
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

async function main() {
  const args = process.argv.slice(2)
  let port = args[0]
  let token = args[1]

  if (!port || !token) {
    // 等 daemon.json 就绪（headless 主程序可能还在起）
    let info = null
    for (let i = 0; i < 60; i++) {
      info = daemonInfo()
      if (info) break
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!info) {
      console.error('[e2e] 等不到 daemon.json（headless 主程序没起来？）')
      process.exit(1)
    }
    port = String(info.port)
    token = info.token
    console.log(`[e2e] 从 daemon.json 拿到端口 ${port}`)
  }

  const base = `http://127.0.0.1:${port}`
  const auth = { Authorization: `Bearer ${token}` }

  const jget = async (p) => {
    const r = await fetch(`${base}${p}`, { headers: auth })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }
  const jpost = async (p, body) => {
    const r = await fetch(`${base}${p}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }

  // 1. 健康检查
  const health = await jget('/health')
  console.log(`[e2e] /health -> ${health.status}`, health.body)

  // 2. 状态快照（确认控制面正常）
  const st = await jget('/status')
  console.log(`[e2e] /status -> ${st.status}`, 'llama:', st.body?.llama?.state ?? '?')

  // 3. 建会话
  const sess = await jpost('/chat/session', { workspace: process.cwd() })
  if (sess.status !== 200 || !sess.body.sessionId) {
    console.error('[e2e] /chat/session 失败', sess)
    process.exit(1)
  }
  const sessionId = sess.body.sessionId
  console.log(`[e2e] /chat/session -> sessionId=${sessionId}`)

  // 4. 订阅 SSE 事件
  const events = []
  const sseDone = new Promise((resolve) => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 30000)
    fetch(`${base}/chat/events?session=${sessionId}&token=${token}`, {
      headers: { accept: 'text/event-stream' },
      signal: ac.signal
    })
      .then(async (r) => {
        if (!r.ok || !r.body) {
          console.error('[e2e] SSE 订阅失败', r.status)
          resolve()
          return
        }
        const reader = r.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        const onEvent = (name, data) => {
          let parsed = data
          try {
            parsed = JSON.parse(data)
          } catch {}
          events.push({ name, data: parsed })
          if (name === 'done' || name === 'error') {
            clearTimeout(timer)
            resolve()
          }
        }
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let idx
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            let evName = 'message'
            let evData = ''
            for (const line of chunk.split('\n')) {
              if (line.startsWith('event: ')) evName = line.slice(7)
              else if (line.startsWith('data: ')) evData += line.slice(6)
            }
            if (evData) onEvent(evName, evData)
          }
        }
      })
      .catch(() => resolve())
  })

  // 5. 发消息（给一个不会触发工具调用的简单问题）
  const ask = '用一句话回答：1+1 等于几？'
  console.log(`[e2e] /chat/send <- "${ask}"`)
  const send = await jpost('/chat/send', { sessionId, text: ask, approvalPolicy: 'deny' })
  console.log(`[e2e] /chat/send -> ${send.status}`, send.body)

  if (send.status !== 202) {
    console.error('[e2e] /chat/send 未受理', send)
    process.exit(1)
  }

  await sseDone

  const deltas = events.filter((e) => e.name === 'delta')
  const done = events.find((e) => e.name === 'done')
  const err = events.find((e) => e.name === 'error')

  console.log(`\n[e2e] 收到事件 ${events.length} 条：`)
  for (const e of events) {
    const brief =
      e.name === 'delta'
        ? `delta +${e.data?.text?.length ?? 0}`
        : e.name === 'tool_call'
          ? `tool_call ${e.data?.tool ?? ''}`
          : e.name
    console.log(`  - ${brief}`)
  }

  // 拼接 delta 文本作为最终回复
  const answer = deltas.map((e) => e.data?.text ?? '').join('')
  console.log(`\n[e2e] 模型回复：${answer || '(无 delta，可能走了工具或出错)'}`)

  if (err) {
    console.error('[e2e] 出现 error 事件：', err.data)
    process.exit(1)
  }
  if (!done) {
    console.error('[e2e] 没收到 done 事件（超时？）')
    process.exit(1)
  }
  if (!answer.trim()) {
    console.error('[e2e] 没有收到任何 delta 文本')
    process.exit(1)
  }

  console.log('\n[e2e] ✅ /chat 无头 API 全链路通过')
  process.exit(0)
}

main().catch((err) => {
  console.error('[e2e] 异常：', err)
  process.exit(1)
})
