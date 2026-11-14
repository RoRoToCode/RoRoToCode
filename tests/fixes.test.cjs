/**
 * 本轮体检修复的回归测试。
 *
 * 每条都对应一个真实故障：
 * 1. 压缩历史时按条裁剪，丢掉半条工具结果 → 之后每次请求都 400；
 * 2. 截断切在 emoji 代理对中间 → 工具结果里出现非法字符；
 * 3. edit_file 用 String.replace 传字符串 → 内容里的 `$&` 被展开，写进去的代码被改；
 * 4. 未登记风险的工具默认放行 → 新工具绕过审批；
 * 5. run_shell 的 timeout_ms 写成 "30s" → NaN → 命令刚起就被杀。
 */
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { dropOldestTurns, toolPairsIntact } = require('../dist/shared/turns.js')
const { clipSafe, replaceOnce } = require('../dist/shared/text.js')
const { classifyRisk } = require('../dist/main/risk.js')

const msg = (id, role, extra = {}) => ({ id, role, content: id, createdAt: 0, ...extra })

/** 两轮完整历史：每轮都是 提问 → 助手喊工具 → 工具结果 → 助手结论 */
function history() {
  return [
    msg('u1', 'user'),
    msg('a1', 'assistant', { toolCalls: [{ id: 'c1', name: 'read_file', args: {} }] }),
    msg('t1', 'tool', { toolCallId: 'c1' }),
    msg('a2', 'assistant'),
    msg('u2', 'user'),
    msg('a3', 'assistant', { toolCalls: [{ id: 'c2', name: 'grep', args: {} }] }),
    msg('t2', 'tool', { toolCallId: 'c2' }),
    msg('a4', 'assistant'),
    msg('u3', 'user'),
    msg('a5', 'assistant')
  ]
}

test('放得下时原样返回，一个字都不动', () => {
  const list = history()
  const out = dropOldestTurns(list, () => false)
  assert.strictEqual(out, list)
})

test('放不下时整轮丢弃：不会留下「喊了工具却没有结果」', () => {
  // 只允许 6 条以内：必须丢掉第一轮
  const out = dropOldestTurns(history(), (next) => next.length > 6)
  assert.deepStrictEqual(
    out.map((m) => m.id),
    ['u1', 'u3', 'a5']
  )
  assert.ok(toolPairsIntact(out))
})

test('丢掉的那段不会把 tool 结果和它的调用拆开', () => {
  // 逐步收紧预算，每一步结果都必须是配对完整的
  for (let limit = 10; limit >= 2; limit--) {
    const out = dropOldestTurns(history(), (next) => next.length > limit)
    assert.ok(toolPairsIntact(out), `预算 ${limit} 时历史不配对：${out.map((m) => m.id).join(',')}`)
    // 第一条提问始终保留（任务背景）
    assert.strictEqual(out[0].id, 'u1')
  }
})

test('只剩最后一轮时宁可超预算也不切空', () => {
  const list = [msg('u1', 'user'), msg('a1', 'assistant')]
  const out = dropOldestTurns(list, () => true)
  assert.deepStrictEqual(out.map((m) => m.id), ['u1', 'a1'])
})

test('历史开头不是 user（被删过）时也能安全裁剪', () => {
  const list = [msg('t0', 'tool', { toolCallId: 'c0' }), msg('u1', 'user'), msg('a1', 'assistant')]
  const out = dropOldestTurns(list, (next) => next.length > 2)
  assert.ok(toolPairsIntact(out))
})

test('clipSafe 不会切在 emoji 的代理对中间', () => {
  // '😀' 占两个 code unit，切在 1 就是半个字符
  const text = '😀abc'
  const cut = clipSafe(text, 1, '')
  assert.strictEqual(cut, '')
  assert.ok(!/[\uD800-\uDBFF]$/.test(cut))
  // 正常位置不受影响
  assert.strictEqual(clipSafe('abcdef', 3, ''), 'abc')
  assert.strictEqual(clipSafe('abc', 10), 'abc')
})

test('clipSafe 超出时补省略标记，且同样不切断代理对', () => {
  const out = clipSafe('😀😀😀', 3)
  assert.ok(out.endsWith('…'))
  assert.ok(!/[\uD800-\uDBFF]…$/.test(out))
})

test('replaceOnce 不展开 $& / $\' / $$ 这些替换模式', () => {
  const original = 'const a = 1'
  // 替换内容里带 $& —— String.replace 会把它展开成「匹配到的原文」
  const out = replaceOnce(original, 'a = 1', "a = s.replace(/x/g, '$&b')")
  assert.strictEqual(out, "const a = s.replace(/x/g, '$&b')")
  // $$ 也不能变成 $
  assert.strictEqual(replaceOnce('X', 'X', '$$HOME'), '$$HOME')
})

test('replaceOnce 只替换第一处，找不到就原样返回', () => {
  assert.strictEqual(replaceOnce('a-a-a', 'a', 'b'), 'b-a-a')
  assert.strictEqual(replaceOnce('abc', 'zzz', 'y'), 'abc')
  // 空 find 不能变成「在每个字符间插入」
  assert.strictEqual(replaceOnce('abc', '', 'y'), 'abc')
})

test('未登记风险的工具默认按高危处理（不能静默放行）', () => {
  const ws = path.resolve('C:/work/demo')
  const risk = classifyRisk('some_new_tool', {}, ws)
  assert.ok(risk, '未登记工具必须返回风险信息')
  assert.strictEqual(risk.high, true)
})

test('登记过的只读工具仍然不弹确认', () => {
  const ws = path.resolve('C:/work/demo')
  for (const tool of ['read_file', 'list_dir', 'grep', 'web_fetch', 'update_todos', 'remember', 'board', 'scratch']) {
    const args = tool === 'read_file' || tool === 'grep' || tool === 'list_dir' ? { path: 'src/a.ts' } : {}
    assert.strictEqual(classifyRisk(tool, args, ws), null, `${tool} 不该要确认`)
  }
})

test('子代理 / 交接 / 技能这类会话内工具不该突然要确认', () => {
  const ws = path.resolve('C:/work/demo')
  for (const tool of ['task', 'handoff', 'question', 'use_skill', 'write_plan']) {
    assert.strictEqual(classifyRisk(tool, {}, ws), null, `${tool} 不该要确认`)
  }
})
