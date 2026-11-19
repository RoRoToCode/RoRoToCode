const test = require('node:test')
const assert = require('node:assert/strict')
const { exploreTools, filterSubagentTools, withExploreNav, childPrompt } = require('../dist/main/subagent.js')

/**
 * 只读探查子 agent（task 工具 mode=explore）的核心契约：
 * 1. 白名单里只有读/查/搜工具，任何「改文件 / 跑命令」的工具都不该在；
 * 2. explore 模式过滤后，写类工具被剔除、只读工具保留；
 * 3. 非 explore 模式（不传 mode）原样返回，不影响现有派活路径。
 */

test('explore 白名单：不含任何改文件 / 跑命令的工具', () => {
  const set = exploreTools()
  const forbidden = ['write_file', 'edit_file', 'patch', 'run_shell', 'shell_bg', 'format', 'task', 'handoff']
  for (const name of forbidden) {
    assert.equal(set.has(name), false, `explore 白名单不该包含 ${name}`)
  }
  // 只读工具必须在
  const required = ['read_file', 'list_dir', 'glob', 'grep', 'goto_definition', 'find_references', 'repo_map', 'web_search', 'web_fetch']
  for (const name of required) {
    assert.equal(set.has(name), true, `explore 白名单必须包含 ${name}`)
  }
})

test('explore 模式过滤：写类工具被剔除，只读工具保留', () => {
  const tools = [
    { name: 'read_file', description: '', parameters: {} },
    { name: 'grep', description: '', parameters: {} },
    { name: 'write_file', description: '', parameters: {} },
    { name: 'edit_file', description: '', parameters: {} },
    { name: 'patch', description: '', parameters: {} },
    { name: 'run_shell', description: '', parameters: {} },
    { name: 'web_search', description: '', parameters: {} }
  ]
  const filtered = filterSubagentTools(tools, 'explore')
  const names = filtered.map((t) => t.name).sort()
  assert.deepEqual(names, ['grep', 'read_file', 'web_search'])
})

test('非 explore 模式：工具表原样返回', () => {
  const tools = [
    { name: 'read_file', description: '', parameters: {} },
    { name: 'write_file', description: '', parameters: {} },
    { name: 'run_shell', description: '', parameters: {} }
  ]
  assert.equal(filterSubagentTools(tools, null), tools)
  assert.equal(filterSubagentTools(tools, undefined), tools)
  // 引用相等：不复制、不重排，保证现有派活路径零行为变化
  assert.equal(filterSubagentTools(tools, null).length, 3)
})

test('嵌套封顶：depth>=1 的孙 agent 不再拿到 task 工具', () => {
  const tools = [
    { name: 'read_file', description: '', parameters: {} },
    { name: 'write_file', description: '', parameters: {} },
    { name: 'task', description: '', parameters: {} }
  ]
  // 子 agent（depth 0）保留 task，能派孙
  assert.equal(filterSubagentTools(tools, null, 0).some((t) => t.name === 'task'), true)
  // 孙 agent（depth 1）不再拿到 task，封顶
  assert.equal(filterSubagentTools(tools, null, 1).some((t) => t.name === 'task'), false)
  assert.equal(filterSubagentTools(tools, null, 2).some((t) => t.name === 'task'), false)
  // 其它工具不受影响
  const names = filterSubagentTools(tools, null, 1).map((t) => t.name).sort()
  assert.deepEqual(names, ['read_file', 'write_file'])
})

/**
 * lean 模式（小窗口）下父会话的工具表里没有 LSP 导航工具 —— 它们在 toolbox 网关后面，
 * 而 toolbox 不能进只读白名单（能展开出 git / terminal）。所以 explore 子 agent
 * 必须靠 withExploreNav 把它们补回来，否则「审查」只能靠 grep 猜文本。
 */
