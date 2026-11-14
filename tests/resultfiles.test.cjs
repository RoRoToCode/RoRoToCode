const test = require('node:test')
const assert = require('node:assert')
const {
  isResultFile,
  isNoisePath,
  filterResultFiles,
  baseName,
  extOf
} = require('../dist/shared/resultfiles.js')

test('成果判定：文档 / 表格 / 演示 / 图片 / 网页算成果', () => {
  for (const p of ['报告.docx', 'data/汇总.xlsx', 'out.png', 'slides.pptx', 'a.pdf', 'index.html', 'table.csv']) {
    assert.equal(isResultFile(p), true, p)
  }
})

test('成果判定：源码与脚本一律不算，去重后不污染成果面板', () => {
  for (const p of ['main.ts', 'scripts/actions.py', 'fetch.sh', 'a.jsx', 'query.sql', 'note.txt.bak']) {
    assert.equal(isResultFile(p), false, p)
  }
  assert.equal(isResultFile('noext'), false)
})

test('噪音：临时文件、编辑器残留、隐藏文件、依赖目录', () => {
  for (const p of ['tmp_fetch.py', 'temp_1.md', '~$报告.docx', '.env.local', 'Thumbs.db', 'a.log', 'x.lock']) {
    assert.equal(isNoisePath(p), true, p)
  }
  assert.equal(isNoisePath('node_modules/pkg/readme.md'), true)
  // 面板判定只看依赖/缓存目录；release、dist 这类只在「递归扫盘」时跳过，不改变展示结果
  assert.equal(isNoisePath('release/workspace/output.md'), false)
  assert.equal(isNoisePath('docs/报告.docx'), false)
})

test('baseName / extOf 同时认 Windows 与 POSIX 路径', () => {
  assert.equal(baseName('C:\\work\\out\\a.PDF'), 'a.PDF')
  assert.equal(baseName('work/out/a.PDF'), 'a.PDF')
  assert.equal(extOf('C:\\work\\out\\a.PDF'), 'pdf')
  assert.equal(extOf('archive.tar.gz'), 'gz')
})

test('filterResultFiles 只留成果、按时间倒序，不做纯编码兜底', () => {
  const items = [
    { path: 'old.md', action: 'created', at: 1, writes: 1 },
    { path: 'new.pdf', action: 'created', at: 3, writes: 1 },
    { path: 'script.py', action: 'edited', at: 9, writes: 2 },
    { path: 'tmp_x.md', action: 'created', at: 8, writes: 1 }
  ]
  assert.deepEqual(filterResultFiles(items).map((f) => f.path), ['new.pdf', 'old.md'])
  assert.deepEqual(filterResultFiles([{ path: 'only.py', action: 'created', at: 1, writes: 1 }]), [])
})
