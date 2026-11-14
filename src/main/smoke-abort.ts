/**
 * 「停止」的两个致命路径端到端验证。
 *
 * 这两个问题都是「用户点了停止之后才暴露」的，纯函数单测覆盖不到：
 *
 * A. 审批弹窗挂着时点停止。
 *    以前 abort() 只清 question / quota，没碰 approvals，Promise 永远没人 resolve，
 *    send() 的 finally 不执行、并发槽位不释放 —— 这个会话从此永远「运行中」。
 *    断言：abort 后 3 秒内收尾、isRunning 变 false、同一会话还能再次发送。
 *
 * B. 一批工具执行到一半时点停止。
 *    以前循环里直接 `throw 已取消`，已落库的 assistant.tool_calls 留下没有结果的孤儿，
 *    之后每次请求都 400。断言：三个调用全部有结果、历史配对完整。
 */
import { app } from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { AgentEngine } from './agent'
import { loadConfig, saveConfig } from './config'
import * as store from './store'
import { toolPairsIntact } from '../shared/turns'
import type { AgentEvent } from '../shared/types'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let fails = 0
function check(name: string, ok: boolean, extra?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) fails++
}

/** 场景：A = 审批中停止，B = 工具批次中途停止 */
let scenario: 'A' | 'B' = 'A'

async function main(): Promise<void> {
  await app.whenReady()
  const userData = app.getPath('userData')
  const cfgFile = path.join(userData, 'config.json')
  const backup = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile) : null

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rorotocode-abort-'))
  const created: string[] = []

  let calls = 0
  const srv = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString()))
    req.on('end', () => {
      if (!(req.url ?? '').includes('chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"data":[]}')
        return
      }
      calls += 1
      const n = calls
      const frames: unknown[] = []
      if (n === 1 && scenario === 'A') {
        // 写工作区里的文件：普通写操作 → ask 模式下要确认
        frames.push({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_a0',
                    function: {
                      name: 'write_file',
                      arguments: JSON.stringify({ path: 'a.txt', content: 'should not land\n' })
                    }
                  }
                ]
              }
            }
          ]
        })
      } else if (n === 1 && scenario === 'B') {
        // 三条命令：第一条要跑 5 秒，留出「跑到一半点停止」的窗口
        for (let i = 0; i < 3; i++) {
          frames.push({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: i,
                      id: `call_b${i}`,
                      function: {
                        name: 'run_shell',
                        arguments: JSON.stringify({
                          command: i === 0 ? 'ping -n 6 127.0.0.1 >nul' : `echo ${i}`,
                          shell: 'cmd',
                          timeout_ms: 60000
                        })
                      }
                    }
                  ]
                }
              }
            ]
          })
        }
      } else {
        frames.push({ choices: [{ delta: { content: '收到，这一轮正常结束。' } }] })
      }
      frames.push({ choices: [{ delta: {} }], usage: { prompt_tokens: 200, completion_tokens: 20 } })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as { port: number }).port

  const events: AgentEvent[] = []
  // 回调里要回点审批，但 engine 得等构造完才存在。用 ref 中转而不是「先声明后赋值」：
  // 后者会让 engine 变成可写变量，构造期间若同步回调就会读到 undefined。
  let engineRef: AgentEngine | null = null
  const engine = new AgentEngine((_sid, ev) => {
    events.push(ev)
    // 场景 B 需要工具真的跑起来，所以替用户点「本次允许」；
    // 场景 A 故意什么都不点 —— 测的就是弹窗挂着时点停止。
    if (scenario === 'B' && ev.type === 'approval' && !ev.request.quota) {
      setTimeout(() => engineRef?.respondApproval(ev.request.id, true, false), 0)
    }
  })
  engineRef = engine

  try {
    const cfg = await loadConfig()
    cfg.providers = [
      {
        id: 'fake',
        name: '假服务',
        kind: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'x',
        model: 'fake',
        contextWindow: 8192
      }
    ]
    cfg.activeId = 'fake'
    cfg.approvalMode = 'ask'
    cfg.autoVerify = false
    cfg.autoCompact = false
    cfg.autoFallback = false
    cfg.autoContinue = false
    cfg.maxSteps = 6
    cfg.tokenLimitPerRun = 0
    cfg.tokenLimitPerDay = 0
    await saveConfig(cfg)

    const s = await store.createSession(ws)
    created.push(s.id)
    fs.writeFileSync(path.join(ws, 'a.txt'), 'original\n', 'utf8')

    // ── 场景 A：审批弹窗挂着时点停止 ────────────────────────────────
    scenario = 'A'
    calls = 0
    events.length = 0
    const runA = engine.send(s.id, '把 a.txt 改一下').catch((err: Error) => err)
    await sleep(600)
    check('A：确实弹出了审批', events.some((e) => e.type === 'approval'))
    check('A：停止前会话处于运行中', engine.isRunning(s.id) === true)

    const abortAt = Date.now()
    engine.abort(s.id)
    const settled = await Promise.race([
      runA.then(() => true),
      sleep(3000).then(() => false)
    ])
    check('A：停止后 3 秒内收尾（不再永久挂起）', settled, `${Date.now() - abortAt}ms`)
    check('A：运行状态已释放', engine.isRunning(s.id) === false)
    check('A：弹窗被撤下', events.some((e) => e.type === 'approval_dismiss'))
    check(
      'A：待确认的操作没有执行',
      fs.readFileSync(path.join(ws, 'a.txt'), 'utf8') === 'original\n'
    )

    // 关键回归：以前这里会抛「这个会话正在运行中」
    const again = await engine.send(s.id, '再试一次，什么都不用改').catch((err: Error) => err)
    check('A：同一会话还能继续发送（锁已释放）', !(again instanceof Error), String(again))

    // ── 场景 B：一批工具执行到一半点停止 ────────────────────────────
    scenario = 'B'
    calls = 0
    events.length = 0
    const b = await store.createSession(ws)
    created.push(b.id)
    const runB = engine.send(b.id, '跑三条命令').catch((err: Error) => err)
    await sleep(1100)
    engine.abort(b.id)
    await Promise.race([runB, sleep(8000)])
    await sleep(300)

    const after = await store.loadSession(b.id)
    const tools = after.messages.filter((m) => m.role === 'tool')
    check('B：三个调用都补上了结果', tools.length === 3, `实际 ${tools.length}`)
    check('B：历史里 tool_calls 与结果严格配对（否则下次请求 400）', toolPairsIntact(after.messages))
    const skipped = tools.filter((m) => (m.content ?? '').includes('没有执行') || (m.content ?? '').includes('已取消'))
    check('B：没跑的那些有明确说明', skipped.length >= 2, `实际 ${skipped.length}`)

    const againB = await engine.send(b.id, '继续').catch((err: Error) => err)
    check('B：中断后还能继续发送', !(againB instanceof Error), String(againB))
  } finally {
    if (backup) fs.writeFileSync(cfgFile, backup)
    try {
      srv.close()
    } catch {
      // 忽略
    }
    // 会话与临时目录都清掉，别把测试数据留在用户目录里
    for (const id of created) {
      const f = path.join(userData, 'sessions', `${id}.json`)
      if (fs.existsSync(f)) fs.rmSync(f, { force: true })
    }
    fs.rmSync(ws, { recursive: true, force: true })
    console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`)
    app.exit(fails === 0 ? 0 : 1)
  }
}

void main()
