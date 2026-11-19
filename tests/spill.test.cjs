const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { clipSafe, clipTailSafe, splitHeadTail } = require('../dist/shared/text.js')
const { saveSpill, cleanupSpill, spillSessionDir } = require('../dist/main/spill.js')
const { compact, maskObservations } = require('../dist/main/agent.js')
const { healTruncatedWrites } = require('../dist/main/heal.js')

/** 孤立代理项：出现在字符串里就是「截断切碎了 emoji」 */
function hasLoneSurrogate(s) {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)
}

test('clipTailSafe：从尾部取，不把 emoji 劈成半个', () => {
  const text = 'a😀b'
  // 长度 4（a + 高 + 低 + b），取 2 正好从低代理开始 → 必须往后挪一个
  const out = clipTailSafe(text, 2)
  assert.equal(out, 'b')
  assert.equal(hasLoneSurrogate(out), false)
  // 取 3 覆盖整个 emoji，原样返回
  assert.equal(clipTailSafe(text, 3), '😀b')
  // 够长就原样
  assert.equal(clipTailSafe(text, 99), text)
})

test('splitHeadTail：省略数就是真实丢掉的字符数', () => {
  const text = `${'h'.repeat(100)}${'m'.repeat(500)}${'t'.repeat(100)}`
  const { head, tail, omitted } = splitHeadTail(text, 80, 40)
  assert.equal(head.length, 80)
  assert.equal(tail.length, 40)
  assert.equal(omitted, 700 - 120)
  // 内容比 head+tail 还短时不该报省略
  const small = splitHeadTail('short', 80, 40)
  assert.equal(small.omitted, 0)
  assert.equal(small.head, 'short')
})

