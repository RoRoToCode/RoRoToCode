const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const providers = require('../dist/main/providers')
const tools = require('../dist/main/tools')
const changes = require('../dist/main/changes')
const lsp = require('../dist/main/lsp')
const { runSubAgent } = require('../dist/main/subagent')
const { leaseHolder, resetFileLeases } = require('../dist/main/lease')

/**
 * 写文件租约在**真派活链路**里的验证（不是纯函数单测）。
 *
 * 原来的漏洞：一批子任务按 laneCount 并行跑，两个都写同一个文件时，
 * 后写的那份把前一份覆盖掉，而「改前快照」各自拿着对方写之前的内容 ——
 * 用户点撤销，撤回来的是另一个任务的半成品。
 *
 * 判据用「执行并发峰值」：两路写同一个文件必须排队（峰值 1），
 * 各写各的文件必须还是 2（锁不能退化成全局串行）。
 */

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'roroto-lease-int-'))
const realChat = providers.chat
const realExecute = tools.executeTool
const realChange = changes.recordChange
const realDiag = lsp.diagnoseReport

test.before(() => {
  // 这两处只跟会话落库 / LSP 有关，和锁无关，换成轻量桩
  changes.recordChange = async () => null
  lsp.diagnoseReport = async () => ({ diags: [], skipped: 'unavailable' })
})

test.after(() => {
  providers.chat = realChat
  tools.executeTool = realExecute
  changes.recordChange = realChange
  lsp.diagnoseReport = realDiag
  fs.rmSync(ws, { recursive: true, force: true })
})

test.beforeEach(() => resetFileLeases())

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const opts = (id, over = {}) => ({
  id,
  callId: `call-${id}`,
  sessionId: 'sess-lease',
  description: '写一个文件',
  prompt: '把结果写进 same.txt',
  workspace: ws,
  provider: { id: 'p', name: 'P', kind: 'openai', baseUrl: 'https://api.example.com/v1', model: 'test-model', contextWindow: 32768 },
  budget: 8000,
  maxSteps: 1,
  tools: require('../dist/main/tools/spec.js').toolSpecs,
  signal: new AbortController().signal,
  web: false,
  approve: async () => true,
  onChange: () => undefined,
  onUpdate: () => undefined,
  ...over
})

/**
 * 子 agent 每一步都调 write_file；收尾请求（无工具表）回一句总结。
 * 写哪个文件从这次任务的 prompt（「写进 X」）里取 —— 每路子任务各自独立。
 */
function stubWriteByPrompt() {
  providers.chat = async (req) => {
    if (req.tools.length === 0) return { text: '写完了', toolCalls: [] }
    const user = [...req.messages].reverse().find((m) => m.role === 'user')
    const target = /写进 (\S+)/.exec(user?.content ?? '')?.[1] ?? 'same.txt'
    return {
      text: '',
      toolCalls: [{ id: 'w', name: 'write_file', args: { path: target, content: 'x' } }],
      usage: { prompt: 10, completion: 2 }
    }
  }
}

/** 记录 executeTool 的并发峰值：锁生效时同一个文件的峰值为 1 */
function spyExecute(delayMs) {
  const stat = { now: 0, peak: 0 }
  tools.executeTool = async (name, args, ctx) => {
    if (name !== 'write_file') return realExecute(name, args, ctx)
    stat.now++
    stat.peak = Math.max(stat.peak, stat.now)
    await sleep(delayMs)
    stat.now--
    return `已写入 ${args.path}`
  }
  return stat
}

test('两路子任务写同一个文件：执行被串行化（并发峰值 1）', async () => {
  const stat = spyExecute(30)
  stubWriteByPrompt()
  const [a, b] = await Promise.all([runSubAgent(opts('sub-a')), runSubAgent(opts('sub-b'))])

  assert.equal(a.status, 'ok')
  assert.equal(b.status, 'ok')
  assert.equal(stat.peak, 1, '同一个文件上的写入必须排队，不能同时进行')
})

test('两路子任务各写各的文件：仍然真并行（锁没有退化成全局串行）', async () => {
  const stat = spyExecute(30)
  stubWriteByPrompt()
  const [a, b] = await Promise.all([
    runSubAgent(opts('sub-a', { prompt: '把结果写进 x.txt' })),
    runSubAgent(opts('sub-b', { prompt: '把结果写进 y.txt' }))
  ])

  assert.equal(a.status, 'ok')
  assert.equal(b.status, 'ok')
  assert.equal(stat.peak, 2, '不同文件之间不该互相等')
})

test('跑完之后不留下锁（后面派的活不会因此卡住）', async () => {
  spyExecute(1)
  stubWriteByPrompt()
  await runSubAgent(opts('sub-a'))
  assert.equal(leaseHolder(path.join(ws, 'same.txt')), undefined)
})
