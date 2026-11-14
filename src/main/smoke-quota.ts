/**
 * 用量闸门 / 同家重试 / 步数用尽保留断点 —— 三条都只在真跑一轮时才走得到，
 * 单测覆盖不了，所以这里起一个假的 OpenAI 兼容服务，把循环真的跑起来。
 *
 * 假服务按 `mode` 决定回什么：
 *   tool-then-text  第一次给一个 read_file 工具调用，之后给纯文本（模拟「干一步再说」）
 *   flaky           第一次 500，之后正常（模拟上游抖动）
 *   always-tool     每次都给工具调用（模拟一直干不完，用来撞步数上限）
 *
 * 会临时改写 config.json，跑完在 finally 里原样写回。
 */
import { app } from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { AgentEngine } from './agent'
import { loadConfig, saveConfig } from './config'
import { loadCheckpoint } from './checkpoint'
import * as store from './store'
import type { AgentEvent, ApprovalRequest } from '../shared/types'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let fails = 0
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) fails++
}

type Mode = 'tool-then-text' | 'flaky' | 'always-tool'

async function main(): Promise<void> {
  await app.whenReady()
  const userData = app.getPath('userData')
  const cfgFile = path.join(userData, 'config.json')
  const backup = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile) : null

  // 工作区里放个文件，read_file 才有东西可读
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rorotocode-quota-'))
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello\n', 'utf8')

  let mode: Mode = 'tool-then-text'
  let calls = 0

  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => {
      // 只把「真的问模型」的请求算进场景计数：探测 /v1/models 之类不算一步，
      // 否则 tool-then-text 的第一步会被探测请求吃掉
      if (!(req.url ?? '').includes('chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"data":[]}')
        return
      }
      calls += 1
      const n = calls
      if (mode === 'flaky' && n === 1) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end('{"error":{"message":"upstream boom"}}')
        return
      }
      const useTool = mode === 'always-tool' || (mode === 'tool-then-text' && n === 1)
      const frames: unknown[] = []
      if (useTool) {
        frames.push({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${n}`,
                    function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) }
                  }
                ]
              }
            }
          ]
        })
      } else {
        frames.push({ choices: [{ delta: { content: '做完了' } }] })
      }
      // 每次都给 usage：闸门靠它计数，本地服务不给 usage 时闸门本来就该失效
      frames.push({ choices: [{ delta: {} }], usage: { prompt_tokens: 4000, completion_tokens: 1000 } })

      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as { port: number }).port

  const events: AgentEvent[] = []
  const quotaAsks: ApprovalRequest[] = []
  /** 配额弹窗的应答：deny = 停在这里，once = 再给一点 */
  const quotaAnswer: 'deny' | 'once' = 'deny'
  const engine: AgentEngine = new AgentEngine((_sid, ev) => {
    events.push(ev)
    if (ev.type === 'approval' && ev.request.quota) {
      quotaAsks.push(ev.request)
      // 真界面上这一步是人点按钮，这里直接按预设应答
      setTimeout(() => engine.respondApproval(ev.request.id, quotaAnswer !== 'deny', false), 0)
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
    cfg.approvalMode = 'ask'
    cfg.autoVerify = false
    cfg.autoCompact = false
    cfg.autoFallback = false
    cfg.autoContinue = false
    cfg.maxSteps = 5
    cfg.tokenLimitPerRun = 3000 // 每次调用 5000 token，一撞就超
    cfg.tokenLimitPerDay = 0
    await saveConfig(cfg)

    // ---- 1. 单次上限：撞上先问，不停也不硬断 ----
    const a = await store.createSession(ws)
    created.push(a.id)
    await engine.send(a.id, '看一下 a.txt')
    const ask = quotaAsks[0]
    check('撞上限时弹的是配额确认，不是工具审批', ask?.tool === 'quota' && !!ask?.quota)
    check('说的是单次运行那条线', ask?.quota?.scope === 'run')
    check('用了 5.0k、上限 3.0k 如实报出来', ask?.quota?.used === 5000 && ask?.quota?.limit === 3000)
    const hintA = events.find((e) => e.type === 'hint' && /已停在这里/.test(e.message))
    check('停下来时说明了原因和怎么接着干', Boolean(hintA))
    check('同一轮只问一次，不会每步都弹', quotaAsks.length === 1)
    await sleep(120)
    const cp = await loadCheckpoint(a.id)
    check('停在用量上是「中断」而不是「做完」：断点还在', cp !== null)

    // ---- 2. 放开上限后能接着跑完 ----
    const cfg2 = await loadConfig()
    cfg2.tokenLimitPerRun = 0
    await saveConfig(cfg2)
    calls = 0
    const before = quotaAsks.length
    await engine.send(a.id, '继续')
    const reloaded = await store.loadSession(a.id)
    const last = reloaded?.messages[reloaded.messages.length - 1]
    check('调大上限后「继续」能跑完', last?.role === 'assistant' && /做完了/.test(last.content))
    check('上限放开后不再弹配额确认', quotaAsks.length === before)
    await sleep(120)
    check('正常跑完会清掉断点', (await loadCheckpoint(a.id)) === null)

    // ---- 3. 同家重试：一次 500 不该直接换模型 ----
    mode = 'flaky'
    calls = 0
    events.length = 0
    const b = await store.createSession(ws)
    created.push(b.id)
    let retried = false
    try {
      await engine.send(b.id, '看一下 a.txt')
      retried = true
    } catch {
      retried = false
    }
    check('上游 500 一次后重试成功，这一轮没有失败', retried)
    check('重试时告诉了用户「在重试第几次」', events.some((e) => e.type === 'hint' && /重试/.test(e.message)))
    check('没有切到别的供应商（只有一个可用）', !events.some((e) => e.type === 'failover'))

    // ---- 4. 步数用尽要保留断点 ----
    mode = 'always-tool'
    calls = 0
    events.length = 0
    const c = await store.createSession(ws)
    created.push(c.id)
    const cfg3 = await loadConfig()
    cfg3.maxSteps = 1
    cfg3.autoContinue = false
    await saveConfig(cfg3)
    await engine.send(c.id, '一直读文件')
    check('撞步数上限会明确告诉用户', events.some((e) => e.type === 'step_limit'))
    await sleep(150)
    const cpC = await loadCheckpoint(c.id)
    check('撞步数上限后断点仍在（不是「做完了」）', cpC !== null)
    check('断点里记着改过/读过的文件', (cpC?.lastCalls.length ?? 0) > 0)
  } finally {
    if (backup) fs.writeFileSync(cfgFile, backup)
    const trash = path.join(userData, 'sessions', '.trash')
    fs.mkdirSync(trash, { recursive: true })
    for (const id of created) {
      const f = path.join(userData, 'sessions', `${id}.json`)
      if (fs.existsSync(f)) fs.renameSync(f, path.join(trash, `${id}.json`))
    }
    fs.rmSync(ws, { recursive: true, force: true })
    srv.close()
  }

  console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
  app.exit(fails ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  app.exit(1)
})
