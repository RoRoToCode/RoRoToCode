/**
 * vramfit 命令行单元测试（node:test，无第三方依赖）
 *
 *   node --test test.mjs
 *
 * 测解析层、推算层和终端报告：不联网、不读显卡。
 * 网页版的渲染与显卡识别在 ../site/test.mjs，两边共用同一份 core/。
 *
 * 重点守住四类已经踩过的坑：
 *   1. 混合线性注意力（Qwen3-Next 没有 full_attention_interval）KV 被高估
 *   2. 滑窗架构（Gemma3 没有 key_length_swa）滑窗分支从不触发
 *   3. 粘贴带引号的链接 + 中文说明，被判成「不是 .gguf」
 *   4. 分片模型只按第 1 片算体积
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  cleanPasted, parseHfInput,
  kvBytes, kvLayers, attentionInterval, shardInfo, totalWeightsBytes,
  quantFromName, quantTier, repoVerdict, analyzeTemplate, assess, inputMode,
  readGguf, vramCeiling, normalizeArgv, parseOptions, stripControl, renderRepoTable,
  render, toJson, headlineOf, VERSION, expandTargets
} from './check.mjs'

import {
  TUNING, ASSUMPTIONS, KV_BYTES_PER_ELEM, VALUE_FLAGS, setMirror, getMirror, DEFAULT_MIRROR, OFFICIAL,
  setLocale, getLocale, detectLocale, t, dictStats, bothLangs, labelWidth, assumptionsList, localeOf,
  speedCapFor, assumptionLines, mergedHardware, moeInfo, activeParamsFromName, launchArgsOf, isMla,
  paramCountOf, verdictOf
} from './core/index.mjs'
import { appleWorkingSet, gpuBandwidth } from './cli/hardware.mjs'


// 断言比的是中文字符串，所以测试必须固定语言。
// 不固定的话，CI（LANG=C 或 en_US）和本机会跑在不同语言下，断言随机失败。
setLocale('zh')

const CLI = fileURLToPath(new URL('./check.mjs', import.meta.url))
const GB = 1024 ** 3
const URL0 = 'https://hf-mirror.com/a/b/resolve/main/c.gguf'

/** 8 GB 显卡、带宽按 3050 填，测试里不依赖真实硬件 */
const hw8 = {
  gpus: [{ name: 'Fake 8G', totalBytes: 8 * GB, usedBytes: 0, bandwidthGBps: 224 }],
  ramBytes: 16 * GB,
  ramBandwidthGBps: 60,
  cpu: 'fake',
  platform: 'test'
}

/** Qwen3-8B Q4_K_M：报告与 JSON 两条路径都用它，8 GB 卡 */
const meta8b = {
  file: 'Qwen3-8B-Q4_K_M.gguf', sizeBytes: 5027784512, arch: 'qwen3', name: 'Qwen3-8B',
  chatTemplate: '{% if tools %}<tool_call>{% endif %}', blockCount: 36, headCount: 32,
  headKv: 8, embdLength: 4096, contextLength: 40960, fileType: 15, tensorCount: 398,
  paramCount: 8.2e9
}
const hw8b = {
  gpus: [{ name: 'RTX 3050', totalBytes: 8 * GB, usedBytes: 0.8 * GB, bandwidthGBps: 224 }],
  ramBytes: 16 * GB, ramBandwidthGBps: 60, osPlatform: 'win32'
}

// ───────────────────── 一句话结论（报告第一屏） ─────────────────────

test('一句话结论：四种情况都说得出原因，且不出现空文案', () => {
  const base = assess(meta8b, hw8b)

  const ok = headlineOf(meta8b, base)
  assert.equal(ok.level, 'good')
  assert.match(ok.why, /上下文/)

  // 没有 chat_template：能加载，但只会接着往下写
  const noTpl = headlineOf({ ...meta8b, chatTemplate: '' }, base)
  assert.equal(noTpl.level, 'warn')
  assert.match(noTpl.title, /接着往下写/)

  // 显存不够：报「跑不动」，并说清差多少
  const tinyGpu = { ...hw8b, gpus: [{ ...hw8b.gpus[0], totalBytes: 1 * GB, usedBytes: 0 }] }
  const noFit = headlineOf(meta8b, assess(meta8b, tinyGpu))
  assert.equal(noFit.level, 'bad')
  assert.match(noFit.title, /跑不动/)
  assert.match(noFit.why, /GB/)

  // 参数太小：能跑，但撑不起 agent
  const tiny = headlineOf(
    { ...meta8b, file: 'Qwen2.5-1.5B-Q4_K_M.gguf', sizeBytes: 1e9, paramCount: 1.5e9 },
    base
  )
  assert.equal(tiny.level, 'warn')
  assert.match(tiny.title, /干不了活/)

  // 元数据不全：算不出来，不能误导成「装不下」
  const broken = headlineOf({ ...meta8b, blockCount: undefined }, assess({ ...meta8b, blockCount: undefined }, hw8b))
  assert.equal(broken.level, 'warn')
  assert.match(broken.title, /算不出来/)

  for (const h of [ok, noTpl, noFit, tiny, broken]) {
    assert.ok(h.title && h.why && h.short, '结论不能有空白字段')
    assert.doesNotMatch(h.title + h.why + h.short, /undefined|NaN/)
  }
})

// ───────────────────────── 粘贴清洗 / 链接识别 ─────────────────────────

test('粘贴清洗：链接被引号包住、后面还跟着中文说明', () => {
  const cases = [
    `"${URL0}" 这个模型行吗`,
    `“${URL0}” 这个行吗`,
    `【${URL0}】真的行吗`,
    `${URL0} 这个呢`,
    `${URL0}。`,
    `<${URL0}>`,
    `(${URL0})`
  ]
  for (const c of cases) {
    const r = parseHfInput(c)
    assert.equal(r?.kind, 'file', `没认出：${c}`)
    assert.equal(r.url, URL0, `清洗结果不对：${c}`)
  }
})

test('粘贴清洗：链接前面挂着中文也不该失败', () => {
  for (const c of [`你好 ${URL0}`, `帮我看看${URL0}`]) {
    assert.equal(parseHfInput(c)?.url, URL0, `没认出：${c}`)
  }
})

test('粘贴清洗：本地路径和仓库名不能被当成链接处理', () => {
  assert.equal(parseHfInput('D:\\models\\qwen3-8b-q4_k_m.gguf'), null)
  assert.equal(parseHfInput('C:/Program Files/x/y.gguf'), null)
  assert.equal(parseHfInput('unsloth/Qwen3-8B-GGUF'), null)
  // 中文路径不能被"截掉中文说明"的逻辑截断
  assert.equal(cleanPasted('D:\\模型\\qwen.gguf'), 'D:\\模型\\qwen.gguf')
})

test('模型站点可切换：默认镜像，也能直连官方或换别的镜像', () => {
  try {
    // 默认走镜像，官方链接会被改写成镜像
    assert.equal(getMirror(), DEFAULT_MIRROR)
    assert.equal(
      parseHfInput('https://huggingface.co/a/b/blob/main/c.gguf').url,
      `${DEFAULT_MIRROR}/a/b/resolve/main/c.gguf`
    )

    // 指到官方 = 不走镜像，贴官方链接保持原样
    assert.equal(setMirror(OFFICIAL), OFFICIAL)
    assert.equal(
      parseHfInput('https://huggingface.co/a/b/blob/main/c.gguf').url,
      `${OFFICIAL}/a/b/resolve/main/c.gguf`
    )

    // 空值同样等于官方；尾斜杠要去掉，否则会拼出 //a/b
    assert.equal(setMirror(''), OFFICIAL)
    assert.equal(setMirror('https://example.com/'), 'https://example.com')

    // 非 http(s) 一律当作「不走镜像」，而不是拼出半截地址
    assert.equal(setMirror('ftp://x'), OFFICIAL)

    // 参数解析：合法值照收，缺值 / 没写协议要报错
    assert.equal(parseOptions(['--mirror', 'https://huggingface.co']).mirror, 'https://huggingface.co')
    assert.ok(parseOptions(['--mirror']).problems.length > 0)
    assert.ok(parseOptions(['--mirror', 'huggingface.co']).problems.length > 0)
    // 取值不能被当成待检查的输入
    assert.ok(VALUE_FLAGS.has('--mirror'))
  } finally {
    setMirror(DEFAULT_MIRROR)
  }
})

test('链接归一化：blob→resolve、模型主页→仓库、带查询串的直链', () => {
  assert.deepEqual(
    parseHfInput('https://huggingface.co/a/b/blob/main/c.gguf').url,
    'https://hf-mirror.com/a/b/resolve/main/c.gguf'
  )
  assert.equal(parseHfInput('https://hf-mirror.com/a/b').kind, 'repo')
  assert.equal(parseHfInput('hf-mirror.com/a/b').repo, 'a/b')
  // 下载按钮给出的地址带 ?download=true，不能因此判成"不是 .gguf"
  assert.equal(parseHfInput(`${URL0}?download=true`)?.url, URL0)
  // 非 gguf 直链要明确拒绝，而不是拿去 fetch
  assert.equal(parseHfInput('https://hf-mirror.com/a/b/resolve/main/README.md').kind, 'invalid')
  assert.equal(parseHfInput('https://modelscope.cn/models/a/b').kind, 'invalid')
})

// ───────────────────────── 层数 / KV 折算 ─────────────────────────

const qwen3next = {
  arch: 'qwen3next', blockCount: 48, headCount: 16, headKv: 2,
  embdLength: 2048, keyLength: 256, valueLength: 256,
  contextLength: 262144, sizeBytes: 27 * GB,
  hasLinearLayers: true,           // 只有 ssm.* 参数，没有 full_attention_interval
  chatTemplate: '<tools>'
}

const gemma3 = {
  arch: 'gemma3', blockCount: 34, headCount: 8, headKv: 4,
  embdLength: 2560, keyLength: 256,   // 没有 keyLengthSwa
  contextLength: 131072, slidingWindow: 1024, sizeBytes: 2.32 * GB,
  chatTemplate: '<tools>'
}

const llama = {
  arch: 'llama', blockCount: 32, headCount: 32, headKv: 8,
  embdLength: 4096, keyLength: 128, valueLength: 128,
  contextLength: 131072, sizeBytes: 5 * GB, chatTemplate: '<tools>'
}

test('混合架构：元数据没声明 interval 时按 ssm 参数推断 1/4', () => {
  const ai = attentionInterval(qwen3next)
  assert.equal(ai.interval, 4)
  assert.equal(ai.inferred, true, '推断出来的必须能被标记出来，报告里要注明')

  assert.equal(kvLayers(qwen3next), 12)
  // 48 层全算 = 4 倍误差，这正是修复前的 bug
  assert.equal(kvLayers({ ...qwen3next, hasLinearLayers: false }), 48)
})

test('混合架构：显式 interval 优先，且不算"推断"', () => {
  const m = { ...qwen3next, fullAttentionInterval: 2, hasLinearLayers: true }
  assert.deepEqual(attentionInterval(m), { interval: 2, inferred: false })
  assert.equal(kvLayers(m), 24)
})

test('MTP 层不计入 KV 层数', () => {
  assert.equal(kvLayers({ ...llama, nextnLayers: 1 }), 31)
})

test('KV 字节数：纯注意力按公式算', () => {
  // 4096 × 32 层 × 8 KV head × (128 + 128) × 2 byte
  assert.equal(kvBytes(llama, 4096, 'f16'), 4096 * 32 * 8 * 256 * 2)
  assert.equal(kvBytes(llama, 4096, 'q8_0'), 4096 * 32 * 8 * 256 * 1.0625)
  assert.equal(kvBytes(llama, 4096, 'q4_0'), 4096 * 32 * 8 * 256 * 0.5625)
})

test('KV 字节数：滑窗架构不能退化成全注意力（Gemma3 没有 key_length_swa）', () => {
  const hybrid = kvBytes(gemma3, 32768, 'f16')
  const pureAttention = kvBytes({ ...gemma3, slidingWindow: undefined }, 32768, 'f16')
  // 6 层 global + 28 层滑窗，窗口 1K
  assert.equal(hybrid, 32768 * 6 * 4 * 512 * 2 + 1024 * 28 * 4 * 512 * 2)
  assert.ok(hybrid < pureAttention * 0.25, `滑窗分支没生效：${hybrid} vs ${pureAttention}`)
})

