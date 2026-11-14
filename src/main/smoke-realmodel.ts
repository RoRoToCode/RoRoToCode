/**
 * 真机冒烟：真的起一个 llama-server，真的加载 gguf，真的走一次对话，真的停掉。
 *
 * 为什么必须用真模型跑，而前面那堆假服务不够：
 * 假服务能证明「解析逻辑对」，但证明不了下面三件只在真机上才暴露的事——
 *   1. 停止时 `killPidSync` 的返回值判定对不对。判错的方向有两个：都当成功（进程还活着
 *      却报 ok，显存永远回不来）、都当失败（反复重试、实例表删不掉）。只有真进程能验。
 *   2. 「我主动停的」和「它自己崩的」有没有分清。加载中直接停掉，如果被记成 crash，
 *      自愈逻辑会立刻再拉一次，用户点「停止」反而越停越起。
 *   3. 健康启动会不会污染重启计数。计数在 spawn 时被清零过一次，结果是失败以后无限重启；
 *      修完必须证明「一路成功跑完，计数还是 0」，以及「重启一次后还是 0」。
 *
 * 用法（本机 ELECTRON_RUN_AS_NODE=1，必须 unset，否则 app 是假的）：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron dist/main/smoke-realmodel.js
 */
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// 配置必须隔离：这个脚本会写 activeId / baseUrl，不能动到用户真实的那份。
app.setPath('userData', path.join(os.tmpdir(), 'rorotocode-realmodel-smoke'))

// 模型和 llama-server 都在 release/ 下，显式指定数据目录，别碰用户真实数据。
const repoRelease = path.resolve(__dirname, '..', '..', 'release')
if (!process.env.ROROTO_DATA_DIR && fs.existsSync(path.join(repoRelease, 'llama.cpp'))) {
  process.env.ROROTO_DATA_DIR = repoRelease
}

import { chat } from './providers'
import type { ChatMessage, ProviderConfig } from '../shared/types'
import {
  detectBackend,
  lastCrashOf,
  llamaInstances,
  localGgufFiles,
  restartCountOf,
  startLlama,
  statusLlama,
  stopLlama
} from './llama'

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

/** 进程还在不在。tasklist 输出是 GBK，别按文字匹配，直接看有没有那行 llama-server。 */
function pidAlive(pid: number): boolean {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true })
  return /llama-server/i.test(r.stdout ?? '')
}

async function waitReady(timeoutMs: number): Promise<{ ready: boolean; state: string; note: string }> {
  const begin = Date.now()
  let last = ''
  while (Date.now() - begin < timeoutMs) {
    const st = await statusLlama()
    last = `${st.state}${st.phase ? `/${st.phase}` : ''} ${st.message}`
    if (st.state === 'ready') return { ready: true, state: st.state, note: last }
    if (st.state === 'error') return { ready: false, state: st.state, note: last }
    // 刚 spawn 的头几秒可能还没进 loading，idle 只在「一直 idle」时才算失败
    if (st.state === 'idle' && Date.now() - begin > 5000) return { ready: false, state: st.state, note: last }
    await sleep(500)
  }
  return { ready: false, state: 'timeout', note: last }
}

function msg(role: 'user', content: string): ChatMessage {
  return { id: `m-${Math.random().toString(36).slice(2)}`, role, content, createdAt: Date.now() }
}

/**
 * 跑哪个模型：环境变量 > 作者挑的 3B > models/ 里体积最小的那个。
 *
 * 原来写死一个 3B 文件名，换台机器（或刚好没下这个模型）就整个跑不起来，
 * 而且失败得很误导：resolveModelPath 会退回目录第一个 gguf，于是「3B 冒烟」
 * 实际加载的是别的模型，用户只看到一句「服务未运行」。
 */
async function pickModel(): Promise<string> {
  const env = (process.env.ROROTO_SMOKE_MODEL ?? '').trim()
  if (env) return env
  const plain = (await localGgufFiles()).filter((f) => !/-mmproj\.gguf$/i.test(f.name))
  const preferred = plain.find((f) => f.name === 'Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf')
  if (preferred) return preferred.name
  // 冒烟只要求「能加载、答得上话」，越小加载越快
  return [...plain].sort((a, b) => a.sizeBytes - b.sizeBytes)[0]?.name ?? ''
}

