/**
 * 重复工具调用护栏的端到端验证。
 *
 * 单测能覆盖判定逻辑，但覆盖不了「引擎真的不再执行、界面卡片真的收口、
 * 这一轮真的会停」。这里起一个假的 OpenAI 服务，**每一轮都返回完全相同的
 * 工具调用**，模拟小模型卡死的样子（真实复现：同一个 query 调 47 次 web_search）。
 *
 * 断言：
 *   1. 前几次照常执行，随后出现一条「已拦截」的工具结果
 *   2. 界面收到 hint，而不是一遍遍重复的 tool_result
 *   3. 整轮在有限的几次请求内结束（不是跑到步数上限）
 *   4. 结束时没有留着转圈的卡片（每条 tool_call 都有对应结果）
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

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rorotocode-repeat-'))
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello\n', 'utf8')

  /** 每个请求都吐同一个 read_file：内容不变，结果自然一模一样 */
  let requests = 0
  const srv = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString()))
    req.on('end', () => {
      if (!(req.url ?? '').includes('chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"data":[]}')
        return
      }
      requests += 1
      const arg = JSON.stringify({ path: 'a.txt' })
      const frames: unknown[] = [
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: `call_${requests}`, function: { name: 'read_file', arguments: arg } }]
              }
            }
          ]
        },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 200, completion_tokens: 20 } }
      ]
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
    // 引擎的工具根目录取全局 workspace（会话只记录它，不参与解析）
    cfg.workspace = ws
    cfg.approvalMode = 'auto'
    cfg.autoVerify = false
    cfg.autoCompact = false
    cfg.autoFallback = false
    cfg.autoContinue = false
    // 步数给足：如果护栏没生效，这一轮会一直转到 20 步，下面的断言就会失败
    cfg.maxSteps = 20
    cfg.tokenLimitPerRun = 0
    cfg.tokenLimitPerDay = 0
    await saveConfig(cfg)

    const a = await store.createSession(ws)
    created.push(a.id)

    const startedAt = Date.now()
    const run = engine.send(a.id, '看看 a.txt 里写了什么')
    await Promise.race([
      run,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(`这一轮没在 20 秒内结束，请求数：${requests}`)), 20000)
      )
    ])
    const elapsed = Date.now() - startedAt

    const session = await store.loadSession(a.id)
    const tools = session.messages.filter((m) => m.role === 'tool')
    const calls = session.messages.flatMap((m) => m.toolCalls ?? [])
    const blocked = tools.filter((m) => (m.content ?? '').includes('已拦截'))
    const executed = tools.filter((m) => (m.content ?? '').includes('hello'))

    if (process.env.REPEAT_DEBUG === '1') {
      for (const t of tools) console.log(`[dbg] ${t.toolName}: ${(t.content ?? '').slice(0, 90)}`)
    }

    check('确实执行过几次正常调用', executed.length >= 3, `执行 ${executed.length} 次`)
    check('出现「已拦截」结果', blocked.length >= 1, `拦截 ${blocked.length} 次`)
    check('拦截文案说明结果不会变', blocked.every((m) => (m.content ?? '').includes('换做法')))
    check('拦截时带上了上次结果，模型不必再跑一遍', blocked.some((m) => (m.content ?? '').includes('hello')))

    const hints = events.filter((e) => e.type === 'hint') as Array<{ message: string }>
    check('界面收到「在重复同一个动作」的提示', hints.some((h) => h.message.includes('重复')))
    check('没有继续发 step_limit（不是跑到步数上限才停）', !events.some((e) => e.type === 'step_limit'))

    /**
     * 关键：请求数必须明显小于步数上限。只靠 maxSteps 拦住的话请求数会是 20。
     * 只读工具：3 次不拦 + 1 次警告 + 1 次照跑 + 5 次拦截 → 大约 8~10 轮。
     */
    check('在步数上限之前就停了', requests <= 10, `共 ${requests} 次请求 / 上限 20`)
    check('整体没有卡死', elapsed < 15000, `${elapsed}ms`)

    // 每条 tool_call 都必须有结果，否则界面会留着转圈的卡片
    const answered = new Set(tools.map((m) => m.toolCallId))
    check(
      '每个 tool_call 都有对应结果（界面不留转圈卡片）',
      calls.every((c) => answered.has(c.id)),
      `调用 ${calls.length} 条 / 结果 ${tools.length} 条`
    )

    // 早停之后 checkpoint 是 running，用户下次打开还能接着干
    const ckPath = path.join(userData, 'checkpoints', `${a.id}.json`)
    check('保留恢复点（不是假装做完了）', fs.existsSync(ckPath), ckPath)
  } finally {
    if (backup) fs.writeFileSync(cfgFile, backup)
    const trash = path.join(userData, 'sessions', '.trash')
    fs.mkdirSync(trash, { recursive: true })
    for (const id of created) {
      const f = path.join(userData, 'sessions', `${id}.json`)
      if (fs.existsSync(f)) fs.renameSync(f, path.join(trash, `${id}.json`))
      const ck = path.join(userData, 'checkpoints', `${id}.json`)
      if (fs.existsSync(ck)) fs.rmSync(ck, { force: true })
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
