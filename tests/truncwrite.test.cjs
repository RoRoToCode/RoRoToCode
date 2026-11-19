const test = require('node:test')
const assert = require('node:assert/strict')
const { isTruncatedWrite } = require('../dist/shared/toolguard.js')
const { cutInsideString, WRITE_TEXT_KEYS } = require('../dist/shared/toolargs.js')
const { compact, messagesTokens } = require('../dist/main/agent.js')

/**
 * 真实复现（会话 d6d55f28，做一个打小鸟的游戏）：
 * 6580 字符的 flappy_bird.js 被一次 **137 字符**的写入覆盖 —— 那是这份文件的开头 6 行，
 * 回复撞到 max_tokens 被切断，工具参数只生成到一半，容错层把非法 JSON 补成合法对象后照样执行。
 * 之后模型读回文件发现内容没了，只能重头写；92 次 write_file 只落下 8 个文件，全卡在这。
 */

test('截断写入识别：三个条件缺一不可', () => {
  assert.equal(isTruncatedWrite('length', 'write_file', 'syntax'), true)
  assert.equal(isTruncatedWrite('length', 'patch', 'unwrapped'), true)
  // 没截断：参数修过也照常执行（尾逗号、单引号这类小毛病不该拦）
  assert.equal(isTruncatedWrite('stop', 'write_file', 'syntax'), false)
  assert.equal(isTruncatedWrite('tool_calls', 'write_file', 'syntax'), false)
  // 没修过：JSON 完整说明这条调用已经写完了，即使后面的输出被切
  assert.equal(isTruncatedWrite('length', 'write_file', undefined), false)
  // 只读工具拿到半截参数最多查不到，不会毁文件
  assert.equal(isTruncatedWrite('length', 'read_file', 'syntax'), false)
  assert.equal(isTruncatedWrite('length', 'run_shell', 'syntax'), false)
})

const big = (n) => 'x'.repeat(n)

function tool(id, content) {
  return { id: `t-${id}`, role: 'tool', toolCallId: `c-${id}`, toolName: 'read_file', content, createdAt: id }
}

test('compact 不折叠最新的工具输出：模型正在读的那一份必须完整', () => {
  const latest = `HEAD-${big(4000)}-TAIL`
  const list = [
    { id: 'u1', role: 'user', content: '改一下这个文件', createdAt: 1 },
    { id: 'a1', role: 'assistant', content: '', createdAt: 2, toolCalls: [{ id: 'c-1', name: 'read_file', args: { path: 'a.js' } }] },
    tool(1, big(3000)),
    { id: 'a2', role: 'assistant', content: '', createdAt: 3, toolCalls: [{ id: 'c-2', name: 'read_file', args: { path: 'b.js' } }] },
    tool(2, latest)
  ]
  const out = compact(list, 2200)
  const last = out[out.length - 1]
  assert.equal(last.content, latest, '最后一条工具输出应保持原文')
  // 但更早的那条会被折叠，而预算也真的降下来了
  assert.ok(messagesTokens(out) < messagesTokens(list))
  assert.ok(out[2].content.includes('较早的工具输出已折叠'))
})

test('compact 折叠时保留输出结尾：否则模型会误判「文件没了」', () => {
  const body = `${'function line() {}\n'.repeat(400)}END_OF_FILE_MARKER`
  // 两步：第一步读过整份文件（这一步的输出该被折叠），第二步刚查了别的东西（必须保留原文）
  const list = [
    { id: 'u1', role: 'user', content: '看看这个文件', createdAt: 1 },
    { id: 'a1', role: 'assistant', content: '', createdAt: 2, toolCalls: [{ id: 'c-1', name: 'read_file', args: { path: 'a.js' } }] },
    tool(1, body),
    { id: 'a2', role: 'assistant', content: '', createdAt: 3, toolCalls: [{ id: 'c-2', name: 'read_file', args: { path: 'b.js' } }] },
    tool(2, 'b.js 只有几行')
  ]
  const out = compact(list, 2200)
  const folded = out[2].content
  assert.ok(folded.includes('END_OF_FILE_MARKER'), '被折叠的输出也必须留下结尾')
  assert.ok(folded.includes('省略'))
  assert.equal(out[out.length - 1].content, 'b.js 只有几行', '最新一步的输出保持原文')
})

