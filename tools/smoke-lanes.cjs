/**
 * 端到端验证：并发路数只认一个数（`laneCount`），且刚被限流的 worker 会被跳过。
 *
 * 复现的是真实现场：主模型在云端、只配了 1 个云端 worker。改动前系统提示按
 * 「配了几个」判断，教模型「同一轮连写 2～3 个」，执行层上限却是 1 ——
 * 几路只读审查排队串行，还全撞在同一家限流上。
 *
 * 这里跑真引擎 + 两个假服务（主模型正常、worker 恒 429），检查：
 * 1. 首轮发给模型的 system 提示里说的是「只放得下 1 路」，不是「能真正并行」；
 * 2. 自动派发文案也只让派 1 个；
 * 3. worker 429 后子任务自动回落到主模型，任务仍能完成（不白跑一轮）；
 * 4. 回落之后 workerPool 已把这家标成冷却，下一批活不会再压给它。
 *
 * 用法：node tools/smoke-lanes.cjs
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const Module = require('node:module')

/** electron 桩：引擎只在调用时碰这些接口（理由见 tools/smoke-delegate.cjs） */
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
const { workerPool } = require(path.join(DIST, 'worker.js'))
const { providerCooling } = require(path.join(DIST, 'health.js'))
const store = require(path.join(DIST, 'store.js'))

let fails = 0
const check = (name, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) fails++
}

const sse = (res, frames) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

/** 从请求体里取 system 提示和最后一条 user 内容 */
function parseBody(raw) {
  try {
    const body = JSON.parse(raw)
    const list = body.messages ?? []
    const sys = list.find((m) => m.role === 'system')
    const sysText = typeof sys?.content === 'string' ? sys.content : ''
    let user = ''
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role !== 'user') continue
      const c = list[i].content
      user = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text ?? '').join('\n') : ''
      break
    }
    return { sysText, user }
  } catch {
    return { sysText: '', user: '' }
  }
}

async function listen(handler) {
  const srv = http.createServer(handler)
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return srv
}

async function main() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rorotocode-lanes-ws-'))
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello\n', 'utf8')

  const systemPrompts = []
  const delegateNotes = []
  let parentRequests = 0
  let workerRequests = 0
  let childOnMain = 0

  // 主模型：正常服务（先派 task，之后正常作答）
  const mainSrv = await listen((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c.toString()))
    req.on('end', () => {
      if (!(req.url ?? '').includes('chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"data":[]}')
        return
      }
      // 子 agent 回落到主模型后也走这台服务：直接给结论，不再要工具
      if (raw.includes('你是子 agent')) {
        childOnMain += 1
        sse(res, [{ choices: [{ delta: { content: '查完了：a.txt 里是 hello，没发现问题。' } }] }])
        return
      }
      const { sysText, user } = parseBody(raw)
      systemPrompts.push(sysText)
      delegateNotes.push(user)
      parentRequests += 1
      if (parentRequests === 1) {
        sse(res, [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'parent_task',
                      function: {
                        name: 'task',
                        arguments: JSON.stringify({
                          description: '审查 a.txt',
                          prompt: '读 a.txt，说明里面写了什么、有没有问题。',
                          mode: 'explore'
                        })
                      }
                    }
                  ]
                }
              }
            ]
          }
        ])
        return
      }
      sse(res, [{ choices: [{ delta: { content: '看完了，没问题。' } }] }])
    })
  })

  // worker：恒 429，模拟「唯一那个子智能体正在被限流」
  const workerSrv = await listen((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c.toString()))
    req.on('end', () => {
      if (!(req.url ?? '').includes('chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      workerRequests += 1
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }))
    })
  })

  const mainPort = mainSrv.address().port
  const workerPort = workerSrv.address().port

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
    cfg.providers = [
      {
        id: 'main',
        name: '主模型',
        kind: 'openai',
        baseUrl: `http://127.0.0.1:${mainPort}/v1`,
        apiKey: 'x',
        model: 'gpt-4o-test',
        contextWindow: 16384
      },
      {
        id: 'wk',
        name: '唯一 worker',
        kind: 'openai',
        baseUrl: `http://127.0.0.1:${workerPort}/v1`,
        apiKey: 'x',
        model: 'worker-test',
        role: 'worker',
        contextWindow: 8192
      }
    ]
    cfg.activeId = 'main'
    cfg.workspace = ws
    cfg.approvalMode = 'auto'
    cfg.autoVerify = false
    cfg.autoCompact = false
    cfg.autoFallback = false
    cfg.autoContinue = false
    cfg.autoDelegate = true
    cfg.maxSteps = 10
    cfg.tokenLimitPerRun = 0
    cfg.tokenLimitPerDay = 0
    await saveConfig(cfg)

    const a = await store.createSession(ws)
    created.push(a.id)
    await Promise.race([
      engine.send(a.id, '检查这个项目的配置读取和错误处理有没有问题'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('这一轮没在 30 秒内结束')), 30000))
    ])

    const session = await store.loadSession(a.id)
    const taskResult = session.messages.find((m) => m.role === 'tool' && m.toolName === 'task')
    const subEnd = events.filter((e) => e.type === 'subagent_end')

    if (process.env.LANES_DEBUG === '1') {
      console.log('[dbg] 父请求', parentRequests, 'worker 请求', workerRequests, '回落主模型', childOnMain)
      console.log('[dbg] system 摘要：', systemPrompts[0]?.split('\n').find((l) => l.includes('个子智能体，')))
      console.log('[dbg] task 结果：', (taskResult?.content ?? '').slice(0, 160))
    }

    const sys = systemPrompts[0] ?? ''
    check('system 提示说「只放得下 1 路」', sys.includes('本次同时只放得下 1 路'))
    check('system 提示不再说「可以真正并行」', !sys.includes('可以真正并行'))
    check('拆分规则改成「拆成几个 task」而非「一起派出去」', sys.includes('就拆成几个 task 派出去'))
    check('自动派发文案只让派 1 个', /派 1 个/.test(delegateNotes[0] ?? '') && !/2～3 个/.test(delegateNotes[0] ?? ''))
    check('worker 真被打了（不是没派过去）', workerRequests >= 1, `${workerRequests} 次`)
    check('worker 429 后子任务自动回落主模型', childOnMain >= 1)
    check('子任务最终成功收工', subEnd.some((e) => e.task.status === 'ok'), subEnd.map((e) => e.task.status).join(','))
    check('结论回到了父会话', (taskResult?.content ?? '').includes('hello'))
    check('卡片上写明了回退原因', ((taskResult?.content ?? '') + JSON.stringify(subEnd)).includes('主模型'))

    // 冷却：下一批活不会再压给这家
    const since = providerCooling('wk')
    check('失败后 worker 进入冷却', Boolean(since), since ? `${since.seconds}s` : '没有')
    const pool = await workerPool(cfg.providers[0], cfg)
    check('workerPool 已跳过它', pool.pool.length === 0 && pool.skipped.some((s) => s.cooling))
  } finally {
    const trash = path.join(tmpUserData, 'sessions', '.trash')
    fs.mkdirSync(trash, { recursive: true })
    for (const id of created) {
      const f = path.join(tmpUserData, 'sessions', `${id}.json`)
      if (fs.existsSync(f)) fs.renameSync(f, path.join(trash, `${id}.json`))
    }
    fs.rmSync(ws, { recursive: true, force: true })
    mainSrv.closeAllConnections?.()
    mainSrv.close()
    workerSrv.closeAllConnections?.()
    workerSrv.close()
  }

  console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
  process.exit(fails ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
