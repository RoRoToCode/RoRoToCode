// 用量闸门的单测：纯逻辑，不碰磁盘、网络和 electron。
const assert = require('node:assert/strict')
const test = require('node:test')

const quota = require('../dist/shared/quota.js')

test('不填上限就永远放行：默认行为不能因为加了闸门而改变', () => {
  assert.equal(quota.checkQuota({ perRun: 0, perDay: 0 }, { run: 999999, day: 999999 }).level, 'ok')
})

test('单次运行撞上限就停', () => {
  const v = quota.checkQuota({ perRun: 10000, perDay: 0 }, { run: 10000, day: 10000 })
  assert.equal(v.level, 'stop')
  assert.equal(v.scope, 'run')
  assert.equal(v.limit, 10000)
})

test('差一个 token 也放行：等于才算撞上，不能提前一步卡死', () => {
  assert.equal(quota.checkQuota({ perRun: 10000, perDay: 0 }, { run: 9999, day: 9999 }).level, 'warn')
})

test('单次优先于每日：撞了单次不必让用户去算今天还剩多少', () => {
  const v = quota.checkQuota({ perRun: 1000, perDay: 500 }, { run: 1200, day: 3000 })
  assert.equal(v.level, 'stop')
  assert.equal(v.scope, 'run')
})

test('只撞每日上限时说的是每日', () => {
  const v = quota.checkQuota({ perRun: 100000, perDay: 5000 }, { run: 100, day: 5000 })
  assert.equal(v.level, 'stop')
  assert.equal(v.scope, 'day')
})

test('到 80% 先提醒一次，别等真撞墙上才说话', () => {
  const v = quota.checkQuota({ perRun: 10000, perDay: 0 }, { run: 8000, day: 0 })
  assert.equal(v.level, 'warn')
  assert.equal(v.scope, 'run')
  assert.equal(quota.checkQuota({ perRun: 10000, perDay: 0 }, { run: 7999, day: 0 }).level, 'ok')
})

test('上限归一化：负数 / NaN / 空都当不限，小数四舍五入', () => {
  assert.equal(quota.parseLimit(-5), 0)
  assert.equal(quota.parseLimit('abc'), 0)
  assert.equal(quota.parseLimit(undefined), 0)
  assert.equal(quota.parseLimit('1200'), 1200)
  assert.equal(quota.parseLimit(999.6), 1000)
})

test('文案说清是哪条线和具体数字', () => {
  const text = quota.quotaText({ level: 'stop', scope: 'run', used: 12000, limit: 10000 })
  assert.match(text, /本次运行/)
  assert.match(text, /12\.0k/)
  assert.match(text, /10\.0k/)
})

test('停止说明要告诉用户怎么接着干，不能只说「超了」', () => {
  const hit = { level: 'stop', scope: 'day', used: 50000, limit: 50000 }
  assert.match(quota.quotaStopNote(hit), /继续/)
  assert.match(quota.quotaAutoStopNote(hit), /自动跑的/)
})
