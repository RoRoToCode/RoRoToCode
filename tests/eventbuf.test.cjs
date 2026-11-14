/**
 * 正文合帧器的顺序单测。
 *
 * 这条逻辑改错的表现很隐蔽：字还是会出来，只是偶尔顺序乱、或者最后几个字不出现。
 * 肉眼看界面看不出来，所以顺序规则必须在这层钉死：
 * - 同一条消息的 delta 攒成一段，字数不变；
 * - 非 delta 事件之前必须先把它前面的字发出去（否则先收到「回答完了」）；
 * - 换了 messageId 不能拼成一段；
 * - 空增量不产生事件（assistant_start 之后可能一个空 chunk）。
 */
const test = require('node:test')
const assert = require('node:assert')
const { DeltaCoalescer } = require('../dist/main/eventbuf.js')

/** 收一个「事件流水」，顺便把 timer 控制在测试手上 */
function setup(flushMs = 5) {
  const got = []
  const c = new DeltaCoalescer((sessionId, event) => got.push({ sessionId, event }), flushMs)
  return { c, got }
}

const delta = (messageId, text) => ({ type: 'delta', messageId, text })

test('同一条消息的多个 delta 合成一次发送', () => {
  const { c, got } = setup()
  c.push('s1', delta('m1', '你'))
  c.push('s1', delta('m1', '好'))
  c.push('s1', delta('m1', '呀'))
  assert.deepStrictEqual(got, [], '还没到 flush 时间，不该发')
  c.flush('s1')
  assert.strictEqual(got.length, 1)
  assert.deepStrictEqual(got[0].event, { type: 'delta', messageId: 'm1', text: '你好呀' })
})

test('非 delta 事件先把前面的字发出去，再发自己', () => {
  const { c, got } = setup()
  c.push('s1', delta('m1', '前半段'))
  c.push('s1', { type: 'assistant_end', messageId: 'm1', content: '前半段', toolCalls: [] })
  assert.deepStrictEqual(
    got.map((x) => x.event.type),
    ['delta', 'assistant_end']
  )
  assert.strictEqual(got[0].event.text, '前半段')
})

test('换了消息先 flush 上一段，两段不会拼在一起', () => {
  const { c, got } = setup()
  c.push('s1', delta('m1', 'A'))
  c.push('s1', delta('m2', 'B'))
  c.push('s1', delta('m2', 'C'))
  c.flush('s1')
  assert.deepStrictEqual(
    got.map((x) => x.event),
    [
      { type: 'delta', messageId: 'm1', text: 'A' },
      { type: 'delta', messageId: 'm2', text: 'BC' }
    ]
  )
})

test('不同会话各攒各的，互不影响', () => {
  const { c, got } = setup()
  c.push('s1', delta('m1', 'one'))
  c.push('s2', delta('m2', 'two'))
  c.flush('s1')
  assert.strictEqual(got.length, 1)
  assert.strictEqual(got[0].sessionId, 's1')
  c.flush('s2')
  assert.strictEqual(got.length, 2)
  assert.strictEqual(got[1].sessionId, 's2')
})

test('空增量不产生事件', () => {
  const { c, got } = setup()
  c.push('s1', delta('m1', ''))
  c.flush('s1')
  assert.deepStrictEqual(got, [])
})

test('没有缓冲时 flush 是空操作', () => {
  const { c, got } = setup()
  c.flush('没这个会话')
  c.flushAll()
  assert.deepStrictEqual(got, [])
})

test('到时间自动发出去，不用等下一个事件', async () => {
  const { c, got } = setup(5)
  c.push('s1', delta('m1', '自动'))
  await new Promise((r) => setTimeout(r, 30))
  assert.strictEqual(got.length, 1)
  assert.strictEqual(got[0].event.text, '自动')
})

test('flushAll 把所有会话残留的字都发掉', () => {
  const { c, got } = setup()
  c.push('s1', delta('m1', 'a'))
  c.push('s2', delta('m2', 'b'))
  c.flushAll()
  assert.deepStrictEqual(got.map((x) => x.event.text).sort(), ['a', 'b'])
})
