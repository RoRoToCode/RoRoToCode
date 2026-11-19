/**
 * 「首字之前长时间静默」的三条约束。
 *
 * 现场：上下文到 1.5 万 token 之后，界面十几分钟一声不响，服务端 decoded 一直停在几十，
 * 请求在反复重启。成因是三层叠在一起：
 *   1. 收到任何一帧（包括 llama.cpp 的 keep-alive 空帧）就把看门狗切到「流式」段，
 *      于是 prefill 期间的正常沉默被当成「连接断了」掐掉；
 *   2. 掐掉之后按「可重试」处理，原样重发同一份长提示 —— 服务端再从头 prefill，再被掐；
 *   3. 这整段时间界面没有任何输出。
 * 这里分别锁住：空帧不切段位、等待期有上报、首字超时归类为「不能原样重发」。
 */
const test = require('node:test')
const assert = require('node:assert')
const { idleGuard, guardLimits } = require('../dist/main/providers/base.js')
const { quietTimeout, retryable, writeCapMs, localCapVerdict } = require('../dist/main/agent.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('首字之前会定期上报「已等多久」，不会一声不响', async () => {
  const waits = []
  let aborted = null
  const g = idleGuard((r) => (aborted = r), {
    firstMs: 60_000,
    onWait: (ms) => waits.push(ms),
    waitEveryMs: 20,
    tickMs: 5
  })
  await sleep(80)
  g.stop()
  assert.equal(aborted, null, '还没到时限不该掐')
  assert.ok(waits.length >= 2, `应当至少上报两次，实际 ${waits.length} 次`)
  assert.ok(waits.every((ms) => ms >= 0))
})

test('拿到内容之后就不再报「还在等首字」', async () => {
  const waits = []
  const g = idleGuard(() => undefined, {
    firstMs: 60_000,
    onWait: (ms) => waits.push(ms),
    waitEveryMs: 20,
    tickMs: 5
  })
  await sleep(50)
  const before = waits.length
  assert.ok(before >= 1)
  g.touch() // 真正的正文 / 工具参数到了
  await sleep(60)
  g.stop()
  assert.equal(waits.length, before, '已经开始了就不该再报等待')
})

test('首字超时的文案点明「预填充」且说明不会再自动重发', async () => {
  let aborted = null
  const g = idleGuard((r) => (aborted = r), { firstMs: 30, tickMs: 5, idleMs: 90_000 })
  await sleep(70)
  g.stop()
  assert.ok(aborted, '到了时限必须掐断')
  assert.match(aborted, /第一个字/)
  assert.match(aborted, /预填充/)
  assert.match(aborted, /不会再自动重发/)
})

test('已经开始输出之后，用的是「生成中断」那一段时限', async () => {
  let aborted = null
  const g = idleGuard((r) => (aborted = r), { firstMs: 20, idleMs: 200, tickMs: 5 })
  g.touch()
  await sleep(80)
  assert.equal(aborted, null, '刚 touch 过，不该按首字时限掐')
  await sleep(200)
  g.stop()
  assert.ok(aborted)
  assert.match(aborted, /生成中断|没有收到新内容/)
})

test('首字超时被归类为「不能原样重发」', () => {
  assert.equal(quietTimeout(new Error('等了 10 分钟仍然没有拿到第一个字：本地模型多半卡在预填充上')), true)
  assert.equal(quietTimeout(new Error('生成中断：90 秒没有收到新内容，连接可能已断开。')), true)
  assert.equal(quietTimeout(new Error('请求超时')), true)
  // 普通的服务端错误、连接失败不在此列（那些重试是有意义的）
  assert.equal(quietTimeout(new Error('HTTP 500 Internal Server Error')), false)
  assert.equal(quietTimeout(new Error('连接失败：fetch failed')), false)
  assert.equal(quietTimeout(new Error('HTTP 400 request exceeds context size')), false)
})

test('「请求超时」本身仍算可重试，只是被首字超时那条规则优先挡下', () => {
  // 这两条必须同时成立：retryable 决定「值不值得再试」，quietTimeout 决定「是不是原样再试」
  assert.equal(retryable(new Error('请求超时')), true)
  assert.equal(quietTimeout(new Error('请求超时')), true)
})

