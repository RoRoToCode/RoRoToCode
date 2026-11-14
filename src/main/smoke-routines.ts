import { app } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentsPath, forgetAgentCache, listAgents, resetAgents, removeAgent, upsertAgent } from './agents'
import { addBoardNote, boardForPrompt, boardInfo, clearBoard } from './board'
import { DEFAULT_AGENT_ID, handoffTargets } from '../shared/roster'
import {
  RETRY_MS,
  listRoutines,
  removeRoutine,
  runRoutine,
  setEnabled,
  startScheduler,
  stopScheduler,
  tick,
  upsertRoutine
} from './routines'
import { createSession, loadSession } from './store'

/**
 * 定时任务自检：不碰真实模型、不弹窗。
 *
 * 用假 runner 验证「该跑的跑了、不该跑的没跑」——真跑一次 agent 需要模型在线，
 * 那是人工验证的事。这里只保证调度逻辑本身没问题：到期、迟到太久、忙、并发。
 */

app.setPath('userData', path.join(os.tmpdir(), 'rorotocode-routines-smoke'))

let failed = 0

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
    // 内置档案：首次启动就该有，否则用户拿到的是个空列表
    const agents = await listAgents()
    check('首次启动自带档案', agents.length >= 3, `实际 ${agents.length}`)
    check('巡检档案存在且限定只读工具', Boolean(agents.find((a) => a.id === 'agent_patrol' && (a.tools ?? []).includes('read_file'))))

    // 主控 = 你自己在系统里的代理：能接活、能改代码，但行为和普通会话一致
    const master = agents.find((a) => a.id === DEFAULT_AGENT_ID)
    check('主控档案存在', Boolean(master))
    check('主控不限工具', master !== undefined && master.tools === undefined, JSON.stringify(master?.tools))
    check('主控不注入岗位说明', master?.role === '', JSON.stringify(master?.role))
    check('主控用工作区记忆，不另开命名空间', master?.ownMemory === false, String(master?.ownMemory))
    check('主控跟随当前工作区', (master?.workspace ?? null) === null)
    check('主控可以接别人的活：巡检能看到它', handoffTargets(agents, 'agent_patrol').some((a) => a.id === DEFAULT_AGENT_ID))
    check('主会话不把活交给主控：那等于交给自己', handoffTargets(agents, null).every((a) => a.id !== DEFAULT_AGENT_ID))

    // 删掉内置档案这件事必须真的生效：以前只是从列表里拿掉，下次启动又被补齐
    const patrol = agents.find((a) => a.id === 'agent_patrol')
    await removeAgent('agent_patrol')
    check('删掉的内置档案不会立刻补回来', !(await listAgents()).some((a) => a.id === 'agent_patrol'))
    forgetAgentCache()
    check('重开软件也不会补回来', !(await listAgents()).some((a) => a.id === 'agent_patrol'))
    const shape = JSON.parse(await fs.readFile(agentsPath(), 'utf8')) as { list?: unknown; deleted?: unknown }
    check('档案文件记下了删过谁', Array.isArray(shape.list) && Array.isArray(shape.deleted) && (shape.deleted as string[]).includes('agent_patrol'))
    if (patrol) await upsertAgent(patrol)
    check('手动保存能把删掉的档案加回来', (await listAgents()).some((a) => a.id === 'agent_patrol'))

    // 自建档案：工具白名单里塞一个不存在的名字，应该被丢掉而不是留成空集合
    const custom = await upsertAgent({
      name: '冒烟测试角色',
      role: '只负责冒烟',
      tools: ['read_file', '不存在的工具']
    })
    check('白名单会过滤掉认不出的工具名', custom.tools?.length === 1 && custom.tools[0] === 'read_file', JSON.stringify(custom.tools))
    check('新档案默认使用独立记忆', custom.ownMemory === true)

    // 会话绑定档案
    const session = await createSession(null, custom.id, null)
    const reloaded = await loadSession(session.id)
    check('会话能记住自己属于哪个档案', reloaded.agentId === custom.id, String(reloaded.agentId))

    await resetAgents()
    await removeAgent(custom.id)

    // ---- 调度 ----
    const fired: string[] = []
    startScheduler({
      busy: () => false,
      fire: async (r) => {
        fired.push(r.id)
        return `session-for-${r.id}`
      }
    })

    const routine = await upsertRoutine({
      name: '冒烟定时',
      agentId: 'agent_patrol',
      prompt: '看一眼有没有异常',
      trigger: { kind: 'interval', minutes: 60 },
      enabled: true
    })
    check('新建任务就算出了下一次时间', typeof routine.nextRunAt === 'number' && routine.nextRunAt > Date.now())

    // 还没到点：不该跑
    await tick(Date.now())
    check('没到点不跑', fired.length === 0, fired.join(','))

    // 到点：跑一次，并推进 nextRunAt
    await tick((routine.nextRunAt ?? 0) + 1000)
    const after = (await listRoutines()).find((r) => r.id === routine.id)
    check('到点跑了一次', fired.length === 1, `实际 ${fired.length}`)
    check('状态记为 ok 并留下会话 id', after?.lastStatus === 'ok' && after?.lastSessionId === `session-for-${routine.id}`)
    check('下一次时间被推进', (after?.nextRunAt ?? 0) > (routine.nextRunAt ?? 0))

    // 迟到太久：跳过，而不是开机后补跑
    await upsertRoutine({ ...after!, enabled: true })
    const stale = (await listRoutines()).find((r) => r.id === routine.id)!
    const beforeStale = fired.length
    await tick((stale.nextRunAt ?? 0) + 7 * 60 * 60 * 1000)
    const skipped = (await listRoutines()).find((r) => r.id === routine.id)
    check('迟到 7 小时不补跑', fired.length === beforeStale, `实际多跑了 ${fired.length - beforeStale} 次`)
    check('跳过会记一条原因', skipped?.lastStatus === 'skipped' && Boolean(skipped?.lastError))

    // 忙的时候不抢占
    stopScheduler()
    let busy = true
    let busyFired = 0
    startScheduler({
      busy: () => busy,
      fire: async () => {
        busyFired++
        return 'x'
      }
    })
    const r2 = await upsertRoutine({
      name: '忙时任务',
      agentId: '',
      prompt: '随便',
      trigger: { kind: 'interval', minutes: 5 },
      enabled: true
    })
    await tick((r2.nextRunAt ?? 0) + 1000)
    check('有任务在跑时不抢占', busyFired === 0, `实际 ${busyFired}`)
    busy = false
    await tick((r2.nextRunAt ?? 0) + 2000)
    check('空闲后补上这一次', busyFired === 1, `实际 ${busyFired}`)

    // 手动运行与定时共用一条路径
    const manual = await runRoutine(r2.id)
    check('手动运行能跑通', manual.ok === true, manual.error ?? '')

    // ---- 失败处理：先重试，连续失败才停用 ----
    stopScheduler()
    let boom = true
    let attempts = 0
    const disabledNames: string[] = []
    startScheduler({
      busy: () => false,
      disabled: (r) => disabledNames.push(r.name),
      fire: async () => {
        attempts++
        if (boom) throw new Error('模型没起来')
        return 'session-ok'
      }
    })
    const rf = await upsertRoutine({
      name: '会失败的任务',
      agentId: '',
      prompt: 'x',
      trigger: { kind: 'interval', minutes: 30 },
      enabled: true
    })

    await tick((rf.nextRunAt ?? 0) + 1000)
    const f1 = (await listRoutines()).find((r) => r.id === rf.id)!
    check('第一次失败记一条原因', f1.lastStatus === 'fail' && Boolean(f1.lastError), f1.lastError)
    check(
      '失败后两分钟就重试，而不是等到下一个排期',
      (f1.nextRunAt ?? 0) > Date.now() && (f1.nextRunAt ?? 0) <= Date.now() + RETRY_MS + 5000,
      String(f1.nextRunAt && f1.nextRunAt - Date.now())
    )
    check('第一次失败还没到停用线', f1.enabled === true && f1.consecutiveFails === 1, `${f1.enabled}/${f1.consecutiveFails}`)

    // 重试仍然失败：计数继续加，但还没停用
    await tick((f1.nextRunAt ?? 0) + 1000)
    const f2 = (await listRoutines()).find((r) => r.id === rf.id)!
    check('第二次失败继续累计', f2.consecutiveFails === 2 && f2.enabled === true, `${f2.enabled}/${f2.consecutiveFails}`)

    // 第三次失败：停用，别再半夜反复失败
    await tick((f2.nextRunAt ?? 0) + 1000)
    const f3 = (await listRoutines()).find((r) => r.id === rf.id)!
    check('连续三次失败自动停用', f3.enabled === false, String(f3.enabled))
    check('停用后不再排期', f3.nextRunAt === undefined, String(f3.nextRunAt))
    check('停用原因写在状态里', (f3.lastError ?? '').includes('自动停用'), f3.lastError)
    check('停用时通知一次，不能只让用户看到「又失败了一次」', disabledNames.includes('会失败的任务'), disabledNames.join(','))
    const stopAt = attempts
    await tick(Date.now() + 60 * 60_000)
    check('停用后不会再跑', attempts === stopAt, `多跑了 ${attempts - stopAt} 次`)

    // 修好之后重新启用：计数清零，跑通一次就回到 ok
    boom = false
    const back = await setEnabled(rf.id, true)
    check('重新启用时把失败计数清零', back?.enabled === true && back?.consecutiveFails === 0, `${back?.enabled}/${back?.consecutiveFails}`)
    await tick((back?.nextRunAt ?? 0) + 1000)
    const f4 = (await listRoutines()).find((r) => r.id === rf.id)!
    check('修好后跑通并清掉错误', f4.lastStatus === 'ok' && f4.consecutiveFails === 0 && !f4.lastError, `${f4.lastStatus}/${f4.consecutiveFails}`)
    await removeRoutine(rf.id)

    // 关掉的任务不跑：新建时就不该有 nextRunAt
    await removeRoutine(r2.id)
    const r3 = await upsertRoutine({ name: '停用的', agentId: '', prompt: 'x', trigger: { kind: 'interval', minutes: 1 }, enabled: false })
    check('停用的任务没有下一次时间', r3.nextRunAt === undefined, String(r3.nextRunAt))
    const before3 = busyFired
    await tick(Date.now() + 10 * 60_000)
    check('停用的任务不会被 tick 捡起来', busyFired === before3, `实际多跑了 ${busyFired - before3} 次`)

    await removeRoutine(routine.id)
    await removeRoutine(r2.id)
    await removeRoutine(r3.id)
    stopScheduler()

    // ---- 共享黑板：多 agent 共用的那一页 ----
    const ws = path.join(os.tmpdir(), 'rorotocode-board-smoke')
    await clearBoard(ws)
    const first = await addBoardNote(ws, 'rule', '测试跑 npm run verify')
    const second = await addBoardNote(ws, 'todo', '还没补 /sessions 的限流测试')
    const dup = await addBoardNote(ws, 'rule', '测试跑 npm run verify')
    check('黑板能写入两条', first.added && second.added && second.items === 2, JSON.stringify(second))
    check('同一条不会写两遍', dup.added === false && dup.items === 2, JSON.stringify(dup))

    const injected = await boardForPrompt(ws)
    check('黑板会随系统提示注入', injected.includes('[约定] 测试跑 npm run verify') && injected.includes('[待办] 还没补'), injected)
    const info = await boardInfo(ws)
    check('界面上能读回同样的内容', info.items === 2 && info.text.includes('## 待办'), info.path)

    await clearBoard(ws)
    check('清空后不再注入任何东西', (await boardForPrompt(ws)) === '')
  } catch (err) {
    failed++
    console.log(`FAIL  异常退出 :: ${(err as Error).stack ?? err}`)
  } finally {
    console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
    app.exit(failed ? 1 : 0)
  }
})
