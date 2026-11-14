const test = require('node:test')
const assert = require('node:assert')
const { classifyRisk } = require('../dist/main/risk.js')
const { toolSpecs } = require('../dist/main/tools/spec.js')
const { langOf } = require('../dist/main/lsp/native.js')

const WS = 'C:\\proj'

test('新工具已注册进工具表', () => {
  for (const name of ['terminal', 'git', 'format', 'use_skill']) {
    assert.ok(toolSpecs.some((t) => t.name === name), `${name} 应该在 toolSpecs 里`)
  }
})

test('use_skill：只是取技能说明，不算风险动作', () => {
  // 它是「读一份指令」，不碰工作区也不跑命令；要弹确认就等于给自动调用上锁
  assert.strictEqual(classifyRisk('use_skill', { name: 'vramfit' }, WS), null)
})

test('terminal：打开是高危，写入是普通风险，读/列表无风险', () => {
  assert.strictEqual(classifyRisk('terminal', { action: 'open' }, WS)?.high, true)
  assert.strictEqual(classifyRisk('terminal', { action: 'write', data: 'ls\n' }, WS)?.kind, 'shell')
  assert.strictEqual(classifyRisk('terminal', { action: 'write', data: 'ls\n' }, WS)?.high, false)
  assert.strictEqual(classifyRisk('terminal', { action: 'read' }, WS), null)
  assert.strictEqual(classifyRisk('terminal', { action: 'list' }, WS), null)
  assert.strictEqual(classifyRisk('terminal', { action: 'close' }, WS), null)
})

test('git：读操作无风险，网络操作高危，本地写是普通风险', () => {
  for (const action of ['status', 'diff', 'log', 'branches']) {
    assert.strictEqual(classifyRisk('git', { action }, WS), null, `${action} 不应要求确认`)
  }
  for (const action of ['push', 'pull', 'pr']) {
    const r = classifyRisk('git', { action }, WS)
    assert.strictEqual(r?.kind, 'network', `${action} 应判为网络`)
    assert.strictEqual(r?.high, true)
  }
  assert.strictEqual(classifyRisk('git', { action: 'commit' }, WS)?.kind, 'write')
  assert.strictEqual(classifyRisk('git', { action: 'undo' }, WS)?.high, false)
})

test('format：普通路径是写风险，越界是高危', () => {
  assert.strictEqual(classifyRisk('format', { paths: ['src/a.ts'] }, WS)?.kind, 'write')
  const outside = classifyRisk('format', { paths: ['../secret.ts'] }, WS)
  assert.strictEqual(outside?.kind, 'outside')
  assert.strictEqual(outside?.high, true)
})

test('按扩展名分流到对应语言', () => {
  assert.strictEqual(langOf('a.py'), 'python')
  assert.strictEqual(langOf('a.go'), 'go')
  assert.strictEqual(langOf('a.rs'), 'rust')
  assert.strictEqual(langOf('a.java'), 'java')
  assert.strictEqual(langOf('a.ts'), null)
  assert.strictEqual(langOf('a.txt'), null)
})
