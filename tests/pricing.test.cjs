// 价格表与用量格式化的单测。只测纯函数，不碰网络与磁盘。
const assert = require('node:assert/strict')
const test = require('node:test')

const pricing = require('../dist/shared/pricing.js')

test('认识的模型能算出正向花费', () => {
  const cost = pricing.estimateCost('gpt-4o-mini', { prompt: 1_000_000, completion: 0 })
  assert.equal(cost, 0.15)
})

test('输出 token 按输出单价算', () => {
  const cost = pricing.estimateCost('gpt-4o-mini', { prompt: 0, completion: 1_000_000 })
  assert.equal(cost, 0.6)
})

test('缓存命中的输入按低价算，且不会超过总输入', () => {
  // 100 万输入里有 50 万命中缓存：0.5 * 0.15 + 0.5 * 0.015
  const cost = pricing.estimateCost('gpt-4o-mini', {
    prompt: 1_000_000,
    completion: 0,
    cached: 500_000
  })
  assert.equal(cost, 0.0825)
})

test('缓存数比输入还多时按输入封顶，不出现负花费', () => {
  const cost = pricing.estimateCost('gpt-4o-mini', { prompt: 1000, completion: 0, cached: 999999 })
  assert.ok(cost >= 0)
  assert.ok(cost < 0.001)
})

test('本地模型 / 自定义名字不算钱，返回 undefined 而不是编一个数', () => {
  assert.equal(pricing.estimateCost('qwen2.5-coder-7b-instruct-q4_k_m', { prompt: 1e6, completion: 1e6 }), undefined)
  assert.equal(pricing.estimateCost('my-local-relay-model', { prompt: 1e6, completion: 1e6 }), undefined)
  assert.equal(pricing.estimateCost('', { prompt: 100, completion: 100 }), undefined)
})

test('gpt-4o-mini 不会被 gpt-4o 的规则抢走', () => {
  const mini = pricing.unitPrice('gpt-4o-mini')
  const full = pricing.unitPrice('gpt-4o')
  assert.deepEqual(mini, { in: 0.15, out: 0.6 })
  assert.deepEqual(full, { in: 2.5, out: 10 })
})

test('token 数格式化：过千进 k，过百万进 m', () => {
  assert.equal(pricing.fmtTokens(0), '0')
  assert.equal(pricing.fmtTokens(999), '999')
  assert.equal(pricing.fmtTokens(1500), '1.50k')
  assert.equal(pricing.fmtTokens(20000), '20.0k')
  assert.equal(pricing.fmtTokens(2_000_000), '2.00m')
})

test('异常输入不抛错', () => {
  assert.equal(pricing.fmtTokens(NaN), '0')
  assert.equal(pricing.fmtTokens(-5), '0')
  assert.equal(pricing.unitPrice('   '), null)
})
