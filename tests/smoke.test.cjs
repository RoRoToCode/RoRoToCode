/**
 * 独立 smoke 断言：识别「字符串存在性检查冒充运行验证」的假测试。
 *
 * 起因：模型把 Playwright 下载卡住后，把真浏览器验收降级成一串 html.includes('xxx')
 * 检查，26 项全过但一行游戏都没跑，核心 bug 一个没抓到。这里钉住那条判据。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { assertSmoke, resolveTestTarget, detectVerifyPlan, stateCoverageGap } = require('../dist/main/verify.js')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'roroto-smoke-'))

test('纯 includes 存在性检查：existenceOnly=true', async () => {
  const dir = tmp()
  const f = path.join(dir, 'test_game.js')
  fs.writeFileSync(
    f,
    [
      "const fs = require('fs')",
      "const html = fs.readFileSync('index.html', 'utf8')",
      "if (html.includes('Three.js')) console.log('✓ 包含 Three.js')",
      "if (html.includes('canvas')) console.log('✓ 包含 canvas')",
      "if (html.includes('init()')) console.log('✓ 包含 init')"
    ].join('\n'),
    'utf8'
  )
  const r = await assertSmoke(f)
  assert.equal(r.existenceOnly, true, '只查字符串存在性，没有运行任何代码')
  assert.ok(r.suspicious.length >= 3)
})

test('真浏览器测试：existenceOnly=false', async () => {
  const dir = tmp()
  const f = path.join(dir, 'real_test.js')
  fs.writeFileSync(
    f,
    "const { chromium } = require('playwright')\n;(async()=>{const b=await chromium.launch();const p=await b.newPage();await p.goto('file:///index.html');await p.click('button');})()",
    'utf8'
  )
  const r = await assertSmoke(f)
  assert.equal(r.existenceOnly, false, '启动了浏览器、点了按钮，是真运行')
})

test('resolveTestTarget 从 scripts.test 抽出脚本文件', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'test_game.js'), 'x', 'utf8')
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'node test_game.js' } }),
    'utf8'
  )
  const t = await resolveTestTarget(dir)
  assert.equal(path.basename(t || ''), 'test_game.js')
})

test('detectVerifyPlan 对 npm test 打上 smoke 标记', async () => {
  const dir = tmp()
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'node test_game.js' } }),
    'utf8'
  )
  const plan = await detectVerifyPlan(dir, [])
  assert.ok(plan, '有 package.json 应给出验证计划')
  assert.equal(plan.smoke, true, '落到项目自带 npm test 时标记 smoke，供调用方做独立断言')
})

test('没有 marker 的轻量 Python 项目也要给出验证计划', async () => {
  const dir = tmp()
  // 围棋项目的最小形态：只有 main.py + .roroto/tmp/test_main.py
  fs.writeFileSync(path.join(dir, 'main.py'), 'print("hi")\n', 'utf8')
  fs.mkdirSync(path.join(dir, '.roroto', 'tmp'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.roroto', 'tmp', 'test_main.py'),
    'assert 1 + 1 == 2\nprint("ok")\n',
    'utf8'
  )
  const plan = await detectVerifyPlan(dir, ['main.py'])
  assert.ok(plan, '有 .py + test_*.py 就不该静默跳过自动验证')
  assert.match(plan.command, /test_main\.py/, '命令里应包含那个临时目录下的测试文件')
  assert.match(plan.command, /^python /)
  assert.equal(plan.testFile, '.roroto/tmp/test_main.py')
})

test('有 .py 但一个测试都没有：保持保守，不乱跑命令', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'main.py'), 'print("hi")\n', 'utf8')
  assert.equal(await detectVerifyPlan(dir, ['main.py']), null)
})

test('只有 tests/ 目录、没有 .py：不能当成 Python 项目', async () => {
  const dir = tmp()
  fs.mkdirSync(path.join(dir, 'tests'))
  fs.writeFileSync(path.join(dir, 'tests', 'a.js'), 'console.log(1)\n', 'utf8')
  assert.equal(await detectVerifyPlan(dir, []), null, '否则会在 JS 项目里跑 pytest')
})

test('requirements.txt 也算 Python marker', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'requirements.txt'), 'requests\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'main.py'), 'print("hi")\n', 'utf8')
  const plan = await detectVerifyPlan(dir, ['main.py'])
  assert.ok(plan)
  assert.match(plan.command, /pytest/)
})

test('Makefile 有 test 目标才用它', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'Makefile'), 'build:\n\tcc -o app main.c\n\ntest:\n\t./app --test\n', 'utf8')
  assert.equal((await detectVerifyPlan(dir, [])).command, 'make test')

  const dir2 = tmp()
  fs.writeFileSync(path.join(dir2, 'Makefile'), 'build:\n\tcc -o app main.c\n', 'utf8')
  assert.equal(await detectVerifyPlan(dir2, []), null, '没有 test/check 目标就不能乱跑')
})

test('覆盖度：GUI 项目只 import 不断言状态 → 给提示', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'ui.py'), 'import tkinter\n\nclass Board:\n    pass\n', 'utf8')
  fs.mkdirSync(path.join(dir, 'tests'))
  fs.writeFileSync(path.join(dir, 'tests', 'test_ui.py'), 'import ui\nassert hasattr(ui, "Board")\n', 'utf8')
  const gap = await stateCoverageGap(dir, ['ui.py'])
  assert.ok(gap, '应该提示核心状态没被覆盖')
  assert.match(gap, /状态/)
})

test('覆盖度：断言了轮次就不打扰', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'ui.py'), 'import tkinter\n\nclass Board:\n    pass\n', 'utf8')
  fs.mkdirSync(path.join(dir, 'tests'))
  fs.writeFileSync(
    path.join(dir, 'tests', 'test_ui.py'),
    'import ui\nb = ui.Board()\nassert b.turn == "black"\n',
    'utf8'
  )
  assert.equal(await stateCoverageGap(dir, ['ui.py']), null)
})

test('覆盖度：非 GUI 项目不打扰', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'calc.py'), 'def add(a, b):\n    return a + b\n', 'utf8')
  fs.mkdirSync(path.join(dir, 'tests'))
  fs.writeFileSync(path.join(dir, 'tests', 'test_calc.py'), 'import calc\nassert calc.add(1, 2) == 3\n', 'utf8')
  assert.equal(await stateCoverageGap(dir, ['calc.py']), null)
})
