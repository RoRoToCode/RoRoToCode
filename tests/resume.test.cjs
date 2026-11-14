const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { downloadResumable } = require('../dist/main/resume.js')

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roro-dl-')), 'file.bin')

async function serve(handler) {
  const srv = http.createServer(handler)
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address()
  // undici 默认 keep-alive，不主动断连接的话 server.close() 会一直等，测试进程不退出
  const close = () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) })
  return { base: `http://127.0.0.1:${port}`, close }
}

test('源瞬间报错时不会秒换线：每个源至少给 switchMs 的窗口', async () => {
  // 以前：几个镜像几秒内被轮一遍，然后报「下载失败（已尝试 6 次）」
  const { base, close } = await serve((_req, res) => {
    res.writeHead(503)
    res.end('busy')
  })
  const dest = tmp()
  const ticks = []
  const started = Date.now()
  await assert.rejects(
    downloadResumable(
      [
        { label: '源A', url: `${base}/a` },
        { label: '源B', url: `${base}/b` }
      ],
      dest,
      { switchMs: 400, triesPerSource: 1, onTick: (t) => ticks.push(t) }
    ),
    /下载失败/
  )
  const elapsed = Date.now() - started
  // 两次尝试各给 400ms 窗口 + 收手前的基础退避，至少 1 秒
  assert.ok(elapsed >= 1000, `换线太快：只用了 ${elapsed}ms`)
  assert.ok(ticks.some((t) => /秒后换源/.test(t.source)), '进度里应提示几秒后换源')
  await close()
})

test('等待换线期间取消，立刻退出而不是等满 15 秒', async () => {
  const { base, close } = await serve((_req, res) => {
    res.writeHead(500)
    res.end('nope')
  })
  const ctrl = new AbortController()
  const started = Date.now()
  const p = downloadResumable([{ label: '源A', url: `${base}/a` }], tmp(), {
    switchMs: 5000,
    triesPerSource: 2,
    signal: ctrl.signal
  })
  setTimeout(() => ctrl.abort(), 300)
  await assert.rejects(p, /已取消/)
  assert.ok(Date.now() - started < 2500, '取消后应立即返回')
  await close()
})

test('正常下载仍然一次成功（新的等待逻辑不干扰成功路径）', async () => {
  const payload = Buffer.alloc(120 * 1024, 7)
  const { base, close } = await serve((_req, res) => {
    res.writeHead(200, { 'content-length': String(payload.length) })
    res.end(payload)
  })
  const dest = tmp()
  const ticks = []
  const r = await downloadResumable([{ label: '源A', url: `${base}/a` }], dest, {
    expectedBytes: payload.length,
    switchMs: 400,
    onTick: (t) => ticks.push(t)
  })
  assert.equal(r.label, '源A')
  assert.equal(fs.statSync(dest).size, payload.length)
  assert.ok(ticks.some((t) => t.speed > 0 || t.received === payload.length))
  await close()
})

test('界面进度回调抛错不能打断下载（切页面/面板卸载的典型情形）', async () => {
  const payload = Buffer.alloc(3 * 1024 * 1024, 9)
  const { base, close } = await serve((req, res) => {
    const range = req.headers.range
    const start = range ? Number(/bytes=(\d+)-/.exec(range)[1]) : 0
    res.writeHead(range ? 206 : 200, {
      'content-length': String(payload.length - start),
      'content-type': 'application/octet-stream',
      ...(range ? { 'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}` } : {})
    })
    res.end(payload.subarray(start))
  })
  const dest = tmp()
  // 模拟渲染层已经卸载：每次播报进度都抛异常
  await downloadResumable([{ label: '源A', url: `${base}/a` }], dest, {
    expectedBytes: payload.length,
    onTick: () => {
      throw new Error('面板已卸载')
    }
  })
  assert.equal(fs.statSync(dest).size, payload.length, '文件应完整落盘，不受进度回调影响')
  await close()
})

// ---------------------------------------------------------------- 分段并发

/** 支持 Range 的本地源；记录每次请求的区间，可给分片请求加延迟模拟快慢源 */
function rangeServe(payload, opts = {}) {
  const hits = []
  const srv = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '')
    const start = m ? Number(m[1]) : 0
    const end = m ? Math.min(Number(m[2]), payload.length - 1) : payload.length - 1
    hits.push({ path: req.url, start, end, probe: start === 0 && end === 65535 })
    if (start >= payload.length) {
      res.writeHead(416, { 'content-range': `bytes */${payload.length}` })
      res.end()
      return
    }
    const body = payload.subarray(start, end + 1)
    const write = () => {
      res.writeHead(206, {
        'content-length': String(body.length),
        'content-range': `bytes ${start}-${end}/${payload.length}`,
        'accept-ranges': 'bytes'
      })
      res.end(body)
    }
    // 探测也照常计延迟：并发测速本来就要靠这一步识别慢源
    const delay = opts.delay?.(req.url) ?? 0
    if (delay > 0) setTimeout(write, delay)
    else write()
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      resolve({
        base: `http://127.0.0.1:${port}`,
        hits,
        reset: () => { hits.length = 0 },
        close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) })
      })
    })
  })
}

