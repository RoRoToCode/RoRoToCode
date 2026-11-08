/**
 * 项目规则（AGENTS.md / CLAUDE.md）发现与 init 单测。
 * 直接跑 dist 里的编译产物，不额外装测试框架。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  findInstructions,
  instructionsBlock,
  initAgents,
  isInstructionFile,
  INSTRUCTIONS_LIMIT
} = require('../dist/main/instructions.js')

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'roroto-instr-'))
}

test('没有规则文件时返回空结果', async () => {
  const dir = tmpdir()
  const r = await findInstructions(dir)
  assert.strictEqual(r.path, null)
  assert.strictEqual(r.text, '')
  assert.strictEqual(r.truncated, false)
  assert.strictEqual(r.name, null)
  assert.strictEqual(instructionsBlock(r), '')
})

test('workspace 为 null 时返回空结果', async () => {
  const r = await findInstructions(null)
  assert.strictEqual(r.path, null)
})

test('找到根目录的 AGENTS.md 并读取正文', async () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# 规则\n- 构建：npm run build\n')
  const r = await findInstructions(dir)
  assert.strictEqual(r.name, 'AGENTS.md')
  assert.ok(r.path.endsWith('AGENTS.md'))
  assert.match(r.text, /npm run build/)
  assert.strictEqual(r.truncated, false)
  assert.match(instructionsBlock(r), /项目规则/)
})

test('AGENTS.md 优先于 CLAUDE.md', async () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'claude 内容')
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'agents 内容')
  const r = await findInstructions(dir)
  assert.strictEqual(r.name, 'AGENTS.md')
  assert.match(r.text, /agents 内容/)
})

test('子目录的规则覆盖父目录（向上逐层查找）', async () => {
  const root = tmpdir()
  const sub = path.join(root, 'a', 'b')
  fs.mkdirSync(sub, { recursive: true })
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '父目录规则')
  fs.writeFileSync(path.join(sub, 'AGENTS.md'), '子目录规则')
  const r = await findInstructions(sub)
  assert.match(r.text, /子目录规则/)
})

test('子目录没有规则时回退到父目录', async () => {
  const root = tmpdir()
  const sub = path.join(root, 'a', 'b')
  fs.mkdirSync(sub, { recursive: true })
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '父目录规则')
  const r = await findInstructions(sub)
  assert.match(r.text, /父目录规则/)
})

test('多份规则跨层合并，最近层在前', async () => {
  const root = tmpdir()
  const sub = path.join(root, 'a', 'b')
  fs.mkdirSync(sub, { recursive: true })
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '父目录规则')
  fs.writeFileSync(path.join(sub, 'AGENTS.md'), '子目录规则')
  const r = await findInstructions(sub)
  // 两份都在，且子目录（最近层）排在父目录之前
  assert.match(r.text, /子目录规则/)
  assert.match(r.text, /父目录规则/)
  assert.ok(r.text.indexOf('子目录规则') < r.text.indexOf('父目录规则'))
  assert.strictEqual(r.name, 'AGENTS.md')
})

test('跨层合并时 CLAUDE.md 与 AGENTS.md 各层独立匹配', async () => {
  const root = tmpdir()
  const sub = path.join(root, 'a')
  fs.mkdirSync(sub, { recursive: true })
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '根层 claude 约定')
  fs.writeFileSync(path.join(sub, 'AGENTS.md'), '子层 agents 约定')
  const r = await findInstructions(sub)
  assert.match(r.text, /子层 agents 约定/)
  assert.match(r.text, /根层 claude 约定/)
})

test('超过上限的规则被截断并标记', async () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'x'.repeat(INSTRUCTIONS_LIMIT + 500))
  const r = await findInstructions(dir)
  assert.strictEqual(r.truncated, true)
  assert.strictEqual(r.text.length, INSTRUCTIONS_LIMIT)
  assert.match(instructionsBlock(r), /已按上限截断/)
})

test('isInstructionFile 只认 AGENTS.md / CLAUDE.md', () => {
  assert.strictEqual(isInstructionFile('AGENTS.md'), true)
  assert.strictEqual(isInstructionFile('CLAUDE.md'), true)
  assert.strictEqual(isInstructionFile('README.md'), false)
  assert.strictEqual(isInstructionFile('agents.md'), false)
})

test('initAgents 生成 AGENTS.md，已存在则不覆盖', async () => {
  const dir = tmpdir()
  const first = await initAgents(dir)
  assert.strictEqual(first.created, true)
  const content = fs.readFileSync(first.path, 'utf8')
  assert.match(content, /# 项目规则/)

  // 第二次调用不覆盖
  const second = await initAgents(dir)
  assert.strictEqual(second.created, false)

  // 用户改过之后也不覆盖
  fs.writeFileSync(first.path, '我自己的约定')
  const third = await initAgents(dir)
  assert.strictEqual(third.created, false)
  assert.strictEqual(fs.readFileSync(first.path, 'utf8'), '我自己的约定')
})

test('initAgents 在 workspace 为 null 时不创建', async () => {
  const r = await initAgents(null)
  assert.strictEqual(r.created, false)
  assert.strictEqual(r.path, '')
})