test('withExploreNav：小窗口下补回跳定义 / 查引用', () => {
  const lean = [
    { name: 'read_file', description: '', parameters: {} },
    { name: 'grep', description: '', parameters: {} },
    { name: 'repo_map', description: '', parameters: {} }
  ]
  const nav = withExploreNav(lean)
  const names = nav.map((t) => t.name)
  assert.equal(names.includes('goto_definition'), true)
  assert.equal(names.includes('find_references'), true)
  // 原有工具不能被顶掉
  assert.equal(names.includes('read_file'), true)
  assert.equal(nav.length, lean.length + 2)
  // 补进来的必须带完整 spec（有 parameters），否则下发出去模型不会用
  for (const name of ['goto_definition', 'find_references']) {
    const spec = nav.find((t) => t.name === name)
    assert.equal(typeof spec.description, 'string')
    assert.ok(spec.parameters && typeof spec.parameters === 'object', `${name} 缺少 parameters`)
  }
})

test('withExploreNav：已有就不重复加，且不破坏引用', () => {
  const full = [
    { name: 'read_file', description: '', parameters: {} },
    { name: 'goto_definition', description: 'x', parameters: {} },
    { name: 'find_references', description: 'x', parameters: {} }
  ]
  const out = withExploreNav(full)
  assert.equal(out, full, '两个导航工具都在时应原样返回同一个数组')
})

/**
 * 补回来的导航工具必须仍在白名单里 —— 否则 filterSubagentTools 会把它们再剔除一次，
 * 这道修复就白做了。
 */
test('补回的导航工具能通过 explore 过滤', () => {
  const lean = [{ name: 'read_file', description: '', parameters: {} }]
  const filtered = filterSubagentTools(withExploreNav(lean), 'explore').map((t) => t.name)
  assert.equal(filtered.includes('goto_definition'), true)
  assert.equal(filtered.includes('find_references'), true)
  // 补完也不能顺手带进写类工具
  assert.deepEqual(filtered.sort(), ['find_references', 'goto_definition', 'read_file'])
})

/**
 * 子 agent 的规则编号必须连续。
 *
 * 只读和完整两套分支条数不同，早先用两段字面量写死编号，只读分支多出一条
 * 「审查输出格式」后编号就断了（1,2,3,4,5 变成 1,2,3,4,5 而完整分支跳号）。
 * 模型看到跳号会以为「少了一条」，反复猜规则内容 —— 这里直接断言连续性。
 */
function numberedRules(prompt) {
  const nums = []
  for (const line of prompt.split('\n')) {
    const m = /^(\d+)\. /.exec(line)
    if (m) nums.push(Number(m[1]))
  }
  return nums
}

test('子 agent 提示：规则编号从 1 开始连续，不跳号不重号', () => {
  for (const mode of ['explore', null]) {
    const nums = numberedRules(childPrompt('/tmp/ws', true, null, mode))
    assert.deepEqual(
      nums,
      nums.map((_n, i) => i + 1),
      `${mode ?? '完整'}模式的规则编号不连续：${nums.join(',')}`
    )
  }
})

test('只读探查提示：要求审查类结论按「问题→位置→影响→建议」给，且限 5 条', () => {
  const explore = childPrompt('/tmp/ws', true, null, 'explore')
  assert.ok(explore.includes('可以合'), '要给出可判定的结论词')
  assert.ok(explore.includes('最多 5 条'), '上限必须写死，否则几路结论没法合')
  assert.ok(explore.includes('文件:行'), '每条问题必须带位置')
  assert.ok(explore.includes('不要为了显得认真而挑刺'), '没问题时不许编')

  // 完整模式不改交付格式：它要写文件，不该被审查格式绑住
  const full = childPrompt('/tmp/ws', true, null, null)
  assert.ok(!full.includes('最多 5 条'))
  assert.ok(full.includes('write_file'), '完整模式要说明能写文件')
})

/* ------------------------------------------------------------------ *
 * 自动派发（autoDelegate）：程序提醒模型「该派一个只读子 agent 了」
 *
 * 这条通道只注入一句提示，派几个/派什么仍由模型决定。测试要守住的契约：
 * 1. 该触发的场景（审查意图、多文件摸底）真的触发；
 * 2. 不该触发的场景（寒暄、纯问答、计划模式、非交互、没有 task 工具）一律不触发；
 * 3. 文案只说 mode=explore（只读），绝不把「会写文件的子任务」带进自动通道。
 * ------------------------------------------------------------------ */
