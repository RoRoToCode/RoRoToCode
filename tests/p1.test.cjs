const test = require('node:test')
const assert = require('node:assert')
const { expandCommandBody } = require('../dist/main/commands.js')
const { parseFrontmatter, splitList } = require('../dist/main/mdmeta.js')
const { matcherHit } = require('../dist/main/hooks.js')
const { resolveProvider } = require('../dist/main/config.js')
const { openapiSpec } = require('../dist/main/daemon.js')

/* ---------------- 斜杠命令 ---------------- */

test('命令占位符：$ARGUMENTS 与 $1/$2 都替换', () => {
  assert.strictEqual(expandCommandBody('修一下 $1，范围 $2', 'ci 全部'), '修一下 ci，范围 全部')
  assert.strictEqual(expandCommandBody('审查 $ARGUMENTS', 'src/a.ts'), '审查 src/a.ts')
  assert.strictEqual(expandCommandBody('审查 {{args}}', 'src/a.ts'), '审查 src/a.ts')
})

test('命令没写占位符：参数接在末尾，不吞用户输入', () => {
  assert.strictEqual(expandCommandBody('跑测试', '只看 api'), '跑测试\n\n只看 api')
  assert.strictEqual(expandCommandBody('跑测试', ''), '跑测试')
})

test('命令缺参数：占位符变成空串，不留 $1', () => {
  assert.strictEqual(expandCommandBody('修 $1', ''), '修')
})

/* ---------------- frontmatter ---------------- */

test('frontmatter：只认 key: value，正文原样保留', () => {
  const { meta, body } = parseFrontmatter('---\nname: 迁移手\ntools: read_file, edit_file\n---\n你负责迁移。')
  assert.strictEqual(meta.name, '迁移手')
  assert.strictEqual(meta.tools, 'read_file, edit_file')
  assert.strictEqual(body, '你负责迁移。')
})

test('frontmatter：没有头部时整篇都是正文', () => {
  const { meta, body } = parseFrontmatter('直接写正文')
  assert.deepStrictEqual(meta, {})
  assert.strictEqual(body, '直接写正文')
})

test('splitList：逗号/空格/方括号都认', () => {
  assert.deepStrictEqual(splitList('read_file, edit_file grep'), ['read_file', 'edit_file', 'grep'])
  assert.deepStrictEqual(splitList('[a, b]'), ['a', 'b'])
  assert.deepStrictEqual(splitList(''), [])
})

/* ---------------- 钩子 matcher ---------------- */

test('钩子 matcher：空 / * 全匹配，| 与逗号是或，正则可用', () => {
  assert.strictEqual(matcherHit(undefined, 'write_file'), true)
  assert.strictEqual(matcherHit('*', 'anything'), true)
  assert.strictEqual(matcherHit('write_file|patch', 'patch'), true)
  assert.strictEqual(matcherHit('write_file,edit_file', 'edit_file'), true)
  assert.strictEqual(matcherHit('write_file', 'read_file'), false)
  assert.strictEqual(matcherHit('/^write_/', 'write_file'), true)
  assert.strictEqual(matcherHit('/^write_/', 'read_file'), false)
})

/* ---------------- 会话级模型 ---------------- */

test('会话级 modelOverride：只在同一供应商里换模型名，不改原配置', () => {
  const config = {
    providers: [
      { id: 'p1', name: '本地', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'a', contextWindow: 8192 },
      { id: 'p2', name: '远端', kind: 'openai', baseUrl: 'http://x/v1', model: 'b', contextWindow: 8192 }
    ],
    activeId: 'p1'
  }
  assert.strictEqual(resolveProvider(config, 'p2', null).model, 'b')
  const over = resolveProvider(config, 'p2', 'c')
  assert.strictEqual(over.model, 'c')
  assert.strictEqual(over.id, 'p2')
  // 原对象不能被改：别的会话还在读它
  assert.strictEqual(config.providers[1].model, 'b')
  // 空串等于没指定
  assert.strictEqual(resolveProvider(config, null, '   ').id, 'p1')
})

/* ---------------- OpenAPI ---------------- */

test('OpenAPI：三个客户端必需端点都在，且带 bearer 鉴权', () => {
  const spec = openapiSpec()
  assert.strictEqual(spec.openapi, '3.1.0')
  for (const p of ['/health', '/openapi.json', '/chat/session', '/chat/send', '/chat/events', '/agents']) {
    assert.ok(spec.paths[p], `缺少 ${p}`)
  }
  assert.ok(spec.components.securitySchemes.bearerAuth)
  assert.strictEqual(spec.paths['/chat/send'].post.responses['202'] !== undefined, true)
})
