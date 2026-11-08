/**
 * 环境变量白名单与脱敏的回归测试。
 * 这两处一旦回退，属于「静默泄露」——不会报错，但密钥会随命令下传。
 */
const test = require('node:test')
const assert = require('node:assert')

test('子进程环境只带白名单，密钥类变量不下传', () => {
  process.env.OPENAI_API_KEY = 'sk-should-not-leak-123456'
  process.env.GITHUB_TOKEN = 'ghp_shouldnotleak1234567890'
  process.env.SOME_PASSWORD = 'hunter2'
  const { safeEnv, filteredSecretCount } = require('../dist/main/tools/env.js')
  const env = safeEnv()
  assert.strictEqual(env.OPENAI_API_KEY, undefined)
  assert.strictEqual(env.GITHUB_TOKEN, undefined)
  assert.strictEqual(env.SOME_PASSWORD, undefined)
  assert.ok(env.PATH || env.Path || env.SystemRoot || env.ComSpec)
  assert.strictEqual(env.GIT_PAGER, 'cat')
  assert.ok(filteredSecretCount() >= 3)
})
