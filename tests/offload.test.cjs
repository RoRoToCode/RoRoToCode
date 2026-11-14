const test = require('node:test')
const assert = require('node:assert/strict')
const { fitTargetMiB, shouldPartialOffload, shouldProbeChain, partialModeOf } = require('../dist/shared/ctxtune.js')

/**
 * `--fit-target` 的语义是「分配完还要留多少空闲」，而体检的 limitMiB 已经是 free×0.92。
 *
 * 旧实现按 limit×10%（小卡 15%）再扣一遍，等于同一块显存扣了两次：
 * 8 GB 卡 32K 实测 `--fit-target 917` 只有 15.9 tok/s，改成 300 立刻 32 tok/s。
 * 现在只补 4% 净空，夹在 192~512。
 */
test('fitTargetMiB：只补体检之外的那点净空，不再二次扣预算', () => {
  // 8 GB 卡：limit 8192 → 328 MiB（旧实现是 819，白少放半个 GB 的层）
  assert.equal(fitTargetMiB(8192), 328)
  // 4 GB 卡：164 低于下限，抬到 192
  assert.equal(fitTargetMiB(4096), 192)
  assert.equal(fitTargetMiB(2048), 192)
  // 大卡封顶 512：再多就是白少放层
  assert.equal(fitTargetMiB(24576), 512)
  assert.equal(fitTargetMiB(81920), 512)
  // 拿不到预算时给上游默认 1024 的一半左右，够 WDDM 周转也不至于吃掉一整档
  assert.equal(fitTargetMiB(null), 320)
  assert.equal(fitTargetMiB(undefined), 320)
  assert.equal(fitTargetMiB(0), 320)
  // totalMiB 不影响结果：差的是「净空」，与卡的总容量无关
  assert.equal(fitTargetMiB(8192, { totalMiB: 8192 }), 328)
  assert.equal(fitTargetMiB(8192, { totalMiB: 81920 }), 328)
})

test('partialModeOf：老布尔值迁移成 auto / off', () => {
  // 新字段优先
  assert.equal(partialModeOf({ mode: 'on', enabled: false }), 'on')
  assert.equal(partialModeOf({ mode: 'off', enabled: true }), 'off')
  // 老配置 true 的语义本来就是「装不下才降级」，升级成 auto 而不是 on
  assert.equal(partialModeOf({ enabled: true }), 'auto')
  assert.equal(partialModeOf({ enabled: false }), 'off')
  // 什么都没有：默认 auto（用户要的就是「大于显存的自动开，普通的不开」）
  assert.equal(partialModeOf({}), 'auto')
  assert.equal(partialModeOf({ mode: 'banana' }), 'auto')
})

test('shouldPartialOffload：auto 只在装不下时分层', () => {
  const base = { mode: 'auto', fits: false, device: 'CUDA0', probing: false }
  assert.equal(shouldPartialOffload(base), true)
  // 装得下：普通模型不动，全放显存最快
  assert.equal(shouldPartialOffload({ ...base, fits: true }), false)
  // 纯 CPU：没有「部分」可言
  assert.equal(shouldPartialOffload({ ...base, device: 'cpu' }), false)
  assert.equal(shouldPartialOffload({ ...base, device: 'CPU' }), false)
  assert.equal(shouldPartialOffload({ ...base, device: '  ' }), false)
  // 探测链：速度判据会被 CPU 层拖累，不能混进来
  assert.equal(shouldPartialOffload({ ...base, probing: true }), false)
})

