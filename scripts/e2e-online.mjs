#!/usr/bin/env node
/**
 * 在线模型端到端「真出成品」验收驱动。
 *
 * 通过 HTTP daemon 驱动**正在运行的** RoRoToCode 程序（不是另起子进程）：
 *   POST /chat/session  -> sessionId（钉一个真实工作区）
 *   GET  /chat/events   -> SSE（实时事件）
 *   POST /chat/send     -> approvalPolicy:'allow' 自动放行
 *   等 done / error -> 落盘验证成品
 *
 * 当前激活模型 = config.json 的 activeId（云端 NVIDIA NIM nemotron-3.5-bolt-e4b）。
 *
 * 用法：
 *   ROROTO_E2E_MODE=probe node scripts/e2e-online.mjs
 *   ROROTO_E2E_MODE=all   node scripts/e2e-online.mjs
 *   ROROTO_E2E_MODE=one ROROTO_E2E_TASK=game node scripts/e2e-online.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const USER_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'RoRoToCode')
const REPO = process.cwd()
const E2E_ROOT = path.join(REPO, 'workspace', 'online-e2e')

function daemonInfo() {
  const p = path.join(USER_DATA, 'daemon.json')
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
}

const MODE = process.env.ROROTO_E2E_MODE || 'probe'
const ONLY = (process.env.ROROTO_E2E_TASK || '').trim()
const TIMEOUT = Number(process.env.ROROTO_E2E_TIMEOUT || 8 * 60 * 1000) // 单任务 8 分钟

function read(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return '' }
}

/** 任务定义：prompt 让模型真刀真枪产出成品，verify 校验成品真的能用 */
function taskDefs() {
  return {
    probe: {
      name: '连通性探针（对话 + 自动写文件）',
      prompt:
        '请先正常回答我：1+1 等于几？然后用 write_file 工具在工作区写一个文件 probe.txt，' +
        '内容就是你的回答（一句话即可）。写完即完成，无需做别的。',
      expects: ['probe.txt'],
      verify: (ws) => {
        const t = read(path.join(ws, 'probe.txt')).trim()
        return { ok: t.length > 0, detail: `probe.txt="${t.slice(0, 60)}"` }
      }
    },
    game: {
      name: '网页游戏：打地鼠',
      prompt:
        '在工作区做一个可玩的网页版「打地鼠」小游戏。写两个文件：index.html 和 game.js，' +
        'index.html 用 <script src="game.js"> 引入。要求：3x3 的洞、地鼠随机冒出并自动消失、' +
        '点击命中加分并实时显示分数、有开始/重开按钮。写完自己用 node --check game.js 检查语法，' +
        '有错就修到通过。做完调用任务完成。',
      expects: ['index.html', 'game.js'],
      verify: (ws) => {
        const html = read(path.join(ws, 'index.html'))
        const js = read(path.join(ws, 'game.js'))
        // 画布(canvas)和 DOM 宫格(3x3 grid/div)都是合法实现，不能只认 canvas
        const hasBoard = /<canvas|grid-template-columns|\.hole|game-container|<td/i.test(html)
        const hasScore = /score|分数/i.test(html + js)
        const hasInteract = /addEventListener|onclick/.test(js)
        const ok = hasBoard && hasScore && js.length > 200 && hasInteract
        return { ok, detail: `html=${html.length}B(board=${hasBoard} score=${hasScore}) js=${js.length}B(interact=${hasInteract})` }
      }
    },
    cli: {
      name: '命令行程序：四则运算 calc.js',
      prompt:
        '写一个 Node 命令行程序 calc.js：从命令行参数读取表达式，支持 + - * / 四则运算，' +
        '例如 `node calc.js 7 "*" 6` 输出 42（注意乘法号要用引号）。写出错时给出友好提示。' +
        '写完后自己用 run_shell 运行 `node calc.js 7 "*" 6` 和 `node calc.js 9 "+" 1` 验证输出分别是 42 和 10，' +
        '不对就修到对。做完调用任务完成。',
      expects: ['calc.js'],
      verify: (ws) => {
        const src = read(path.join(ws, 'calc.js'))
        let run = ''
        try {
          run = execFileSync(process.execPath, [path.join(ws, 'calc.js'), '7', '*', '6'], { encoding: 'utf8', timeout: 8000 }).trim()
        } catch (e) { run = 'ERR:' + (e.stderr || e.message).toString().slice(0, 80) }
        return { ok: run === '42' && src.length > 50, detail: `calc.js=${src.length}B 运行7*6="${run}"` }
      }
    },
    modify: {
      name: '修改已有代码：修 buggy.js 的 bug',
      prompt:
        '工作区里有一个 buggy.js，add 函数有 bug：它只接收一个参数，导致 add(2,5) 输出 NaN。' +
        '先 read_file 读它，再用 edit_file（或 write_file）把 bug 修对，让 `node buggy.js` 输出 7。' +
        '改完自己用 run_shell 运行 `node buggy.js` 验证输出是 7，不对就继续修。做完调用任务完成。',
      expects: ['buggy.js'],
      seed: (ws) => fs.writeFileSync(path.join(ws, 'buggy.js'), 'function add(a) {\n  return a + 5\n}\n\nconsole.log(add(2, 5))\n', 'utf8'),
      verify: (ws) => {
        let out = ''
        try {
          out = execFileSync(process.execPath, [path.join(ws, 'buggy.js')], { encoding: 'utf8', timeout: 8000 }).trim()
        } catch (e) { out = 'ERR:' + (e.stderr || e.message).toString().slice(0, 80) }
        return { ok: out === '7', detail: `node buggy.js => "${out}"` }
      }
    },
    product: {
      name: '产品：个人任务清单网页（带本地存储）',
      prompt:
        '在工作区做一个真正可用的「个人待办清单」网页产品，写 index.html、style.css、app.js 三个文件，' +
        'index.html 正确引入它们。功能要求：1) 输入任务并能添加；2) 列表显示所有任务，可勾选完成（完成有视觉区分）；' +
        '3) 可删除任务；4) 用 localStorage 持久化，刷新后数据还在；5) 界面整洁美观、中文界面。' +
        '写完自己用 node --check app.js 检查语法，有错修到通过。做完调用任务完成。',
      expects: ['index.html', 'style.css', 'app.js'],
      verify: (ws) => {
        const html = read(path.join(ws, 'index.html'))
        const css = read(path.join(ws, 'style.css'))
        const js = read(path.join(ws, 'app.js'))
        const linked = /style\.css/.test(html) && /app\.js/.test(html)
        const ok = linked && /localStorage/.test(js) && /addEventListener|onclick/.test(js) && css.length > 100 && js.length > 200
        return { ok, detail: `link=${linked} localStorage=${/localStorage/.test(js)} html=${html.length}B css=${css.length}B js=${js.length}B` }
      }
    },
    webpage: {
      name: '产品：数据展示单页（Chart 仪表盘）',
      prompt:
        '在工作区做一个单文件 index.html 的数据仪表盘产品：用原生 Canvas 或内联 SVG 画一个柱状图展示一组' +
        '示例月度销售数据（1-6月），带标题、图例和数值标签，纯前端、不依赖外网 CDN（离线可打开）。' +
        '要求页面自包含、样式美观。写完调用任务完成。',
      expects: ['index.html'],
      verify: (ws) => {
        const html = read(path.join(ws, 'index.html'))
        const ok = html.length > 400 && /<canvas|<svg/i.test(html) && /月|销售/.test(html)
        return { ok, detail: `index.html=${html.length}B(canvas/svg=${/<canvas|<svg/i.test(html)})` }
      }
    },
    fetch: {
      name: '联网访问：查询信息并落盘',
      prompt:
        '用网络工具（web_fetch 或 web_search）查询「Node.js 当前最新 LTS 版本号」，' +
        '把查到的版本号和简要结论写入 answer.txt（只要结论，一两句话）。如果网络工具不可用，' +
        '就如实写「网络工具不可用」到 answer.txt。写完调用任务完成。',
      expects: ['answer.txt'],
      verify: (ws) => {
        const t = read(path.join(ws, 'answer.txt')).trim()
        return { ok: t.length > 0, detail: `answer.txt="${t.slice(0, 80)}"` }
      }
    }
  }
}