async function main(): Promise<void> {
  const model = await pickModel()

  console.log('===== realmodel =====')
  console.log(`模型：${model || '（没找到任何 .gguf）'}`)

  // ---- 0. 后端与文件 ----
  const backend = await detectBackend()
  console.log(
    `后端：backend=${backend.backend} gpuReady=${backend.gpuReady} installed=${backend.installed}` +
      `${backend.note ? ` note=${backend.note}` : ''}`
  )
  check('llama.cpp 已装（找得到 llama-server.exe）', backend.installed)
  check('后端类型能识别出来（不是空结论）', typeof backend.backend === 'string' && backend.backend.length > 0)

  // ---- 1. 加载中直接停止：必须算「我停的」，不能记成崩溃 ----
  // 这条是 stoppingPids / stopping 那套标记的核心：判错的话自愈会把用户按下的「停止」
  // 变成「重启」，而且日志里还留一条假的 crash 现场。
  const first = await startLlama(model, 4096)
  check('startLlama 接受真模型并拉起进程', first.ok, first.message)
  if (!first.ok) {
    console.log('\n启动失败，后面的用例没有意义')
    return
  }
  const instAfterStart = llamaInstances()
  const pid1 = instAfterStart[0]?.pid ?? null
  const key1 = instAfterStart[0]?.key ?? ''
  check('实例表里有进程号（真的是 spawn 出来的）', pid1 != null && pid1 > 0, String(pid1))

  const earlyStop = await stopLlama(key1)
  check('加载中停止返回成功', earlyStop.ok, earlyStop.message)
  await sleep(600)
  check('加载中停止后进程真的没了', pid1 != null && !pidAlive(pid1), `pid=${pid1}`)
  check('加载中停止没有被记成崩溃（否则自愈会替用户「恢复」）', key1 ? lastCrashOf(key1) == null : false)

  // ---- 2. 完整启动到 ready ----
  const second = await startLlama(model, 4096)
  check('再次启动成功', second.ok, second.message)
  const ready = await waitReady(180_000)
  check('服务真的加载完并 ready', ready.ready, ready.note)
  if (!ready.ready) return

  const st = await statusLlama()
  const key = llamaInstances()[0]?.key ?? key1
  const pid2 = llamaInstances()[0]?.pid ?? null
  console.log(`就绪：端口 ${st.port}，模型 ${(st.models || []).join(',') || model}，耗时 ${st.elapsedMs ?? '?'}ms`)
  check('状态里带端口', typeof st.port === 'number' && st.port > 0)
  // 闸门是惰性的：没发过请求就不去探 /props（省得每个界面轮询都多打一次服务端）。
  // 所以这里只能说「要么没探，要么探出来的数是对的」，不能要求它一定有值。
  check(
    '没发请求时不编造槽位数（闸门惰性探测）',
    st.queue === undefined || st.queue.limit >= 1,
    JSON.stringify(st.queue)
  )
  check('健康启动后重启计数是 0（不再被 spawn 清零污染）', restartCountOf(key) === 0, String(restartCountOf(key)))
  check('健康启动后没有遗留崩溃记录', lastCrashOf(key) == null)

  // ---- 3. 真对话：走 providers 的 SSE 解析，不是直连 ----
  const provider: ProviderConfig = {
    id: 'llamacpp',
    name: '本地 llama.cpp',
    kind: 'openai',
    baseUrl: `http://127.0.0.1:${st.port}`,
    model,
    contextWindow: 4096,
    temperature: 0
  }
  let streamed = ''
  const t0 = Date.now()
  const result = await chat({
    provider,
    messages: [
      msg(
        'user',
        '只回复这一个词，不要任何解释、不要标点：PONG'
      )
    ],
    tools: [],
    signal: new AbortController().signal,
    onText: (t) => {
      streamed += t
    }
  })
  const wall = Date.now() - t0
  const text = (result.text || '').trim()
  console.log(`回答：“${text.slice(0, 80)}”  ${wall}ms${result.genMs ? `（纯生成 ${result.genMs}ms）` : ''}`)
  check('真实对话拿到了非空回答', text.length > 0, `len=${text.length}`)
  check('流式回调拼出来的正文与最终结果一致', streamed.trim() === text || text.includes(streamed.trim().slice(0, 8)))
  check('回答里出现 PONG（模型真的按指令答了）', /PONG/i.test(text), text.slice(0, 120))
  check('带了用量或纯生成耗时', !!result.usage || typeof result.genMs === 'number')

  // 闸门只在「正在跑 / 有人在等」时才对外报 —— 空闲时不返回，免得界面每次轮询
  // 都看到一个恒定的 0/0。所以只能趁请求在途时观察，这才是真机上唯一能验证的时机。
  let inFlight = true
  // 用数组装而不是 let 变量：赋值发生在闭包里，TS 的控制流会把 let 收窄成 null
  const seen: Array<{ active: number; queued: number; limit: number }> = []
  const poll = (async () => {
    while (seen.length === 0) {
      if (!inFlight) break
      const s = await statusLlama()
      if (s.queue && s.queue.active >= 1) seen.push(s.queue)
      else await sleep(25)
    }
  })()
  // 要一段足够长的输出，3B 模型答 PONG 只花 40ms，来不及观察
  const long = await chat({
    provider,
    messages: [msg('user', '用中文写一段大约 150 字的自我介绍，不要用列表，直接写成一段话。')],
    tools: [],
    signal: new AbortController().signal,
    onText: () => undefined
  })
  inFlight = false
  await poll
  check('长回答也拿到了正文', (long.text || '').trim().length > 20, `len=${(long.text || '').length}`)
  // 这一条才是「/props 在真 llama.cpp 上解得动 + 槽位记账正确」的证据：
  // 假服务只能证明照文档写对了，证明不了真实服务回的字段长什么样。
  check(
    '请求在途时闸门可见，且槽位上限来自真服务',
    seen.length > 0 && seen[0].limit >= 1 && seen[0].active >= 1,
    JSON.stringify(seen[0] ?? null)
  )
  const stIdle = await statusLlama()
  check('请求结束后槽位已归还（空闲时不报队列，没漏放槽位）', stIdle.queue == null, JSON.stringify(stIdle.queue))

  // ---- 4. 停止：返回值判定得对，进程也必须真没了 ----
  const stopped = await stopLlama(key)
  check('stopLlama 返回成功', stopped.ok, stopped.message)
  await sleep(800)
  check('停止后进程真的消失（killPidSync 的判定没错）', pid2 != null && !pidAlive(pid2), `pid=${pid2}`)
  check('停止后实例表清空', !llamaInstances().some((i) => i.key === key))
  const stAfter = await statusLlama()
  check('停止后状态不再是 ready', stAfter.state !== 'ready', stAfter.state)
  check('主动停止没有被记成崩溃', lastCrashOf(key) == null)

  const stopAgain = await stopLlama(key)
  check('再停一次是幂等的（不抛错、不误报失败）', stopAgain.ok, stopAgain.message)

  // ---- 5. 停完再起：停止标记不能污染下一次启动 ----
  const third = await startLlama(model, 4096)
  check('停止后能再次启动（stoppingPids 没有留下毒标记）', third.ok, third.message)
  const ready2 = await waitReady(180_000)
  check('第二次启动仍能 ready', ready2.ready, ready2.note)
  check('重启一次后计数仍是 0（成功路径会把计数清掉）', restartCountOf(key) === 0, String(restartCountOf(key)))

  const stopFinal = await stopLlama(key)
  check('收尾停止成功', stopFinal.ok, stopFinal.message)
  await sleep(600)
  const left = llamaInstances()
  check('收尾后没有残留实例', left.length === 0, JSON.stringify(left))
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
    if (failed === 0) {
      console.log(`全部通过（${passed} 项）`)
      app.exit(0)
    } else {
      console.log(`${failed} 项失败`)
      app.exit(1)
    }
  })
