// 交接单的纯函数单测：提示词写得对不对，直接决定接手方能不能自己开工。
const assert = require('node:assert/strict')
const test = require('node:test')

const { buildHandoffPrompt, handoffTitle, MAX_HANDOFF_DEPTH } = require('../dist/shared/handoff.js')

test('交接单里要有任务、来源和边界', () => {
  const p = buildHandoffPrompt({
    fromName: '巡检',
    toName: '审查',
    task: '给登录接口加限流',
    context: 'daemon.ts 的 /sessions 没有频控',
    files: ['src/main/daemon.ts'],
    canWrite: true
  })
  assert.match(p, /「巡检」交过来/)
  assert.match(p, /给登录接口加限流/)
  assert.match(p, /没有频控/)
  assert.match(p, /src\/main\/daemon\.ts/)
  assert.match(p, /只处理上面这一处/)
})

test('只读交接必须提前说明写不了，否则它会把时间全花在撞墙上', () => {
  const p = buildHandoffPrompt({ toName: '审查', task: 'x', canWrite: false })
  assert.match(p, /会被拒绝/)
  assert.match(p, /把「具体改哪一行、改成什么」写清楚/)
})

test('可写交接不该出现「写不了」的说明', () => {
  const p = buildHandoffPrompt({ toName: '审查', task: 'x', canWrite: true })
  assert.doesNotMatch(p, /会被拒绝/)
})

test('没给 context / files 时不留空标题', () => {
  const p = buildHandoffPrompt({ toName: '审查', task: 'x', canWrite: true })
  assert.doesNotMatch(p, /它看到的情况/)
  assert.doesNotMatch(p, /相关文件/)
})

test('标题带目标档案，长任务名会截断', () => {
  const t = handoffTitle('审查', '把'.repeat(80))
  assert.ok(t.startsWith('↳ 审查 · '))
  assert.ok(t.length < 40, `实际 ${t.length}`)
})

test('深度上限是 3：再往后就不是分工，是踢皮球', () => {
  assert.equal(MAX_HANDOFF_DEPTH, 3)
})
