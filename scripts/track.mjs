#!/usr/bin/env node
/**
 * 跟踪器：起一个会话 → 发任务 → 把 SSE 事件全部落盘，并按类型统计。
 *
 * 用法：node scripts/track.mjs <port> <token> <workspace> <promptFile> <outFile>
 *
 * 关注点（这一轮要回答的问题）：
 *  - 有没有 task 调用、subagent_start / subagent_end 事件 —— 子 agent 到底参不参与
 *  - 写文件类工具的结果里有没有语法错误、浏览器验收失败（门禁是否真的在拦）
 *  - run_shell 被门禁拒绝了几次（shell 绕过是否被堵住）
 */
import fs from 'node:fs'

const [port, token, workspace, promptFile, outFile] = process.argv.slice(2)
if (!port || !token || !workspace || !promptFile) {
  console.error('usage: node scripts/track.mjs <port> <token> <workspace> <promptFile> [outFile]')
  process.exit(1)
}
const base = `http://127.0.0.1:${port}`
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
const out = outFile || 'track.log'
fs.writeFileSync(out, '')

const stats = {
  events: 0,
  byType: {},
  tools: {},
  shellBlocked: 0,
  htmlIssues: 0,
  webFails: 0,
  subagentStarts: [],
  subagentEnds: [],
  taskCalls: 0,
  todos: []
}

function log(obj) {
  fs.appendFileSync(out, `${new Date().toISOString()} ${JSON.stringify(obj)}\n`)
}

async function main() {
  const prompt = fs.readFileSync(promptFile, 'utf8')
  const sr = await fetch(`${base}/chat/session`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ workspace })
  })
  const session = await sr.json()
  const sid = session.sessionId ?? session.id ?? session.session?.id
  log({ phase: 'session', sid, session })
  if (!sid) throw new Error('没拿到 sessionId：' + JSON.stringify(session))

  const ctrl = new AbortController()
  const es = await fetch(`${base}/chat/events?session=${sid}&token=${token}`, {
    headers: { Accept: 'text/event-stream' },
    signal: ctrl.signal
  })
  const reader = es.body.getReader()
  const dec = new TextDecoder()
  let buf = ''

  const consume = (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const dataLines = raw
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
      if (!dataLines.length) continue
      let ev
      try {
        ev = JSON.parse(dataLines.join('\n'))
      } catch {
        continue
      }
      handle(ev)
    }
  }

  function handle(ev) {
    stats.events += 1
    stats.byType[ev.type] = (stats.byType[ev.type] ?? 0) + 1
    switch (ev.type) {
      case 'tool_start':
        stats.tools[ev.tool] = (stats.tools[ev.tool] ?? 0) + 1
        log({ phase: 'tool_start', tool: ev.tool, args: brief(ev.args) })
        if (ev.tool === 'task') {
          stats.taskCalls += 1
          log({ phase: 'TASK_CALL', args: ev.args })
        }
        break
      case 'tool_result': {
        const text = String(ev.result ?? '')
        log({
          phase: 'tool_result',
          tool: ev.tool,
          ok: ev.ok,
          ms: ev.durationMs,
          head: text.slice(0, 400)
        })
        if (/已拒绝执行：这条命令要直接改写源码/.test(text)) stats.shellBlocked += 1
        if (/语法错误/.test(text)) stats.htmlIssues += 1
        if (/打开时报错|白屏|控制台报错/.test(text)) stats.webFails += 1
        break
      }
      case 'subagent_start':
        stats.subagentStarts.push(ev.task)
        log({ phase: 'SUBAGENT_START', task: ev.task })
        break
      case 'subagent_end':
        stats.subagentEnds.push(ev.task)
        log({ phase: 'SUBAGENT_END', task: ev.task })
        break
      case 'subagent_step':
        log({ phase: 'subagent_step', task: ev.task, tool: ev.tool })
        break
      case 'todos':
        stats.todos.push(ev.items?.map((i) => `${i.status}:${i.text ?? i.title ?? ''}`) ?? [])
        log({ phase: 'todos', items: ev.items })
        break
      case 'delta':
        break
      case 'done':
        log({ phase: 'done', ev })
        break
      default:
        log({ phase: ev.type, ev: brief(ev) })
    }
  }

  function brief(v) {
    const s = JSON.stringify(v ?? null)
    return s && s.length > 600 ? s.slice(0, 600) + '…' : s
  }

  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        consume(dec.decode(value, { stream: true }))
      }
    } catch {
      /* aborted */
    }
  })()

  await fetch(`${base}/chat/send`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ sessionId: sid, text: prompt, approvalPolicy: 'allow' })
  })
  log({ phase: 'sent' })

  // 一直跟到 done 事件或超时（默认 25 分钟）
  const deadline = Date.now() + Number(process.env.TRACK_MS ?? 25 * 60 * 1000)
  let lastCount = -1
  let idleSince = Date.now()
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    if (stats.events !== lastCount) {
      lastCount = stats.events
      idleSince = Date.now()
    }
    if (stats.byType.done) {
      // done 之后再等一小会儿收尾事件
      await new Promise((r) => setTimeout(r, 3000))
      break
    }
    if (Date.now() - idleSince > 180000) {
      log({ phase: 'idle-timeout' })
      break
    }
  }
  ctrl.abort()
  await pump
  fs.writeFileSync(out.replace(/\.log$/, '.summary.json'), JSON.stringify(stats, null, 2))
  console.log(JSON.stringify(stats, null, 2))
}

main().catch((e) => {
  console.error('track failed:', e)
  process.exit(1)
})