test('spill：内容寻址，同一段输出只落一次盘', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roro-spill-'))
  try {
    const text = 'x'.repeat(5000)
    const a = saveSpill(root, 'session-1', text, { toolName: 'read_file' })
    assert.ok(a, '应该返回路径')
    assert.equal(fs.readFileSync(a, 'utf8'), text)
    // 同一段内容再存一次：路径相同，文件没有多出来
    const b = saveSpill(root, 'session-1', text, { toolName: 'read_file' })
    assert.equal(b, a)
    assert.equal(fs.readdirSync(path.dirname(a)).length, 1)
    // 不同内容各自一份
    saveSpill(root, 'session-1', 'other content')
    assert.equal(fs.readdirSync(path.dirname(a)).length, 2)
    // 会话隔离
    assert.notEqual(spillSessionDir(root, 'session-1'), spillSessionDir(root, 'session-2'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('spill：过期清理只删旧文件，空目录一起收掉', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roro-spill-'))
  try {
    const file = saveSpill(root, 'session-1', 'old content')
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    fs.utimesSync(file, old, old)
    const fresh = saveSpill(root, 'session-2', 'fresh content')
    const removed = cleanupSpill(root, 7 * 24 * 3600 * 1000)
    assert.equal(removed, 1)
    assert.equal(fs.existsSync(file), false)
    assert.equal(fs.existsSync(fresh), true)
    // 被清空的会话目录不应该留着
    assert.equal(fs.existsSync(spillSessionDir(root, 'session-1')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('compact：传了 spill 就把「全文在哪」写进折叠说明', () => {
  const body = `${'A'.repeat(4000)}MIDDLE${'B'.repeat(4000)}`
  // 两轮：最新一轮的原文必须保留，被折叠的只能是「较早」的那条
  const list = [
    { id: 'u1', role: 'user', content: '看这个文件', createdAt: 1 },
    { id: 'a1', role: 'assistant', content: '', createdAt: 2, toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.js' } }] },
    { id: 't1', role: 'tool', content: body, toolName: 'read_file', toolCallId: 'c1', createdAt: 3 },
    { id: 'u2', role: 'user', content: '继续', createdAt: 4 },
    { id: 'a2', role: 'assistant', content: '', createdAt: 5, toolCalls: [{ id: 'c2', name: 'read_file', args: { path: 'b.js' } }] },
    { id: 't2', role: 'tool', content: 'b.js 只有几行', toolName: 'read_file', toolCallId: 'c2', createdAt: 6 }
  ]
  const without = compact(list, 1000)
  assert.ok(without[2].content.includes('省略'))
  assert.ok(!without[2].content.includes('read_file 读'), '没给 spill 就不该编路径')

  const withSpill = compact(list, 1000, { spill: () => '.roroto/spill/s/abc.txt' })
  assert.ok(withSpill[2].content.includes('.roroto/spill/s/abc.txt'))
  // 掐头留尾仍然成立：中间被省略，两头都在
  assert.ok(withSpill[2].content.startsWith('AAAA'))
  assert.ok(withSpill[2].content.endsWith('BBBB'))
})

test('maskObservations：存下来了就指路，没存才让重新调用', () => {
  const body = `${'Q'.repeat(3000)}`
  const list = [
    { id: 'u1', role: 'user', content: '查日志', createdAt: 1 },
    { id: 't1', role: 'tool', content: body, toolName: 'run_command', createdAt: 2 },
    { id: 'u2', role: 'user', content: '再看别的', createdAt: 3 },
    { id: 'u3', role: 'user', content: '最后一条', createdAt: 4 }
  ]
  const capped = maskObservations(list, 100, { spill: () => '.roroto/spill/s/log.txt' })
  assert.ok(capped[1].content.includes('.roroto/spill/s/log.txt'))
  const plain = maskObservations(list, 100)
  assert.ok(plain[1].content.includes('重新调用'))
})

/**
 * 硬闸：续写拼完仍然不闭合时，绝不落参、绝不执行。
 * 这里把 chat 换掉，模拟「本地 9B 续了半截就 stop」的真实行为。
 */
function brokenCall() {
  const raw =
    '{"path":"index.html","content":"<!DOCTYPE html>\\n<html>\\n<script>\\n' +
    'const a = 1;\\n'.repeat(40) +
    'function draw(){'
  return { id: 'call-1', name: 'write_file', args: { _raw: raw }, argRepair: 'syntax' }
}

function withChat(reply, fn) {
  const providers = require('../dist/main/providers/index.js')
  const original = providers.chat
  providers.chat = async () => ({
    text: reply,
    toolCalls: [],
    finishReason: 'stop',
    usage: { prompt: 10, completion: 10 }
  })
  return Promise.resolve(fn()).finally(() => {
    providers.chat = original
  })
}

test('heal：续写后没闭合 → 拦下不执行，并把半成品存起来', async () => {
  const call = brokenCall()
  let salvaged = ''
  const out = await withChat('const b = 2;', () =>
    healTruncatedWrites({
      provider: { id: 'p', kind: 'llama', baseUrl: 'http://127.0.0.1:1', model: 'm', contextWindow: 8192 },
      messages: [],
      calls: [call],
      signal: new AbortController().signal,
      onSalvage: (text) => {
        salvaged = text
        return '.roroto/spill/s/partial.txt'
      }
    })
  )
  assert.equal(out.rejected, 1)
  assert.equal(out.healed, 0)
  // 参数没被补全 → 工具拿不到 content，绝不会写文件
  assert.equal(call.args.content, undefined)
  assert.ok(call.argRepair, 'argRepair 要留着，外层才会继续按截断处理')
  assert.ok(call.truncRejected.includes('已拦下'))
  assert.ok(call.truncRejected.includes('.roroto/spill/s/partial.txt'))
  // 半成品交出去了，模型可以读回来接着补
  assert.ok(salvaged.includes('<script>'))
  assert.ok(salvaged.includes('const b = 2;'))
})

test('heal：续写后闭合了 → 正常落参，不拦', async () => {
  const call = brokenCall()
  const out = await withChat('}</script></body></html>', () =>
    healTruncatedWrites({
      provider: { id: 'p', kind: 'llama', baseUrl: 'http://127.0.0.1:1', model: 'm', contextWindow: 8192 },
      messages: [],
      calls: [call],
      signal: new AbortController().signal
    })
  )
  assert.equal(out.healed, 1)
  assert.equal(out.rejected, 0)
  assert.equal(call.truncRejected, undefined)
  assert.ok(String(call.args.content).includes('</html>'))
})

test('heal：续了两轮还在被切 → 一样不执行', async () => {
  const call = brokenCall()
  const providers = require('../dist/main/providers/index.js')
  const original = providers.chat
  providers.chat = async () => ({
    text: 'const c = 3;'.repeat(20),
    toolCalls: [],
    finishReason: 'length',
    usage: { prompt: 10, completion: 10 }
  })
  try {
    const out = await healTruncatedWrites({
      provider: { id: 'p', kind: 'llama', baseUrl: 'http://127.0.0.1:1', model: 'm', contextWindow: 8192 },
      messages: [],
      calls: [call],
      signal: new AbortController().signal
    })
    assert.equal(out.rejected, 1)
    assert.equal(call.args.content, undefined)
    assert.ok(call.truncRejected.includes('又被切断'))
  } finally {
    providers.chat = original
  }
})
