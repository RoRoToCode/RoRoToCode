const test = require('node:test')
const assert = require('node:assert/strict')
const {
  CTX_TIERS,
  tierList,
  predictFootMiB,
  bestTier,
  adjacentTier,
  fingerprintOf,
  sameFingerprint,
  classifyLoadFailure,
  slotWindowOk,
  probeStartTier
} = require('../dist/shared/ctxtune.js')

test('档位表：原生窗口不在表里时补成一档', () => {
  assert.deepEqual(tierList(null), [...CTX_TIERS])
  assert.deepEqual(tierList(262144), [...CTX_TIERS, 262144])
  // 已经表里有的不重复加
  assert.deepEqual(tierList(65536), [...CTX_TIERS])
})

test('外推：KV 随上下文线性增长，其它部分不变', () => {
  const probe = { ctx: 32768, footMiB: 5886 }
  // 每 1K tokens 24 MiB：32K → 64K 多 32.768K，即 32.768 × 24 = 786.4 MiB
  assert.equal(predictFootMiB(probe, 65536, 24), 5886 + 32.768 * 24)
  assert.equal(predictFootMiB(probe, 32768, 24), 5886)
  // 斜率缺失时不当成 0 上下文，直接退回实测值
  assert.equal(predictFootMiB(probe, 131072, 0), 5886)
})

test('实测 32K 占 5886 MiB 时，8GB 卡（上限 7700）应升到 64K', () => {
  const pick = bestTier({
    probe: { ctx: 32768, footMiB: 5886 },
    kvMiBPerK: 24,
    limitMiB: 7700,
    reserveMiB: 320,
    nativeCtx: 262144
  })
  assert.equal(pick.ctx, 65536)
  assert.equal(Math.round(pick.footMiB), 6672)
  assert.equal(pick.limitedBy, 'none')
})

test('余量不够时不升：64K 的预算被砍到 6900 就停在 32K', () => {
  const pick = bestTier({
    probe: { ctx: 32768, footMiB: 5886 },
    kvMiBPerK: 24,
    limitMiB: 6900,
    reserveMiB: 320,
    nativeCtx: 262144
  })
  assert.equal(pick.ctx, 32768)
})

test('训练窗口是硬边界：原生只有 32K 时不会给出 64K', () => {
  const pick = bestTier({
    probe: { ctx: 16384, footMiB: 5000 },
    kvMiBPerK: 24,
    limitMiB: 7700,
    nativeCtx: 32768
  })
  assert.equal(pick.ctx, 32768)
  assert.equal(pick.limitedBy, 'native')
})

test('一档都装不下：返回最小档并标明是显存问题', () => {
  const pick = bestTier({
    probe: { ctx: 4096, footMiB: 7900 },
    kvMiBPerK: 24,
    limitMiB: 7000
  })
  assert.equal(pick.ctx, 4096)
  assert.equal(pick.limitedBy, 'vram')
})

test('相邻档位：只在表内移动，到头返回 null', () => {
  assert.equal(adjacentTier(32768, 1), 65536)
  assert.equal(adjacentTier(32768, -1), 16384)
  assert.equal(adjacentTier(131072, 1), null)
  assert.equal(adjacentTier(4096, -1), null)
  // 用户手填的怪数字也要有去处
  assert.equal(adjacentTier(50000, 1), 65536)
  assert.equal(adjacentTier(50000, -1), 32768)
})

test('指纹：字段一致才算命中，任何一项变化都作废', () => {
  const base = {
    gpuName: 'RTX 3050',
    vramMiB: 8192,
    driver: '560.94',
    model: 'qwen2.5-coder-7b-q4_k_m.gguf',
    modelBytes: 4_400_000_000,
    modelMtimeMs: 1_760_000_000_000,
    kvType: 'q8_0',
    parallel: 0,
    flashAttn: true,
    extra: '',
    contextLimit: false
  }
  const a = fingerprintOf(base)
  // 键序打乱不该影响结果
  const shuffled = Object.fromEntries(Object.entries(base).reverse())
  assert.equal(fingerprintOf(shuffled), a)
  assert.equal(fingerprintOf({ ...base }), a)
  // 同名模型但重新下载过（mtime / 体积变了）→ 必须失效
  assert.notEqual(fingerprintOf({ ...base, modelMtimeMs: base.modelMtimeMs + 1 }), a)
  assert.notEqual(fingerprintOf({ ...base, modelBytes: base.modelBytes + 1 }), a)
  // 换 KV 精度 / 开槽 / 关 FA → 显存占用变了，结论不能再复用
  assert.notEqual(fingerprintOf({ ...base, kvType: 'f16' }), a)
  assert.notEqual(fingerprintOf({ ...base, parallel: 4 }), a)
  assert.notEqual(fingerprintOf({ ...base, flashAttn: false }), a)
  assert.equal(sameFingerprint(a, a), true)
  assert.equal(sameFingerprint(a, undefined), false)
  assert.equal(sameFingerprint('', ''), false)
})

test('失败归因：只有显存类失败才值得降档', () => {
  assert.equal(classifyLoadFailure('ggml_backend_cuda_buffer_type_alloc_buffer: failed to allocate 2048.00 MiB'), 'vram')
  assert.equal(classifyLoadFailure('CUDA error: out of memory'), 'vram')
  assert.equal(classifyLoadFailure('failed to allocate KV cache: 显存不足'), 'vram')
  assert.equal(classifyLoadFailure('the request exceeds the available context size (n_ctx = 16384)'), 'native')
  // 文件损坏 / 参数非法 / 驱动崩：降档无用，必须原样报出来
  assert.equal(classifyLoadFailure('error loading model: unknown model architecture: qwen4'), 'other')
  assert.equal(classifyLoadFailure('invalid magic in gguf file'), 'other')
  assert.equal(classifyLoadFailure('CUDA error: an illegal memory access was encountered'), 'other')
  assert.equal(classifyLoadFailure(''), 'other')
})

test('单槽窗口：多槽把总窗口切分后不够 agent 用就判不合格', () => {
  assert.equal(slotWindowOk(65536, 0), true)
  assert.equal(slotWindowOk(65536, 1), true)
  assert.equal(slotWindowOk(65536, 4), true)
  // 64K 开 6 槽 → 每槽约 10.6K，低于 12K 门槛
  assert.equal(slotWindowOk(65536, 6), false)
  assert.equal(slotWindowOk(16384, 2), false)
  // 探不到槽位数时放行，不要因为探测失败拦用户
  assert.equal(slotWindowOk(8192, 0), true)
})

test('探测起点：不贴上限就用体检档，贴上限才降一档', () => {
  assert.equal(probeStartTier({ recommendedCtx: 65536, nativeCtx: 262144, maxCtx: 131072 }), 65536)
  assert.equal(probeStartTier({ recommendedCtx: 65536, nativeCtx: 262144, maxCtx: 32768 }), 32768)
  assert.equal(probeStartTier({ recommendedCtx: 65536, nativeCtx: 262144, maxCtx: 131072, tight: true }), 32768)
  // 已经是最低档时不能再降
  assert.equal(probeStartTier({ recommendedCtx: 4096, nativeCtx: 262144, maxCtx: 131072, tight: true }), 4096)
  // 体检算不出（元数据不全）时退回上限，但不能越过原生窗口
  assert.equal(probeStartTier({ recommendedCtx: null, nativeCtx: 32768, maxCtx: 131072 }), 32768)
  assert.equal(probeStartTier({ recommendedCtx: null, nativeCtx: null, maxCtx: 131072 }), 131072)
})