test('shouldPartialOffload：auto 在体检缺席时用「文件比预算大」兜底', () => {
  const base = { mode: 'auto', fits: null, device: 'CUDA0', probing: false }
  const MiB = 1024 * 1024
  // 6 GB 的模型 + 6.6 GB 预算：体检没给结论，但能装下，不该分层
  assert.equal(shouldPartialOffload({ ...base, modelBytes: 6000 * MiB, budgetMiB: 6600 }), false)
  // 8 GB 的模型 + 6.6 GB 预算：权重比预算还大，必然要分层
  assert.equal(shouldPartialOffload({ ...base, modelBytes: 8000 * MiB, budgetMiB: 6600 }), true)
  // 差一点点（98% 门槛内）不分层：张量对齐本来就有几十 MiB 的零头
  assert.equal(shouldPartialOffload({ ...base, modelBytes: 6400 * MiB, budgetMiB: 6600 }), false)
  // 没有体积信息时不能赌，回到保守判否
  assert.equal(shouldPartialOffload(base), false)
})

test('shouldPartialOffload：on 强制允许、off 一律禁止', () => {
  const MiB = 1024 * 1024
  const base = { mode: 'on', fits: true, device: 'CUDA0', probing: false }
  // 体检说装得下也允许（用于估算偏乐观的模型）
  assert.equal(shouldPartialOffload(base), true)
  // 但没卡 / 探测链仍然否
  assert.equal(shouldPartialOffload({ ...base, device: 'cpu' }), false)
  assert.equal(shouldPartialOffload({ ...base, probing: true }), false)

  const off = { mode: 'off', fits: false, device: 'CUDA0', probing: false, modelBytes: 9000 * MiB, budgetMiB: 6600 }
  assert.equal(shouldPartialOffload(off), false)
})

test('shouldPartialOffload：没绑卡但机器上有卡，也要走分层', () => {
  // 设置里显卡选「自动」时 device 是空串 —— 旧判据把它当纯 CPU，
  // 于是 -ngl auto / --fit-target 从来没进过命令行
  const auto = { mode: 'auto', fits: false, device: '', probing: false, gpuAvailable: true }
  assert.equal(shouldPartialOffload(auto), true)
  // 确实没有卡：仍然不能降级
  assert.equal(shouldPartialOffload({ ...auto, gpuAvailable: false }), false)
  // 显式指定 CPU 的用户意图优先，即使有卡也不碰
  assert.equal(shouldPartialOffload({ ...auto, device: 'cpu' }), false)
  // 探测链里一律不降级，跟有没有卡无关
  assert.equal(shouldPartialOffload({ ...auto, probing: true }), false)
})

test('shouldPartialOffload：老调用方只传 enabled 也能用', () => {
  assert.equal(shouldPartialOffload({ enabled: false, fits: false, device: 'CUDA0', probing: false }), false)
  assert.equal(shouldPartialOffload({ enabled: true, fits: false, device: 'CUDA0', probing: false }), true)
})

test('shouldProbeChain：权重装不下时不许探测（否则分层永远没机会）', () => {
  const base = { weightFits: true, hasBudget: true, gpuAvailable: true }
  assert.equal(shouldProbeChain(base), true)
  // 关键回归：8.38 GB 的 14B 在 8 GB 卡上 —— 每一档都起不来，
  // 探测会连着失败再停掉服务，报「跑不动」，而分层其实能跑
  assert.equal(shouldProbeChain({ ...base, weightFits: false }), false)
  // 体检缺席 / 元数据不全：不知道就别拿用户的时间去撞墙
  assert.equal(shouldProbeChain({ ...base, weightFits: null }), false)
  assert.equal(shouldProbeChain({ ...base, weightFits: undefined }), false)
  // 纯 CPU / 没预算：降档不会变快
  assert.equal(shouldProbeChain({ ...base, hasBudget: false }), false)
  assert.equal(shouldProbeChain({ ...base, gpuAvailable: false }), false)
  // 手点档位 / 探测内部重启 / 调档重试：都不该起新链
  assert.equal(shouldProbeChain({ ...base, ctxExplicit: true }), false)
  assert.equal(shouldProbeChain({ ...base, internal: true }), false)
  assert.equal(shouldProbeChain({ ...base, tuned: true }), false)
})
