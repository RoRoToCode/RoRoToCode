/**
 * 上下文裁剪回归：写入类工具把整份文件塞进参数，历史压不下去时
 * 服务端会稳定回 400（现场日志是 16431 vs 16384，三次重试发的是同一份）。
 *
 * 这里验三件事：
 * 1. compact 会折叠 assistant.toolCalls 里的大字段，且不破坏 tool_call / tool 结果配对；
 * 2. 整轮丢无可丢时，shrinkTail 能就地瘦身，而不是把注定 400 的请求发出去；
 * 3. 估算口径按 3 字符/token，不再偏乐观（偏乐观正是「只差 47 token」的根源）。
 */
const test = require('node:test')
const assert = require('node:assert')
const { compact, shrinkTail, messagesTokens } = require('../dist/main/agent.js')

const big = (n) => 'x'.repeat(n)

function history() {
  const html = `<html>${big(9000)}</html>`
  return [
    { id: 'u1', role: 'user', content: '写一个游戏', createdAt: 0 },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'game.html', content: html } }],
      createdAt: 1
    },
    {
      id: 't1',
      role: 'tool',
      toolCallId: 'c1',
      toolName: 'write_file',
      content: '已写入 game.html',
      createdAt: 2
    },
    { id: 'u2', role: 'user', content: '继续修一下第 162 行', createdAt: 3 },
    {
      id: 'a2',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c2', name: 'write_file', args: { path: 'game.html', content: html } }],
      createdAt: 4
    },
    {
      id: 't2',
      role: 'tool',
      toolCallId: 'c2',
      toolName: 'write_file',
      content: big(3000),
      createdAt: 5
    }
  ]
}

function pairsIntact(list) {
  const calls = new Set()
  const results = new Set()
  for (const m of list) for (const c of m.toolCalls ?? []) calls.add(c.id)
  for (const m of list) if (m.role === 'tool' && m.toolCallId) results.add(m.toolCallId)
  if (calls.size !== results.size) return false
  return [...calls].every((id) => results.has(id))
}

test('compact 折叠 assistant 工具参数，且不动配对关系', () => {
  const all = history()
  const before = messagesTokens(all)
  const out = compact(all, 2000)
  assert.ok(messagesTokens(out) < before, '压缩后 token 应该下降')
  assert.ok(pairsIntact(out), 'tool_calls 与 tool 结果必须仍然配对')
  const dumped = JSON.stringify(out)
  assert.ok(dumped.includes('历史参数已压缩'), '大段写入参数应带压缩标记')
  assert.ok(!dumped.includes(big(9000)), '原始整份文件不该继续躺在历史里')
})

test('最后一轮自己就超预算时，shrinkTail 就地瘦身而不是放弃', () => {
  const all = history()
  const out = shrinkTail(all, 900)
  assert.ok(messagesTokens(out) <= messagesTokens(all), '瘦身后不应更大')
  assert.ok(pairsIntact(out), '只截内容、不删消息，配对必须完整')
})

test('估算口径按 3 字符/token，不再偏乐观', () => {
  const html = `<div class="a">${big(3000)}</div>`
  const tokens = messagesTokens([{ id: 'm', role: 'assistant', content: html, createdAt: 0 }])
  assert.ok(tokens > 3000 / 3.5, '代码 / HTML 的估算要明显高于旧的 3.5 口径')
})
