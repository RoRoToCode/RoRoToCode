/**
 * 对话框正文的 Markdown 块解析。
 *
 * 这里守的是「模型流式吐出来的半截文本不能把界面弄乱」：
 * 表格少一行分隔符要退回段落、代码块没闭合要吃到结尾、
 * 缩进不同的列表要正确分组。这些在屏幕上很难肉眼验，只能靠断言。
 */
const test = require('node:test')
const assert = require('node:assert')

const { parseMarkdownBlocks, splitTableRow } = require('../dist/shared/mdblocks.js')

test('表格：表头 / 对齐 / 行，列数不一致时补齐或截断', () => {
  const md = [
    '| 模型 | 显存 | 速度 |',
    '| :--- | :---: | ---: |',
    '| Qwen3-9B | 6.2G | 32 t/s |',
    '| 7B | 4G | 45 | extra |',
    '| 缺列 |'
  ].join('\n')
  const blocks = parseMarkdownBlocks(md)
  assert.equal(blocks.length, 1)
  const t = blocks[0]
  assert.equal(t.kind, 'table')
  assert.deepEqual(t.head, ['模型', '显存', '速度'])
  assert.deepEqual(t.align, ['left', 'center', 'right'])
  assert.equal(t.rows.length, 3)
  // 多出来的列丢掉，少的补空：渲染时表格不会错位
  assert.deepEqual(t.rows[1], ['7B', '4G', '45'])
  assert.deepEqual(t.rows[2], ['缺列', '', ''])
})

test('表格：分隔行列数对不上就不当表格（宁可露出原文，也不排成歪的）', () => {
  const blocks = parseMarkdownBlocks(['| a | b |', '| --- |', '| 1 | 2 |'].join('\n'))
  assert.equal(blocks[0].kind, 'para')
})

test('表格：转义竖线和行内代码里的竖线不切开单元格', () => {
  assert.deepEqual(splitTableRow('| a \\| b | `x|y` |'), ['a | b', '`x|y`'])
})

test('代码块：没闭合时吃到结尾并标记 open', () => {
  const blocks = parseMarkdownBlocks('说明\n\n```ts\nconst a = 1')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[1].kind, 'code')
  assert.equal(blocks[1].lang, 'ts')
  assert.equal(blocks[1].value, 'const a = 1')
  assert.equal(blocks[1].open, true)
})

test('代码块：闭合后后面的正文照常解析', () => {
  const blocks = parseMarkdownBlocks('```\nx = 1\n```\n\n**结论**：没问题')
  assert.equal(blocks[0].kind, 'code')
  assert.equal(blocks[0].open, false)
  assert.equal(blocks[1].kind, 'para')
  assert.equal(blocks[1].text, '**结论**：没问题')
})

test('列表：有序 / 无序 / 嵌套 / 勾选项', () => {
  const md = [
    '1. 先装依赖',
    '2. 再跑测试',
    '   - npm test',
    '   - 失败就看日志',
    '- [x] 已经做过的',
    '- [ ] 还没做的'
  ].join('\n')
  const list = parseMarkdownBlocks(md)[0]
  assert.equal(list.kind, 'list')
  const items = list.items
  assert.equal(items.length, 6)
  assert.equal(items[0].ordered, true)
  assert.equal(items[0].start, 1)
  assert.equal(items[2].ordered, false)
  assert.equal(items[2].depth, 1)
  assert.equal(items[3].depth, 1)
  assert.equal(items[4].depth, 0)
  assert.equal(items[4].checked, true)
  assert.equal(items[5].checked, false)
})

test('标题 / 引用 / 分隔线 / 段落', () => {
  const md = ['## 结论', '', '> 这里有个坑', '> 第二行', '', '---', '', '第一行', '第二行'].join('\n')
  const blocks = parseMarkdownBlocks(md)
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['heading', 'quote', 'hr', 'para']
  )
  assert.equal(blocks[0].level, 2)
  assert.equal(blocks[1].text, '这里有个坑\n第二行')
  // 段落里的单个换行要保留（正文容器是 pre-wrap，靠它显示换行）
  assert.equal(blocks[3].text, '第一行\n第二行')
})

test('流式输出：任何长度的前缀都不能抛异常', () => {
  const md = [
    '## 报告',
    '',
    '| 项目 | 值 |',
    '| --- | --- |',
    '| 构建 | 通过 |',
    '',
    '1. 第一步',
    '2. 第二步',
    '',
    '```js',
    'console.log(1)',
    '```',
    '',
    '![截图](./shot.png)'
  ].join('\n')
  for (let i = 0; i <= md.length; i++) {
    const blocks = parseMarkdownBlocks(md.slice(0, i))
    assert.ok(Array.isArray(blocks))
  }
})

test('空输入返回空数组', () => {
  assert.deepEqual(parseMarkdownBlocks(''), [])
  assert.deepEqual(parseMarkdownBlocks('   \n\n  '), [])
})

test('正文图片：格式白名单、越界相对路径、不存在的文件都被挡住', () => {
  const os = require('node:os')
  const fsx = require('node:fs')
  const pathx = require('node:path')
  const { imagePreview } = require('../dist/main/vision.js')
  const root = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'roro-img-'))

  // 不是图片扩展名：连读盘都不该发生
  assert.equal(imagePreview('notes.txt', root).ok, false)
  // 相对路径跑出工作区
  const outside = imagePreview('../secret.png', root)
  assert.equal(outside.ok, false)
  assert.match(String(outside.error), /工作区/)
  // 工作区里确实没有这张图
  assert.equal(imagePreview('shot.png', root).ok, false)

  fsx.rmSync(root, { recursive: true, force: true })
})
