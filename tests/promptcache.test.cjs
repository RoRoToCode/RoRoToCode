/**
 * 前缀缓存 / 工具下发 / 观察掩码的回归测试。
 *
 * 这几项的共同点：改动看起来「只是提示词组织」，但一旦把易变内容放回 system，
 * 本地模型每轮就会多烧几千 token 的 prefill —— 从界面上完全看不出来，
 * 只能靠这里的断言守住结构。
 */
const test = require('node:test')
const assert = require('node:assert')

const agent = require('../dist/main/agent.js')
const spec = require('../dist/main/tools/spec.js')

const provider = {
  id: 'llamacpp',
  name: '本地 llama.cpp',
  kind: 'openai',
  runtime: 'llama',
  model: 'Qwen3.5-9B-Q4_K_M.gguf',
  baseUrl: 'http://127.0.0.1:8080'
}

test('系统提示里不能再出现每轮都会变的内容', () => {
  const text = agent.systemPrompt('/tmp/ws', provider, {
    web: true,
    remember: true,
    memory: '构建命令是 npm run build',
    instructions: null,
    summary: null
  })
  assert.ok(!/^当前时间：/m.test(text), '时间戳必须放在本轮环境信息里，否则前缀缓存整段失效')
  assert.ok(!text.includes('自动验证结果'), '验证结论是逐轮的，不能进 system')
  assert.ok(!text.includes('编译诊断'), '诊断结论是逐轮的，不能进 system')
  assert.ok(!text.includes('【继续执行】'), '续跑提示是逐轮的，不能进 system')
  // 稳定内容必须还在：规则、工具用法、记忆都要留在 system 里，不能为了缓存把能力砍掉
  assert.ok(text.includes('工作原则'), '规则应该留在系统提示里')
  assert.ok(text.includes('npm run build'), '长期记忆应该留在系统提示里')
})

test('易变信息进 runtimeBlock，且只拼在本轮最后一条 user 消息上', () => {
  const block = agent.runtimeBlock({
    clock: '2026-11-09 周一 21:30',
    verify: 'npm test 失败：3 个用例挂了',
    nudge: '你只说了要做，没调用工具'
  })
  assert.ok(block.includes('2026-11-09 周一 21:30'))
  assert.ok(block.includes('【自动验证结果】'))
  assert.ok(block.includes('【需要你重做】'))

  const empty = agent.runtimeBlock({ clock: '2026-11-09 周一 21:30' })
  assert.ok(!empty.includes('【自动验证结果】'), '没有验证结果时不该留空标题占 token')
})

test('窗口紧张时收起不常用工具，但通过 toolbox 仍然可达', () => {
  const full = spec.toolSpecs
  const narrow = agent.pickTools(full, 16 * 1024)
  const names = narrow.list.map((t) => t.name)
  assert.ok(names.includes('toolbox'), '收起工具后必须给出网关，否则能力就真没了')
  assert.ok(names.includes('read_file') && names.includes('edit_file'), '开工必需的工具不能被收走')
  assert.ok(!names.includes('git'), 'git 应该走网关')
  assert.ok(!names.includes('terminal'), 'terminal 应该走网关')
  assert.ok(narrow.hidden.some((t) => t.name === 'git'))

  const wide = agent.pickTools(full, 64 * 1024)
  assert.equal(wide.hidden.length, 0, '窗口够大就全量下发')
  assert.ok(!wide.list.map((t) => t.name).includes('toolbox'), '全量下发时不该白占一个网关位')
})

test('技能：只在打开开关时进系统提示，且正文不进（渐进披露）', () => {
  const base = {
    web: true,
    remember: true,
    memory: null,
    instructions: null,
    summary: null
  }

  // 没有开启任何技能：一个字都不该多占
  const off = agent.systemPrompt('/tmp/ws', provider, base)
  assert.ok(!off.includes('可调用技能'), '没开开关时不该出现技能目录')
  assert.ok(!off.includes('use_skill'), '没开开关时不该教它用这个工具')

  // 开着时只给名字和说明，正文留给 use_skill 现取
  const on = agent.systemPrompt('/tmp/ws', provider, {
    ...base,
    skills: [{ name: 'pdf-workshop', desc: '拆分 / 合并 / 转图片这些 PDF 活' }]
  })
  assert.ok(on.includes('【可调用技能】'), '开了开关就要告诉模型有哪些技能')
  assert.ok(on.includes('pdf-workshop'), '技能名必须出现，否则模型无法取用')
  assert.ok(on.includes('use_skill'), '要给调用入口')
  assert.ok(!on.includes('PDF-LONG-BODY'), '技能正文不能整篇塞进系统提示')

  // 技能入口不能被收进网关：提示里正在让模型「用 use_skill 取步骤」，
  // 藏起来它就得先猜一层网关，小窗口下这个技能等于不可用
  const narrow = agent.pickTools(spec.toolSpecs, 16 * 1024)
  assert.ok(narrow.list.map((t) => t.name).includes('use_skill'))
})

test('toolbox 展开成真名，且不存在的名字不会被当成调用', () => {
  const universe = spec.toolSpecs
  const call = { id: 'c1', name: 'toolbox', args: { tool: 'git', args: { action: 'status' } } }
  const out = agent.unwrapToolbox(call, universe)
  assert.equal(out.name, 'git', '展开后风险/审批/钩子都按真工具走')
  assert.deepEqual(out.args, { action: 'status' })

  assert.equal(agent.unwrapToolbox({ id: 'c2', name: 'toolbox', args: {} }, universe), null, '只要清单时不展开')
  assert.equal(
    agent.unwrapToolbox({ id: 'c3', name: 'toolbox', args: { tool: 'rm_rf' } }, universe),
    null,
    '不存在的工具交给网关回清单'
  )
  assert.equal(agent.unwrapToolbox({ id: 'c4', name: 'read_file', args: {} }, universe), null)
})

test('超阈值时折叠较早的工具输出，最近一轮原样保留', () => {
  const big = 'x'.repeat(5000)
  const mk = (id, role, content, extra = {}) => ({ id, role, content, createdAt: 1, ...extra })
  const list = [
    mk('1', 'user', '帮我看看这个仓库'),
    mk('2', 'assistant', '我读一下'),
    mk('3', 'tool', big, { toolName: 'read_file' }),
    mk('4', 'assistant', '这是现状'),
    mk('5', 'user', '继续修'),
    mk('6', 'tool', big, { toolName: 'grep' })
  ]
  // 预算很小 → 触发折叠
  const masked = agent.maskObservations(list, 800)
  assert.ok(masked[2].content.length < 1000, '早期工具输出应被折叠')
  assert.ok(masked[2].content.includes('较早的工具输出已折叠'))
  assert.equal(masked[5].content, big, '最近一条工具输出必须原样保留')

  // 已经折叠过的不重复处理（幂等：否则每轮都在改历史，缓存又废了）
  const twice = agent.maskObservations(masked, 800)
  assert.equal(twice[2].content, masked[2].content)

  // 预算充足时一个字节都不动
  const untouched = agent.maskObservations(list, 999999)
  assert.deepEqual(untouched, list)
})
