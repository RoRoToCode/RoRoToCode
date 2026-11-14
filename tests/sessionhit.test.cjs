const test = require('node:test')
const assert = require('node:assert/strict')
const { searchHit } = require('../dist/shared/sessionhit.js')

const base = {
  id: 'abc-123',
  title: '修一下登录接口',
  workspace: 'C:/ws',
  createdAt: 1000,
  updatedAt: 2000,
  messages: [
    { role: 'user', content: '登录接口返回 500，帮我看下' },
    { role: 'assistant', content: '我先读一下 auth.ts' }
  ]
}

test('标题命中优先做片段：标题和首条消息都含关键词时计数为 2', () => {
  const hit = searchHit(base, '登录')
  assert.equal(hit.hits, 2)
  assert.equal(hit.snippet, '修一下登录接口')
  assert.equal(hit.id, 'abc-123')
})

test('只在正文命中：片段带上下文，大小写不敏感', () => {
  const hit = searchHit(base, 'AUTH.TS')
  assert.equal(hit.hits, 1)
  assert.match(hit.snippet, /auth\.ts/i)
})

test('多条消息命中时逐条累计', () => {
  const both = searchHit({ ...base, messages: [{ content: '登录还是不行' }, { content: '登录已修好' }] }, '登录')
  // 标题 1 + 正文 2
  assert.equal(both.hits, 3)
})

test('老会话没有 title：不抛错，仍能按正文命中（这条以前会被整条漏掉）', () => {
  const legacy = { id: 'legacy-1', messages: [{ role: 'user', content: '部署脚本怎么跑' }] }
  const hit = searchHit(legacy, '部署')
  assert.ok(hit, '缺 title 的会话不该从搜索结果里消失')
  assert.equal(hit.title, '未命名会话')
  assert.equal(hit.workspace, null)
})

test('缺 messages 不抛错：标题命中照常返回', () => {
  const hit = searchHit({ id: 'x-1', title: '数据库迁移' }, '迁移')
  assert.equal(hit.hits, 1)
  assert.equal(hit.snippet, '数据库迁移')
})

test('messages 不是数组时不抛错，当作空历史', () => {
  const hit = searchHit({ id: 'x-2', title: 'abc', messages: 'oops' }, 'abc')
  assert.equal(hit.hits, 1)
})

test('messages 里混进 null / 非对象条目时跳过，不影响后面的条目', () => {
  const hit = searchHit({ id: 'x-3', title: 'z', messages: [null, 42, { content: '目标关键词' }] }, '目标关键词')
  assert.equal(hit.hits, 1)
})

test('没有 id 的会话不列出来：点开是空白，只会误导用户', () => {
  assert.equal(searchHit({ title: '有标题没 id' }, '标题'), null)
})

test('时间戳缺失或非法时补 0，不让排序变成 NaN', () => {
  const hit = searchHit({ id: 'x-4', title: 'abc' }, 'abc')
  assert.equal(hit.createdAt, 0)
  assert.equal(hit.updatedAt, 0)
  assert.ok(Number.isFinite(hit.createdAt))
})

test('空查询 / 纯空白 / 没命中都返回 null', () => {
  assert.equal(searchHit(base, ''), null)
  assert.equal(searchHit(base, '   '), null)
  assert.equal(searchHit(base, '不存在的词'), null)
  assert.equal(searchHit(null, 'abc'), null)
})

test('片段过长时截断，前部带省略号', () => {
  const long = `${'前'.repeat(80)}关键词${'后'.repeat(80)}`
  const hit = searchHit({ id: 'x-5', messages: [{ content: long }] }, '关键词')
  assert.match(hit.snippet, /^…/)
  assert.ok(hit.snippet.length < long.length)
})
