/**
 * grep 指向「单个文件」时必须真的去搜这个文件。
 *
 * 历史 bug：grepTool 一律走 walkFiles → fs.readdir(base)。base 是文件时 readdir
 * 抛 ENOTDIR 被 catch 吞掉，函数返回空列表 → 永远「没有匹配结果」。
 * 模型据此认定原文不存在，换 pattern 反复重试，白烧几十轮（真实会话里连试 4 次）。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { executeTool } = require('../dist/main/tools/index.js')

const ctx = (workspace) => ({ workspace, signal: new AbortController().signal })

function makeWs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roro-grep-'))
  fs.writeFileSync(
    path.join(dir, 'game.js'),
    ['const GROUND_Y = 100;', 'player.y = GROUND_Y - player.h; // clamp (defensive)', 'done();'].join('\n'),
    'utf8'
  )
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'sub', 'other.js'), 'const GROUND_Y = 1;\n', 'utf8')
  return dir
}

test('grep 指向单个文件：能搜到，而不是永远「没有匹配结果」', async () => {
  const ws = makeWs()
  const out = await executeTool('grep', { pattern: 'defensive', path: 'game.js' }, ctx(ws))
  assert.ok(out.includes('defensive'), `应该在 game.js 里匹配到 defensive，实际返回：${out}`)
  assert.ok(out.includes('game.js:2'), `应带行号 game.js:2，实际：${out}`)
})

test('grep 指向单个文件：结果里不应混进同目录其它文件', async () => {
  const ws = makeWs()
  const out = await executeTool('grep', { pattern: 'GROUND_Y', path: 'game.js' }, ctx(ws))
  assert.ok(out.includes('game.js'), out)
  assert.ok(!out.includes('other.js'), `点名只搜 game.js 时不该搜 sub/other.js，实际：${out}`)
})

test('grep 指向目录：仍然递归搜', async () => {
  const ws = makeWs()
  const out = await executeTool('grep', { pattern: 'GROUND_Y', path: '.' }, ctx(ws))
  assert.ok(out.includes('game.js'), out)
  assert.ok(out.includes('other.js'), `目录模式应递归到 sub/，实际：${out}`)
})

test('grep 路径不存在：明确报错，不能说成「没有匹配结果」', async () => {
  const ws = makeWs()
  await assert.rejects(
    () => executeTool('grep', { pattern: 'x', path: 'nope.js' }, ctx(ws)),
    /路径不存在/,
    '路径写错时要让模型知道是路径问题'
  )
})
