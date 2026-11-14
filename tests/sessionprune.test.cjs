const test = require('node:test')
const assert = require('node:assert')
const { pickPrunable, SESSION_KEEP_MAX, SESSION_KEEP_DAYS } = require('../dist/main/store.js')

const DAY = 864e5
const NOW = Date.UTC(2026, 10, 10)

function file(id, daysAgo, size = 1024) {
  return { id, mtime: NOW - daysAgo * DAY, size }
}

test('会话数量没到上限时一个都不动', () => {
  const files = [file('a', 400), file('b', 500), file('c', 600)]
  const picked = pickPrunable(files, { max: 300, maxAgeDays: 180, now: NOW })
  assert.deepEqual(picked, [])
})

test('超过上限但仍在保留期内：不动', () => {
  const files = []
  for (let i = 0; i < 30; i++) files.push(file(`s${i}`, i * 5))
  const picked = pickPrunable(files, { max: 20, maxAgeDays: 180, now: NOW })
  assert.deepEqual(picked, [])
})

test('超过上限且超期：只挑最老的那批', () => {
  const files = []
  // 25 个会话：前 20 个很老，后 5 个新
  for (let i = 0; i < 20; i++) files.push(file(`old${i}`, 400 + i))
  for (let i = 0; i < 5; i++) files.push(file(`new${i}`, i))
  const picked = pickPrunable(files, { max: 20, maxAgeDays: 180, now: NOW })
  assert.equal(picked.length, 5)
  // 最新的 20 个受保护，被挑中的全是最老的
  for (const p of picked) assert.ok(p.id.startsWith('old'), `${p.id} 不该被归档`)
})

test('最近 10 分钟内动过的绝不碰（可能正在写）', () => {
  const files = []
  for (let i = 0; i < 25; i++) files.push(file(`old${i}`, 400 + i))
  // 一个「很老但刚被写过」的会话：mtime 是现在
  files.push({ id: 'active', mtime: NOW - 60 * 1000, size: 2048 })
  const picked = pickPrunable(files, { max: 20, maxAgeDays: 180, now: NOW })
  assert.ok(!picked.some((p) => p.id === 'active'))
})

test('上限与保留期都有下限，传错值不会把会话删光', () => {
  const files = []
  for (let i = 0; i < 40; i++) files.push(file(`s${i}`, 500 + i))
  // max 传 0 会被抬到 20，保留期传 0 会被抬到 7 天
  const picked = pickPrunable(files, { max: 0, maxAgeDays: 0, now: NOW })
  assert.ok(picked.length <= 40 - 20, `最多只能归档 ${40 - 20} 个，实际 ${picked.length}`)
})

test('默认阈值足够宽松：正常使用不会触发', () => {
  assert.ok(SESSION_KEEP_MAX >= 200, '保留上限太低会误伤真实用户')
  assert.ok(SESSION_KEEP_DAYS >= 90, '保留天数太短会误伤真实用户')
})
