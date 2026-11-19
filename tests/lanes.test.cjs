/**
 * 「本次能并行几路」的唯一判定源。
 *
 * 起因（真实现场）：主模型在云端、只配了 1 个云端 worker，系统提示按「配了几个」
 * 判断，于是教模型「同一轮连写 2～3 个 task」；而执行层按「池里几个就绪」开闸，
 * 上限是 1。三路只读审查排成一队，还全撞在同一家限流上、一起 429。
 *
 * 这里守的契约：
 * 1. `laneCount` 就是执行层的并发上限，提示只说这个数；
 * 2. systemPrompt 的措辞随 lanes 切换（1 路时不劝多路，也不说「能真正并行」）；
 * 3. 刚失败的 provider 在冷却窗口内会被 workerPool 跳过 —— 不再把新一轮活压给它。
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const { laneCount } = require('../dist/shared/agentpool.js')
const { parallelLanes, workerPool } = require('../dist/main/worker.js')
const { noteProviderFailure, noteProviderSuccess, providerCooling, resetProviderHealth } =
  require('../dist/main/health.js')
const agent = require('../dist/main/agent.js')

const main = {
  id: 'main',
  name: '云端主模型',
  model: 'mistralai/mistral-large',
  baseUrl: 'https://api.example.com/v1',
  kind: 'openai'
}
const llama = {
  id: 'llama',
  name: '本地 llama.cpp',
  runtime: 'llama',
  model: 'qwen.gguf',
  baseUrl: 'http://127.0.0.1:8080',
  kind: 'openai'
}
const worker = (id, extra = {}) => ({
  id,
  name: id,
  model: 'nvidia/nemotron',
  baseUrl: 'https://api.example.com/v1',
  role: 'worker',
  kind: 'openai',
  ...extra
})
const cfg = (workers) => ({ providers: [main, ...workers], activeId: main.id })

/* ---------------------------------------------------------------- *
 * laneCount：执行层的并发上限
 * ---------------------------------------------------------------- */
test('laneCount：池里几个就几路，没池子时本地 1 / 远端 3，上限 8', () => {
  assert.equal(laneCount(0, true), 1, '本地单槽只能 1 路')
  assert.equal(laneCount(0, false), 3, '远端回落主模型可以 3 路')
  assert.equal(laneCount(1, false), 1, '只有 1 个 worker 就是串行 —— 这正是之前错位的地方')
  assert.equal(laneCount(2, false), 2)
  assert.equal(laneCount(5, true), 5, '本地池子有 5 个就按 5 个')
  assert.equal(laneCount(20, false), 8, '上限 8，别一次把闸门塞满')
})

/* ---------------------------------------------------------------- *
 * parallelLanes：真去查一次池子
 * ---------------------------------------------------------------- */
test('parallelLanes：1 个 worker → 1 路；没配 → 按主模型算', async () => {
  assert.equal(await parallelLanes(main, cfg([])), 3, '无 worker + 云端主模型 = 3')
  assert.equal(await parallelLanes(main, cfg([worker('w-lane-1')])), 1, '1 个 worker 只能串行')
  assert.equal(
    await parallelLanes(main, cfg([worker('w-lane-2a'), worker('w-lane-2b')])),
    2,
    '2 个 worker 就 2 路'
  )
})

/* ---------------------------------------------------------------- *
 * 提示层：同一个数决定措辞
 * ---------------------------------------------------------------- */
const prompt = (p, opts) => agent.systemPrompt('/tmp/ws', p, { web: true, remember: true, ...opts })

test('systemPrompt：1 路时不劝多路，也不说「能真正并行」', () => {
  const one = prompt(main, { subAgents: 1, lanes: 1 })
  assert.ok(!one.includes('可以真正并行'), '只有 1 路还说「能真正并行」就是原来的 bug')
  assert.ok(one.includes('本次同时只放得下 1 路'), '要说清为什么只能派 1 个')
  assert.ok(one.includes('派 1 个 `task(mode=explore)`'), '审查该派 1 个')
  assert.ok(!one.includes('同一轮连写 3 个'), '不能劝它连写 3 个')
  assert.ok(one.includes('就拆成几个 task 派出去'), '拆还是可以拆，只是不承诺同时跑')
})

test('systemPrompt：多路时才鼓励分头查，且路数跟着 lanes 走', () => {
  const three = prompt(main, { subAgents: 3, lanes: 3 })
  assert.ok(three.includes('本次能真正并行 3 路'))
  assert.ok(three.includes('同一轮连写 3 个'))
  assert.ok(three.includes('就在同一轮连写多个 task 一起派出去'))

  const two = prompt(main, { subAgents: 2, lanes: 2 })
  assert.ok(two.includes('同一轮连写 2 个'), '只有 2 路就别教它写 3 个')
  assert.ok(!two.includes('同一轮连写 3 个'))
})

test('systemPrompt：不传 lanes 时按「没配 worker」估，和以前行为一致', () => {
  const local = prompt(llama, {})
  assert.ok(local.includes('派 1 个 `task(mode=explore)`'))
  assert.ok(local.includes('但这条路在本机是**串行**的'))

  const remote = prompt(main, {})
  assert.ok(remote.includes('同一轮连写 3 个'), '云端主模型回落时本来就能并发 3 个')
})

/* ---------------------------------------------------------------- *
 * 健康状态：刚失败的那家先别派活
 * ---------------------------------------------------------------- */
test('健康状态：限流/超时/5xx 才冷却，鉴权错与排队不算', () => {
  resetProviderHealth()
  noteProviderFailure('h1', new Error('「A」HTTP 429 rate limit'))
  assert.ok(providerCooling('h1'), '429 应该进冷却')
  noteProviderSuccess('h1')
  assert.equal(providerCooling('h1'), null, '成功一次就解除')

  noteProviderFailure('h2', new Error('「B」HTTP 401 unauthorized'))
  assert.equal(providerCooling('h2'), null, '鉴权错不是「忙」，冷却它只会把问题藏起来')

  noteProviderFailure('h3', new Error('本机模型排队超过 900 秒还没轮到这个请求'))
  assert.equal(providerCooling('h3'), null, '本机忙是排队，不是坏了')

  noteProviderFailure('h4', new Error('「D」连接失败'))
  assert.ok(providerCooling('h4'), '连不上也算暂时用不了')
})

test('workerPool：冷却中的远端 worker 被跳过，并标出原因', async () => {
  resetProviderHealth()
  const cool = worker('w-cool')
  // 正常情况下它就在池子里
  assert.equal((await workerPool(main, cfg([cool]))).pool.length, 1)

  noteProviderFailure('w-cool', new Error('「w-cool」HTTP 429 Too Many Requests'))
  const after = await workerPool(main, cfg([cool]))
  assert.equal(after.pool.length, 0, '冷却中不该再往它身上派活')
  assert.equal(after.skipped.length, 1)
  assert.equal(after.skipped[0].cooling, true, '要标出来是「冷」而不是「没起来」，否则会白等预热')
  assert.match(after.skipped[0].reason, /429/)
  assert.equal(after.configuredCount, 1, '配了几个不变，变的是这次能不能用')

  // 全部冷却时 parallelLanes 回落到主模型的并发（云端 3），和执行层的回落一致
  assert.equal(await parallelLanes(main, cfg([cool])), 3)

  noteProviderSuccess('w-cool')
  assert.equal((await workerPool(main, cfg([cool]))).pool.length, 1, '恢复后重新进池')
})
