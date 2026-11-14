/**
 * 工具参数容错的单测。
 *
 * 这套东西的每一行都是被真实模型打出来的坏 JSON 逼出来的，所以测的不是「函数返回什么」，
 * 而是「模型这么写，最后能不能跑」：尾逗号、单引号、裸键、True/None、裸换行、
 * 代码块、前后寒暄、{input:{}}、file_path、写到一半被截断。
 *
 * 有一条防线单独验：**截断的字符串不许抢救**。半个文件内容写进磁盘，比这次调用失败严重得多。
 */
const test = require('node:test')
const assert = require('node:assert')
const {
  parseArgs,
  settleToolArgs,
  relaxJson,
  stripWrapping,
  parseLoose,
  balancedEnd,
  RAW_ARG_KEY
} = require('../dist/shared/toolargs.js')

const READ = {
  properties: { path: { type: 'string' }, offset: { type: 'number' } },
  required: ['path']
}
const WRITE = {
  properties: { path: { type: 'string' }, content: { type: 'string' } },
  required: ['path', 'content']
}

test('合法 JSON 原样通过，一个字段都不动', () => {
  const p = parseArgs('{"path":"src/a.ts","offset":10}', READ)
  assert.strictEqual(p.repair, 'none')
  assert.deepStrictEqual(p.args, { path: 'src/a.ts', offset: 10 })
  assert.deepStrictEqual(p.missing, [])
  assert.strictEqual(p.usable, true)
})

test('尾逗号', () => {
  const p = parseArgs('{"path":"a.ts",}', READ)
  assert.strictEqual(p.repair, 'syntax')
  assert.strictEqual(p.args.path, 'a.ts')
  assert.strictEqual(p.usable, true)
})

test('尾逗号出现在数组和嵌套对象里也裁得掉', () => {
  const p = parseArgs('{"path":"a.ts","list":[1,2,],}', { properties: { path: { type: 'string' }, list: { type: 'array' } }, required: ['path'] })
  assert.deepStrictEqual(p.args.list, [1, 2])
})

test('单引号', () => {
  const p = parseArgs("{'path': 'src/b.ts'}", READ)
  assert.strictEqual(p.repair, 'syntax')
  assert.strictEqual(p.args.path, 'src/b.ts')
})

test('单引号串里本身带单引号的词不会被改坏', () => {
  // 无脑 replace(/'/g,'"') 会把这句变成 "it"s fine" 直接炸
  const p = parseArgs(`{'content': 'it\\'s fine'}`, WRITE)
  assert.strictEqual(p.args.content, "it's fine")
})

test('键没加引号', () => {
  const p = parseArgs('{path: "c.ts", offset: 3}', READ)
  assert.strictEqual(p.args.path, 'c.ts')
  assert.strictEqual(p.args.offset, 3)
})

test('Python 字面量 True / None', () => {
  const p = parseArgs('{"path": "d.ts", "flag": True, "other": None}', {
    properties: { path: { type: 'string' }, flag: { type: 'boolean' }, other: { type: 'string' } },
    required: ['path']
  })
  assert.strictEqual(p.args.flag, true)
  assert.strictEqual(p.args.other, null)
})

test('字符串里塞了裸换行（写文件时的头号杀手）', () => {
  const raw = '{"path":"e.ts","content":"line1\nline2\nline3"}'
  const p = parseArgs(raw, WRITE)
  assert.strictEqual(p.repair, 'syntax')
  assert.strictEqual(p.args.content, 'line1\nline2\nline3')
  assert.strictEqual(p.usable, true)
})

test('外面包了一层 ```json', () => {
  const p = parseArgs('```json\n{"path":"f.ts"}\n```', READ)
  assert.strictEqual(p.repair, 'unwrapped')
  assert.strictEqual(p.args.path, 'f.ts')
})

test('前后各来一句寒暄和总结', () => {
  const p = parseArgs('好的，我来读这个文件：\n{"path":"g.ts"}\n读完了，请稍等。', READ)
  assert.strictEqual(p.args.path, 'g.ts')
  assert.strictEqual(p.usable, true)
})

