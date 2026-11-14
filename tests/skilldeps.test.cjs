const test = require('node:test')
const assert = require('node:assert')
const {
  SKILL_DEPS,
  allModules,
  buildInstallCommand,
  summarizeDeps
} = require('../dist/shared/skilldeps.js')

test('依赖表覆盖 6 个离线技能，且 pip 名与 import 名分开写', () => {
  assert.equal(SKILL_DEPS.length, 6)
  const img = SKILL_DEPS.find((s) => s.skill === '图片处理')
  assert.deepEqual(img.modules, [{ pip: 'Pillow', mod: 'PIL' }])
  const arch = SKILL_DEPS.find((s) => s.skill === '文件归档整理')
  assert.deepEqual(arch.modules, [])
  assert.ok(allModules().includes('docx'))
  assert.ok(allModules().includes('PIL'))
  assert.equal(new Set(allModules()).size, allModules().length)
})

test('没装 Python：报告可读、不给无法执行的安装命令', () => {
  const r = summarizeDeps(null, '', {})
  assert.equal(r.ok, false)
  assert.equal(r.python, null)
  assert.equal(r.installCmd, '')
  assert.match(r.message, /Python/)
  assert.equal(r.items.length, 6)
})

test('依赖齐备：ok 且没有安装命令', () => {
  const found = Object.fromEntries(allModules().map((m) => [m, true]))
  const r = summarizeDeps('python', 'Python 3.11.8', found)
  assert.equal(r.ok, true)
  assert.equal(r.installCmd, '')
  assert.ok(r.items.every((i) => i.ok))
  assert.match(r.message, /3\.11\.8/)
})

test('缺包：用 pip 名而非 import 名，去重后给一行命令', () => {
  const found = Object.fromEntries(allModules().map((m) => [m, true]))
  found.PIL = false
  found.docx = false
  const r = summarizeDeps('py', 'Python 3.12.0', found)
  assert.equal(r.ok, false)
  assert.match(r.installCmd, /^py -m pip install /)
  assert.match(r.installCmd, /Pillow/)
  assert.match(r.installCmd, /python-docx/)
  assert.ok(!r.installCmd.includes('PIL '))
  const img = r.items.find((i) => i.skill === '图片处理')
  assert.deepEqual(img.missing, ['Pillow'])
  const arch = r.items.find((i) => i.skill === '文件归档整理')
  assert.equal(arch.ok, true)
})

test('buildInstallCommand 去重、忽略空包名、无 Python 时返回空', () => {
  assert.equal(buildInstallCommand(['a', 'a', 'b'], 'python'), 'python -m pip install a b')
  assert.equal(buildInstallCommand([], 'python'), '')
  assert.equal(buildInstallCommand(['a'], null), '')
})
