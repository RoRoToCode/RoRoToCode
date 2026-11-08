/** 脱敏：日志与错误提示里最常见几种凭据形态都要被替换掉 */
const test = require('node:test')
const assert = require('node:assert')
const { redact } = require('../dist/main/redact.js')

test('OpenAI 风格的 key 被替换', () => {
  const out = redact('请求失败 key=sk-proj-abcdefghijklmnopqrstuvwxyz')
  assert.ok(!out.includes('abcdefghijklmnop'))
  assert.ok(out.includes('sk-***'))
})

test('Anthropic 与 GitHub token 被替换', () => {
  const out = redact('sk-ant-api03-abcdefghijklmnop ghp_abcdefghijklmnopqrst')
  assert.ok(!out.includes('api03-abcdefghijklmnop'))
  assert.ok(!out.includes('ghp_abcdefghijklmnopqrst'))
})

test('Authorization 头与 URL 查询参数被替换', () => {
  const out = redact('Authorization: Bearer abcdef123456789 https://x.dev/v1?api_key=abcdef123456')
  assert.ok(!out.includes('abcdef123456789'))
  assert.ok(!out.includes('api_key=abcdef123456'))
})

test('JSON 里的 apiKey 字段被替换', () => {
  const out = redact('{"apiKey":"sk-realvalue-1234","model":"gpt"}')
  assert.ok(!out.includes('sk-realvalue-1234'))
  assert.ok(out.includes('"apiKey":"***"'))
})

test('普通文本保持原样', () => {
  const s = '构建失败：Cannot find module vite'
  assert.strictEqual(redact(s), s)
})
