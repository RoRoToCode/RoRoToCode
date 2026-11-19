/**
 * 写前快照 + 一键回滚。
 *
 * 起因：模型改坏文件后，非 git 工作区没有回滚手段。git 的 undo 依赖工作区是
 * git 仓库，而很多自动生成的项目（单页游戏、静态站点）根本没初始化 git。
 * 快照层补的是与 git 无关的兜底。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { snapshotBeforeWrite, listSnapshots, rollbackSnapshot, clearSnapshots } = require('../dist/main/snapshot.js')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'roroto-snap-'))
const sid = 'sess-123'

test('覆盖已存在文件前会留快照；新建文件不留', async () => {
  const ws = tmp()
  const existing = path.join(ws, 'a.txt')
  fs.writeFileSync(existing, 'v1', 'utf8')

  const e1 = await snapshotBeforeWrite(ws, sid, existing)
  assert.ok(e1, '已存在文件应产生快照')
  assert.equal(e1.rel, 'a.txt')

  // 改内容后再拍一次
  fs.writeFileSync(existing, 'v2', 'utf8')
  const e2 = await snapshotBeforeWrite(ws, sid, existing)
  assert.equal(e2.seq, e1.seq + 1, '序号递增')

  // 新建文件不产生快照
  const fresh = path.join(ws, 'new.txt')
  const e3 = await snapshotBeforeWrite(ws, sid, fresh)
  assert.equal(e3, null, '新建文件无需备份')
})

test('回滚按序号把备份内容拷回', async () => {
  const ws = tmp()
  const f = path.join(ws, 'game.js')
  fs.writeFileSync(f, '第一版', 'utf8')
  const e1 = await snapshotBeforeWrite(ws, sid, f)

  fs.writeFileSync(f, '改坏了', 'utf8')
  const e2 = await snapshotBeforeWrite(ws, sid, f)

  // 回滚到第一版
  const restored = await rollbackSnapshot(ws, sid, e1.seq)
  assert.equal(restored, 'game.js')
  assert.equal(fs.readFileSync(f, 'utf8'), '第一版')

  // 回滚到第二版
  await rollbackSnapshot(ws, sid, e2.seq)
  assert.equal(fs.readFileSync(f, 'utf8'), '改坏了')
})

test('list 新到旧；回滚不存在的序号返回 null', async () => {
  const ws = tmp()
  const f = path.join(ws, 'x.js')
  fs.writeFileSync(f, 'a', 'utf8')
  await snapshotBeforeWrite(ws, sid, f)
  fs.writeFileSync(f, 'b', 'utf8')
  await snapshotBeforeWrite(ws, sid, f)

  const list = listSnapshots(ws, sid)
  assert.equal(list.length, 2)
  assert.ok(list[0].seq > list[1].seq, '新到旧')

  assert.equal(await rollbackSnapshot(ws, sid, 999), null)
})

test('工作区外的路径拒绝备份', async () => {
  const ws = tmp()
  const outside = path.join(os.tmpdir(), `outside-${Date.now()}.txt`)
  fs.writeFileSync(outside, 'x', 'utf8')
  const e = await snapshotBeforeWrite(ws, sid, outside)
  assert.equal(e, null)
})

test('clear 清空快照', async () => {
  const ws = tmp()
  const f = path.join(ws, 'a.js')
  fs.writeFileSync(f, 'v1', 'utf8')
  await snapshotBeforeWrite(ws, sid, f)
  assert.equal(listSnapshots(ws, sid).length, 1)
  await clearSnapshots(ws, sid)
  assert.equal(listSnapshots(ws, sid).length, 0)
})
