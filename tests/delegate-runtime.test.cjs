const test = require('node:test')
const assert = require('node:assert/strict')
const { runtimeDelegateTip } = require('../dist/main/agent.js')

/**
 * 运行时派发信号（autoDelegate 的第二条通道）的契约。
 *
 * 首句判定只在 step 0 看用户原话；用户开场那句没带故障词、模型随后闷头读七八个文件时，
 * 一整轮可能一次都不派。这里补一道「已经动手多轮 → 补一次 survey」的信号。
 *
 * 必须守住的四条：
 * 1. 首句已经提醒过就不再补（一句话说两遍，模型会以为它没照做）；
 * 2. 整轮只补一次（latch），否则每步都念，模型会反复派、反复读同一批文件；
 * 3. step 0 不抢首句判定的位；
 * 4. 门禁（开关 / 没 task 工具 / 计划模式 / 非交互）关掉时恒为 null ——
 *    尤其 hasTask：小模型上 task 会被硬拒（「当前模型太小」），提醒它等于白烧 token。
 */

const base = {
  step: 1,
  toolsRun: 6,
  threshold: 6,
  notified: false,
  textTip: null,
  allowed: true
}
const tip = (extra = {}) => runtimeDelegateTip({ ...base, ...extra })

test('运行时信号：首句已命中 → 不再补提醒', () => {
  assert.equal(tip({ textTip: 'review' }), null)
  assert.equal(tip({ textTip: 'survey' }), null)
  // 首句命中 + 已通知，同样不该再出现
  assert.equal(tip({ textTip: 'review', notified: true }), null)
})

test('运行时信号：动手次数达阈值且未通知 → survey', () => {
  assert.equal(tip({ toolsRun: 6 }), 'survey')
  assert.equal(tip({ toolsRun: 22 }), 'survey')
  // 边界：恰好等于阈值就该触发（>=，不是 >）
  assert.equal(tip({ toolsRun: 6, threshold: 6 }), 'survey')
})

test('运行时信号：未达阈值 → null', () => {
  assert.equal(tip({ toolsRun: 0 }), null)
  assert.equal(tip({ toolsRun: 5 }), null)
  assert.equal(tip({ toolsRun: 5, threshold: 6 }), null)
})

test('运行时信号：latch —— notified 之后再怎么动都不再提醒', () => {
  assert.equal(tip({ notified: true }), null)
  assert.equal(tip({ notified: true, toolsRun: 99 }), null)
})

test('运行时信号：step 0 不抢首句判定', () => {
  assert.equal(tip({ step: 0 }), null)
  assert.equal(tip({ step: 0, toolsRun: 40 }), null)
})

test('运行时信号：门禁关掉时恒为 null', () => {
  // allowed 汇总了「开关关 / 没有 task 工具 / 计划模式 / 非交互」四种情况
  assert.equal(tip({ allowed: false }), null)
  assert.equal(tip({ allowed: false, toolsRun: 99 }), null)
})

/**
 * 把主循环的用法照搬一遍：每步先算首句判定，再算运行时信号，发出即锁。
 * 断言「整轮只注入一次」—— 这是 tailNote 每步重新拼、提醒却不该每步重复的关键，
 * 也是原实现（没有 latch）会每步重念的回归护栏。
 */
test('整轮模拟：无论跑多少步，提醒只注入一次', () => {
  const run = (turnTextHit, hook) => {
    let notified = false
    const injected = []
    let toolsRun = 0
    for (let step = 0; step < 12; step++) {
      const textTip = turnTextHit && step === 0 ? 'review' : null
      const runtimeTip = runtimeDelegateTip({
        step,
        toolsRun,
        threshold: 6,
        notified,
        textTip,
        allowed: true
      })
      const delegateTip = textTip ?? runtimeTip
      if (delegateTip) notified = true
      if (delegateTip) injected.push({ step, kind: delegateTip })
      // 每步跑两个工具：第 3 步起 toolsRun 越过阈值
      toolsRun += 2
      if (hook) hook(step, toolsRun)
    }
    return injected
  }

  // 首句命中：只在 step 0 注入一次，之后运行时信号被 latch 挡住
  assert.deepEqual(run(true), [{ step: 0, kind: 'review' }])
  // 首句没命中：跑到阈值那一步补一次 survey，之后不再重复
  assert.deepEqual(run(false), [{ step: 3, kind: 'survey' }])
})

test('整轮模拟：没有 task 工具时一次都不注入（小模型硬拒场景）', () => {
  let notified = false
  const injected = []
  let toolsRun = 0
  for (let step = 0; step < 20; step++) {
    const runtimeTip = runtimeDelegateTip({
      step,
      toolsRun,
      threshold: 6,
      notified,
      textTip: null,
      allowed: false
    })
    if (runtimeTip) {
      notified = true
      injected.push(runtimeTip)
    }
    toolsRun += 5
  }
  assert.deepEqual(injected, [])
})
