/**
 * old_string 宽松匹配的单测。
 *
 * 这套逻辑的意义是「模型给的片段语义对、字符不对时仍能落到正确位置」，
 * 所以每条测试都对应一种真实失败：缩进漂移、行尾空白、CRLF、多带空行、
 * 多处歧义、范围吞太大。最后一条验「没命中时给出的线索」——
 * 只说「未找到」等于让模型干猜，必须给出最接近的一段和行号。
 */
const test = require('node:test')
const assert = require('node:assert')
const { applyEdit } = require('../dist/shared/editmatch.js')

test('精确匹配：返回行号与策略', () => {
  const src = 'function a() {\n  return 1\n}\n'
  const r = applyEdit(src, 'return 1', 'return 2')
  assert.equal(r.ok, true)
  assert.equal(r.strategy, 'exact')
  assert.equal(r.ranges[0].lineStart, 2)
  assert.equal(r.text, 'function a() {\n  return 2\n}\n')
})

test('缩进漂移：模型少写两格缩进也能命中', () => {
  const src = 'function a() {\n    const x = 1\n    return x\n}\n'
  const oldText = 'const x = 1\n  return x'
  const r = applyEdit(src, oldText, 'const x = 2\n  return x')
  assert.equal(r.ok, true)
  assert.notEqual(r.strategy, 'exact')
  assert.match(r.text, /const x = 2/)
  assert.equal(r.ranges[0].lineStart, 2)
  assert.equal(r.ranges[0].lineEnd, 3)
})

test('行尾空白差异：行 trim 后命中', () => {
  const src = 'a = 1   \nb = 2\nc = 3\n'
  const r = applyEdit(src, 'a = 1\nb = 2', 'a = 9\nb = 2')
  assert.equal(r.ok, true)
  assert.equal(r.strategy, 'line-trimmed')
  assert.match(r.text, /a = 9/)
})

test('CRLF 文件：替换后仍然是 CRLF，不产生混合换行', () => {
  const src = 'one\r\ntwo\r\nthree\r\n'
  const r = applyEdit(src, 'one\ntwo', 'ONE\nTWO')
  assert.equal(r.ok, true)
  assert.equal(r.text, 'ONE\r\nTWO\r\nthree\r\n')
  assert.equal(/[^\r]\n/.test(r.text), false)
})

test('多带一个空行：剥掉块首尾空行后命中', () => {
  const src = 'x = 1\ny = 2\nz = 3\n'
  const r = applyEdit(src, '\nx = 1\ny = 2\n', 'x = 1\ny = 7')
  assert.equal(r.ok, true)
  assert.equal(r.text, 'x = 1\ny = 7\nz = 3\n')
})

test('多处命中：拒绝并报出行号', () => {
  const src = 'doThing()\ndoThing()\n'
  const r = applyEdit(src, 'doThing()', 'doThing2()')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'ambiguous')
  assert.match(r.message, /第 1、2 行/)
})

test('replace_all：多处一起改', () => {
  const src = 'doThing()\ndoThing()\n'
  const r = applyEdit(src, 'doThing()', 'doThing2()', true)
  assert.equal(r.ok, true)
  assert.equal(r.count, 2)
  assert.equal(r.text, 'doThing2()\ndoThing2()\n')
})

test('没命中：给出最接近的一段和行号，而不是干说未找到', () => {
  const src = 'function a() {\n  const value = compute()\n  return value\n}\n'
  const r = applyEdit(src, 'const valu = compute()\n  return val', 'x')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-found')
  assert.match(r.message, /最接近的是第 2-3 行/)
  assert.match(r.message, /const value = compute\(\)/)
})

test('首尾锚点：中间被改过一行，仍能整段替换', () => {
  const src = ['function a() {', '  const alpha = 1', '  const beta = 2', '  const gamma = 3', '}'].join('\n') + '\n'
  const oldText = ['function a() {', '  const alpha = 1', '  const beta = 999', '  const gamma = 3', '}'].join('\n')
  const r = applyEdit(src, oldText, ['function a() {', '  return 42', '}'].join('\n'))
  assert.equal(r.ok, true)
  assert.equal(r.strategy, 'block-anchor')
  assert.equal(r.text, 'function a() {\n  return 42\n}\n')
})

test('不吞整段：只给首尾两行时，不会把整个函数替换掉', () => {
  const big = Array.from({ length: 60 }, (_, i) => `  line${i} = ${i}`).join('\n')
  const src = `function a() {\n${big}\n}\n`
  // 看似「首尾都命中」，但中间 60 行都不是模型写的：宁可失败，也不能整段吞掉
  const r = applyEdit(src, 'function a() {\n}', 'function b() {\n}')
  assert.equal(r.ok, false)
  assert.notEqual(r.strategy, 'exact')
  assert.ok(src.includes('line0 = 0'), '原文应保持不变（这里只验证未产生替换结果）')
})

test('中间行差异过大：范围远超 old_string 时拒绝', () => {
  const huge = `middle_${'x'.repeat(600)}`
  const src = ['start()', huge, 'end()'].join('\n') + '\n'
  const r = applyEdit(src, 'start()\nmiddle_old\nend()', 'ok()')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'disproportionate')
})

test('old 与 new 相同：直接拒绝，不要假装改了什么', () => {
  const r = applyEdit('abc\n', 'abc', 'abc')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'same')
})

test('old 为空：拒绝', () => {
  const r = applyEdit('abc\n', '', 'x')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'empty')
})

test('BOM 保留：带 BOM 的文件改完仍是带 BOM', () => {
  const src = '\uFEFFconst a = 1\n'
  const r = applyEdit(src, 'const a = 1', 'const a = 2')
  assert.equal(r.ok, true)
  assert.equal(r.text, '\uFEFFconst a = 2\n')
})
