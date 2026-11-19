/**
 * 写入粒度 + 分段追加 + HTML 脚本校验的单测。
 *
 * 这三条对应的是同一次真实事故：模型想一次性把整个跑酷游戏写进 index.html，
 * 每次都在半路被输出上限截断，于是反复重写 —— 77 条消息、6 万 token、
 * 换来一个 693 字节的残片，而内置诊断因为「工作区里没有 tsconfig」全程静默。
 *
 *  - 单次写入超限必须当场拒绝，并给出可执行的分段方案（不是一句「太大」）
 *  - append 让分段不需要锚点：9B 模型记不住上一段最后一行，只让它接着写才行
 *  - HTML 内联脚本要能被 node --check 查出语法错误，并折算回 html 里的真实行号
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { executeTool, previewWrite, MAX_SINGLE_WRITE_CHARS } = require('../dist/main/tools/index.js')
const { checkHtmlScripts, extractInlineScripts, parseNodeCheckError } = require('../dist/main/htmlcheck.js')
const { resetFileState } = require('../dist/main/filestate.js')

const ctx = (workspace, extra) => ({ workspace, signal: new AbortController().signal, ...extra })

function makeWs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roro-write-'))
  return dir
}

test('单次写入上限是个明确的数：16000 字符', () => {
  assert.equal(MAX_SINGLE_WRITE_CHARS, 16000)
})

test('超过上限的 write_file 被拒绝，且文件一个字都没动', async () => {
  resetFileState()
  const ws = makeWs()
  const target = path.join(ws, 'big.html')
  fs.writeFileSync(target, 'ORIGINAL', 'utf8')
  const huge = 'x'.repeat(MAX_SINGLE_WRITE_CHARS + 1)
  await assert.rejects(
    () => executeTool('write_file', { path: 'big.html', content: huge }, ctx(ws)),
    (err) => {
      assert.match(err.message, /超过单次写入上限/)
      // 拒绝必须给方案，否则模型只会原样重试
      assert.match(err.message, /append:true/)
      assert.match(err.message, /骨架/)
      return true
    }
  )
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL')
})

test('正好等于上限的写入照常放行', async () => {
  resetFileState()
  const ws = makeWs()
  const edge = 'y'.repeat(MAX_SINGLE_WRITE_CHARS)
  const out = await executeTool('write_file', { path: 'edge.txt', content: edge }, ctx(ws))
  assert.match(out, /已写入/)
  assert.equal(fs.readFileSync(path.join(ws, 'edge.txt'), 'utf8').length, MAX_SINGLE_WRITE_CHARS)
})

test('append 追加而不是覆盖', async () => {
  resetFileState()
  const ws = makeWs()
  await executeTool('write_file', { path: 'g.html', content: '<div>' }, ctx(ws))
  const out = await executeTool('write_file', { path: 'g.html', content: '</div>', append: true }, ctx(ws))
  assert.match(out, /已追加/)
  assert.equal(fs.readFileSync(path.join(ws, 'g.html'), 'utf8'), '<div></div>')
})

test('append 到不存在的文件等于新建（第一次就用 append 不该报错）', async () => {
  resetFileState()
  const ws = makeWs()
  await executeTool('write_file', { path: 'new/a.css', content: 'body{}', append: true }, ctx(ws))
  assert.equal(fs.readFileSync(path.join(ws, 'new/a.css'), 'utf8'), 'body{}')
})

test('append 也受同一个上限约束（不能换个参数就绕过去）', async () => {
  resetFileState()
  const ws = makeWs()
  await assert.rejects(
    () => executeTool('write_file', { path: 'x.txt', content: 'z'.repeat(MAX_SINGLE_WRITE_CHARS + 5), append: true }, ctx(ws)),
    /超过单次写入上限/
  )
})

test('审批预览必须和落盘一致：append 的 after 是「原文 + 片段」', async () => {
  resetFileState()
  const ws = makeWs()
  const file = path.join(ws, 'p.txt')
  fs.writeFileSync(file, 'AAA', 'utf8')
  const pv = await previewWrite('write_file', { path: 'p.txt', content: 'BBB', append: true }, ws)
  assert.equal(pv.before, 'AAA')
  assert.equal(pv.after, 'AAABBB')
  assert.equal(pv.kind, 'modify')
})

test('edit_file 的 new_string 超限被拒绝', async () => {
  resetFileState()
  const ws = makeWs()
  fs.writeFileSync(path.join(ws, 'e.js'), 'const a = 1\n', 'utf8')
  await executeTool('read_file', { path: 'e.js' }, ctx(ws))
  await assert.rejects(
    () =>
      executeTool(
        'edit_file',
        { path: 'e.js', old_string: 'const a = 1', new_string: 'q'.repeat(MAX_SINGLE_WRITE_CHARS + 1) },
        ctx(ws)
      ),
    /超过单次写入上限/
  )
  assert.equal(fs.readFileSync(path.join(ws, 'e.js'), 'utf8'), 'const a = 1\n')
})

test('抽内联脚本：跳过 src、跳过非 JS type、锚点行号正确', () => {
  const html = [
    '<!DOCTYPE html>', // 1
    '<html><head>', // 2
    '<script src="./a.js"></script>', // 3
    '<script type="application/json">{"a":1}</script>', // 4
    '<script>', // 5
    'const x = 1', // 6
    '</script>', // 7
    '</body></html>'
  ].join('\n')
  const blocks = extractInlineScripts(html)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].startLine, 6)
})

test('node --check 报错的行号能折算回 html 里的真实行号', async () => {
  const ws = makeWs()
  const file = path.join(ws, 'bad.html')
  fs.writeFileSync(
    file,
    ['<!DOCTYPE html>', '<html><body>', '<script>', 'const A = 1', 'const B = (2', 'for (let i = 0; i < 3; i++ {', '}', '</script>', '</body></html>'].join('\n'),
    'utf8'
  )
  const issues = await checkHtmlScripts([file])
  assert.ok(issues.length >= 1, '应该报出语法错误')
  // `for (` 在第 6 行
  assert.equal(issues[0].line, 6)
  assert.match(issues[0].message, /SyntaxError/)
})

test('语法正确的 html 一条都不报（外链与非 JS type 不误伤）', async () => {
  const ws = makeWs()
  const file = path.join(ws, 'good.html')
  fs.writeFileSync(
    file,
    [
      '<!DOCTYPE html><html><body>',
      '<script>const a = [1,2,3].map(x => x * 2); console.log(a)</script>',
      '<script type="application/json">{"a": 1}</script>',
      '<script src="./ext.js"></script>',
      '<script type="module">export const k = 1</script>',
      '</body></html>'
    ].join('\n'),
    'utf8'
  )
  assert.deepEqual(await checkHtmlScripts([file]), [])
})

test('非 html 文件不进入脚本校验', async () => {
  const ws = makeWs()
  const file = path.join(ws, 'a.js')
  fs.writeFileSync(file, 'const a = \n', 'utf8')
  assert.deepEqual(await checkHtmlScripts([file]), [])
})

test('parseNodeCheckError 能从上到下两种 stderr 里取出行号和摘要', () => {
  const a = parseNodeCheckError('C:\\tmp\\s0.js:7\n  for (;; {\n        ^\n\nSyntaxError: Unexpected token \'for\'\n')
  assert.equal(a.line, 7)
  assert.equal(a.message, "SyntaxError: Unexpected token 'for'")
  assert.equal(parseNodeCheckError('some random output'), null)
})

test('续写拼好的内容不受单次上限约束（否则救回来的内容会被扔掉）', async () => {
  resetFileState()
  const ws = makeWs()
  const { HEALED_ARGS } = require('../dist/shared/toolargs.js')
  const big = 'h'.repeat(MAX_SINGLE_WRITE_CHARS + 5000)
  const args = { path: 'healed.html', content: big }
  // 标记做成不可枚举，避免污染会话记录 / 审批载荷
  Object.defineProperty(args, HEALED_ARGS, { value: true, enumerable: false })
  assert.equal(JSON.stringify(args).includes('healedArgs'), false, '标记不能进 JSON')
  const out = await executeTool('write_file', args, ctx(ws))
  assert.match(out, /已写入/)
  assert.equal(fs.readFileSync(path.join(ws, 'healed.html'), 'utf8').length, big.length)
})
