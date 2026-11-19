#!/usr/bin/env node
/**
 * attach 跟踪器：挂到【正在运行】的会话上，只消费 SSE 事件，不发新任务、不干扰。
 * 用法：node scripts/attach.mjs <port> <token> <sessionId> <outFile> [maxMs]
 */
import fs from 'node:fs'

const [port, token, sid, outFile, maxMsEnv] = process.argv.slice(2)
if (!port || !token || !sid) {
  console.error('usage: node scripts/attach.mjs <port> <token> <sessionId> <outFile> [maxMs]')
  process.exit(1)
}
const base = `http://127.0.0.1:${port}`
const out = outFile || 'attach.log'
fs.writeFileSync(out, '')

const stats = {
  events: 0,
  byType: {},
  tools: {},
  toolFail: [],
  shellBlocked: 0,
  htmlIssues: 0,
  webFails: 0,
  subagentStarts: [],
  subagentEnds: [],
  taskCalls: 0,
  errors: [],
  done: null,
  firstEventAt: null,
  lastEventAt: null,
  todoSnapshots: []
}
function log(obj) {
  fs.appendFileSync(out, `${new Date().toISOString()} ${JSON.stringify(obj)}\n`)
}
function brief(v) {
  const s = JSON.stringify(v ?? null)
  return s && s.length > 800 ? s.slice(0, 800) + '…' : s
}

async function main() {
  const ctrl = new AbortController()
  const es = await fetch(`${base}/chat/events?session=${sid}&token=${token}`, {
    headers: { Accept: 'text/event-stream' },
    signal: ctrl.signal
  })
  if (!es.ok || !es.body) throw new Error('attach 失败 HTTP ' + es.status + ' ' + (await es.text().catch(() => '')))
  log({ phase: 'attached', sid })

  const reader = es.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let block = null
  let evtType = ''

  function handle(ev) {
    stats.events += 1
    stats.lastEventAt = new Date().toISOString()
    if (!stats.firstEventAt) stats.firstEventAt = stats.lastEventAt
    const type = ev.type ?? evtType ?? 'raw'
    stats.byType[type] = (stats.byType[type] ?? 0) + 1
    switch (type) {
      case 'tool_start':
        stats.tools[ev.tool] = (stats.tools[ev.tool] ?? 0) + 1
        log({ phase: 'tool_start', tool: ev.tool, args: brief(ev.args) })
        if (ev.tool === 'task') { stats.taskCalls += 1; log({ phase: 'TASK_CALL', args: ev.args }) }
        break
      case 'tool_result': {
        const text = String(ev.result ?? '')
        const ok = ev.ok
        log({ phase: 'tool_result', tool: ev.tool, ok, ms: ev.durationMs, head: text.slice(0, 500) })
        if (ok === false || /失败|错误|error|Error|ENOENT|not found/.test(text)) {
          stats.toolFail.push({ tool: ev.tool, head: text.slice(0, 300) })
        }
        if (/已拒绝执行：这条命令要直接改写源码/.test(text)) stats.shellBlocked += 1
        if (/语法错误|SyntaxError/.test(text)) stats.htmlIssues += 1
        if (/打开时报错|白屏|控制台报错/.test(text)) stats.webFails += 1
        break
      }
      case 'subagent_start': stats.subagentStarts.push(ev.task); log({ phase: 'SUBAGENT_START', task: ev.task }); break
      case 'subagent_end': stats.subagentEnds.push(ev.task); log({ phase: 'SUBAGENT_END', task: ev.task }); break
      case 'subagent_step': log({ phase: 'subagent_step', task: ev.task, tool: ev.tool }); break
      case 'todos': stats.todoSnapshots.push((ev.items ?? []).map((i) => `${i.status ?? i.state ?? '?'}:${i.content ?? i.text ?? i.title ?? ''}`)); log({ phase: 'todos', items: ev.items }); break
      case 'error': stats.errors.push(brief(ev)); log({ phase: 'ERROR', ev }); break
      case 'file_change': log({ phase: 'file_change', path: ev.path ?? ev.file ?? ev.filePath, action: ev.action ?? ev.kind }); break
      case 'done': stats.done = ev; log({ phase: 'done', ev }); break
      case 'delta': break
      case 'gen_progress': break
      default: log({ phase: type, ev: brief(ev) })
    }
  }

  function consume(chunk) {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      block = raw
      evtType = ''
      const dataLines = []
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) evtType = line.slice(6).trim()
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      if (!dataLines.length) continue
      let ev
      try { ev = JSON.parse(dataLines.join('\n')) } catch { continue }
      handle(ev)
    }
  }

  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        consume(dec.decode(value, { stream: true }))
      }
    } catch { /* aborted */ }
  })()

  const maxMs = Number(maxMsEnv || 25 * 60 * 1000)
  const deadline = Date.now() + maxMs
  let lastCount = -1
  let idleSince = Date.now()
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    if (stats.events !== lastCount) { lastCount = stats.events; idleSince = Date.now() }
    // 落盘进度快照，方便外部随时读取
    fs.writeFileSync(out.replace(/\.log$/, '.progress.json'), JSON.stringify(stats, null, 2))
    if (stats.done) { await new Promise((r) => setTimeout(r, 2500)); break }
    if (Date.now() - idleSince > 240000) { log({ phase: 'idle-timeout' }); break }
  }
  ctrl.abort()
  await pump.catch(() => {})
  fs.writeFileSync(out.replace(/\.log$/, '.summary.json'), JSON.stringify(stats, null, 2))
  console.log(JSON.stringify(stats, null, 2))
}
main().catch((e) => { console.error('attach failed:', e); process.exit(1) })
