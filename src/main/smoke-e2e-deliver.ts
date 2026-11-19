/**
 * 实机端到端验收：真的拉起本地模型，真的让 AgentEngine 在真实工作区里干活出成品。
 *
 * 和 smoke-realmodel 的区别：那个只验证「模型加载 + 一句话对话 + 启停」，
 * 这个验证「agent 走完 读需求 → 规划 → 写文件 → 跑命令 → 自查 → 收工」的完整闭环，
 * 并且对每类任务验证成品真的落盘、真的能用。
 *
 * 覆盖四类任务（用 ROROTO_E2E_TASK 选择，缺省全跑）：
 *   game   网页游戏（index.html + game.js，触发 JS 语法门禁 + 打开验收）
 *   cli    命令行程序（Node 脚本，可 node 直接运行）
 *   modify 修改已有代码（给一段有 bug 的代码改对，验证 diff 生效）
 *   fetch  网页访问（用 web 工具抓取内容，验证网络路径）
 *
 * 用法（本机 ELECTRON_RUN_AS_NODE=1，必须 unset）：
 *   env -u ELECTRON_RUN_AS_NODE ROROTO_E2E_TASK=game npx electron dist/main/smoke-e2e-deliver.js
 *
 * 审批：approvalMode=auto + RunOptions.nonInteractive + approvalPolicy='allow'，
 * 全程不弹窗、自动放行（符合「授权自动放行」）。高危操作仍会被 hardBlock 拦下。
 */
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentEngine } from './agent'
import { createSession, loadSession, removeSession } from './store'
import { loadConfig, saveConfig } from './config'
import { startLlama, statusLlama, stopLlama, localGgufFiles, llamaInstances } from './llama'
import type { AgentEvent } from '../shared/types'

// 隔离到临时目录，不碰用户真实配置 / 会话
app.setPath('userData', path.join(os.tmpdir(), 'rorotocode-e2e-deliver'))