/** 通过 SSE 跑一轮，返回事件汇总 */
async function runTask(cfg, def, key) {
  const base = `http://127.0.0.1:${cfg.port}`
  const auth = { Authorization: `Bearer ${cfg.token}` }
  const jpost = async (p, body) => {
    const r = await fetch(`${base}${p}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }

  const ws = path.join(E2E_ROOT, `${key}-${Date.now().toString(36)}`)
  fs.mkdirSync(ws, { recursive: true })
  if (def.seed) def.seed(ws)

  const sess = await jpost('/chat/session', { workspace: ws })
  if (sess.status !== 200 || !sess.body.sessionId) throw new Error('/chat/session 失败 ' + JSON.stringify(sess))
  const sid = sess.body.sessionId

  const events = []
  let finished = null
  const terminated = new Promise((resolve) => {
    const ac = new AbortController()
    const timer = setTimeout(() => { ac.abort(); resolve('timeout') }, TIMEOUT)
    fetch(`${base}/chat/events?session=${sid}&token=${cfg.token}`, {
      headers: { accept: 'text/event-stream' }, signal: ac.signal
    }).then(async (r) => {
      if (!r.ok || !r.body) { resolve('sse-fail:' + r.status); return }
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      const onEvent = (type, data) => {
        let parsed = data
        try { parsed = JSON.parse(data) } catch {}
        const ev = { type, data: parsed }; if (process.env.ROROTO_E2E_DUMP) console.log("  [EV]", type, JSON.stringify(parsed).slice(0, 400))
        events.push(ev)
        if (type === 'done') { clearTimeout(timer); resolve('done') }
        if (type === 'error') { clearTimeout(timer); resolve('error') }
      }
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2)
          let type = 'message', data = ''
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event: ')) type = line.slice(7)
            else if (line.startsWith('data: ')) data += line.slice(6)
            else if (line.startsWith(':')) { /* 心跳注释 */ }
          }
          if (data && type !== 'ready') onEvent(type, data)
        }
      }
    }).catch(() => { clearTimeout(timer); resolve('sse-err') })
  })

  // 先确保 SSE 已订阅（ready），再发消息，避免漏事件
  await new Promise((r) => setTimeout(r, 400))
  const send = await jpost('/chat/send', { sessionId: sid, text: def.prompt, approvalPolicy: 'allow' })
  if (send.status !== 202) { finished = 'send-fail:' + send.status; }
  else finished = await terminated

  // 汇总
  const toolCalls = events.filter((e) => e.type === 'tool_start').map((e) => e.data?.tool)
  const errs = events.filter((e) => e.type === 'error').map((e) => e.data?.message)
  const done = events.find((e) => e.type === 'done')
  const fileChanges = events.filter((e) => e.type === 'file_change').length
  const text = events.filter((e) => e.type === 'delta').map((e) => e.data?.text || '').join('')
  return { ws, sid, finished, toolCalls, errs, done: done?.data, fileChanges, textLen: text.length, events: events.length }
}

async function main() {
  const cfg = daemonInfo()
  if (!cfg) { console.error('读不到 daemon.json，程序没启动？'); process.exit(2) }
  const defs = taskDefs()
  let keys
  if (MODE === 'probe') keys = ['probe']
  else if (MODE === 'one') keys = ONLY ? ONLY.split(',') : ['game']
  else keys = Object.keys(defs).filter((k) => k !== 'probe')
  fs.mkdirSync(E2E_ROOT, { recursive: true })

  let pass = 0, fail = 0
  const summary = []
  console.log('===== 在线模型端到端验收 =====')
  console.log(`daemon ${cfg.port} · 模式 ${MODE} · 任务 ${keys.join(', ')}`)
  console.log(`工作区根目录: ${E2E_ROOT}\n`)

  for (const key of keys) {
    const def = defs[key]
    if (!def) { console.log(`跳过未知任务 ${key}`); continue }
    console.log(`\n----- ${def.name} [${key}] -----`)
    const t0 = Date.now()
    try {
      const r = await runTask(cfg, def, key)
      const secs = ((Date.now() - t0) / 1000).toFixed(1)
      const v = def.verify(r.ws)
      const runOk = r.finished === 'done'
      const ok = runOk && v.ok
      console.log(`  事件=${r.events} 工具调用=${r.toolCalls.length}(${[...new Set(r.toolCalls)].join(',')}) 文件变更=${r.fileChanges} 文本=${r.textLen}字 用时=${secs}s`)
      console.log(`  收尾=${r.finished} done.note="${(r.done?.note || '').slice(0, 60)}"`)
      if (r.errs.length) console.log(`  错误=${r.errs.join(' | ').slice(0, 160)}`)
      console.log(`  成品校验: ${v.ok ? 'OK' : 'FAIL'} — ${v.detail}`)
      console.log(`  工作区: ${r.ws}`)
      if (ok) pass++; else fail++
      summary.push({ key, ok, secs, verify: v.detail, run: r.finished, ws: r.ws })
    } catch (e) {
      fail++
      console.log(`  EXCEPTION: ${e.message}`)
      summary.push({ key, ok: false, err: e.message })
    }
  }

  console.log('\n===== 汇总 =====')
  for (const s of summary) console.log(`  ${s.ok ? 'PASS' : 'FAIL'}  ${s.key}  ${s.secs || ''}s  ${s.verify || s.err || ''}`)
  console.log(`\n${pass} 通过 / ${fail} 失败`)
  fs.writeFileSync(path.join(E2E_ROOT, 'summary.json'), JSON.stringify({ mode: MODE, at: new Date().toISOString(), pass, fail, summary }, null, 2), 'utf8')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('驱动异常:', e); process.exit(2) })
