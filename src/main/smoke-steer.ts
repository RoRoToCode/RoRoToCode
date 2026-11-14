/**
 * 运行中插话（steer）的端到端验证。
 *
 * 单测只能测中断信号的合并，测不到「工具真的停了、剩下没跑的工具补了占位结果、
 * 下一轮请求没有因为缺 tool 消息而 400」。所以这里起一个假的 OpenAI 兼容服务，
 * 让模型一次吐出 3 个工具调用（第一个是 5 秒的长等待），跑到一半插话。
 *
 * 关键断言：
 *   1. 正在跑的命令真的被 kill（结果文案是「被打断」，不是「跑完了」）
 *   2. 没轮到的两个工具补了占位结果（少了下一步就 400）
 *   3. 插话落成一条 user 消息并进了下一次模型请求
 *   4. 会话没在跑时 steer 返回 false（界面据此退回普通发送）
 */
import { app } from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { AgentEngine } from './agent'
import { loadConfig, saveConfig } from './config'
import * as store from './store'
import type { AgentEvent } from '../shared/types'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let fails = 0
function check(name: string, ok: boolean, extra?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) fails++
}

async function main(): Promise<void> {
  await app.whenReady()
  const userData = app.getPath('userData')
  const cfgFile = path.join(userData, 'config.json')
  const backup = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile) : null

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rorotocode-steer-'))
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello\n', 'utf8')

  /** 每次 chat/completions 的请求体，用来核对插话有没有进到下一次请求里 */
  const reqs: Array<{ messages: Array<{ role: string; content: string }> }> = []
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
      try {
        reqs.push(JSON.parse(raw) as { messages: Array<{ role: string; content: string }> })
      } catch {
        reqs.push({ messages: [] })
      }

      const frames: unknown[] = []
      if (n === 1) {
        /**
         * 一次三个调用，全部指向同一条长命令。引擎会逐个执行：
         * 第一个跑起来就占住 5 秒，正好留出插话的窗口；后两个排在后面。
         */
        const arg = JSON.stringify({ command: 'ping -n 6 127.0.0.1 >nul', shell: 'cmd', timeout_ms: 60000 })
        for (let i = 0; i < 3; i++) {
          frames.push({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: i, id: `call_${n}_${i}`, function: { name: 'run_shell', arguments: arg } }
                  ]
                }
              }
            ]
          })
        }
      } else {
        frames.push({ choices: [{ delta: { content: '已经改成看 b.txt 了。' } }] })
      }
      frames.push({ choices: [{ delta: {} }], usage: { prompt_tokens: 300, completion_tokens: 40 } })

      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as { port: number }).port

  const events: AgentEvent[] = []
  const engine: AgentEngine = new AgentEngine((_sid, ev) => {
    events.push(ev)
    // run_shell 属于高危操作，auto 模式也会先问一句；这里代替用户点「本次允许」
    if (ev.type === 'approval' && !ev.request.quota) {
      setTimeout(() => engine.respondApproval(ev.request.id, true, false), 0)
    }
  })

  const created: string[] = []
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
    cfg.approvalMode = 'auto'
    cfg.autoVerify = false
    cfg.autoCompact = false
    cfg.autoFallback = false
    cfg.autoContinue = false
    cfg.maxSteps = 6
    cfg.tokenLimitPerRun = 0
    cfg.tokenLimitPerDay = 0
    await saveConfig(cfg)

    const a = await store.createSession(ws)
    created.push(a.id)

    // 没在跑的时候插话必须被拒绝，界面据此改走普通发送
    check('会话空闲时 steer 返回 false', engine.steer(a.id, '随便说一句') === false)

    const startedAt = Date.now()
    const run = engine.send(a.id, '把 a.txt 处理一下')
    // 等第一个工具真的跑起来再插话，否则断的是「还没开始的动作」，测不到 kill
    await sleep(900)
    const accepted = engine.steer(a.id, '别等了，直接去看 b.txt')
    check('运行中 steer 被接受', accepted === true)
    /**
     * 兜底：这一轮如果因为断言之外的原因挂住，宁可报错也不要让冒烟卡在那里
     * （卡住时 shell 层会杀掉整个进程，什么输出都拿不到，等于白跑）。
     */
    await Promise.race([
      run,
      sleep(20000).then(() => {
        throw new Error(`这一轮没在 20 秒内结束，事件：${events.map((e) => e.type).join(',')}`)
      })
    ])

    const session = await store.loadSession(a.id)
    const tools = session.messages.filter((m) => m.role === 'tool')
    const users = session.messages.filter((m) => m.role === 'user')
    if (process.env.STEER_DEBUG === '1') {
      for (const t of tools) console.log(`[dbg] ${t.toolName}: ${(t.content ?? '').slice(0, 70)}`)
    }

    check('插话落成了一条 user 消息', users.some((m) => m.content.includes('直接去看 b.txt')))
    check('插话通过事件通知了界面', events.some((e) => e.type === 'steer' && e.text.includes('b.txt')))

    check('三个调用都补上了结果（缺一条下一步就 400）', tools.length === 3, `实际 ${tools.length}`)
    /**
     * 光看文案不够：命令本身要跑 5 秒，如果没真打断，这一轮至少 5 秒才结束。
     * 900ms 插话，整轮压在 4 秒内才说明命令是被 kill 的，不是自己跑完的。
     */
    const elapsed = Date.now() - startedAt
    check('整轮远早于命令自身的 5 秒（证明是真打断）', elapsed < 4000, `${elapsed}ms`)
    const cut = tools.filter((m) => (m.content ?? '').includes('打断'))
    check('正在跑的那条被真打断了', cut.length === 1, `实际 ${cut.length}`)
    const skipped = tools.filter((m) => (m.content ?? '').includes('没有执行'))
    check('没轮到的两条被跳过并说明原因', skipped.length === 2, `实际 ${skipped.length}`)
    check(
      '打断文案说清「不是环境坏了」',
      cut.length > 0 && cut.every((m) => (m.content ?? '').includes('不用重试'))
    )

    // 第二次请求 = 插话之后重新规划的那一轮
    const second = reqs[1]
    check('插话之后确实又请求了一次模型', Boolean(second))
    const sentTools = (second?.messages ?? []).filter((m) => m.role === 'tool')
    check('重规划那轮带上了三条 tool 结果', sentTools.length === 3, `实际 ${sentTools.length}`)
    check(
      '模型看到的是新指令',
      (second?.messages ?? []).some((m) => m.role === 'user' && m.content.includes('b.txt'))
    )

    const last = session.messages[session.messages.length - 1]
    check('最终正常收尾，给了回答', last.role === 'assistant' && last.content.includes('b.txt'))

    // 收尾后临时状态要清干净：否则下一次提问会莫名带上上一轮没说完的话
    check('跑完之后插话队列已清空（再插话会被拒绝）', engine.steer(a.id, '再来一句') === false)
  } finally {
    if (backup) fs.writeFileSync(cfgFile, backup)
    const trash = path.join(userData, 'sessions', '.trash')
    fs.mkdirSync(trash, { recursive: true })
    for (const id of created) {
      const f = path.join(userData, 'sessions', `${id}.json`)
      if (fs.existsSync(f)) fs.renameSync(f, path.join(trash, `${id}.json`))
    }
    fs.rmSync(ws, { recursive: true, force: true })
    srv.closeAllConnections?.()
    srv.close()
  }

  console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
  app.exit(fails ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  app.exit(1)
})
