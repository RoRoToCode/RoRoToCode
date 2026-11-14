const test = require('node:test')
const assert = require('node:assert/strict')
const { createIdleWatcher, shouldUnload, MIN_ALIVE_MS } = require('../dist/main/idleunload.js')

const MIN = 60_000

/**
 * 全局假时钟。watcher 的 now 从 deps 取，所以 mkDeps 默认就绑到这里，
 * 每个用例开头 resetClock() 一下，互不影响。
 */
let clockT = 1_000_000
function resetClock(v = 1_000_000) {
  clockT = v
}
const clock = {
  now: () => clockT,
  advance: (ms) => {
    clockT += ms
  },
  set: (v) => {
    clockT = v
  }
}

function mkDeps(over = {}) {
  const stopped = []
  const deps = {
    list: () => [{ key: 'llamacpp', port: 8080, model: 'm.gguf', startedAt: 0, partial: false }],
    busy: async () => false,
    pending: () => 0,
    stop: async (key) => {
      stopped.push(key)
      return true
    },
    ttlMs: () => 10 * MIN,
    now: clock.now,
    ...over
  }
  return { deps, stopped }
}

test('shouldUnload：五个条件缺一不可', () => {
  const base = { now: 100 * MIN, startedAt: 0, lastBusyAt: 0, ttlMs: 10 * MIN, busy: false, pending: 0 }
  assert.equal(shouldUnload(base), true)
  // 关闭
  assert.equal(shouldUnload({ ...base, ttlMs: 0 }), false)
  // 服务端说在忙
  assert.equal(shouldUnload({ ...base, busy: true }), false)
  // 探不到（null）不能当成空闲
  assert.equal(shouldUnload({ ...base, busy: null }), false)
  // 闸门里还有请求
  assert.equal(shouldUnload({ ...base, pending: 1 }), false)
  // 刚启动不到保护期
  assert.equal(shouldUnload({ ...base, startedAt: 100 * MIN - 1000 }), false)
  // 还没到阈值
  assert.equal(shouldUnload({ ...base, now: 5 * MIN }), false)
})

test('tick：空闲到点就卸载，并记下被卸载的是哪个模型', async () => {
  resetClock()
  const c = clock
  const { deps, stopped } = mkDeps()
  const w = createIdleWatcher(deps, { intervalMs: 5000 })
  // 第一次 tick 只建立基线，不卸载
  assert.deepEqual(await w.tick(), [])
  c.advance(10 * MIN + 1)
  const gone = await w.tick()
  assert.deepEqual(gone, ['llamacpp'])
  assert.deepEqual(stopped, ['llamacpp'])
  const rec = w.unloaded()
  assert.equal(rec.length, 1)
  assert.equal(rec[0].model, 'm.gguf')
  assert.equal(rec[0].idleMin, 10)
})

test('tick：正在生成时一直重置计时，不会在长任务中途被卸掉', async () => {
  resetClock()
  const c = clock
  const { deps, stopped } = mkDeps({ busy: async () => true })
  const w = createIdleWatcher(deps, { intervalMs: 5000 })
  await w.tick()
  for (let i = 0; i < 30; i++) {
    c.advance(5 * MIN)
    assert.deepEqual(await w.tick(), [])
  }
  assert.deepEqual(stopped, [])
})

test('tick：探测不到 /slots 时不卸载（宁可多占，不误杀）', async () => {
  resetClock()
  const c = clock
  const { deps, stopped } = mkDeps({ busy: async () => null })
  const w = createIdleWatcher(deps, { intervalMs: 5000 })
  await w.tick()
  c.advance(60 * MIN)
  assert.deepEqual(await w.tick(), [])
  assert.deepEqual(stopped, [])
})

test('tick：闸门里有排队请求时算忙', async () => {
  resetClock()
  const c = clock
  const { deps, stopped } = mkDeps({ pending: () => 2 })
  const w = createIdleWatcher(deps, { intervalMs: 5000 })
  await w.tick()
  c.advance(60 * MIN)
  assert.deepEqual(await w.tick(), [])
  assert.deepEqual(stopped, [])
})

test('tick：关闭（ttl=0）时什么都不做', async () => {
  resetClock()
  const c = clock
  const { deps, stopped } = mkDeps({ ttlMs: () => 0 })
  const w = createIdleWatcher(deps, { intervalMs: 5000 })
  await w.tick()
  c.advance(1000 * MIN)
  assert.deepEqual(await w.tick(), [])
  assert.deepEqual(stopped, [])
})

test('tick：加载完不到一分钟不卸载', async () => {
  resetClock()
  const c = clock
  const started = 1_000_000
  const { deps, stopped } = mkDeps({
    list: () => [{ key: 'llamacpp', port: 8080, model: 'm.gguf', startedAt: started, partial: false }],
    // 阈值调到 1 分钟，刚好卡在保护期上
    ttlMs: () => MIN
  })
  const w = createIdleWatcher(deps, { intervalMs: 5000 })
  await w.tick()
  // 距启动还差 1 毫秒到保护期：即便 ttl 早就到了也不卸载
  c.advance(MIN_ALIVE_MS - 1)
  assert.deepEqual(await w.tick(), [])
  // 过了保护期，且空闲已满 ttl -> 卸载
  c.advance(1)
  assert.deepEqual(await w.tick(), ['llamacpp'])
  assert.deepEqual(stopped, ['llamacpp'])
})

test('tick：停不掉时下一轮还会再试，但不会每轮都撞', async () => {
  resetClock()
  const c = clock
  let attempts = 0
  const { deps } = mkDeps({
    stop: async () => {
      attempts++
      return false
    }
  })
  const w = createIdleWatcher(deps, { intervalMs: 5000 })
  await w.tick()
  c.advance(11 * MIN)
  assert.deepEqual(await w.tick(), [])
  // 失败后重置计时：同一秒内再 tick 不会立刻重试
  assert.equal(attempts, 1)
  assert.deepEqual(await w.tick(), [])
  assert.equal(attempts, 1)
  // 再等一个完整阈值，才会重试第二次
  c.advance(11 * MIN)
  assert.deepEqual(await w.tick(), [])
  assert.equal(attempts, 2)
})

test('tick：实例消失后计时记录被清掉，不会无限增长', async () => {
  resetClock()
  const c = clock
  let list = [{ key: 'a', port: 1, model: 'a.gguf', startedAt: 0, partial: false }]
  const { deps } = mkDeps({ list: () => list })
  const w = createIdleWatcher(deps, { intervalMs: 5000 })
  await w.tick()
  list = []
  await w.tick()
  // 再放回来：应当按「第一次见到」处理，基线重置
  list = [{ key: 'a', port: 1, model: 'a.gguf', startedAt: 0, partial: false }]
  await w.tick()
  c.advance(11 * MIN)
  assert.deepEqual(await w.tick(), ['a'])
})

test('forget：手动启动后清掉「已卸载」记录', async () => {
  resetClock()
  const c = clock
  const { deps } = mkDeps()
  const w = createIdleWatcher(deps, { intervalMs: 5000 })
  await w.tick()
  c.advance(11 * MIN)
  await w.tick()
  assert.equal(w.unloaded().length, 1)
  w.forget('llamacpp')
  assert.equal(w.unloaded().length, 0)
})

test('start/stop：定时器幂等且能停', async () => {
  const { deps } = mkDeps()
  const w = createIdleWatcher(deps, { intervalMs: 5000 })
  w.start()
  w.start()
  w.stop()
  w.stop()
  assert.ok(true)
})
