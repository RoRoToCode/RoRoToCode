/**
 * 删除「一整轮对话」的边界单测。
 *
 * 这条逻辑最怕两件事：把下一轮的提问一起删掉，以及留下没配对的 tool 结果
 * （OpenAI / Anthropic 会直接 400）。所以每一条都顺带验 toolPairsIntact。
 */
const test = require('node:test')
const assert = require('node:assert')
const {
  turnRangeOf,
  toolPairsIntact,
  trimDanglingTail,
  titleAfterTurnDelete
} = require('../dist/shared/turns.js')

const msg = (id, role, extra = {}) => ({ id, role, content: id, createdAt: 0, ...extra })

/** 两轮完整历史：提问 → 工具调用 → 工具结果 → 结论 → 再提问 → 再工具调用 → 结果 → 结论 */
function history() {
  return [
    msg('u1', 'user'),
    msg('a1', 'assistant', { toolCalls: [{ id: 'c1', name: 'read_file', args: {} }] }),
    msg('t1', 'tool', { toolCallId: 'c1' }),
    msg('a2', 'assistant'),
    msg('u2', 'user'),
    msg('a3', 'assistant', { toolCalls: [{ id: 'c2', name: 'run_shell', args: {} }] }),
    msg('t2', 'tool', { toolCallId: 'c2' }),
    msg('a4', 'assistant')
  ]
}

const apply = (all, id) => {
  const range = turnRangeOf(all, id)
  assert.ok(range, '应该找到这一轮')
  return all.slice(0, range.start).concat(all.slice(range.end))
}

test('点提问：只删这一轮，下一轮完整保留', () => {
  const all = history()
  const range = turnRangeOf(all, 'u1')
  assert.deepStrictEqual(range, { start: 0, end: 4 })
  assert.deepStrictEqual(apply(all, 'u1').map((m) => m.id), ['u2', 'a3', 't2', 'a4'])
})

test('点中间的工具结果：往回找到提问，往后到下一个提问之前', () => {
  const all = history()
  const range = turnRangeOf(all, 't1')
  assert.deepStrictEqual(range, { start: 0, end: 4 })
  assert.deepStrictEqual(apply(all, 't1').map((m) => m.id), ['u2', 'a3', 't2', 'a4'])
})

test('点第二轮里的任意一条：只删第二轮', () => {
  const all = history()
  for (const id of ['u2', 'a3', 't2', 'a4']) {
    assert.deepStrictEqual(turnRangeOf(all, id), { start: 4, end: 8 })
    assert.deepStrictEqual(apply(all, id).map((m) => m.id), ['u1', 'a1', 't1', 'a2'])
  }
})

test('删掉任意一轮后，剩下的 tool_calls 与工具结果仍然配对', () => {
  const all = history()
  assert.strictEqual(toolPairsIntact(all), true)
  for (const id of ['u1', 'a1', 't1', 'a2', 'u2', 'a3', 't2', 'a4']) {
    assert.strictEqual(toolPairsIntact(apply(all, id)), true, `删 ${id} 后配对断裂`)
  }
})

test('最后一轮没有后继提问时删到末尾', () => {
  const all = history().slice(0, 4)
  assert.deepStrictEqual(turnRangeOf(all, 't1'), { start: 0, end: 4 })
  assert.deepStrictEqual(apply(all, 't1'), [])
})

test('会话开头没有 user（历史被删过）也能定位', () => {
  const all = [
    msg('t0', 'tool', { toolCallId: 'c0' }),
    msg('a0', 'assistant'),
    msg('u1', 'user'),
    msg('a1', 'assistant')
  ]
  assert.deepStrictEqual(turnRangeOf(all, 'a0'), { start: 0, end: 2 })
  assert.deepStrictEqual(apply(all, 'a0').map((m) => m.id), ['u1', 'a1'])
})

test('不存在的消息返回 null', () => {
  assert.strictEqual(turnRangeOf(history(), 'nope'), null)
  assert.strictEqual(turnRangeOf([], 'u1'), null)
})

test('删掉开头那一轮后，自动生成的标题跟着换成下一条提问', () => {
  const all = [msg('第一个问题', 'user'), msg('a1', 'assistant'), msg('第二个问题', 'user')]
  const range = turnRangeOf(all, '第一个问题')
  const removed = all.slice(range.start, range.end)
  const rest = all.slice(0, range.start).concat(all.slice(range.end))
  assert.strictEqual(titleAfterTurnDelete('第一个问题', removed, rest), '第二个问题')
  // 用户手动改过的标题不动
  assert.strictEqual(titleAfterTurnDelete('我改过的名字', removed, rest), '我改过的名字')
  // 删的不是开头第一轮时也不动
  assert.strictEqual(titleAfterTurnDelete('第一个问题', [msg('第二个问题', 'user')], all), '第一个问题')
})

test('toolPairsIntact 能抓到孤儿工具结果 / 没收到结果的调用', () => {
  assert.strictEqual(
    toolPairsIntact([msg('u1', 'user'), msg('t1', 'tool', { toolCallId: 'c1' })]),
    false
  )
  assert.strictEqual(
    toolPairsIntact([
      msg('a1', 'assistant', { toolCalls: [{ id: 'c1', name: 'x', args: {} }] })
    ]),
    false
  )
})

test('分叉剪尾：切在「喊了工具、结果还没回来」处，把那条调用一起剪掉', () => {
  const all = history()
  // 切到 a3 为止：a3 喊了 c2，但 t2 还没回来
  const cut = trimDanglingTail(all.slice(0, 6))
  assert.deepStrictEqual(cut.map((m) => m.id), ['u1', 'a1', 't1', 'a2', 'u2'])
  assert.ok(toolPairsIntact(cut))
})

test('分叉剪尾：配对完整的历史一个字不动', () => {
  const all = history()
  assert.deepStrictEqual(trimDanglingTail(all).map((m) => m.id), all.map((m) => m.id))
})

test('分叉剪尾：只剩孤立的工具结果时，整段剪空而不是留个孤儿', () => {
  const cut = trimDanglingTail([msg('t9', 'tool', { toolCallId: 'c9' })])
  assert.deepStrictEqual(cut, [])
})