test('<tool_call> 标签', () => {
  const p = parseArgs('<tool_call>{"path":"h.ts"}</tool_call>', READ)
  assert.strictEqual(p.args.path, 'h.ts')
})

test('参数被套了一层 {"input": {...}}', () => {
  const p = parseArgs('{"input":{"path":"i.ts"}}', READ)
  assert.strictEqual(p.args.path, 'i.ts')
})

test('参数被套了一层 {"kwargs": {...}}（Python 系模型的口癖）', () => {
  const p = parseArgs('{"kwargs":{"path":"j.ts"}}', READ)
  assert.strictEqual(p.args.path, 'j.ts')
})

test('file_path 认成 path', () => {
  const p = parseArgs('{"file_path":"k.ts"}', READ)
  assert.strictEqual(p.args.path, 'k.ts')
  assert.strictEqual(p.usable, true)
})

test('fileName 这种大小写差异归一到 file_name', () => {
  const p = parseArgs('{"fileName":"l.ts"}', { properties: { file_name: { type: 'string' } }, required: ['file_name'] })
  assert.strictEqual(p.args.file_name, 'l.ts')
})

test('数字被写成字符串，按 schema 强转回来', () => {
  const p = parseArgs('{"path":"m.ts","offset":"20"}', READ)
  assert.strictEqual(p.args.offset, 20)
})

test('布尔被写成字符串', () => {
  const p = parseArgs('{"path":"n.ts","multiSelect":"true"}', {
    properties: { path: { type: 'string' }, multiSelect: { type: 'boolean' } },
    required: ['path']
  })
  assert.strictEqual(p.args.multiSelect, true)
})

test('单元素数组当成参数对象（多包了一层 []）', () => {
  const p = parseArgs('[{"path":"o.ts"}]', READ)
  assert.strictEqual(p.args.path, 'o.ts')
})

test('二次编码：整个参数是一个 JSON 字符串', () => {
  const p = parseArgs(JSON.stringify('{"path":"p.ts"}'), READ)
  assert.strictEqual(p.args.path, 'p.ts')
})

test('截断的 content 绝不抢救：半个文件写进磁盘比报错糟得多', () => {
  // 写到一半被上下文截断，引号没闭合
  const raw = '{"path":"q.ts","content":"export function a() {\n  return 1'
  const p = parseArgs(raw, WRITE)
  assert.strictEqual(p.usable, false)
  assert.ok(p.missing.includes('content'), '截断的 content 应该算缺失')
  assert.strictEqual(p.args.content, undefined)
  assert.deepStrictEqual(p.truncated, ['content'], '要能和「根本没写」区分开')
})

test('「写了但断了」和「没写」给模型的提示不一样', () => {
  const cut = settleToolArgs({ args: { [RAW_ARG_KEY]: '{"path":"q.ts","content":"abc' } }, WRITE)
  assert.ok(cut.blocked && cut.blocked.includes('截断'), cut.blocked)
  // 提示里不能只说「缺少 content」——模型会补一个空字符串再发一遍，那才是真把文件清空
  assert.ok(!/^这次工具调用没有执行：缺少必填参数/.test(cut.blocked), cut.blocked)

  const forgot = settleToolArgs({ args: { path: 'q.ts' } }, WRITE)
  assert.ok(forgot.blocked && forgot.blocked.includes('缺少必填参数'), forgot.blocked)
})

test('整体截断但必填字段都完整：按字段名救回来', () => {
  // 末尾的 } 丢了，但两个字段都是完整的
  const raw = '{"path":"r.ts","content":"hello"'
  const p = parseArgs(raw, WRITE)
  assert.strictEqual(p.args.path, 'r.ts')
  assert.strictEqual(p.args.content, 'hello')
  assert.strictEqual(p.repair, 'salvaged')
  assert.strictEqual(p.usable, true)
})

