/**
 * 按步推进门禁 + 打开验收的单测。
 *
 * 这两件事绑在一起才成立：
 *  - 光有计划切片，模型照样能把没跑起来的活标成完成（它不需要任何证据）
 *  - 光有验收，模型可以验完不理，继续往下标
 *
 * 所以这里既测「跳项/抢跑被拒」，也测「验收失败时不许收工」，
 * 以及验收模块在非 Electron 环境下必须优雅降级 —— 单测跑在普通 node 里，
 * 它不能因为拿不到 BrowserWindow 就抛错，否则整条测试链会被一个环境问题带塌。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { todoGate, normalizeTodos } = require('../dist/shared/todos.js')
const { checkWebPages, formatWebCheck, hasBlockingFailure } = require('../dist/main/webcheck.js')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'roroto-gate-'))

test('按顺序完成会被接受', () => {
  const prev = [
    { content: 'v1 打开是一块能移动的方块', status: 'in_progress' },
    { content: 'v2 能跳起来', status: 'pending' }
  ]
  const next = [
    { content: 'v1 打开是一块能移动的方块', status: 'completed' },
    { content: 'v2 能跳起来', status: 'in_progress' }
  ]
  assert.equal(todoGate(prev, next).ok, true)
})

test('跳项标完成会被拒绝，并指名是第几项', () => {
  const prev = [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'pending' },
    { content: 'c', status: 'pending' }
  ]
  const next = [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'pending' },
    { content: 'c', status: 'completed' }
  ]
  const v = todoGate(prev, next)
  assert.equal(v.ok, false)
  assert.match(v.reason, /第 1 项/)
  assert.match(v.reason, /第 3 项/)
  assert.ok(v.hint && v.hint.length > 10, '要给出可执行的下一步，不能只说「不允许」')
})

test('同时推进两项会被拒绝', () => {
  const next = [
    { content: 'a', status: 'pending' },
    { content: 'b', status: 'in_progress' }
  ]
  const v = todoGate([], next)
  assert.equal(v.ok, false)
  assert.match(v.reason, /只能推进一项/)
})

test('验收没过时不许把活标成完成', () => {
  const blocking = new Map([['index.html', 'Uncaught ReferenceError: Player is not defined']])
  const prev = [{ content: 'v1 方块能移动', status: 'in_progress' }]
  const next = [{ content: 'v1 方块能移动', status: 'completed' }]
  const v = todoGate(prev, next, blocking)
  assert.equal(v.ok, false)
  assert.match(v.reason, /index\.html/)
  assert.match(v.reason, /打开时报错/)
})

test('验收没过，但这一步没有新增完成项，就不拦', () => {
  const blocking = new Map([['index.html', 'boom']])
  const prev = [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'pending' }
  ]
  const next = [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'pending' }
  ]
  assert.equal(todoGate(prev, next, blocking).ok, true, '拦的是「虚报完成」，不是「带着报错继续修」')
})

test('验收通过后（blocking 清空）可以正常收工', () => {
  const prev = [{ content: 'a', status: 'in_progress' }]
  const next = [{ content: 'a', status: 'completed' }]
  assert.equal(todoGate(prev, next, new Map()).ok, true)
})

test('清空计划放行', () => {
  assert.equal(todoGate([{ content: 'a', status: 'in_progress' }], []).ok, true)
})

test('normalizeTodos 仍然只留一个 in_progress', () => {
  const items = normalizeTodos([
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'in_progress' }
  ])
  assert.equal(items.filter((i) => i.status === 'in_progress').length, 1)
})

test('非 Electron 环境下验收降级为 skipped，不算失败', async () => {
  const dir = tmp()
  const file = path.join(dir, 'index.html')
  fs.writeFileSync(file, '<!DOCTYPE html><html><body><script>1</script></body></html>', 'utf8')
  const results = await checkWebPages([file])
  assert.equal(results.length, 1)
  assert.equal(results[0].skipped, 'no-electron')
  assert.equal(results[0].ok, true, 'skipped 不能当成通过，也不能当成不通过')
  assert.equal(hasBlockingFailure(results), false)
  assert.equal(formatWebCheck(results, dir), '', 'skipped 时一个字都不该说')
})

test('非 html 文件不进入验收', async () => {
  const dir = tmp()
  const file = path.join(dir, 'a.js')
  fs.writeFileSync(file, 'const a = 1', 'utf8')
  assert.deepEqual(await checkWebPages([file]), [])
})

test('失败报告给出行号，并明确说这一步不能算完成', () => {
  const dir = tmp()
  const results = [
    {
      file: path.join(dir, 'index.html'),
      ok: false,
      errors: ['Uncaught ReferenceError: Player is not defined（第 143 行）'],
      warnings: 2
    }
  ]
  const text = formatWebCheck(results, dir)
  assert.match(text, /【打开验收·未通过】index\.html/)
  assert.match(text, /第 143 行/)
  assert.match(text, /不能算完成/)
  assert.match(text, /read_file/)
  assert.equal(hasBlockingFailure(results), true)
})

test('通过时也回一句话：9B 不知道什么时候该停', () => {
  const dir = tmp()
  const results = [
    {
      file: path.join(dir, 'index.html'),
      ok: true,
      errors: [],
      warnings: 0,
      probe: { readyState: 'complete', canvasCount: 1, painted: true, animated: true }
    }
  ]
  const text = formatWebCheck(results, dir)
  assert.match(text, /【打开验收】index\.html 已实际打开/)
  assert.match(text, /画布已绘制/)
  assert.match(text, /动画帧在跑/)
  assert.equal(hasBlockingFailure(results), false)
})
