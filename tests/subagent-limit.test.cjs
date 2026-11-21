const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const providers = require('../dist/main/providers')
const { runSubAgent } = require('../dist/main/subagent.js')

/**
 * 子 agent 的两条硬约束 —— 都是「不修就会静默亏掉一整轮工作」的那种：
 *
 * 1. **步数用尽不许丢结论**：跑满 maxSteps 时补一次不带工具的请求，要它用纯文本
 *    把已经做完的部分交出来（opencode 在 steps 上限那一步也是这么收的）。
 *    收尾也失败才退回「按工具名统计」的摘要，绝不再回一句「没有产出总结」。
 * 2. **子 agent 的 token 要进账**：以前整条链路没有 usage 处理，并行三路时
 *    界面花费、单次上限、每日配额全按「没花钱」算。
 *
 * chat 用桩替换：这里验的是调度与记账，不是任何一家的 HTTP 细节。
 */

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'roroto-subagent-'))
const file = path.join(ws, 'a.txt')
fs.writeFileSync(file, 'hello\n', 'utf8')

const realChat = providers.chat
test.after(() => {
  providers.chat = realChat
  fs.rmSync(ws, { recursive: true, force: true })
})

const baseOpts = (over = {}) => ({
  id: 'sub-1',
  callId: 'call-1',
  sessionId: 'sess-1',
  description: '看一眼 a.txt',
  prompt: '读一下 a.txt 里写了什么',
  workspace: ws,
  provider: { id: 'p', name: 'P', kind: 'openai', baseUrl: 'https://api.example.com/v1', model: 'test-model', contextWindow: 32768 },
  budget: 8000,
  maxSteps: 2,
  tools: require('../dist/main/tools/spec.js').toolSpecs,
  signal: new AbortController().signal,
  web: false,
  approve: async () => true,
  onChange: () => undefined,
  onUpdate: () => undefined,
  ...over,
})

/** 每一步都调一次 read_file，从不给总结 —— 逼出「步数用尽」那条路 */
function stubStepsOnFile(calls, usage) {
  providers.chat = async (req) => {
    calls.push({ tools: req.tools.length, messages: req.messages.length })
    if (req.tools.length === 0) {
      // 收尾请求：没有工具表，只能说话
      return { text: '已经读完 a.txt，内容是 hello；没有改动任何文件。', toolCalls: [], usage }
    }
    return {
      text: '',
      toolCalls: [{ id: `c${calls.length}`, name: 'read_file', args: { path: 'a.txt' } }],
      usage
    }
  }
}

test('步数用尽：补一次不带工具的收尾请求，结论不丢', async () => {
  const calls = []
  stubStepsOnFile(calls, { prompt: 100, completion: 20 })

  const done = await runSubAgent(baseOpts())

  assert.equal(done.status, 'ok', '拿到收尾总结就不该再判失败')
  assert.match(done.summary, /步数用尽/)
  assert.match(done.summary, /已经读完 a\.txt/, '收尾请求说出来的话必须回传给父 agent')
  assert.equal(calls.length, 3, '2 步 + 1 次收尾请求')
  assert.equal(calls.at(-1).tools, 0, '收尾请求必须撤掉工具，否则它还会接着读文件')
  assert.match(done.note ?? '', /步数用尽/)
})

test('步数用尽：收尾也失败时按工具名统计，不再只回「没有产出总结」', async () => {
  let n = 0
  providers.chat = async (req) => {
    n++
    if (req.tools.length === 0) throw new Error('HTTP 500')
    return {
      text: '',
      toolCalls: [{ id: `c${n}`, name: 'read_file', args: { path: 'a.txt' } }],
      usage: { prompt: 10, completion: 1 }
    }
  }

  const done = await runSubAgent(baseOpts())
  assert.equal(done.status, 'fail')
  assert.match(done.summary, /已执行的工具调用/)
  assert.match(done.summary, /read_file ×2/, '至少要说清它做了什么')
})

test('用量进账：每一步 + 收尾的 token 都回调给父会话', async () => {
  const calls = []
  stubStepsOnFile(calls, { prompt: 100, completion: 20 })
  const deltas = []
  const done = await runSubAgent(baseOpts({ onUsage: (d) => deltas.push(d) }))

  assert.equal(done.status, 'ok')
  assert.equal(deltas.length, 3, '2 步 + 收尾，每次真请求都要记一笔')
  const prompt = deltas.reduce((n, d) => n + d.prompt, 0)
  const completion = deltas.reduce((n, d) => n + d.completion, 0)
  assert.equal(prompt, 300)
  assert.equal(completion, 60)
})

test('用量进账：供应商不给 usage 时不编数字', async () => {
  const calls = []
  stubStepsOnFile(calls, undefined)
  const deltas = []
  await runSubAgent(baseOpts({ onUsage: (d) => deltas.push(d) }))
  assert.equal(deltas.length, 0, '本地服务不给 usage 就跳过，不估一个假值')
})

test('正常收工时不该多发收尾请求', async () => {
  providers.chat = async () => ({ text: '读完了，没问题。', toolCalls: [], usage: { prompt: 5, completion: 2 } })
  const done = await runSubAgent(baseOpts())
  assert.equal(done.status, 'ok')
  assert.equal(done.summary.trim(), '读完了，没问题。')
  assert.doesNotMatch(done.summary, /步数用尽/)
})
