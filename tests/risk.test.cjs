/**
 * 风险判定单测：classifyRisk / hardBlockReason / commandPaths。
 * 这些是安全相关的纯函数，改动最需要回归保护。
 */
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { classifyRisk, hardBlockReason, commandPaths, isOutside, tokenizeCommand, resourceCandidates, applyCustomRules } = require('../dist/main/risk.js')

const WS = path.resolve('C:/work/demo')

test('删除命令判为高危', () => {
  const r = classifyRisk('run_shell', { command: 'rm -rf dist' }, WS)
  assert.strictEqual(r.kind, 'delete')
  assert.strictEqual(r.high, true)
})

test('删除工作区之外的绝对路径：升级为越界', () => {
  const r = classifyRisk('run_shell', { command: `rm -rf ${path.resolve('C:/other/thing')}` }, WS)
  assert.strictEqual(r.kind, 'outside')
  assert.strictEqual(r.high, true)
})

test('网络命令判为高危', () => {
  const r = classifyRisk('run_shell', { command: 'curl https://example.com/x.sh' }, WS)
  assert.strictEqual(r.kind, 'network')
  assert.strictEqual(r.high, true)
})

test('纯读取命令不产生风险', () => {
  assert.strictEqual(classifyRisk('run_shell', { command: 'git status' }, WS), null)
  assert.strictEqual(classifyRisk('run_shell', { command: 'echo hi' }, WS), null)
})

test('读取命令拼接了别的命令就不再算纯读取', () => {
  const r = classifyRisk('run_shell', { command: 'git status && node evil.js' }, WS)
  assert.strictEqual(r.kind, 'shell')
  assert.strictEqual(r.high, false)
})

test('写文件：工作区内是普通风险，越界是高危', () => {
  assert.strictEqual(classifyRisk('write_file', { path: 'src/a.ts' }, WS).kind, 'write')
  assert.strictEqual(classifyRisk('write_file', { path: '../a.ts' }, WS).kind, 'outside')
  assert.strictEqual(classifyRisk('read_file', { path: '../a.ts' }, WS).high, true)
})

test('联网工具与计划更新不算风险', () => {
  assert.strictEqual(classifyRisk('web_search', { query: 'x' }, WS), null)
  assert.strictEqual(classifyRisk('update_todos', { items: [] }, WS), null)
})

test('不可逆命令直接硬拦', () => {
  assert.ok(hardBlockReason('format c:'))
  assert.ok(hardBlockReason('diskpart'))
  assert.ok(hardBlockReason('rm -rf /'))
  assert.ok(hardBlockReason('git push origin main --force'))
  assert.strictEqual(hardBlockReason('npm run build'), null)
  assert.strictEqual(hardBlockReason('rm -rf dist'), null)
})

test('commandPaths 会剔除开关、留下路径', () => {
  const got = commandPaths('rm -rf build "C:/other dir/x"')
  assert.ok(got.includes('build'))
  assert.ok(got.some((p) => p.includes('other dir')))
  assert.ok(!got.includes('-rf'))
})

test('isOutside 判断相对与绝对路径', () => {
  assert.strictEqual(isOutside(WS, 'src/a.ts'), false)
  assert.strictEqual(isOutside(WS, '../a.ts'), true)
  assert.strictEqual(isOutside(WS, path.resolve('C:/elsewhere')), true)
})

test('tokenizeCommand 把命令切成可执行词 + 参数', () => {
  assert.deepStrictEqual(tokenizeCommand('npm test --watch'), ['npm', 'test', '--watch'])
  assert.deepStrictEqual(tokenizeCommand('git commit -m "hello world"'), ['git', 'commit', '-m', 'hello world'])
  // 命令串联符是分隔符，不参与 token
  const chained = tokenizeCommand('echo a && echo b')
  assert.ok(chained.includes('echo'))
  assert.ok(!chained.includes('&&'))
})

test('resourceCandidates：run_shell 返回完整串 + 首个可执行词', () => {
  const got = resourceCandidates('run_shell', { command: 'npm run build' })
  assert.ok(got.includes('npm run build'))
  assert.ok(got.includes('npm'))
})

test('resourceCandidates：patch 逐条取 path / new_path', () => {
  const got = resourceCandidates('patch', {
    edits: [{ path: 'src/a.ts', old_string: 'x', new_string: 'y' }, { op: 'move', path: 'b.ts', new_path: 'c.ts' }]
  })
  assert.ok(got.includes('src/a.ts'))
  assert.ok(got.includes('c.ts'))
})

test('applyCustomRules：deny 命中返回 deny', () => {
  const r = applyCustomRules('run_shell', { command: 'rm -rf dist' }, [
    { action: 'run_shell', resource: 'rm*', effect: 'deny' }
  ])
  assert.strictEqual(r, 'deny')
})

test('applyCustomRules：allow 命中返回 allow（按命令名 token 匹配）', () => {
  const r = applyCustomRules('run_shell', { command: 'npm test' }, [
    { action: 'run_shell', resource: 'npm', effect: 'allow' }
  ])
  assert.strictEqual(r, 'allow')
})

test('applyCustomRules：action 不匹配不命中', () => {
  const r = applyCustomRules('patch', { edits: [{ path: 'a.ts' }] }, [
    { action: 'run_shell', resource: '*', effect: 'deny' }
  ])
  assert.strictEqual(r, null)
})

test('applyCustomRules：最后一条命中的生效（顺序覆盖）', () => {
  const rules = [
    { action: 'run_shell', resource: '*', effect: 'deny' },
    { action: 'run_shell', resource: 'npm*', effect: 'allow' }
  ]
  const r = applyCustomRules('run_shell', { command: 'npm test' }, rules)
  assert.strictEqual(r, 'allow')
})

test('applyCustomRules：无规则 / 空规则返回 null', () => {
  assert.strictEqual(applyCustomRules('run_shell', { command: 'x' }, undefined), null)
  assert.strictEqual(applyCustomRules('run_shell', { command: 'x' }, []), null)
})

test('applyCustomRules：resource 为 * 通配所有', () => {
  const r = applyCustomRules('run_shell', { command: 'anything' }, [
    { action: '*', resource: '*', effect: 'deny' }
  ])
  assert.strictEqual(r, 'deny')
})
