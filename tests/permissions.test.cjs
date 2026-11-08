/**
 * 权限规则化单测：deny/allow 规则、命令分词、decideApproval 的 denied 短路。
 */
const test = require('node:test')
const assert = require('node:assert')
const { applyCustomRules, tokenizeCommand, classifyRisk, classifyMcpRisk, resourceCandidates } = require('../dist/main/risk.js')
const { decideApproval } = require('../dist/main/approval.js')

const WS = 'C:/project'

test('tokenizeCommand 切出命令词与参数，跳过引号内的空格', () => {
  assert.deepStrictEqual(tokenizeCommand('npm test'), ['npm', 'test'])
  assert.deepStrictEqual(tokenizeCommand('git commit -m "hello world"'), ['git', 'commit', '-m', 'hello world'])
  assert.deepStrictEqual(tokenizeCommand('rm -rf src && npm i'), ['rm', '-rf', 'src', 'npm', 'i'])
})

test('applyCustomRules：deny 命中返回 deny', () => {
  const rules = [{ action: 'run_shell', resource: 'rm *', effect: 'deny' }]
  assert.strictEqual(applyCustomRules('run_shell', { command: 'rm -rf src' }, rules), 'deny')
})

test('applyCustomRules：不命中返回 null', () => {
  const rules = [{ action: 'run_shell', resource: 'rm *', effect: 'deny' }]
  assert.strictEqual(applyCustomRules('run_shell', { command: 'npm test' }, rules), null)
})

test('applyCustomRules：最后一条匹配生效', () => {
  const rules = [
    { action: 'run_shell', resource: 'npm *', effect: 'deny' },
    { action: 'run_shell', resource: 'npm test', effect: 'allow' }
  ]
  assert.strictEqual(applyCustomRules('run_shell', { command: 'npm test' }, rules), 'allow')
})

test('applyCustomRules：action=* 匹配所有工具', () => {
  const rules = [{ action: '*', resource: '*secret*', effect: 'deny' }]
  assert.strictEqual(applyCustomRules('write_file', { path: 'src/.secret/key' }, rules), 'deny')
  assert.strictEqual(applyCustomRules('write_file', { path: 'src/app.ts' }, rules), null)
})

test('classifyRisk：deny 规则命中返回 denied 标记', () => {
  const rules = [{ action: 'run_shell', resource: 'rm *', effect: 'deny' }]
  const r = classifyRisk('run_shell', { command: 'rm -rf src' }, WS, rules)
  assert.ok(r)
  assert.strictEqual(r.denied, true)
  assert.strictEqual(r.high, true)
})

test('classifyRisk：deny 规则不命中时按内置判定（删除仍是高危）', () => {
  const rules = [{ action: 'run_shell', resource: 'echo *', effect: 'deny' }]
  const r = classifyRisk('run_shell', { command: 'rm -rf src' }, WS, rules)
  assert.ok(r)
  assert.strictEqual(r.denied, undefined)
  assert.strictEqual(r.kind, 'delete')
})

test('decideApproval：denied 直接 deny，无视任何放行记录', () => {
  const base = {
    mode: 'auto',
    hasRisk: true,
    high: false,
    alwaysApprove: true,
    alwaysApproveHigh: true
  }
  assert.strictEqual(decideApproval({ ...base, denied: true }), 'deny')
  assert.strictEqual(decideApproval({ ...base, denied: false }), 'allow')
})

test('decideApproval：无 denied 时行为不变（高危仍需确认）', () => {
  const base = { mode: 'auto', hasRisk: true, high: true, alwaysApprove: false, alwaysApproveHigh: false }
  assert.strictEqual(decideApproval(base), 'ask')
})

test('resourceCandidates：命令同时给出完整串与首个命令词', () => {
  assert.deepStrictEqual(resourceCandidates('run_shell', { command: 'npm test --watch' }), ['npm test --watch', 'npm'])
})

test('resourceCandidates：patch 给出每个 edit 的 path 与 new_path', () => {
  const args = { edits: [{ path: 'a.ts' }, { path: 'b.ts', new_path: 'c.ts' }] }
  assert.deepStrictEqual(resourceCandidates('patch', args), ['a.ts', 'b.ts', 'c.ts'])
})

test('applyCustomRules：命令规则按命令词匹配（不用写完整命令）', () => {
  const rules = [{ action: 'run_shell', resource: 'npm', effect: 'deny' }]
  assert.strictEqual(applyCustomRules('run_shell', { command: 'npm test --watch' }, rules), 'deny')
})

test('classifyRisk：allow 放行普通写文件（无内置风险）', () => {
  const rules = [{ action: 'write_file', resource: '*.ts', effect: 'allow' }]
  const r = classifyRisk('write_file', { path: 'src/app.ts' }, WS, rules)
  assert.strictEqual(r, null)
})

test('classifyRisk：allow 不能放行高危（删除仍是高危）', () => {
  const rules = [{ action: 'run_shell', resource: 'rm *', effect: 'allow' }]
  const r = classifyRisk('run_shell', { command: 'rm -rf src' }, WS, rules)
  assert.ok(r)
  assert.strictEqual(r.kind, 'delete')
  assert.strictEqual(r.high, true)
})

test('classifyRisk：allow 不能放行越界写', () => {
  const rules = [{ action: 'write_file', resource: '*', effect: 'allow' }]
  const r = classifyRisk('write_file', { path: 'C:/outside/file.txt' }, WS, rules)
  assert.ok(r)
  assert.strictEqual(r.kind, 'outside')
})

test('classifyMcpRisk：deny 规则对 MCP 工具生效', () => {
  const rules = [{ action: 'mcp__evil__drop', resource: '*', effect: 'deny' }]
  const r = classifyMcpRisk('mcp__evil__drop', rules)
  assert.ok(r)
  assert.strictEqual(r.denied, true)
})

test('classifyMcpRisk：无 deny 规则时仍算高危（需确认）', () => {
  const r = classifyMcpRisk('mcp__safe__list', [])
  assert.ok(r)
  assert.strictEqual(r.denied, undefined)
  assert.strictEqual(r.high, true)
})
