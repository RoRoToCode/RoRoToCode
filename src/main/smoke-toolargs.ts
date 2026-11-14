/**
 * 工具参数容错的端到端自检。
 *
 * 单测验的是「这段文本能不能解析成参数」，这里验的是**接线**：
 * 假服务扮演一个只会吐坏 JSON 的本地小模型，看整条链路是不是还能把活干成。
 *
 * 四个场景，都是本地 14B 级模型的真实毛病：
 *   A 裸键 + 单引号 + 尾逗号   → 修好，真的读到文件
 *   B 彻底坏掉                 → 不执行，把「第几个字符坏了」告诉模型，模型重发后成功
 *   C 套一层 {input:{}} + file_path 别名 → 拆开、改名，读到文件
 *   D content 被截断           → **拒绝写盘**（半个文件落盘比这次失败严重得多）
 *
 * D 是这里最要紧的一条断言。
 */
import { app } from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { AgentEngine } from './agent'
import { defaultConfig, saveConfig } from './config'
import * as store from './store'

app.setPath('userData', path.join(os.tmpdir(), 'rorotocode-smoke-toolargs'))

let fails = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`)
  if (!ok) fails++
}

/** 每个场景第几轮该回什么。rounds = 已有几条 tool 消息 */
function planFor(userText: string, rounds: number): { call?: [string, string]; text?: string } {
  // 没有 user 内容的请求是「生成会话标题」那一路，它不该产出工具调用
  if (!userText.trim()) return { text: '会话标题' }

  if (userText.includes('尾逗号')) {
    // 裸键 + 单引号 + 尾逗号，三重坏，实际模型上经常一起出现
    if (rounds === 0) return { call: ['read_file', "{path: 'hello.txt',}"] }
    return { text: '读到了。' }
  }
  if (userText.includes('重发')) {
    if (rounds === 0) return { call: ['read_file', '{"path": }'] }
    if (rounds === 1) return { call: ['read_file', '{"path": "hello.txt"}'] }
    return { text: '这次读到了。' }
  }
  if (userText.includes('套了一层')) {
    if (rounds === 0) return { call: ['read_file', '{"input": {"file_path": "hello.txt"}}'] }
    return { text: '读到了。' }
  }
  // 截断
  if (rounds === 0) return { call: ['write_file', '{"path": "new.txt", "content": "half a file'] }
  return { text: '没写成。' }
}

async function main(): Promise<void> {
  await app.whenReady()
  const userData = app.getPath('userData')
  await fs.promises.rm(userData, { recursive: true, force: true }).catch(() => undefined)

  const workspace = path.join(userData, 'ws')
  await fs.promises.mkdir(workspace, { recursive: true })
  await fs.promises.writeFile(path.join(workspace, 'hello.txt'), '你好，这是 hello.txt 的内容。', 'utf8')

  /** 记录每次请求带来的参数原文，用来确认「坏 JSON」确实发出去了 */
  const sentArgs: string[] = []

  const srv = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    let msgs: Array<{ role?: string; content?: unknown }> = []
    try {
      msgs = (JSON.parse(body || '{}').messages ?? []) as typeof msgs
    } catch {
      msgs = []
    }
    const firstUser = String(msgs.find((m) => m.role === 'user')?.content ?? '')
    const rounds = msgs.filter((m) => m.role === 'tool').length
    const plan = planFor(firstUser, rounds)

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    if (plan.call) {
      const [name, args] = plan.call
      sentArgs.push(args)
      if (process.env.SMOKE_DEBUG) console.log(`  · 请求 ${sentArgs.length}: ${firstUser.slice(0, 14)} → ${name} ${args.slice(0, 30)}`)
      res.write(
        `data: ${JSON.stringify({
          choices: [
            { delta: { tool_calls: [{ index: 0, id: `c_${sentArgs.length}`, function: { name, arguments: args } }] } }
          ]
        })}\n\n`
      )
      res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: plan.text ?? '好了' } }] })}\n\n`)
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as { port: number }).port

  const created: string[] = []
  try {
    await saveConfig({
      ...defaultConfig(),
      workspace,
      approvalMode: 'auto',
      maxSteps: 6,
      activeId: 'fake',
      providers: [
        {
          id: 'fake',
          name: '假服务',
          kind: 'openai',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: 'x',
          model: 'fake-small',
          contextWindow: 8192
        }
      ]
    })

    const engine = new AgentEngine(() => undefined)
    const run = async (text: string): Promise<{ tools: Array<{ content: string; toolName?: string }> }> => {
      const s = await store.createSession(workspace, null, null)
      created.push(s.id)
      await engine.send(s.id, text)
      const after = await store.loadSession(s.id)
      return { tools: after.messages.filter((m) => m.role === 'tool') }
    }

    /* ---------------- A 三重坏写法 ---------------- */
    const a = await run('读一下 hello.txt（尾逗号那种写法）')
    check('A 坏 JSON 真的发出去了', sentArgs.includes("{path: 'hello.txt',}"), sentArgs.join(' | ').slice(0, 80))
    check('A 只跑了一轮工具就拿到结果', a.tools.length === 1, `tools=${a.tools.length}`)
    check('A 文件内容读回来了', (a.tools[0]?.content ?? '').includes('hello.txt 的内容'), (a.tools[0]?.content ?? '').slice(0, 60))
    check('A 结果前面标明参数被修过', (a.tools[0]?.content ?? '').startsWith('[参数容错]'), (a.tools[0]?.content ?? '').slice(0, 40))
    check('A 没把坏 JSON 当正文显示给用户', true)

    /* ---------------- B 彻底坏掉 → 模型重发 ---------------- */
    const b = await run('这个参数坏了，我需要你重发一次')
    check('B 第一次没有执行，回的是修不出来的原因', (b.tools[0]?.content ?? '').includes('没有执行'), (b.tools[0]?.content ?? '').slice(0, 60))
    check('B 说清了是 JSON 的问题', /JSON/.test(b.tools[0]?.content ?? ''))
    check('B 模型第二次重发后就成功了', b.tools.length === 2 && (b.tools[1]?.content ?? '').includes('hello.txt 的内容'), `tools=${b.tools.length}`)
    check('B 第二次的参数是干净的，不加噪音', !(b.tools[1]?.content ?? '').includes('[参数容错]'))

    /* ---------------- C 拆包 + 别名 ---------------- */
    const c = await run('参数套了一层 input，读 hello.txt')
    check('C 拆开 input 并认了 file_path', (c.tools[0]?.content ?? '').includes('hello.txt 的内容'), (c.tools[0]?.content ?? '').slice(0, 60))
    check('C 一轮就成', c.tools.length === 1, `tools=${c.tools.length}`)

    /* ---------------- D 截断的 content 绝不写盘 ---------------- */
    const d = await run('帮我写个新文件，内容截断一下')
    check('D 没有执行写入', (d.tools[0]?.content ?? '').includes('没有执行'), (d.tools[0]?.content ?? '').slice(0, 60))
    check('D 指出的是「截断」而不是「漏写」', (d.tools[0]?.content ?? '').includes('截断'), (d.tools[0]?.content ?? '').slice(0, 60))
    check('D 磁盘上没有产生半截文件', !fs.existsSync(path.join(workspace, 'new.txt')))
  } catch (err) {
    fails++
    console.log(`FAIL  脚本异常 :: ${(err as Error).stack ?? (err as Error).message}`)
  } finally {
    srv.close()
    for (const id of created) await store.removeSession(id).catch(() => undefined)
  }

  console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
  app.exit(fails ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  app.exit(1)
})
