import { createServer, type Server } from 'node:http'
import { acquireSlot, BusyError, gateKey, markHolding, queueInfoOf, resetGate } from './gate'

/**
 * 请求闸门自检：纯 Node，不需要 Electron，也不碰真实模型。
 *
 * 起两个假服务：一个报 1 个槽位，一个报 2 个。闸门应该照着服务端说的槽位数
 * 排队，而不是按写死的数字。验证的是「请求不会无声挂着」这件事本身。
 */

let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`PASS  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name}${detail ? `  ::  ${detail}` : ''}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 假 llama-server：只把 /props 答对，其余 404 */
function fakeServer(slots: number | null): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (slots !== null && req.url === '/props') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ total_slots: slots }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, port })
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()))
}

async function main(): Promise<void> {
  // 1. 探不到槽位（普通 HTTP / 中转站）→ 不闸，行为与以前完全一致
  const plain = await fakeServer(null)
  resetGate(`http://127.0.0.1:${plain.port}`)
  const noGate = await acquireSlot(`http://127.0.0.1:${plain.port}/v1`, new AbortController().signal)
  check('探不到 /props 的服务不闸（返回 null）', noGate === null, String(noGate))
  await close(plain.server)

  // 2. 单槽：第二个请求必须排队，而不是假装能同时跑
  const one = await fakeServer(1)
  const base1 = `http://127.0.0.1:${one.port}`
  resetGate(base1)
  const ctlA = new AbortController()
  const releaseA = await acquireSlot(`${base1}/v1`, ctlA.signal)
  check('单槽服务第一个请求立刻拿到槽位', typeof releaseA === 'function')

  const ctlB = new AbortController()
  let bAcquired = false
  const pendingB = acquireSlot(`${base1}/v1`, ctlB.signal).then((r) => {
    bAcquired = true
    return r
  })
  await sleep(60)
  check('第二个请求在排队（没有并发跑起来）', !bAcquired)
  const q1 = queueInfoOf(base1)
  check('队列可查：1 个在跑、1 个在等', q1?.active === 1 && q1?.queued === 1, JSON.stringify(q1))
  check('队列带上服务端槽位数', q1?.limit === 1, String(q1?.limit))

  // 3. 释放后槽位转交给排队者
  releaseA?.()
  const releaseB = await pendingB
  check('释放后排队者拿到槽位', bAcquired && typeof releaseB === 'function')
  const q2 = queueInfoOf(base1)
  check('转交后仍在跑 1 个、队列清空', q2?.active === 1 && q2?.queued === 0, JSON.stringify(q2))
  releaseB?.()
  const q3 = queueInfoOf(base1)
  check('全部释放后队列归零（不会漏放槽位）', !q3, JSON.stringify(q3))

  // 4. 排队中取消：必须立刻退出队列，不能留在那里等 2 分钟
  const ctlHold = new AbortController()
  const releaseHold = await acquireSlot(`${base1}/v1`, ctlHold.signal)
  const ctlCancel = new AbortController()
  const cancelP = acquireSlot(`${base1}/v1`, ctlCancel.signal).then(
    () => 'acquired',
    (e: Error) => e.message
  )
  await sleep(40)
  ctlCancel.abort()
  const cancelResult = await cancelP
  check('排队中取消 → 报「已取消」而不是死等', cancelResult === '已取消', String(cancelResult))
  releaseHold?.()
  check('取消后槽位没有泄漏', !queueInfoOf(base1), JSON.stringify(queueInfoOf(base1)))

  // 5. 队列上限：堆满了要立刻拒绝，并且给机器可读的 code
  const ctlFull = new AbortController()
  const releaseFull = await acquireSlot(`${base1}/v1`, ctlFull.signal)
  const waiters: Array<Promise<unknown>> = []
  const waiterCtls: AbortController[] = []
  for (let i = 0; i < 24; i++) {
    const c = new AbortController()
    waiterCtls.push(c)
    waiters.push(acquireSlot(`${base1}/v1`, c.signal).catch((e: Error) => e))
  }
  let fullErr: unknown = null
  try {
    await acquireSlot(`${base1}/v1`, new AbortController().signal)
  } catch (e) {
    fullErr = e
  }
  check(
    '队列满 → 立刻拒绝并带 code=QUEUE_FULL',
    fullErr instanceof BusyError && fullErr.code === 'QUEUE_FULL',
    fullErr instanceof Error ? fullErr.message.slice(0, 40) : String(fullErr)
  )
  check(
    '拒绝时给出重试建议（服务本机忙，不是额度问题）',
    fullErr instanceof BusyError && fullErr.retryAfterMs > 0,
    String(fullErr instanceof BusyError ? fullErr.retryAfterMs : '')
  )
  // 先取消等待者再释放槽位：顺序反过来的话槽会转交给某个已经没人管的等待者
  for (const c of waiterCtls) c.abort()
  await Promise.allSettled(waiters)
  releaseFull?.()
  check('队列满后取消全部等待者 → 队列归零，没有残留', !queueInfoOf(base1), JSON.stringify(queueInfoOf(base1)))
  await close(one.server)

  // 6. 双槽：两个请求可以同时跑，第三个才排队
  const two = await fakeServer(2)
  const base2 = `http://127.0.0.1:${two.port}`
  resetGate(base2)
  const r1 = await acquireSlot(`${base2}/v1`, new AbortController().signal)
  const r2 = await acquireSlot(`${base2}/v1`, new AbortController().signal)
  check('双槽服务两个请求都能立刻跑', typeof r1 === 'function' && typeof r2 === 'function')
  let third = false
  const p3 = acquireSlot(`${base2}/v1`, new AbortController().signal).then((r) => {
    third = true
    return r
  })
  await sleep(60)
  check('第三个请求在排队（照服务端槽位数为准）', !third && queueInfoOf(base2)?.queued === 1, JSON.stringify(queueInfoOf(base2)))
  r1?.()
  const r3 = await p3
  check('双槽下释放一个就轮到第三个', third && typeof r3 === 'function')
  r2?.()
  r3?.()
  await close(two.server)

  // 7. 持槽期间的内部请求（压缩 / 规划）不重复排队，否则单槽会自我死锁
  const three = await fakeServer(1)
  const base3 = `http://127.0.0.1:${three.port}`
  resetGate(base3)
  const outer = await acquireSlot(`${base3}/v1`, new AbortController().signal)
  const nested = await markHolding(() => acquireSlot(`${base3}/v1`, new AbortController().signal))
  check('持槽期间再发内部请求 → 不再排队（防死锁）', nested === null, String(nested))
  outer?.()
  check('嵌套请求不影响队列归零', !queueInfoOf(base3), JSON.stringify(queueInfoOf(base3)))
  await close(three.server)

  // 8. 归一化：同一个服务的 /v1 与裸地址必须是同一个闸门，否则并发会翻倍
  check(
    '同一个服务的不同写法归一到同一个闸门',
    gateKey('http://127.0.0.1:8080/v1') === gateKey('http://127.0.0.1:8080/'),
    gateKey('http://127.0.0.1:8080/v1')
  )

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
