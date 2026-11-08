/**
 * roroto.json 多层合并单测：向上逐层收集，外层在前、内层在后（内层覆盖外层）。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { loadProjectPermissions, loadProjectPermissionsDetailed, clearPermissionsCache } =
  require('../dist/main/permissions.js')

function tmpTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roroto-perm-'))
  // 三层：root / mid / leaf
  const mid = path.join(root, 'mid')
  const leaf = path.join(mid, 'leaf')
  fs.mkdirSync(leaf, { recursive: true })
  return { root, mid, leaf }
}

function write(file, permissions) {
  fs.writeFileSync(file, JSON.stringify({ permissions }, null, 2))
}

test('单层：只读工作区根的 roroto.json', async () => {
  const { leaf } = tmpTree()
  write(path.join(leaf, 'roroto.json'), [{ action: 'run_shell', resource: 'rm *', effect: 'deny' }])
  const result = await loadProjectPermissionsDetailed(leaf)
  assert.strictEqual(result.rules.length, 1)
  assert.strictEqual(result.files.length, 1)
  assert.strictEqual(result.detailed[0].from, path.join(leaf, 'roroto.json'))
})

test('多层：外层规则在前、内层规则在后', async () => {
  const { root, mid, leaf } = tmpTree()
  write(path.join(root, 'roroto.json'), [{ action: 'run_shell', resource: 'npm *', effect: 'allow' }])
  write(path.join(mid, 'roroto.json'), [{ action: 'run_shell', resource: 'rm *', effect: 'deny' }])
  write(path.join(leaf, 'roroto.json'), [{ action: 'run_shell', resource: 'npm test', effect: 'deny' }])

  const result = await loadProjectPermissionsDetailed(leaf)
  // 顺序：root → mid → leaf（外层在前）
  assert.deepStrictEqual(result.rules.map((r) => r.resource), ['npm *', 'rm *', 'npm test'])
  assert.strictEqual(result.files.length, 3)
  assert.strictEqual(result.files[0], path.join(leaf, 'roroto.json')) // files 最内层在前
  // 来源标注正确
  assert.deepStrictEqual(
    result.detailed.map((d) => d.from),
    [path.join(root, 'roroto.json'), path.join(mid, 'roroto.json'), path.join(leaf, 'roroto.json')]
  )
})

test('内层覆盖外层：同 action+resource 时内层生效', async () => {
  const { root, leaf } = tmpTree()
  // 外层 allow，内层 deny —— 内层更具体，应覆盖为 deny
  write(path.join(root, 'roroto.json'), [{ action: 'run_shell', resource: 'npm test', effect: 'allow' }])
  write(path.join(leaf, 'roroto.json'), [{ action: 'run_shell', resource: 'npm test', effect: 'deny' }])

  const result = await loadProjectPermissionsDetailed(leaf)
  assert.strictEqual(result.rules.length, 2)
  // 最后一条（内层）生效
  assert.strictEqual(result.rules[result.rules.length - 1].effect, 'deny')
})

test('无 roroto.json 时返回空', async () => {
  const { leaf } = tmpTree()
  const result = await loadProjectPermissionsDetailed(leaf)
  assert.strictEqual(result.rules.length, 0)
  assert.strictEqual(result.files.length, 0)
})

test('非法规则被过滤，合法规则保留', async () => {
  const { leaf } = tmpTree()
  write(path.join(leaf, 'roroto.json'), [
    { action: 'run_shell', resource: 'rm *', effect: 'deny' },
    { action: 'run_shell' }, // 缺 resource
    { action: '', resource: 'x', effect: 'allow' }, // 空 action
    { action: 'x', resource: 'y', effect: 'maybe' } // 非法 effect
  ])
  const result = await loadProjectPermissionsDetailed(leaf)
  assert.strictEqual(result.rules.length, 1)
  assert.strictEqual(result.rules[0].resource, 'rm *')
})

test('缓存失效：改文件后 mtime 变了会重读', async () => {
  const { leaf } = tmpTree()
  const file = path.join(leaf, 'roroto.json')
  write(file, [{ action: 'run_shell', resource: 'rm *', effect: 'deny' }])
  let result = await loadProjectPermissionsDetailed(leaf)
  assert.strictEqual(result.rules.length, 1)

  // 追加一条，mtime 变化
  write(file, [
    { action: 'run_shell', resource: 'rm *', effect: 'deny' },
    { action: 'run_shell', resource: 'npm *', effect: 'allow' }
  ])
  clearPermissionsCache()
  result = await loadProjectPermissionsDetailed(leaf)
  assert.strictEqual(result.rules.length, 2)
})

test('loadProjectPermissions 返回合并后的纯规则数组', async () => {
  const { root, leaf } = tmpTree()
  write(path.join(root, 'roroto.json'), [{ action: 'run_shell', resource: 'npm *', effect: 'allow' }])
  write(path.join(leaf, 'roroto.json'), [{ action: 'run_shell', resource: 'rm *', effect: 'deny' }])
  const rules = await loadProjectPermissions(leaf)
  assert.strictEqual(rules.length, 2)
  assert.strictEqual(rules[0].resource, 'npm *')
  assert.strictEqual(rules[1].resource, 'rm *')
})
