/**
 * 工作区卫生：收工时清理一次性脚本与缓存目录。
 *
 * 这些用例守的是三条底线，任何一条破了都算严重回归：
 *  1. 用户的真实源码（app.py / runtime.ts / main.js / general.ts）绝不能被当成临时脚本；
 *  2. 本轮之前就存在的文件绝不能被搬走（判据是 mtime）；
 *  3. 被成果引用的脚本不能被搬走，且搬走的文件必须还能在 .roroto/trash 里找到。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { isScratchScript, isScratchPath, sweepWorkspace, formatSweep } = require('../dist/main/hygiene.js')

function makeWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'roro-hyg-'))
}

/** 把文件时间推到过去，模拟「用户早就有的文件」 */
function ageFile(file, minutesAgo) {
  const t = new Date(Date.now() - minutesAgo * 60_000)
  fs.utimesSync(file, t, t)
}

function write(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

test('一次性脚本的判据：认得出临时名，认不出真源码', () => {
  const scratch = [
    'gen.py',
    'validate_about.py',
    '_check.py',
    'verify_ttt.js',
    'fix_snake.py',
    'check.js',
    'tmp_scan.py',
    'verify2.js',
    'convert.mjs',
    'dump.html.py'
  ]
  for (const name of scratch) assert.equal(isScratchScript(name), true, `${name} 应当是一次性脚本`)

  const real = [
    'index.html',
    'snake.html',
    'style.css',
    'app.py',
    'runtime.ts',
    'general.ts',
    'main.js',
    'server.py',
    'package.json',
    'README.md',
    'run_task.py',
    'checkout.ts'
  ]
  for (const name of real) assert.equal(isScratchScript(name), false, `${name} 不该被当成临时脚本`)
})

test('本轮新建的临时脚本被搬进 .roroto/trash，内容不丢', async () => {
  const ws = makeWs()
  const since = Date.now()
  write(path.join(ws, 'index.html'), '<html>ok</html>')
  write(path.join(ws, 'gen.py'), 'print("hi")')

  const r = await sweepWorkspace(ws, since)
  assert.deepEqual(r.moved, ['gen.py'])
  assert.ok(r.trashDir && r.trashDir.startsWith('.roroto/trash/'))
  assert.equal(fs.existsSync(path.join(ws, 'gen.py')), false)
  const kept = path.join(ws, ...r.trashDir.split('/'), 'gen.py')
  assert.equal(fs.readFileSync(kept, 'utf8'), 'print("hi")')
  // 成果一个字节都不该动
  assert.equal(fs.readFileSync(path.join(ws, 'index.html'), 'utf8'), '<html>ok</html>')
})

test('本轮之前就存在的文件不动（mtime 判据）', async () => {
  const ws = makeWs()
  write(path.join(ws, 'validate_old.py'), 'old')
  ageFile(path.join(ws, 'validate_old.py'), 120)

  const r = await sweepWorkspace(ws, Date.now())
  assert.deepEqual(r.moved, [])
  assert.equal(fs.existsSync(path.join(ws, 'validate_old.py')), true)
})

test('被成果引用的脚本不动', async () => {
  const ws = makeWs()
  const since = Date.now()
  // 生成脚本被 README 提到：那是项目的一部分，不是一次性垃圾
  write(path.join(ws, 'README.md'), '跑 `python gen_site.py` 可以重新生成站点')
  write(path.join(ws, 'gen_site.py'), 'print(1)')

  const r = await sweepWorkspace(ws, since)
  assert.deepEqual(r.moved, [])
  assert.equal(fs.existsSync(path.join(ws, 'gen_site.py')), true)
})

test('__pycache__ 这类缓存目录直接删掉', async () => {
  const ws = makeWs()
  write(path.join(ws, '__pycache__', 'gen.cpython-311.pyc'), 'bytecode')
  write(path.join(ws, 'index.html'), '<html></html>')

  const r = await sweepWorkspace(ws, Date.now())
  assert.deepEqual(r.removedDirs, ['__pycache__'])
  assert.equal(fs.existsSync(path.join(ws, '__pycache__')), false)
})

test('node_modules / .git / .roroto 一律不进', async () => {
  const ws = makeWs()
  write(path.join(ws, 'node_modules', 'fix_dep.js'), 'x')
  write(path.join(ws, '.roroto', 'trash', 'old', 'gen.py'), 'x')
  write(path.join(ws, '.git', 'check.py'), 'x')

  const r = await sweepWorkspace(ws, Date.now())
  assert.deepEqual(r.moved, [])
  assert.equal(fs.existsSync(path.join(ws, 'node_modules', 'fix_dep.js')), true)
  assert.equal(fs.existsSync(path.join(ws, '.roroto', 'trash', 'old', 'gen.py')), true)
})

test('子目录里的临时脚本也会被处理，并保留相对路径', async () => {
  const ws = makeWs()
  const since = Date.now()
  write(path.join(ws, 'tmp', 'probe.py'), 'x')

  const r = await sweepWorkspace(ws, since)
  assert.deepEqual(r.moved, ['tmp/probe.py'])
  assert.equal(fs.existsSync(path.join(ws, 'tmp', 'probe.py')), false)
  assert.ok(fs.existsSync(path.join(ws, ...r.trashDir.split('/'), 'tmp', 'probe.py')))
})

test('放进 tmp/ 的脚本即使名字不规整也算一次性产物，空了就连目录一起收走', async () => {
  const ws = makeWs()
  const since = Date.now()
  write(path.join(ws, 'index.html'), '<html></html>')
  write(path.join(ws, 'tmp', 'test_ttt_logic.js'), 'x')
  write(path.join(ws, 'tmp', 'scratchpad.mjs'), 'x')

  const r = await sweepWorkspace(ws, since)
  assert.deepEqual(r.moved.sort(), ['tmp/scratchpad.mjs', 'tmp/test_ttt_logic.js'])
  // 目录空了要一并消失，否则交付目录里还挂着一个空 tmp/
  assert.equal(fs.existsSync(path.join(ws, 'tmp')), false)
  assert.equal(fs.existsSync(path.join(ws, 'index.html')), true)
})

test('非临时目录里名字规整的文件不受影响', () => {
  assert.equal(isScratchPath('tmp/whatever.js'), true)
  assert.equal(isScratchPath('src/util.ts'), false)
  assert.equal(isScratchPath('src/general.ts'), false)
  assert.equal(isScratchPath('lib/runtime.js'), false)
  assert.equal(isScratchPath('gen.py'), true)
})

test('体积过大的脚本不当成临时文件（避免搬走真程序）', async () => {
  const ws = makeWs()
  const big = 'x'.repeat(600 * 1024)
  write(path.join(ws, 'gen.py'), big)

  const r = await sweepWorkspace(ws, Date.now())
  assert.deepEqual(r.moved, [])
  assert.equal(fs.existsSync(path.join(ws, 'gen.py')), true)
})

test('什么都没清时提示为空，清了会说清去向', async () => {
  const ws = makeWs()
  write(path.join(ws, 'index.html'), 'x')
  const quiet = await sweepWorkspace(ws, Date.now())
  assert.equal(formatSweep(quiet), '')

  write(path.join(ws, 'gen.py'), 'x')
  const loud = await sweepWorkspace(ws, Date.now())
  const note = formatSweep(loud)
  assert.match(note, /\.roroto\/trash\//)
  assert.match(note, /gen\.py/)
  assert.match(note, /没有删除/)
})
