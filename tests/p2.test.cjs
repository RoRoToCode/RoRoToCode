const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const repoindex = require('../dist/main/repoindex.js')
const verify = require('../dist/main/verify.js')
const workspaces = require('../dist/main/workspaces.js')
const agent = require('../dist/main/agent.js')
const { diffHunks, buildWithHunks } = require('../dist/shared/hunks.js')

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function write(root, rel, content) {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
  return full
}

test('repoindex：TS 顶层导出能被提取', () => {
  const src = `
import x from 'x'
export function alpha() {}
export class Beta {}
export const gamma = 1
export interface Delta {}
export { eps as zeta }
`
  const r = repoindex.extractSymbols(src, 'a.ts')
  assert.ok(r.symbols.includes('alpha'))
  assert.ok(r.symbols.includes('Beta'))
  assert.ok(r.symbols.includes('gamma'))
  assert.ok(r.symbols.includes('Delta'))
  assert.ok(r.symbols.includes('eps'))
})

test('repoindex：Python / Go 符号', () => {
  const py = repoindex.extractSymbols('def handler():\n    pass\n\nclass Api:\n    pass\n', 'x.py')
  assert.deepEqual(py.symbols.sort(), ['Api', 'handler'])
  const go = repoindex.extractSymbols('package main\n\nfunc Serve() {}\n\ntype Opts struct{}\n', 'x.go')
  assert.ok(go.symbols.includes('Serve'))
  assert.ok(go.symbols.includes('Opts'))
})

