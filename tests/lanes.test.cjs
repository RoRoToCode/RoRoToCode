/**
 * 「本次能并行几路」的唯一判定源。
 *
 * 起因（真实现场）：主模型在云端、只配了 1 个云端 worker，系统提示按「配了几个」
 * 判断，于是教模型「同一轮连写 2～3 个 task」；而执行层按「池里几个就绪」开闸，
 * 上限是 1。三路只读审查排成一队，还全撞在同一家限流上、一起 429。
 *
 * 现在口径改成「按车道容量求和」：本地 llama 恒 1（一个进程一个槽），远端默认 3、
 * 可用 `provider.lanes` 覆写。所以「1 条云端 worker」= 3 路，不再是串行。
 *
 * 这里守的契约：
 * 1. `laneCount` 就是执行层的并发上限，提示只说这个数；
 * 2. 分派器按每条容量封顶，一批任务不会把某一条压爆；
 * 3. systemPrompt 的措辞随 lanes 切换（1 路时不劝多路，也不说「能真正并行」）；
 * 4. 刚失败的 provider 在冷却窗口内会被 workerPool 跳过 —— 不再把新一轮活压给它。
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const { laneCount, capacityOf, createSubAgentDispatcher } = require('../dist/shared/agentpool.js')
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
 *
 * 口径从「池里几条配置」换成「各条车道数之和」，修的是云端那半：
 * 一个 key 能同时接多个请求，不该因为列表里只有一行就被算成串行。
 * ---------------------------------------------------------------- */
test('capacityOf：本地恒 1，远端默认 3，可被 lanes 覆写且封顶 8', () => {
  assert.equal(capacityOf(llama), 1, '一个 llama-server 只有一个推理槽')
  assert.equal(capacityOf({ ...llama, lanes: 4 }), 1, '本地填了也不生效，多开只会互相顶掉')
  assert.equal(capacityOf(main), 3, '远端默认 3，和改动前的云端回落值一致')
  assert.equal(capacityOf({ ...main, lanes: 5 }), 5)
  assert.equal(capacityOf({ ...main, lanes: 0 }), 3, '0/非法值按默认处理')
  assert.equal(capacityOf({ ...main, lanes: -2 }), 3)
  assert.equal(capacityOf({ ...main, lanes: 99 }), 8, '单条封顶 8')
})

test('laneCount：按容量求和，池空时算主模型自己那条', () => {
  assert.equal(laneCount([], llama), 1, '本地单槽只能 1 路')
  assert.equal(laneCount([], main), 3, '远端主模型回落时可以 3 路')
  assert.equal(laneCount([worker('w1')], main), 3, '1 条云端 worker = 3 路（改动前被算成 1 路）')
  assert.equal(laneCount([worker('w1'), worker('w2')], main), 6)
  assert.equal(laneCount([llama], main), 1, '本地 worker 只有 1 路')
  assert.equal(laneCount([llama, worker('w1')], main), 4, '本地 1 + 云端 3')
  assert.equal(laneCount([worker('w1', { lanes: 2 }), worker('w2', { lanes: 2 })], main), 4)
  assert.equal(laneCount([worker('a'), worker('b'), worker('c')], main), 8, '总上限 8，别一次把闸门塞满')
})

test('createSubAgentDispatcher：批内按容量封顶，满员返回 null', () => {
  const one = { provider: worker('w1'), load: 0 }
  const pick1 = createSubAgentDispatcher([one])
  assert.equal(pick1()?.provider.id, 'w1')
  assert.equal(pick1()?.provider.id, 'w1')
  assert.equal(pick1()?.provider.id, 'w1')
  assert.equal(pick1(), null, '默认 3 路，第 4 个任务不该再压给它')

  const pair = [
    { provider: worker('a', { lanes: 2 }), load: 0 },
    { provider: worker('b', { lanes: 2 }), load: 0 }
  ]
  const pick2 = createSubAgentDispatcher(pair)
  const got = [pick2(), pick2(), pick2(), pick2()].map((m) => m?.provider.id)
  assert.deepEqual(got, ['a', 'b', 'a', 'b'], '两条各 2 路时按忙闲摊平')
  assert.equal(pick2(), null, '4 路用满后不再分派')

  const local = createSubAgentDispatcher([{ provider: { ...llama, id: 'l1' }, load: 0 }])
  assert.ok(local())
  assert.equal(local(), null, '本地恒 1 路')
})

test('分派器每批重建：上一批占满的实例，下一批还能继续接活', () => {
  // `assigned` 是批内计数。若跨批复用同一个分派器，第二批会看到「已满」而全员跳过，
  // 一批任务就悄悄全落到主模型上了 —— 这正是执行层每批重建的原因。
  const pool = [{ provider: worker('a'), load: 0 }]
  const first = createSubAgentDispatcher(pool)
  assert.ok(first())
  assert.ok(first())
  assert.ok(first())
  assert.equal(first(), null)

  const second = createSubAgentDispatcher(pool)
  assert.equal(second()?.provider.id, 'a', '新一批必须还能分派')
})

/* ---------------------------------------------------------------- *
 * parallelLanes：真去查一次池子
 * ---------------------------------------------------------------- */
test('parallelLanes：1 条云端 worker 就是 3 路；没配 → 按主模型算', async () => {
  assert.equal(await parallelLanes(main, cfg([])), 3, '无 worker + 云端主模型 = 3')
  assert.equal(
    await parallelLanes(main, cfg([worker('w-lane-1')])),
    3,
    '1 条云端 worker 能同时接 3 个请求，不该被算成串行'
  )
  assert.equal(
    await parallelLanes(main, cfg([worker('w-lane-2a'), worker('w-lane-2b')])),
    6,
    '2 条云端 worker = 6 路（总上限 8）'
  )
  assert.equal(
    await parallelLanes(main, cfg([worker('w-lane-3', { lanes: 1 })])),
    1,
    'lanes=1 可以把某条显式压回串行（限流严格的供应商）'
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
