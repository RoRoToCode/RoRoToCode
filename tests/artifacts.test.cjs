const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const {
  snapshotResults,
  diffResults,
  mayProduceFiles
} = require('../dist/main/artifacts.js')

async function withTmp(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roroto-art-'))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('快照只收成果文件：跳过源码、脚本、依赖目录与隐藏目录', async () => {
  await withTmp(async (dir) => {
    await fs.mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
    await fs.mkdir(path.join(dir, '.git'), { recursive: true })
    await fs.mkdir(path.join(dir, 'release', 'workspace'), { recursive: true })
    await fs.writeFile(path.join(dir, 'report.docx'), 'a')
    await fs.writeFile(path.join(dir, 'helper.py'), 'a')
    await fs.writeFile(path.join(dir, 'node_modules', 'pkg', 'readme.md'), 'a')
    await fs.writeFile(path.join(dir, '.git', 'note.md'), 'a')
    await fs.writeFile(path.join(dir, 'release', 'workspace', 'build-note.md'), 'a')
    const snap = await snapshotResults(dir)
    assert.deepEqual([...snap.keys()], ['report.docx'])
  })
})

test('diff：新增记 created，内容改动记 edited，没动过的不重复报', async () => {
  await withTmp(async (dir) => {
    await fs.writeFile(path.join(dir, 'existing.pdf'), 'a')
    const before = await snapshotResults(dir)

    await fs.writeFile(path.join(dir, 'fresh.xlsx'), 'b')
    const later = new Date(Date.now() + 10_000)
    await fs.utimes(path.join(dir, 'existing.pdf'), later, later)
    const after = await snapshotResults(dir)

    const items = diffResults(before, after)
    assert.equal(items.length, 2)
    assert.equal(items.find((i) => i.path === 'fresh.xlsx').action, 'created')
    assert.equal(items.find((i) => i.path === 'existing.pdf').action, 'edited')
    assert.deepEqual(diffResults(after, after), [])
  })
})

test('空目录 / 不存在的根：返回空快照而不是抛错', async () => {
  assert.equal((await snapshotResults('')).size, 0)
  assert.equal((await snapshotResults(path.join(os.tmpdir(), 'roroto-no-such-dir-xyz'))).size, 0)
})

test('只有命令类工具才值得扫盘', () => {
  assert.equal(mayProduceFiles(['read_file', 'grep']), false)
  assert.equal(mayProduceFiles(['write_file', 'run_shell']), true)
  assert.equal(mayProduceFiles(['use_skill']), true)
  assert.equal(mayProduceFiles([]), false)
})
