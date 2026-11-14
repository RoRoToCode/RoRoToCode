const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { resolveDataRoot } = require('../dist/shared/datadir.js')

const USER = path.join('C:', 'Users', 'tester', 'AppData', 'Roaming', 'RoRoTo Code')
const EXE = path.join('C:', 'Users', 'tester', 'scoop', 'apps', 'rorotocode', '0.1.3')

/** dataRoots：哪些根目录下「已经有数据」 */
function run(env, dataRoots = []) {
  const set = new Set(dataRoots.map((r) => path.normalize(r)))
  return resolveDataRoot({
    env,
    userDataDir: USER,
    exeDir: EXE,
    resolve: (p) => path.resolve(p),
    hasData: (base) => set.has(path.normalize(base))
  })
}

test('全新安装：默认落在持久目录，不跟 exe 走', () => {
  assert.equal(run({}), USER)
})

test('ROROTO_DATA_DIR 优先级最高', () => {
  const custom = path.resolve(path.join('D:', 'llm-data'))
  assert.equal(run({ ROROTO_DATA_DIR: custom }), custom)
})

test('ROROTO_DATA_DIR 为空白时视为未设置', () => {
  assert.equal(run({ ROROTO_DATA_DIR: '   ' }), USER)
})

test('ROROTO_PORTABLE=1 回到 exe 同目录（真便携 / U 盘）', () => {
  assert.equal(run({ ROROTO_PORTABLE: '1' }), EXE)
})

test('老便携版用户：exe 同目录已有数据，沿用旧位置', () => {
  assert.equal(run({}, [EXE]), EXE)
})

test('两边都有数据时优先持久目录', () => {
  assert.equal(run({}, [EXE, USER]), USER)
})

test('持久目录已有数据：升级后不回退到安装目录', () => {
  assert.equal(run({}, [USER]), USER)
})

test('ROROTO_PORTABLE=1 即便持久目录有数据也用 exe 目录', () => {
  assert.equal(run({ ROROTO_PORTABLE: '1' }, [USER]), EXE)
})

test('ROROTO_DATA_DIR 覆盖老数据兼容判断', () => {
  const custom = path.resolve(path.join('E:', 'roroto-data'))
  assert.equal(run({ ROROTO_DATA_DIR: custom }, [EXE]), custom)
})