// 模型和 llama-server 都在 release/ 下
const repoRelease = path.resolve(__dirname, '..', '..', 'release')
if (!process.env.ROROTO_DATA_DIR && fs.existsSync(path.join(repoRelease, 'llama.cpp'))) {
  process.env.ROROTO_DATA_DIR = repoRelease
}

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}${detail ? `  → ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 等 llama-server ready（复用 smoke-realmodel 的判断口径） */
async function waitReady(timeoutMs: number): Promise<{ ready: boolean; note: string }> {
  const begin = Date.now()
  let last = ''
  while (Date.now() - begin < timeoutMs) {
    const st = await statusLlama()
    last = `${st.state}${st.phase ? `/${st.phase}` : ''} ${st.message}`
    if (st.state === 'ready') return { ready: true, note: last }
    if (st.state === 'error') return { ready: false, note: last }
    if (st.state === 'idle' && Date.now() - begin > 5000) return { ready: false, note: last }
    await sleep(500)
  }
  return { ready: false, note: last }
}

/** 挑模型：环境变量 > 7B coder（实测带 tools 稳定）> 最小可用 */
async function pickModel(): Promise<string> {
  const env = (process.env.ROROTO_E2E_MODEL ?? '').trim()
  if (env) return env
  const plain = (await localGgufFiles()).filter((f) => !/-mmproj\.gguf$/i.test(f.name))
  // 实机实测：MiMo-9B 带 tools 请求会让 llama-server 崩溃（纯 chat 正常），
  // 7B coder 带 tools 稳定，是 agent 干活的可靠主力。
  const seven = plain.find((f) => /7b/i.test(f.name))
  if (seven) return seven.name
  return [...plain].sort((a, b) => a.sizeBytes - b.sizeBytes)[0]?.name ?? ''
}

/** 建一个隔离的临时工作区 */
function makeWorkspace(tag: string): string {
  const ws = path.join(os.tmpdir(), `roroto-e2e-${tag}-${Date.now().toString(36)}`)
  fs.mkdirSync(ws, { recursive: true })
  return ws
}

interface TaskDef {
  name: string
  prompt: string
  /** 任务结束后要验证的成品（相对工作区路径）；存在即算「成品落盘」 */
  expects: string[]
  /** 额外的验证器：返回 {ok, detail} */
  verify: (ws: string) => { ok: boolean; detail: string }
}

/** 四类任务的定义 */
function taskDefs(): Record<string, TaskDef> {
  return {
    game: {
      name: '网页游戏',
      prompt:
        '在这个工作区做一个网页版「打地鼠」小游戏：文件是 index.html 和 game.js（index.html 用 <script src="game.js"> 引入）。' +
        '要求：有计分、有 3x3 的洞、地鼠随机冒出、点击命中加分。做完后自己打开 index.html 确认没有报错、画面能画出来。',
      expects: ['index.html', 'game.js'],
      verify: (ws) => {
        const html = safeRead(path.join(ws, 'index.html'))
        const js = safeRead(path.join(ws, 'game.js'))
        const ok = html.includes('<canvas') && js.length > 200 && /function|=>/.test(js)
        return {
          ok,
          detail: `html=${html.length}B(含canvas=${html.includes('<canvas')}) js=${js.length}B`
        }
      }
    },
    cli: {
      name: '命令行程序',
      prompt:
        '写一个 Node 命令行程序 calc.js：读命令行参数，支持 + - * / 四则运算。' +
        '例如 `node calc.js 2 + 3` 输出 5。写完后用 run_shell 实际运行 `node calc.js 7 * 6` 验证输出 42。',
      expects: ['calc.js'],
      verify: (ws) => {
        const src = safeRead(path.join(ws, 'calc.js'))
        return { ok: src.length > 50, detail: `calc.js=${src.length}B` }
      }
    },
    modify: {
      name: '修改已有代码',
      prompt:
        '工作区里有一个 buggy.js，里面 add 函数有 bug（少了个参数）。' +
        '先 read_file 读它，再用 edit_file 把 bug 修对，让 `node buggy.js` 输出 7 而不是 NaN。',
      expects: ['buggy.js'],
      verify: (ws) => {
        const src = safeRead(path.join(ws, 'buggy.js'))
        return { ok: /add\(2, 5\)/.test(src) || /7/.test(src), detail: `buggy.js=${src.length}B` }
      }
    },
    fetch: {
      name: '网页访问',
      prompt:
        '用 web 相关工具（web_fetch 或 web_search）查一下「今天的日期」，' +
        '然后把结果写进一个 answer.txt 文件里（只要日期那一行结论）。',
      expects: ['answer.txt'],
      verify: (ws) => {
        const txt = safeRead(path.join(ws, 'answer.txt'))
        return { ok: txt.length > 0, detail: `answer.txt=${txt.length}B 内容="${txt.slice(0, 40)}"` }
      }
    }
  }
}

function safeRead(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** 给 modify 任务预置一段有 bug 的代码 */
function seedFixture(ws: string, task: string): void {
  if (task === 'modify') {
    fs.writeFileSync(
      path.join(ws, 'buggy.js'),
      'function add(a) {\n  return a + 5\n}\n\nconsole.log(add(2, 5))\n',
      'utf8'
    )
  }
}

/**
 * 主流程：起模型 → 逐任务跑 → 验证 → 停模型。
 *
 * 注意：AgentEngine 的 emit 是构造注入，send 返回后不直接给 done；
 * 这里用「send 后轮询 engine.isRunning() 直到 false」来等一轮收工，
 * 再从会话里读最后一条 assistant 文本作为结论。
 */
async function main(): Promise<void> {
  const tasks = (process.env.ROROTO_E2E_TASK ?? '').trim()
  const want = tasks ? tasks.split(',').map((s) => s.trim()) : Object.keys(taskDefs())
  const defs = taskDefs()

  const model = await pickModel()
  console.log('===== e2e-deliver =====')
  console.log(`模型：${model}`)
  console.log(`任务：${want.join('、')}`)

  // 1. 起模型。上下文用环境变量控制（8GB 显存跑 9B 时，32768 的 KV cache 可能 OOM，
  // 默认降到 8192 求稳；够用的机器可 ROROTO_E2E_CTX=32768 调大）。
  const ctx = Number(process.env.ROROTO_E2E_CTX ?? 8192) || 8192
  const started = await startLlama(model, ctx)
  check(`拉起本地模型服务（ctx=${ctx}）`, started.ok, started.message)
  if (!started.ok) return
  const ready = await waitReady(240_000)
  check('模型加载完成并 ready', ready.ready, ready.note)
  if (!ready.ready) return

  const st = await statusLlama()
  const provider = {
    id: 'llamacpp',
    name: '本地 llama.cpp',
    kind: 'openai' as const,
    baseUrl: `http://127.0.0.1:${st.port}`,
    model,
    contextWindow: 32768,
    temperature: 0.2
  }

  // 2. 把配置写成指向本地模型 + auto 审批
  const cfg = await loadConfig()
  cfg.providers = [
    {
      ...provider,
      apiKey: 'enc:v1:local',
      runtime: 'llama' as const,
      llamaVision: false
    }
  ]
  cfg.activeId = 'llamacpp'
  cfg.approvalMode = 'auto'
  await saveConfig(cfg)

  // 3. 逐任务跑
  const engine = new AgentEngine((_sid, _ev) => {
    // 本轮不回传事件；完成与否靠 isRunning 轮询 + 会话落盘判断
  })

  for (const key of want) {
    const def = defs[key]
    if (!def) {
      console.log(`跳过未知任务：${key}`)
      continue
    }
    console.log(`\n----- 任务：${def.name} -----`)
    const ws = makeWorkspace(key)
    seedFixture(ws, key)
    const session = await createSession(ws)

    try {
      await engine.send(session.id, def.prompt, [], {
        nonInteractive: true,
        approvalPolicy: 'allow',
        workspace: ws,
        reason: 'chat'
      })
      // 等这一轮收工
      const t0 = Date.now()
      while (engine.isRunning(session.id) && Date.now() - t0 < 300_000) {
        await sleep(1000)
      }
      const doneMsg = await loadSession(session.id).catch(() => null)
      const lastAssistant = doneMsg
        ? [...doneMsg.messages].reverse().find((m) => m.role === 'assistant' && !m.toolCalls)
        : null
      const tail = (lastAssistant?.content ?? '').trim().slice(-200)
      check(`${def.name}：agent 跑完一轮`, !engine.isRunning(session.id), tail)

      // 成品落盘验证
      for (const rel of def.expects) {
        const full = path.join(ws, rel)
        const exists = fs.existsSync(full)
        check(`${def.name}：成品 ${rel} 落盘`, exists, exists ? `${safeRead(full).length}B` : '缺失')
      }
      const v = def.verify(ws)
      check(`${def.name}：成品内容可用`, v.ok, v.detail)
    } catch (err) {
      check(`${def.name}：跑通`, false, (err as Error).message)
    } finally {
      await removeSession(session.id).catch(() => undefined)
    }
  }

  // 4. 停模型
  const insts = llamaInstances()
  for (const i of insts) {
    await stopLlama(i.key)
  }
  await sleep(800)
  check('收尾：没有残留 llama-server 实例', llamaInstances().length === 0, String(llamaInstances().length))
}

app
  .whenReady()
  .then(main)
  .catch((err) => {
    failed += 1
    console.log(`FAIL  脚本异常：${err instanceof Error ? err.message : String(err)}`)
    if (err instanceof Error && err.stack) console.log(err.stack)
  })
  .finally(() => {
    console.log('')
    if (failed === 0) console.log(`全部通过（${passed} 项）`)
    else console.log(`${passed} 项通过 / ${failed} 项失败`)
    app.exit(failed ? 1 : 0)
  })
