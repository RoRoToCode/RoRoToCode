// 全局并发闸门的单测：纯逻辑，不碰网络、磁盘和 electron。
const assert = require('node:assert/strict')
const test = require('node:test')

const { RunQueue, MAX_CONCURRENT_RUNS, priorityOf } = require('../dist/shared/runqueue.js')

/** 收集通知：每条记 { sessionId, position, active } */
function make(max) {
  const notes = []
  const q = new RunQueue(max, (n) => notes.push(n))
  return { q, notes }
}

/** 让出几个微任务，等 acquire 的 Promise 落定 */
const tick = () => new Promise((r) => setImmediate(r))

test('上限是 2：前两个直接放行，第三个开始排队', async () => {
  assert.equal(MAX_CONCURRENT_RUNS, 2)
  const { q } = make(2)
  await q.acquire('a')
  await q.acquire('b')
  assert.equal(q.activeCount, 2)
  assert.equal(q.waitingCount, 0)

  const third = q.acquire('c')
  await tick()
  assert.equal(q.activeCount, 2)
  assert.equal(q.waitingCount, 1)
  assert.equal(q.position('c'), 1)

  q.release('a')
  await third
  assert.equal(q.activeCount, 2)
  assert.equal(q.position('c'), 0)
  assert.equal(q.holding('c'), true)
})

test('排队位置按先来后到，前一个放行后整体前移', async () => {
  const { q, notes } = make(1)
  await q.acquire('a')
  const b = q.acquire('b')
  const c = q.acquire('c')
  await tick()
  assert.equal(q.position('b'), 1)
  assert.equal(q.position('c'), 2)

  q.release('a')
  await b
  // b 拿到槽位，c 变成第 1 位
  assert.equal(q.position('c'), 1)
  assert.equal(q.holding('b'), true)

  // 最后一次通知里 c 应该被推到 1
  const cNotes = notes.filter((n) => n.sessionId === 'c')
  assert.equal(cNotes[cNotes.length - 1].position, 1)

  q.release('b')
  await c
  assert.equal(q.activeCount, 1)
  assert.equal(q.waitingCount, 0)
})

test('排队时通知里带 active 与 limit，界面靠它解释「为什么在等」', async () => {
  const { q, notes } = make(1)
  await q.acquire('a')
  const b = q.acquire('b')
  await tick()
  const n = notes.find((x) => x.sessionId === 'b')
  assert.equal(n.position, 1)
  assert.equal(n.active, 1)
  assert.equal(n.limit, 1)
  q.release('a')
  await b
})

test('排队中取消：从队列摘掉，后面的人前移', async () => {
  const { q } = make(1)
  await q.acquire('a')
  const ctrl = new AbortController()
  const b = q.acquire('b', ctrl.signal)
  const c = q.acquire('c')
  await tick()
  assert.equal(q.position('b'), 1)
  assert.equal(q.position('c'), 2)

  ctrl.abort()
  await assert.rejects(b, /已取消/)
  assert.equal(q.waitingCount, 1)
  assert.equal(q.position('b'), 0)
  assert.equal(q.position('c'), 1)

  q.release('a')
  await c
  assert.equal(q.holding('c'), true)
})

test('已经中止的信号不会再排队，直接拒绝', async () => {
  const { q } = make(2)
  const ctrl = new AbortController()
  ctrl.abort()
  await assert.rejects(q.acquire('a', ctrl.signal), /已取消/)
  assert.equal(q.activeCount, 0)
})

test('重复释放不会把计数打负，也不会误放行别人', async () => {
  const { q } = make(1)
  await q.acquire('a')
  const b = q.acquire('b')
  await tick()

  q.release('a')
  await b
  assert.equal(q.activeCount, 1)

  // a 早就交回去了，这次不该再减一次去放行别人
  q.release('a')
  assert.equal(q.activeCount, 1)
  assert.equal(q.holding('b'), true)
  q.release('b')
  assert.equal(q.activeCount, 0)
  assert.equal(q.waitingCount, 0)
})