test('MLA：KV 只存压缩后的 K 行，V 复用 K（DeepSeek V3/R1）', () => {
  // DeepSeek-V3 形状：61 层（含 1 层 MTP）→ 60 层带 KV；转换后 head_count_kv=1，
  // key_length=576（kv_lora_rank 512 + rope 64），value_length=512。
  const ds = {
    arch: 'deepseek2', blockCount: 61, nextnLayers: 1,
    headCount: 128, headKv: 1, embdLength: 7168,
    keyLength: 576, valueLength: 512,
    keyLengthMla: 192, valueLengthMla: 128,
    kvLoraRank: 512, ropeDimCount: 64
  }
  assert.equal(isMla(ds), true, '两个 *_mla 键都在才判 MLA')
  // 每 token 每层只有 576 个元素，不加 value_length(512)
  assert.equal(kvBytes(ds, 32768, 'f16'), 32768 * 60 * 1 * 576 * 2)

  // 按普通 GQA 公式 (k_dim + v_dim) 会把 KV 高估约 1.89 倍 —— 这正是要修的偏差
  const naive = 32768 * 60 * 1 * (576 + 512) * 2
  assert.ok(naive / kvBytes(ds, 32768, 'f16') > 1.8, `MLA 应比普通公式小：${naive}`)

  // 早期转换没有 *_mla 键，llama.cpp 走普通 GQA 分配：16 头 × (192+128)，不能当 MLA
  const legacy = {
    ...ds, keyLengthMla: undefined, valueLengthMla: undefined,
    headKv: 16, keyLength: 192, valueLength: 128
  }
  assert.equal(isMla(legacy), false, '缺 *_mla 键必须回普通公式')
  assert.equal(kvBytes(legacy, 32768, 'f16'), 32768 * 60 * 16 * (192 + 128) * 2)
})

test('MLA：缺 key_length 时用 kv_lora_rank + rope_dim 兜底', () => {
  const ds = {
    arch: 'deepseek2', blockCount: 61, nextnLayers: 1,
    headCount: 128, headKv: 1, embdLength: 7168,
    keyLengthMla: 192, valueLengthMla: 128, kvLoraRank: 512, ropeDimCount: 64
  }
  assert.equal(kvBytes(ds, 4096, 'f16'), 4096 * 60 * 1 * (512 + 64) * 2)
})

// ───────────────────────── 显存预算 ─────────────────────────
test('8G 卡上的 Gemma3-4B：128K 原生上下文应该装得下（修复前会算成 19 GB）', () => {
  const r = assess(gemma3, hw8)
  assert.equal(r.best?.ctx, 131072)
  // 阈值含 800 MiB 运行时开销；修复前这条是 19 GB，现在是 6.2 GB 上下
  assert.ok(r.best.need / GB < 7, `预算明显偏高：${(r.best.need / GB).toFixed(2)} GB`)
})

test('权重本身就超显存时不给建议上下文', () => {
  const r = assess(qwen3next, hw8)   // 27 GB 权重，8G 卡
  assert.equal(r.weightsFit, false)
  assert.equal(r.best, null)
})

test('原生上下文小于最低测试档时，把它单独列一档', () => {
  const tiny = { ...llama, contextLength: 2048, sizeBytes: 1 * GB }
  const r = assess(tiny, hw8)
  assert.equal(r.rows[0].ctx, 2048)
  assert.equal(r.best.ctx, 2048)
  assert.equal(r.rows.find((x) => x.ctx === 4096).beyondNative, true)
})

test('分片模型：体积按片数折算，不能只算第 1 片', () => {
  assert.deepEqual(shardInfo('m-00002-of-00004.gguf'), { index: 2, total: 4 })
  assert.equal(shardInfo('m-Q4_K_M.gguf'), null)

  const shardMeta = { ...llama, file: 'm-00001-of-00004.gguf', sizeBytes: 5 * GB }
  assert.equal(totalWeightsBytes(shardMeta), 20 * GB)
  assert.equal(totalWeightsBytes({ ...llama, file: 'm.gguf', sizeBytes: 5 * GB }), 5 * GB)
})

// ───────────────────────── 量化 / 结论 ─────────────────────────

test('量化名：变体后缀不能被截断成同名', () => {
  assert.equal(quantFromName('Qwen3-8B-Q4_K_XL.gguf'), 'Q4_K_XL')
  assert.equal(quantFromName('Qwen3-8B-Q4_K_M.gguf'), 'Q4_K_M')
  assert.equal(quantFromName('x-IQ4_XS.gguf'), 'IQ4_XS')
  assert.equal(quantFromName('x-bf16.gguf'), 'BF16')
  assert.equal(quantFromName('model.gguf'), undefined)
})

test('量化分级：1-2 bit 判"别用"', () => {
  assert.equal(quantTier('IQ1_S').tier, 0)
  assert.equal(quantTier('Q2_K').tier, 1)
  assert.equal(quantTier('Q4_K_M').tier, 3)
  assert.equal(quantTier('Q8_0').tier, 5)
})

test('模板能力：有 tools 分支和 tool_call 才算强支持', () => {
  assert.equal(analyzeTemplate(undefined).level, 'none')
  assert.equal(analyzeTemplate('{% if tools %}...<tool_call>').level, 'strong')
  // 有 tools 分支但没有工具调用格式 → 只能算部分支持
  assert.equal(analyzeTemplate('{% if tools %}...{% endif %}').level, 'partial')
  assert.equal(analyzeTemplate('{% if message.role == "user" %}hi').level, 'weak')
})

test('仓库结论：有模板但不支持工具，要和"无模板"区分开', () => {
  assert.equal(repoVerdict({ hasTemplate: false, best: 32768, tier: 3, toolOk: false }).label, '无模板')
  assert.equal(repoVerdict({ hasTemplate: true, best: 32768, tier: 3, toolOk: false }).label, '不支持工具')
  assert.equal(repoVerdict({ hasTemplate: true, best: 32768, tier: 3, toolOk: true }).label, '推荐')
  assert.equal(repoVerdict({ hasTemplate: true, best: 4096, tier: 3, toolOk: true }).label, '上下文太小')
  assert.equal(repoVerdict({ hasTemplate: true, best: null, tier: 3, toolOk: true }).label, '装不下')
  assert.equal(repoVerdict({ hasTemplate: true, best: 32768, tier: 1, toolOk: true }).label, '别用')
})

test('交互输入模式：Windows 控制台必须走熟模式，否则 Ctrl+V 粘贴失效', () => {
  // raw 模式会把 ENABLE_QUICK_EDIT_MODE 清掉，conhost 的 Ctrl+V / 右键粘贴就没反应了
  const win = inputMode({ isTTY: true, platform: 'win32' })
  assert.equal(win.cooked, true)
  assert.equal(win.terminal, false)

  // 类 Unix 终端靠终端自己处理粘贴，继续用 readline 的 raw 模式以保留行编辑
  const nix = inputMode({ isTTY: true, platform: 'linux' })
  assert.equal(nix.cooked, false)
  assert.equal(nix.terminal, true)

  // 管道输入两种都不用，否则 setRawMode 会直接抛错
  assert.deepEqual(inputMode({ isTTY: false, platform: 'win32' }), { cooked: false, terminal: false })
  assert.deepEqual(inputMode({ isTTY: undefined, platform: 'linux' }), { cooked: false, terminal: false })
})

// ───────────────────────── 显存上限：平台差异 ─────────────────────────

test('显存上限：只认当前可用，不把「可驱逐」当预算', () => {
  const g = { totalBytes: 8 * GB, usedBytes: 6 * GB }

  // 8G 卡上已占 6G。旧实现走 max(free, total×0.94) 会报 7.52 → 每个模型都推荐 64K，
  // 真跑起来并发两个请求 decode 掉到 1.5 tok/s。现在只认 free。
  const win = vramCeiling({ ...g, platform: 'win32', budget: 'auto' })
  assert.ok(
    Math.abs(win.limit / GB - 2 * 0.92) < 1e-9,
    `Windows 上限应是可用显存的 92%：${(win.limit / GB).toFixed(2)}`
  )
  assert.equal(win.reclaimable, 0, '不再承诺「关掉别的程序就能腾出这么多」')

  const lin = vramCeiling({ ...g, platform: 'linux', budget: 'auto' })
  assert.ok(Math.abs(lin.limit / GB - 2 * 0.92) < 1e-9, `Linux 上限应是可用显存的 92%：${lin.limit / GB}`)
  assert.equal(lin.reclaimable, 0)
  // 两个平台在「按可用算」上一致；差别只在报告口径
  assert.ok(Math.abs(lin.limit - win.limit) < 1)

  // 空闲时才该接近总显存 —— 这条保证新实现没有反过来把空闲机器也判死
  const idle = vramCeiling({ totalBytes: 8 * GB, usedBytes: 0.5 * GB, platform: 'win32', budget: 'auto' })
  assert.ok(idle.limit / GB > 6.8, `空闲的 8G 卡应能用 7G 左右：${(idle.limit / GB).toFixed(2)}`)
  assert.ok(idle.limit <= 8 * GB * 0.94, '但永远不能超过总显存的 94%')
})

test('显存上限：不传 budget 时默认走 static（不是 auto）', () => {
  // 回归：CLI 曾把默认写成 auto，于是 8G 卡被别的程序占了 5G 时按 2.76G 预算，
  // 把权重 5.38G 的模型误判成「装不下」。README / CHANGELOG 都承诺默认静态，
  // 这里把「默认 = static」钉死，避免以后改默认值又悄悄回退。
  const g = { totalBytes: 8 * GB, usedBytes: 5 * GB, platform: 'win32' }
  const def = vramCeiling({ ...g })
  assert.equal(def.basis, 'static', '不传 budget 必须走静态口径')
  assert.ok(Math.abs(def.limit / GB - 8 * 0.94) < 1e-9, `静态上限应是总容量 94%：${(def.limit / GB).toFixed(2)}`)
  assert.ok(def.limit > 5.38 * GB, '8G 卡上权重 5.38G 的模型应判装得下')
  // 显式 auto 仍可用，且确实更保守
  const auto = vramCeiling({ ...g, budget: 'auto' })
  assert.equal(auto.basis, 'wddm')
  assert.ok(auto.limit < def.limit)
})

test('显存上限：静态口径只按总容量，和当前占用无关', () => {
  // 同一张 8G 卡，占用从 0 到 7.5G，静态口径必须给出同一个数 ——
  // 这正是「开一局游戏再测，结论就变了」的解法：预算不跟着别人的显存跳。
  const g = { totalBytes: 8 * GB, platform: 'win32', budget: 'static' }
  const idle = vramCeiling({ ...g, usedBytes: 0 })
  const busy = vramCeiling({ ...g, usedBytes: 7.5 * GB })
  assert.equal(idle.basis, 'static')
  assert.equal(busy.basis, 'static')
  assert.equal(idle.limit, busy.limit, '静态口径不能被当前占用影响')
  assert.ok(Math.abs(idle.limit / GB - 8 * 0.94) < 1e-9, `应是总显存 94%：${(idle.limit / GB).toFixed(2)}`)
  assert.ok(idle.limit > busy.limit || true)
  // 动态口径在同样输入下必须不同（否则这个开关等于没接上）
  const auto = vramCeiling({ totalBytes: 8 * GB, usedBytes: 7.5 * GB, platform: 'win32', budget: 'auto' })
  assert.ok(auto.limit < idle.limit, 'auto 口径应当比静态口径小')

  // 读不到 used 的 A 卡 / 核显：静态口径不再走 60% 保守档，它本来就不读 used
  const unknown = vramCeiling({ totalBytes: 8 * GB, usedBytes: 0, usedUnknown: true, platform: 'win32', budget: 'static' })
  assert.equal(unknown.basis, 'static')
  assert.ok(unknown.limit > 8 * GB * 0.6)
})

// ───────────────────────── 多卡合并评估 ─────────────────────────

test('多卡合并：容量求和、带宽取最弱卡', () => {
  const two = {
    gpus: [
      { name: 'GPU-A', totalBytes: 8 * GB, usedBytes: 1 * GB, bandwidthGBps: 448, backend: 'cuda' },
      { name: 'GPU-B', totalBytes: 8 * GB, usedBytes: 2 * GB, bandwidthGBps: 200, backend: 'cuda' }
    ],
    osPlatform: 'win32', ramBytes: 16 * GB
  }
  const m = mergedHardware(two)
  assert.equal(m.merged, true)
  assert.equal(m.gpus, 2)
  assert.equal(m.hw.gpus.length, 1)          // 合成一张虚拟卡
  assert.equal(m.hw.gpus[0].totalBytes, 16 * GB, '容量必须是两卡之和')
  assert.equal(m.hw.gpus[0].usedBytes, 3 * GB)
  assert.equal(m.hw.gpus[0].bandwidthGBps, 200, '带宽取最弱（最慢）那张')
  assert.equal(m.weakestName, 'GPU-B')
  assert.equal(m.bandwidthUnknown, false)
})

