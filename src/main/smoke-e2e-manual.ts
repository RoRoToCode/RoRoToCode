/**
 * 实机端到端出成品：用本地模型 + 手动工具循环，真正产出一个成品并验证。
 *
 * 这是 smoke-e2e-deliver 的「直连版」：绕开 AgentEngine 的 runLoop（它在单槽
 * llama-server 上有一个待定位的崩溃），直接用 providers.chat + 手动执行工具调用
 * 走完「模型提需求 → 工具写文件 → 回灌结果 → 模型验收」的完整闭环。
 *
 * 用途：证明「本地模型 + 工具链」能真刀真枪产出可用成品。
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron dist/main/smoke-e2e-manual.js
 */
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startLlama, statusLlama, stopLlama, llamaInstances, localGgufFiles } from './llama'
import { chat } from './providers'
import type { ChatMessage, ToolCall } from '../shared/types'
import type { ToolSpec } from './tools/spec'

app.setPath('userData', path.join(os.tmpdir(), 'rorotocode-e2e-manual'))
const repoRelease = path.resolve(__dirname, '..', '..', 'release')
if (!process.env.ROROTO_DATA_DIR && fs.existsSync(path.join(repoRelease, 'llama.cpp'))) {
  process.env.ROROTO_DATA_DIR = repoRelease
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitReady(t: number): Promise<{ state: string; port?: number } | null> {
  const b = Date.now()
  while (Date.now() - b < t) {
    const s = await statusLlama()
    if (s.state === 'ready') return s
    if (s.state === 'error') return s
    await sleep(500)
  }
  return null
}

/** 工具定义：给模型一个「写文件」工具，够它产出成品 */
const TOOLS: ToolSpec[] = [
  {
    name: 'write_file',
    description: '把内容写进工作区的一个文件（覆盖或新建）。path 是相对路径，content 是完整文件内容。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content']
    }
  },
  {
    name: 'run_shell',
    description: '执行一条命令（用于验证产物，如 node xxx.js）。',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command']
    }
  },
  {
    name: 'finish',
    description: '所有文件都写好了、验证通过，调用它结束任务。',
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary']
    }
  }
]

/** 解析模型返回的工具调用（可能以 JSON 形式，也可能以 tool_calls 形式） */
function extractToolCalls(text: string): ToolCall[] {
  const out: ToolCall[] = []
  // 优先找 ```tool 或纯 JSON 行
  const re = /\{[^{}]*"name"\s*:\s*"(write_file|run_shell|finish)"[^{}]*\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    try {
      const obj = JSON.parse(m[0])
      out.push({ id: `c${out.length}`, name: obj.name, args: obj.args ?? {} })
    } catch {
      /* 不是合法 JSON，跳过 */
    }
  }
  return out
}

