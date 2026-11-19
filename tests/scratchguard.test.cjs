const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createScratchGuard,
  isScratchScript,
  dirKey
} = require('../dist/shared/toolguard.js')

/**
 * 这些用例来自一次真实复现：9B 模型做一个 HTML 小游戏，89 次写盘里 47 次是临时脚本
 * （`_tmp_fix.js` 23 次、`_tmp_inspect.js` 12 次、`_tmp_check.py` 9 次），真实文件只动了 8 个。
 * 签名护栏拦不到它 —— 每次名字和内容都变，签名次次不同。
 */

test('临时脚本识别：只认脚本类扩展名，且名字真的像 tmp/temp/scratch', () => {
  for (const f of ['_tmp_fix.js', 'tmp.py', '_tmp_check.py', 'temp_check.sh', 'scratch.mjs', 'tmp.js']) {
    assert.equal(isScratchScript(f), true, f)
  }
  // 常见正名不该被误判成临时脚本
  for (const f of ['template.js', 'tempest.py', 'game.js', 'flappy_bird.html', 'README.md', 'tmp.json']) {
    assert.equal(isScratchScript(f), false, f)
  }
})

test('目录键归一化：反斜杠与正斜杠、大小写算同一处', () => {
  assert.equal(dirKey('C:\\proj\\game\\a.js'), dirKey('c:/proj/game/b.js'))
  assert.equal(dirKey('a.js'), '')
})

test('同一目录允许第一个临时脚本，换名字新建第二个直接拦', () => {
  const g = createScratchGuard()
  assert.equal(g.check('write_file', { path: 'game/_tmp_fix.js' }).verdict, 'ok')
  g.record('write_file', { path: 'game/_tmp_fix.js' })
  // 第二个换了名字：签名护栏看不到，这里必须拦住
  const d = g.check('write_file', { path: 'game/_tmp_inspect.js' })
  assert.equal(d.verdict, 'block')
  assert.match(d.note, /_tmp_fix\.js/)
  assert.match(d.note, /edit_file/)
})

test('同名重写放行：那是在改自己刚写的那个脚本', () => {
  const g = createScratchGuard()
  g.record('write_file', { path: 'game/_tmp_fix.js' })
  assert.equal(g.check('write_file', { path: 'game/_tmp_fix.js' }).verdict, 'ok')
  assert.equal(g.check('edit_file', { path: 'game/_tmp_fix.js' }).verdict, 'ok')
})

test('不同目录互不影响：临时目录里的脚本不该牵连工作区', () => {
  const g = createScratchGuard()
  g.record('write_file', { path: 'game/_tmp_fix.js' })
  assert.equal(g.check('write_file', { path: '/tmp/_tmp_other.js' }).verdict, 'ok')
  assert.equal(g.check('write_file', { path: 'game/src/probe.js' }).verdict, 'ok')
  // check 不记账：只有真执行过的脚本才占名额
  assert.equal(g.size(), 1)
})

test('只判单文件写工具：patch / run_shell 不参与', () => {
  const g = createScratchGuard()
  g.record('write_file', { path: 'game/_tmp_fix.js' })
  // patch 一次可能改多个文件，路径不在 args.path 里
  assert.equal(g.check('patch', { path: 'game/_tmp_second.js' }).verdict, 'ok')
  assert.equal(g.check('run_shell', { command: 'node _tmp_x.js' }).verdict, 'ok')
  // 真实文件永远放行
  assert.equal(g.check('write_file', { path: 'game/flappy_bird.html' }).verdict, 'ok')
})