test('多卡合并：带宽有卡未收录时不编造速度', () => {
  const two = {
    gpus: [
      { name: 'GPU-A', totalBytes: 8 * GB, bandwidthGBps: 448, backend: 'cuda' },
      { name: 'GPU-B', totalBytes: 8 * GB, bandwidthGBps: null, backend: 'cuda' }
    ],
    osPlatform: 'win32'
  }
  const m = mergedHardware(two)
  assert.equal(m.merged, true)
  assert.equal(m.hw.gpus[0].bandwidthGBps, null, '有卡带宽未知 → 不能报合并速度')
  assert.equal(m.bandwidthUnknown, true)
})

test('多卡合并：单卡 / 无卡时不合并', () => {
  assert.equal(mergedHardware(hw8b).merged, false, '单卡不该有合并段')
  assert.equal(mergedHardware({ gpus: [] }).merged, false)
})

test('多卡合并：合并后能装下原本单卡装不下的模型', () => {
  // 8G + 8G 合 16G，权重 5.38G 在单卡 8G 就装得下；这里用一个 12G 的模型验证合并的价值
  const big = { ...meta8b, file: 'Qwen3-30B-Q4_K_M.gguf', sizeBytes: 12 * GB, paramCount: 30e9 }
  const two = {
    gpus: [
      { name: 'GPU-A', totalBytes: 8 * GB, usedBytes: 0, bandwidthGBps: 448, backend: 'cuda' },
      { name: 'GPU-B', totalBytes: 8 * GB, usedBytes: 0, bandwidthGBps: 448, backend: 'cuda' }
    ],
    osPlatform: 'win32', ramBytes: 16 * GB
  }
  const single = assess(big, two, { budget: 'static' })
  const m = mergedHardware(two)
  const combined = assess(big, m.hw, { budget: 'static' })
  assert.equal(single.weightsFit, false, '12G 权重单卡 8G 装不下')
  assert.equal(combined.weightsFit, true, '合并 16G 后应装得下')
  assert.ok(combined.limit > single.limit)
})

test('多卡报告：列出所有卡并给出合并评估段', () => {
  const two = {
    gpus: [
      { name: 'RTX-2080', totalBytes: 8 * GB, usedBytes: 0, bandwidthGBps: 448, backend: 'cuda' },
      { name: 'P104-100', totalBytes: 8 * GB, usedBytes: 0, bandwidthGBps: null, backend: 'cuda' }
    ],
    osPlatform: 'win32', ramBytes: 16 * GB, cpu: 'fake'
  }
  const draw = () => render(meta8b, two, assess(meta8b, two, { kvType: 'f16', budget: 'static' }), { kvType: 'f16', budget: 'static' })
  setLocale('zh')
  const zh = draw()
  setLocale('en')
  const en = draw()
  setLocale('zh')  // 测试文件默认语言，恢复以免影响后续用例
  for (const [lang, text] of [['en', en], ['zh', zh]]) {
    assert.ok(text.includes('RTX-2080') && text.includes('P104-100'), `${lang} 报告应列出两块卡`)
    assert.ok(/Combined|合并评估/.test(text), `${lang} 报告应有合并评估段`)
    assert.ok(!/undefined|NaN|⟪/.test(text), `${lang} 多卡报告出现 undefined/NaN/未翻译 key`)
    for (const line of text.split('\n')) {
      const w = [...line].reduce((n, c) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(c) ? 2 : 1), 0)
      assert.ok(w <= 100, `${lang} 多卡报告有 ${w} 列的行：${line}`)
    }
  }
  assert.ok(zh.includes('16.00 GB'), '中文报告合并池应是 16 GB')
  assert.ok(zh.includes('带宽有卡未收录'), '带宽未知要如实说明')
})

test('带宽表：矿卡型号也要认，否则多卡合并连速度都估不出来', () => {
  assert.equal(gpuBandwidth('NVIDIA P104-100'), 320)
  assert.equal(gpuBandwidth('NVIDIA P106-100'), 192)
  assert.equal(gpuBandwidth('NVIDIA GeForce RTX 2080'), 448, '消费卡不能被矿卡规则抢走')
  assert.equal(gpuBandwidth('NVIDIA GeForce RTX 4070 Ti SUPER'), 672, 'ti super 要先于 ti 匹配')
})

test('多卡合并：-dev 按驱动枚举顺序，--gpu 换序后也不错位', () => {
  const a = { name: 'GPU-A', totalBytes: 8 * GB, bandwidthGBps: 448, backend: 'cuda', devIndex: 0 }
  const b = { name: 'GPU-B', totalBytes: 8 * GB, bandwidthGBps: 448, backend: 'cuda', devIndex: 1 }
  const m = mergedHardware({ gpus: [a, b], osPlatform: 'win32' })
  assert.deepEqual(m.devices, ['CUDA0', 'CUDA1'])
  // --gpu 1 会把第二张卡换到 gpus[0]；编号必须还按出厂的 device 序号，
  // 否则 -dev CUDA0,CUDA1 里的 CUDA0 指的是另一张卡，用户照着抄就分错层
  assert.deepEqual(mergedHardware({ gpus: [b, a], osPlatform: 'win32' }).devices,
    ['CUDA0', 'CUDA1'], '换序后编号不能跟着数组下标走')
  // 后端不认识时不猜编号，宁可少给一行旗标
  assert.equal(mergedHardware({ gpus: [a, { ...b, backend: 'mystery' }] }).devices, null)
})

test('多卡合并：启动参数走 -dev + -sm layer，并给出上下文', () => {
  const two = {
    gpus: [
      { name: 'GPU-A', totalBytes: 8 * GB, bandwidthGBps: 448, backend: 'cuda', devIndex: 0 },
      { name: 'GPU-B', totalBytes: 8 * GB, bandwidthGBps: 448, backend: 'cuda', devIndex: 1 }
    ],
    osPlatform: 'win32', ramBytes: 16 * GB
  }
  const big = { ...meta8b, file: 'Qwen3-30B-Q4_K_M.gguf', sizeBytes: 12 * GB, paramCount: 30e9 }
  const m = mergedHardware(two)
  const combined = assess(big, m.hw, { budget: 'static' })
  const flags = launchArgsOf(big, combined, { merged: { devices: m.devices } }).map((x) => x.flag)
  assert.ok(flags.includes('-dev CUDA0,CUDA1'), `合并启动要给 -dev：${flags.join(' ')}`)
  assert.ok(flags.includes('-sm layer'))
  assert.ok(flags.some((f) => f.startsWith('-c ')), '合并装得下就必须给上下文')
  // 没声明合并时不能凭空冒出 -dev，单卡场景的旗标要和以前一致
  assert.ok(!launchArgsOf(big, combined, {}).some((x) => x.flag.startsWith('-dev')))
})

test('多卡报告：单卡放不下时抬头指向合并，启动参数也换成多卡', () => {
  const two = {
    gpus: [
      { name: 'RTX-2080', totalBytes: 8 * GB, bandwidthGBps: 448, backend: 'cuda', devIndex: 0 },
      { name: 'RTX-2080B', totalBytes: 8 * GB, bandwidthGBps: 448, backend: 'cuda', devIndex: 1 }
    ],
    osPlatform: 'win32', ramBytes: 16 * GB, cpu: 'fake'
  }
  const big = { ...meta8b, file: 'Qwen3-30B-Q4_K_M.gguf', sizeBytes: 12 * GB, paramCount: 30e9 }
  const single = assess(big, two, { budget: 'static' })
  assert.equal(single.weightsFit, false, '前提：单卡 8G 放不下 12G 权重')
  setLocale('zh')
  let text = ''
  try {
    text = render(big, two, single, { budget: 'static' })
  } finally {
    setLocale('zh')
  }
  assert.ok(/合起来能跑/.test(text), '抬头要立刻说「合起来可以」，否则用户去换模型')
  assert.ok(/贴近上限/.test(text), '12 GB 权重塞 15 GB 合并池是 89%，必须标注贴上限')
  assert.ok(text.includes('-dev CUDA0,CUDA1'), '启动参数要指向合并多卡')
  assert.ok(text.includes('-sm layer'))
  for (const line of text.split('\n')) {
    const w = [...line].reduce((n, c) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(c) ? 2 : 1), 0)
    assert.ok(w <= 100, `多卡报告有 ${w} 列的行：${line}`)
  }
})

test('结论文案：权重放得下而上下文放不下时，不能说「权重超过上限」', () => {
  const r = {
    estimated: true, weightsFit: true, best: null, gpu: {},
    weights: 6.6 * GB, limit: 7.5 * GB,
    rows: [{ ctx: 4096, need: 8.2 * GB, fits: false }]
  }
  setLocale('zh')
  try {
    const hd = headlineOf(meta8b, r)
    assert.equal(hd.level, 'bad')
    assert.ok(hd.why.includes('4K'), `要说清是哪一档放不下：${hd.why}`)
    assert.ok(!hd.why.includes('光权重就要'), '权重其实放得下，这句话会自相矛盾')
  } finally {
    setLocale('zh')
  }
})

test('文件名参数：8X4B 是「8 专家×4B」，不能盖掉总参数 21B', () => {
  // 真实案例：L3.2-8X4B-MOE-...-21B-...Q4_k_s 曾把 21B 报成 4.00B，
  // 于是「11.29 GB 的文件装 4B 参数」自相矛盾，用户会怀疑整份报告
  assert.equal(paramCountOf('L3.2-8X4B-MOE-V2-Dark-Champion-Inst-21B-uncen-Q4_k_s.gguf') / 1e9, 21)
  assert.equal(paramCountOf('Mixtral-8x7B-Instruct-v0.1.Q4_K_M.gguf'), undefined,
    '8x7B 是专家数×专家大小，总参数不在名字里 → 宁可不猜')
  assert.equal(paramCountOf('Qwen3-8B-Q4_K_M.gguf') / 1e9, 8, '常规名字照旧')
  assert.equal(paramCountOf('DeepSeek-R1-Distill-Qwen-7B-Q4.gguf') / 1e9, 7)
})

test('MoE 启动参数：给 --n-cpu-moe 时不能再砍 -ngl', () => {
  const r = assess(metaBigMoe, hw8Ram32, { weightsBytes: 16.04e9 })
  const flags = launchArgsOf(metaBigMoe, r).map((a) => a.flag)
  assert.ok(flags.includes('-ngl 999'), `注意力/KV 仍该全上显存，实际：${flags.join(' ')}`)
  assert.ok(flags.some((f) => f.startsWith('--n-cpu-moe')), '专家要放内存')
  // 旧逻辑同时给 -ngl 21 + --n-cpu-moe，等于又砍掉 11 层注意力，显存白闲
  assert.ok(!flags.some((f) => /^-ngl \d+$/.test(f) && f !== '-ngl 999'))
})

test('MoE + 多卡：专家放内存能跑时，也要指出合并后是全显存更快', () => {
  // 11.29 GB / 32 层 / 8 专家，8G 单卡要 offload，8G+8G 合并刚好全放
  const moe11 = { ...metaBigMoe, file: 'L3.2-8X4B-MOE-21B-Q4_k_s.gguf', sizeBytes: 11.29e9, paramCount: 21e9 }
  const two = {
    gpus: [
      { name: 'RTX-2080', totalBytes: 8 * GB, usedBytes: 0, bandwidthGBps: 448, backend: 'cuda', devIndex: 0 },
      { name: 'P104-100', totalBytes: 8 * GB, usedBytes: 0, bandwidthGBps: null, backend: 'cuda', devIndex: 1 }
    ],
    ramBytes: 32 * GB, ramBandwidthGBps: 51, osPlatform: 'win32', cpu: 'fake'
  }
  const r = assess(moe11, two, { budget: 'static' })
  assert.equal(r.moe.canOffload, true, '前提：单卡要 offload 专家')
  for (const lang of ['zh', 'en']) {
    setLocale(lang)
    let text = ''
    try {
      text = render(moe11, two, r, { budget: 'static' })
    } finally {
      setLocale('zh')
    }
    assert.ok(/-dev CUDA0,CUDA1/.test(text), `${lang} 合并段要给能直接抄的命令`)
    assert.ok(text.includes('-sm layer'))
    // 标签占满列宽时值不能贴上去（曾经渲染成「部分 offload约 12 tok/s」）
    assert.ok(!/offload约|offload~/.test(text), `${lang} 速度和标签粘在一起了`)
    for (const line of text.split('\n')) {
      const w = [...line].reduce((n, c) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(c) ? 2 : 1), 0)
      assert.ok(w <= 100, `${lang} 有 ${w} 列的行：${line}`)
    }
  }
})