const { partialString, joinContinuation, recoverArgs } = require('../dist/shared/toolargs.js')

/**
 * 断点续写：真实断口长这样（会话 a3d5589c）——
 * `{"path":"index.html","content":"<!DOCTYPE html>\n<html…` 写到 `ctx.fill();\n` 就没了。
 * 后半段既没有闭合引号，也没有闭合花括号，整条参数在容错层只能是 failed。
 */
const CUT_RAW =
  '{"path":"index.html","content":"<!DOCTYPE html>\\n<html lang=\\"zh-CN\\">\\n<script>\\n' +
  "  const g = ctx.createLinearGradient(0,o.y,0,o.y+o.h);\\n  g.addColorStop(0,'#8a6a4a');\\n"

test('partialString：从半截 JSON 里抠出已经写好的正文，并还原转义', () => {
  const got = partialString(CUT_RAW, ['content'])
  assert.ok(got, '应该认出 content 字段')
  assert.equal(got.key, 'content')
  assert.equal(got.closed, false, '被截断的字符串不算闭合')
  assert.ok(got.text.startsWith('<!DOCTYPE html>\n<html lang="zh-CN">'), '换行和引号都要还原')
  assert.ok(got.text.endsWith("g.addColorStop(0,'#8a6a4a');\n"), '尾巴必须原样保留')
  // 没有这个字段时不要瞎猜
  assert.equal(partialString(CUT_RAW, ['old_string']), null)
})

test('recoverArgs：短参数能单独捞回来，续写后才拼得出完整调用', () => {
  assert.deepEqual(recoverArgs(CUT_RAW, ['path']), { path: 'index.html' })
})

test('joinContinuation：老实接着写就直接拼', () => {
  const full = '<html><body>'
  assert.equal(joinContinuation(full, 'hello</body></html>'), '<html><body>hello</body></html>')
})

test('joinContinuation：复读尾巴要去重，不然接缝处会长出一段重复代码', () => {
  // 本地模型最常见的走法：把断点前那几行原样再抄一遍，然后才接着往下写
  const tail = '  ctx.fillStyle=g;\n  roundRect(o.x, o.y, o.w, o.h, 5); ctx.fill();\n'
  const soFar = `function draw(ctx, o) {\n${tail}`
  const chunk = `${tail}  }\n`
  assert.equal(joinContinuation(soFar, chunk), `${soFar}  }\n`)
})

test('joinContinuation：整段重写时只取新增的部分', () => {
  const soFar = `${'A'.repeat(300)}TAIL`
  const chunk = `${'A'.repeat(300)}TAIL-REST`
  assert.equal(joinContinuation(soFar, chunk), `${'A'.repeat(300)}TAIL-REST`)
})

test('joinContinuation：剥掉模型自己加的代码块围栏', () => {
  assert.equal(joinContinuation('abc', '```js\ndef\n```'), 'abcdef')
  // 空续写不能把已有内容清掉
  assert.equal(joinContinuation('abc', '   '), 'abc')
})

/**
 * P0-2：服务端不报 finish_reason 时的兜底。
 *
 * 中转站、部分 Ollama 版本、某些 chat template 会返回 stop 甚至不给这个字段。
 * 那时半截参数会被容错层补成合法对象，然后真的覆盖文件 —— 这是数据损坏，不是效率问题。
 * 判据只能落在参数本身：断在字符串中间才是被切断的硬证据。
 */
test('cutInsideString：断在字符串里才算截断', () => {
  assert.equal(cutInsideString('{"path":"index.html","content":"<!DOCTYPE html>\\n<html>'), true)
  // 正文写完了，只少右花括号：不能当截断，否则白让模型重写一遍
  assert.equal(cutInsideString('{"path":"a.js","content":"x"'), false)
  assert.equal(cutInsideString('{"path":"a.js","content":"x"}'), false)
  // 转义引号不算闭合
  assert.equal(cutInsideString('{"content":"a\\"b'), true)
  // 转义反斜杠之后是真的闭合了
  assert.equal(cutInsideString('{"content":"a\\\\"}'), false)
  // 末尾一个孤立反斜杠：连转义序列都没写完
  assert.equal(cutInsideString('{"content":"abc\\'), true)
})

