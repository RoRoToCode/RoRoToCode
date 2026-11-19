const test = require('node:test')
const assert = require('node:assert/strict')
const {
  AUTO_RESUME_SECONDS,
  isSilentStall,
  stallReason
} = require('../dist/shared/autoresume.js')

/**
 * 静默中断自动续跑的判定：
 * 只允许「吐字前超时 / 生成中断」这类「流没送达」的错误触发倒计时，
 * 401 / 上下文溢出 / 连接失败这些必须先让用户处理，续跑只会再撞一次墙。
 */
test('倒计时长度是 60 秒', () => {
  assert.equal(AUTO_RESUME_SECONDS, 60)
})

test('静默中断的四类原文都能识别', () => {
  assert.equal(isSilentStall(new Error('生成中断：90 秒没有收到新内容，连接可能已断开。')), true)
  assert.equal(isSilentStall(new Error('等了 10 分钟仍然没有拿到第一个字')), true)
  assert.equal(isSilentStall(new Error('没有任何输出')), true)
  assert.equal(isSilentStall(new Error('请求超时')), true)
  assert.equal(isSilentStall('生成中断：流断了'), true) // 非 Error 对象也要认
})

test('需要用户先处理的错误不触发自动续跑', () => {
  for (const msg of [
    'HTTP 401 Unauthorized',
    'HTTP 402 payment required',
    'HTTP 400 request exceeds context size',
    '连接失败：fetch failed',
    'ECONNRESET',
    ''
  ]) {
    assert.equal(isSilentStall(new Error(msg)), false, `不应该续跑：${msg}`)
  }
})

test('界面原因文案简短、不漏服务端原文', () => {
  assert.equal(stallReason(new Error('生成中断：90 秒没有收到新内容，连接可能已断开。')), '生成中断：连接长时间没有返回内容')
  assert.equal(stallReason(new Error('请求超时')), '请求超时：服务端没有在时限内响应')
  assert.equal(stallReason(new Error('仍然没有拿到第一个字')), '模型没有返回内容（可能卡在预填充）')
  assert.ok(stallReason(new Error('x'.repeat(500))).length <= 120)
})

test('与引擎 quietTimeout 判定一致（两边共用一份，不漂移）', () => {
  const { quietTimeout } = require('../dist/main/agent.js')
  for (const msg of ['生成中断：90 秒没有收到新内容', '请求超时', 'HTTP 401 Unauthorized', 'fetch failed']) {
    const e = new Error(msg)
    assert.equal(quietTimeout(e), isSilentStall(e), `判定必须一致：${msg}`)
  }
})