const parallelOpts = (n) => ({
  expectedBytes: n,
  minParallelBytes: 1024,
  chunkBytes: 32 * 1024,
  segments: 4,
  switchMs: 50
})

test('同 family 的多个源同时分段下载，文件字节完全一致', async () => {
  const payload = crypto.randomBytes(512 * 1024)
  const { base, close, hits } = await rangeServe(payload)
  const dest = tmp()
  const r = await downloadResumable(
    [
      { label: '源A', url: `${base}/a`, family: 'hf' },
      { label: '源B', url: `${base}/b`, family: 'hf' }
    ],
    dest,
    parallelOpts(payload.length)
  )
  assert.match(r.label, /并发/)
  const count = { '/a': 0, '/b': 0 }
  for (const h of hits) count[h.path] += 1
  assert.ok(count['/a'] > 1 && count['/b'] > 1, `两个源都应参与分片：${JSON.stringify(count)}`)
  assert.equal(r.bytes, payload.length)
  assert.deepEqual(fs.readFileSync(dest), payload)
  await close()
})

test('远端总长不同的源被排除，不会拼进同一个文件', async () => {
  const payload = crypto.randomBytes(512 * 1024)
  const other = Buffer.alloc(payload.length * 2, 3)
  const hits = { good: 0, bad: 0 }
  const srv = http.createServer((req, res) => {
    const bad = req.url === '/bad'
    const data = bad ? other : payload
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '')
    const start = m ? Number(m[1]) : 0
    const end = m ? Math.min(Number(m[2]), data.length - 1) : data.length - 1
    if (bad) hits.bad++
    else hits.good++
    const body = data.subarray(start, end + 1)
    res.writeHead(206, {
      'content-length': String(body.length),
      'content-range': `bytes ${start}-${end}/${data.length}`
    })
    res.end(body)
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const dest = tmp()
  await downloadResumable(
    [
      { label: '快镜像', url: `${base}/good`, family: 'hf' },
      { label: '同名异文件', url: `${base}/bad`, family: 'hf' }
    ],
    dest,
    parallelOpts(payload.length)
  )
  assert.equal(hits.bad, 1, '内容不一致的源只应被探测一次，不参与分段')
  assert.deepEqual(fs.readFileSync(dest), payload)
  await new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) })
})

test('取消后重新下载按分片续传，不会重头开始', async () => {
  const payload = crypto.randomBytes(512 * 1024)
  const { base, close, hits, reset } = await rangeServe(payload, { delay: () => 30 })
  const dest = tmp()
  const ctrl = new AbortController()
  const sources = [{ label: '源A', url: `${base}/a`, family: 'hf' }]
  const timer = setTimeout(() => ctrl.abort(), 110)
  await assert.rejects(
    downloadResumable(sources, dest, { ...parallelOpts(payload.length), segments: 2, signal: ctrl.signal }),
    /已取消/
  )
  clearTimeout(timer)
  const kept = fs.statSync(dest).size
  assert.ok(kept > 0 && kept < payload.length, `取消应保留部分进度，实际 ${kept}/${payload.length}`)

  reset()
  await downloadResumable(sources, dest, { ...parallelOpts(payload.length), segments: 2 })
  assert.deepEqual(fs.readFileSync(dest), payload)
  const chunks = hits.filter((h) => !h.probe)
  assert.ok(chunks.length < 16, `续传只应请求剩余分片，实际 ${chunks.length}`)
  assert.ok(chunks.some((h) => h.start > 0), '应从分片断点继续')
  await close()
})

test('源不支持 Range 时自动回退串行，文件仍完整', async () => {
  const payload = crypto.randomBytes(200 * 1024)
  const { base, close } = await serve((_req, res) => {
    res.writeHead(200, { 'content-length': String(payload.length) })
    res.end(payload)
  })
  const dest = tmp()
  const r = await downloadResumable([{ label: '源A', url: `${base}/a` }], dest, parallelOpts(payload.length))
  assert.doesNotMatch(r.label, /并发/)
  assert.deepEqual(fs.readFileSync(dest), payload)
  await close()
})

test('慢源只拿少量分片，剩余分片由快源接管', async () => {
  const payload = crypto.randomBytes(512 * 1024)
  const { base, close, hits } = await rangeServe(payload, { delay: (p) => (p === '/slow' ? 90 : 0) })
  const dest = tmp()
  await downloadResumable(
    [
      { label: '快源', url: `${base}/fast`, family: 'hf' },
      { label: '慢源', url: `${base}/slow`, family: 'hf' }
    ],
    dest,
    parallelOpts(payload.length)
  )
  const chunks = hits.filter((h) => !h.probe)
  const slow = chunks.filter((h) => h.path === '/slow').length
  const fast = chunks.filter((h) => h.path === '/fast').length
  assert.ok(slow > 0, '慢源也应参与（同一 family 且内容一致）')
  assert.ok(fast > slow, `快源应领到更多分片：fast=${fast} slow=${slow}`)
  assert.deepEqual(fs.readFileSync(dest), payload)
  await close()
})
