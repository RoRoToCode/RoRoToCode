/**
 * 只读工具并发「取哪一段」的边界单测。
 *
 * 并发本身没法在单测里验证时序，但真正容易出事的是**边界**：
 * 一旦把 write_file / run_shell 后面的读也拖进同一批，就会读到旧内容
 * （写完再读回来校验是模型最常用的套路）。这几条就是钉死这个边界。
 */
const test = require('node:test')
const assert = require('node:assert')
const { collectParallelReadRun } = require('../dist/main/agent.js')

const call = (name, extra) => ({ id: `${name}-${Math.random().toString(36).slice(2, 6)}`, name, args: {}, ...extra })

test('连续三个 read_file：整段收进来', () => {
  const calls = [call('read_file'), call('read_file'), call('read_file')]
  assert.equal(collectParallelReadRun(calls, 0).length, 3)
})

test('中间夹一个 write_file：在它前面断开', () => {
  const calls = [call('read_file'), call('read_file'), call('write_file'), call('read_file')]
  const run = collectParallelReadRun(calls, 0)
  assert.equal(run.length, 2)
  assert.ok(run.every((c) => c.name === 'read_file'))
})

test('只有单个只读调用：不并发（走了也没收益，还要多绕一层）', () => {
  const calls = [call('read_file'), call('run_shell')]
  assert.equal(collectParallelReadRun(calls, 0).length, 0)
})

test('中间夹一个 run_shell：在它前面断开', () => {
  const calls = [call('grep'), call('run_shell'), call('grep'), call('grep')]
  assert.equal(collectParallelReadRun(calls, 0).length, 0, '开头只有一个 grep 就断了，退回串行')
  assert.equal(collectParallelReadRun(calls, 2).length, 2)
})

test('参数不完整的调用切断这一批（只剩一个就退回串行）', () => {
  const calls = [call('read_file'), call('read_file', { truncRejected: '[已拦下]' }), call('read_file')]
  // 第二个被截断拦下，这一批只能到第一个 —— 长度为 1 时按约定返回空数组，交给串行
  assert.equal(collectParallelReadRun(calls, 0).length, 0)
  // 从它后面重新收集则是正常的一批
  assert.equal(collectParallelReadRun(calls, 2).length, 0)
})

test('上限：一批最多 6 个', () => {
  const calls = Array.from({ length: 10 }, () => call('read_file'))
  assert.equal(collectParallelReadRun(calls, 0).length, 6)
})

test('不认识的工具切断这一批（MCP / 第三方工具副作用不明）', () => {
  const calls = [call('read_file'), call('mcp__foo__bar'), call('read_file')]
  assert.equal(collectParallelReadRun(calls, 0).length, 0, '只剩一个读，退回串行')
})

test('list_dir / glob / grep / read_file 可以混在一批里', () => {
  const calls = [call('read_file'), call('list_dir'), call('glob'), call('grep')]
  assert.equal(collectParallelReadRun(calls, 0).length, 4)
})

test('repo_map / LSP 跳转不参与并发', () => {
  const calls = [call('read_file'), call('repo_map'), call('read_file'), call('read_file')]
  assert.equal(collectParallelReadRun(calls, 0).length, 0, 'repo_map 会写索引缓存，必须在它前面断开')
  assert.equal(collectParallelReadRun(calls, 2).length, 2, '它后面的两个读照常成批')
})
