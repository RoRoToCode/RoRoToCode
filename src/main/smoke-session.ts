/**
 * 会话层的四项自检：分叉、会话便签、长期授权、/learn 蒸馏。
 *
 * 这四个都在主进程里落盘、也都不需要真的模型跑一轮，所以放一个冒烟里跑完：
 * 起一个假 OpenAI 服务只为 /learn 那一步（它必须走一次 chat 调用）。
 * 整个过程在临时 userData 目录里进行，跑完不留痕迹。
 */
import { app } from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import * as store from './store'
import { defaultConfig, saveConfig } from './config'
import { executeTool } from './tools'
import { clearScratch, scratchForPrompt } from './scratch'
import { clearGrants, grantKey, grantTool, listGrants, loadGrantSet, revokeGrant } from './grants'
import { distillSkill } from './learn'
import { listSkills } from './skills'

app.setPath('userData', path.join(os.tmpdir(), 'rorotocode-smoke-session'))

let fails = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`)
  if (!ok) fails++
}

const now = Date.now()
const m = (id: string, role: 'user' | 'assistant' | 'tool', content: string, extra: Record<string, unknown> = {}) =>
  ({ id, role, content, createdAt: now, ...extra }) as never

async function main(): Promise<void> {
  await app.whenReady()
  const userData = app.getPath('userData')
  // 上一次跑剩下的记录会让「重复记住只有一条」这类断言误判
  await fs.promises.rm(path.join(userData, 'approvals.json'), { force: true }).catch(() => undefined)
  await fs.promises.rm(path.join(userData, 'skills.json'), { force: true }).catch(() => undefined)

  const workspace = path.join(userData, 'ws')
  await fs.promises.mkdir(workspace, { recursive: true })

  /* ---------------- 分叉 ---------------- */
  const src = await store.createSession(workspace, null)
  await store.appendMessages(src.id, [
    m('u1', 'user', '给接口加上限流'),
    m('a1', 'assistant', '', { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'src/api.ts' } }] }),
    m('t1', 'tool', 'export function api() {}', { toolName: 'read_file', toolCallId: 'c1' }),
    m('a2', 'assistant', '限流加好了'),
    m('u2', 'user', '再补个测试')
  ])

  const f1 = await store.forkSession(src.id, 'u1')
  check('分叉只带切点及之前的历史', f1.messages.length === 1, `len=${f1.messages.length}`)
  check('原会话一个字没动', (await store.loadSession(src.id)).messages.length === 5)
  check('标题标明是分叉', f1.title.endsWith('· 分叉'), f1.title)
  check('记得从哪分出来的', f1.forkedFrom === src.id)
  check('新会话是独立文件', f1.id !== src.id && fs.existsSync(path.join(userData, 'sessions', `${f1.id}.json`)))

  const f2 = await store.forkSession(src.id)
  check('不传消息就是复制整段', f2.messages.length === 5)

  // 切在「喊了工具、结果还没回来」处：新会话不能带着没有结果的 tool_calls，否则下次请求 400
  const dangling = await store.createSession(workspace, null)
  await store.appendMessages(dangling.id, [
    m('u9', 'user', '查一下'),
    m('a9', 'assistant', '', { toolCalls: [{ id: 'c9', name: 'grep', args: { pattern: 'x' } }] })
  ])
  const f3 = await store.forkSession(dangling.id)
  check(
    '分叉时剪掉悬空的工具调用',
    f3.messages.length === 1 && f3.messages[0].role === 'user',
    `len=${f3.messages.length}`
  )

  await store.removeSession(f2.id)
  check('删掉分叉不影响原会话', (await store.loadSession(src.id)).messages.length === 5)

  /* ---------------- 会话搜索 ---------------- */
  /**
   * 老版本写下的会话文件没有 title 字段。以前 searchSessions 直接
   * `s.title.toLowerCase()`，抛 TypeError 后被外层 catch 吞掉 ——
   * 表现为「这条会话明明有记录，搜关键词却搜不出来」。这里造一个真实的老文件。
   */
  const sessionsDir = path.join(userData, 'sessions')
  const legacyFile = path.join(sessionsDir, 'legacysearch001.json')
  await fs.promises.mkdir(sessionsDir, { recursive: true })
  await fs.promises.writeFile(
    legacyFile,
    JSON.stringify({
      id: 'legacysearch001',
      origin: 'old-version',
      createdAt: 1,
      updatedAt: 1,
      messages: [{ id: 'm1', role: 'user', content: '部署脚本怎么跑' }]
    }),
    'utf8'
  )
  const legacyHits = await store.searchSessions('部署脚本')
  check(
    '没有 title 的老会话也能被搜到',
    legacyHits.some((h) => h.id === 'legacysearch001'),
    `命中 ${legacyHits.length} 条`
  )
  check(
    '老会话的标题给占位而不是 undefined',
    legacyHits.find((h) => h.id === 'legacysearch001')?.title === '未命名会话'
  )
  await fs.promises.rm(legacyFile, { force: true })

  // IPC 边界没有类型保证：清空搜索框时可能传来 undefined，不该抛 TypeError
  const emptyHits = await store.searchSessions(undefined as unknown as string)
  check('搜索词为 undefined 时返回空结果而不是抛错', Array.isArray(emptyHits) && emptyHits.length === 0)

  /* ---------------- 会话便签 ---------------- */
  const ctx = { workspace, signal: new AbortController().signal, sessionId: src.id }
  const w1 = await executeTool('scratch', { text: '改了 src/api.ts，待会儿补测试' }, ctx)
  check('便签能写', /便签现在 \d+ 字/.test(w1), w1)
  await executeTool('scratch', { text: '测试文件放 src/api.test.ts' }, ctx)
  const read = await executeTool('scratch', {}, ctx)
  check('追加后能读回两条', read.includes('补测试') && read.includes('api.test.ts'))
  check('注入系统提示时带上内容', (await scratchForPrompt(src.id)).includes('api.test.ts'))
  check('别的会话看不到这份便签', (await scratchForPrompt('another-session')) === '')

  const replaced = await executeTool('scratch', { text: '只剩这一条', mode: 'replace' }, ctx)
  check('覆盖模式只剩新的那条', replaced.includes('覆盖') && !(await scratchForPrompt(src.id)).includes('补测试'))
  await executeTool('scratch', { clear: true }, ctx)
  check('清空后不再注入', (await scratchForPrompt(src.id)) === '')
  await clearScratch(src.id)

  /* ---------------- 「以后都这样」的授权 ---------------- */
  await grantTool(workspace, 'run_shell')
  const set = await loadGrantSet()
  // Windows 路径大小写不敏感：换个大小写也要能匹配上，否则「记住了但没生效」
  check('授权记下了（路径大小写不敏感）', set.has(grantKey(workspace.toUpperCase(), 'run_shell')))
  await grantTool(workspace, 'run_shell')
  check('重复记住不会长出第二条', (await listGrants()).length === 1, `n=${(await listGrants()).length}`)
  check('撤销单条', (await revokeGrant(workspace, 'run_shell')) === true)
  check('撤销后不再放行', !(await loadGrantSet()).has(grantKey(workspace, 'run_shell')))
  await grantTool(workspace, 'write_file')
  check('全部清空返回条数', (await clearGrants()) === 1)
  check('清空后一条不剩', (await listGrants()).length === 0)

  /* ---------------- /learn 蒸馏 ---------------- */
  const answer = JSON.stringify({
    name: '接口加限流',
    desc: '接口可能被刷时',
    prompt: '1. 找到路由注册处\n2. 在中间件链上加限流\n3. 跑测试确认 429 生效'
  })
  const srv = http.createServer(async (req, res) => {
    for await (const _ of req) {
      // 只关心请求到了没，内容不影响断言
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`)
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as { port: number }).port

  await saveConfig({
    ...defaultConfig(),
    workspace,
    activeId: 'fake',
    providers: [
      {
        id: 'fake',
        name: '假服务',
        kind: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'x',
        model: 'fake',
        contextWindow: 8192
      }
    ]
  })

  const learned = await distillSkill(src.id)
  check('蒸馏成功', learned.ok, learned.message)
  check('技能名解析对了', learned.skill?.name === '接口加限流', String(learned.skill?.name))
  check('指令里有分步', (learned.skill?.prompt ?? '').includes('中间件'))
  const all = await listSkills()
  check('技能进了技能面板', all.some((s) => s.name === '接口加限流'))

  // 没执行过工具的会话不该蒸馏出空技能
  const blank = await store.createSession(workspace, null)
  await store.appendMessages(blank.id, [m('u0', 'user', '你好')])
  const bad = await distillSkill(blank.id)
  check('没跑过工具的会话直接拒绝', !bad.ok && bad.message.includes('没执行过工具'), bad.message)

  srv.close()

  // 收拾：删掉这一轮建的会话
  for (const s of [src, dangling, blank, f1, f3]) {
    await store.removeSession(s.id).catch(() => undefined)
  }

  console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
  app.exit(fails ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  app.exit(1)
})