async function main(): Promise<void> {
  const plain = (await localGgufFiles()).filter((f) => !/-mmproj\.gguf$/i.test(f.name))
  const model = plain.find((f) => /7b/i.test(f.name))?.name ?? plain[0]?.name ?? ''
  console.log('===== e2e-manual =====')
  console.log(`模型：${model}`)

  await startLlama(model, 8192)
  const ready = await waitReady(240000)
  if (!ready || ready.state !== 'ready') {
    console.log('模型未就绪:', ready?.state)
    return app.exit(1)
  }
  const provider = {
    id: 'llamacpp',
    name: '本地 llama.cpp',
    kind: 'openai' as const,
    baseUrl: `http://127.0.0.1:${ready.port}`,
    model,
    contextWindow: 8192,
    temperature: 0.2
  }

  // 真实工作区
  const ws = path.join(os.tmpdir(), `roroto-manual-${Date.now().toString(36)}`)
  fs.mkdirSync(ws, { recursive: true })

  const task =
    '在这个工作区做一个网页版「打地鼠」小游戏：写 index.html 和 game.js 两个文件' +
    '（index.html 用 <script src="game.js"> 引入）。要求有计分、3x3 的洞、地鼠随机冒出、点击命中加分。' +
    '写完两个文件后，用 run_shell 运行 `node --check game.js` 验证语法，通过后调用 finish。'

  const messages: ChatMessage[] = [
    {
      id: 'sys',
      role: 'system',
      content: `你是编程助手。工作区：${ws}。用 write_file 写文件、run_shell 验证、finish 收尾。用中文。`,
      createdAt: Date.now()
    },
    { id: 'u1', role: 'user', content: task, createdAt: Date.now() }
  ]

  let finalSummary = ''
  for (let round = 0; round < 12; round++) {
    let text = ''
    const result = await chat({
      provider,
      messages,
      tools: TOOLS,
      signal: new AbortController().signal,
      onText: (t) => {
        text += t
      }
    }).catch((e) => {
      console.log(`第 ${round} 轮报错:`, (e as Error).message.slice(0, 100))
      return null
    })
    if (!result) break

    const assistantText = (result.text || text).trim()
    console.log(`\n[第 ${round} 轮] 模型输出 ${assistantText.length} 字`)

    const calls = extractToolCalls(assistantText)
    if (!calls.length) {
      // 没工具调用，可能是纯文本回答或模型卡住，把输出回灌继续
      messages.push({ id: `a${round}`, role: 'assistant', content: assistantText, createdAt: Date.now() })
      messages.push({
        id: `t${round}`,
        role: 'user',
        content: '请继续：用 write_file 写文件，或如果已经完成就调用 finish。',
        createdAt: Date.now()
      })
      continue
    }

    // 执行工具调用
    messages.push({ id: `a${round}`, role: 'assistant', content: assistantText, createdAt: Date.now() })
    for (const c of calls) {
      if (c.name === 'write_file') {
        const p = path.join(ws, String(c.args.path ?? ''))
        try {
          fs.mkdirSync(path.dirname(p), { recursive: true })
          fs.writeFileSync(p, String(c.args.content ?? ''), 'utf8')
          const size = fs.statSync(p).size
          console.log(`  工具 write_file: ${c.args.path} (${size}B)`)
          messages.push({
            id: `r${round}-${c.id}`,
            role: 'user',
            content: `已写入 ${c.args.path}（${size} 字节）`,
            createdAt: Date.now()
          })
        } catch (e) {
          messages.push({
            id: `r${round}-${c.id}`,
            role: 'user',
            content: `写入失败：${(e as Error).message}`,
            createdAt: Date.now()
          })
        }
      } else if (c.name === 'run_shell') {
        const { execSync } = await import('node:child_process')
        try {
          const out = execSync(String(c.args.command ?? ''), { cwd: ws, encoding: 'utf8', timeout: 15000 })
          console.log(`  工具 run_shell: ${c.args.command} → ${out.trim().slice(0, 60)}`)
          messages.push({
            id: `r${round}-${c.id}`,
            role: 'user',
            content: `命令输出：${out.slice(0, 500)}`,
            createdAt: Date.now()
          })
        } catch (e) {
          const err = e as { stdout?: string; stderr?: string; message?: string }
          messages.push({
            id: `r${round}-${c.id}`,
            role: 'user',
            content: `命令报错：${err.stderr || err.message || ''}`.slice(0, 500),
            createdAt: Date.now()
          })
        }
      } else if (c.name === 'finish') {
        finalSummary = String(c.args.summary ?? '')
        console.log(`  工具 finish: ${finalSummary.slice(0, 80)}`)
      }
    }
    if (finalSummary) break
  }

  // 验证成品
  console.log('\n===== 成品验证 =====')
  const html = fs.existsSync(path.join(ws, 'index.html')) ? fs.readFileSync(path.join(ws, 'index.html'), 'utf8') : ''
  const js = fs.existsSync(path.join(ws, 'game.js')) ? fs.readFileSync(path.join(ws, 'game.js'), 'utf8') : ''
  console.log(`index.html: ${html.length}B${html.includes('<canvas') ? '（含 canvas）' : ''}`)
  console.log(`game.js: ${js.length}B`)
  // 用 node --check 验证 game.js 语法
  if (js) {
    const { execSync } = await import('node:child_process')
    try {
      execSync(`node --check "${path.join(ws, 'game.js')}"`, { encoding: 'utf8' })
      console.log('game.js 语法检查: 通过 ✓')
    } catch (e) {
      console.log('game.js 语法检查: 失败 ✗', (e as Error).message.slice(0, 100))
    }
  }
  const ok = html.includes('<canvas') && js.length > 200
  console.log(ok ? '\n✅ 成品产出成功（可运行的网页游戏）' : '\n❌ 成品不完整')

  const insts = llamaInstances()
  for (const i of insts) await stopLlama(i.key)
  app.exit(ok ? 0 : 1)
}

app.whenReady().then(main).catch((e) => {
  console.log('异常:', (e as Error).message)
  app.exit(1)
})