test('repoindex：建索引跳过 node_modules，且能增量复用', async () => {
  const root = tmpdir('roro-idx-')
  write(root, 'src/a.ts', '/** 甲模块 */\nexport function one() {}\n')
  write(root, 'src/b.py', '# 乙模块\ndef two():\n    pass\n')
  write(root, 'node_modules/x/i.js', 'export function nope() {}')
  write(root, 'package-lock.json', '{}')

  const idx = await repoindex.buildIndex(root)
  const files = idx.files.map((f) => f.path).sort()
  assert.deepEqual(files, ['src/a.ts', 'src/b.py'])
  const a = idx.files.find((f) => f.path === 'src/a.ts')
  assert.match(a.summary, /甲模块/)
  assert.ok(fs.existsSync(path.join(root, '.roroto', 'index.json')))

  // 第二次：文件没变，复用旧条目（保留同一个 mtime 与符号）
  const again = await repoindex.buildIndex(root)
  const a2 = again.files.find((f) => f.path === 'src/a.ts')
  assert.equal(a2.mtime, a.mtime)
  assert.deepEqual(a2.symbols, a.symbols)

  // 改了内容：只更新这一个，另一个原样
  write(root, 'src/a.ts', '/** 甲模块 v2 */\nexport function one() {}\nexport function three() {}\n')
  const third = await repoindex.buildIndex(root)
  const a3 = third.files.find((f) => f.path === 'src/a.ts')
  assert.ok(a3.symbols.includes('three'))
  assert.match(a3.summary, /v2/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('repoindex：query 同时匹配路径与符号', async () => {
  const root = tmpdir('roro-idx2-')
  write(root, 'src/parser.ts', 'export function parseThing() {}\n')
  write(root, 'src/other.ts', 'export function unrelated() {}\n')
  const idx = await repoindex.buildIndex(root)
  const text = repoindex.renderMap(idx, { query: 'parseThing' })
  assert.match(text, /parser\.ts/)
  assert.doesNotMatch(text, /other\.ts/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('hunks：相邻改动合并，隔得远的切成两块', () => {
  const lines = []
  const ctx = (t) => lines.push({ kind: 'ctx', text: t })
  ctx('a')
  lines.push({ kind: 'add', text: 'X' })
  ctx('b')
  lines.push({ kind: 'del', text: 'c' })
  for (let i = 0; i < 20; i++) ctx(`pad${i}`)
  lines.push({ kind: 'add', text: 'Y' })
  ctx('z')

  const hunks = diffHunks(lines)
  assert.equal(hunks.length, 2)
  assert.equal(hunks[0].added, 1)
  assert.equal(hunks[0].removed, 1)
  assert.equal(hunks[1].added, 1)
})

test('hunks：只保留选中的块，其余回退成原文', () => {
  const lines = []
  const ctx = (t) => lines.push({ kind: 'ctx', text: t })
  ctx('one')
  lines.push({ kind: 'del', text: 'old' })
  lines.push({ kind: 'add', text: 'new' })
  for (let i = 0; i < 20; i++) ctx(`pad${i}`)
  lines.push({ kind: 'add', text: 'extra' })
  ctx('end')

  const hunks = diffHunks(lines)
  assert.equal(hunks.length, 2)

  // 只保留第一块：第二块的 add 不写进去
  const keepFirst = buildWithHunks(lines, hunks, new Set([0]))
  assert.match(keepFirst, /new/)
  assert.doesNotMatch(keepFirst, /old/)
  assert.doesNotMatch(keepFirst, /extra/)

  // 一个都不要：回到原文
  const none = buildWithHunks(lines, hunks, new Set())
  assert.match(none, /old/)
  assert.doesNotMatch(none, /new/)
  assert.doesNotMatch(none, /extra/)
})

test('verify：失败输出只留失败行', () => {
  const lines = []
  for (let i = 0; i < 200; i++) lines.push(`✔ test case ${i} passed`)
  lines.push('✕ 登录失败时应该返回 401')
  lines.push('  Expected: 401')
  lines.push('  Received: 200')
  const text = lines.join('\n')

  const slim = verify.slimFailure(text)
  assert.match(slim, /登录失败/)
  assert.match(slim, /Expected: 401/)
  assert.ok(slim.length < text.length)
  // 通过的行被压掉
  assert.doesNotMatch(slim, /test case 42 passed/)
})

test('verify：短输出不动，通过时也不瘦身', () => {
  assert.equal(verify.slimFailure('全部通过'), '全部通过')
})

test('verify：有 vitest 时只跑相关用例', async () => {
  const root = tmpdir('roro-verify-')
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ devDependencies: { vitest: '^1.0.0' }, scripts: { test: 'vitest run' } })
  )
  write(root, 'src/a.ts', 'export const a = 1\n')
  const plan = await verify.detectVerifyPlan(root, ['src/a.ts'])
  assert.match(plan.command, /vitest related src\/a\.ts --run/)
  assert.equal(plan.label, '相关测试')
  fs.rmSync(root, { recursive: true, force: true })
})

test('verify：没有相关测试框架就回落到项目脚本', async () => {
  const root = tmpdir('roro-verify2-')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  const plan = await verify.detectVerifyPlan(root, ['src/a.ts'])
  assert.equal(plan.command, 'npm test --silent')
  fs.rmSync(root, { recursive: true, force: true })
})

test('workspaces：登记、置顶、去重、移除', async () => {
  const root = tmpdir('roro-ws-')
  const a = path.join(root, 'alpha')
  const b = path.join(root, 'beta')
  fs.mkdirSync(a)
  fs.mkdirSync(b)

  await workspaces.rememberWorkspace(root, a)
  let list = await workspaces.listWorkspaces(root)
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'alpha')

  await workspaces.rememberWorkspace(root, b)
  list = await workspaces.listWorkspaces(root)
  assert.equal(list[0].name, 'beta', '最近打开的排前面')

  // 重复登记同一目录不应该出现两条
  await workspaces.rememberWorkspace(root, b)
  list = await workspaces.listWorkspaces(root)
  assert.equal(list.length, 2)

  list = await workspaces.forgetWorkspace(root, b)
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'alpha')

  assert.equal(await workspaces.existsDir(a), true)
  assert.equal(await workspaces.existsDir(path.join(root, 'nope')), false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('modeOf：会话级覆盖优先于全局', () => {
  assert.equal(agent.modeOf({ approvalMode: 'ask' }, { modeOverride: 'plan' }), 'plan')
  assert.equal(agent.modeOf({ approvalMode: 'ask' }, { modeOverride: null }), 'ask')
  // 全局只读 + 会话批准过 → 升到 ask，能动手但每步仍可拦
  assert.equal(agent.modeOf({ approvalMode: 'readonly' }, { modeOverride: 'build' }), 'ask')
  assert.equal(agent.modeOf({ approvalMode: 'plan' }, { modeOverride: 'build' }), 'ask')
  // 全局是自动，批准后仍然是自动
  assert.equal(agent.modeOf({ approvalMode: 'auto' }, { modeOverride: 'build' }), 'auto')
})