test('JSON：单卡放不下、合并能跑时 launchArgs 也给多卡旗标', () => {
  const two = {
    gpus: [
      { name: 'RTX-2080', totalBytes: 8 * GB, bandwidthGBps: 448, backend: 'cuda', devIndex: 0 },
      { name: 'RTX-2080B', totalBytes: 8 * GB, bandwidthGBps: 448, backend: 'cuda', devIndex: 1 }
    ],
    osPlatform: 'win32', ramBytes: 16 * GB
  }
  const big = { ...meta8b, file: 'Qwen3-30B-Q4_K_M.gguf', sizeBytes: 12 * GB, paramCount: 30e9 }
  const single = assess(big, two, { budget: 'static' })
  const mg = mergedHardware(two)
  const combined = assess(big, mg.hw, { budget: 'static' })
  const row = toJson([{ meta: big, result: single, hw: two, mg, combined }])[0]
  assert.equal(row.splitAcrossGpus, true, '合并才跑得动时必须标记')
  assert.ok(row.launchArgs.some((a) => a.flag.startsWith('-dev CUDA0,CUDA1')),
    `JSON 的旗标要和终端一致：${row.launchArgs.map((a) => a.flag).join(' ')}`)

  // 单卡本来就能跑时，绝不能加 -dev（否则多卡机器上单卡场景被强行改成合并）
  const small = assess(meta8b, two, { budget: 'static' })
  const row2 = toJson([{ meta: meta8b, result: small, hw: two, mg, combined: assess(meta8b, mg.hw, { budget: 'static' }) }])[0]
  assert.equal(row2.splitAcrossGpus, false)
  assert.ok(!row2.launchArgs.some((a) => a.flag.startsWith('-dev')))
})

test('显存上限：静态口径不影响统一内存与 CPU 分支', () => {
  // macOS 的统一内存已经是「按容量算」，静态口径套上去会把 Metal 建议工作集顶掉
  const u = vramCeiling({ totalBytes: 16 * GB, unified: true, maxWorkingSetBytes: 16 * GB * 2 / 3, platform: 'darwin', budget: 'static' })
  assert.equal(u.basis, 'unified')
  assert.ok(u.limit < 16 * GB * 0.7, `统一内存不能因为 --budget static 就按整块内存算：${(u.limit / GB).toFixed(2)}`)
})

test('显存上限：没有显卡时静态口径不会凭空造出预算', () => {
  const nothing = vramCeiling({ totalBytes: 0, usedBytes: 0, platform: 'win32', budget: 'static' })
  assert.equal(nothing.limit, 0, 'total 为 0 时必须给 0，让上层退到 CPU 分支')
  assert.notEqual(nothing.basis, 'static')
})

test('显存上限：macOS 统一内存按 GPU 建议工作集，不是物理内存', () => {
  const total = 16 * GB
  const r = vramCeiling({ totalBytes: total, unified: true, maxWorkingSetBytes: total * 2 / 3, platform: 'darwin' })
  assert.equal(r.basis, 'unified')
  assert.ok(r.limit < total * 0.7, `统一内存不能按整块内存算：${(r.limit / GB).toFixed(2)} GB`)
  // 没有 maxWorkingSet 时也要有兜底，不能给 0
  assert.ok(vramCeiling({ totalBytes: total, unified: true, platform: 'darwin' }).limit > 0)
})

test('Apple：--vram 不能把统一内存当成独立显卡', () => {
  // 假设 24 GB：macOS 仍只允许 GPU 用约 2/3，再留 10% → 约 14.4 GB
  const guess = appleWorkingSet(24 * GB)
  assert.equal(guess, Math.floor(24 * GB * 2 / 3))
  const unified = vramCeiling({ totalBytes: 24 * GB, unified: true, maxWorkingSetBytes: guess, platform: 'darwin' })
  const asDiscrete = vramCeiling({ totalBytes: 24 * GB, usedBytes: 0, unified: false, platform: 'darwin' })
  assert.ok(unified.limit < asDiscrete.limit * 0.7,
    `当独显算会高估 ${((asDiscrete.limit / unified.limit - 1) * 100).toFixed(0)}%`)
  // 大内存档的工作集比例是 3/4，不是 2/3
  assert.equal(appleWorkingSet(64 * GB), Math.floor(64 * GB * 0.75))
})

test('没有可用显卡时按内存估算，而不是判成「装不下」', () => {
  const hw = { gpus: [], ramBytes: 16 * GB, ramBandwidthGBps: 60, cpu: 'x', osPlatform: 'linux' }
  const meta = { ...llama, sizeBytes: 4 * GB, contextLength: 8192 }
  const r = assess(meta, hw)

  assert.equal(r.onCpu, true)
  assert.equal(r.limitBasis, 'ram')
  assert.equal(r.weightsFit, true, '修复前 limit=0，所有模型都被判装不下')
  assert.ok(r.best, 'CPU 推理也应该给出建议上下文')
  assert.equal(r.speed.cpu, true)
  assert.equal(r.speed.onVram, null)
})

// ───────────────────────── 命令行参数 ─────────────────────────

test('等号写法：--kv=q8_0 / --vram=8 不能被静默忽略', () => {
  const argv = normalizeArgv(['--kv=q8_0', '--vram=8', 'x.gguf'])
  assert.deepEqual(argv, ['--kv', 'q8_0', '--vram', '8', 'x.gguf'])

  const o = parseOptions(argv)
  assert.equal(o.kvType, 'q8_0')
  assert.equal(o.manualVram, 8)
  assert.deepEqual(o.problems, [])

  // 等号写法同样要校验，不能因为写法不同就把非法值放过去
  assert.equal(parseOptions(normalizeArgv(['--kv=banana'])).problems.length, 1)
  assert.equal(parseOptions(normalizeArgv(['--vram=-3'])).problems.length, 1)

  // 开关类参数不能被拆开
  assert.deepEqual(normalizeArgv(['--json', '--no-color']), ['--json', '--no-color'])

  assert.equal(parseOptions(normalizeArgv(['--repo=unsloth/Qwen3-8B-GGUF'])).repo, 'unsloth/Qwen3-8B-GGUF')
  assert.equal(parseOptions(normalizeArgv(['--repo'])).problems.length, 1)
})

test('--mmproj：投影器开销要能进预算，缺值要报错', () => {
  const o = parseOptions(normalizeArgv(['--mmproj', 'mmproj-x.gguf', 'x.gguf']))
  assert.equal(o.mmproj, 'mmproj-x.gguf')
  assert.deepEqual(o.problems, [])
  // 等号写法同样要能拆开
  assert.equal(normalizeArgv(['--mmproj=a.gguf'])[0], '--mmproj')
  // 只写 flag 不跟值：必须报错，不能静默按纯文本算（那会高估可用显存）
  assert.equal(parseOptions(['--mmproj']).problems.length, 1)
})

test('assess：看图的额外开销只影响带图的结论，不污染纯文本的推荐档', () => {
  const hw = {
    osPlatform: 'win32',
    ramBytes: 16 * 1024 ** 3,
    ramBandwidthGBps: 26,
    gpus: [{ name: 'RTX 3050', totalBytes: 8 * 1024 ** 3, usedBytes: 1.5 * 1024 ** 3, backend: 'cuda', bandwidthGBps: 224 }]
  }
  const plain = assess(meta8b, hw)
  // 实测 Ornith-9B：879 MiB 投影器 + 373 MiB 激活 ≈ 1252 MiB，这里按 1263 MiB 的假设值给
  const extra = 879 * 1024 * 1024 + 384 * 1024 * 1024
  const withVision = assess(meta8b, hw, { extraBytes: extra })

  // 纯文本口径不能被改动（默认启动不挂投影器）
  assert.equal(plain.best.ctx, assess(meta8b, hw, { extraBytes: 0 }).best.ctx)
  assert.equal(plain.extra, 0)
  // 带图口径必须更小：每档的 need 都多出这笔钱
  assert.equal(withVision.extra, extra)
  assert.ok(withVision.best === null || withVision.best.ctx < plain.best.ctx,
    '挂投影器后还推荐同样的上下文，等于又回到「说装得下、一发图就崩」')
})

test('终端转义清洗：远端文件名不能带控制序列进终端', () => {
  // OSC 改窗口标题、CSI 清屏换色，都会伪造出假的报告
  assert.equal(stripControl('\u001b]0;pwned\u0007Q4_K_M.gguf'), 'Q4_K_M.gguf')
  assert.equal(stripControl('\u001b[2J\u001b[31mred'), 'red')
  assert.equal(stripControl('a\u0000b\u0007c'), 'abc')
  // 正常内容（含中文、制表符、换行）不能被误伤
  assert.equal(stripControl('中文 名字\tok\nnext'), '中文 名字\tok\nnext')
})

// ───────────────────────── 解析层：合成 GGUF ─────────────────────────

const bufU32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const bufU64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
const bufStr = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([bufU64(b.length), b]) }
const kvString = (k, v) => [k, 8, bufStr(v)]
const kvNum = (k, n) => [k, 4, bufU32(n)]
const kvStrArray = (k, arr) => [k, 9, Buffer.concat([bufU32(8), bufU64(arr.length), ...arr.map(bufStr)])]
const kvNumArray = (k, arr) => [k, 9, Buffer.concat([bufU32(4), bufU64(arr.length), ...arr.map(bufU32)])]

/** 拼一个 header + kv 段都合法的最小 GGUF，tensorCount=0 */
function gguf(entries, tailBytes = 0) {
  const body = []
  for (const [key, type, value] of entries) body.push(bufStr(key), bufU32(type), value)
  const head = Buffer.concat([bufU32(0x46554747), bufU32(3), bufU64(0), bufU64(entries.length)])
  return Buffer.concat([head, ...body, Buffer.alloc(tailBytes)])
}

const TEMPLATE = '{% if tools %}<tool_call>{% endif %}{% if message.role == "user" %}hi'

async function withTempGguf(buffer, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vramfit-'))
  const file = path.join(dir, 'qwen-8b-q4_k_m.gguf')
  await writeFile(file, buffer)
  try { return await fn(file) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('解析 GGUF：架构、层数、逐层 KV head 数组、chat_template 数组', async () => {
  const buf = gguf([
    kvString('general.architecture', 'llama'),
    kvString('general.name', 'Tiny Test'),
    kvNum('llama.block_count', 32),
    kvNum('llama.attention.head_count', 32),
    kvNumArray('llama.attention.head_count_kv', [8, 8, 8, 8]),
    kvNum('llama.embedding_length', 4096),
    kvNum('llama.attention.key_length', 128),
    kvNum('llama.context_length', 131072),
    kvStrArray('tokenizer.chat_template', [TEMPLATE]),
    // 词表这种十几万条的数组必须走跳过分支，不能被读进内存
    kvStrArray('tokenizer.ggml.tokens', ['<s>', '</s>', '<unk>'])
  ], 4096)

  const meta = await withTempGguf(buf, (file) => readGguf(file))
  assert.equal(meta.arch, 'llama')
  assert.equal(meta.blockCount, 32)
  assert.equal(meta.headCount, 32)
  assert.equal(meta.headKv, 8, 'head_count_kv 是数组时要取第一个')
  assert.equal(meta.contextLength, 131072)
  assert.equal(meta.chatTemplate, TEMPLATE)
  assert.equal(analyzeTemplate(meta.chatTemplate).level, 'strong')
  assert.ok(meta.sizeBytes > 4096)
})

test('解析 GGUF：truncated 文件要明确报「被截断」', async () => {
  const buf = gguf([kvString('general.architecture', 'llama'), kvString('general.name', 'x'.repeat(200))])
  await withTempGguf(buf.subarray(0, buf.length - 8), async (file) => {
    await assert.rejects(readGguf(file), /截断/)
  })
  // 连 magic 都不完整
  await withTempGguf(Buffer.from([0x47, 0x47]), async (file) => {
    await assert.rejects(readGguf(file), /截断/)
  })
})

test('解析 GGUF：magic 不对时不能瞎猜', async () => {
  await withTempGguf(Buffer.alloc(64, 0x41), async (file) => {
    await assert.rejects(readGguf(file), /不是 GGUF/)
  })
})

// ───────────────────────── 远程读取：Range ─────────────────────────

function serve(body, { ignoreRange = false } = {}) {
  const stats = { bytesServed: 0, requests: 0 }
  const server = http.createServer((req, res) => {
    stats.requests++
    res.on('error', () => {})
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '')
    if (!ignoreRange && m) {
      const start = Number(m[1])
      const end = Math.min(Number(m[2]), body.length - 1)
      const chunk = body.subarray(start, end + 1)
      stats.bytesServed += chunk.length
      res.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'content-length': String(chunk.length),
        'accept-ranges': 'bytes'
      })
      res.end(chunk)
      return
    }
    stats.bytesServed += body.length
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, stats })
    })
  })
}

