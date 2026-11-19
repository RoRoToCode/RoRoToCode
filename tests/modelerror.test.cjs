/**
 * 模型失败的身份标签：界面/日志里的一句 `HTTP 401` 必须说清是哪条模型。
 *
 * 两条不能破的底线：
 *  1. `HTTP xxx` 子串原样保留 —— agent 的 switchReason / retryable / isWarmingUp
 *     靠它决定换模型还是重试，丢了就会静默换模型或不再重试。
 *  2. 幂等 —— 同一错误可能被包两次，标签不能叠加。
 */
const test = require('node:test')
const assert = require('node:assert')
const { modelError } = require('../dist/main/providers/base.js')

const provider = (over = {}) => ({
  id: 'p1',
  name: '自定义',
  kind: 'openai',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  apiKey: 'k',
  model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
  contextWindow: 132768,
  temperature: 0.2,
  ...over
})

test('401 带上供应商与模型名，并给出 Key 建议', () => {
  const out = modelError(provider(), new Error('HTTP 401 Unauthorized：Unauthorized access'))
  assert.match(out.message, /自定义 · nvidia\/nemotron-3\.5-super-vl-120b-a12b/)
  assert.match(out.message, /HTTP 401/)
  assert.match(out.message, /API Key 无效或已过期/)
})

test('HTTP xxx 子串原样保留，不破坏自动切换判断', () => {
  for (const code of [400, 401, 402, 403, 429, 503]) {
    const out = modelError(provider(), new Error(`HTTP ${code} Something`))
    assert.ok(out.message.includes(`HTTP ${code}`), `丢失了 HTTP ${code}`)
  }
})

test('401 与 403 才提示 Key，其它状态码不多嘴', () => {
  assert.match(modelError(provider(), new Error('HTTP 401 x')).message, /API Key/)
  assert.match(modelError(provider(), new Error('HTTP 403 x')).message, /API Key/)
  assert.doesNotMatch(modelError(provider(), new Error('HTTP 500 x')).message, /API Key/)
})

test('Anthropic 供应商说 Anthropic API Key', () => {
  const out = modelError(provider({ kind: 'anthropic' }), new Error('HTTP 401 x'))
  assert.match(out.message, /Anthropic API Key/)
})

test('幂等：重复包装不叠加标签', () => {
  const once = modelError(provider(), new Error('HTTP 401 x'))
  const twice = modelError(provider(), once)
  assert.strictEqual(twice.message, once.message)
})

test('原文作为 cause 保留，便于排错', () => {
  const src = new Error('HTTP 429 Too Many Requests')
  const out = modelError(provider(), src)
  assert.strictEqual(out.cause, src)
})

test('非 Error 入参也能得到一句带模型的话', () => {
  const out = modelError(provider(), 'boom')
  assert.match(out.message, /自定义 · nvidia/)
  assert.match(out.message, /boom/)
})
