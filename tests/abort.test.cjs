// 中断信号合并的单测：纯逻辑，不碰磁盘、网络和 electron。
const assert = require('node:assert/strict')
const test = require('node:test')

const { combineSignals } = require('../dist/shared/abort.js')

test('两个都没断，合并出来的也没断', () => {
  const a = new AbortController()
  const b = new AbortController()
  const out = combineSignals(a.signal, b.signal)
  assert.equal(out.signal.aborted, false)
})

test('第一个断 = 合并断（点停止走这条）', () => {
  const run = new AbortController()
  const step = new AbortController()
  const out = combineSignals(run.signal, step.signal)
  run.abort(new Error('已取消'))
  assert.equal(out.signal.aborted, true)
})

test('第二个断 = 合并断（插话走这条，整轮还在跑）', () => {
  const run = new AbortController()
  const step = new AbortController()
  const out = combineSignals(run.signal, step.signal)
  step.abort(new Error('用户插话'))
  assert.equal(out.signal.aborted, true)
  // 关键：断的只是这一步，整轮没有被取消
  assert.equal(run.signal.aborted, false)
})

test('传进来的信号已经断了，合并出来立刻是断的', () => {
  const run = new AbortController()
  run.abort()
  const step = new AbortController()
  const out = combineSignals(run.signal, step.signal)
  assert.equal(out.signal.aborted, true)
})

test('原因从真正先断的那个信号来，上层据此区分「取消」和「插话」', () => {
  const run = new AbortController()
  const step = new AbortController()
  const out = combineSignals(run.signal, step.signal)
  step.abort(new Error('用户插话'))
  assert.equal(out.signal.reason.message, '用户插话')
})

test('先断 run 再断 step，不会重复触发也不会报错', () => {
  const run = new AbortController()
  const step = new AbortController()
  const out = combineSignals(run.signal, step.signal)
  let fired = 0
  out.signal.addEventListener('abort', () => {
    fired += 1
  })
  run.abort()
  step.abort()
  assert.equal(fired, 1)
  assert.equal(out.signal.aborted, true)
})