test('同一个会话重复 acquire 只占一个槽位', async () => {
  const { q } = make(2)
  await q.acquire('a')
  await q.acquire('a')
  assert.equal(q.activeCount, 1)
  q.release('a')
  assert.equal(q.activeCount, 0)
})

test('全部跑完后再提交，能立刻拿到槽位（没有残留占位）', async () => {
  const { q } = make(1)
  await q.acquire('a')
  q.release('a')
  assert.equal(q.activeCount, 0)
  assert.equal(q.waitingCount, 0)
  await q.acquire('b')
  assert.equal(q.activeCount, 1)
  assert.equal(q.holding('b'), true)
})

test('原因翻译成优先级：定时任务让两档，交接让一档', () => {
  assert.equal(priorityOf('routine'), 'routine')
  assert.equal(priorityOf('handoff'), 'handoff')
  assert.equal(priorityOf('chat'), 'manual')
  assert.equal(priorityOf(undefined), 'manual')
  // 认不出的原因不能悄悄降级：让用户的活排到后台任务后面是最难受的 bug
  assert.equal(priorityOf('whatever'), 'manual')
})

test('用户的话插到定时任务前面，哪怕定时任务先排队', async () => {
  const { q } = make(1)
  await q.acquire('busy')
  const r = q.acquire('cron', undefined, 'routine')
  await tick()
  assert.equal(q.position('cron'), 1)

  const m = q.acquire('mine', undefined, 'manual')
  await tick()
  assert.equal(q.position('mine'), 1, '用户那条应该排第一')
  assert.equal(q.position('cron'), 2, '定时任务被推到后面')

  q.release('busy')
  await m
  assert.equal(q.holding('mine'), true)
  assert.equal(q.holding('cron'), false, '先被放行的是用户那条')
  assert.equal(q.position('cron'), 1)

  q.release('mine')
  await r
  assert.equal(q.holding('cron'), true)
})

test('优先级：手动 > 交接 > 定时，同档仍按先来后到', async () => {
  const { q } = make(1)
  await q.acquire('busy')
  const cron1 = q.acquire('cron1', undefined, 'routine')
  const hand = q.acquire('hand', undefined, 'handoff')
  const cron2 = q.acquire('cron2', undefined, 'routine')
  const mine = q.acquire('mine', undefined, 'manual')
  await tick()

  assert.deepEqual(
    ['mine', 'hand', 'cron1', 'cron2'].map((id) => q.position(id)),
    [1, 2, 3, 4]
  )

  // 逐个放行，顺序必须严格按优先级；同档的 cron1 先于 cron2
  const order = []
  q.release('busy')
  await mine
  order.push('mine')
  q.release('mine')
  await hand
  order.push('hand')
  q.release('hand')
  await cron1
  order.push('cron1')
  q.release('cron1')
  await cron2
  order.push('cron2')
  assert.deepEqual(order, ['mine', 'hand', 'cron1', 'cron2'])
})

test('排队通知带优先级，界面能说清是谁在让路', async () => {
  const { q, notes } = make(1)
  await q.acquire('busy')
  const r = q.acquire('cron', undefined, 'routine')
  await tick()
  const n = notes.filter((x) => x.sessionId === 'cron').pop()
  assert.equal(n.priority, 'routine')
  assert.equal(n.position, 1)
  q.release('busy')
  await r
})

test('高优先级插队后取消，队列恢复原样（不留空洞）', async () => {
  const { q } = make(1)
  await q.acquire('busy')
  const cron = q.acquire('cron', undefined, 'routine')
  const ctrl = new AbortController()
  const mine = q.acquire('mine', ctrl.signal, 'manual')
  await tick()
  assert.equal(q.position('mine'), 1)
  assert.equal(q.position('cron'), 2)

  ctrl.abort()
  await assert.rejects(mine, /已取消/)
  assert.equal(q.waitingCount, 1)
  assert.equal(q.position('cron'), 1, '插队者走了，原来的人应回到第一位')
  q.release('busy')
  await cron
  assert.equal(q.holding('cron'), true)
})
