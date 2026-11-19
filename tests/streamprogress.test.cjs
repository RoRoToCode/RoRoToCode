/**
 * 实时生成进度（gen_progress 的源头）必须把**工具参数**也算进去。
 *
 * 历史问题：写文件的耗时全在 tool_calls 的 arguments 里，正文一直是空的。
 * 如果只统计正文，界面在几分钟的大文件生成期间一个数字都不涨，
 * 用户看到的就是「在转圈但什么都没产出」。
 */
const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const { streamOpenAI } = require('../dist/main/providers/openai.js')

/** 起一个假 OpenAI 兼容服务，按帧吐 SSE */
function fakeServer(frames) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

const provider = (port) => ({
  id: 'fake',
  name: 'fake',
  kind: 'openai',
  baseUrl: `http://127.0.0.1:${port}/v1`,
  model: 'fake-model',
  apiKey: '',
  contextWindow: 8192,
  temperature: 0.2
})

test('写文件的参数帧也要计入实时生成量', async () => {
  // 1 帧正文 + 4 帧工具参数：以前只会报到 1
  const frames = [
    { choices: [{ delta: { content: '好的，' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: '{"path":"a.html",' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"<!DOCTYPE' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' html><html>' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}</body></html>"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
  ]
  const { server, port } = await fakeServer(frames)
  try {
    const seen = []
    const result = await streamOpenAI({
      provider: provider(port),
      messages: [{ id: 'u1', role: 'user', content: '写个页面', createdAt: Date.now() }],
      tools: [],
      signal: new AbortController().signal,
      onText: () => undefined,
      onProgress: (n) => seen.push(n)
    })
    assert.ok(seen.length > 0, '应该持续上报生成量')
    assert.strictEqual(result.toolCalls.length, 1, '工具调用要正常解析出来')
    assert.ok(result.toolCalls[0].args.path === 'a.html', JSON.stringify(result.toolCalls[0].args))
    // 1 帧正文 + 4 帧参数 = 5
    assert.strictEqual(seen[seen.length - 1], 5, `最后一次上报应是 5，实际 ${seen.join(',')}`)
    // 必须单调不减，否则界面上的数字会往回跳
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], `进度不能回退：${seen.join(',')}`)
  } finally {
    server.close()
  }
})
