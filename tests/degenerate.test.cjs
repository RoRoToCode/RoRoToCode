/**
 * 生成退化检测：本地小模型「同一段话复读十几遍」的兜底。
 * 关键是不误伤——正常回答、排比、代码块都不该被剪。
 */
const test = require('node:test')
const assert = require('node:assert')
const { findRepetition, trimRepetition, createLoopGuard } = require('../dist/shared/degenerate.js')

const block =
  '## 网盘直连\n' +
  '- PanDownload（PanDownload/PanDownload）— 支持百度网盘、阿里云盘、115、天翼云等，支持批量下载、断点续传。\n' +
  '- Netdisk（Netdisk/netdisk）— 支持百度网盘、阿里云盘、115、天翼云等，支持批量下载、断点续传。\n'

test('整段复读：能识别并定位到第一份末尾', () => {
  const text = '有，GitHub 上有不少开源网盘下载工具。\n' + block.repeat(8)
  const hit = findRepetition(text)
  assert.ok(hit, '应当判定为循环')
  assert.ok(hit.hits >= 3, `命中次数 ${hit.hits}`)
  assert.ok(hit.cut > 0 && hit.cut < text.length / 2, `截断点太靠后：${hit.cut}/${text.length}`)
})

test('剪完之后只留一份，不再有重复块', () => {
  const text = '有，GitHub 上有不少开源网盘下载工具。\n' + block.repeat(8)
  const r = trimRepetition(text)
  assert.equal(r.trimmed, true)
  assert.ok(r.text.startsWith('有，GitHub 上'))
  assert.equal(r.text.split('## 网盘直连').length - 1, 1, '应只保留一份段落')
  assert.ok(r.text.length < text.length / 3)
})

test('正常长回答不误伤', () => {
  const lines = []
  for (let i = 0; i < 40; i++) {
    lines.push(`第 ${i} 步：先检查配置里的端口 ${8000 + i}，再用第 ${i} 种方式重试并观察返回结果。`)
  }
  const text = lines.join('\n')
  assert.equal(findRepetition(text), null)
  assert.equal(trimRepetition(text).trimmed, false)
})

test('引用同一句话两遍不算循环', () => {
  const quote = '支持多账号、任务队列、限速；支持断点续传；支持批量下载，这些是同类工具的共同特性。'
  const text = `先说明结论：${quote}\n中间还有一段完全不同的分析，讲的是如何按协议分类和选择工具。\n` +
    `再回看一遍上面的说法：${quote}\n所以结论不变。`
  assert.equal(findRepetition(text), null)
  assert.equal(trimRepetition(text).trimmed, false)
})

test('同一短句机械复读也算退化，会被剪', () => {
  const text = ('支持多账号、任务队列、限速；支持断点续传；支持批量下载。').repeat(12)
  assert.ok(findRepetition(text))
})

test('短文本直接跳过', () => {
  assert.equal(findRepetition('重复重复重复'), null)
  assert.equal(trimRepetition('').trimmed, false)
})

test('流式护栏：命中后不再放行后续 delta', () => {
  const guard = createLoopGuard()
  const whole = '开头一句说明。\n' + block.repeat(8)
  let pushed = 0
  // 模拟逐段推送的 delta
  for (let i = 0; i < whole.length; i += 37) {
    if (guard.push(whole.slice(i, i + 37))) pushed++
  }
  assert.equal(guard.isStopped(), true)
  assert.ok(pushed * 37 < whole.length, '循环出现后应停止向界面推送')
  const r = guard.apply(whole)
  assert.equal(r.trimmed, true)
  assert.equal(r.text.split('## 网盘直连').length - 1, 1)
})

test('尾部空白不影响判定', () => {
  const text = '开头。\n' + block.repeat(6) + '\n\n   '
  assert.ok(findRepetition(text))
})
