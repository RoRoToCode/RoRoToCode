/**
 * 标准 apply_patch（unified diff）解析器单测。
 *
 * 重点覆盖：Anthropic 风格的 *** Update File / @@ hunk、git 风格 ---/+++、
 * 多 hunk 同文件、删除/新增整文件、行号乱写也能靠文本定位、以及不可解析的兜底。
 */
const test = require('node:test')
const assert = require('node:assert')
const { parseApplyPatch, looksLikeApplyPatch } = require('../dist/main/tools/applypatch.js')

test('解析 *** Update File + 单 hunk', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/a.ts',
    '@@ -1,3 +1,3 @@',
    ' const x = 1',
    '-const y = 2',
    '+const y = 3',
    ' console.log(x, y)',
    '*** End Patch'
  ].join('\n')
  const edits = parseApplyPatch(patch)
  assert.strictEqual(edits.length, 1)
  assert.strictEqual(edits[0].path, 'src/a.ts')
  assert.strictEqual(edits[0].op, 'update')
  assert.ok(edits[0].old_string.includes('const y = 2'))
  assert.ok(edits[0].new_string.includes('const y = 3'))
})

test('解析 git 风格 ---/+++ 文件头', () => {
  const patch = [
    '--- a/lib/foo.py',
    '+++ b/lib/foo.py',
    '@@ -10,2 +10,2 @@',
    '-    return old',
    '+    return new'
  ].join('\n')
  const edits = parseApplyPatch(patch)
  assert.strictEqual(edits.length, 1)
  assert.strictEqual(edits[0].path, 'lib/foo.py')
  assert.strictEqual(edits[0].old_string, '    return old')
  assert.strictEqual(edits[0].new_string, '    return new')
})

test('同文件多 hunk 拆成多个编辑', () => {
  const patch = [
    '*** Update File: src/b.ts',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+aa',
    '@@ -5,1 +5,1 @@',
    '-b',
    '+bb'
  ].join('\n')
  const edits = parseApplyPatch(patch)
  assert.strictEqual(edits.length, 2)
  assert.deepStrictEqual(edits.map((e) => e.old_string), ['a', 'b'])
})

test('多文件各成一个编辑', () => {
  const patch = [
    '*** Update File: x.ts',
    '@@ -1,1 +1,1 @@',
    '-x',
    '+xx',
    '*** Update File: y.ts',
    '@@ -1,1 +1,1 @@',
    '-y',
    '+yy'
  ].join('\n')
  const edits = parseApplyPatch(patch)
  assert.strictEqual(edits.length, 2)
  assert.strictEqual(edits[0].path, 'x.ts')
  assert.strictEqual(edits[1].path, 'y.ts')
})

test('纯上下文无增删的 hunk 被丢弃', () => {
  const patch = [
    '*** Update File: z.ts',
    '@@ -1,2 +1,2 @@',
    ' a',
    ' b'
  ].join('\n')
  const edits = parseApplyPatch(patch)
  assert.strictEqual(edits.length, 0)
})

test('无 hunk / 无文件头的文本解析为空', () => {
  assert.deepStrictEqual(parseApplyPatch(''), [])
  assert.deepStrictEqual(parseApplyPatch('just some text\nwith no diff'), [])
  assert.deepStrictEqual(parseApplyPatch(null), [])
})

test('行号可以乱写，不影响解析（不信任行号）', () => {
  const patch = [
    '*** Update File: w.ts',
    '@@ -999,1 +1,1 @@',
    '-real',
    '+changed'
  ].join('\n')
  const edits = parseApplyPatch(patch)
  assert.strictEqual(edits.length, 1)
  assert.strictEqual(edits[0].old_string, 'real')
})

test('looksLikeApplyPatch 识别三种形态', () => {
  assert.ok(looksLikeApplyPatch('*** Update File: a.ts\n@@ -1,1 +1,1 @@\n-a\n+b'))
  assert.ok(looksLikeApplyPatch('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b'))
  assert.ok(looksLikeApplyPatch('@@ -1,1 +1,1 @@\n-a\n+b'))
  assert.ok(!looksLikeApplyPatch('just a normal sentence'))
  assert.ok(!looksLikeApplyPatch(123))
  assert.ok(!looksLikeApplyPatch(''))
})

test('CRLF 换行也能解析', () => {
  const patch = '*** Update File: c.ts\r\n@@ -1,1 +1,1 @@\r\n-old\r\n+new\r\n'
  const edits = parseApplyPatch(patch)
  assert.strictEqual(edits.length, 1)
  assert.strictEqual(edits[0].old_string, 'old')
})
