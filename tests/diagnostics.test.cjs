const test = require('node:test')
const assert = require('node:assert')
const {
  normalizeDiag,
  dedupe,
  errorsOnly,
  relPath,
  formatDiagnostics,
  isTypeScriptFile,
  parseTscLine,
  parseTscOutput
} = require('../dist/shared/diagnostics.js')

const RAW = {
  start: { line: 12, offset: 5 },
  end: { line: 12, offset: 9 },
  text: '类型 "string" 不能赋值给类型 "number"。',
  code: 2322,
  category: 'error'
}

test('tsserver 诊断归一：行列是 1-based，code 是数字', () => {
  const d = normalizeDiag('C:/p/a.ts', RAW)
  assert.strictEqual(d.line, 12)
  assert.strictEqual(d.col, 5)
  assert.strictEqual(d.code, 2322)
  assert.strictEqual(d.severity, 'error')
})

test('多行诊断文本压成一行：否则列表每条都断成两三行，读不出层次', () => {
  const d = normalizeDiag('a.ts', { ...RAW, text: '不能把类型\n  {\n    a: string\n  }\n赋给 number' })
  assert.strictEqual(d.message.includes('\n'), false)
  assert.ok(d.message.includes('不能把类型'))
})

test('认不出的诊断（没有 text）直接丢掉，不留空条目', () => {
  assert.strictEqual(normalizeDiag('a.ts', { code: 1 }), null)
  assert.strictEqual(normalizeDiag('a.ts', null), null)
})

test('缺 start 时退到第 1 行第 1 列，不产生 NaN', () => {
  const d = normalizeDiag('a.ts', { text: 'x', code: 1, category: 'error' })
  assert.strictEqual(d.line, 1)
  assert.strictEqual(d.col, 1)
})

test('同一位置同一条码只留一条：syntax 和 semantic 会各推一次', () => {
  const list = [normalizeDiag('a.ts', RAW), normalizeDiag('a.ts', RAW), normalizeDiag('a.ts', { ...RAW, code: 9999 })]
  assert.strictEqual(dedupe(list).length, 2)
})

test('只报 error：warning 回灌会把真正的错淹掉', () => {
  const list = [
    normalizeDiag('a.ts', RAW),
    normalizeDiag('a.ts', { ...RAW, code: 6133, category: 'suggestion', text: '声明了但没用到' }),
    normalizeDiag('a.ts', { ...RAW, code: 1234, category: 'warning', text: '可能有副作用' })
  ]
  const kept = errorsOnly(list)
  assert.strictEqual(kept.length, 1)
  assert.strictEqual(kept[0].code, 2322)
})

test('相对路径：工作区内变相对，工作区外保持原样', () => {
  assert.strictEqual(relPath('C:\\ws\\src\\a.ts', 'C:\\ws'), 'src/a.ts')
  assert.strictEqual(relPath('C:\\other\\b.ts', 'C:\\ws'), 'C:\\other\\b.ts')
  // 盘符大小写不一致也要认
  assert.strictEqual(relPath('c:/ws/src/a.ts', 'C:/ws'), 'src/a.ts')
})

test('没有错误时不产生任何文本：调用方据此决定不追加内容', () => {
  assert.strictEqual(formatDiagnostics([]), '')
  assert.strictEqual(formatDiagnostics([normalizeDiag('a.ts', { ...RAW, category: 'warning', code: 1234 })]), '')
})

test('回灌文案包含文件:行:列 + TS 码 + 一句可执行的话', () => {
  const text = formatDiagnostics([normalizeDiag('C:/ws/src/a.ts', RAW)], { workspace: 'C:/ws' })
  assert.ok(text.includes('src/a.ts:12:5'), text)
  assert.ok(text.includes('TS2322'), text)
  assert.ok(text.includes('编译错误'), text)
  assert.ok(text.includes('现在就修'), text)
})

test('多文件时措辞交代清楚改了几个文件', () => {
  const text = formatDiagnostics(
    [normalizeDiag('C:/ws/a.ts', RAW), normalizeDiag('C:/ws/b.ts', { ...RAW, code: 1 })],
    { workspace: 'C:/ws', filesWritten: 2 }
  )
  assert.ok(text.includes('2 个文件'), text)
})

test('错误太多时截断，并明确说还有多少条没列', () => {
  const many = Array.from({ length: 12 }, (_, i) => normalizeDiag('a.ts', { ...RAW, code: 1000 + i, start: { line: i + 1, offset: 1 } }))
  const text = formatDiagnostics(many, { max: 5 })
  assert.ok(text.includes('还有 7 个'), text)
  assert.strictEqual((text.match(/^- /gm) || []).length, 5)
})

test('文件类型判断只看 TS/JS 家族', () => {
  for (const f of ['a.ts', 'a.tsx', 'a.mts', 'a.js', 'a.jsx', 'A.TS']) assert.strictEqual(isTypeScriptFile(f), true, f)
  for (const f of ['a.md', 'a.json', 'a.py', 'a.rs']) assert.strictEqual(isTypeScriptFile(f), false, f)
})

test('tsc 输出解析：5.x 括号写法和旧式冒号写法都认', () => {
  const a = parseTscLine('src/a.ts(12,5): error TS2322: 类型不匹配。', 'C:/ws')
  assert.strictEqual(a.line, 12)
  assert.strictEqual(a.code, 2322)
  assert.ok(a.file.replace(/\\/g, '/').endsWith('C:/ws/src/a.ts'), a.file)

  const b = parseTscLine('src/b.ts:3:1 - error TS2304: 找不到名称 "x"。', '/ws')
  assert.strictEqual(b.line, 3)
  assert.strictEqual(b.code, 2304)
})

test('tsc 输出解析：already absolute 的路径不重复拼工作区', () => {
  const d = parseTscLine('C:\\abs\\a.ts(1,1): error TS1: x')
  assert.strictEqual(d.file, 'C:\\abs\\a.ts')
})

test('tsc 输出解析：汇总行 / 空行 / 普通正文都不算诊断', () => {
  assert.strictEqual(parseTscLine('Found 3 errors in 2 files.'), null)
  assert.strictEqual(parseTscLine(''), null)
  assert.strictEqual(parseTscLine('> roroto-code@0.1.2 typecheck'), null)
})

test('整段输出切成诊断列表，并跨行去重', () => {
  const out = [
    'src/a.ts(1,1): error TS1: 一',
    'src/a.ts(1,1): error TS1: 一',
    'src/b.ts(2,2): error TS2: 二'
  ].join('\n')
  assert.strictEqual(parseTscOutput(out, 'C:/ws').length, 2)
})