/* ------------------------------------------------------------------ *
 * 看门狗分级 + 可观测（2026-11-19 追加）
 *
 * 现场：14:41 到 15:01 一个单请求挂了 20 分钟，日志里只有一句「请求超时」。
 * 云端首字时限和总超时都是 10 分钟、谁先到看运气，且掐断时不留任何痕迹。
 * 这一组锁住三件事：按本机/云端分级、掐断只发生一次、掐断时能上报。
 * ------------------------------------------------------------------ */
test('看门狗时限按本机/云端分级：本机给预填充留足，云端 150 秒', () => {
  const local = guardLimits({ name: '本机', baseUrl: 'http://127.0.0.1:8080' })
  assert.equal(local.firstMs, 10 * 60_000, '本地长上下文预填充本来就要几分钟')
  assert.equal(local.idleMs, 90_000)
  assert.equal(local.local, true)

  const cloud = guardLimits({ name: '云端', baseUrl: 'https://api.example.com/v1' })
  assert.equal(cloud.firstMs, 150_000, '云端一个字都不吐，不该让人等十分钟')
  assert.equal(cloud.idleMs, 90_000, '首字之后的时限两边一致')
  assert.equal(cloud.local, false)
})

test('掐断只发生一次，且 onTrip 能拿到段位与静默时长', async () => {
  const trips = []
  let aborts = 0
  const g = idleGuard(() => aborts++, { firstMs: 20, tickMs: 5, onTrip: (i) => trips.push(i) })
  // 触发后再多跑几轮 tick：以前不停表，这里会打出十几次 abort
  await sleep(140)
  g.stop()
  assert.equal(aborts, 1, '掐断必须只发生一次，否则加了日志会刷屏')
  assert.equal(trips.length, 1)
  assert.equal(trips[0].phase, 'first')
  assert.ok(trips[0].waitedMs >= 20)
})

test('云端首字超时的文案指向网关，不是「预填充」', async () => {
  let aborted = null
  const g = idleGuard((r) => (aborted = r), { firstMs: 20, tickMs: 5, local: false })
  await sleep(70)
  g.stop()
  assert.ok(aborted)
  assert.match(aborted, /云端服务没有响应/, '云端没有本地预填充可等，说「预填充」会带着人去查错地方')
  assert.ok(!aborted.includes('预填充'))
  // 这句话必须能被 explainStreamFailure 认出来，否则界面上会退化成一句「已取消」
  assert.match(aborted, /第一个字/)
})

test('本地 worker 的墙钟护栏只套「本地 + 写型」任务', () => {
  const local = { id: 'l', name: '本地', runtime: 'llama', baseUrl: 'http://127.0.0.1:8080' }
  const cloud = { id: 'c', name: '云端', baseUrl: 'https://api.example.com/v1' }
  assert.equal(writeCapMs(local, false), 10 * 60_000, '本地写型子任务要有上限')
  assert.equal(writeCapMs(local, true), 0, '只读探查没有破坏性，不该被掐')
  assert.equal(writeCapMs(cloud, false), 0, '云端 worker 有自己的超时与重试策略')
  assert.equal(writeCapMs(null, false), 0, '回落主模型时不管')
})

test('墙钟到点后的话要说清「还能不能接着干」', () => {
  const withFiles = localCapVerdict(600_000, 27, 108, ['ui.py', 'sgf.py'])
  assert.match(withFiles.error, /10 分钟/)
  assert.match(withFiles.error, /27 步 · 108 次工具调用/)
  assert.match(withFiles.error, /ui\.py、sgf\.py/, '必须告诉父 agent 动过哪些文件')
  assert.ok(!/重派一次是安全的/.test(withFiles.error), '改过文件就不能说「重派是安全的」')

  const clean = localCapVerdict(600_000, 3, 4, [])
  assert.match(clean.error, /没有写入任何文件/)
  assert.match(clean.error, /拆小重派一次是安全的/)

  assert.match(withFiles.note, /墙钟上限 10 分钟已到/)
  assert.match(withFiles.summary, /拆小再派/)
})

module.exports = {}
