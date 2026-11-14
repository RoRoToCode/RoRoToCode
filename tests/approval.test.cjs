/**
 * 审批决策单测。
 * 用 Node 内置的 test runner，直接跑 dist 里的编译产物，不额外装测试框架：
 *   npm test  →  build:main && node --test tests/
 */
const test = require('node:test')
const assert = require('node:assert')
const { decideApproval } = require('../dist/main/approval.js')

const base = {
  mode: 'ask',
  hasRisk: true,
  high: false,
  alwaysApprove: false,
  alwaysApproveHigh: false
}

test('无风险的工具调用：任何模式都放行，包括只读档', () => {
  for (const mode of ['ask', 'auto', 'readonly']) {
    assert.strictEqual(decideApproval({ ...base, mode, hasRisk: false }), 'allow')
  }
})

test('只读档：有副作用一律拒绝', () => {
  assert.strictEqual(decideApproval({ ...base, mode: 'readonly' }), 'deny')
  assert.strictEqual(decideApproval({ ...base, mode: 'readonly', high: true }), 'deny')
})

test('询问档：普通风险要问，普通放行后不再问', () => {
  assert.strictEqual(decideApproval(base), 'ask')
  assert.strictEqual(decideApproval({ ...base, alwaysApprove: true }), 'allow')
})

test('自动模式：普通风险直接放行', () => {
  assert.strictEqual(decideApproval({ ...base, mode: 'auto' }), 'allow')
})

test('高危：自动模式也必须问（这正是原来的漏洞）', () => {
  assert.strictEqual(decideApproval({ ...base, mode: 'auto', high: true }), 'ask')
})

test('高危：普通「之后全允许」不能顺带放行高危', () => {
  assert.strictEqual(decideApproval({ ...base, high: true, alwaysApprove: true }), 'ask')
  assert.strictEqual(
    decideApproval({ ...base, high: true, alwaysApprove: true, mode: 'auto' }),
    'ask'
  )
})

test('高危：只有显式允许高危后才放行', () => {
  assert.strictEqual(decideApproval({ ...base, high: true, alwaysApproveHigh: true }), 'allow')
})

test('高危放行不影响普通风险的判断路径', () => {
  assert.strictEqual(
    decideApproval({ ...base, high: false, alwaysApproveHigh: true }),
    'ask'
  )
})

test('「以后都这样」的长期授权：非高危直接放行，不用再问', () => {
  assert.strictEqual(decideApproval({ ...base, granted: true }), 'allow')
})

test('长期授权不能越过高危：高危操作该问还得问', () => {
  assert.strictEqual(decideApproval({ ...base, high: true, granted: true }), 'ask')
  // 连自动模式一起算也一样：高危只认「高危专用放行」
  assert.strictEqual(decideApproval({ ...base, high: true, granted: true, mode: 'auto' }), 'ask')
})

test('长期授权不能绕过只读档与项目规则', () => {
  assert.strictEqual(decideApproval({ ...base, granted: true, mode: 'readonly' }), 'deny')
  assert.strictEqual(decideApproval({ ...base, granted: true, denied: true }), 'deny')
})