test('不报 finish_reason 的网关：断在字符串里才拦，语法修复不拦', () => {
  const cut = '{"path":"a.js","content":"function draw(ctx){'
  assert.equal(isTruncatedWrite('stop', 'write_file', 'salvaged', cut), true)
  assert.equal(isTruncatedWrite(undefined, 'write_file', 'salvaged', cut), true)
  // 尾逗号这类语法修复内容是完整的，照常执行
  assert.equal(isTruncatedWrite('stop', 'write_file', 'syntax', '{"path":"a.js","content":"x",}'), false)
  // 只读工具拿到半截参数不会毁文件
  assert.equal(isTruncatedWrite('stop', 'read_file', 'salvaged', cut), false)
  // 明说 length 时行为和以前一致
  assert.equal(isTruncatedWrite('length', 'write_file', 'salvaged', '{"path":"a.js"}'), true)
})


/**
 * P0-1：输出预算按「这次请求实际还剩多少窗口」算。
 * 以前只看 ctx/4，且不知道 prompt 多大 —— 64K 窗口、55K 历史时仍许出去 16384，
 * prompt+output 直接超窗，服务端截断后引擎还以为是「输出上限不够」。
 */
const { outputBudget, escalationRoom, isLocalProvider } = require('../dist/main/providers/budget.js')

const local = { kind: 'llama', baseUrl: 'http://127.0.0.1:8080', model: 'm', contextWindow: 65536 }
const cloud = { kind: 'openai', baseUrl: 'https://api.example.com', model: 'm', contextWindow: 200000 }

test('预算：本地首轮给足，云端首轮小、撞墙才升', () => {
  assert.equal(isLocalProvider(local), true)
  assert.equal(isLocalProvider(cloud), false)
  assert.equal(outputBudget(local, 1000), 16384)
  assert.equal(outputBudget(cloud, 1000), 8192)
  assert.equal(outputBudget(cloud, 1000, true), 32768)
  // 本地升档没有空间：首轮已经给到能给的最大值，重发一次纯属浪费
  assert.equal(escalationRoom(local, 1000), 0)
  assert.ok(escalationRoom(cloud, 1000) > 0)
})

test('预算：prompt 长大时先扣出来，绝不让 prompt+output 超窗', () => {
  // 64K 窗口、历史 55K：只剩 8K 左右，不能再按 16384 发
  const out = outputBudget(local, 55000)
  assert.ok(out < 16384, `expected < 16384, got ${out}`)
  assert.ok(55000 + out <= 65536, 'prompt + output 不能超过窗口')
  // 窗口够大时仍按 1/4 留，别把 128K 窗口一次许出去 32K
  const wide = outputBudget({ ...local, contextWindow: 131072 }, 1000)
  assert.equal(wide, 16384)
})

test('预算：用户配了就按用户的来，且不再升档', () => {
  const pinned = { ...cloud, maxOutputTokens: 4096 }
  assert.equal(outputBudget(pinned, 1000), 4096)
  assert.equal(outputBudget(pinned, 1000, true), 4096)
  assert.equal(escalationRoom(pinned, 1000), 0)
})

test('续写字段表覆盖 edit_file / patch：这两类以前完全救不了', () => {
  // edit_file：正文在 new_string 里
  const edit = '{"path":"a.js","old_string":"x","new_string":"function draw(ctx){'
  const p1 = partialString(edit, WRITE_TEXT_KEYS)
  assert.equal(p1.key, 'new_string')
  assert.equal(p1.closed, false)
  // patch：正文是 unified diff
  const patch = '{"patch":"--- a/a.js\\n+++ b/a.js\\n@@ -1 +1 @@\\n-old\\n+new'
  const p2 = partialString(patch, WRITE_TEXT_KEYS)
  assert.equal(p2.key, 'patch')
  assert.equal(p2.closed, false)
})

