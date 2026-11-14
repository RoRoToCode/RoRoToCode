import { app } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listAgents, resetAgents } from './agents'
import {
  cancelHandoff,
  enqueueHandoff,
  handoffPrompt,
  handoffsPath,
  listHandoffs,
  pumpHandoffs,
  startHandoffPump,
  stopHandoffPump
} from './handoff'
import { createSession, loadSession, removeSession } from './store'

/**
 * 交接自检：不碰真实模型。
 *
 * 真跑一次交接需要模型在线，那是人工验证的事；这里只保证机制本身对：
 * 能不能入队、空闲才放行、权限不升级、链路不会无限接力、取消后不留空会话。
 */

app.setPath('userData', path.join(os.tmpdir(), 'rorotocode-handoff-smoke'))

let failed = 0
const createdSessions: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`PASS  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name}${detail ? `  ::  ${detail}` : ''}`)
  }
}

void app.whenReady().then(async () => {
  try {
    await fs.rm(handoffsPath(), { force: true }).catch(() => undefined)
    await resetAgents()
    const agents = await listAgents()
    check('内置档案齐全：巡检 / 审查 / 主控', agents.length >= 3, `实际 ${agents.length}`)

    // 假 runner：只记录「放行了哪条」，不真的发消息
    let busy = false
    const launched: Array<{ id: string; sessionId: string }> = []
    startHandoffPump({
      busy: () => busy,
      launch: async (h, sessionId) => {
        launched.push({ id: h.id, sessionId })
        // 假回执：真跑的时候由 main.ts 从会话里读最后一句和用量
        if (h.task.includes('会炸')) throw new Error('模型没起来')
        return {
          status: 'ok' as const,
          summary: '改完了：给 /sessions 加了每分钟 60 次的限制',
          tokens: { prompt: 1200, completion: 340 },
          files: ['src/main/daemon.ts'],
          at: Date.now()
        }
      }
    })

    // 父会话：普通会话，没绑档案
    const parent = await createSession(null, null, null)
    createdSessions.push(parent.id)
    // 父会话的权限：没有明确 allow，所以交出去的活一律只读
    const h1 = await enqueueHandoff({
      fromSessionId: parent.id,
      toAgentId: 'agent_review',
      task: '把登录接口的限流补上',
      context: 'src/main/daemon.ts 的 /sessions 没有频率限制，任何人都能刷。',
      files: ['src/main/daemon.ts'],
      workspace: null
    })
    if (h1.sessionId) createdSessions.push(h1.sessionId)
    check('入队后处于排队状态', h1.status === 'pending')
    check('权限只继承不升级', h1.approvalPolicy === 'deny')
    check('链路第一手深度为 0', h1.depth === 0)

    const created = await loadSession(h1.sessionId!)
    check('交接立刻建好了会话', created.agentId === 'agent_review', String(created.agentId))
    check('会话标题带交接标记', created.title.startsWith('↳ 审查'), created.title)

    const prompt = await handoffPrompt(h1)
    check('交接单写明要做什么', prompt.includes('把登录接口的限流补上'))
    check('交接单带上对方的线索', prompt.includes('/sessions 没有频率限制'))
    check('交接单列出相关文件', prompt.includes('src/main/daemon.ts'))
    check('只读交接要提前说明写不了', prompt.includes('会被拒绝'))

    // 忙的时候不许插队
    busy = true
    const blocked = await pumpHandoffs()
    check('引擎忙时不放行', blocked.length === 0 && launched.length === 0)
    busy = false

    const ran = await pumpHandoffs()
    check('空闲时放行一条', ran.length === 1 && launched.length === 1, JSON.stringify(ran))
    const after = (await listHandoffs()).find((h) => h.id === h1.id)
    check('跑完状态记为 ok', after?.status === 'ok', String(after?.status))
    check('承载会话就是它自己那条', launched[0]?.sessionId === h1.sessionId)
    // 回执：结论 / token / 文件，三样都能在面板上一行看完
    check('回执记下了接手方的结论', after?.result?.summary.includes('每分钟 60 次') === true, after?.result?.summary)
    check(
      '回执只算这一手的 token',
      after?.result?.tokens.prompt === 1200 && after.result.tokens.completion === 340,
      JSON.stringify(after?.result?.tokens)
    )
    check('回执列出动了哪些文件', after?.result?.files?.[0] === 'src/main/daemon.ts')

    // 同一会话最多交出去两件：防止模型一口气撒十条
    const h2 = await enqueueHandoff({
      fromSessionId: parent.id,
      toAgentId: 'agent_patrol',
      task: '看看有没有别的地方缺限流',
      context: '同上',
      workspace: null
    })
    if (h2.sessionId) createdSessions.push(h2.sessionId)
    let thirdBlocked = false
    try {
      await enqueueHandoff({ fromSessionId: parent.id, toAgentId: 'agent_review', task: '第三件' })
    } catch {
      thirdBlocked = true
    }
    check('同一会话最多交出去两件', thirdBlocked)

    // 链路深度：parent → h1(0) → 从 h1 的会话再交(1) → 再交(2) → 第四次要被拒
    const hop2 = await enqueueHandoff({
      fromSessionId: h1.sessionId!,
      toAgentId: 'agent_patrol',
      task: '第二手'
    })
    if (hop2.sessionId) createdSessions.push(hop2.sessionId)
    check('第二手深度为 1', hop2.depth === 1, String(hop2.depth))
    const hop3 = await enqueueHandoff({
      fromSessionId: hop2.sessionId!,
      toAgentId: 'agent_review',
      task: '第三手'
    })
    if (hop3.sessionId) createdSessions.push(hop3.sessionId)
    check('第三手深度为 2', hop3.depth === 2, String(hop3.depth))
    let deepBlocked = false
    try {
      await enqueueHandoff({ fromSessionId: hop3.sessionId!, toAgentId: 'agent_patrol', task: '第四手' })
    } catch {
      deepBlocked = true
    }
    check('超过三手就拒绝继续传', deepBlocked)

    // 交给自己没有意义：同一份提示词、同一份记忆、同一套工具
    let selfBlocked = false
    try {
      await enqueueHandoff({ fromAgentId: 'agent_review', toAgentId: 'agent_review', task: '自己交给自己' })
    } catch {
      selfBlocked = true
    }
    check('不允许交给同一个档案', selfBlocked)

    // 取消：只对还在排队的有效，且不留空会话
    const parent2 = await createSession(null, null, null)
    createdSessions.push(parent2.id)
    const h4 = await enqueueHandoff({
      fromSessionId: parent2.id,
      toAgentId: 'agent_patrol',
      task: '这条会被取消'
    })
    const cancelled = await cancelHandoff(h4.id)
    check('排队中的可以取消', cancelled.ok)
    const gone = await loadSession(h4.sessionId!).then(
      () => false,
      () => true
    )
    check('取消后会话进回收站', gone)
    check('已完成的不许取消', (await cancelHandoff(h1.id)).ok === false)

    // 失败也要有回执：发起方得知道接手方挂在哪一步，而不是只看到「失败了」
    const parent3 = await createSession(null, null, null)
    createdSessions.push(parent3.id)
    const broke = await enqueueHandoff({
      fromSessionId: parent3.id,
      toAgentId: 'agent_patrol',
      task: '这条会炸'
    })
    if (broke.sessionId) createdSessions.push(broke.sessionId)
    // 队列里前面还有几条没放行（h2 / hop2 / hop3），要一直放到它为止
    for (let i = 0; i < 10; i++) {
      const started = await pumpHandoffs()
      const st = (await listHandoffs()).find((h) => h.id === broke.id)?.status
      if (!started.length || st === 'fail' || st === 'ok') break
    }
    const failed = (await listHandoffs()).find((h) => h.id === broke.id)
    check('失败时状态记为 fail', failed?.status === 'fail', String(failed?.status))
    check('失败也留下回执', failed?.result?.status === 'fail' && failed.result.summary.includes('模型没起来'), failed?.result?.summary)
    check('失败回执没有 token 就不编', failed?.result?.tokens.prompt === 0, JSON.stringify(failed?.result?.tokens))
  } catch (err) {
    failed++
    console.log(`FAIL  脚本异常 :: ${(err as Error).stack ?? (err as Error).message}`)
  } finally {
    stopHandoffPump()
    for (const id of createdSessions) await removeSession(id).catch(() => undefined)
    console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
    app.exit(failed === 0 ? 0 : 1)
  }
})
