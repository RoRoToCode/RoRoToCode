/**
 * shell 写源码拦截 + 变更驱动门禁 + HTML 多错报告的单元测试。
 *
 * 对应的是同一次真实事故的收尾三条：
 *  1. 模型用 `sed -i` / `python -c "open(...,'w')"` / `echo > index.html` 改源码，
 *     所有写入门禁（写入上限、语法校验、打开验收）一次都没经过；
 *  2. 于是「门禁生效了」只对 write_file 成立，换个写法就全线失效；
 *  3. htmlcheck 一次只报第一条错，一处一处地修要来回十几轮。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  detectShellWrite,
  snapshotSources,
  changedSources,
  shellWriteRefusal
} = require('../dist/main/shellguard.js')
const { checkHtmlScripts, blankLine } = require('../dist/main/htmlcheck.js')
const { executeTool } = require('../dist/main/tools/index.js')

function makeWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'roro-shell-'))
}
const ctx = (workspace) => ({ workspace, signal: new AbortController().signal })

test('sed -i 改源码算写文件', () => {
  const v = detectShellWrite("sed -i 's/红色/蓝色/' index.html")
  assert.equal(v.mutating, true)
  assert.ok(v.targets.includes('index.html'))
})

test('重定向到源码算写文件', () => {
  assert.equal(detectShellWrite('cat > index.html <<EOF').mutating, true)
  assert.equal(detectShellWrite('echo "<div></div>" >> index.html').mutating, true)
  assert.equal(detectShellWrite('printf x >  main.js').mutating, true)
})

test('python / node 内联写源码算写文件', () => {
  assert.equal(detectShellWrite(`python -c "open('index.html','w').write('x')"`).mutating, true)
  assert.equal(detectShellWrite(`node -e "require('fs').writeFileSync('game.js','x')"`).mutating, true)
})

test('拷贝覆盖源码算写文件', () => {
  assert.equal(detectShellWrite('cp /tmp/A.html index.html').mutating, true)
  assert.equal(detectShellWrite('mv new.css style.css').mutating, true)
})

test('PowerShell 写文件 cmdlet 算写文件', () => {
  assert.equal(detectShellWrite('Set-Content -Path index.html -Value "x"').mutating, true)
})

test('正常命令不误伤', () => {
  const quiet = [
    'npm run build',
    'node --test tests/',
    'ls -la',
    'grep -n foo index.html > /dev/null',
    'cat index.html | head -20',
    'python -c "print(1)" 2>&1',
    'npm run dev > build.log',
    'git status'
  ]
  for (const cmd of quiet) {
    assert.equal(detectShellWrite(cmd).mutating, false, `不该拦：${cmd}`)
  }
})

test('拒绝信息必须给出替代写法', () => {
  const msg = shellWriteRefusal(detectShellWrite('echo x > index.html'))
  assert.match(msg, /edit_file/)
  assert.match(msg, /write_file/)
  assert.match(msg, /index\.html/)
})

test('run_shell 里改源码当场拒绝，文件没被改', async () => {
  const ws = makeWs()
  const file = path.join(ws, 'index.html')
  fs.writeFileSync(file, '<html>原样</html>', 'utf8')
  let err = null
  try {
    await executeTool(
      'run_shell',
      { command: `printf '<html>被改了</html>' > ${file}` },
      ctx(ws)
    )
  } catch (e) {
    err = e
  }
  assert.ok(err, '应该抛错拒绝')
  assert.match(err.message, /已拒绝执行/)
  assert.equal(fs.readFileSync(file, 'utf8'), '<html>原样</html>')
})

test('快照能找出被 shell 改过的源码，并带回改前内容', async () => {
  const ws = makeWs()
  fs.writeFileSync(path.join(ws, 'a.js'), 'const a = 1', 'utf8')
  fs.writeFileSync(path.join(ws, 'keep.js'), 'const k = 1', 'utf8')
  const before = await snapshotSources(ws)
  fs.writeFileSync(path.join(ws, 'a.js'), 'const a = 2', 'utf8')
  fs.writeFileSync(path.join(ws, 'new.html'), '<html></html>', 'utf8')
  const changed = await changedSources(ws, before)
  const names = changed.map((c) => path.basename(c.file)).sort()
  assert.deepEqual(names, ['a.js', 'new.html'])
  const a = changed.find((c) => path.basename(c.file) === 'a.js')
  assert.equal(a.before, 'const a = 1')
  const created = changed.find((c) => path.basename(c.file) === 'new.html')
  assert.equal(created.before, null)
})

test('快照跳过 node_modules 与非源码文件', async () => {
  const ws = makeWs()
  fs.mkdirSync(path.join(ws, 'node_modules', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'node_modules', 'lib', 'x.js'), 'x', 'utf8')
  fs.writeFileSync(path.join(ws, 'run.log'), 'log', 'utf8')
  const snap = await snapshotSources(ws)
  assert.equal(snap.size, 0)
})

test('blankLine 只挖空目标行，行数不变', () => {
  const code = 'a\nb\nc'
  assert.equal(blankLine(code, 2), 'a\n\nc')
  assert.equal(blankLine(code, 2).split('\n').length, 3)
})

test('一次报出多处语法错误，且标明哪条是连带暴露的', async () => {
  const ws = makeWs()
  const html = [
    '<!doctype html>',
    '<html><body>',
    '<script>',
    'const a = 1',
    'function f() { return a }',
    'case 1:',
    'const b = 2',
    'let c = ;',
    '</script>',
    '</body></html>'
  ].join('\n')
  const file = path.join(ws, 'index.html')
  fs.writeFileSync(file, html, 'utf8')
  const issues = await checkHtmlScripts([file])
  assert.ok(issues.length >= 2, `应该报出多条，实际 ${issues.length}`)
  assert.equal(issues[0].line, 6)
  assert.equal(issues[0].cascaded, false)
  assert.ok(issues[1].line > 6)
  assert.equal(issues[1].cascaded, true)
})

test('语法正确的 html 一条都不报', async () => {
  const ws = makeWs()
  const file = path.join(ws, 'ok.html')
  fs.writeFileSync(
    file,
    ['<html><body>', '<script>', 'const a = 1', 'console.log(a)', '</script></body></html>'].join('\n'),
    'utf8'
  )
  assert.deepEqual(await checkHtmlScripts([file]), [])
})

test('unix 命令跑错 shell：给出换 bash / 等价命令的提示', { skip: process.platform !== 'win32' }, () => {
  const { shellMismatchHint } = require('../dist/main/tools/index.js')
  const hint = shellMismatchHint(
    'powershell',
    'echo x | tail -1',
    "tail : The term 'tail' is not recognized as a name of a cmdlet"
  )
  assert.match(hint, /unix 命令/, '应点明命令和 shell 不匹配')
  assert.match(hint, /"shell":"bash"/, '应给出换 bash 的写法')
  assert.match(hint, /Get-Content/, '应给出本机等价命令')
})

test('不该给提示的几种情况', { skip: process.platform !== 'win32' }, () => {
  const { shellMismatchHint } = require('../dist/main/tools/index.js')
  // 已经是 bash
  assert.equal(shellMismatchHint('bash', 'tail -1 f', 'not found'), '')
  // 命令在参数位置，不是每段的第一个词
  assert.equal(shellMismatchHint('powershell', 'python tail.py', 'CommandNotFoundException'), '')
  // 跟「命令不存在」无关的普通失败（装了 Git 的机器上 grep 能跑，只是文件不存在）
  assert.equal(shellMismatchHint('cmd', 'grep x missing.txt', 'File not found'), '')
  // cmd 里跑 dir 没问题是常识，不该被误判
  assert.equal(shellMismatchHint('cmd', 'dir', 'File Not Found'), '')
})

test('PowerShell 5.1 不认 && ：给出拆开执行的提示', { skip: process.platform !== 'win32' }, () => {
  const { shellMismatchHint } = require('../dist/main/tools/index.js')
  const hint = shellMismatchHint(
    'powershell',
    'npm run build && npm test',
    "ParserError: The token '&&' is not a valid statement separator in this version."
  )
  assert.match(hint, /不支持 `&&`/)
  assert.match(hint, /拆成两条/)
})

test('同一文件内容没变时，第二次 read_file 只回一句提示', async () => {
  const ws = makeWs()
  const file = path.join(ws, 'big.py')
  // 超过 READ_MEMO_MIN_CHARS（4000），否则不做去重
  fs.writeFileSync(file, Array.from({ length: 400 }, (_, i) => `line_${i} = ${i}`).join('\n'), 'utf8')
  const first = await executeTool('read_file', { path: 'big.py' }, ctx(ws))
  assert.match(first, /1→line_0/, '第一次应给全文')
  const second = await executeTool('read_file', { path: 'big.py' }, ctx(ws))
  assert.match(second, /没有变化/)
  assert.ok(second.length < first.length / 4, '第二次应该明显更短')
  const third = await executeTool('read_file', { path: 'big.py' }, ctx(ws))
  assert.match(third, /1→line_0/, '第三次必须还能拿到全文')
})

test('文件改过之后 read_file 立刻返回新内容', async () => {
  const ws = makeWs()
  const file = path.join(ws, 'big.py')
  fs.writeFileSync(file, Array.from({ length: 400 }, (_, i) => `v1_${i} = ${i}`).join('\n'), 'utf8')
  await executeTool('read_file', { path: 'big.py' }, ctx(ws))
  await executeTool('read_file', { path: 'big.py' }, ctx(ws))
  fs.writeFileSync(file, Array.from({ length: 400 }, (_, i) => `v2_${i} = ${i}`).join('\n'), 'utf8')
  const out = await executeTool('read_file', { path: 'big.py' }, ctx(ws))
  assert.match(out, /v2_0/, '内容变了就必须给新内容')
})
