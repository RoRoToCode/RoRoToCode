// 共享黑板的解析 / 去重 / 注入文本。纯函数，不碰 electron 和磁盘。
const assert = require('node:assert/strict')
const test = require('node:test')

const board = require('../dist/shared/board.js')

test('空黑板也能渲染出三段，用户打开就知道往哪写', () => {
  const text = board.renderBoard(board.emptyBoard())
  assert.ok(text.includes('## 约定'))
  assert.ok(text.includes('## 事实'))
  assert.ok(text.includes('## 待办'))
})

test('写进去再读回来，条目一条不少', () => {
  const first = board.addToBoard(board.emptyBoard(), 'rule', '测试跑 npm run verify')
  const second = board.addToBoard(first.data, 'todo', '还没补 /sessions 的限流测试')
  const back = board.parseBoard(board.renderBoard(second.data))
  assert.deepEqual(back.rule, ['测试跑 npm run verify'])
  assert.deepEqual(back.todo, ['还没补 /sessions 的限流测试'])
  assert.deepEqual(back.fact, [])
})

test('返回的条数是加完之后的，不是加之前的', () => {
  const a = board.addToBoard(board.emptyBoard(), 'fact', '第一条')
  const b = board.addToBoard(a.data, 'fact', '第二条')
  assert.equal(a.items, 1)
  assert.equal(b.items, 2)
})

test('新写的排在最上面：黑板是便签，最近写的最可能要用', () => {
  let d = board.emptyBoard()
  d = board.addToBoard(d, 'fact', '第一条').data
  d = board.addToBoard(d, 'fact', '第二条').data
  assert.deepEqual(d.fact, ['第二条', '第一条'])
})

test('同一条话换个标点不会变成两条', () => {
  const once = board.addToBoard(board.emptyBoard(), 'fact', '限流在 src/auth/limit.ts')
  const again = board.addToBoard(once.data, 'fact', '限流在 src/auth/limit.ts。')
  assert.equal(again.added, false)
  assert.equal(again.items, 1)
})

test('跨段重复也算重复：同一件事不该在约定和事实里各写一遍', () => {
  const once = board.addToBoard(board.emptyBoard(), 'rule', '别动 legacy/ 目录')
  const again = board.addToBoard(once.data, 'fact', '别动 legacy/ 目录')
  assert.equal(again.added, false)
})

test('空白条目不写入', () => {
  const r = board.addToBoard(board.emptyBoard(), 'todo', '   ')
  assert.equal(r.added, false)
})

test('注入文本带分段前缀，模型能分清哪条是约定', () => {
  let d = board.addToBoard(board.emptyBoard(), 'rule', '用 pnpm').data
  d = board.addToBoard(d, 'todo', '补测试').data
  const text = board.boardPromptText(d)
  assert.ok(text.includes('- [约定] 用 pnpm'))
  assert.ok(text.includes('- [待办] 补测试'))
})

test('超长时不硬塞进提示：装不下的条目直接跳过，且不超过上限', () => {
  let d = board.emptyBoard()
  for (let i = 0; i < 40; i++) d = board.addToBoard(d, 'todo', `第 ${i} 条待办，写得长一点好把预算撑满`).data
  d = board.addToBoard(d, 'rule', '约定要留下').data
  const text = board.boardPromptText(d)
  assert.ok(text.length <= board.BOARD_PROMPT_LIMIT, `实际 ${text.length}`)
  // 约定排在最前面，必须保住
  assert.ok(text.includes('约定要留下'))
})

test('手改文件写坏一行，不该让整页失效', () => {
  const broken = ['# 共享黑板', '## 约定', '- 能读的这条要留下', '## 含义不明的小节', '- 这条该被忽略', '## 事实'].join('\n')
  const parsed = board.parseBoard(broken)
  assert.deepEqual(parsed.rule, ['能读的这条要留下'])
  assert.deepEqual(parsed.fact, [])
})
