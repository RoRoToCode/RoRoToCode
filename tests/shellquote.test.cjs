/**
 * Windows cmd.exe 引号解析的回归测试。
 *
 * 背景：run_shell 以前用 spawn('cmd.exe', ['/d','/s','/c', command]) 数组传参。
 * Node 在 Windows 上会给含双引号的 argv 做 Windows 命令行转义（`"` → `\"`），
 * 但 cmd.exe 只认双引号配对、不认反斜杠转义，于是
 *   node -e "console.log(1+2); console.log(3+4)"
 * 的内层双引号被剥掉，子进程只收到 `"console...` 半句 → SyntaxError。
 *
 * 修复：对 cmd 加 windowsVerbatimArguments:true，让命令原样交给 cmd 解析。
 * 本测试锁住两件事：
 *   1) shellNeedsVerbatim 只对 Windows + cmd 返回 true（powershell/bash 开了反而坏）；
 *   2) Windows 上带 verbatim 执行含分号的内联命令确实能跑通。
 */
const test = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('node:child_process')

test('shellNeedsVerbatim 只对 Windows 的 cmd 生效', () => {
  const { shellNeedsVerbatim, isWin } = require('../dist/main/platform.js')
  assert.strictEqual(shellNeedsVerbatim('cmd'), isWin)
  assert.strictEqual(shellNeedsVerbatim('powershell'), false)
  assert.strictEqual(shellNeedsVerbatim('bash'), false)
})

test('cmd + verbatim：含分号的内联命令不再被截断', (t) => {
  const { isWin, shellArgs, shellNeedsVerbatim, shellBin } = require('../dist/main/platform.js')
  if (!isWin) return t.skip('仅 Windows 有意义')
  const command = 'node -e "console.log(1+2); console.log(3+4)"'
  const r = spawnSync(shellBin('cmd'), shellArgs('cmd', command), {
    encoding: 'utf8',
    windowsHide: true,
    windowsVerbatimArguments: shellNeedsVerbatim('cmd')
  })
  assert.strictEqual(r.status, 0, String(r.stderr || ''))
  assert.match(String(r.stdout), /3/)
  assert.match(String(r.stdout), /7/)
})