const agentMod = require('../dist/main/agent.js')
const { delegateHint, delegateNoteText, runtimeBlock, lastUserText } = agentMod

const allow = (text, extra = {}) =>
  delegateHint({ text, step: 0, hasTask: true, enabled: true, ...extra })

test('自动派发：审查意图命中 review', () => {
  assert.equal(allow('检查这个项目的配置读取和错误处理有没有问题'), 'review')
  assert.equal(allow('帮我审查一下 src/main/agent.ts 最近的改动'), 'review')
  assert.equal(allow('这段代码对不对，帮我 review 一下'), 'review')
})

test('自动派发：故障报障型口语命中 review（带代码语境）', () => {
  // 15:30 实测漏派的真实原话，以及一整类「东西坏了去修」的说法
  assert.equal(allow('打开 sgf文件后 ，棋子的数量 不对'), 'review')
  assert.equal(allow('sgf文件棋子数量不对'), 'review')
  assert.equal(allow('棋子数量错了'), null, '无代码语境的报障仍不该派')
  assert.equal(allow('脚本执行后黑子数量不正确'), 'review')
  assert.equal(allow('这个功能坏了，打不开'), null, '没有代码语境词，防误派')
  assert.equal(allow('ui.py 里这个功能坏了'), 'review')
  assert.equal(allow('棋子的显示不对劲，配置文件里看看'), 'review')
  assert.equal(allow('src/main/board.py 算错了'), 'review')
})

test('自动派发：故障词单独出现不触发（守住代码语境闸门）', () => {
  // 「不对 / 错了 / 坏了」是日常高频词，没有代码语境一律不派
  assert.equal(allow('今天心情不对'), null)
  assert.equal(allow('这个想法错了'), null)
  assert.equal(allow('手机坏了'), null)
  assert.equal(allow('你觉得这个思路对不对，我们该先做哪一块'), null)
})

test('自动派发：多文件摸底命中 survey', () => {
  assert.equal(allow('把这个项目的鉴权链路梳理一下'), 'survey')
  assert.equal(allow('把 src 目录下所有模块的日志调用统一一下'), 'survey')
  // 长需求通常就是多文件的活
  const long = '我这边有个模块最近老是出问题，麻烦你去看一下它的实现，把相关的配置读取和错误处理都过一遍，然后把不安全的地方列出来'
  assert.equal(allow(long), 'survey')
})

test('自动派发：寒暄 / 纯问答 / 无代码语境一律不触发', () => {
  // 寒暄
  assert.equal(allow('你好'), null)
  assert.equal(allow('好的，谢谢！'), null)
  // 太短
  assert.equal(allow('改一下'), null)
  // 有「对不对」但没有代码语境：这是问观点，不是查代码
  assert.equal(allow('你觉得这个思路对不对，我们该先做哪一块'), null)
  // 纯知识问答
  assert.equal(allow('React 的 useEffect 和 useLayoutEffect 有什么区别'), null)
})

test('自动派发：门禁条件（步数 / 开关 / 工具 / 计划模式 / 非交互）', () => {
  const text = '帮我审查一下这个项目的错误处理'
  assert.equal(allow(text), 'review', '基线：正常情况应命中')
  assert.equal(allow(text, { step: 1 }), null, '只在第一步提醒，后面每步都念会让它反复派')
  assert.equal(allow(text, { enabled: false }), null, '开关关掉就不提醒')
  assert.equal(allow(text, { hasTask: false }), null, 'task 不在工具表里（小模型/档案白名单）就别提')
  assert.equal(allow(text, { planMode: true }), null, '计划模式本来就不许动手')
  assert.equal(allow(text, { nonInteractive: true }), null, '定时任务/交接没人盯着，不白烧 token')
})

