// 快捷键解析 / 匹配 / 归一化的单测
const assert = require('node:assert/strict')
const test = require('node:test')

const keys = require('../dist/shared/keys.js')

test('解析常规组合键', () => {
  assert.deepEqual(keys.parseCombo('Ctrl+K'), { key: 'k', shift: false, alt: false })
  assert.deepEqual(keys.parseCombo('ctrl+shift+p'), { key: 'p', shift: true, alt: false })
  assert.deepEqual(keys.parseCombo('Ctrl+, '), { key: ',', shift: false, alt: false })
})

test('mac 上的 Cmd / 中文输入法里的 Control 都按 Ctrl 处理', () => {
  assert.deepEqual(keys.parseCombo('Cmd+K'), { key: 'k', shift: false, alt: false })
  assert.deepEqual(keys.parseCombo('Meta+K'), { key: 'k', shift: false, alt: false })
})

test('没有 Ctrl 的组合一律非法（裸字母会劫走打字）', () => {
  assert.equal(keys.parseCombo('K'), null)
  assert.equal(keys.parseCombo('Shift+K'), null)
  assert.equal(keys.parseCombo(''), null)
  assert.equal(keys.parseCombo('Ctrl'), null)
  assert.equal(keys.parseCombo('Ctrl+Foo+K'), null)
})

test('格式化后能再解析回来（往返稳定）', () => {
  for (const s of ['Ctrl+K', 'Ctrl+Shift+P', 'Ctrl+Alt+1', 'Ctrl+,']) {
    assert.equal(keys.formatCombo(keys.parseCombo(s)), s)
  }
  // 小写输入会被规范成标准写法
  assert.equal(keys.formatCombo(keys.parseCombo('control+shift+k')), 'Ctrl+Shift+K')
})

test('按下修饰键本身不算一次输入', () => {
  assert.equal(keys.comboFromEvent({ key: 'Control', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }), null)
  assert.equal(keys.comboFromEvent({ key: 'Shift', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }), null)
  assert.equal(keys.comboFromEvent({ key: 'k', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }), null)
})

test('匹配时严格区分附加修饰键', () => {
  const base = { key: 'k', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }
  assert.equal(keys.comboMatches(base, 'Ctrl+K'), true)
  assert.equal(keys.comboMatches(base, 'Ctrl+Shift+K'), false)
  assert.equal(keys.comboMatches({ ...base, shiftKey: true }, 'Ctrl+Shift+K'), true)
  assert.equal(keys.comboMatches({ ...base, metaKey: true }, 'Ctrl+K'), true)
})

test('未绑定（空串）永远不命中', () => {
  assert.equal(keys.comboMatches({ key: 'k', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, ''), false)
})

test('冲突检查：同一个键不能被两个动作占用', () => {
  const cur = keys.defaultKeys()
  assert.equal(keys.findConflict(cur, 'search', 'Ctrl+N'), 'newSession')
  // 自己改自己不算冲突
  assert.equal(keys.findConflict(cur, 'newSession', 'Ctrl+N'), null)
  // 大小写 / 写法不同但实际相同，也要算冲突
  assert.equal(keys.findConflict(cur, 'export', 'ctrl+n'), 'newSession')
  // 带了 Shift 就是另一个键，不算冲突
  assert.equal(keys.findConflict(cur, 'export', 'ctrl+shift+n'), null)
})

test('归一化：非法值回默认', () => {
  const out = keys.normalizeKeys({ search: 'K', newSession: 123, export: null })
  assert.equal(out.search, 'Ctrl+K')
  assert.equal(out.newSession, 'Ctrl+N')
  assert.equal(out.export, 'Ctrl+E')
  assert.equal(out.settings, 'Ctrl+,')
})

test('归一化：重复的绑定回默认，不会两个动作抢同一个键', () => {
  const out = keys.normalizeKeys({ search: 'Ctrl+J', newSession: 'Ctrl+J' })
  const vals = Object.values(out)
  assert.equal(new Set(vals).size, vals.length)
  assert.equal(out.search, 'Ctrl+J')
  assert.notEqual(out.newSession, 'Ctrl+J')
})

test('归一化：任意垃圾输入都不抛错', () => {
  for (const bad of [null, undefined, 42, 'x', [], { search: {} }]) {
    const out = keys.normalizeKeys(bad)
    assert.deepEqual(Object.keys(out).sort(), ['export', 'newSession', 'search', 'settings'])
    for (const v of Object.values(out)) assert.equal(typeof v, 'string')
  }
})

test('默认值本身是合法的且互不重复', () => {
  const d = keys.defaultKeys()
  const vals = Object.values(d)
  assert.equal(new Set(vals).size, vals.length)
  for (const v of vals) assert.ok(keys.parseCombo(v))
})
