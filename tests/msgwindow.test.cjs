const test = require('node:test')
const assert = require('node:assert')
const { MSG_WINDOW, MSG_WINDOW_STEP, windowRows } = require('../dist/shared/msgwindow.js')

const rows = (n) => Array.from({ length: n }, (_, i) => i)

test('行数没超窗口：全部渲染，不显示「更早」入口', () => {
  const r = windowRows(rows(10), 0)
  assert.equal(r.hidden, 0)
  assert.equal(r.shown.length, 10)
  assert.deepEqual(r.shown, rows(10))
})

test('刚好等于窗口：不截断', () => {
  const r = windowRows(rows(MSG_WINDOW), 0)
  assert.equal(r.hidden, 0)
  assert.equal(r.shown.length, MSG_WINDOW)
})

test('超出窗口：只留尾部，头部行数记为 hidden', () => {
  const total = MSG_WINDOW + 25
  const r = windowRows(rows(total), 0)
  assert.equal(r.hidden, 25)
  assert.equal(r.shown.length, MSG_WINDOW)
  // 留下的是最后一批，不是最前面一批
  assert.equal(r.shown[0], 25)
  assert.equal(r.shown[r.shown.length - 1], total - 1)
})

test('点一次「显示更早」多展开一批', () => {
  const total = MSG_WINDOW + 25
  const r = windowRows(rows(total), MSG_WINDOW_STEP)
  assert.equal(r.hidden, 0)
  assert.equal(r.shown.length, total)
})

test('空会话不会算出负数窗口', () => {
  const r = windowRows([], 0)
  assert.equal(r.hidden, 0)
  assert.deepEqual(r.shown, [])
})

test('extra 传负数或小数也不会崩', () => {
  const total = MSG_WINDOW + 5
  assert.equal(windowRows(rows(total), -100).hidden, 5)
  assert.equal(windowRows(rows(total), 2.7).hidden, 3)
})
