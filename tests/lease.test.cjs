const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const {
  acquireFileLeases,
  leaseHolder,
  resetFileLeases
} = require('../dist/main/lease.js')

/**
 * 并行子任务的写文件租约。核心契约：
 * 1. 同一路径同时只归一个 owner，后来者排队（不是失败）；
 * 2. 不同路径互不阻塞 —— 这就是并行的意义，锁不能退化成全局串行；
 * 3. 释放是幂等的，重入不会把外层那次的锁提前放掉；
 * 4. 拿不到要说清楚（超时 / 取消），并且不留下半组锁把后面的任务全卡住；
 * 5. 两个任务用相反顺序要同一组文件时不能死锁（内部按排序后的顺序取）。
 */

const abs = (name) => path.resolve('/tmp/roroto-lease-test', name)

/** 只推进一个事件循环：用来断言「这个 promise 现在还挂着」 */
const tick = () => new Promise((r) => setTimeout(r, 0))

test.beforeEach(() => resetFileLeases())

test('租约：同一路径后来者排队，释放后自动转交', async () => {
  const file = abs('a.ts')
  const releaseA = await acquireFileLeases([file], { owner: 'A' })
  assert.equal(leaseHolder(file), 'A')

  let got = false
  const pending = acquireFileLeases([file], { owner: 'B' }).then((r) => {
    got = true
    return r
  })

  await tick()
  assert.equal(got, false, 'A 还占着，B 必须等着，不能直接拿到')

  releaseA()
  const releaseB = await pending
  assert.equal(got, true)
  assert.equal(leaseHolder(file), 'B')

  releaseB()
  assert.equal(leaseHolder(file), undefined)
})

test('租约：不同文件互不阻塞（并行没有被退化成串行）', async () => {
  const a = abs('one.ts')
  const b = abs('two.ts')
  const releaseA = await acquireFileLeases([a], { owner: 'A' })
  // 不等 tick 就应该拿到：不同路径
  const releaseB = await acquireFileLeases([b], { owner: 'B' })
  assert.equal(leaseHolder(a), 'A')
  assert.equal(leaseHolder(b), 'B')
  releaseA()
  releaseB()
})

test('租约：释放幂等，重复调用不会误放别人的锁', async () => {
  const file = abs('idem.ts')
  const releaseA = await acquireFileLeases([file], { owner: 'A' })
  releaseA()
  // B 拿到之后，A 再调一次自己的释放函数，不能把 B 的锁放掉
  const releaseB = await acquireFileLeases([file], { owner: 'B' })
  releaseA()
  assert.equal(leaseHolder(file), 'B')
  releaseB()
  assert.equal(leaseHolder(file), undefined)
})

test('租约：同一 owner 重入，内层释放不影响外层', async () => {
  const file = abs('reentrant.ts')
  const outer = await acquireFileLeases([file], { owner: 'A' })
  const inner = await acquireFileLeases([file], { owner: 'A' })
  inner()
  assert.equal(leaseHolder(file), 'A', '内层放掉不该把外层的锁也放掉')
  outer()
  assert.equal(leaseHolder(file), undefined)
})

test('租约：等超时要明确报错，且不留下半组锁', async () => {
  const a = abs('held.ts')
  const b = abs('free.ts')
  const holdByOther = await acquireFileLeases([a], { owner: 'other' })

  await assert.rejects(
    // 排序后先取 free.ts 再取 held.ts：报错时要把已经拿到的 free.ts 回滚掉
    acquireFileLeases([a, b], { owner: 'A', waitMs: 30 }),
    /正在修改 held\.ts|正在修改/
  )
  assert.equal(leaseHolder(b), undefined, '失败后已拿到的那把必须回滚')

  holdByOther()
})

test('租约：被取消时立刻拒绝，不用等到超时', async () => {
  const file = abs('abort.ts')
  const hold = await acquireFileLeases([file], { owner: 'other' })
  const ctrl = new AbortController()
  const pending = acquireFileLeases([file], { owner: 'A', signal: ctrl.signal, waitMs: 60_000 })
  setTimeout(() => ctrl.abort(), 5)
  await assert.rejects(pending, /已取消/)
  hold()
})

test('租约：反序要同一组文件不会死锁', async () => {
  const a = abs('x.ts')
  const b = abs('y.ts')
  const first = await acquireFileLeases([a, b], { owner: 'A' })
  // B 用相反顺序要同一组：内部排序后顺序一致，只会等 A 放，不会互相等
  const pending = acquireFileLeases([b, a], { owner: 'B', waitMs: 60_000 })
  await tick()
  first()
  const releaseB = await pending
  assert.equal(leaseHolder(a), 'B')
  assert.equal(leaseHolder(b), 'B')
  releaseB()
})
