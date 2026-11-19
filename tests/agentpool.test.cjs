const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createSubAgentDispatcher,
  pickSubAgentPool,
  subAgentKeepAliveIds,
  subAgentProviders,
  subIsolation
} = require('../dist/shared/agentpool.js')

/**
 * 「主 / 子智能体」的纯判定。
 *
 * 规则和线上模型一致：标了 role='worker' 的才是子，不再按「几块卡配好模型」自动成组。
 * 仍然要判的是「两块卡分不分得开」—— 同一张卡上两个 llama.cpp 实例会互相顶掉。
 */
const p = (id, model, baseUrl, extra = {}) => ({
  id,
  name: id,
  kind: 'openai',
  baseUrl,
  model,
  contextWindow: 32768,
  ...extra
})
const local = (id, device, extra = {}) =>
  p(id, `${id}.gguf`, `http://127.0.0.1:${8080 + Number(id.slice(1) || 0)}/v1`, {
    runtime: 'llama',
    device,
    ...extra
  })
const main = () => local('m0', 'CUDA0')
const subs = (...devices) =>
  devices.map((d, i) => local(`w${i + 1}`, d, { role: 'worker' }))

test('subAgentProviders：只认显式「子」，本地模型不再因为配好模型就自动进池', () => {
  const m = main()
  const list = [
    m,
    ...subs('CUDA1', 'CUDA2'),
    local('w3', 'CUDA3', { role: 'worker', model: '' }), // 空槽：不进池
    local('w4', 'CUDA4'), // 没标「子」：即使绑了卡也不进池（这是本次改动的核心）
    local('m0', 'CUDA0', { role: 'worker' }) // 主模型自己：永远不进池
  ]
  assert.deepEqual(subAgentProviders(list, m.id).map((x) => x.id), ['w1', 'w2'])
})

test('subAgentProviders：线上模型和本地模型同一套规则', () => {
  const remoteMain = p('m0', 'gpt', 'https://api.example.com/v1')
  const list = [
    remoteMain,
    p('a1', 'claude', 'https://api2.example.com/v1', { role: 'worker' }),
    p('a2', 'gemini', 'https://api3.example.com/v1'),
    local('w1', 'CUDA1', { role: 'worker' })
  ]
  assert.deepEqual(subAgentProviders(list, remoteMain.id).map((x) => x.id), ['a1', 'w1'])
})

test('池：主 + 两个不同卡上的子全部接纳', () => {
  const m = main()
  const [w1, w2] = subs('CUDA1', 'CUDA2')
  const r = pickSubAgentPool(m, [m, w1, w2])
  assert.deepEqual(r.accepted.map((x) => x.provider.id), ['w1', 'w2'])
  assert.deepEqual(r.skipped, [])
  assert.ok(r.accepted.every((x) => x.isolation === 'gpu'))
})

test('池：两个子抢同一张卡，后一条被跳过并说明原因', () => {
  const m = main()
  const [w1, w2] = subs('CUDA1', 'CUDA1')
  const r = pickSubAgentPool(m, [m, w1, w2])
  assert.deepEqual(r.accepted.map((x) => x.provider.id), ['w1'])
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].provider.id, 'w2')
  assert.match(r.skipped[0].reason, /重叠|顶掉/)
})

test('池：子和主落在同一张卡上 → 拒绝，原因点名是哪一边', () => {
  const m = main()
  const [w1] = subs('CUDA0')
  const r = pickSubAgentPool(m, [m, w1])
  assert.equal(r.accepted.length, 0)
  assert.match(r.skipped[0].reason, /两边都绑在 CUDA0/)
  assert.match(r.skipped[0].reason, /换到另一块卡/)
})

test('池：没绑卡一律按「分不开」处理，原因点名是哪一边', () => {
  const m = main()
  const bare = local('w1', undefined, { role: 'worker' })
  const r = pickSubAgentPool(m, [m, bare])
  assert.equal(r.accepted.length, 0)
  assert.match(r.skipped[0].reason, /子智能体.*没绑显卡/)
})

test('隔离：远端子不占显存；主在远端时本地子独占', () => {
  const m = main()
  const remoteSub = p('r1', 'gpt', 'https://api.example.com/v1', { role: 'worker' })
  assert.equal(subIsolation(m, remoteSub), 'remote')
  const remoteMain = p('m0', 'gpt', 'https://api.example.com/v1')
  assert.equal(subIsolation(remoteMain, local('w1', 'CUDA1', { role: 'worker' })), 'gpu')
  assert.equal(subIsolation(remoteMain, local('w1', 'CPU', { role: 'worker' })), 'cpu')
})

test('合并实例和单卡实例重叠也算冲突', () => {
  const m = local('m0', 'CUDA0,CUDA1')
  const [w1, w2] = subs('CUDA2', 'CUDA1')
  const r = pickSubAgentPool(m, [m, w1, w2])
  assert.deepEqual(r.accepted.map((x) => x.provider.id), ['w1'])
  assert.equal(subIsolation(m, w2), 'none')
})

test('保活：本地子 + 本地主归到同一池；远端主不算本地实例', () => {
  const m = main()
  const list = [m, ...subs('CUDA1', 'CUDA2')]
  assert.deepEqual(subAgentKeepAliveIds(list, m.id), ['w1', 'w2', 'm0'])
  const remote = p('m0', 'gpt', 'https://api.example.com/v1')
  assert.deepEqual(subAgentKeepAliveIds([remote, ...subs('CUDA0', 'CUDA1')], remote.id), [
    'w1',
    'w2'
  ])
})

test('保活：没标「子」的本地实例不参与，也不会被整池拖着不卸', () => {
  const m = main()
  const list = [m, local('w1', 'CUDA1')]
  assert.deepEqual(subAgentKeepAliveIds(list, m.id), ['m0'])
})

test('分派：按忙闲摊平，一批子任务不会全落在第一条', () => {
  const m = main()
  const [w1, w2] = subs('CUDA1', 'CUDA2')
  assert.equal(createSubAgentDispatcher([])(), null)
  const pick = createSubAgentDispatcher([
    { provider: w1, load: 0 },
    { provider: w2, load: 0 }
  ])
  const seq = [pick(), pick(), pick(), pick()].map((x) => x.provider.id)
  assert.deepEqual(seq, ['w1', 'w2', 'w1', 'w2'])
})

test('分派：忙的那条让位给闲的', () => {
  const m = main()
  const [w1, w2] = subs('CUDA1', 'CUDA2')
  const pick = createSubAgentDispatcher([
    { provider: w1, load: 5 },
    { provider: w2, load: 0 }
  ])
  assert.equal(pick().provider.id, 'w2')
})