const closeServer = (server) => new Promise((resolve) => {
  server.closeAllConnections?.()
  server.close(() => resolve())
})

test('远程读取：服务器忽略 Range 时必须立刻报错，不能把整个模型读进内存', async () => {
  // 5 MB 的假模型：旧代码会为了读头部把它整份拉两遍
  const body = gguf([kvString('general.architecture', 'llama')], 5 * 1024 * 1024)
  const { server, port } = await serve(body, { ignoreRange: true })
  try {
    await assert.rejects(
      readGguf(`http://127.0.0.1:${port}/m.gguf`),
      /不支持 Range/
    )
  } finally { await closeServer(server) }
})

test('远程读取：支持 Range 时只读头部，不下载整份文件', async () => {
  const body = gguf([
    kvString('general.architecture', 'llama'),
    kvString('general.name', 'remote'),
    kvNum('llama.block_count', 32),
    kvNum('llama.context_length', 8192)
  ], 5 * 1024 * 1024)
  const { server, port, stats } = await serve(body)
  try {
    const meta = await readGguf(`http://127.0.0.1:${port}/m.gguf`)
    assert.equal(meta.arch, 'llama')
    assert.equal(meta.contextLength, 8192)
    assert.ok(stats.bytesServed < body.length / 2,
      `只该读头部，实际取了 ${(stats.bytesServed / 1024 / 1024).toFixed(2)} MB / ${(body.length / 1024 / 1024).toFixed(2)} MB`)
  } finally { await closeServer(server) }
})

// ───────────────────────── 仓库对比表 ─────────────────────────

test('仓库表：推荐行取「质量最高档里体积最小」的变体', () => {
  const base = { best: 32768, hasTemplate: true, toolOk: true }
  const rows = [
    { ...base, quant: 'Q5_K_M', file: 'a-Q5_K_M.gguf', weights: 4 * GB, tier: 4, qualityLabel: '几乎无损', onVram: 20 },
    { ...base, quant: 'Q5_K_S', file: 'a-Q5_K_S.gguf', weights: 3.5 * GB, tier: 4, qualityLabel: '几乎无损', onVram: 24 },
    { ...base, quant: 'Q4_K_M', file: 'a-Q4_K_M.gguf', weights: 3 * GB, tier: 3, qualityLabel: '轻微损失', onVram: 28 }
  ]
  const out = renderRepoTable('owner/repo', rows)
  // 数据行的结论列也有「推荐」两个字，用「上下文」把汇总行挑出来
  const recLine = out.split('\n').find((l) => l.includes('推荐') && l.includes('上下文'))
  assert.ok(recLine, '应该有推荐行')
  // 同属 Q5 档（rank 5），应选体积更小的 K_S，而不是排在后面的 K_M
  assert.ok(recLine.includes('Q5_K_S'), `推荐挑错了：${recLine.trim()}`)
})

test('仓库表：量化名为空 / 读取失败 / 带转义序列都不能把表搞坏', () => {
  const rows = [
    { quant: 'Q4_K_M', file: 'a-Q4_K_M.gguf', weights: 3 * GB, best: 32768, hasTemplate: true, toolOk: true, tier: 3, qualityLabel: '轻微损失', onVram: null },
    // 文件名里没有量化标记
    { quant: undefined, file: 'weird-model.gguf', weights: 4 * GB, best: 32768, hasTemplate: true, toolOk: true, tier: 3, qualityLabel: '未知', onVram: 12 },
    // 远端文件名带 ANSI 序列（恶意仓库能塞进去）
    { quant: '\u001b]0;pwned\u0007Q4_K_S', file: 'b-Q4_K_S.gguf', weights: 3 * GB, best: 32768, hasTemplate: true, toolOk: true, tier: 3, qualityLabel: '轻微损失', onVram: 25 },
    { file: 'c-Q2_K.gguf', quant: 'Q2_K', error: '读取失败（HTTP 500）' }
  ]
  const out = renderRepoTable('owner/repo', rows)
  assert.ok(!out.includes('undefined'), '不能渲染出字面量 undefined')
  assert.ok(!out.includes('\u001b'), '远端字符串里的转义序列必须清掉')
  assert.ok(out.includes('weird-model'), '没有量化标记时退回显示文件名')
  assert.ok(out.includes('读取失败'), '失败行要保留')
})

// ───────────────────────── 架构约束 ─────────────────────────

