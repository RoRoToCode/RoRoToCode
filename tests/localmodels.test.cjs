const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { isInsideAnyRoot, isModelFileName } = require('../dist/shared/modelpath.js')
const { samplingBody } = require('../dist/shared/chatbody.js')
const { sha256Of } = require('../dist/main/filehash.js')

/* ── 删除路径的边界 ───────────────────────────────────────── */

test('isInsideAnyRoot：目录内的文件放行，目录本身拒绝', () => {
  const root = path.resolve(os.tmpdir(), 'roroto-models')
  assert.equal(isInsideAnyRoot([root], path.join(root, 'a.gguf')), true)
  assert.equal(isInsideAnyRoot([root], path.join(root, 'sub', 'b.gguf')), true)
  // 目录本身不能当文件删
  assert.equal(isInsideAnyRoot([root], root), false)
})

test('isInsideAnyRoot：../ 逃逸一律拒绝', () => {
  const root = path.resolve(os.tmpdir(), 'roroto-models')
  assert.equal(isInsideAnyRoot([root], path.join(root, '..', 'secret.gguf')), false)
  assert.equal(isInsideAnyRoot([root], path.join(root, '..', '..', 'windows', 'system32', 'x.gguf')), false)
})

test('isInsideAnyRoot：多个根目录里命中任意一个即可', () => {
  const a = path.resolve(os.tmpdir(), 'root-a')
  const b = path.resolve(os.tmpdir(), 'root-b')
  assert.equal(isInsideAnyRoot([a, b], path.join(b, 'm.gguf')), true)
  assert.equal(isInsideAnyRoot([a, b], path.join(os.tmpdir(), 'elsewhere', 'm.gguf')), false)
  // 空根 / 空路径不能误放行
  assert.equal(isInsideAnyRoot([''], path.join(a, 'm.gguf')), false)
  assert.equal(isInsideAnyRoot([a], ''), false)
})

test('isModelFileName：只认 .gguf', () => {
  assert.equal(isModelFileName('C:/m/x.GGUF'), true)
  assert.equal(isModelFileName('C:/m/x.gguf'), true)
  assert.equal(isModelFileName('C:/m/x.json'), false)
  assert.equal(isModelFileName('C:/m/x.gguf.part'), false)
  assert.equal(isModelFileName('C:/m/gguf'), false)
})

/* ── 采样参数 ─────────────────────────────────────────────── */

test('samplingBody：没填就不发送，别替服务端做主', () => {
  assert.deepEqual(samplingBody({}, false), {})
  assert.deepEqual(samplingBody({ topP: undefined, repeatPenalty: undefined }, false), {})
})

test('samplingBody：填了才带上，非法数值丢弃', () => {
  assert.deepEqual(samplingBody({ topP: 0.9, repeatPenalty: 1.1 }, false), {
    top_p: 0.9,
    repeat_penalty: 1.1
  })
  // NaN / Infinity 不能混进请求体
  assert.deepEqual(samplingBody({ topP: NaN, repeatPenalty: Infinity }, false), {})
})

test('samplingBody：jsonMode 只在无工具时生效', () => {
  assert.deepEqual(samplingBody({ jsonMode: true }, false), { response_format: { type: 'json_object' } })
  // 带工具时必须让出去：否则模型会把 tool_calls 写成普通 JSON 文本
  assert.deepEqual(samplingBody({ jsonMode: true }, true), {})
  assert.deepEqual(samplingBody({ jsonMode: false }, false), {})
})

/* ── 哈希校验 ─────────────────────────────────────────────── */

test('sha256Of：与 crypto 直算一致，并且能报进度', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roroto-hash-'))
  const file = path.join(dir, 'blob.bin')
  // 5 MB：跨过多个 4 MB 读块，验证流式拼接没漏字节
  const buf = crypto.randomBytes(5 * 1024 * 1024)
  fs.writeFileSync(file, buf)
  try {
    const want = crypto.createHash('sha256').update(buf).digest('hex')
    assert.equal(await sha256Of(file), want)

    // 小文件不到 128 MB 的阈值，不该报进度（否则界面会闪一堆 0%）
    let ticks = 0
    await sha256Of(file, () => ticks++)
    assert.equal(ticks, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sha256Of：内容变一个字节，哈希就不同', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roroto-hash-'))
  const a = path.join(dir, 'a.bin')
  const b = path.join(dir, 'b.bin')
  fs.writeFileSync(a, 'hello world')
  fs.writeFileSync(b, 'hello worle')
  try {
    assert.notEqual(await sha256Of(a), await sha256Of(b))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sha256Of：文件不存在时抛错，由调用方降级成「这次不校验」', async () => {
  await assert.rejects(() => sha256Of(path.join(os.tmpdir(), 'definitely-missing-roroto.bin')))
})

