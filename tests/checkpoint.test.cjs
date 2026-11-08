/**
 * checkpointBrief：把结构化进度拼成「恢复摘要」的纯函数单测。
 *
 * 核心诉求：崩溃后恢复时，模型要能从摘要里明确看到
 * ① 还剩哪些计划没做 ② 哪些文件已经动过 ③ 上次验证结论，且不重复已完成部分。
 */
const test = require('node:test')
const assert = require('node:assert')
const { checkpointBrief } = require('../dist/shared/checkpoint.js')

const cp = (over = {}) => ({
  sessionId: 'abc-123',
  workspace: 'C:/ws',
  status: 'running',
  todos: [],
  touched: [],
  verifyNote: null,
  lastCalls: [],
  continues: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over
})

test('有未完成计划时，列出剩余项和进度', () => {
  const brief = checkpointBrief(
    cp({
      todos: [
        { content: '写模块 A', status: 'completed' },
        { content: '写模块 B', status: 'in_progress' },
        { content: '写模块 C', status: 'pending' }
      ]
    })
  )
  assert.match(brief, /还剩 2 项未完成/)
  assert.match(brief, /已完成 1\/3/)
  assert.match(brief, /进行中.*写模块 B/)
  assert.match(brief, /未开始.*写模块 C/)
  // 已完成的项不该再列出来
  assert.doesNotMatch(brief, /写模块 A/)
})

test('列出已改动文件，提示不要重复', () => {
  const brief = checkpointBrief(cp({ touched: ['src/a.ts', 'src/b.ts'] }))
  assert.match(brief, /已经改动过的文件/)
  assert.match(brief, /src\/a\.ts/)
  assert.match(brief, /src\/b\.ts/)
  assert.match(brief, /不要重复已经完成的部分/)
})

test('带上上次验证结论', () => {
  const brief = checkpointBrief(cp({ verifyNote: '测试失败：TypeError: x is not a function' }))
  assert.match(brief, /上次最后的验证结论/)
  assert.match(brief, /TypeError/)
})

test('空 checkpoint 只给一句收尾', () => {
  const brief = checkpointBrief(cp({}))
  assert.match(brief, /请从断点接着做完/)
  assert.doesNotMatch(brief, /未完成|已经改动过的文件|验证结论/)
})