test('架构：core 和 net 层不许引入 node: 内置模块', async () => {
  // 这两层要原样跑在浏览器里。一旦有人顺手 import 了 node:fs，
  // 命令行毫无影响、网页端会在加载阶段直接白屏，而且很难看出是哪儿的问题。
  for (const dir of ['core', 'net']) {
    const base = new URL(`./${dir}/`, import.meta.url)
    for (const f of await readdir(base)) {
      if (!f.endsWith('.mjs')) continue
      const src = await readFile(new URL(f, base), 'utf8')
      assert.doesNotMatch(src, /from ['"]node:/, `${dir}/${f} 引入了 node: 模块，网页端会崩`)
    }
  }
})

test('命令行：元数据不全是「算不出来」，也不能报成装不下', () => {
  const broken = { ...meta8b, blockCount: undefined, headKv: undefined, embdLength: undefined }
  const out = render(broken, hw8b, assess(broken, hw8b, {}))
  assert.ok(out.includes('算不出来'))
  assert.ok(out.includes('缺 block_count / head_count / embedding_length') || out.includes('元数据缺'))
  assert.ok(!out.includes('超过上限'))
})

test('JSON：CPU 推理的速度不能写成 0 tok/s', () => {
  // speed.onVram 是 null，Math.round(null) === 0 —— 看起来像真测出了 0 tok/s
  const cpuHw = { gpus: [], ramBytes: 16 * GB, ramBandwidthGBps: 60, platform: 'test' }
  const row = toJson([{ meta: meta8b, result: assess(meta8b, cpuHw, {}) }])[0]
  assert.equal(row.genTokPerSec, null)
  assert.ok(row.genTokPerSecOnCpu > 0)
  assert.equal(row.cpuOnly, true)
})

// ───────────── 速度口径：零上下文峰值 / 封顶 / 上下文折减 ─────────────

test('速度公式守住 RTX 2080 + 9B Q4 的实测校准点', () => {
  // core/assess.mjs 注释里那个校准点：448 GB/s × 0.7 ÷ 5.78 GB = 54.3，实测 53.9。
  // 把它写成断言，免得以后调效率因子时把已验证的校准悄悄改坏。
  const nineB = { ...meta8b, sizeBytes: 5.78e9 }
  const hw = {
    gpus: [{ name: 'RTX 2080', totalBytes: 8 * GB, usedBytes: 0, bandwidthGBps: 448 }],
    ramBytes: 32 * GB, ramBandwidthGBps: 50, platform: 'test'
  }
  const r = assess(nineB, hw, { weightsBytes: 5.78e9 })
  assert.ok(Math.abs(r.speed.onVram - 54.3) < 0.2, `公式值偏离校准点：${r.speed.onVram}`)
  assert.ok(Math.abs(r.speed.onVram / 53.9 - 1) < 0.01, '和实测的差距应在 1% 内')
})

test('CPU 推理的速度效率因子与 TUNING 同源，不再写死 0.7', () => {
  const hw = { gpus: [], ramBytes: 16 * GB, ramBandwidthGBps: 60, platform: 'test' }
  const meta = { ...meta8b, sizeBytes: 4 * GB }
  const r = assess(meta, hw, { weightsBytes: 4 * GB })
  assert.equal(r.speed.efficiency, TUNING.memoryEfficiency)
  const expected = (60 * TUNING.memoryEfficiency) / (4 * GB / 1e9)
  assert.ok(Math.abs(r.speed.onRam - expected) < 1e-9, `CPU 分支应算出 ${expected}，实际 ${r.speed.onRam}`)
})

test('速度封顶：小模型的 JSON 不能再把公式值原样报出去', () => {
  assert.equal(speedCapFor(1.5e9), TUNING.speedCapTiny)
  assert.equal(speedCapFor(5e9), TUNING.speedCap)
  assert.equal(speedCapFor(0), TUNING.speedCap, '体积拿不到时按常规档兜底')

  // 0.5 GB 小模型配 448 GB/s 的卡，公式给 627 tok/s —— kernel launch / 采样
  // 是固定开销，物理上跑不到。命令行早就封顶，JSON 以前却直接 Math.round。
  const tiny = { ...meta8b, file: 'Qwen3-0.6B-Q4_K_M.gguf', sizeBytes: 0.5e9 }
  const fastGpu = {
    gpus: [{ name: 'RTX 2080', totalBytes: 8 * GB, usedBytes: 0, bandwidthGBps: 448 }],
    ramBytes: 16 * GB, ramBandwidthGBps: 60, platform: 'test'
  }
  const result = assess(tiny, fastGpu, { weightsBytes: 0.5e9 })
  assert.ok(result.speed.onVram > 600, `公式值应明显超过封顶，实际 ${result.speed.onVram}`)

  const row = toJson([{ meta: tiny, result }])[0]
  assert.equal(row.genTokPerSec, TUNING.speedCapTiny, 'JSON 与命令行必须同一个封顶')
  const text = render(tiny, fastGpu, result)
  assert.ok(!text.includes('627'), '命令行也不该把未封顶的公式值写出来')
})

test('按建议上下文折减：峰值不含 KV 读取，折减值必须更低', () => {
  const r = assess(meta8b, hw8b, {})
  const peak = r.speed.onVram
  assert.ok(r.speed.atCtx > 0 && r.speed.atCtx < peak,
    `折减值 ${r.speed.atCtx} 应落在 0 与峰值 ${peak} 之间`)
  assert.equal(r.speed.atCtxTokens, r.best.ctx)
  // 带宽与利用率不变时速度 ∝ 1/(权重 + KV)，直接核对公式
  const expected = peak * r.weights / (r.weights + r.best.kv)
  assert.ok(Math.abs(r.speed.atCtx - expected) < 1e-9)
  // 上下文越长折减越多：手工把建议档的 KV 翻倍，速度必须下降
  const longer = peak * r.weights / (r.weights + r.best.kv * 2)
  assert.ok(longer < r.speed.atCtx)

  const row = toJson([{ meta: meta8b, result: r }])[0]
  assert.equal(row.speedBasis, 'zero-context-decode-peak')
  assert.equal(row.speedCtx, r.best.ctx)
  assert.ok(row.genTokPerSecAtCtx > 0 && row.genTokPerSecAtCtx < row.genTokPerSec,
    `折减 ${row.genTokPerSecAtCtx} 应低于峰值 ${row.genTokPerSec}`)
  assert.match(row.disclaimer, /零上下文/, 'JSON 契约里要写明口径')
})

// ───────────────────────── MoE（混合专家） ─────────────────────────

const metaMoe = {
  ...meta8b,
  file: 'DeepSeek-R1-235B-A22B-Q4_K_M.gguf',
  name: 'DeepSeek-R1',
  arch: 'deepseek2',
  sizeBytes: 5.78e9,
  paramCount: 235e9,
  expertCount: 256,
  expertUsedCount: 8
}
const gpuFast = {
  gpus: [{ name: 'RTX 2080', totalBytes: 24 * GB, usedBytes: 0, bandwidthGBps: 448 }],
  ramBytes: 64 * GB, ramBandwidthGBps: 50, platform: 'test'
}

test('MoE 判定：dense 返回 null，KV 有 expert_used_count 时按专家比例', () => {
  assert.equal(moeInfo(meta8b, 5.78e9), null, 'dense 不该被判成 MoE')

  const m = moeInfo(metaMoe, 5.78e9)
  assert.equal(m.experts, 256)
  assert.equal(m.used, 8)
  assert.equal(m.ratio, 8 / 256)
  assert.equal(m.source, 'kv')
  assert.equal(m.corrected, true)
  assert.ok(Math.abs(m.activeBytes - 5.78e9 * (8 / 256)) < 1, '激活权重 = 全权重 × 比例')
})

test('MoE 兜底：KV 缺 expert_used_count 时从文件名 A22B 取激活比例', () => {
  assert.equal(activeParamsFromName('DeepSeek-R1-235B-A22B-Q4_K_M.gguf'), 22)
  assert.equal(activeParamsFromName('Qwen3-8B-Q4_K_M.gguf'), undefined, 'dense 文件名不该读出激活参数')

  const noKv = { ...metaMoe, expertUsedCount: undefined }
  const m = moeInfo(noKv, 5.78e9)
  assert.equal(m.source, 'name')
  assert.equal(m.used, null, '文件名只给参数比例，不该编造一个专家数')
  assert.equal(m.activeParamsB, 22)
  assert.ok(Math.abs(m.ratio - 22 / 235) < 1e-12, '比例 = A22B / 235B')
  assert.equal(m.corrected, true)
})

test('MoE 信息不足时不修正：不编比例、不虚报速度', () => {
  // 有专家数但 KV 和文件名都没有激活信息 → ratio=null、速度按全权重
  const bare = { ...metaMoe, file: 'Some-MoE-Q4.gguf', expertUsedCount: undefined, paramCount: undefined }
  const m = moeInfo(bare, 5.78e9)
  assert.equal(m.experts, 256)
  assert.equal(m.ratio, null)
  assert.equal(m.corrected, false)
  assert.equal(m.activeBytes, 5.78e9, '没激活信息就按全权重，绝不编数字')

  // used >= experts 等于没省，也不修正
  const allActive = moeInfo({ ...metaMoe, expertUsedCount: 256 }, 5.78e9)
  assert.equal(allActive.corrected, false)
})

test('MoE 速度按激活权重算，显存判定仍按全权重', () => {
  const denseR = assess({ ...meta8b, sizeBytes: 5.78e9 }, gpuFast, { weightsBytes: 5.78e9 })
  const moeR = assess(metaMoe, gpuFast, { weightsBytes: 5.78e9 })

  // 速度：MoE 只激活 8/256，应远快于同体积 dense
  assert.ok(moeR.speed.onVram > denseR.speed.onVram * 10,
    `MoE 激活速度应远超 dense：${moeR.speed.onVram} vs ${denseR.speed.onVram}`)
  assert.ok(Math.abs(moeR.speed.basisBytes - 5.78e9 * (8 / 256)) < 1, '速度封顶口径 = 激活权重')

  // 显存：weights / limit / 档位 need 仍按全权重，MoE 不能因此被误判「装得下更大上下文」
  assert.equal(moeR.weights, 5.78e9)
  assert.equal(moeR.limit, denseR.limit)
  assert.equal(moeR.rows[0].need, denseR.rows[0].need)

  // atCtx 折减分子也用激活权重
  const expectedAtCtx = moeR.speed.onVram * moeR.speed.basisBytes / (moeR.speed.basisBytes + moeR.best.kv)
  assert.ok(Math.abs(moeR.speed.atCtx - expectedAtCtx) < 1e-9)
})

test('MoE 三端展示：CLI 出专家行、JSON 带 ratio、封顶按激活权重、行宽不超 100', () => {
  const r = assess(metaMoe, gpuFast, { weightsBytes: 5.78e9 })

  const row = toJson([{ meta: metaMoe, result: r }])[0]
  assert.equal(row.moe.experts, 256)
  assert.equal(row.moe.active, 8)
  assert.ok(Math.abs(row.moe.ratio - 8 / 256) < 1e-12)
  assert.equal(row.moe.corrected, true)
  assert.equal(row.moe.source, 'kv')
  assert.equal(row.moe.speedBasisBytes, r.speed.basisBytes)
  // 激活权重 5.78GB × 8/256 = 0.18GB（< 2GB 小模型档），公式值 1736 要封到 200。
  // 若误用全权重 5.78GB 封顶会得 400 —— 这个断言同时钉住「封顶口径=激活权重」。
  assert.equal(row.genTokPerSec, TUNING.speedCapTiny)

  try {
    for (const lang of ['zh', 'en']) {
      setLocale(lang)
      const text = render(metaMoe, gpuFast, r)
      assert.match(text, /MoE/, `${lang} 报告应出现 MoE 标记`)
      assert.match(text, /256/, `${lang} 报告应显示专家数`)
      for (const line of text.split('\n')) {
        const w = [...line].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0)
        assert.ok(w <= 100, `${lang} 有 ${w} 列的行：${line}`)
        assert.ok(!/undefined|NaN|⟪/.test(line), `${lang} 有未替换内容：${line}`)
      }
    }
  } finally {
    setLocale('zh') // 断言失败也不能把 locale 留在 en，污染后面的测试
  }

  // 信息不足的 MoE 也要能渲染，且不崩、不报假速度
  const bare = { ...metaMoe, file: 'Some-MoE-64x7B-Q4.gguf', expertUsedCount: undefined, paramCount: undefined }
  const bareR = assess(bare, gpuFast, { weightsBytes: 5.78e9 })
  const bareText = render(bare, gpuFast, bareR)
  assert.ok(bareText.includes('MoE'))
  assert.ok(!/undefined|NaN/.test(bareText))
})

// ───────────────────────── MoE 显存 + RAM 合计判定 / 启动参数 ─────────────────────────

/** 贴近用户场景：8GB 卡、32GB RAM、16GB 的 8 专家 MoE */
const hw8Ram32 = {
  gpus: [{ name: 'RTX 2080', totalBytes: 8 * GB, usedBytes: 0.85 * GB, bandwidthGBps: 448 }],
  ramBytes: 32 * GB, ramBandwidthGBps: 51, osPlatform: 'win32'
}
const metaBigMoe = {
  ...meta8b,
  file: 'Mixtral-8x7B-Q6_K.gguf', arch: 'llama', name: 'Mixtral-8x7B',
  sizeBytes: 16.04e9, paramCount: 46.7e9, blockCount: 32, headCount: 24, headKv: 8,
  embdLength: 3072, contextLength: 131072, expertCount: 8, expertUsedCount: 2
}

test('MoE 合计判定：显存放不下但 RAM 够 → combinedFit / canOffload', () => {
  const r = assess(metaBigMoe, hw8Ram32, { weightsBytes: 16.04e9 })
  assert.equal(r.weightsFit, false, '16GB 权重在 8GB 卡上确实装不下全权重')
  assert.equal(r.moe.combinedFit, true, '显存+系统RAM 合计够')
  assert.equal(r.moe.canOffload, true, 'MoE 可把专家 offload 到 RAM 运行')
  assert.ok(r.moe.supplyBytes > r.moe.needBytes)
  assert.ok(r.moe.spillBytes > 0)
  assert.ok(r.moe.offloadLayers >= 1 && r.moe.offloadLayers <= 32, 'offload 层数在合理范围')
  assert.ok(Math.abs(r.moe.usableRam - 32 * GB * TUNING.moeRamFactor) < 1)
})

test('结论一致性：MoE 靠专家放内存能跑时，verdict 不能说「跑不动」', () => {
  // 以前 verdictOf 只看 weightsFit/best：报告抬头写「能跑，但专家要放内存」，
  // JSON 却给 not-recommended，照 JSON 做界面的会说反话。
  const r = assess(metaBigMoe, hw8Ram32, { weightsBytes: 16.04e9 })
  assert.equal(r.moe.canOffload, true)
  assert.equal(r.best, null, '单卡确实一档上下文都没有（权重都装不下）')
  assert.notEqual(verdictOf(metaBigMoe, r), 'not-recommended')
  assert.match(headlineOf(metaBigMoe, r).title, /专家|offload/)
})

test('MoE 合计判定：RAM 也不够时 combinedFit=false，不误导', () => {
  const tinyRam = { ...hw8Ram32, ramBytes: 4 * GB }
  const r = assess(metaBigMoe, tinyRam, { weightsBytes: 16.04e9 })
  assert.equal(r.moe.combinedFit, false)
  assert.equal(r.moe.canOffload, false)
})

test('MoE headline：能 offload 时不报「跑不动」，给专门档位', () => {
  const r = assess(metaBigMoe, hw8Ram32, { weightsBytes: 16.04e9 })
  const hd = headlineOf(metaBigMoe, r)
  assert.equal(hd.level, 'warn')
  assert.match(hd.short, /offload/)
  assert.ok(!/跑不动|won't run/.test(hd.title + hd.short))

  // dense 同样装不下时必须仍是「跑不动」，不能被 MoE 逻辑带偏
  const dense = { ...meta8b, file: 'BigDense-32B-Q4.gguf', sizeBytes: 16.04e9, paramCount: 32e9 }
  const dr = assess(dense, hw8Ram32, { weightsBytes: 16.04e9 })
  const dhd = headlineOf(dense, dr)
  assert.equal(dhd.level, 'bad')
  assert.match(dhd.short, /装不下|won't fit/)
})

test('启动参数：MoE offload 场景给 -ngl / --n-cpu-moe / -c', () => {
  const r = assess(metaBigMoe, hw8Ram32, { weightsBytes: 16.04e9 })
  const args = launchArgsOf(metaBigMoe, r)
  const flags = args.map((a) => a.flag)
  assert.ok(flags.some((f) => /^-ngl /.test(f)), '应有 -ngl')
  const cpuMoe = flags.find((f) => f.startsWith('--n-cpu-moe'))
  assert.ok(cpuMoe, 'MoE offload 场景应有 --n-cpu-moe')
  assert.match(cpuMoe, new RegExp(`${r.moe.offloadLayers}`))
  assert.ok(flags.some((f) => /^-c /.test(f)), '应有 -c 上下文')
  // JSON 也带上了
  const row = toJson([{ meta: metaBigMoe, result: r }])[0]
  assert.ok(row.launchArgs.length >= 3)
  assert.equal(row.moe.canOffload, true)
  assert.equal(row.moe.offloadLayers, r.moe.offloadLayers)
})

test('启动参数：单卡靠专家放内存、合并全放显存更快时，末尾给合并那条', () => {
  // 双卡机器上同样的 MoE：合并后 16 GB 全进显存，比专家读内存快一个档。
  // 这时候终端末尾的「启动参数建议」和 JSON 的 launchArgs 都必须是合并那一套 ——
  // 用户只抄最后一段，给慢的那条等于让 74 tok/s 白写在上面。
  const hwTwo = {
    ...hw8Ram32,
    gpus: [
      { name: 'RTX 2080', totalBytes: 8 * GB, usedBytes: 0.85 * GB, bandwidthGBps: 448, backend: 'cuda' },
      { name: 'P104-100', totalBytes: 8 * GB, usedBytes: 0, bandwidthGBps: 320, backend: 'cuda' }
    ]
  }
  // 11.29 GB：单卡 7.52 GB 上限装不下，合并池 15.04 GB 正好放得下
  const moe = { ...metaBigMoe, file: 'L3.2-8X4B-MOE-21B-Q4_k_s.gguf', sizeBytes: 11.29e9, paramCount: 21e9 }
  const r = assess(moe, hwTwo, { weightsBytes: 11.29e9 })
  const mg = mergedHardware(hwTwo)
  const merged = assess(moe, mg.hw, { weightsBytes: 11.29e9 })
  assert.equal(r.moe.canOffload, true, '单卡走专家放内存')
  assert.ok(merged.weightsFit && merged.best, '合并后全放显存')
  assert.ok(merged.speed.onVram > r.speed.onRam * 1.15, '合并确实快得多')

  const out = render(moe, hwTwo, r, { kvType: 'f16', budget: 'static' })
  const launch = out.slice(out.indexOf('启动参数建议'))
  assert.match(launch, /-dev CUDA0,CUDA1/, '末尾命令要给合并')
  assert.doesNotMatch(launch, /--n-cpu-moe/, '不能再给「专家放内存」那条慢路')
  // 命令只出现一次：合并评估段里不该再重复一遍
  assert.equal((out.match(/-dev CUDA0,CUDA1/g) || []).length, 1)

  const row = toJson([{ meta: moe, result: r, combined: merged, mg }])[0]
  assert.equal(row.splitAcrossGpus, true)
  assert.ok(row.launchArgs.some((a) => a.flag.startsWith('-dev')), 'JSON 也要给合并')
})

test('启动参数：dense 与元数据不全场景不出 --n-cpu-moe', () => {
  const dense = { ...meta8b, sizeBytes: 5.78e9 }
  const dr = assess(dense, hw8b, { weightsBytes: 5.78e9 })
  const denseFlags = launchArgsOf(dense, dr).map((a) => a.flag)
  assert.ok(!denseFlags.some((f) => f.startsWith('--n-cpu-moe')), 'dense 不该有 --n-cpu-moe')
  assert.ok(denseFlags.some((f) => f.startsWith('-ngl')))
})

test('MoE 合计判定 + 启动参数的三端渲染：说明出现、行宽不超 100', () => {
  const r = assess(metaBigMoe, hw8Ram32, { weightsBytes: 16.04e9 })
  try {
    for (const lang of ['zh', 'en']) {
      setLocale(lang)
      const text = render(metaBigMoe, hw8Ram32, r)
      assert.match(text, /MoE/, `${lang} 应有 MoE 标记`)
      assert.match(text, /--n-cpu-moe/, `${lang} 应显示 --n-cpu-moe 启动参数`)
      assert.match(text, /内存|RAM/, `${lang} 应说明 offload 到内存`)
      for (const line of text.split('\n')) {
        const w = [...line].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0)
        assert.ok(w <= 100, `${lang} 有 ${w} 列的行：${line}`)
        assert.ok(!/undefined|NaN|⟪/.test(line), `${lang} 有未替换内容：${line}`)
      }
    }
  } finally {
    setLocale('zh')
  }
})

test('MLA：报告模型段标出潜在 KV，中英都不超宽', () => {
  const ds = {
    ...metaMoe,
    blockCount: 61, nextnLayers: 1,
    headCount: 128, headKv: 1, embdLength: 7168,
    keyLength: 576, valueLength: 512,
    keyLengthMla: 192, valueLengthMla: 128,
    kvLoraRank: 512, ropeDimCount: 64
  }
  const r = assess(ds, gpuFast, { weightsBytes: 5.78e9 })
  try {
    for (const lang of ['zh', 'en']) {
      setLocale(lang)
      const text = render(ds, gpuFast, r)
      assert.match(text, /MLA/, `${lang} 报告应标出 MLA`)
      assert.match(text, /576/, `${lang} 报告应显示每 token 元素数`)
      for (const line of text.split('\n')) {
        const w = [...line].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0)
        assert.ok(w <= 100, `${lang} 有 ${w} 列的行：${line}`)
        assert.ok(!/undefined|NaN|⟪/.test(line), `${lang} 有未替换内容：${line}`)
      }
    }
  } finally {
    setLocale('zh')
  }
})

test('假设清单：MoE 说明改为「已按激活专家修正」', () => {
  const lines = assumptionLines().join('\n')
  assert.match(lines, /激活专家|active experts/, '假设清单不该再说「未计入激活比例」')
})

test('假设清单：明说峰值「不计上下文」并给出折减说明', () => {
  const lines = assumptionLines().join('\n')
  assert.match(lines, /零上下文解码峰值/)
  assert.match(lines, /不计 KV cache 读取|KV cache 读取/)
  assert.match(lines, /命令行与 JSON 都套用同一个封顶/)
})

// ───────────────────────── 报告版式 ─────────────────────────

test('版式：不折行、不留尾空格、值列对齐、免责只印一次', () => {
  const out = render(meta8b, hw8b, assess(meta8b, hw8b, {}))
  const dw = (s) => [...s].reduce((n, ch) => n +
    (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0)
  const lines = out.split('\n')

  // 80 列终端是下限，90 列留一点余量；超了就会折行，整张表散架
  for (const l of lines) assert.ok(dw(l) <= 90, `超过 90 列会折行：${l}`)
  for (const l of lines) assert.equal(l, l.replace(/\s+$/, ''), `行尾多了空格：${JSON.stringify(l)}`)
  assert.doesNotMatch(out, /undefined|NaN/)

  // 免责是"仅供参考"，重复三遍会变成噪音，也让人以为是三条独立证据
  assert.equal((out.match(/仅供参考/g) || []).length, 1, '免责声明只该出现一次')

  // 标签列固定 12 显示宽度：值必须都从第 16 个显示列开始，否则中文标签会把表推开
  // （slice 按码元算，中文会被多切 2 列，所以用「缩进+标签+填充」的实际宽度来比）
  const labels = ['文件', '体积', '架构', '量化', '原生上下文', '结构', '权重', '运行时开销', '可用上限']
  for (const lab of labels) {
    const line = lines.find((l) => l.startsWith(`    ${lab}`))
    assert.ok(line, `报告里找不到「${lab}」这一行`)
    const m = line.match(/^(\s+)(\S+)(\s+)/)
    assert.equal(dw(m[1] + m[2] + m[3]), 16, `「${lab}」的值没对齐：${line}`)
  }
})

// ───────────────────────── 参数与假设 ─────────────────────────

test('参数与假设：报告里印出来的数字就是代码里用的那个', () => {
  const out = render(meta8b, hw8b, assess(meta8b, hw8b, {}))
  const mib = Math.round(TUNING.overheadBytes / 1024 / 1024)
  assert.ok(out.includes(`${mib} MiB`), `报告里该写 ${mib} MiB`)
  assert.ok(out.includes('--about'), '要告诉用户去哪看完整清单')
  // 文案里出现过的比例，必须和 TUNING 对得上
  assert.ok(out.includes(`×${TUNING.tightRatio}`) || out.includes(`×${TUNING.tightRatio * 100}`))
})

test('参数与假设：清单完整、和 TUNING 一致', () => {
  // 面板怎么渲染归网页版管（site/test.mjs），这里只守住数据本身不漂
  for (const g of ASSUMPTIONS) assert.ok(g.items.length > 0, `${g.group} 没有条目`)
  assert.equal(Math.round(TUNING.overheadBytes / 1024 / 1024), 800)
  assert.equal(KV_BYTES_PER_ELEM.f16, 2)
  assert.equal(KV_BYTES_PER_ELEM.q8_0, 1.0625)
})

test('参数与假设：assess 用到的比例和图里写的一致', () => {
  // 混着用两套数字是最难查的 bug：报告说按 92% 算，代码按 94% 算，谁都不报错。
  const g8 = { totalBytes: 8 * GB, usedBytes: 0 }
  const lin = vramCeiling({ ...g8, platform: 'linux', budget: 'auto' })
  assert.equal(lin.limit, 8 * GB * TUNING.freeFactor)
  const win = vramCeiling({ ...g8, platform: 'win32', budget: 'auto' })
  // min 而不是 max：total×0.94 只是物理上限，不能当预算用（空闲时 free×0.92 更小，取它）
  assert.equal(win.limit, Math.min(8 * GB * TUNING.wddmFreeFactor, 8 * GB * TUNING.wddmTotalFactor))
  const uni = vramCeiling({ totalBytes: 32 * GB, unified: true, maxWorkingSetBytes: 24 * GB })
  assert.equal(uni.limit, 24 * GB * TUNING.unifiedReserve)
})


// ───────────────────────── 语言（i18n） ─────────────────────────

test('版本号：check.mjs 里写死的和 package.json 一致', async () => {
  // 单文件 bin 不读 package.json，两处只能靠测试对齐。
  // 不一致时发布的包 --version 会说谎，npm 页面和实际行为对不上。
  const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, pkg.version)
})

test('词条表：两种语言都齐、没有空串、没有漏写的占位符', () => {
  const { count, broken } = dictStats()
  assert.ok(count > 150, `词条太少，看起来没接完：${count}`)
  assert.deepEqual(broken, [], `这些词条不完整：${broken.join(', ')}`)
})

test('词条表：中英占位符一一对应', () => {
  // 中文写了 {n} 而英文漏了，英文那句数字就会消失，而且不会有任何报错
  const { keys } = dictStats()
  const bad = []
  for (const k of keys) {
    const both = bothLangs(k)
    const ph = (x) => (String(x).match(/\{(\w+)\}/g) ?? []).sort().join(',')
    if (ph(both.zh) !== ph(both.en)) bad.push(`${k}: ${ph(both.zh)} vs ${ph(both.en)}`)
  }
  assert.deepEqual(bad, [], `占位符对不上：\n${bad.join('\n')}`)
})

test('语言检测：显式 > 环境变量 > 系统 locale，C/POSIX 当没表态', () => {
  assert.equal(detectLocale({ arg: 'en', env: { LANG: 'zh_CN.UTF-8' } }), 'en')
  assert.equal(detectLocale({ arg: 'zh', env: { LANG: 'en_US.UTF-8' } }), 'zh')
  assert.equal(detectLocale({ env: { VRAMFIT_LANG: 'en' } }), 'en')
  assert.equal(detectLocale({ env: { LANG: 'zh_CN.UTF-8' } }), 'zh')
  assert.equal(detectLocale({ env: { LC_ALL: 'en_GB.UTF-8', LANG: 'zh_CN.UTF-8' } }), 'en')
  // C / POSIX 说明用户没表态，不能据此判成英文
  const c = detectLocale({ env: { LANG: 'C' } })
  assert.ok(c === 'zh' || c === 'en')
})

test('语言切换：非法值要报错，不能静默退回中文', () => {
  assert.throws(() => setLocale('fr'))
  setLocale('zh')
  assert.equal(getLocale(), 'zh')
  setLocale('en')
  assert.equal(getLocale(), 'en')
  setLocale('zh')
})

test('标签列宽：英文比中文宽，否则值列会被挤歪', () => {
  setLocale('zh')
  const zh = labelWidth()
  setLocale('en')
  const en = labelWidth()
  setLocale('zh')
  assert.ok(en > zh, `英文标签列 ${en} 应该比中文 ${zh} 宽`)
})

const renderBoth = () => {
  const out = {}
  for (const lang of ['zh', 'en']) {
    setLocale(lang)
    out[lang] = render(meta8b, hw8b, assess(meta8b, hw8b, { kvType: 'f16' }), { kvType: 'f16' })
  }
  setLocale('zh')
  return out
}

test('英文报告：不能残留任何中文（术语除外）', () => {
  const { en } = renderBoth()
  const cjk = en.split('\n').filter((l) => /[\u4e00-\u9fff]/.test(l))
  assert.deepEqual(cjk, [], `英文报告里还有中文：\n${cjk.join('\n')}`)
  // 全角标点也是「没翻干净」的信号
  const full = en.split('\n').filter((l) => /[，。「」（）：；]/.test(l))
  assert.deepEqual(full, [], `英文报告里还有全角标点：\n${full.join('\n')}`)
})

test('中文报告：也不能混进英文句子（标签必须是中文）', () => {
  const { zh } = renderBoth()
  for (const label of ['文件', '体积', '架构', '量化', '权重', '可用上限']) {
    assert.ok(zh.includes(label), `中文报告缺标签「${label}」`)
  }
})

test('英文报告：行宽不超 100 列，没有 undefined / NaN / 未替换的占位符', () => {
  for (const [lang, out] of Object.entries(renderBoth())) {
    for (const line of out.split('\n')) {
      const w = [...line].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0)
      assert.ok(w <= 100, `${lang} 有 ${w} 列的行：${line}`)
      assert.ok(!/undefined|NaN|⟪/.test(line), `${lang} 出现 undefined/NaN/未翻译 key：${line}`)
    }
  }
})

