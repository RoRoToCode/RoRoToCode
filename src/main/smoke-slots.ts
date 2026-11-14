/**
 * 多槽实测的冒烟：用一个假 llama.cpp 服务把四种结局都演一遍。
 *
 * 为什么要造四种，而不是只测「能连上」：
 * 这个探针的价值全在**判定**上。判定错了比不测更糟——用户会按一个错误结论去调参数。
 * 所以这里要分别证明：
 *   - 真并行 → 说 parallel
 *   - 按槽切分上下文 → 说 slot-split（并指出缺 -kvu）
 *   - 排队跑 → 说 serialized（并建议把槽位调回 1）
 *   - 不是 llama.cpp → 说 unsupported（不硬猜）
 *
 * 串行那一条尤其关键：两个 0.4 窗口的请求串行跑，总时长正好等于一个 0.8 窗口的，
 * 用「总耗时」判会得出「并行正常」的错误结论。这里靠区间重叠判，用例就是为了守住它。
 */
import { app } from 'electron'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { probeSlotsConcurrency } from './slotscheck'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}${detail ? `  → ${detail}` : ''}`)
  }
}

interface FakeOpts {
  slots: number
  /** parallel = 真并发；serial = 排队；split = 每槽只有 ctx/slots 的窗口 */
  mode: 'parallel' | 'serial' | 'split'
  ctx: number
  /** 每个请求占用的时间 */
  delayMs: number
  /** /props 是否返回 404（模拟不是 llama.cpp 的服务） */
  noProps?: boolean
}

interface Fake {
  baseUrl: string
  close: () => Promise<void>
  stats: { maxInflight: number; calls: number; rejected: number }
}

function startFake(opts: FakeOpts): Promise<Fake> {
  const stats = { maxInflight: 0, calls: 0, rejected: 0 }
  let inflight = 0
  // 串行队列：一次只让一个请求进「处理中」
  let chain: Promise<void> = Promise.resolve()

  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0]

    if (url === '/props') {
      if (opts.noProps) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ total_slots: opts.slots, default_generation_settings: { n_parallel: opts.slots } }))
      return
    }

    if (url === '/v1/chat/completions' && req.method === 'POST') {
      let body = ''
      req.on('data', (d) => {
        body += d.toString()
      })
      req.on('end', () => {
        stats.calls += 1
        let tokens = 0
        try {
          const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> }
          tokens = (parsed.messages ?? []).reduce((n, m) => n + (m.content?.length ?? 0), 0)
        } catch {
          // 解析不了就当很短的请求
        }

        // 按槽切分：每个槽只有 ctx/slots
        const perSlot = opts.mode === 'split' ? Math.floor(opts.ctx / opts.slots) : opts.ctx
        if (tokens > perSlot) {
          stats.rejected += 1
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              error: {
                message: `the request exceeds the available context size, try increasing it (n_ctx = ${perSlot})`,
                type: 'invalid_request_error'
              }
            })
          )
          return
        }

        const respond = (): Promise<void> =>
          new Promise((resolve) => {
            inflight += 1
            stats.maxInflight = Math.max(stats.maxInflight, inflight)
            setTimeout(() => {
              inflight -= 1
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(
                JSON.stringify({
                  choices: [{ message: { role: 'assistant', content: 'ok' } }],
                  usage: { prompt_tokens: tokens, completion_tokens: 1 }
                })
              )
              resolve()
            }, opts.delayMs)
          })

        if (opts.mode === 'serial') {
          // 排队：前一个处理完了才让下一个进
          chain = chain.then(respond)
        } else {
          void respond()
        }
      })
      return
    }

    res.writeHead(404).end('not found')
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        stats,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.()
            server.close(() => done())
          })
      })
    })
  })
}

async function main(): Promise<void> {
  const ctx = 8192

  // ---- 1. 真并行 ----
  {
    const fake = await startFake({ slots: 2, mode: 'parallel', ctx, delayMs: 220 })
    try {
      const r = await probeSlotsConcurrency({ baseUrl: fake.baseUrl, model: 'fake', contextWindow: ctx })
      check('真并行 → 判定 parallel', r.verdict === 'parallel', r.verdict + ' / ' + r.message)
      check('报出服务端槽位数 2', r.slots === 2, String(r.slots))
      check('单个长请求成功（说明 KV 是共享池）', r.singleMs !== null && r.singleMs > 0, String(r.singleMs))
      check('并发期间服务端确实同时处理了 2 个', fake.stats.maxInflight === 2, String(fake.stats.maxInflight))
      check('结论里点明 -kvu 生效', r.message.includes('-kvu'), r.message)
    } finally {
      await fake.close()
    }
  }

  // ---- 2. 按槽切分：单个 0.8 窗口的长请求就该超窗 ----
  {
    const fake = await startFake({ slots: 2, mode: 'split', ctx, delayMs: 50 })
    try {
      const r = await probeSlotsConcurrency({ baseUrl: fake.baseUrl, model: 'fake', contextWindow: ctx })
      check('上下文被切成 1/N → 判定 slot-split', r.verdict === 'slot-split', r.verdict + ' / ' + r.message)
      check('指出缺 -kvu', r.message.includes('-kvu'), r.message)
      check('算出每槽的实际窗口', /每槽约 \d+/.test(r.message), r.message)
      check('没有继续去测并发（第一步就失败了）', fake.stats.calls === 1, String(fake.stats.calls))
    } finally {
      await fake.close()
    }
  }

  // ---- 3. 排队跑：两个请求都成功，但时间上不重叠 ----
  {
    const fake = await startFake({ slots: 2, mode: 'serial', ctx, delayMs: 200 })
    try {
      const r = await probeSlotsConcurrency({ baseUrl: fake.baseUrl, model: 'fake', contextWindow: ctx })
      check('排队跑 → 判定 serialized（不被总耗时骗到）', r.verdict === 'serialized', r.verdict + ' / ' + r.message)
      check('服务端从未同时处理 2 个', fake.stats.maxInflight === 1, String(fake.stats.maxInflight))
      check('建议把槽位调回 1', r.message.includes('调回 1'), r.message)
    } finally {
      await fake.close()
    }
  }

  // ---- 4. 不是 llama.cpp：不硬猜 ----
  {
    const fake = await startFake({ slots: 2, mode: 'parallel', ctx, delayMs: 20, noProps: true })
    try {
      const r = await probeSlotsConcurrency({ baseUrl: fake.baseUrl, model: 'fake', contextWindow: ctx })
      check('探不到槽位 → unsupported，且不做任何请求', r.verdict === 'unsupported' && fake.stats.calls === 0, r.verdict)
      check('文案说明「测不了」而不是「不支持并发」', r.message.includes('测不了'), r.message)
    } finally {
      await fake.close()
    }
  }

  // ---- 5. 服务根本没起 ----
  {
    const r = await probeSlotsConcurrency({ baseUrl: 'http://127.0.0.1:1/v1', model: 'x', contextWindow: 8192 })
    check('连不上 → unsupported（不是崩）', r.verdict === 'unsupported', r.verdict)
  }
}

main()
  .catch((err) => {
    console.error('冒烟异常:', err)
    failed += 1
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    app.exit(failed === 0 ? 0 : 1)
  })
