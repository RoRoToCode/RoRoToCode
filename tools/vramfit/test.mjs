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
  setLocale, getLocale, detectLocale, t, dictStats, bothLangs, labelWidth, assumptionsList, localeOf
} from './core/index.mjs'
import { appleWorkingSet } from './cli/hardware.mjs'


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

// ───────────────────────── 显存预算 ─────────────────────────

test('8G 卡上的 Gemma3-4B：128K 原生上下文应该装得下（修复前会算成 19 GB）', () => {
  const r = assess(gemma3, hw8)
  assert.equal(r.best?.ctx, 131072)
  assert.ok(r.best.need / GB < 6, `预算明显偏高：${(r.best.need / GB).toFixed(2)} GB`)
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

test('显存上限：Windows 可驱逐，Linux 只能按当前可用算', () => {
  const g = { totalBytes: 8 * GB, usedBytes: 6 * GB }

  const win = vramCeiling({ ...g, platform: 'win32' })
  assert.ok(win.limit / GB > 7, `Windows 应接近总显存：${(win.limit / GB).toFixed(2)}`)
  assert.ok(win.reclaimable / GB > 5, 'Windows 上那部分是可驱逐的，报告要写明')

  // 8G 卡已占 6G，Linux 只剩 2G。修复前这里也走 max(free, total*0.94)，报 7.52 → 必然 OOM
  const lin = vramCeiling({ ...g, platform: 'linux' })
  assert.ok(Math.abs(lin.limit / GB - 2 * 0.92) < 1e-9, `Linux 上限应是可用显存的 92%：${lin.limit / GB}`)
  assert.equal(lin.reclaimable, 0)
  assert.ok(lin.limit < win.limit)
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
  assert.equal(Math.round(TUNING.overheadBytes / 1024 / 1024), 200)
  assert.equal(KV_BYTES_PER_ELEM.f16, 2)
  assert.equal(KV_BYTES_PER_ELEM.q8_0, 1.0625)
})

test('参数与假设：assess 用到的比例和图里写的一致', () => {
  // 混着用两套数字是最难查的 bug：报告说按 92% 算，代码按 94% 算，谁都不报错。
  const g8 = { totalBytes: 8 * GB, usedBytes: 0 }
  const lin = vramCeiling({ ...g8, platform: 'linux' })
  assert.equal(lin.limit, 8 * GB * TUNING.freeFactor)
  const win = vramCeiling({ ...g8, platform: 'win32' })
  assert.equal(win.limit, Math.max(8 * GB * TUNING.wddmFreeFactor, 8 * GB * TUNING.wddmTotalFactor))
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
