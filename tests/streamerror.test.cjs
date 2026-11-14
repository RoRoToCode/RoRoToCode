/**
 * 流式请求失败的翻译层。
 *
 * 这一层的存在理由就一条：用户不该看到 `TypeError: terminated`。
 * 那是 undici 内部关于 socket 的错，字面意思和真实原因（模型进程崩了 / 请求被掐）无关。
 */
const test = require('node:test')
const assert = require('node:assert')
const { explainStreamFailure } = require('../dist/main/providers/base.js')

const provider = (over = {}) => ({
  id: 'llamacpp',
  name: 'llama.cpp 本地',
  kind: 'openai',
  baseUrl: '',
  model: 'test-9b',
  contextWindow: 8192,
  temperature: 0.2,
  ...over
})

test('用户取消：透出我们自己的中文，而不是 terminated', async () => {
  const c = new AbortController()
  c.abort(new Error('已取消'))
  const msg = await explainStreamFailure(new TypeError('terminated'), provider(), c.signal)
  assert.match(msg, /已取消/)
})

test('看门狗掐断：保留原始原因（生成中断 / 请求超时）', async () => {
  const c = new AbortController()
  c.abort(new Error('生成中断：90 秒没有收到新内容，连接可能已断开。'))
  const msg = await explainStreamFailure(new TypeError('terminated'), provider(), c.signal)
  assert.match(msg, /90 秒没有收到新内容/)
})

test('终止且服务已不在：说清是进程没了，并指路', async () => {
  const msg = await explainStreamFailure(
    new TypeError('terminated'),
    provider({ baseUrl: '' }),
    new AbortController().signal
  )
  assert.match(msg, /进程不在了/)
  assert.match(msg, /本地模型/)
})

test('非网络错误原样上抛，不被改写', async () => {
  const msg = await explainStreamFailure(
    new Error('HTTP 400 上下文超长'),
    provider(),
    new AbortController().signal
  )
  assert.strictEqual(msg, 'HTTP 400 上下文超长')
})

test('空错误也给一句人话，不留空白', async () => {
  const msg = await explainStreamFailure(null, provider(), new AbortController().signal)
  assert.ok(msg.length > 0)
})