test('少一个逗号：按字段名救回来，而不是整条丢掉', () => {
  const p = parseArgs('{"path": "s.ts" "offset": 3}', READ)
  assert.strictEqual(p.args.path, 's.ts')
  assert.strictEqual(p.repair, 'salvaged')
  assert.strictEqual(p.usable, true)
})

test('完全不是 JSON：usable=false，并且说明坏在第几个字符附近', () => {
  const p = parseArgs('not json at all', READ)
  assert.strictEqual(p.usable, false)
  assert.strictEqual(p.repair, 'failed')
  assert.ok(p.error && /第 \d+ 个字符|不是合法 JSON/.test(p.error), p.error)
})

test('空参数：不算失败，交给工具自己报缺什么', () => {
  const p = parseArgs('', READ)
  assert.strictEqual(p.repair, 'none')
  assert.strictEqual(p.usable, false)
  assert.deepStrictEqual(p.missing, ['path'])
})

test('JSON 合法但漏了必填：usable=false，missing 指名道姓', () => {
  const p = parseArgs('{"offset":5}', READ)
  assert.strictEqual(p.repair, 'none')
  assert.strictEqual(p.usable, false)
  assert.deepStrictEqual(p.missing, ['path'])
})

test('传对象（Ollama 原生 arguments）只做 schema 层整理', () => {
  const p = parseArgs({ file_path: 't.ts', offset: '7' }, READ)
  assert.strictEqual(p.args.path, 't.ts')
  assert.strictEqual(p.args.offset, 7)
  assert.strictEqual(p.repair, 'none')
})

test('relaxJson 不碰已经合法的 JSON', () => {
  const ok = '{"a":"x, y","b":[1,2],"c":null}'
  assert.strictEqual(relaxJson(ok), ok)
})

test('stripWrapping 对已经干净的 JSON 返回 null（表示没剥过）', () => {
  assert.strictEqual(stripWrapping('{"a":1}'), null)
  assert.strictEqual(stripWrapping('```json\n{"a":1}\n```'), '{"a":1}')
})

test('parseLoose 认得裸键写法（文本里夹带的调用原来会因为这条被整条丢掉）', () => {
  const v = parseLoose('{name: "read_file", args: {path: "u.ts"}}')
  assert.strictEqual(v.name, 'read_file')
  assert.strictEqual(v.args.path, 'u.ts')
})

test('balancedEnd 跳过字符串里的括号', () => {
  assert.strictEqual(balancedEnd('{"a":"}{"}', 0), 9)
  assert.strictEqual(balancedEnd('{"a":1', 0), -1)
})

test('settleToolArgs：参数坏了就 blocked，并且不执行', () => {
  const s = settleToolArgs({ args: { [RAW_ARG_KEY]: '{"path": ' } }, READ)
  assert.ok(s.blocked && /没有执行/.test(s.blocked))
  assert.ok(/JSON/.test(s.blocked))
  assert.strictEqual(s.note, undefined)
})

test('settleToolArgs：_raw 走 schema 再解一次，能救回来就带上说明', () => {
  const s = settleToolArgs({ args: { [RAW_ARG_KEY]: "{'file_path': 'v.ts',}" } }, READ)
  assert.strictEqual(s.blocked, undefined)
  assert.strictEqual(s.args.path, 'v.ts')
  assert.ok(s.note && /参数容错/.test(s.note))
})

test('settleToolArgs：合法参数不加任何噪音', () => {
  const s = settleToolArgs({ args: { path: 'w.ts' } }, READ)
  assert.strictEqual(s.note, undefined)
  assert.strictEqual(s.blocked, undefined)
  assert.strictEqual(s.args.path, 'w.ts')
})

test('settleToolArgs：缺必填时的提示直接点名缺哪个字段', () => {
  const s = settleToolArgs({ args: { offset: 1 } }, READ)
  assert.ok(s.blocked && s.blocked.includes('path'), s.blocked)
})
