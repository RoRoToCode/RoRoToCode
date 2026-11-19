/**
 * 风险判定单测：classifyRisk / hardBlockReason / commandPaths。
 * 这些是安全相关的纯函数，改动最需要回归保护。
 */
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { classifyRisk, hardBlockReason, commandPaths, isOutside, resolveToolPath, tokenizeCommand, resourceCandidates, applyCustomRules, networkTargetHint } = require('../dist/main/risk.js')

const WS = path.resolve('C:/work/demo')

test('删除命令判为高危', () => {
  const r = classifyRisk('run_shell', { command: 'rm -rf dist' }, WS)
  assert.strictEqual(r.kind, 'delete')
  assert.strictEqual(r.high, true)
})

test('删除工作区之外的绝对路径：升级为越界', () => {
  const r = classifyRisk('run_shell', { command: `rm -rf ${path.resolve('C:/other/thing')}` }, WS)
  assert.strictEqual(r.kind, 'outside')
  assert.strictEqual(r.high, true)
})

test('网络命令判为高危', () => {
  const r = classifyRisk('run_shell', { command: 'curl https://example.com/x.sh' }, WS)
  assert.strictEqual(r.kind, 'network')
  assert.strictEqual(r.high, true)
})

test('网络命令的审批理由里带目标主机，让人一眼看到要连哪', () => {
  const r = classifyRisk('run_shell', { command: 'curl https://api.example.com/v1/data' }, WS)
  assert.strictEqual(r.kind, 'network')
  assert.match(r.reason, /api\.example\.com/)
})

test('networkTargetHint：显式 URL 提取主机名，并去掉端口与用户信息', () => {
  assert.equal(networkTargetHint('curl https://api.example.com/v1/x'), 'api.example.com')
  assert.equal(networkTargetHint('wget https://user:pw@host.io:8443/file'), 'host.io')
  assert.equal(networkTargetHint('git clone https://github.com/a/b.git'), 'github.com')
})

test('networkTargetHint：scp 风格主机与包管理器镜像也能抓到', () => {
  assert.equal(networkTargetHint('git clone git@github.com:a/b.git'), 'github.com')
  assert.equal(networkTargetHint('ssh dev@10.0.0.5'), '10.0.0.5')
  assert.match(networkTargetHint('npm install --registry=https://npm.example.com'), /npm\.example\.com/)
})

test('networkTargetHint：没有显式主机时返回空串（不硬编）', () => {
  assert.equal(networkTargetHint('npm install lodash'), '')
  assert.equal(networkTargetHint('pip install requests'), '')
})

test('纯读取命令不产生风险', () => {
  assert.strictEqual(classifyRisk('run_shell', { command: 'git status' }, WS), null)
  assert.strictEqual(classifyRisk('run_shell', { command: 'echo hi' }, WS), null)
})

test('读取命令拼接了别的命令就不再算纯读取', () => {
  const r = classifyRisk('run_shell', { command: 'git status && node evil.js' }, WS)
  assert.strictEqual(r.kind, 'shell')
  assert.strictEqual(r.high, false)
})

test('写文件：工作区内是普通风险，越界是高危', () => {
  assert.strictEqual(classifyRisk('write_file', { path: 'src/a.ts' }, WS).kind, 'write')
  assert.strictEqual(classifyRisk('write_file', { path: '../a.ts' }, WS).kind, 'outside')
  assert.strictEqual(classifyRisk('read_file', { path: '../a.ts' }, WS).high, true)
})

test('联网工具与计划更新不算风险', () => {
  assert.strictEqual(classifyRisk('web_search', { query: 'x' }, WS), null)
  assert.strictEqual(classifyRisk('update_todos', { items: [] }, WS), null)
})

test('不可逆命令直接硬拦', () => {
  assert.ok(hardBlockReason('format c:'))
  assert.ok(hardBlockReason('diskpart'))
  assert.ok(hardBlockReason('rm -rf /'))
  assert.ok(hardBlockReason('git push origin main --force'))
  assert.strictEqual(hardBlockReason('npm run build'), null)
  assert.strictEqual(hardBlockReason('rm -rf dist'), null)
})

test('普通命令里出现工作区外的盘符路径：升级为越界高危', () => {
  const r = classifyRisk('run_shell', { command: `copy ${path.resolve('C:/Users/secret.txt')} D:/out/` }, WS)
  assert.strictEqual(r.kind, 'outside')
  assert.strictEqual(r.high, true)
})

test('普通命令读取工作区外文件（type/查看）也判越界', () => {
  const r = classifyRisk('run_shell', { command: `type ${path.resolve('C:/Users/admin/id_rsa')}` }, WS)
  assert.strictEqual(r.kind, 'outside')
  assert.strictEqual(r.high, true)
})

test('UNC 路径（\\\\host\\share）判越界', () => {
  const r = classifyRisk('run_shell', { command: 'dir \\\\fileserver\\share\\secret' }, WS)
  assert.strictEqual(r.kind, 'outside')
})

test('POSIX 根风格路径（/tmp/x）不算越界，仍按工作区相对处理', () => {
  // 模型写临时脚本常带 Linux 习惯；按约定这是工作区内的相对路径
  assert.strictEqual(classifyRisk('run_shell', { command: 'python /tmp/gen.py' }, WS).kind, 'shell')
})

