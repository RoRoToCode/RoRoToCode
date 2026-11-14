/**
 * 交接的端到端自检：假装模型要求 handoff，看整条链路是不是真的通了。
 *
 * 起一个假 OpenAI 服务：第一轮返回一个 handoff 工具调用，第二轮（收到工具结果后）
 * 说一句「已交接」。这样验证的是**接线**，不是模型能力：
 * 工具表里有它、参数能解析、会话建出来了、交接单进队列了、回给模型的话说得对。
 *
 * 会临时改写 config.json，跑完在 finally 里原样写回。
 */
import { app } from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { AgentEngine } from './agent'
import { loadConfig, saveConfig } from './config'
import { listHandoffs, pumpHandoffs, startHandoffPump, stopHandoffPump } from './handoff'
import * as store from './store'

let fails = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`)
  if (!ok) fails++
}

async function main(): Promise<void> {
  await app.whenReady()
  const cfgFile = path.join(app.getPath('userData'), 'config.json')
  const backup = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile) : null
  await fs.promises.rm(path.join(app.getPath('userData'), 'handoffs.json'), { force: true }).catch(() => undefined)

  /** 模型收到的最后一条工具结果：它决定模型下一步说什么，也是我们验证的依据 */
  let toolOutput = ''
  let steps = 0

  const srv = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    let msgs: Array<{ role?: string; content?: unknown }> = []
    try {
      msgs = (JSON.parse(body || '{}').messages ?? []) as typeof msgs
    } catch {
      msgs = []
    }
    const toolMsgs = msgs.filter((m) => m.role === 'tool')
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })

    if (toolMsgs.length === 0) {
      steps++
      const args = JSON.stringify({
        to: '审查',
        task: '给 /sessions 接口加频率限制',
        context: 'src/main/daemon.ts 里 /sessions 没有任何频控，可以被无限刷',
        files: ['src/main/daemon.ts']
      })
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_1', function: { name: 'handoff', arguments: args } }]
              }
            }
          ]
        })}\n\n`
      )
      res.write(`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n`)
    } else {
      toolOutput = String(toolMsgs[toolMsgs.length - 1].content ?? '')
      const text = '已经交给审查了，我这边不再重复处理。'
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
      res.write(`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as { port: number }).port

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
        model: 'fake-large',
        contextWindow: 8192
      }
    ]
    cfg.activeId = 'fake'
    cfg.maxSteps = 4
    await saveConfig(cfg)

    const engine = new AgentEngine(() => undefined)
    const parent = await store.createSession(null, null, null)
    created.push(parent.id)

    await engine.send(parent.id, '巡检一下登录接口有没有限流')
    check('一轮就跑完了，没被工具卡住', steps >= 1)

    const list = await listHandoffs()
    check('模型调用后真的入队了一条交接', list.length === 1, `实际 ${list.length}`)
    const h = list[0]
    check('目标档案按名字解析出来了', h?.toAgentId === 'agent_review', String(h?.toAgentId))
    check('任务与上下文原样带过去', h?.task === '给 /sessions 接口加频率限制' && (h?.context ?? '').includes('/sessions'))
    check('文件清单保留', (h?.files ?? []).includes('src/main/daemon.ts'))
    check('普通会话交出去的活只读', h?.approvalPolicy === 'deny')
    check('回给模型的话说清了「不要等」', toolOutput.includes('不要等它'), toolOutput.slice(0, 80))

    const child = await store.loadSession(h.sessionId!)
    created.push(child.id)
    check('接手会话绑定了审查档案', child.agentId === 'agent_review', String(child.agentId))
    check('接手会话标题带 ↳', child.title.startsWith('↳'), child.title)

    // 放行：这里换成假 runner，只验状态流转，不真跑模型
    let launchedId = ''
    startHandoffPump({
      busy: () => false,
      launch: async (rec, sessionId) => {
        launchedId = sessionId
        // 真跑的时候这里会调 engine.send，接收方拿到的是交接单
        const sent = await (await import('./handoff')).handoffPrompt(rec)
        if (!sent.includes('给 /sessions 接口加频率限制')) throw new Error('交接单内容不对')
        return { status: 'ok' as const, summary: '已给 /sessions 加限流', tokens: { prompt: 10, completion: 5 }, at: Date.now() }
      }
    })
    const ran = await pumpHandoffs()
    check('空闲时自动放行', ran.length === 1 && launchedId === h.sessionId)
    const after = (await listHandoffs()).find((x) => x.id === h.id)
    check('状态从排队变成完成', after?.status === 'ok', String(after?.status))
    check('回执跟着记录一起落盘', after?.result?.summary === '已给 /sessions 加限流', after?.result?.summary)
  } catch (err) {
    fails++
    console.log(`FAIL  脚本异常 :: ${(err as Error).stack ?? (err as Error).message}`)
  } finally {
    stopHandoffPump()
    srv.close()
    if (backup) fs.writeFileSync(cfgFile, backup)
    for (const id of created) await store.removeSession(id).catch(() => undefined)
    console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
    app.exit(fails === 0 ? 0 : 1)
  }
}

void main()
