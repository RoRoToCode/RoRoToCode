const test = require('node:test')
const assert = require('node:assert/strict')
const { createToolCallGuard, callSignature, toolKind } = require('../dist/shared/toolguard.js')

/** 走一遍「执行完记一笔」，返回这次 check 的结论 */
function cycle(guard, name, args, result) {
  const d = guard.check(name, args)
  guard.record(name, args, result)
  return d
}

test('签名对键序不敏感：换个键序不能绕过护栏', () => {
  assert.equal(
    callSignature('read_file', { path: 'a.ts', limit: 10 }),
    callSignature('read_file', { limit: 10, path: 'a.ts' })
  )
  // 值不同必须是不同签名
  assert.notEqual(callSignature('read_file', { path: 'a.ts' }), callSignature('read_file', { path: 'b.ts' }))
  // 工具名大小写不敏感
  assert.equal(callSignature('Read_File', { path: 'a.ts' }), callSignature('read_file', { path: 'a.ts' }))
})

test('副作用分级：写 / 命令 / 只读，认不出的当只读', () => {
  assert.equal(toolKind('write_file'), 'write')
  assert.equal(toolKind('patch'), 'write')
  assert.equal(toolKind('run_shell'), 'shell')
  assert.equal(toolKind('web_search'), 'read')
  assert.equal(toolKind('mcp__github__search'), 'read')
  assert.equal(toolKind(''), 'read')
})

test('只读工具：结果不变时第 6 次拦下，之前只警告一次', () => {
  const guard = createToolCallGuard()
  const args = { query: 'llama.cpp 量化' }
  const verdicts = []
  for (let i = 0; i < 6; i++) verdicts.push(cycle(guard, 'web_search', args, '同样的三条结果').verdict)
  assert.deepEqual(verdicts.slice(0, 5), ['ok', 'ok', 'ok', 'warn', 'ok'])
  assert.equal(verdicts[5], 'block')
})

test('结果一直在变 = 有进展，永远不拦（轮询进度不能被误伤）', () => {
  const guard = createToolCallGuard()
  const args = { command: 'ls -l out.zip' }
  for (let i = 0; i < 12; i++) {
    const d = cycle(guard, 'run_shell', args, `size=${i * 1024}`)
    assert.notEqual(d.verdict, 'block', `第 ${i + 1} 次就被拦了`)
  }
})

test('写工具门槛最低：第三次重复就拦，早于只读工具', () => {
  const guard = createToolCallGuard()
  const args = { path: 'a.ts', old_string: 'x', new_string: 'y' }
  const verdicts = []
  for (let i = 0; i < 4; i++) verdicts.push(cycle(guard, 'edit_file', args, '失败：找不到要替换的原文').verdict)
  assert.deepEqual(verdicts, ['ok', 'ok', 'warn', 'block'])
})

test('只调过一次时没有对比样本，不放行拦截（避免误杀正常重试）', () => {
  const guard = createToolCallGuard()
  // times=2 才有两次结果可比；只执行过一次再问，必须还是 ok / warn，不能 block
  cycle(guard, 'patch', { path: 'a.ts' }, '失败：旧文本不匹配')
  cycle(guard, 'patch', { path: 'a.ts' }, '失败：旧文本不匹配')
  const d = guard.check('patch', { path: 'a.ts' })
  // times=2、两次结果一致 → 已经冻结，达到 blockAt=3 之前仍只是 warn
  assert.equal(d.verdict, 'warn')
  assert.equal(d.times, 2)
})

test('不同参数互不计数', () => {
  const guard = createToolCallGuard()
  for (let i = 0; i < 5; i++) cycle(guard, 'read_file', { path: 'a.ts' }, '正文')
  const other = guard.check('read_file', { path: 'b.ts' })
  assert.equal(other.verdict, 'ok')
  assert.equal(other.times, 0)
})

test('拦截文案带上上次结果，模型不必再跑一遍', () => {
  const guard = createToolCallGuard()
  const args = { path: 'src/a.ts' }
  for (let i = 0; i < 5; i++) cycle(guard, 'write_file', args, '已写入 src/a.ts（12 行）')
  const d = guard.check('write_file', args)
  assert.equal(d.verdict, 'block')
  assert.match(d.note, /已拦截/)
  assert.match(d.note, /已写入 src\/a\.ts/)
  assert.match(d.note, /换做法/)
  assert.equal(d.lastResult.includes('已写入'), true)
})

test('警告只发一次，不会每轮都往上下文里塞同一段话', () => {
  const guard = createToolCallGuard()
  const args = { path: 'a.ts' }
  let warns = 0
  for (let i = 0; i < 5; i++) {
    if (cycle(guard, 'grep', args, '无匹配').verdict === 'warn') warns++
  }
  assert.equal(warns, 1)
})

test('签名表有上限：长时间运行不会无限涨', () => {
  const guard = createToolCallGuard({ maxEntries: 20 })
  for (let i = 0; i < 200; i++) guard.record('read_file', { path: `f${i}.ts` }, 'x')
  assert.ok(guard.size() <= 20, `size=${guard.size()}`)
  guard.reset()
  assert.equal(guard.size(), 0)
})
