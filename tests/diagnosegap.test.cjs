/**
 * 「该检查却没检查」的状态上报。
 *
 * 回归的 bug：项目有 tsconfig 但没装 typescript 时，诊断层静默返回空数组，
 * 调用方把它当成「没有编译错误」，模型改坏一片类型也能顺利收工。
 * 这里盯的是状态本身 —— 空数组不再等于「查过了」。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { diagnoseReport, disposeAll } = require('../dist/main/lsp/index.js')
const { formatDiagGap } = require('../dist/shared/diagnostics.js')

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('空列表：什么都不用查', async () => {
  const r = await diagnoseReport(tmpdir('roro-gap-empty-'), [])
  assert.deepEqual(r.diags, [])
  assert.equal(r.skipped, 'empty')
})

test('文件都不存在：报 not-found，而不是「检查通过」', async () => {
  const root = tmpdir('roro-gap-miss-')
  const r = await diagnoseReport(root, [path.join(root, 'nope.ts')])
  assert.deepEqual(r.diags, [])
  assert.equal(r.skipped, 'not-found')
})

test('没有 tsconfig：报 no-config（纯 JS 脚本不该被提示去装 typescript）', async () => {
  const root = tmpdir('roro-gap-nocfg-')
  const file = path.join(root, 'a.ts')
  fs.writeFileSync(file, 'const a: number = 1\n')
  const r = await diagnoseReport(root, [file])
  assert.deepEqual(r.diags, [])
  assert.equal(r.skipped, 'no-config')
})

test('有 tsconfig 但没装 typescript：报 no-typescript，这是会骗过模型的那种情况', async () => {
  // 目录挖深三层：TsServer.locate 会往上一级、两级找 node_modules，
  // 放在系统临时目录根下可能撞到别的项目，挖深一点隔离干净
  const root = path.join(tmpdir('roro-gap-nots-'), 'a', 'b', 'c')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }))
  const file = path.join(root, 'a.ts')
  fs.writeFileSync(file, 'const a: number = "x"\n')
  const r = await diagnoseReport(root, [file])
  assert.deepEqual(r.diags, [])
  assert.equal(r.skipped, 'no-typescript')
})

test('非 TS 文件不进 TS 那一路，skipped 保持 null（真的没有可查的结论）', async () => {
  const root = tmpdir('roro-gap-md-')
  const file = path.join(root, 'README.md')
  fs.writeFileSync(file, '# hi\n')
  const r = await diagnoseReport(root, [file])
  assert.deepEqual(r.diags, [])
  assert.equal(r.skipped, null)
})

test('提示文案：说清「没查」并给出下一步，不能写成「检查通过」', () => {
  const noTs = formatDiagGap('no-typescript')
  assert.match(noTs, /没有做类型检查/)
  assert.match(noTs, /不要把/)
  assert.match(noTs, /npm install|构建|测试/)

  const dead = formatDiagGap('unavailable')
  assert.match(dead, /没有做类型检查/)
  assert.notEqual(noTs, dead)
})

test('收尾清理：不留 tsserver 进程', () => {
  disposeAll()
  assert.ok(true)
})