/* ── Ollama 日志 → 显卡名（界面「当前用哪张卡」的依据） ─────────────── */

const { parseOllamaLogDevices, shortGpuName } = require('../dist/shared/ollamagpu.js')

test('parseOllamaLogDevices：取最后一次加载用到的显卡', () => {
  const log = [
    'ggml_cuda_init: found 1 CUDA devices (Total VRAM: 8191 MiB):',
    'llama_prepare_model_devices: using device CUDA0 (NVIDIA GeForce RTX 2080) (0000:01:00.0) - 7113 MiB free',
    'load_tensors: offloaded 34/34 layers to GPU',
    'ggml_cuda_init: found 2 CUDA devices (Total VRAM: 16384 MiB):',
    'llama_prepare_model_devices: using device CUDA0 (NVIDIA GeForce RTX 4090) (0000:01:00.0) - 12000 MiB free',
    'llama_prepare_model_devices: using device CUDA1 (NVIDIA GeForce RTX 4090) (0000:02:00.0) - 12000 MiB free'
  ].join('\n')
  // 第二次加载用了两张卡：上一轮的 2080 不能残留
  assert.deepEqual(parseOllamaLogDevices(log), ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 4090'])
})

test('parseOllamaLogDevices：多卡时按设备顺序全列出来（同型号两张也要算两张）', () => {
  const log = [
    'llama runner started in 3.2 seconds',
    'ggml_cuda_init: found 2 CUDA devices (Total VRAM: 16384 MiB):',
    'llama_prepare_model_devices: using device CUDA0 (NVIDIA GeForce RTX 4090) (0000:01:00.0) - 12000 MiB free',
    'llama_prepare_model_devices: using device CUDA1 (NVIDIA GeForce RTX 4090) (0000:02:00.0) - 12000 MiB free'
  ].join('\n')
  assert.deepEqual(parseOllamaLogDevices(log), ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 4090'])
})

test('parseOllamaLogDevices：纯 CPU 加载不当作显卡', () => {
  const log = [
    'ggml_cuda_init: found 1 CUDA devices (Total VRAM: 8191 MiB):',
    'llama_prepare_model_devices: using device CUDA0 (NVIDIA GeForce RTX 2080) (0000:01:00.0) - 7113 MiB free',
    'ggml_cpu_init: numa=0',
    'llama_prepare_model_devices: using device CPU',
    'load_tensors: offloaded 0/34 layers to GPU'
  ].join('\n')
  // 最后一次加载是 CPU：不能把上一轮的卡当成「现在用的卡」
  assert.deepEqual(parseOllamaLogDevices(log), [])
})

test('parseOllamaLogDevices：只有 inference compute 行时也能读出型号', () => {
  const log =
    'time=2026-11-13T17:06:02.940+08:00 level=INFO source=types.go:32 msg="inference compute" id=0 filter_id=0 library=CUDA compute=7.5 name=CUDA0 description="NVIDIA GeForce RTX 2080" libdirs=ollama,cuda_v12 driver=12.4 type=discrete total="8.0 GiB"'
  assert.deepEqual(parseOllamaLogDevices(log), ['NVIDIA GeForce RTX 2080'])
})

test('parseOllamaLogDevices：空日志 / 垃圾日志返回空数组，不抛错', () => {
  assert.deepEqual(parseOllamaLogDevices(''), [])
  assert.deepEqual(parseOllamaLogDevices('[GIN] 200 | GET "/api/ps"'), [])
})

test('shortGpuName：去掉厂商前缀，顶栏胶囊放得下', () => {
  assert.equal(shortGpuName('NVIDIA GeForce RTX 2080'), 'RTX 2080')
  assert.equal(shortGpuName('NVIDIA RTX A4000'), 'RTX A4000')
  assert.equal(shortGpuName('AMD Radeon RX 7900 XTX'), 'RX 7900 XTX')
  assert.equal(shortGpuName('Intel(R) Arc(TM) A770'), 'Arc A770')
})
