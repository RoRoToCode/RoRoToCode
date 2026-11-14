const test = require('node:test')
const assert = require('node:assert/strict')
const {
  resolveGpuProfile,
  PERF_MIN_BUILD
} = require('../dist/shared/gpuprofile.js')

const cuda = (over = {}) => ({ build: 12211, cc: 8.6, pref: 'cuda', noFa: false, forceFa: false, ...over })

test('Ampere 及更新（cc≥8）：FA + KV 量化全开，ub 提到 1024', () => {
  const p = resolveGpuProfile(cuda({ cc: 8.6 }))
  assert.equal(p.tier, 'cuda-fa')
  assert.equal(p.fa, true)
  assert.equal(p.ctk, true)
  assert.equal(p.ctv, true)
  assert.equal(p.ub, 1024)
})

test('Turing（cc 7.5）：关 FA/V 量化，但 K cache 量化保留', () => {
  const p = resolveGpuProfile(cuda({ cc: 7.5 }))
  assert.equal(p.tier, 'cuda-nofa')
  assert.equal(p.fa, false)
  assert.equal(p.ctk, true) // 关键：K 量化不依赖 FA，8GB 小卡白拿一半 K cache
  assert.equal(p.ctv, false)
  assert.equal(p.ub, 0)
  assert.match(p.reason, /Turing/)
})

test('build 太老 / 识别不出：一律不加，宁慢勿崩', () => {
  assert.equal(resolveGpuProfile(cuda({ build: 4000, cc: 8.6 })).fa, false)
  assert.equal(resolveGpuProfile(cuda({ build: null, cc: 8.6 })).fa, false)
  assert.equal(resolveGpuProfile(cuda({ build: PERF_MIN_BUILD - 1, cc: 8.6 })).ctk, false)
})

test('ROROTO_LLAMA_NO_FA=1：全关', () => {
  const p = resolveGpuProfile(cuda({ cc: 8.6, noFa: true }))
  assert.equal(p.fa, false)
  assert.equal(p.ctk, false)
  assert.equal(p.ctv, false)
})

test('ROROTO_LLAMA_FORCE_FA=1：即使 cc<8 也强开 FA', () => {
  const p = resolveGpuProfile(cuda({ cc: 7.5, forceFa: true }))
  assert.equal(p.tier, 'cuda-fa')
  assert.equal(p.fa, true)
  assert.match(p.reason, /强制开/)
})

test('Vulkan / CPU 后端：FA 与 KV 量化默认都不加', () => {
  const vulkan = resolveGpuProfile(cuda({ pref: 'vulkan', cc: 8.6 }))
  assert.equal(vulkan.tier, 'vulkan')
  assert.equal(vulkan.fa, false)
  assert.equal(vulkan.ctk, false)
  // 提示里要给出开启方式，否则用户只能翻代码
  assert.match(vulkan.reason, /ROROTO_LLAMA_VULKAN_PERF/)

  const cpu = resolveGpuProfile(cuda({ pref: 'cpu', cc: 8.6 }))
  assert.equal(cpu.tier, 'cpu')
  assert.equal(cpu.fa, false)
})

test('Vulkan 显式开启：build 够新才给 FA / KV 量化', () => {
  const on = resolveGpuProfile(cuda({ pref: 'vulkan', cc: null, vulkanPerf: true }))
  assert.equal(on.tier, 'vulkan-fa')
  assert.equal(on.fa, true)
  assert.equal(on.ctk, true)
  assert.equal(on.ctv, true)
  // 老构建不认这些参数，即使开了开关也不能加
  const old = resolveGpuProfile(cuda({ pref: 'vulkan', cc: null, vulkanPerf: true, build: 5000 }))
  assert.equal(old.fa, false)
  assert.equal(old.ctk, false)
})

test('CUDA 但算力探不出：退回保守档，不赌 FA', () => {
  const p = resolveGpuProfile(cuda({ cc: null }))
  assert.equal(p.tier, 'cuda-nofa')
  assert.equal(p.fa, false)
  assert.equal(p.ctk, false)
})
