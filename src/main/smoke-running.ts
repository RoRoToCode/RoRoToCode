/**
 * 验证「现在谁在干活」这条链路：登记 → 查询 → 清理。
 *
 * 做法：起一个故意慢 6 秒才回 500 的假服务，让两次运行真的卡在网络上。
 * 期间读 runningRuns()（应该看到两条、按开始时间排），中断后再读一次
 * （必须为空，否则界面会永久显示一个幽灵任务）。
 *
 * 会临时改写 config.json，跑完在 finally 里原样写回。
 */
import { app } from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { AgentEngine } from './agent'
import type { RunningRun } from '../shared/types'
import { loadConfig, saveConfig } from './config'
import * as store from './store'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let fails = 0
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) fails++
}

async function main(): Promise<void> {
  await app.whenReady()
  const userData = app.getPath('userData')
  const cfgFile = path.join(userData, 'config.json')
  const backup = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile) : null

  const srv = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(500)
      res.end('boom')
    }, 6000)
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as { port: number }).port

  const created: string[] = []
  try {
    const cfg = await loadConfig()
    // 只留一个指向假服务的供应商：确保这次运行一定卡在网络请求上
    cfg.providers = [
      {
        id: 'fake',
        name: '假服务',
        kind: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'x',
        model: 'fake',
        contextWindow: 4096
      }
    ]
    cfg.activeId = 'fake'
    cfg.maxSteps = 1
    await saveConfig(cfg)

    const engine = new AgentEngine(() => undefined)

    const a = await store.createSession(null, 'agent_patrol')
    created.push(a.id)
    const runA = engine.send(a.id, '看一眼有什么不对').catch(() => undefined)

    const b = await store.createSession(null, 'agent_review')
    created.push(b.id)
    const runB = engine.send(b.id, '看看这段能不能合').catch(() => undefined)

    await sleep(1500)
    const live = engine.runningRuns()
    check('两个会话同时在跑，能报出两条', live.length === 2)
    check('按开始时间排：巡检在前', live[0]?.agentId === 'agent_patrol')
    check('能报出是哪个档案', live[1]?.agentId === 'agent_review')
    check('有开始时间和标题', (live[0]?.startedAt ?? 0) > 0 && !!live[0]?.title)
    check('kind 记成用户提问', live.every((r) => r.kind === 'chat'))
    check('hasRunning 与清单一致', engine.hasRunning() === (live.length > 0))

    // 全局并发上限是 2：第三个会话必须排队，而不是一起挤进同一个模型服务
    const q = await store.createSession(null, 'agent_patrol')
    created.push(q.id)
    const runQ = engine.send(q.id, '第三个活').catch(() => undefined)
    await sleep(400)
    const queued = engine.runningRuns().find((r) => r.sessionId === q.id)
    check('超出上限的会话被登记成 queued', queued?.state === 'queued')
    check('排队位置是 1', queued?.position === 1)
    check('排队期间只有 2 个真的在跑', engine.activeRuns() === 2)
    check('排队数报得出来', engine.queuedRuns() === 1)

    engine.abort(a.id)
    engine.abort(b.id)
    await Promise.all([runA, runB])
    await sleep(400)

    // 前面两个让出槽位后，排队的这个应该自动接上
    const promoted = engine.runningRuns().find((r) => r.sessionId === q.id)
    check('有人跑完后排队的自动接上', promoted?.state === 'running')
    check('接上后位置归零', promoted?.position === 0)

    engine.abort(q.id)
    await runQ

    check('跑完清单清空', engine.runningRuns().length === 0)
    check('清空后 hasRunning 为假', !engine.hasRunning())
    check('清空后没有残留的占位', engine.activeRuns() === 0 && engine.queuedRuns() === 0)

    /**
     * 队列优先级：用户的话 > 交接 > 定时任务。
     * 场景：槽位已经占满，先来的是定时任务，后来的是用户提问 ——
     * 用户那条必须插到前面，否则就是「我打完字，半天没反应」。
     */
    const p1 = await store.createSession(null, 'agent_patrol')
    created.push(p1.id)
    const runP1 = engine.send(p1.id, '占住第一个槽位').catch(() => undefined)
    await sleep(150)
    const p2 = await store.createSession(null, 'agent_patrol')
    created.push(p2.id)
    const runP2 = engine.send(p2.id, '占住第二个槽位').catch(() => undefined)
    await sleep(500)

    // 现取而不是缓存：位置会随着别人跑完而前移
    const at = (id: string): RunningRun | undefined =>
      engine.runningRuns().find((r) => r.sessionId === id)

    const cronS = await store.createSession(null, 'agent_patrol')
    created.push(cronS.id)
    const runCron = engine.send(cronS.id, '定时任务：按表巡检', undefined, {
      reason: 'routine'
    }).catch(() => undefined)
    await sleep(700)
    check('定时任务先来，排在第一位', at(cronS.id)?.state === 'queued' && at(cronS.id)?.position === 1)

    const mineS = await store.createSession(null, 'agent_patrol')
    created.push(mineS.id)
    const runMine = engine.send(mineS.id, '用户刚打的字').catch(() => undefined)
    await sleep(500)

    check('用户后提交，但插到了定时任务前面', at(mineS.id)?.position === 1 && at(cronS.id)?.position === 2)
    check('定时任务在清单里标成 routine', at(cronS.id)?.kind === 'routine')
    check('用户那条标成 chat', at(mineS.id)?.kind === 'chat')

    // 只空出一个槽位：被提升的必须是用户那条
    engine.abort(p1.id)
    await runP1
    await sleep(300)
    check('空出一个槽位，先跑用户那条', at(mineS.id)?.state === 'running')
    check('定时任务还在等，位置变成 1', at(cronS.id)?.state === 'queued' && at(cronS.id)?.position === 1)

    engine.abort(p2.id)
    await runP2
    await sleep(300)
    check('再空一个槽位，定时任务才接上', at(cronS.id)?.state === 'running')

    engine.abort(mineS.id)
    engine.abort(cronS.id)
    await Promise.all([runMine, runCron])
    check(
      '优先级场景跑完后没有残留',
      engine.activeRuns() === 0 && engine.queuedRuns() === 0 && engine.runningRuns().length === 0
    )

    // 再跑一次，确认清理没有把状态弄坏（上次残留会让这里抛「正在运行中」）
    const c = await store.createSession(null, 'agent_patrol')
    created.push(c.id)
    let reused = true
    try {
      engine.send(c.id, '再来一次').catch(() => undefined)
      await sleep(300)
      check('同一会话可以再次运行（没有残留锁）', engine.runningRuns().length === 1)
      engine.abort(c.id)
    } catch {
      reused = false
    }
    check('再次运行没有抛「正在运行中」', reused)
  } finally {
    if (backup) fs.writeFileSync(cfgFile, backup)
    // 测试会话移到应用回收站，用户可以恢复，不会污染会话列表
    const trash = path.join(userData, 'sessions', '.trash')
    fs.mkdirSync(trash, { recursive: true })
    for (const id of created) {
      const f = path.join(userData, 'sessions', `${id}.json`)
      if (fs.existsSync(f)) fs.renameSync(f, path.join(trash, `${id}.json`))
    }
    srv.close()
  }

  console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
  app.exit(fails ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  app.exit(1)
})
