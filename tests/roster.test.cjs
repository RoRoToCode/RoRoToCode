// 交接名单规则的单测。纯函数，不碰 electron、磁盘和网络。
const assert = require('node:assert/strict')
const test = require('node:test')

const roster = require('../dist/shared/roster.js')

/** 造一个最小档案：只关心 id 和 role */
const mk = (id, role = '负责一件事') => ({ id, name: id, role, createdAt: 0, updatedAt: 0 })

const ALL = [mk('agent_patrol', '巡检'), mk('agent_review', '审查'), mk(roster.DEFAULT_AGENT_ID, '')]

test('交接名单排除自己，否则等于用 task 派给自己', () => {
  const out = roster.handoffTargets(ALL, 'agent_patrol')
  assert.deepEqual(
    out.map((a) => a.id),
    ['agent_review', roster.DEFAULT_AGENT_ID]
  )
})

test('没有档案的会话看不到主控：它自己就是主控', () => {
  const out = roster.handoffTargets(ALL, null)
  assert.deepEqual(
    out.map((a) => a.id),
    ['agent_patrol', 'agent_review']
  )
})

test('有档案的会话能看到主控，交接这条链才接得上', () => {
  const out = roster.handoffTargets(ALL, 'agent_review')
  assert.ok(out.some((a) => a.id === roster.DEFAULT_AGENT_ID))
})

test('主控自己不能把活交给自己', () => {
  const out = roster.handoffTargets(ALL, roster.DEFAULT_AGENT_ID)
  assert.deepEqual(
    out.map((a) => a.id),
    ['agent_patrol', 'agent_review']
  )
})

test('名单为空时不抛错，只是没人可交', () => {
  assert.deepEqual(roster.handoffTargets([], 'agent_patrol'), [])
})

test('岗位说明取第一行', () => {
  assert.equal(roster.agentBrief(mk('x', '第一行\n第二行')), '第一行')
})

test('主控没有岗位说明时给兜底文案，提示词里不会出现空冒号', () => {
  const brief = roster.agentBrief(mk(roster.DEFAULT_AGENT_ID, ''))
  assert.ok(brief.length > 0)
  assert.ok(!brief.includes('：'))
})

test('普通档案漏填岗位也有兜底', () => {
  assert.equal(roster.agentBrief(mk('x', '   ')), '（没写岗位说明）')
})