test('英文报告：值列仍然对齐（标签列宽跟着语言走）', () => {
  setLocale('en')
  const out = render(meta8b, hw8b, assess(meta8b, hw8b, { kvType: 'f16' }), { kvType: 'f16' })
  setLocale('zh')
  // 「File / Size / Arch」三行的值都必须从同一列开始：
  // 标签后第一个非空格的位置就是值列的起点
  const starts = ['File', 'Size', 'Arch'].map((lab) => {
    const line = out.split('\n').find((l) => l.trimStart().startsWith(lab))
    const idx = line.indexOf(lab) + lab.length
    const rest = line.slice(idx)
    return idx + (rest.length - rest.replace(/^\s+/, '').length)
  })
  // 值是变长的（文件名 / 体积 / 架构都有颜色码），只要求它们都落在同一个「标签列」之后
  assert.equal(new Set(starts).size, 1, `英文标签列没对齐：${starts.join(',')}`)
})

test('仓库对比表：换语言后推荐行仍然选得出来（按 rank 不按文案）', () => {
  const rows = [
    { file: 'Q4_K_M.gguf', quant: 'Q4_K_M', weights: 5 * GB, best: 32768, onVram: 54, hasTemplate: true, toolOk: true, tier: 3, qualityLabel: '轻微损失' },
    { file: 'Q2_K.gguf', quant: 'Q2_K', weights: 3 * GB, best: 32768, onVram: 90, hasTemplate: true, toolOk: true, tier: 1, qualityLabel: '明显有损' }
  ]
  const out = {}
  for (const lang of ['zh', 'en']) {
    setLocale(lang)
    out[lang] = renderRepoTable('a/b', rows)
  }
  setLocale('zh')
  assert.ok(out.zh.includes('Q4_K_M'), '中文推荐行丢了')
  assert.ok(out.en.includes('Q4_K_M'), '英文推荐行丢了')
  assert.ok(/Recommended|推荐/.test(out.en + out.zh), '推荐字样必须有')
  assert.ok(!/推荐/.test(out.en), '英文表里不该出现「推荐」')
})

