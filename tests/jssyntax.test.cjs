const test = require('node:test')
const assert = require('node:assert')
const { promises: fs } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { checkJsSyntax, formatJsIssues } = require('../dist/main/jssyntax.js')

let dir

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roroto-jssyntax-'))
})

test.after(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

test('checkJsSyntax：语法正确返回空数组', async () => {
  const file = path.join(dir, 'ok.js')
  await fs.writeFile(file, 'function add(a, b) {\n  return a + b\n}\n', 'utf8')
  assert.deepEqual(await checkJsSyntax([file]), [])
})

test('checkJsSyntax：只认 .js/.mjs/.cjs，其它后缀忽略', async () => {
  const txt = path.join(dir, 'notes.txt')
  await fs.writeFile(txt, 'this is not js )))', 'utf8')
  const py = path.join(dir, 'bad.py')
  await fs.writeFile(py, 'def x(:', 'utf8')
  assert.deepEqual(await checkJsSyntax([txt, py]), [])
})

test('checkJsSyntax：语法错误返回文件+行号+摘要', async () => {
  const file = path.join(dir, 'bad.js')
  await fs.writeFile(file, 'const a = 1\nfor (;; {\n  console.log(a)\n', 'utf8')
  const issues = await checkJsSyntax([file])
  assert.ok(issues.length >= 1, '应该报至少一条')
  const first = issues[0]
  assert.strictEqual(first.file, file)
  assert.strictEqual(typeof first.line, 'number')
  assert.ok(first.line >= 1)
  assert.ok(first.message.length > 0)
  assert.strictEqual(first.cascaded, false)
})

test('checkJsSyntax：多处错误会挖空恢复，后续标 cascaded', async () => {
  const file = path.join(dir, 'multi.js')
  // 两处明显语法错误：缺括号 + 缺引号闭合
  await fs.writeFile(file, 'function f( {\n  return "unclosed\n', 'utf8')
  const issues = await checkJsSyntax([file])
  assert.ok(issues.length >= 1)
  if (issues.length > 1) {
    assert.strictEqual(issues[1].cascaded, true)
  }
})

test('checkJsSyntax：挖空恢复的第二条错误行号必须是源码行，不是 node 堆栈行（回归）', async () => {
  // 回归：临时文件曾因无扩展名而让 node --check 抛 ERR_UNKNOWN_FILE_EXTENSION，
  // parseNodeCheckError 把堆栈里的行号（几十~几百）当成源码行号回灌给模型 —— 假坐标。
  const file = path.join(dir, 'cascade-lines.js')
  // 三处独立语法错误，都在前几行；挖空第一条后应能报出后续错误
  await fs.writeFile(file, 'const a = ;\nfunction ok() { return 1 }\nconst b = ;\nlet c = ;\n', 'utf8')
  const issues = await checkJsSyntax([file])
  assert.ok(issues.length >= 2, `挖空恢复应报出至少 2 处错误，实际 ${issues.length}`)
  for (const it of issues) {
    // 源码只有 4 行；任何 > 4 的行号都说明解析到了 node 内部堆栈
    assert.ok(it.line >= 1 && it.line <= 4, `行号 ${it.line} 超出源码范围，疑似解析了 node 堆栈`)
    assert.match(it.message, /SyntaxError/, `错误消息应是 SyntaxError，实际: ${it.message}`)
  }
})

test('checkJsSyntax：文件不存在 / 空文件静默返回空', async () => {
  assert.deepEqual(await checkJsSyntax([path.join(dir, 'nope.js')]), [])
  const empty = path.join(dir, 'empty.js')
  await fs.writeFile(empty, '', 'utf8')
  assert.deepEqual(await checkJsSyntax([empty]), [])
})

test('formatJsIssues：包含「语法错误」和「行号」两个关键信息', () => {
  const ws = dir
  const file = path.join(dir, 'x.js')
  const text = formatJsIssues([{ file, line: 3, message: "SyntaxError: Unexpected token '}'" }], ws)
  assert.ok(text.includes('语法错误'))
  assert.ok(text.includes('x.js:3'))
  assert.ok(text.includes('SyntaxError'))
  assert.ok(text.includes('edit_file'), '应提示用 edit_file 精确替换而不是整份重写')
})
