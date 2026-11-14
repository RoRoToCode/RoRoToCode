const test = require('node:test')
const assert = require('node:assert/strict')
const { runProbeChain, probeBudget } = require('../dist/main/ctxprobe.js')

const okVerify = { ok: true, nCtx: null, slots: 1, tokPerSec: 20, failure: null, message: 'ok' }
const vramFail = { ok: false, nCtx: null, slots: 0, tokPerSec: null, failure: 'vram', message: 'failed to allocate 2048 MiB' }
const otherFail = { ok: false, nCtx: null, slots: 0, tokPerSec: null, failure: 'other', message: 'unknown model architecture' }

/** verify 按顺序返回；用完后一直重复最后一个 */
function seq(list) {
  let i = 0
  return async () => list[Math.min(i++, list.length - 1)]
}

function mkPlan(over = {}) {
  return {
    providerId: 'llamacpp',
    nativeCtx: 262144,
    maxCtx: 131072,
    minCtx: 4096,
    // 每 1K tokens 24 MiB：和 ctxtune 的用例同一口径
    kvMiBPerK: 24,
    limitMiB: 7700,
    reserveMiB: 320,
    downBudget: 2,
    upBudget: 1,
    ...over
  }
}

function mkDeps(over = {}) {
  const calls = []
  const deps = {
    firstPort: 8080,
    firstCtx: 32768,
    restart: async (ctx) => {
      calls.push(['restart', ctx])
      return { ok: true, port: 9000 + (ctx % 1000), message: 'started' }
    },
    verify: async () => okVerify,
    measure: async () => 6000,
    quiet: async () => {},
    stop: async () => {
      calls.push(['stop'])
    },
    note: (msg) => calls.push(['note', msg]),
    cancelled: () => false,
    save: async (probe, ceiling) => {
      calls.push(['save', probe, ceiling])
    },
    ...over
  }
  return { deps, calls }
}

test('首档可用 + 外推更高 → 升一档并确认，只重启一次', async () => {
  const { deps, calls } = mkDeps({ verify: seq([okVerify, okVerify]) })
  const out = await runProbeChain(mkPlan(), deps)
  assert.equal(out.ok, true)
  // 32K 实测 6000 MiB，按 24 MiB/K 算 64K 约 6672 + 320 余量还在 7700 以内
  assert.equal(out.ctx, 65536)
  assert.equal(out.attempts, 1)
  const restarts = calls.filter((c) => c[0] === 'restart')
  assert.equal(restarts.length, 1)
  assert.equal(restarts[0][1], 65536)
  assert.ok(calls.some((c) => c[0] === 'save' && c[1] && c[1].ctx === 65536))
})

test('首档显存不够 → 降一档成功，不误升回去', async () => {
  const { deps, calls } = mkDeps({
    firstCtx: 65536,
    verify: seq([vramFail, okVerify]),
    // 实测占用很高：外推不出更大的档，不该再升
    measure: async () => 9000
  })
  const out = await runProbeChain(mkPlan(), deps)
  assert.equal(out.ok, true)
  assert.equal(out.ctx, 32768)
  assert.equal(out.attempts, 1)
  const restarts = calls.filter((c) => c[0] === 'restart')
  assert.equal(restarts.length, 1)
  assert.equal(restarts[0][1], 32768)
})

test('不是显存问题（模型文件坏了）→ 一次都不重试，直接报真实原因', async () => {
  const { deps, calls } = mkDeps({ verify: async () => otherFail })
  const out = await runProbeChain(mkPlan(), deps)
  assert.equal(out.ok, false)
  assert.equal(out.attempts, 0)
  assert.equal(calls.filter((c) => c[0] === 'restart').length, 0)
  assert.ok(out.message.includes('unknown model architecture'))
  // 失败要落 ceiling，但不能写 ctxProbe（没量过占用）
  const saved = calls.find((c) => c[0] === 'save')
  assert.equal(saved[1], null)
  assert.ok(calls.some((c) => c[0] === 'stop'))
})

test('用户中途点了别的档位 → 立刻收手，不做任何重启', async () => {
  const { deps, calls } = mkDeps({ cancelled: () => true })
  const out = await runProbeChain(mkPlan(), deps)
  assert.equal(out.cancelled, true)
  assert.equal(calls.filter((c) => c[0] === 'restart').length, 0)
})

test('降档预算用尽仍起不来 → 判失败，不能当成成功落盘', async () => {
  const { deps, calls } = mkDeps({
    firstCtx: 65536,
    verify: async () => vramFail
  })
  const out = await runProbeChain(mkPlan({ downBudget: 2 }), deps)
  assert.equal(out.ok, false)
  // 65536 → 32768 → 16384，两次降档后用尽预算
  assert.equal(out.attempts, 2)
  assert.equal(out.ctx, 16384)
  assert.ok(out.message.includes('仍没跑起来'))
  const saved = calls.find((c) => c[0] === 'save')
  assert.equal(saved[1], null)
  assert.ok(calls.some((c) => c[0] === 'stop'))
})

test('升到更高档失败 → 退回原档，仍算成功', async () => {
  let n = 0
  const { deps, calls } = mkDeps({
    verify: async () => {
      n++
      // 首档 ok、升档失败、回滚后 ok
      return n === 2 ? vramFail : okVerify
    }
  })
  const out = await runProbeChain(mkPlan(), deps)
  assert.equal(out.ok, true)
  assert.equal(out.ctx, 32768)
  const restarts = calls.filter((c) => c[0] === 'restart')
  assert.deepEqual(
    restarts.map((r) => r[1]),
    [65536, 32768]
  )
})

test('探测预算：首档 + 降档 + 升档 + 可能的回滚', () => {
  assert.equal(probeBudget({ downBudget: 2, upBudget: 1 }), 5)
  assert.equal(probeBudget({ downBudget: 0, upBudget: 0 }), 1)
})

test('贴边降档来的起点：禁止升回去，也不再花一次重载', async () => {
  // 体检算出 64K 占用贴着上限 → 启动时已降一档到 32K。这里量出 32K 只占 6000 MiB，
  // 按 24 MiB/K 外推 64K 完全装得下 —— 但升回去窗口翻倍、速度砍半（实测 38 → 19 tok/s），
  // 所以 noUpgrade 时只验证不升档，重启次数必须是 0。
  const { deps, calls } = mkDeps()
  const out = await runProbeChain(mkPlan({ noUpgrade: true, upBudget: 0 }), deps)
  assert.equal(out.ok, true)
  assert.equal(out.ctx, 32768, '应停在起点档')
  assert.equal(calls.filter((c) => c[0] === 'restart').length, 0, '不该为升档再重启')
  // 预算也要跟着变：首档 1 + 降 2 + 升 0 + 回滚 0 = 3
  assert.equal(probeBudget({ downBudget: 2, upBudget: 0 }), 3)
})
