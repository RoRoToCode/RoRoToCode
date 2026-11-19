/**
 * 打开验收的活性判定。
 *
 * 起因是一次实测：7 个产物语法全过、控制台全干净，其中 2 个是死的
 * （一个 init() 从没被调用、画布 0 像素；一个球画出来但完全静止）。
 * 这类失败不抛错、不白屏，只「安静地什么都不做」，只能靠探针抓。
 *
 * 这些测试钉住的是「什么时候判死」和「什么时候不许判死」——
 * 判错方向的代价不对称：漏判会让死的产物过关，误判会让模型去修一个并不存在的问题。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  decideAlive,
  checkWebPages,
  formatWebCheck,
  hasBlockingFailure,
  EMPTY_CANVAS_ERROR,
  NO_RESPONSE_ERROR
} = require('../dist/main/webcheck.js')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'roroto-alive-'))

test('canvas 上一个像素都没有：判死，并点名「漏了初始化调用」', () => {
  const v = decideAlive({ canvasCount: 1, pixels: 0, animated: true, interactive: true })
  assert.equal(v.alive, false)
  assert.equal(v.error, EMPTY_CANVAS_ERROR)
  assert.match(v.error, /init\(\)/)
})

test('画了东西、但少得可怜：也算空（一个光标点不该算画了）', () => {
  const v = decideAlive({ canvasCount: 1, pixels: 5, animated: false, interactive: true })
  assert.equal(v.alive, false)
})

test('有画面 + rAF 在跳：直接判活，不用再模拟输入', () => {
  const v = decideAlive({ canvasCount: 1, pixels: 80000, animated: true, interactive: true })
  assert.equal(v.alive, true)
  assert.equal(v.needsNudge, undefined, '已经在动就别再花时间测输入')
})

test('画面静止、源码也绑了交互：要先模拟一轮输入才下结论', () => {
  const v = decideAlive({ canvasCount: 1, pixels: 57600, animated: false, interactive: true })
  assert.equal(v.needsNudge, true)
  assert.equal(v.alive, undefined, '还没测就不能先判死')
})

test('画面静止、源码里没有任何事件：静态图，不判定', () => {
  const v = decideAlive({ canvasCount: 1, pixels: 57600, animated: false, interactive: false })
  assert.equal(v.alive, undefined)
  assert.equal(v.needsNudge, undefined)
  assert.equal(v.error, undefined, '「画一张静态图」是合法产物，不许判死')
})

test('模拟输入后画面变了：判活', () => {
  const v = decideAlive({ canvasCount: 1, pixels: 57600, animated: false, interactive: true, changed: true })
  assert.equal(v.alive, true)
  assert.equal(v.error, undefined)
})

test('模拟输入后毫无变化：判死，并指出定时器/键名两类原因', () => {
  const v = decideAlive({ canvasCount: 1, pixels: 57600, animated: false, interactive: true, changed: false })
  assert.equal(v.alive, false)
  assert.equal(v.error, NO_RESPONSE_ERROR)
  assert.match(v.error, /e\.key/)
})

test('页面没有 canvas：不判定（表单、文档页不该被这套规则管）', () => {
  const v = decideAlive({ canvasCount: 0, pixels: 0, animated: true, interactive: true })
  assert.equal(v.alive, undefined)
  assert.equal(v.error, undefined)
})

// --- WebGL 画布：读不到像素 ≠ 画布是空的 -------------------------------
// 起因：three.js / 任何 WebGL 页面在打开验收里一律被判「画布是空的」。
// 根因是一个 canvas 只能有一种 context，对已经绑定 webgl 的画布再调
// getContext('2d') 必然返回 null，于是像素数恒为 0。
// 这组测试钉住「测量失败不许当成证据」，也钉住修复后不许把真·空画布放过去。

test('WebGL 画布读不到像素时，不许以「画布是空的」判死', () => {
  const v = decideAlive({
    canvasCount: 1,
    pixels: 0,
    animated: false,
    interactive: true,
    glUnreadable: 1
  })
  assert.equal(v.alive, undefined, '读不到像素只能不判定，不能判死')
  assert.equal(v.error, undefined, '不许报 EMPTY_CANVAS_ERROR')
  assert.equal(v.needsNudge, undefined, '像素都读不到，再模拟输入也证明不了什么')
})

test('WebGL 画布读不到像素但动画在跳：判活', () => {
  const v = decideAlive({
    canvasCount: 1,
    pixels: 0,
    animated: true,
    interactive: true,
    glUnreadable: 1
  })
  assert.equal(v.alive, true, 'rAF 在跳就是活着的直接证据')
  assert.equal(v.error, undefined)
})

test('WebGL 画布采样成功、确实是空的：仍然判死（修复不能把真问题放过去）', () => {
  const v = decideAlive({
    canvasCount: 1,
    pixels: 0,
    animated: false,
    interactive: true,
    glUnreadable: 0
  })
  assert.equal(v.alive, false)
  assert.equal(v.error, EMPTY_CANVAS_ERROR)
})

test('2D 画布 + 0 像素仍按原规则判死（WebGL 的豁免不能外溢）', () => {
  const v = decideAlive({ canvasCount: 1, pixels: 0, animated: true, interactive: true, glUnreadable: 0 })
  assert.equal(v.alive, false)
  assert.equal(v.error, EMPTY_CANVAS_ERROR)
})

test('失败的活性错误会让这一步被挡住', () => {
  const dir = tmp()
  const results = [
    {
      file: path.join(dir, 'snake.html'),
      ok: false,
      errors: [EMPTY_CANVAS_ERROR],
      warnings: 0,
      probe: { readyState: 'complete', canvasCount: 1, pixels: 0, painted: false, animated: true, alive: false }
    }
  ]
  assert.equal(hasBlockingFailure(results), true)
  const text = formatWebCheck(results, dir)
  assert.match(text, /【打开验收·未通过】snake\.html/)
  assert.match(text, /没有真正跑起来/)
  assert.match(text, /画布是空的/)
  assert.match(text, /不能算完成/)
})

test('通过时把「对模拟操作有响应」也讲出来', () => {
  const dir = tmp()
  const results = [
    {
      file: path.join(dir, 'ball.html'),
      ok: true,
      errors: [],
      warnings: 0,
      probe: {
        readyState: 'complete',
        canvasCount: 1,
        pixels: 443,
        painted: true,
        animated: false,
        alive: true,
        responded: true
      }
    }
  ]
  const text = formatWebCheck(results, dir)
  assert.match(text, /画布已绘制/)
  assert.match(text, /对模拟操作有响应/)
  assert.equal(hasBlockingFailure(results), false)
})

test('非 Electron 环境：不许把「没查」当成「没通过」', async () => {
  const dir = tmp()
  const file = path.join(dir, 'a.html')
  fs.writeFileSync(file, '<canvas></canvas>', 'utf8')
  const results = await checkWebPages([file])
  assert.equal(results[0].skipped, 'no-electron')
  assert.equal(results[0].ok, true)
  assert.equal(hasBlockingFailure(results), false)
  assert.equal(formatWebCheck(results, dir), '')
})

test('一次最多验 8 个：超出的不会静默排队，也不会越界', async () => {
  const dir = tmp()
  const files = []
  for (let i = 0; i < 11; i++) {
    const f = path.join(dir, `p${i}.html`)
    fs.writeFileSync(f, '<canvas></canvas>', 'utf8')
    files.push(f)
  }
  const results = await checkWebPages(files)
  assert.equal(results.length, 8)
})

test('视觉闭环：截图路径会写进报告，并提醒模型看图核对布局', () => {
  const dir = tmp()
  const results = [
    {
      file: path.join(dir, 'page.html'),
      ok: true,
      errors: [],
      warnings: 0,
      shot: '.roroto/shots/page-abc.png',
      probe: {
        readyState: 'complete',
        canvasCount: 1,
        pixels: 500,
        painted: true,
        animated: true,
        alive: true
      }
    }
  ]
  const text = formatWebCheck(results, dir)
  assert.match(text, /已截图：\.roroto\/shots\/page-abc\.png/)
  assert.match(text, /read_file 打开截图/)
  assert.match(text, /布局/)
})

test('视觉闭环：未通过时也带上截图，让模型看到实际画面', () => {
  const dir = tmp()
  const results = [
    {
      file: path.join(dir, 'bad.html'),
      ok: false,
      errors: [EMPTY_CANVAS_ERROR],
      warnings: 0,
      shot: '.roroto/shots/bad-xyz.png',
      probe: {
        readyState: 'complete',
        canvasCount: 1,
        pixels: 0,
        painted: false,
        animated: false,
        alive: false
      }
    }
  ]
  const text = formatWebCheck(results, dir)
  assert.match(text, /已截图：\.roroto\/shots\/bad-xyz\.png/)
  assert.match(text, /看实际样子/)
})