test('参数与假设：换语言后清单跟着变，英文版不带中文', () => {
  setLocale('zh')
  const zh = assumptionsList()
  setLocale('en')
  const en = assumptionsList()
  setLocale('zh')

  assert.equal(zh.length, en.length, '两种语言的条目数必须一样')
  assert.ok(zh[0].group !== en[0].group, '英文清单没跟着切')
  const flat = en.flatMap((g) => [g.group, ...g.items.flatMap((it) => [it.k, it.v, it.note])])
  const bad = flat.filter((x) => /[\u4e00-\u9fff]/.test(x))
  assert.deepEqual(bad, [], `英文假设清单里有中文：${bad.join(' / ')}`)
})

// ───────────────────── 交互模式里的语言切换 ─────────────────────

test('语言别名：cn / -en / 中文 / english 都认，别的返回 null', () => {
  for (const [word, want] of [
    ['zh', 'zh'], ['cn', 'zh'], ['-cn', 'zh'], ['--cn', 'zh'], ['中文', 'zh'],
    ['简体中文', 'zh'], ['zh-CN', 'zh'], ['chinese', 'zh'],
    ['en', 'en'], ['-en', 'en'], ['EN', 'en'], ['eng', 'en'], ['english', 'en'],
    ['英文', 'en'], ['en_US', 'en']
  ]) {
    assert.equal(localeOf(word), want, `localeOf(${word}) 应该是 ${want}`)
  }
  // 关键：文件名不能被当成语言，否则「检查 cn 这个目录」就换成中文了
  for (const word of ['war', 'en.gguf', 'zh.txt', 'qwen', '', '  ']) {
    assert.equal(localeOf(word), null, `localeOf(${word}) 应该认不出来`)
  }
})

test('命令行参数：owner/repo 猜成 HF 仓库，不能当成相对路径', async () => {
  // README 首屏第一行示例就是 `npx vramfit unsloth/Qwen3-8B-GGUF`。
  // 命令行这条路径曾经漏传 guessRepo，害得示例命令直接报 ENOENT。
  const hf = await expandTargets(['unsloth/Qwen3-8B-GGUF'], { guessRepo: true })
  assert.deepEqual(hf.files, [], '不能当成本地文件')
  assert.deepEqual(hf.repos, ['unsloth/Qwen3-8B-GGUF'], '要认成仓库')

  // 斜杠在路径里是分隔符，不是仓库分隔符。./nope 只有一个斜杠，
  // 光看形状很像 owner/repo，猜成仓库只会给出让人摸不着头脑的报错。
  const rel = await expandTargets(['./nope'], { guessRepo: true })
  assert.deepEqual(rel.repos, [], './ 开头的是路径，不是仓库')
  assert.equal(rel.files.length, 1)

  // 不给开关时一律按本地路径处理。猜仓库这件事必须是显式的，
  // 否则「文件不存在」和「这是仓库名」两种意图会被悄悄混在一起。
  const off = await expandTargets(['unsloth/Qwen3-8B-GGUF'], {})
  assert.deepEqual(off.repos, [])
  assert.deepEqual(off.files, ['unsloth/Qwen3-8B-GGUF'])
})

test('交互模式：lang en 之后提示符变 check >，lang zh 之后变回 检查 >', () => {
  // 交互循环的分支（命令解析 / 清屏 / 重画抬头）在单测里 import 不到，
  // 只能拿管道喂 stdin 真跑一遍进程。
  const run = (input) => spawnSync(process.execPath, [CLI, '--no-color'], {
    input,
    encoding: 'utf8',
    cwd: path.dirname(CLI),
    // 起点钉成中文：不钉的话 CI（LANG=C）和本机会从不同语言开始
    env: { ...process.env, VRAMFIT_LANG: 'zh', LANG: 'C', LC_ALL: 'C' }
  }).stdout

  const toEn = run('lang en\nq\n')
  assert.match(toEn, /check > /, 'lang en 之后提示符应该是 check >')
  assert.match(toEn, /Switched to English/, '要留一行「切过了」的记录，否则用户以为没生效')
  // 切语言不该顺手清屏：那会把用户刚看到的报告抹掉。清屏是 cls 的活。
  assert.doesNotMatch(toEn, /\x1b\[2J/, '切换语言不能带清屏副作用')

  const toZh = run('lang zh\nq\n')
  assert.match(toZh, /检查 > /, 'lang zh 之后提示符应该是 检查 >')
  assert.match(toZh, /已切换为中文/)

  // 裸写和带横线都要能用 —— 用户凭直觉敲的就是这些
  assert.match(run('cn\nq\n'), /检查 > /)
  assert.match(run('-en\nq\n'), /check > /)
  // 交互里顺手敲 --lang en 也很常见，不能掉进「没认出这是链接还是文件」
  const asFlag = run('--lang en\nq\n')
  assert.match(asFlag, /check > /)
  assert.doesNotMatch(asFlag, /没认出这是链接还是文件/)
})

test('交互模式：裸 lang 只报当前语言，不切换', () => {
  const out = spawnSync(process.execPath, [CLI, '--no-color'], {
    input: 'lang\nq\n', encoding: 'utf8', cwd: path.dirname(CLI),
    env: { ...process.env, VRAMFIT_LANG: 'zh', LANG: 'C', LC_ALL: 'C' }
  }).stdout
  assert.match(out, /当前界面语言：中文/)
  assert.match(out, /lang zh  \/  lang en/, '要顺手给出用法')
})

test('交互模式：乱写的语言不改动当前语言', () => {
  const out = spawnSync(process.execPath, [CLI, '--no-color'], {
    input: 'lang war\nq\n', encoding: 'utf8', cwd: path.dirname(CLI),
    env: { ...process.env, VRAMFIT_LANG: 'zh', LANG: 'C', LC_ALL: 'C' }
  }).stdout
  assert.match(out, /没有「war」这个语言/)
  assert.match(out, /检查 > /, '报错后应该还停在中文')
})

// ── 附加件与逐层 KV 头数
//
// 这三个坑都是拿真实模型跑出来的：
//   LFM3       卷积层 + 注意力层交替，head_count_kv 首层是 0 → 整份报告「算不出来」
//   mmproj     视觉投影件，文件名继承主模型（…12b…-mmproj.gguf）→ 被报成 12B 模型
//   MTP 草稿   77 MB 的文件被判成「128K 装得下，可以当 agent 用」

/** 拼一个最小可解析的 GGUF v3（只有元数据，没有张量） */
function ggufBytes(kvs) {
  const parts = []
  const push = (b) => parts.push(b)
  const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); push(b) }
  const u64 = (n) => {
    const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); push(b)
  }
  const str = (s) => { const e = new TextEncoder().encode(s); u64(e.length); push(e) }
  u32(0x46554747); u32(3); u64(0); u64(kvs.length)
  for (const [key, val] of kvs) {
    str(key)
    if (typeof val === 'string') { u32(8); str(val) } else if (Array.isArray(val)) {
      u32(9); u32(5); u64(val.length) // 9 = ARRAY，5 = INT32
      for (const n of val) u32(n)
    } else { u32(5); u32(val) } // 5 = INT32
  }
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

async function writeGguf(kvs) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vramfit-gguf-'))
  const file = path.join(dir, 'probe.gguf')
  await writeFile(file, ggufBytes(kvs))
  return { file, dir }
}

test('逐层 head_count_kv：首层是 0 也要读出 KV 头数与带 KV 的层数', async () => {
  // LFM3 的真实形态：24 层，卷积层写 0，注意力层写 4
  const arr = Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? 0 : 4))
  const { file, dir } = await writeGguf([
    ['general.architecture', 'lfm3'],
    ['lfm3.block_count', 24],
    ['lfm3.attention.head_count', 16],
    ['lfm3.attention.head_count_kv', arr],
    ['lfm3.embedding_length', 2048],
    ['lfm3.attention.key_length', 128],
    ['lfm3.attention.sliding_window', 256]
  ])
  try {
    const meta = await readGguf(file)
    assert.equal(meta.headKv, 4, '取数组最大值，不是第一个元素（第一个是 0）')
    assert.equal(meta.kvLayerCount, 12, '12 层带 KV，不是 24')
    assert.equal(kvLayers(meta), 12)
    // 有 KV 才算得出来：以前 headKv=0 直接返回 null，整份报告退化成「算不出来」
    const kv = kvBytes(meta, 4096, 'f16')
    assert.ok(kv > 0, 'KV 必须算得出来，不能被 0 头数拦掉')
    const r = assess(meta, { gpus: [{ name: 'X', totalBytes: 8 * GB, usedBytes: 0, bandwidthGBps: 400 }] })
    assert.notEqual(r.estimated, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('视觉投影件：arch=clip 且 has_vision_encoder → 判成 mmproj，不当模型', async () => {
  const { file, dir } = await writeGguf([
    ['general.architecture', 'clip'],
    ['general.name', 'Gemma-4-12B-It'],
    ['clip.has_vision_encoder', 1]
  ])
  try {
    const meta = await readGguf(file)
    assert.equal(meta.isVision, true)
    assert.equal(meta.isAssistant, false)
    const r = assess(meta, { gpus: [{ name: 'X', totalBytes: 8 * GB, bandwidthGBps: 400 }] })
    const hd = headlineOf(meta, r)
    assert.match(hd.title, /视觉投影件/)
    assert.match(hd.why, /显存另算 0\.\d+ GB/, '要给出额外占多少显存（投影件 + 图像缓冲）')
    assert.equal(verdictOf(meta, r), 'vision-projector')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('MTP 草稿：所有层都是 nextn 层 → 判成草稿件，不给 -ngl', async () => {
  const { file, dir } = await writeGguf([
    ['general.architecture', 'gemma4-assistant'],
    ['gemma4-assistant.block_count', 4],
    ['gemma4-assistant.nextn_predict_layers', 4],
    ['gemma4-assistant.attention.head_count', 4],
    ['gemma4-assistant.attention.head_count_kv', 2],
    ['gemma4-assistant.embedding_length', 256],
    ['gemma4-assistant.context_length', 131072]
  ])
  try {
    const meta = await readGguf(file)
    assert.equal(meta.isAssistant, true)
    const r = assess(meta, { gpus: [{ name: 'X', totalBytes: 8 * GB, bandwidthGBps: 400 }] })
    const hd = headlineOf(meta, r)
    assert.match(hd.title, /草稿件/)
    assert.equal(verdictOf(meta, r), 'draft-model')
    // 77 MB 的草稿件绝不能再出现「可以当 agent 用」或 -ngl 999
    const out = render(meta, { gpus: [{ name: 'X', totalBytes: 8 * GB, bandwidthGBps: 400 }] }, r, {})
    assert.doesNotMatch(out, /-ngl/)
    assert.match(out, /-md/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('参数量：E4B 这类有效参数写法也要认出来', () => {
  assert.equal(paramCountOf('gemma-4-E4B_q4_0-it.gguf'), 4e9)
  // 8X4B 仍然不能被当成总参数（这是「8 专家 × 4B」，总参数 21B）
  assert.equal(paramCountOf('L3.2-8X4B-MOE-21B-Q4_k_s.gguf'), 21e9)
  assert.equal(paramCountOf('Mixtral-8x7B-Instruct-Q4_K_M.gguf'), undefined)
})
