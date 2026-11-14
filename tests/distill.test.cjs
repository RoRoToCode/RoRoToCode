/**
 * /learn 的纯逻辑单测：轨迹压缩与模型输出解析。
 * 真正调模型那步在 smoke:learn 里用假服务验。
 */
const test = require('node:test')
const assert = require('node:assert')
const { condenseTrace, parseDistilled, TRACE_LIMIT } = require('../dist/shared/distill.js')

const msg = (role, content, extra = {}) => ({ id: `${role}${Math.random()}`, role, content, createdAt: 0, ...extra })

test('轨迹保留工具调用参数和结论，丢掉客套话', () => {
  const text = condenseTrace([
    msg('user', '给接口加上限流'),
    msg('assistant', '好的，我来看看'),
    msg('assistant', '', { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'src/api.ts' } }] }),
    msg('tool', '文件内容……', { toolName: 'read_file', toolCallId: 'c1' }),
    msg('assistant', '改好了，限流加在 src/api.ts 的中间件里，测试通过。')
  ])
  assert.match(text, /\[用户\] 给接口加上限流/)
  assert.match(text, /\[调用\] read_file .*src\/api\.ts/)
  assert.match(text, /\[说明\] 改好了/)
  assert.doesNotMatch(text, /好的，我来看看/, '空客套不该进轨迹')
})

test('工具失败会被标出来，蒸馏时才知道哪条路走不通', () => {
  const text = condenseTrace([
    msg('assistant', '', { toolCalls: [{ id: 'c1', name: 'run_shell', args: { command: 'pnpm test' } }] }),
    msg('tool', '执行失败：pnpm 不是内部或外部命令', { toolName: 'run_shell', toolCallId: 'c1' })
  ])
  assert.match(text, /\[结果·失败\] run_shell/)
})

test('超长轨迹砍头留尾：最后怎么成的才是重点', () => {
  const many = Array.from({ length: 80 }, (_, i) =>
    msg('assistant', '', { toolCalls: [{ id: `c${i}`, name: 'read_file', args: { path: `src/f${i}.ts` } }] })
  )
  const text = condenseTrace(many, 400)
  assert.ok(text.length <= 400 + 20, '要按上限截断')
  assert.match(text, /前段已省略/)
  assert.match(text, /src\/f79\.ts/, '最新的几步必须留着')
  assert.doesNotMatch(text, /src\/f0\.ts/, '最早的几步应该被砍掉')
})

test('默认上限就是 TRACE_LIMIT', () => {
  const many = Array.from({ length: 400 }, () => msg('user', 'x'.repeat(200)))
  assert.ok(condenseTrace(many).length <= TRACE_LIMIT + 20)
})

test('解析：直接给 JSON', () => {
  const r = parseDistilled('{"name":"加限流","desc":"接口要被刷时","prompt":"1. 找到中间件"}')
  assert.deepStrictEqual(r, { name: '加限流', desc: '接口要被刷时', prompt: '1. 找到中间件' })
})

test('解析：套了 ```json 代码块、前后还有解释也能抠出来', () => {
  const raw = '好的，这是技能：\n```json\n{"name":"加限流","prompt":"1. 找中间件"}\n```\n希望有用'
  const r = parseDistilled(raw)
  assert.equal(r.name, '加限流')
  assert.equal(r.desc, '')
})

test('解析：不是 JSON 就返回 null（上层退回原文，不丢结果）', () => {
  assert.equal(parseDistilled('这里没有结构化的东西'), null)
  assert.equal(parseDistilled('{"name":"","prompt":"x"}'), null, '缺名字不算数')
  assert.equal(parseDistilled('{"name":"x"}'), null, '缺指令不算数')
})
