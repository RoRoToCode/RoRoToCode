/**
 * 「该检查却没检查」的回灌验证。
 *
 * 场景：工作区有 tsconfig.json，但没装 typescript（用户 clone 下来还没 npm install，
 * 或者依赖被放在了别处）。
 *
 * 修复前的表现：诊断层静默返回空数组 → 引擎认为「没有编译错误」→ 模型改完就收工，
 * 用户拿到一堆类型错误。修复后：工具结果里必须明确写「这次没有做类型检查」。
 *
 * 断言：
 *   1. 写文件后的工具结果包含「没有做类型检查」，并给出下一步办法
 *   2. 只提示一次，不会每个文件都重复一遍
 *   3. 真的装了 typescript 的项目不会被误报
 */
import { app } from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { AgentEngine } from './agent'
import { loadConfig, saveConfig } from './config'
import * as store from './store'
import { diagnoseReport } from './lsp'

let fails = 0
function check(name: string, ok: boolean, extra?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) fails++
}

async function main(): Promise<void> {
  await app.whenReady()
  const cfgFile = path.join(app.getPath('userData'), 'config.json')
  const backup = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile) : null

  /** 有 tsconfig、缺 typescript：挖深三层，避免 locate 往上找到本仓库的 node_modules */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorotocode-gap-'))
  const ws = path.join(root, 'a', 'b')
  fs.mkdirSync(ws, { recursive: true })
  fs.writeFileSync(path.join(ws, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }))

  let n = 0
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
      n += 1
      const frames: unknown[] =
        n === 1
          ? [
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'w1',
                          function: {
                            name: 'write_file',
                            arguments: JSON.stringify({ path: 'a.ts', content: 'const x: number = 1\n' })
                          }
                        }
                      ]
                    }
                  }
                ]
              }
            ]
          : [{ choices: [{ delta: { content: '改好了。' } }] }]
      frames.push({ choices: [{ delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 10 } })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as { port: number }).port

  const engine: AgentEngine = new AgentEngine((_sid, ev) => {
    if (ev.type === 'approval' && !ev.request.quota) {
      setTimeout(() => engine.respondApproval(ev.request.id, true, false), 0)
    }
  })

  const ids: string[] = []
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
    cfg.maxSteps = 4
    cfg.tokenLimitPerRun = 0
    cfg.tokenLimitPerDay = 0
    await saveConfig(cfg)

    const s = await store.createSession(ws)
    ids.push(s.id)
    await Promise.race([
      engine.send(s.id, '写个 a.ts'),
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error('超时')), 20000))
    ])

    const session = await store.loadSession(s.id)
    if (process.env.GAP_DEBUG === '1') {
      const probe = await diagnoseReport(ws, [path.join(ws, 'a.ts')])
      console.log(
        `[dbg] skipped=${probe.skipped} diags=${probe.diags.length} diagnoseOnWrite=${String(
          cfg.diagnoseOnWrite
        )} ws=${ws}`
      )
    }
    const tool = session.messages.find((m) => m.role === 'tool' && m.toolName === 'write_file')
    const text = tool?.content ?? ''
    const gapHits = (text.match(/没有做类型检查/g) ?? []).length

    check('写文件的工具结果带上了「没有做类型检查」', gapHits >= 1, text.slice(0, 90))
    check('提醒别把「没报错」当成通过', text.includes('不要把'))
    check('给了下一步办法', /构建|测试|npm install/.test(text))
    check('没有伪造一句「检查通过」', !text.includes('0 个编译错误'))
    check('只提示一次', gapHits === 1, `出现 ${gapHits} 次`)
    check('模型确实收到了这条结果并收尾', requests >= 2, `共 ${requests} 次请求`)

    /**
     * 对照组：本仓库真装了 typescript，不该被报成 no-typescript。
     * 这里同时验证「有编译器时仍走原来的检查路径」，不是把所有人当成没装。
     */
    const real = await diagnoseReport(process.cwd(), [path.join(process.cwd(), 'src', 'main', 'agent.ts')])
    check('装了 typescript 的项目不会被误判成缺编译器', real.skipped !== 'no-typescript', String(real.skipped))
  } finally {
    if (backup) fs.writeFileSync(cfgFile, backup)
    const trash = path.join(app.getPath('userData'), 'sessions', '.trash')
    fs.mkdirSync(trash, { recursive: true })
    for (const id of ids) {
      const f = path.join(app.getPath('userData'), 'sessions', `${id}.json`)
      if (fs.existsSync(f)) fs.renameSync(f, path.join(trash, `${id}.json`))
    }
    fs.rmSync(root, { recursive: true, force: true })
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
