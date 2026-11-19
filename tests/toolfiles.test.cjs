/**
 * 文件类工具的「能不能正常干活」单测。
 *
 * 这几条对应的是真实会话里反复出现的卡点：
 *  - read_file 不带行号 → 模型说不清改哪几行，offset 续读也算不准
 *  - 没读过就 edit → old_string 只能靠猜，猜错就重来
 *  - 读过之后文件被改过 → 手里的原文过期，仍然照旧替换
 *  - 路径写错（下划线打成空格）→ 只回一句 ENOENT，模型继续瞎猜
 *  - 命令输出从头截断 → 构建/测试的报错全丢，只能盲改重跑
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { executeTool, clipCommandOutput } = require('../dist/main/tools/index.js')
const { resetFileState } = require('../dist/main/filestate.js')

const ctx = (workspace, extra) => ({ workspace, signal: new AbortController().signal, ...extra })

function makeWs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roro-files-'))
  fs.writeFileSync(path.join(dir, 'app.js'), ['const a = 1', 'const b = 2', 'const c = 3', ''].join('\n'), 'utf8')
  fs.mkdirSync(path.join(dir, '22_33'))
  fs.writeFileSync(path.join(dir, '22_33', 'run_game.py'), 'print(1)\n', 'utf8')
  return dir
}

test('read_file 输出带行号', async () => {
  resetFileState()
  const ws = makeWs()
  const out = await executeTool('read_file', { path: 'app.js' }, ctx(ws))
  assert.match(out, /^1→const a = 1$/m)
  assert.match(out, /^3→const c = 3$/m)
})

test('read_file 截断时给总行数与续读 offset', async () => {
  resetFileState()
  const ws = makeWs()
  const out = await executeTool('read_file', { path: 'app.js' }, ctx(ws, { readCap: 40 }))
  assert.match(out, /已显示第 1-2 行，共 4 行/)
  assert.match(out, /offset=3/)
})

test('offset/limit 分段读：行号仍是文件里的真实行号', async () => {
  resetFileState()
  const ws = makeWs()
  const out = await executeTool('read_file', { path: 'app.js', offset: 2, limit: 2 }, ctx(ws))
  assert.match(out, /^2→const b = 2$/m)
  assert.match(out, /^3→const c = 3$/m)
  assert.doesNotMatch(out, /^1→/m)
})

test('没读过就 edit：拒绝并明确要求先读', async () => {
  resetFileState()
  const ws = makeWs()
  await assert.rejects(
    () => executeTool('edit_file', { path: 'app.js', old_string: 'const b = 2', new_string: 'const b = 9' }, ctx(ws)),
    /还没读过/
  )
})

test('读过之后 edit：宽松匹配也能落到正确行', async () => {
  resetFileState()
  const ws = makeWs()
  await executeTool('read_file', { path: 'app.js' }, ctx(ws))
  // old_string 少了缩进/行尾差异（这里用行尾空格模拟），仍然应该改第 2 行
  const out = await executeTool(
    'edit_file',
    { path: 'app.js', old_string: 'const b = 2   ', new_string: 'const b = 9' },
    ctx(ws)
  )
  assert.match(out, /第 2-2 行|第 2 行/)
  const after = fs.readFileSync(path.join(ws, 'app.js'), 'utf8')
  assert.match(after, /const b = 9/)
  assert.match(after, /const c = 3/, '后面的行不能被吃掉')
})

test('读过之后文件被改过：拒绝，要求重读', async () => {
  resetFileState()
  const ws = makeWs()
  const file = path.join(ws, 'app.js')
  await executeTool('read_file', { path: 'app.js' }, ctx(ws))
  // 模拟外部改动（用户手动编辑 / 另一个进程）
  fs.writeFileSync(file, 'const a = 0\nconst b = 2\n', 'utf8')
  await assert.rejects(
    () => executeTool('edit_file', { path: 'app.js', old_string: 'const b = 2', new_string: 'const b = 9' }, ctx(ws)),
    /被改过/
  )
})

test('路径写错：给出工作区里的相近文件，而不是裸 ENOENT', async () => {
  resetFileState()
  const ws = makeWs()
  await assert.rejects(
    () => executeTool('read_file', { path: '22 33/run_game.py' }, ctx(ws)),
    (err) => {
      assert.match(err.message, /工作区里这些文件名字最接近/)
      assert.match(err.message, /22_33\/run_game\.py/)
      return true
    }
  )
})

test('write_file 新建文件不需要先读', async () => {
  resetFileState()
  const ws = makeWs()
  const out = await executeTool('write_file', { path: 'new.js', content: 'x\n' }, ctx(ws))
  assert.match(out, /已写入/)
  assert.equal(fs.readFileSync(path.join(ws, 'new.js'), 'utf8'), 'x\n')
})

test('patch 的 update 同样要求先读', async () => {
  resetFileState()
  const ws = makeWs()
  await assert.rejects(
    () =>
      executeTool(
        'patch',
        { edits: [{ path: 'app.js', op: 'update', old_string: 'const c = 3', new_string: 'const c = 8' }] },
        ctx(ws)
      ),
    /还没读过/
  )
})

test('grep 到上限：明确说「还有更多」', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'roro-grepcap-'))
  const lines = Array.from({ length: 260 }, (_, i) => `hit ${i}`).join('\n')
  fs.writeFileSync(path.join(ws, 'many.txt'), lines, 'utf8')
  const out = await executeTool('grep', { pattern: 'hit' }, ctx(ws))
  assert.match(out, /已到 200 条上限/)
})

test('命令输出截断：保留尾部（报错在末尾）', () => {
  const body = Array.from({ length: 3000 }, (_, i) => `progress line ${i} ......`).join('\n')
  const text = `${body}\nERROR: cannot resolve module './x' at line 42`
  const out = clipCommandOutput(text, 2000)
  assert.ok(out.length < text.length, '必须真的截断')
  assert.match(out, /ERROR: cannot resolve module/, '尾部的报错必须留下')
  assert.match(out, /中间省略/)
})
