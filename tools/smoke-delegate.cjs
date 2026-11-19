/**
 * 在普通 node 里跑起引擎的端到端验证（不需要真的 Electron 窗口）。
 *
 * 为什么要这么绕：本机的 electron 启动不了（连已有的 smoke-repeat 都报
 * `app.whenReady` 未定义），但那不代表链路没通。engine/agent/store/config
 * 都只在**调用时**才碰 electron API，所以先把 'electron' 换成桩，再驱动
 * 真实引擎跑一轮，就能验证「提醒 → 派发 → 子 agent → 结论回父会话」。
 *
 * 用法：node tools/smoke-delegate.cjs
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const Module = require('node:module')

/** electron 桩：只提供引擎真正会用到的几个入口 */
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'rorotocode-ud-'))
const electronStub = {
  app: {
    getPath: () => tmpUserData,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    getVersion: () => '0.0.0-test',
    whenReady: async () => undefined,
    on: () => undefined,
    exit: (code) => process.exit(code),
    quit: () => process.exit(0)
  },
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: { openExternal: async () => undefined },
  BrowserWindow: class {}
}
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub
  return origLoad.call(this, request, ...rest)
}

const DIST = path.join(__dirname, '..', 'dist', 'main')
const { AgentEngine } = require(path.join(DIST, 'agent.js'))
const { loadConfig, saveConfig } = require(path.join(DIST, 'config.js'))
const store = require(path.join(DIST, 'store.js'))

let fails = 0
const check = (name, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) fails++
}

function lastUserContent(body) {
  try {
    const parsed = JSON.parse(body)
    const list = parsed.messages ?? []
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role !== 'user') continue
      const c = list[i].content
      if (typeof c === 'string') return c
      if (Array.isArray(c)) return c.map((p) => (p && p.text) || '').join('\n')
      return ''
    }
  } catch {
    /* 忽略：解析失败说明不是 chat 请求 */
  }
  return ''
}

async function main() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rorotocode-delegate-ws-'))
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello\n', 'utf8')

  const parentPrompts = []
  let childRequests = 0

  const srv = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c.toString()))
    req.on('end', () => {
      if (!(req.url ?? '').includes('chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"data":[]}')
        return
      }
      const frames = []
      if (raw.includes('你是子 agent')) {
        childRequests += 1
        if (childRequests === 1) {
          frames.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'child_read', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) } }] } }] })
        } else if (childRequests === 2) {
          frames.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'child_write', function: { name: 'write_file', arguments: JSON.stringify({ path: 'x.txt', content: 'nope' }) } }] } }] })
        } else {
          frames.push({ choices: [{ delta: { content: '查完了：a.txt 里是 hello，没发现问题。' } }] })
        }
      } else {
        parentPrompts.push(lastUserContent(raw))
        if (parentPrompts.length === 1) {
          frames.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'parent_task', function: { name: 'task', arguments: JSON.stringify({ description: '审查 a.txt', prompt: '读 a.txt，说明里面写了什么、有没有问题。', mode: 'explore' }) } }] } }] })
        } else {
          frames.push({ choices: [{ delta: { content: '看完了，没问题。' } }] })
        }
      }
      frames.push({ choices: [{ delta: {} }], usage: { prompt_tokens: 120, completion_tokens: 20 } })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port

  const events = []
  const engine = new AgentEngine((_sid, ev) => {
    events.push(ev)
    if (ev.type === 'approval' && !ev.request.quota) {
      setTimeout(() => engine.respondApproval(ev.request.id, true, false), 0)
    }
  })
  const created = []
  try {
    const cfg = await loadConfig()
    cfg.providers = [{ id: 'fake', name: '假服务', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', model: 'fake', contextWindow: 8192 }]
    cfg.activeId = 'fake'
    cfg.workspace = ws
    cfg.approvalMode = 'auto'
    cfg.autoVerify = false
    cfg.autoCompact = false
    cfg.autoFallback = false
    cfg.autoContinue = false
    cfg.autoDelegate = true
    cfg.maxSteps = 12
    cfg.tokenLimitPerRun = 0
    cfg.tokenLimitPerDay = 0
    await saveConfig(cfg)

    const a = await store.createSession(ws)
    created.push(a.id)
    await Promise.race([
      engine.send(a.id, '检查这个项目的配置读取和错误处理有没有问题'),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`这一轮没在 25 秒内结束，父请求数：${parentPrompts.length}`)), 25000))
    ])

    const session = await store.loadSession(a.id)
    const toolMsgs = session.messages.filter((m) => m.role === 'tool')
    const taskResult = toolMsgs.find((m) => m.toolName === 'task')
    const subStart = events.filter((e) => e.type === 'subagent_start')
    const subEnd = events.filter((e) => e.type === 'subagent_end')
    const allContent = toolMsgs.map((m) => m.content ?? '').join('\n')

    if (process.env.DELEGATE_DEBUG === '1') {
      console.log('[dbg] 父请求数：', parentPrompts.length, ' 子请求数：', childRequests)
      console.log('[dbg] 首个父请求尾部：\n', (parentPrompts[0] ?? '').slice(-320))
      for (const m of toolMsgs) console.log(`[dbg] ${m.toolName}: ${(m.content ?? '').slice(0, 110)}`)
    }

    check('审查意图的首个请求带上了【自动派发】提醒', (parentPrompts[0] ?? '').includes('【自动派发】'))
    check('提醒里点名只读模式', (parentPrompts[0] ?? '').includes('mode=explore'))
    check('模型据此派了 task', Boolean(taskResult), taskResult ? '有 task 结果' : '没有')
    check('子 agent 真的起来过', subStart.length >= 1, `${subStart.length} 次 start`)
    check('子 agent 正常收工', subEnd.some((e) => e.task.status === 'ok'), subEnd.map((e) => e.task.status).join(','))
    check('子 agent 的 read_file 真的执行了', allContent.includes('hello'))
    check('子 agent 的 write_file 被只读模式拦下', allContent.includes('只读探查') || allContent.includes('只读模式'))
    check('没有真的写出 x.txt', !fs.existsSync(path.join(ws, 'x.txt')))
    check('结论回到了父会话', (taskResult?.content ?? '').includes('hello'), (taskResult?.content ?? '').slice(0, 70))

    // 寒暄不该再提醒
    const b = await store.createSession(ws)
    created.push(b.id)
    parentPrompts.length = 0
    await Promise.race([
      engine.send(b.id, '你好'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('第二条消息没在 15 秒内结束')), 15000))
    ])
    check('寒暄消息不再注入提醒', !(parentPrompts[0] ?? '').includes('【自动派发】'))
  } finally {
    const trash = path.join(tmpUserData, 'sessions', '.trash')
    fs.mkdirSync(trash, { recursive: true })
    for (const id of created) {
      const f = path.join(tmpUserData, 'sessions', `${id}.json`)
      if (fs.existsSync(f)) fs.renameSync(f, path.join(trash, `${id}.json`))
    }
    fs.rmSync(ws, { recursive: true, force: true })
    srv.closeAllConnections?.()
    srv.close()
  }

  console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
  process.exit(fails ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
