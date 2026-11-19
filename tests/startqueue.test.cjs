const test = require('node:test')
const assert = require('node:assert/strict')
const { createSerialQueue } = require('../dist/main/startqueue.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/*
 * 这些用例守的是「本地模型不会同时起两个」的底层保证：
 * 启动路径里全是 await，只要两个任务能并行跑，它们就会各自读到
 * 「还没有实例」然后各 spawn 一个进程，抢同一个端口。
 */

test('串行队列：同一队列里的任务不会交错', async () => {
  const enqueue = createSerialQueue()
  const log = []
  // 故意让先提交的那个最慢：若实现是并行，顺序会变成 start:a start:b end:b end:a
  const job = (name, ms) => async () => {
    log.push(`start:${name}`)
    await sleep(ms)
    log.push(`end:${name}`)
    return name
  }
  const got = await Promise.all([enqueue(job('a', 30)), enqueue(job('b', 1)), enqueue(job('c', 1))])
  assert.deepEqual(log, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
  assert.deepEqual(got, ['a', 'b', 'c'])
})

test('串行队列：前一个失败不会卡住队列，异常原样给调用方', async () => {
  const enqueue = createSerialQueue()
  const order = []
  const boom = enqueue(async () => {
    order.push('boom')
    throw new Error('启动失败')
  })
  const after = enqueue(async () => {
    order.push('after')
    return 42
  })
  await assert.rejects(boom, /启动失败/)
  assert.equal(await after, 42)
  assert.deepEqual(order, ['boom', 'after'])
})

test('串行队列：不同队列互不阻塞', async () => {
  const q1 = createSerialQueue()
  const q2 = createSerialQueue()
  const log = []
  await Promise.all([
    q1(async () => {
      log.push('slow')
      await sleep(25)
      log.push('slow-end')
    }),
    q2(async () => {
      log.push('fast')
    })
  ])
  assert.deepEqual(log, ['slow', 'fast', 'slow-end'])
})
