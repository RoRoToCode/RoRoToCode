/**
 * LSP 导航层的纯函数测试。
 *
 * goto_definition / find_references 的底层走 tsserver 进程（需要真实 TS 项目），
 * 这里只测不依赖进程的部分：路径归一、以及工具输出文案的构造逻辑。
 * tsserver 的协议收发（行分隔发、Content-Length 收）已由 smoke-diagnostics 覆盖。
 */
const test = require('node:test')
const assert = require('node:assert')
const { relPath, absPath } = require('../dist/main/lsp/types.js')

test('relPath：工作区内路径转相对', () => {
  const ws = 'C:/proj/app'
  assert.strictEqual(relPath('C:/proj/app/src/a.ts', ws), 'src/a.ts')
  // Windows 反斜杠也要归一
  assert.strictEqual(relPath('C:\\proj\\app\\src\\a.ts', ws), 'src/a.ts')
})

test('relPath：盘符大小写不一致也能匹配', () => {
  assert.strictEqual(relPath('c:/proj/app/a.ts', 'C:/proj/app'), 'a.ts')
})

test('relPath：工作区之外保持原样（不截断成奇怪路径）', () => {
  const f = 'C:/other/x.ts'
  assert.strictEqual(relPath(f, 'C:/proj/app'), f)
})

test('relPath：没有工作区时原样返回', () => {
  assert.strictEqual(relPath('C:/x/a.ts', null), 'C:/x/a.ts')
})

test('absPath：相对路径接到工作区根', () => {
  assert.strictEqual(absPath('src/a.ts', 'C:/proj'), 'C:\\proj\\src\\a.ts')
})

test('absPath：绝对路径原样返回', () => {
  assert.strictEqual(absPath('C:/proj/a.ts', 'C:/proj'), 'C:/proj/a.ts')
})

test('absPath：没有工作区时相对路径原样返回', () => {
  assert.strictEqual(absPath('src/a.ts', null), 'src/a.ts')
})

test('absPath：空路径原样返回，不拼接出垃圾', () => {
  assert.strictEqual(absPath('', 'C:/proj'), '')
})