/**
 * 真实模型跑出来的三个坑（本地 Ornith-1.5-9B，6 轮端到端）：
 * 续写接缝要么重抄整行、要么跳过 for 头、要么只回 4 个字符，
 * 修法对应下面这几组断言。
 */
const {
  cutToBoundary,
  looksIncomplete,
  stripFenceLines,
  stripOuterChatter
} = require('../dist/main/heal.js')

test('cutToBoundary：断在半句上就整行退回，安全的那一行必须留下', () => {
  const pad = '// ' + 'x'.repeat(240) + '\n'
  const body = pad + 'function draw() {\n  a();\n  b();\n  con\n'
  // `  b();` 是判定出来的安全行，必须保留 —— 切掉它模型就会从上一行往下写，等于丢代码
  assert.equal(cutToBoundary(body), pad + 'function draw() {\n  a();\n  b();')
  // 已经停在语句边界上就不要再退
  assert.equal(cutToBoundary(pad + 'let a = 1;\n'), pad + 'let a = 1;')
  // 整段都在一行里（压缩代码）：退无可退就原样返回
  const minified = 'x'.repeat(300)
  assert.equal(cutToBoundary(minified), minified)
})

test('cutToBoundary：不把 <script> 当边界，否则续写会重开一个', () => {
  const pad = '<!-- ' + 'x'.repeat(240) + ' -->\n'
  const out = cutToBoundary(pad + '<script>\nlet a = 1;\nif (x)\n')
  assert.equal(out, pad + '<script>\nlet a = 1;')
})

test('looksIncomplete：只判有把握的，别误判 markdown', () => {
  assert.equal(looksIncomplete('<html><script>a()</script>', 'a.html'), true)
  assert.equal(looksIncomplete('<html><script>a()</script></html>', 'a.html'), false)
  assert.equal(looksIncomplete('{"a":1', 'a.json'), true)
  assert.equal(looksIncomplete('{"a":1}', 'a.json'), false)
  assert.equal(looksIncomplete('function a(){', 'a.js'), true)
  assert.equal(looksIncomplete('function a(){}', 'a.js'), false)
  assert.equal(looksIncomplete('const s = "{";', 'a.js'), false)
  assert.equal(looksIncomplete('# 标题\n\n没结构', 'a.md'), false)
})

test('stripOuterChatter：清掉 </html> 之后的客套话', () => {
  const dirty = '<!DOCTYPE html>\n<html><body>hi</body></html>\n\nIf you\'d like, I can output one clean version.'
  assert.equal(stripOuterChatter(dirty, 'index.html'), '<!DOCTYPE html>\n<html><body>hi</body></html>')
  // 前面带了「这是你要的文件」也切掉
  assert.equal(stripOuterChatter('好的，这是完整代码：\n<!DOCTYPE html><html></html>', 'a.html'), '<!DOCTYPE html><html></html>')
  // 非 HTML 不硬切，免得砍掉真实代码
  const js = 'const a = 1\n// done\n'
  assert.equal(stripOuterChatter(js, 'a.js'), js)
})

test('stripFenceLines：只清代码文件里的围栏，markdown 原样保留', () => {
  assert.equal(stripFenceLines('```html\n<div/>\n```\n', 'a.html'), '<div/>\n')
  const md = '```js\ncode\n```'
  assert.equal(stripFenceLines(md, 'a.md'), md)
})

test('restartsDocument：整份重写要替换，不能拼成两份文档', () => {
  const { restartsDocument } = require('../dist/main/heal.js')
  const soFar = '<!DOCTYPE html>\n<html><body>'
  // 真的重写：正文里又出现一次文档开头
  assert.equal(restartsDocument('<!DOCTYPE html>\n<html><head>', soFar), true)
  assert.equal(restartsDocument('x'.repeat(500) + '<html>', soFar), false, '开头 400 字符之外的不算')
  // 正常续写：只是代码片段
  assert.equal(restartsDocument('const a = 1;', soFar), false)
  // 手上这份本来就不是文档（比如一个 .js）就别乱替换
  assert.equal(restartsDocument('<html>', 'const a = 1'), false)
})