test('自动派发：文案只说只读 explore，且并行与否措辞不同', () => {
  for (const kind of ['review', 'survey']) {
    const serial = delegateNoteText(kind, false)
    const par = delegateNoteText(kind, true)
    assert.ok(serial.includes('mode=explore'), '必须点名只读模式')
    assert.ok(par.includes('mode=explore'))
    assert.ok(!serial.includes('2～3 个'), '本机单槽不该劝多路')
    assert.ok(par.includes('2～3 个'), '能真并发时鼓励分头查')
    // 绝不把会写文件的子任务带进自动通道
    assert.ok(!/派.*task\((?!mode=explore)/.test(serial))
    assert.ok(serial.includes('不要反复派'), '提醒只生效一次，否则长任务会反复派')
  }
})

test('runtimeBlock：delegate 段落有就出现、没有就不占 token，且排在验证结论之前', () => {
  const note = delegateNoteText('review', false)
  const withTip = runtimeBlock({ clock: '2026-11-19 12:00', delegate: note, verify: 'npm test 失败' })
  assert.ok(withTip.includes('【自动派发】'))
  // 派发是「开工第一步」，必须排在「改完再修」的验证结论前面
  assert.ok(withTip.indexOf('【自动派发】') < withTip.indexOf('【自动验证结果】'))

  const without = runtimeBlock({ clock: '2026-11-19 12:00' })
  assert.ok(!without.includes('自动派发'))
})

/**
 * 断点续跑的回归：resume() 写进会话的「继续。上次执行被中断了…」必须带 id='continue'，
 * 好让 lastUserText() 跳过它、回溯到用户原始那句带审查/摸底意图的话。
 * 否则续跑那一轮 delegateHint() 只会看到这句没有代码语境的注入文字 -> 返回 null -> 子 agent 再也不启动。
 */
const msg = (id, role, content) => ({ id, role, content, createdAt: Date.now() })

test('lastUserText：跳过 resume 注入的 continue 消息，回溯到用户原始意图', () => {
  const session = {
    messages: [
      msg('u1', 'user', '帮我审查一下这个项目的错误处理有没有问题'),
      msg('a1', 'assistant', '好的，我先看看'),
      msg('c1', 'user', '继续。上次执行被中断了，请从断点接着做完，不要重复已经完成的部分。')
    ]
  }
  // id='continue' 是程序注入标记：这句「继续…」不是用户意图，必须被跳过
  session.messages[2].id = 'continue'
  assert.match(lastUserText(session), /审查/)
  // 用回溯到的原话判派发，仍能命中 review（正是续跑前漏掉的那一步）
  assert.equal(delegateHint({ text: lastUserText(session), step: 0, hasTask: true, enabled: true }), 'review')
})

test('lastUserText：普通 uuid 的续跑消息会盖住意图（回归护栏，说明为何必须打 continue 标记）', () => {
  const session = {
    messages: [
      msg('u1', 'user', '帮我审查一下这个项目的错误处理有没有问题'),
      msg('a2', 'user', '继续。上次执行被中断了，请从断点接着做完。')
    ]
  }
  // 这条若是普通 id，就会被当成用户原话 —— 里面没有代码语境，delegateHint 落空
  assert.match(lastUserText(session), /继续/)
  assert.equal(delegateHint({ text: lastUserText(session), step: 0, hasTask: true, enabled: true }), null)
})

test('lastUserText：runtime / compact-user 注入消息同样跳过，附件正文被切掉', () => {
  const session = {
    messages: [
      msg('u1', 'user', '检查这个脚本有没有问题'),
      msg('runtime', 'user', '【本轮环境】…'),
      msg('compact-user', 'user', '（压缩摘要）…'),
      msg('u2', 'user', '看一下 src/main/agent.ts' + '----- 以下正文由程序自动' + '整份源码')
    ]
  }
  const text = lastUserText(session)
  assert.ok(text.startsWith('看一下 src/main/agent.ts'), '应取最后一条真实用户消息')
  assert.ok(!text.includes('整份源码'), '附件正文不能混进意图判定')
})