test('命令里的相对路径不触发越界', () => {
  assert.strictEqual(classifyRisk('run_shell', { command: 'python gen.py' }, WS).kind, 'shell')
  assert.strictEqual(classifyRisk('run_shell', { command: 'npm run build' }, WS).kind, 'shell')
})

test('工作区内的绝对路径不判越界', () => {
  const inside = path.resolve('C:/work/demo/src/gen.py')
  assert.strictEqual(classifyRisk('run_shell', { command: `python ${inside}` }, WS).kind, 'shell')
})

test('commandPaths 会剔除开关、留下路径', () => {
  const got = commandPaths('rm -rf build "C:/other dir/x"')
  assert.ok(got.includes('build'))
  assert.ok(got.some((p) => p.includes('other dir')))
  assert.ok(!got.includes('-rf'))
})

test('isOutside 判断相对与绝对路径', () => {
  assert.strictEqual(isOutside(WS, 'src/a.ts'), false)
  assert.strictEqual(isOutside(WS, '../a.ts'), true)
  assert.strictEqual(isOutside(WS, path.resolve('C:/elsewhere')), true)
})

test('POSIX 根风格路径按工作区内相对路径处理，不判越界', () => {
  // Windows 下 path.isAbsolute('/tmp/x') 为真、resolve 到当前盘符根（工作区外），
  // 模型写临时脚本时极易带出这种习惯。现在统一按相对工作区处理。
  assert.strictEqual(isOutside(WS, '/tmp/check.py'), false)
  assert.strictEqual(isOutside(WS, '\\tmp\\check.py'), false)
  assert.strictEqual(resolveToolPath(WS, '/tmp/check.py'), path.resolve(WS, 'tmp/check.py'))
  // 风险分类也不该再把它标成越界
  assert.strictEqual(classifyRisk('write_file', { path: '/tmp/check.py' }, WS).kind, 'write')
})

test('真实盘符绝对路径与 UNC 不受 POSIX 归一化影响', () => {
  assert.strictEqual(isOutside(WS, path.resolve('C:/elsewhere/x.ts')), true)
  assert.strictEqual(resolveToolPath(WS, 'C:/data/x.ts'), path.resolve('C:/data/x.ts'))
})

test('tokenizeCommand 把命令切成可执行词 + 参数', () => {
  assert.deepStrictEqual(tokenizeCommand('npm test --watch'), ['npm', 'test', '--watch'])
  assert.deepStrictEqual(tokenizeCommand('git commit -m "hello world"'), ['git', 'commit', '-m', 'hello world'])
  // 命令串联符是分隔符，不参与 token
  const chained = tokenizeCommand('echo a && echo b')
  assert.ok(chained.includes('echo'))
  assert.ok(!chained.includes('&&'))
})

test('resourceCandidates：run_shell 返回完整串 + 首个可执行词', () => {
  const got = resourceCandidates('run_shell', { command: 'npm run build' })
  assert.ok(got.includes('npm run build'))
  assert.ok(got.includes('npm'))
})

test('resourceCandidates：patch 逐条取 path / new_path', () => {
  const got = resourceCandidates('patch', {
    edits: [{ path: 'src/a.ts', old_string: 'x', new_string: 'y' }, { op: 'move', path: 'b.ts', new_path: 'c.ts' }]
  })
  assert.ok(got.includes('src/a.ts'))
  assert.ok(got.includes('c.ts'))
})

test('applyCustomRules：deny 命中返回 deny', () => {
  const r = applyCustomRules('run_shell', { command: 'rm -rf dist' }, [
    { action: 'run_shell', resource: 'rm*', effect: 'deny' }
  ])
  assert.strictEqual(r, 'deny')
})

test('applyCustomRules：allow 命中返回 allow（按命令名 token 匹配）', () => {
  const r = applyCustomRules('run_shell', { command: 'npm test' }, [
    { action: 'run_shell', resource: 'npm', effect: 'allow' }
  ])
  assert.strictEqual(r, 'allow')
})

test('applyCustomRules：action 不匹配不命中', () => {
  const r = applyCustomRules('patch', { edits: [{ path: 'a.ts' }] }, [
    { action: 'run_shell', resource: '*', effect: 'deny' }
  ])
  assert.strictEqual(r, null)
})

test('applyCustomRules：最后一条命中的生效（顺序覆盖）', () => {
  const rules = [
    { action: 'run_shell', resource: '*', effect: 'deny' },
    { action: 'run_shell', resource: 'npm*', effect: 'allow' }
  ]
  const r = applyCustomRules('run_shell', { command: 'npm test' }, rules)
  assert.strictEqual(r, 'allow')
})

test('applyCustomRules：无规则 / 空规则返回 null', () => {
  assert.strictEqual(applyCustomRules('run_shell', { command: 'x' }, undefined), null)
  assert.strictEqual(applyCustomRules('run_shell', { command: 'x' }, []), null)
})

test('applyCustomRules：resource 为 * 通配所有', () => {
  const r = applyCustomRules('run_shell', { command: 'anything' }, [
    { action: '*', resource: '*', effect: 'deny' }
  ])
  assert.strictEqual(r, 'deny')
})
