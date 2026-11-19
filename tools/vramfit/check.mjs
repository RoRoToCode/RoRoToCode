#!/usr/bin/env node
/**
 * vramfit —— 单文件 GGUF 体检工具
 *
 * 回答一个问题：这个 GGUF 在你这块显卡上，到底能不能被 coding agent 用起来？
 *
 * 只读 GGUF 头部的元数据区（通常几百 KB），不会把几 GB 的模型读进内存。
 *
 * 用法：
 *   node check.mjs model.gguf
 *   node check.mjs models/*.gguf          # 批量
 *   node check.mjs --json model.gguf      # 机器可读
 *   node check.mjs --no-color model.gguf
 *   node check.mjs --lang en model.gguf   # 英文报告
 *   （Windows 下可直接把 .gguf 拖到 check.cmd 上）
 *
 * 判定分级：报告里每一条都标了是「读到的」还是「算出来的」，不混合。
 * 界面文案在 core/i18n.mjs：--lang > VRAMFIT_LANG > 系统 locale > 兜底中文。
 * 只显示一种语言，不做中英并排 —— 标签列只有 12 个显示宽，并排会把表撑歪。
 */

import { promises as fs } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

// 解析、判定、参数全部来自 core —— 那一层同时跑在浏览器里，不许有 IO。
import {
  parseGguf, normalizeUrl, stripControl, FILE_TYPE,
  cleanPasted, parseHfInput,
  normalizeArgv, parseOptions, VALUE_FLAGS, setMirror, getMirror, DEFAULT_MIRROR,
  quantFromName, shardInfo, totalWeightsBytes, paramCountOf,
  quantRank, quantTier, repoVerdict,
  GB, TUNING, ASSUMPTIONS, KV_BYTES_PER_ELEM, fmtSize, speedCapFor,
  vramCeiling, attentionInterval, kvLayers, fullLayerFraction, isHybridSwa, isMla, kvBytes,
  analyzeTemplate, assess, mergedHardware, attentionReport, verdictOf, headlineOf, launchArgsOf,
  t, setLocale, getLocale, detectLocale, labelWidth, assumptionsList, localeOf
} from './core/index.mjs'

// 远端读取走 net/ —— 那一层同样跑在浏览器里，只用 fetch + Range
import { fetchGguf, listRepoGgufs } from './net/hf.mjs'

// 本机硬件探测是 Node 专属的，网页端靠查表，所以单独一层
import { makeHardware } from './cli/hardware.mjs'

// repo 模式的重试分支要等几秒（见下方 retryAt）。这个 helper 原先只在
// net/hf.mjs 里定义，模块作用域不共享，于是「某些量化抓取失败」时会抛
// "sleep is not defined"，把整轮输出吞掉 —— 表现就是 repo 模式偶尔完全没结果。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 版本门槛放在最前面：Node 16 及更早没有全局 fetch，跑起来会死在
// "fetch is not defined" 这种和真实原因无关的报错上，用户根本想不到是版本问题。
{
  const major = Number(process.versions.node.split('.')[0])
  if (major < 18) {
    console.error('')
    console.error(`  ${t('x.nodeOld', { ver: process.versions.node })}`)
    console.error('')
    console.error(`  ${t('x.nodeOldWhy')}`)
    console.error(`  ${t('x.nodeOldFix')}`)
    console.error('')
    process.exit(1)
  }
}

// 版本号写死在这里，由 test.mjs 对着 package.json 校验 —— 单文件 bin 不去读包元数据，
// 少一次文件系统访问，也避免 npx 缓存目录里包结构变了就崩。
const VERSION = '1.0.4'

// ───────────────────────────── GGUF 解析 ─────────────────────────────




/**
 * 读 GGUF 元数据。失败抛错，由调用方给出可读提示。
 * 支持本地路径和 http(s) 地址。
 */
export async function readGguf(file) {
  // 远端交给 net/hf.mjs —— 网页端走的是同一个函数
  if (/^https?:\/\//i.test(file)) return fetchGguf(normalizeUrl(file))

  const fh = await fs.open(file, 'r')
  try {
    const { size } = await fh.stat()
    // 解析全在 core 里，这里只负责把本地文件打开成读取器
    return await parseGguf(fh, size, file)
  } finally {
    await fh.close().catch(() => undefined)
  }
}

// ───────────────────────────── 输出 ─────────────────────────────

const useColor = process.stdout.isTTY && !process.argv.includes('--no-color') && !process.env.NO_COLOR
// 老 conhost / 日志文件里方框绘制字符会变乱码。--ascii 全退回 ASCII
let asciiOnly = process.argv.includes('--ascii')
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[90m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', blue: '\x1b[34m', magenta: '\x1b[35m'
}
const paint = (s, ...cs) => useColor ? `${cs.map((c) => C[c]).join('')}${s}${C.reset}` : String(s)


const fmtGB = (b) => `${(b / GB).toFixed(2)} GB`
const fmtNum = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : String(n)
const fmtCtx = (n) => n >= 1024 ? `${n / 1024}K` : String(n)


function bar(ratio, width = 24) {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)))
  // --ascii：方块字符在旧 conhost / 日志文件里会变成乱码，退回 # 和 -
  return (asciiOnly ? '#' : '█').repeat(filled) + (asciiOnly ? '-' : '░').repeat(width - filled)
}

function render(meta, hw, result, opts = {}) {
  const L = []
  const { gpu, weights, overhead, freeVram, limit, rows, best, weightsFit, moe } = result
  /** 看图开销：主报告的档位不含它，只在预算区单列一行，并给出「带图时建议几 K」 */
  const vision = opts.extra?.bytes > 0 ? opts.extra : null
  const visionFit = opts.visionFit ?? null
  const quant = quantFromName(meta.file)
  const ftype = meta.fileType !== undefined ? FILE_TYPE[meta.fileType] : undefined
  const params = paramCountOf(meta.file, meta.paramCount)
  const tpl = analyzeTemplate(meta.chatTemplate)
  const shard = shardInfo(meta.file)

  // 合并评估：多卡机器额外给一份「按层切分、显存合计」的结论。
  // 提前算是因为抬头结论和启动参数都要用它 —— 单卡放不下时，
  // 不给用户一句「合起来可以」，他就会去换更小的量化，而其实不用。
  const mg = mergedHardware(hw)
  const mergedResult = mg.merged
    ? assess(meta, mg.hw, {
      kvType: opts.kvType,
      weightsBytes: opts.weightsBytes ?? totalWeightsBytes(meta),
      extraBytes: opts.extra?.bytes ?? 0,
      budget: opts.budget ?? 'static'
    })
    : null
  /** 合并后是否真的能跑：权重进得去，且至少一档上下文放得下 */
  const mergedViable = Boolean(mergedResult?.estimated && mergedResult.weightsFit && mergedResult.best)
  /** 单卡侧是否已经能跑（含 MoE 专家 offload 到内存这种「能跑但要降速」） */
  const singleViable = Boolean(result.estimated && result.best) || Boolean(result.moe?.canOffload)
  /**
   * 单卡只能「专家放内存」时，合并全放显存往往快好几倍（内存 50 GB/s vs 显存 450）。
   * 这时候报告末尾那条「启动参数建议」必须给合并的那套 —— 用户永远只抄最后一段，
   * 给他一条 12 tok/s 的命令而 74 tok/s 就写在上面几行，等于白算。
   */
  const mergedSpeed = mergedResult?.speed?.onVram
  const preferMerged = Boolean(
    mergedViable && result.moe?.canOffload && Number.isFinite(mergedSpeed) &&
    (!Number.isFinite(result.speed?.onRam) || mergedSpeed > result.speed.onRam * 1.15)
  )

  // ── 版式约定：全报告只有这一套，任何一行都落在栅格上
  //   小节标题   2 空格 + 粗体，前面空一行
  //   一组数据   4 空格 + 标签列 + 值（值永远从同一列开始）
  //   续行说明   对齐到值那一列，灰色
  //   颜色只表示含义：青 = 结论真正在用的数字，绿/黄/红 = 状态，
  //                   灰 = 解释和算式，白 = 普通事实。装饰性上色一律不用。
  //
  // 标签列宽跟着语言走：中文 6 个字 = 12 列，英文单词更长要 14。
  // 写死 12 的话 "Native ctx" 会把值挤到下一列，整张表歪掉。
  const LW = labelWidth()
  // 标签正好占满列宽时 dpad 不会补空格，值会直接贴上去（"部分 offload约 12 tok/s"）。
  // 宁可这一行多一列，也不能让两个词粘成一个。
  const row = (label, value) =>
    `    ${paint(dpad(label, LW) + (dwidth(label) >= LW ? ' ' : ''), 'dim')}${value}`
  const note = (text) => `    ${' '.repeat(LW)}${paint(text, 'dim')}`
  // 块标题（✗ 装不下 / ? 算不出来）下面的说明：只缩一个层级，
  // 不能按值列对齐 —— 那是给「标签—值」用的，套到整段说明上会悬在半空
  const sub = (text) => `      ${paint(text, 'dim')}`
  const drow = (label, text) => `    ${paint(dpad(label, LW), 'dim')}${paint(text, 'dim')}`
  const section = (title) => { L.push(''); L.push(`  ${paint(title, 'bold')}`) }
  const cyan = (s) => paint(s, 'cyan')
  // 老 conhost / 重定向到日志文件时，方框绘制字符会变成乱码。--ascii 统一退回 ASCII
  const g = (u, a) => (asciiOnly ? a : u)
  const rule = g('═', '=').repeat(55)
  const dot = paint(` ${g('·', '-')} `, 'dim')
  // 上下文档位表的「上下文」列：英文 Context 比中文两个字宽，列宽要放
  const CTX_W = getLocale() === 'en' ? 8 : 6

  // ── 抬头
  L.push('')
  L.push(paint(`  ${rule}`, 'dim'))
  L.push(`  ${paint(t('r.title'), 'bold')}`)
  L.push(paint(`  ${rule}`, 'dim'))

  // ── 一句话结论：先回答「这东西我能不能用」，后面所有数字都是支撑它的证据
  // 免责压成一行小字：它很重要，但不是用户第一眼想知道的事，也不该出现两遍。
  const hd = headlineOf(meta, result)
  const tone = { good: 'green', warn: 'yellow', bad: 'red' }[hd.level] ?? 'yellow'
  const mark = { good: g('✓', '+'), warn: g('△', '~'), bad: g('✗', 'x') }[hd.level] ?? '?'
  L.push('')
  L.push(`  ${paint(`${mark} ${hd.title}`, tone, 'bold')}`)
  L.push(`    ${hd.why}`)
  // 单卡结论说「跑不动」时，多卡机器必须立刻告诉用户「合起来其实可以」，
  // 否则他会按第一行去换模型或换卡，而机器本来就够。
  if (mergedViable && !singleViable) {
    L.push(`    ${paint(t('r.mergedHint', { n: mg.gpus, c: fmtCtx(mergedResult.best.ctx) }), 'cyan', 'bold')}`)
  } else if (mergedViable && result.moe?.canOffload) {
    // 专家放内存能跑，但合并后是全显存 —— 后者更快，值得在结论处就指出来
    L.push(`    ${paint(t('r.mergedHintMoe', { n: mg.gpus, c: fmtCtx(mergedResult.best.ctx) }), 'cyan', 'bold')}`)
  }
  L.push(`    ${paint(t('r.disclaimer'), 'dim')}`)

  // ── 附加件（视觉投影件 / 推测解码草稿）：不是能独立加载的模型。
  // 它们没有 KV cache、也没有可评估的上下文档位，硬套主报告的显存/速度段
  // 只会输出一堆空表和「算不出来」。这里给一份只讲「怎么配、额外占多少」的短报告。
  if (meta.isVision || meta.isAssistant) {
    const kind = meta.isVision ? 'vision' : 'draft'
    const extra = (meta.sizeBytes ?? 0) + (meta.isVision ? TUNING.visionOverheadBytes : 0)
    section(t('s.model'))
    L.push(row(t('f.file'), stripControl(path.basename(meta.file))))
    L.push(row(t('f.size'), `${fmtGB(meta.sizeBytes)}${meta.tensorCount
      ? paint(t('f.tensors', { n: meta.tensorCount }), 'dim')
      : ''}`))
    L.push(row(t('f.kind'), t(`a.${kind}.kind`)))
    if (meta.arch) L.push(row(t('f.arch'), stripControl(meta.arch)))
    section(t('s.attach'))
    if (opts.pair) L.push(row(t('f.pair'), stripControl(opts.pair)))
    L.push(row(t('f.attachFlag'), cyan(t(`a.${kind}.flag`))))
    L.push(note(meta.isVision
      ? t('a.extra.vision', {
        s: fmtGB(extra), w: fmtGB(meta.sizeBytes), o: fmtGB(TUNING.visionOverheadBytes)
      })
      : t('a.extra.draft', { s: fmtGB(extra) })))
    L.push(note(t(meta.isVision ? 'a.vision.noKv' : 'a.draft.note')))
    if (!opts.pair) L.push(note(t('a.noPair')))
    L.push('')
    return L.join('\n')
  }

  // ── 模型
  section(t('s.model'))
  L.push(row(t('f.file'), stripControl(path.basename(meta.file))))
  // 张量数缺省时不要留下未替换的 {n}（合成/残缺 GGUF 会走到这里）
  L.push(row(t('f.size'), `${fmtGB(meta.sizeBytes)}${meta.tensorCount
    ? paint(t('f.tensors', { n: meta.tensorCount }), 'dim')
    : ''}`))
  if (shard && shard.total > 1) {
    L.push(note(t('f.shard', { i: shard.index, t: shard.total, size: fmtGB(totalWeightsBytes(meta)) })))
  }
  L.push(row(t('f.arch'), `${meta.arch ? stripControl(meta.arch) : paint(t('common.unknown'), 'yellow')}` +
    (params ? paint(t('f.params', { p: fmtNum(params) }), 'dim') : '')))
  L.push(row(t('f.quant'), `${quant ?? paint(t('common.unknown'), 'yellow')}` +
    (ftype && ftype !== quant ? paint(t('f.ftype', { t: ftype }), 'dim') : '')))
  if (meta.contextLength) {
    L.push(row(t('f.nativeCtx'), `${fmtCtx(meta.contextLength)} tokens` +
      (meta.slidingWindow ? paint(t('f.sliding', { n: fmtCtx(meta.slidingWindow) }), 'dim') : '')))
  }

  const shape = []
  if (meta.blockCount) {
    const realLayers = Math.max(1, meta.blockCount - (meta.nextnLayers ?? 0))
    shape.push(t('f.layers', { n: meta.blockCount }) + (meta.nextnLayers ? t('f.mtp', { m: meta.nextnLayers }) : ''))
    shape.push(t('f.heads', { h: meta.headCount ?? '?', kv: meta.headKv ?? '?' }))
    if (meta.embdLength) shape.push(t('f.hidden', { n: meta.embdLength }))
    // MLA 也有 head_kv < head_count，但它省显存靠的是潜向量压缩，不是 GQA 分组，
    // 标成 GQA 会误导（真正的机制由下面单独一行说明）
    const gqa = !isMla(meta) && meta.headKv && meta.headCount && meta.headKv < meta.headCount
    L.push(row(t('f.structure'), shape.join(dot) + (gqa ? paint(t('f.gqa'), 'dim') : '')))
    const kl = kvLayers(meta)
    const ai = attentionInterval(meta)
    if (kl && kl < realLayers) {
      L.push(row(t('f.attention'), t('f.kvLayers', { kl, rl: realLayers })))
      // 两种来源要说清：逐层 head_count_kv 直接给了「哪几层带 KV」（LFM2/3 这类
      // 卷积与注意力交替的架构），还是按 full_attention_interval 推出来的。
      // 前者 interval 恒为 1，套「每 1 层 1 层 full attention」会变成一句废话。
      L.push(note(meta.kvLayerCount
        ? t('f.mixedPerLayer')
        : t('f.mixedNote', {
          how: ai.inferred
            ? t('f.mixedInferred', { i: ai.interval })
            : t('f.mixedExplicit', { i: ai.interval })
        })))
    }
  }
  // MLA（DeepSeek V3/R1）：KV 压成潜向量，和同规模 GQA 差一个量级，必须单独说清，
  // 否则用户会以为这张卡连 32K 都开不了（实际 KV 只有普通公式的 1/2 左右）。
  if (isMla(meta)) {
    const kRow = (meta.keyLength ?? 0) > 0
      ? meta.keyLength
      : (meta.kvLoraRank ?? 0) + (meta.ropeDimCount ?? 0)
    L.push(row(t('f.mla'), t('f.mlaDetail', {
      r: meta.kvLoraRank ?? '?', p: meta.ropeDimCount ?? '?', t: kRow
    })))
  }
  // MoE：专家总数、每 token 激活数（KV 缺字段时显示 ?）、文件名标注的激活参数
  if (moe) {
    const detail = t('f.moeExperts', { n: moe.experts, u: moe.used ?? '?' }) +
      (moe.activeParamsB ? paint(t('f.moeParams', { p: moe.activeParamsB }), 'dim') : '')
    L.push(row(t('f.moe'), detail))
  }

  // ── 硬件
  section(t('s.hw'))
  // 多卡机器先把所有探测到的卡列出来，再详细展开本次评估针对的那张。
  // 以前只显示 gpus[0]，用户明明插了两块卡却以为 vramfit 只认出一块。
  const allGpus = (hw?.gpus ?? []).filter((x) => x && (x.totalBytes ?? 0) > 0)
  if (allGpus.length > 1) {
    L.push(row(t('f.gpuCount', { n: allGpus.length }), ''))
    allGpus.forEach((x, i) => {
      const tag = t('f.gpuOf', { i: i + 1, n: allGpus.length })
      const be = { cuda: 'CUDA', rocm: 'ROCm', vulkan: 'Vulkan', metal: 'Metal' }[x.backend] ?? t('f.backendPending')
      const bw = x.bandwidthGBps ? t('f.bw', { n: x.bandwidthGBps }) : t('f.bwUnknown')
      const selected = gpu && x.name === gpu.name ? `  ${paint(t('f.current') ?? '←', 'cyan')}` : ''
      L.push(drow(tag, `${stripControl(x.name)} · ${fmtGB(x.totalBytes)} · ${be} · ${bw}${selected}`))
    })
  }
  if (gpu) {
    const backend = { cuda: 'CUDA', rocm: 'ROCm', vulkan: 'Vulkan', metal: 'Metal' }[gpu.backend] ?? t('f.backendPending')
    const bits = [backend]
    if (gpu.driver) bits.push(t('f.driver', { v: gpu.driver }))
    if (gpu.bandwidthGBps) bits.push(t('f.bw', { n: gpu.bandwidthGBps }))
    else bits.push(t('f.bwUnknown'))
    if (allGpus.length > 1) {
      // 上面那张清单已经把卡名、容量、后端、带宽都写过了，
      // 这里再抄一遍只是噪音 —— 只补清单里没有的驱动版本。
      if (gpu.driver) L.push(note(t('f.driver', { v: gpu.driver })))
    } else {
      L.push(row(t('f.gpu'), stripControl(gpu.name)))
      L.push(note(bits.join(g(' · ', ' | '))))
    }
    const used = gpu.usedBytes ?? 0
    const usedRatio = gpu.totalBytes ? used / gpu.totalBytes : 0
    if (gpu.unified) {
      L.push(row(t('f.vramAsGpu'), cyan(fmtGB(gpu.maxWorkingSetBytes ?? gpu.totalBytes))))
      L.push(note(t('f.physRam', { size: fmtGB(gpu.totalBytes) })))
    } else if (gpu.shared) {
      L.push(row(t('f.vramUsable'), `${cyan(fmtGB(gpu.totalBytes))}${paint(t('f.sharedNote'), 'dim')}`))
      if (used > 0) L.push(note(t('f.used', { size: fmtGB(used) })))
    } else {
      L.push(row(t('f.vram'), `${fmtGB(gpu.totalBytes)} ${t('f.totalSuffix')}${dot}` +
        `${t('f.used', { size: fmtGB(used) })}${dot}${cyan(fmtGB(freeVram))} ${t('f.freeSuffix')}`))
      if (used > 0) {
        const b = bar(usedRatio)
        L.push(`    ${' '.repeat(LW)}${paint(b, usedRatio > 0.7 ? 'yellow' : 'dim')}` +
          `  ${paint(t('f.usedPct', { p: (usedRatio * 100).toFixed(0) }), 'dim')}`)
      }
    }
  } else {
    L.push(row(t('f.gpu'), paint(t('f.gpuNone'), 'yellow')))
    L.push(note(t('f.gpuNoneNote')))
  }
  // 硬件对象可能来自调用方（测试、第三方集成），缺字段时写「未知」而不是 undefined
  L.push(row(t('f.ram'), hw.ramBytes > 0 ? fmtGB(hw.ramBytes) : t('common.unknown')))
  L.push(row(t('f.cpu'), hw.cpu ? stripControl(hw.cpu) : t('common.unknown')))

  // ── 显存预算
  section(result.onCpu ? t('s.budgetRam') : t('s.budgetVram'))
  L.push(row(t('f.weights'), fmtGB(weights) +
    (shard && shard.total > 1 ? paint(t('f.weightsShard'), 'dim') : '')))
  L.push(row(t('f.overhead'), `${fmtSize(overhead)}${paint(t('f.overheadNote'), 'dim')}`))
  /**
   * 看图开销单独一行：它和「运行时开销」不是一回事 —— 不挂投影器就没有这一项，
   * 但一旦发图片挂上，就是「32K 能跑」和「一发图就 OOM」之间的差。
   */
  if (vision) {
    const vBest = visionFit?.best?.ctx ?? null
    L.push(row(t('f.vision'), `+${fmtSize(vision.bytes)}` +
      paint(t('f.visionNote', { f: fmtSize(vision.weights) }), 'dim') +
      paint(' · ', 'dim') +
      (vBest
        ? paint(t('f.visionCtx', { c: fmtCtx(vBest) }), 'yellow')
        : paint(t('f.visionNoFit'), 'yellow'))))
  }
  L.push(row(t('f.ceiling'), cyan(fmtGB(limit))))
  const basisNote = {
    wddm: () => (result.reclaimable > 0.3 * GB
      ? t('f.basis.wddmReclaim', { n: fmtGB(result.reclaimable) })
      : t('f.basis.wddm', { p: Math.round((1 - TUNING.wddmTotalFactor) * 100) })),
    'wddm-unknown': () => t('f.basis.wddmUnknown', { p: Math.round(TUNING.wddmUnknownBudgetFactor * 100) }),
    free: () => t('f.basis.free', { p: Math.round((1 - TUNING.freeFactor) * 100) }),
    static: () => t('f.basis.static', { p: Math.round(TUNING.wddmTotalFactor * 100) }),
    unified: () => t('f.basis.unified', { p: Math.round((1 - TUNING.unifiedReserve) * 100) }),
    ram: () => t('f.basis.ram', { p: Math.round(TUNING.ramFactor * 100) })
  }[result.limitBasis]
  if (basisNote) L.push(note(basisNote()))

  if (isHybridSwa(meta)) {
    const layers = kvLayers(meta)
    const full = Math.max(1, Math.round(layers * fullLayerFraction(meta.arch)))
    L.push(note(t('f.swaLine', { full, swa: layers - full, w: fmtCtx(meta.slidingWindow) })))
    L.push(note(t('f.swaNote') + (meta.keyLengthSwa ? '' : t('f.swaNote2'))))
  } else if (meta.slidingWindow) {
    L.push(note(t('f.slidingOnly', { w: fmtCtx(meta.slidingWindow) })))
  }
  /**
   * 别的程序占着显存时说一句 —— 但静态口径下这句话不能再说成「所以预算变小了」：
   * 结论明明是按总容量算的，再配一句「被占用了」会让人以为上面的上限已经扣过。
   * 静态口径下它的含义变成「你并没有独占这张卡，真跑起来会掉速甚至失败」。
   */
  if (gpu && !gpu.unified && !gpu.shared && (gpu.usedBytes ?? 0) > 1.5 * GB) {
    const key = result.limitBasis === 'static' ? 'f.usedWarnStatic' : 'f.usedWarn'
    L.push(`    ${' '.repeat(LW)}${paint(t(key, { n: fmtGB(gpu.usedBytes) }), 'yellow')}`)
  }

  if (!result.estimated) {
    // 元数据缺层数 / head / 隐层维度：不是装不下，是算不出来。两者给的建议完全不同。
    L.push('')
    L.push(`    ${paint(t('b.cantEstimate'), 'yellow', 'bold')}`)
    L.push(sub(t('b.cantEstimate1')))
    L.push(sub(t('b.cantEstimate2')))
    L.push(sub(t('b.cantEstimate3')))
  } else if (!weightsFit) {
    L.push('')
    L.push(`    ${paint(t('b.noFit'), 'red', 'bold')}`)
    L.push(sub(t('b.noFitLine', {
      w: fmtGB(weights),
      o: fmtSize(overhead),
      sum: cyan(fmtGB(weights + overhead)),
      limit: cyan(fmtGB(limit))
    })))
    if (moe?.canOffload) {
      // MoE 能 offload 专家，就不说 dense 那套「慢 3–10 倍」——会吓退用户去换模型
      L.push(sub(t('b.moeFitsViaOffload')))
    } else if (gpu && limit < 1 * GB) {
      L.push(sub(t('b.noFitVramFull')))
    } else {
      L.push(sub(result.onCpu
        ? t('b.noFitRam')
        : gpu?.unified
          ? t('b.noFitUnified')
          : t('b.noFitDiscrete')))
    }
    // MoE 的关键区别：显存装不下 ≠ 跑不了。专家可 offload 到系统 RAM，
    // 门槛是显存 + RAM 合计。把这条说明紧跟在「装不下」下面，否则用户会误换模型。
    if (moe) {
      L.push('')
      L.push(sub(paint(moe.combinedFit
        ? t('b.moeCombinedOk', {
          ram: fmtGB(moe.usableRam),
          supply: fmtGB(moe.supplyBytes),
          need: fmtGB(moe.needBytes),
          n: moe.offloadLayers
        })
        : t('b.moeCombinedBad', {
          supply: fmtGB(moe.supplyBytes),
          need: fmtGB(moe.needBytes)
        }), moe.combinedFit ? 'green' : 'red', 'bold')))
      L.push(sub(t('b.moeOffloadNote')))
    }
  } else {
    // 表头和数据行同一套列宽：上下文右对齐、体积右对齐 10、进度条 20
    L.push('')
    L.push(`    ${paint(dpad(t('t.ctx'), CTX_W, 'right'), 'dim')}  ` +
      `${paint(dpad(t('t.need'), 10, 'right'), 'dim')}  ${paint(t('t.share'), 'dim')}`)
    for (const r of rows) {
      if (r.need === null) {
        L.push(`    ${dpad(fmtCtx(r.ctx), CTX_W, 'right')}  ${paint(t('t.cantEst'), 'dim')}`)
        continue
      }
      const mark2 = r.beyondNative
        ? paint(g('⚠', '!'), 'yellow')
        : r.fits ? (r.tight ? paint(g('△', '~'), 'yellow') : paint(g('✓', '+'), 'green')) : paint(g('✗', 'x'), 'red')
      const ratio = Math.min(1, r.need / (limit || 1))
      const barPaint = r.beyondNative ? 'dim' : r.fits ? (r.tight ? 'yellow' : 'green') : 'red'
      const tail = r.beyondNative ? paint(t('t.beyond'), 'yellow')
        : r.tight ? paint(t('t.tight'), 'yellow') : ''
      L.push(`    ${dpad(fmtCtx(r.ctx), CTX_W, 'right')}  ` +
        `${dpad(fmtGB(r.need), 10, 'right')}  ${paint(bar(ratio, 20), barPaint)} ${mark2}${tail}`)
    }
    L.push('')
    if (best) {
      L.push(row(t('t.bestCtx'), `${paint(fmtCtx(best.ctx), best.tight ? 'yellow' : 'cyan', 'bold')}` +
        paint(t('t.bestCtxNote', { need: fmtGB(best.need), limit: fmtGB(limit) }), 'dim')))
      // 表格里那一行有「△ 接近上限」，但结论行才是用户真正会照抄的数字。
      // 99% 占用在 8 GB 卡上基本等于「启动就 OOM」，不能只在表格里标个小三角。
      if (best.tight) L.push(sub(t('t.bestTight')))
      if (meta.contextLength && best.ctx < meta.contextLength) {
        L.push(sub(t('t.canGoHigher', { n: fmtCtx(meta.contextLength) })))
      }
    } else if (rows.every((r) => r.beyondNative)) {
      L.push(`    ${paint(t('t.nativeShort'), 'yellow', 'bold')}`)
      L.push(sub(t('t.nativeShortNote', { n: fmtCtx(meta.contextLength) })))
    } else {
      L.push(`    ${paint(t('t.minNoFit'), 'red', 'bold')}`)
      L.push(sub(result.onCpu ? t('t.minNoFitRam') : t('t.minNoFitVram')))
    }
  }

  // ── 模板 / 工具调用
  section(t('s.agent'))
  if (!meta.chatTemplate) {
    L.push(`    ${paint(t('a.noTpl'), 'red', 'bold')}`)
    L.push(note(t('a.noTpl1')))
    L.push(note(t('a.noTpl2')))
  } else {
    const sizeKB = (Buffer.byteLength(meta.chatTemplate, 'utf8') / 1024).toFixed(1)
    L.push(row(t('a.tpl'), `${sizeKB} KB` +
      (meta.templateVariants?.length ? paint(t('a.tplVariants', { list: meta.templateVariants.join(', ') }), 'dim') : '')))
    for (const n of tpl.notes) {
      L.push(`    ${' '.repeat(LW)}${n.ok ? paint(g('✓', '+'), 'green') : paint(g('·', '-'), 'yellow')} ` +
        paint(n.text, 'dim'))
    }
    const verdict = {
      strong: [t('a.strong'), 'green', t('a.strongNote')],
      partial: [t('a.partial'), 'yellow', t('a.partialNote')],
      weak: [t('a.weak'), 'yellow', t('a.weakNote')],
      none: [t('a.none'), 'red', t('a.noneNote')]
    }[tpl.level]
    L.push(row(t('a.toolUse'), paint(verdict[0], verdict[1], 'bold')))
    L.push(note(verdict[2]))
  }

  // ── 生成速度
  if (result.speed) {
    const sp = result.speed
    // 封顶与公式都用速度口径的权重（MoE = 激活权重），否则显示「÷ 5.78GB」却给出按
    // 0.18GB 算的速度，用户对不上。basisBytes 由 core 算出，三端共用同一个数。
    const speedBytes = sp.basisBytes ?? weights
    const gb = speedBytes / 1e9
    const cap = speedCapFor(speedBytes)
    section(t('s.speed'))
    const formula = () => note(t('v.formula', { bw: sp.bandwidth, gb: gb.toFixed(2), eff: sp.efficiency }))
    if (sp.cpu) {
      // 没有可用显卡：只走内存，带宽就是系统内存带宽。同一套公式，慢一个量级
      L.push(row(t('v.cpu'), sp.onRam ? paint(t('v.about', { n: sp.onRam.toFixed(0) }), 'yellow', 'bold') : t('v.unknown')))
      if (sp.onRam) formula()
      L.push(note(t('v.buyGpu')))
    } else if (gpu?.unified) {
      // 统一内存：CPU 和 GPU 同一块内存，不存在「放不下就 offload」，带宽本来就是内存带宽
      const v = sp.onVram
      L.push(row(t('v.unified'), v > cap
        ? `${paint(t('v.under', { n: cap }), 'green', 'bold')}${paint(t('v.capNote'), 'dim')}`
        : paint(t('v.about', { n: v.toFixed(0) }), 'green', 'bold')))
      if (!(v > cap)) formula()
      L.push(note(t('v.unifiedNote')))
    } else if (weightsFit && best) {
      // 小模型上公式会失效：每 token 的 kernel launch、采样、传输是固定开销，
      // 不可能随权重变小无限加速。2 GB 以下封顶，并且明说公式值不可信
      const v = sp.onVram
      L.push(row(t('v.allVram'), v > cap
        ? `${paint(t('v.under', { n: cap }), 'green', 'bold')}${paint(t('v.capNote'), 'dim')}`
        : paint(t('v.about', { n: v.toFixed(0) }), 'green', 'bold')))
      if (!(v > cap)) formula()
    } else if (weightsFit && !best) {
      // 权重放得下、KV 放不下：必须 offload 掉几层才能腾出上下文空间
      L.push(row(t('v.afterOffload'), sp.onRam ? paint(t('v.about', { n: sp.onRam.toFixed(0) }), 'yellow', 'bold') : t('v.muchSlower')))
      L.push(note(t('v.offloadNote', { bw: hw.ramBandwidthGBps })))
      L.push(note(t('v.offloadNote2', { n: sp.onVram.toFixed(0) })))
    } else {
      L.push(row(t('v.partial'), sp.onRam ? paint(t('v.about', { n: sp.onRam.toFixed(0) }), 'yellow', 'bold') : t('v.unknown')))
      L.push(note(t('v.partialNote', { bw: hw.ramBandwidthGBps })))
      L.push(note(t('v.partialNote2', { n: sp.onVram.toFixed(0) })))
    }
    if (moe) {
      L.push(note(moe.corrected
        ? t('v.moe', { n: moe.experts })
        : t('v.moeUnknown')))
    }
    L.push(note(t('v.bottleneck', { p: TUNING.speedErrorPct })))
  }

  // ── 合并评估：多卡机器额外给一份「按层切分、显存合计」的结论
  // 走和主报告完全相同的 assess()，只是硬件换成合并后的虚拟卡，口径绝不分叉。
  if (mg.merged) {
    section(t('s.merged'))
    L.push(row(t('f.mergedPool'), cyan(fmtGB(mg.hw.gpus[0].totalBytes)) +
      paint(' ' + t('f.mergedCards', { n: mg.gpus }), 'dim')))
    // 合并后能开多大上下文 —— 这是用户真正想知道的「合起来值不值」
    if (mergedResult.estimated) {
      const ok = mergedResult.weightsFit && mergedResult.best
      const ctxText = ok ? fmtCtx(mergedResult.best.ctx) : ''
      // 贴着上限（>85%）时别只写「装得下」：碎片、驱动保留量都可能让它加载失败
      const tight = ok && mergedResult.best.need > mergedResult.limit * TUNING.tightRatio
      L.push(row(t('f.mergedCtx'), ok
        ? paint(t(tight ? 'f.mergedCanTight' : 'f.mergedCan', { c: ctxText }), tight ? 'yellow' : 'green', 'bold')
        : paint(t('f.mergedCant'), 'red', 'bold')))
      if (tight) L.push(note(t('f.mergedTight')))
    }
    // 速度按最弱卡；有一张带宽未知就明说无法可靠估算，不编一个数
    if (mg.bandwidthUnknown || !mergedResult.speed?.onVram) {
      L.push(note(t('f.mergedBwUnknown')))
    } else if (mergedResult.speed.onVram) {
      const cap = speedCapFor(mergedResult.weights)
      const v = mergedResult.speed.onVram
      L.push(row(t('v.allVram'), paint(v > cap
        ? t('v.under', { n: cap })
        : t('v.about', { n: v.toFixed(0) }), 'yellow', 'bold')))
      L.push(note(t('f.mergedBasis', { name: mg.weakestName ?? '?' })))
    }
    // MoE 能把专家塞内存时，合并后全放显存通常更快 —— 与其让用户自己拼旗标，
    // 这里直接给一条能抄的命令。带宽未知时不给速度，但显存/内存的差别是结构性的。
    // preferMerged 时这一段不写命令：报告末尾的「启动参数建议」就是这一套，
    // 同一份报告里出现两条一模一样的命令行，用户会以为是两种方案。
    if (moe?.canOffload && mergedViable && mg.devices?.length && !preferMerged) {
      L.push(row(t('f.mergedLaunch'),
        cyan(`-dev ${mg.devices.join(',')} -sm layer -ngl 999 -c ${mergedResult.best.ctx}`)))
      L.push(note(t('f.mergedFaster')))
    }
    L.push(note(t('f.mergedNote')))
  }

  // ── 启动参数建议：把上面的结论翻译成可照抄的 llama.cpp 旗标。
  // 单卡一档上下文都放不下、但多卡合起来能跑时，给的是合并的那套旗标 ——
  // 只报「-ngl 999」会让人以为单卡就能跑，照着抄必然 OOM。
  const useMerged = mergedViable && (!singleViable || preferMerged)
  const launchSrc = useMerged ? mergedResult : result
  const launch = launchArgsOf(meta, launchSrc, {
    kvType: opts.kvType,
    merged: useMerged ? { devices: mg.devices } : null
  })
  // 单卡、合并都跑不动时不给旗标：给不出能加载的组合，任何旗标都是误导
  const launchUsable = Boolean(launchSrc.best) || Boolean(launchSrc.moe?.canOffload)
  if (launch.length && launchUsable) {
    section(t('s.launch'))
    // 旗标宽度固定 16（盖住最长的 -ngl / --n-cpu-moe），说明从同一列开始。
    // 不能拿它当 label 走 row 的 LW=12/14 —— 旗标比标签长，补不齐就会贴在一起。
    const flagW = 22
    for (const a of launch) {
      L.push(`    ${paint(dpad(a.flag, flagW), 'cyan')}${t(a.whyKey, a.args ?? {})}`)
    }
    L.push(note(t(useMerged ? (preferMerged ? 'la.noteFaster' : 'la.noteMerged') : 'la.note')))
  }

  // ── 参数与假设：结论旁边就写清楚它是怎么算出来的
  const paramHead = t('s.params')
  const barLen = Math.max(6, 51 - dwidth(paramHead))
  L.push('')
  L.push(paint(`  ${g('──', '--')} ${paramHead} ` + g('─', '-').repeat(barLen), 'dim'))
  L.push(drow(t('p.weights'), t(shard && shard.total > 1 ? 'p.weightsValShard' : 'p.weightsVal')))
  L.push(drow(t('p.overhead'), t('p.overheadVal', { n: fmtSize(overhead) })))
  L.push(drow(t('p.kv'), t('p.kvVal', { n: KV_BYTES_PER_ELEM[opts.kvType ?? 'f16'] })))
  L.push(drow(t('p.ceiling'), limitBasisText(result.limitBasis)))
  L.push(drow(t('p.speed'), t('p.speedVal', { e: TUNING.memoryEfficiency, p: TUNING.speedErrorPct })))
  L.push(drow(t('p.threshold'), t('p.thresholdVal', {
    r: TUNING.tightRatio, p: fmtNum(TUNING.minAgentParams), c: fmtCtx(TUNING.minAgentContext)
  })))
  L.push(drow(t('p.fullList'), '--about'))
  L.push('')

  return L.join('\n')
}

/** 一行说明显存上限用的是哪套规则，报告和 --about 共用 */
function limitBasisText(basis) {
  if (basis === 'wddm') return t('lb.wddm', { f: TUNING.wddmFreeFactor, t: TUNING.wddmTotalFactor })
  if (basis === 'wddm-unknown') return t('lb.wddmUnknown', { f: TUNING.wddmUnknownBudgetFactor })
  if (basis === 'free') return t('lb.free', { f: TUNING.freeFactor })
  if (basis === 'static') return t('lb.static', { t: TUNING.wddmTotalFactor })
  if (basis === 'unified') return t('lb.unified', { r: TUNING.unifiedReserve })
  if (basis === 'ram') return t('lb.ram', { r: TUNING.ramFactor })
  return t('lb.other')
}

// ───────────────────────────── 入口 ─────────────────────────────

function usage() {
  const b = (s) => paint(s, 'bold')
  const d = (s) => paint(s, 'dim')
  const y = (s) => paint(s, 'yellow')
  const c = (s) => paint(s, 'cyan')
  // 选项列统一 20 显示宽，说明从同一列开始 —— 中英文都对齐
  const opt = (flag, key) => `    ${dpad(flag, 20)}${t(key)}`
  console.log(`
${paint('vramfit', 'bold', 'cyan')} — ${t('u.tagline')}

  ${b(t('u.fileUsage'))}
  ${b(t('u.repoUsage'))}
  ${d(t('u.interactive'))}

  ${b(t('u.options'))}
${opt('--repo owner/name', 'u.optRepo')}
${opt('-i, --interactive', 'u.optInteractive')}
${opt('--json', 'u.optJson')}
${opt('--no-color', 'u.optNoColor')}
${opt('--ascii', 'u.optAscii')}
${opt('--kv <type>', 'u.optKv')}
${opt('--vram 8', 'u.optVram')}
${opt('--gpu 1', 'u.optGpu')}
${opt('--budget static', 'u.optBudget')}
${opt('--mmproj <file>', 'u.optMmproj')}
${opt('--mirror <url>', 'u.optMirror')}
${opt('--lang zh|en', 'u.optLang')}
${opt('--about', 'u.optAbout')}
${opt('--help', 'u.optHelp')}
${opt('-v, --version', 'u.optVersion')}

  ${d(t('u.eqForm'))}
  ${d(t('u.exitCode'))}

  ${d(t('u.linkHead'))}
${d(t('u.link1'))}
${d(t('u.link2'))}
${d(t('u.link3'))}

  ${d(t('u.shardHint'))}
  ${d(t('u.winHint'))}
  ${d(t('u.npmHint'))}
  ${d(t('u.dragHint'))}
  ${d(t('u.aboutHint'))}${y('--about')}
`)
}

/**
 * 全部参数与假设。用户问「这数怎么来的」时给的是这个，不是一句「仅供参考」。
 * 内容来自 core/assumptions.mjs —— 和 assess() 里真正用的常量是同一份。
 */
function about() {
  const L = []
  const rule = asciiOnly ? '='.repeat(55) : '═'.repeat(55)
  L.push('')
  L.push(paint(`  ${rule}`, 'dim'))
  L.push('  ' + paint(t('s.params'), 'bold', 'cyan') + paint(`   ${t('ab.sub')}`, 'dim'))
  L.push(paint(`  ${rule}`, 'dim'))
  L.push('')
  L.push(paint(`  ${t('ab.disclaimer1')}`, 'yellow', 'bold'))
  L.push(paint(t('ab.disclaimer2'), 'yellow'))
  L.push('')
  for (const g of assumptionsList()) {
    L.push(`  ${paint(g.group, 'bold')}`)
    for (const it of g.items) {
      // 标签列跟着语言走：中文 16 够用，英文最长的 "Sliding-window arch" 有 19 列，
      // 用 16 会让标签和值贴在一起
      const kw = getLocale() === 'en' ? 22 : 16
      L.push(`    ${paint(dpad(it.k, kw), 'cyan')}${it.v}`)
      if (it.note) L.push(paint(`    ${' '.repeat(kw)}${it.note}`, 'dim'))
    }
    L.push('')
  }
  L.push(paint(`  ${t('ab.foot1')}`, 'dim'))
  L.push(paint(`  ${t('ab.foot2')}`, 'dim'))
  L.push('')
  L.push(paint(`  ${t('ab.contact')}`, 'dim'))
  L.push(paint('  https://github.com/RoRoToCode/vramfit/issues', 'cyan') + paint('  ·  su@roroto.com', 'dim'))
  L.push('')
  console.log(L.join('\n'))
}

/** 把一组体检结果排成对比表，回答「这个模型该下哪个量化」 */
function renderRepoTable(repo, rows) {
  const L = []
  const en = getLocale() === 'en'
  // 英文列名和量化质量标签都比中文长，列宽得跟着放，否则表格挤成一团
  const QW = 14
  const CTX_W = en ? 8 : 6
  // 'slightly lossy' 有 14 列 —— 比 13 宽一格就会把后面的结论列推歪
  const QUAL_W = en ? 15 : 10
  const rule = asciiOnly ? '='.repeat(55) : '═'.repeat(55)
  const g = (u, a) => (asciiOnly ? a : u)

  L.push('')
  L.push(paint(`  ${rule}`, 'dim'))
  L.push(`  ${paint(t('rt.title'), 'bold')}${paint('  ' + stripControl(repo), 'dim')}` +
    paint(`   ${t('rt.variants', { n: rows.length })}`, 'dim'))
  L.push(paint(`  ${rule}`, 'dim'))
  L.push('')
  L.push(paint('    ' + dpad(t('rt.q'), QW) + ' ' + dpad(t('rt.size'), 9, 'right') +
    '  ' + dpad(t('rt.ctx'), CTX_W, 'right') + '  ' + dpad(t('rt.speed'), 11) + ' ' +
    dpad(t('rt.quality'), QUAL_W) + '  ' + t('rt.result'), 'dim'))

  const sorted = [...rows].sort((a, b) => quantRank(a.quant) - quantRank(b.quant) || (a.weights ?? 0) - (b.weights ?? 0))

  // 少数文件名里没有量化标记（fp16 / 原始 f32），退回显示文件名，别写个问号
  const labelOf = (r) => {
    const raw = r.quant || quantFromName(r.file ?? '') ||
      String(r.file ?? '').split(/[\\/]/).pop().replace(/\.gguf$/i, '')
    return stripControl(raw).slice(0, QW) || '?'
  }

  for (const r of sorted) {
    if (r.error) {
      // 失败行也占同样的列位，别把表格撑歪
      const short = /网络|超时|连不上|network|timeout|fetch/i.test(r.error)
        ? t('rt.netErr')
        : stripControl(r.error).slice(0, 40)
      L.push(`    ${dpad(labelOf(r), QW)} ${dpad(g('—', '-'), 9, 'right')}  ${dpad(g('—', '-'), CTX_W, 'right')}  ` +
        `${paint(dpad(g('—', '-'), 11), 'dim')} ${dpad(g('—', '-'), QUAL_W)}  ${paint(short, 'red')}`)
      continue
    }
    const ctx = r.best ? fmtCtx(r.best) : g('—', '-')
    const v = repoVerdict(r)
    L.push(`    ${dpad(labelOf(r), QW)} ${dpad(fmtGB(r.weights), 9, 'right')}  ` +
      `${dpad(ctx, CTX_W, 'right')}  ${dpad(spdText(r.onVram, r.weights), 11)} ${dpad(r.qualityLabel, QUAL_W)}  ` +
      paint(v.label, v.color))
  }
  L.push('')

  // 推荐：在「推荐」档里取质量最高的；同一质量档取体积最小的（同样的质量，省显存）
  // 判定用 rank 不用 label —— 按文案筛选的话，换语言推荐行就没了
  const rec = sorted
    .filter((r) => !r.error && repoVerdict(r).rank === 2)
    .sort((a, b) => quantRank(b.quant) - quantRank(a.quant) || (a.weights ?? 0) - (b.weights ?? 0))
  if (rec.length) {
    const pick = rec[0]
    // 没探测到带宽时 onVram 为 null，整段速度信息直接省略，不要写 "undefined tok/s"
    const spd = Number.isFinite(pick.onVram) && pick.onVram > 0 ? ` · ${t('v.about', { n: pick.onVram.toFixed(0) })}` : ''
    L.push(`    ${t('rt.rec')} ${paint(labelOf(pick), 'green', 'bold')}` +
      paint(`   ${t('rt.recNote', { ctx: fmtCtx(pick.best), spd, q: pick.qualityLabel })}`, 'dim'))
    L.push(paint(`    ${t('rt.lowNote')}`, 'dim'))
  } else {
    const failed = sorted.filter((r) => r.error).length
    const near = sorted.filter((r) => !r.error && r.best).sort((a, b) => b.best - a.best)[0]
    if (near) {
      const why = !near.hasTemplate
        ? t('rt.whyNoTpl')
        : !near.toolOk
          ? t('rt.whyNoTools')
          : t('rt.whyShortCtx')
      L.push(paint(`    ${t('rt.none', { q: labelOf(near), why })}`, 'yellow'))
    } else if (failed === sorted.length) {
      // 全部读取失败 ≠ 装不下，这两种情况必须区分开，否则会给出完全错误的结论
      L.push(paint(`    ${t('rt.allFailed')}`, 'red'))
      L.push(paint(`    ${t('rt.allFailed2')}`, 'dim'))
    } else {
      L.push(paint(`    ${t('rt.noneFit')}`, 'red'))
    }
  }
  L.push('')
  L.push(paint(`    ${t('rt.foot')}`, 'dim'))
  L.push('')
  return L.join('\n')
}

/** 并发上限，避免把镜像打限流 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      try { out[i] = await fn(items[i], i) } catch (err) { out[i] = { error: err.message, item: items[i] } }
    }
  })
  await Promise.all(workers)
  return out
}

/** 列出一个 HF 仓库里的所有 gguf 文件。主镜像不通时退到官方 API。 */


/** 显示宽度：中文/全角占两列，padEnd 按码点数会算错，表格会歪 */
const dwidth = (s) => [...String(s)].reduce((n, ch) =>
  n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0)
const dpad = (s, width, align = 'left') => {
  const pad = ' '.repeat(Math.max(0, width - dwidth(s)))
  return align === 'right' ? pad + s : s + pad
}

/** 速度和上下文列：拿不到带宽就不写数字，不然会渲染成 "undefined tok/s"。封顶与 JSON 同源 */
const spdText = (onVram, weightsBytes) =>
  Number.isFinite(onVram) && onVram > 0
    ? `~${Math.min(onVram, speedCapFor(weightsBytes)).toFixed(0)} tok/s`
    : '—'

const isUrlLike = (s) => /^https?:\/\//i.test(s)
// owner/repo 只有两段。排除 ./models、../x 这类相对路径写法，
// 它们的斜杠不是仓库分隔符，猜成 HF 仓库只会给出让人摸不着头脑的报错。
const LOOKS_LIKE_REPO = /^(?!\.)[\w.-]+\/[\w.-]+$/
const shortName = (s) => {
  try { return stripControl(decodeURIComponent(String(s).split('/').pop() || s)) } catch { return stripControl(s) }
}

/**
 * 把用户输入拆成「逐个查的文件」和「整体对比的仓库」。
 * 输入可以是：本地文件、目录、HF/镜像链接、owner/repo。
 *
 * 目录自动递归：LM Studio 的模型放在 models/<publisher>/<repo>/x.gguf，
 * 所以必须递归，否则用户传 models/ 什么也扫不到。
 */
async function expandTargets(raw, opts = {}) {
  const files = []
  const repos = []

  for (const rawTarget of raw) {
    // 从文档 / 聊天窗口复制出来的链接常带引号、尖括号、零宽字符，先洗干净
    const target = cleanPasted(rawTarget)
    if (!target) continue
    const hf = parseHfInput(target)

    if (hf?.kind === 'repo') {
      if (hf.note) console.error(paint(`  ${hf.note}`, 'dim'))
      repos.push(hf.repo)
      continue
    }
    if (hf?.kind === 'file') {
      if (hf.note) console.error(paint(`  ${hf.note}`, 'dim'))
      files.push(hf.url)
      continue
    }
    if (hf?.kind === 'invalid') {
      console.error(paint(`  ${t('x.invalid', { reason: hf.reason, t: stripControl(target) })}`, 'red'))
      continue
    }
    if (isUrlLike(target)) { files.push(normalizeUrl(target)); continue }

    const abs = path.resolve(target)
    let stat = null
    try { stat = await fs.stat(abs) } catch { /* 不存在：下面按「是不是仓库名」再判一次 */ }

    if (!stat || !stat.isDirectory()) {
      // 本地没有这个文件，但形如 owner/repo，基本可以肯定是在说 HF 仓库
      if (opts.guessRepo && !stat && LOOKS_LIKE_REPO.test(target)) {
        console.error(paint(`  ${t('x.envRepo', { t: target })}`, 'dim'))
        repos.push(target)
      } else {
        files.push(target)
      }
      continue
    }

    const found = []
    const walk = async (dir, depth) => {
      if (depth > 6) return
      let entries = []
      try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) await walk(p, depth + 1)
        else if (/\.gguf$/i.test(e.name)) found.push(p)
      }
    }
    await walk(abs, 0)
    if (!found.length) {
      console.error(paint(`  ${t('x.noGguf', { t: target })}`, 'red'))
      continue
    }
    found.sort()
    if (!opts.jsonOut) console.error(paint(`  ${t('x.foundN', { t: target, n: found.length })}\n`, 'dim'))
    files.push(...found)
  }

  return { files, repos }
}

/** 整仓库对比：远程读每个量化的元数据，出一张「该下哪个」的表 */
async function runRepo(repo, { jsonOut = false, kvType = 'f16', hw = makeHardware(), budget = 'static' } = {}) {
  const { urls, sharded } = await listRepoGgufs(repo)
  if (!jsonOut) console.error(paint(`  ${t('x.repoCount', { repo, n: urls.length })}`, 'dim'))

  // 并发压到 3：镜像是按出口 IP 计配额的，开太高很容易 429
  let done = 0
  const total = urls.length

  const checkOne = async (url, quiet = false) => {
    const quant = quantFromName(url)
    try {
      const meta = await readGguf(url)
      // 分片模型按「第 1 片 × 片数」估算整体权重，否则一个 20 GB 的模型会被当成 4 GB
      const totalWeights = totalWeightsBytes(meta)
      const result = assess(meta, hw, { kvType, weightsBytes: totalWeights, budget })
      const tpl = analyzeTemplate(meta.chatTemplate)
      const q = quantTier(quant)
      return {
        file: meta.file,
        quant,
        weights: totalWeights,
        best: result.best?.ctx ?? null,
        onVram: result.speed?.onVram ?? null,
        estimated: result.estimated !== false,
        hasTemplate: !!meta.chatTemplate,
        toolOk: !!(meta.chatTemplate && (tpl.level === 'strong' || tpl.level === 'partial')),
        tier: q.tier,
        qualityLabel: q.label,
        verdict: verdictOf(meta, result)
      }
    } catch (err) {
      // 单个变体失败不影响整张表，但必须标出是哪个量化失败了
      return { file: url, quant, error: err.message }
    } finally {
      done++
      if (!jsonOut && !quiet) process.stderr.write(paint(`\r  ${t('x.progress', { d: Math.min(done, total), t: total })}`, 'dim'))
    }
  }

  const rows = await mapLimit(urls, 3, checkOne)

  // 镜像抖动很常见，而且并发本身会让它更抖。失败的那些隔几秒串行再试一轮，
  // 能把「一半变体显示网络连不上」这种噪音压掉大半。
  const retryAt = rows.map((r, i) => (r?.error ? i : -1)).filter((i) => i >= 0 && i < urls.length)
  if (retryAt.length && retryAt.length < urls.length) {
    if (!jsonOut) process.stderr.write(paint(`\r  ${t('x.retrying', { n: retryAt.length })}        `, 'dim'))
    await sleep(3000)
    for (const [k, i] of retryAt.entries()) {
      if (!jsonOut) process.stderr.write(paint(`\r  ${t('x.retryN', { k: k + 1, n: retryAt.length })}            `, 'dim'))
      const again = await checkOne(urls[i], true).catch((e) => ({ file: urls[i], quant: quantFromName(urls[i]), error: e.message }))
      if (!again?.error) rows[i] = again
    }
  }
  if (!jsonOut) process.stderr.write('\r' + ' '.repeat(30) + '\r')

  if (jsonOut) { console.log(JSON.stringify({ repo, sharded, rows }, null, 2)); return rows }
  console.log(renderRepoTable(repo, rows))
  if (sharded) {
    console.log(paint(`    ${t('rt.shardNote', { n: sharded })}`, 'yellow'))
    console.log('')
  }
  return rows
}

/**
 * 视觉投影器给预算带来的额外占用。
 *
 * 投影器权重按文件字节数算，激活按 assumptions 里的固定值算 —— 两者性质不同：
 * 权重随量化变化，激活只跟分辨率和 batch 有关。返回 0 表示这次按纯文本算。
 */
async function visionExtra(mmproj, { jsonOut = false } = {}) {
  const none = { bytes: 0, weights: 0, overhead: 0 }
  if (!mmproj) return none
  if (isUrlLike(mmproj)) return none
  try {
    const st = await fs.stat(path.resolve(mmproj))
    if (!st.isFile() || st.size <= 0) throw new Error('empty')
    return {
      bytes: st.size + TUNING.visionOverheadBytes,
      weights: st.size,
      overhead: TUNING.visionOverheadBytes
    }
  } catch {
    // 投影器读不到就退回纯文本口径，但必须说一声：静默忽略等于高估可用显存
    if (!jsonOut) console.error(paint(`  ${t('in.p.mmprojBad', { v: shortName(mmproj) })}`, 'yellow'))
    return none
  }
}

/**
 * 给附加件找配对的主模型。
 *
 * mmproj 的命名里本来就有主模型名（`xxx-Q4_K_M-mmproj.gguf` 对应 `xxx-Q4_K_M.gguf`），
 * 草稿件则是加了前缀（`mtp-xxx.gguf` 对应 `xxx.gguf`）。先按命名直接找，找不到
 * 再按「前几段共同词干」在目录里扫一遍 —— 命名不规范时也能给出个候选。
 * 找不到就返回 null，报告里明说「自己挂到实际用的主模型上」，不瞎猜。
 */
async function findPair(file) {
  if (!file || isUrlLike(file)) return null
  const abs = path.resolve(file)
  const dir = path.dirname(abs)
  const base = path.basename(abs)
  const cands = []
  if (/-mmproj\.gguf$/i.test(base)) cands.push(base.replace(/-mmproj\.gguf$/i, '.gguf'))
  if (/^mtp-/i.test(base)) cands.push(base.replace(/^mtp-/i, ''))
  for (const c of cands) {
    try {
      const st = await fs.stat(path.join(dir, c))
      if (st.isFile()) return c
    } catch { /* 继续试下一个 */ }
  }
  // 词干兜底：`mtp-gemma-4-E4B-it-Artemis-Q4_0.gguf` 的实际主模型叫
  // `gemma-4-E4B_q4_0-it.gguf`，名字对不上但前 3 段（gemma-4-E4B）一致
  const stem = base.replace(/^mtp-/i, '').split(/[-_]/).slice(0, 3).join('-')
  if (stem.length < 6) return null
  try {
    const names = await fs.readdir(dir)
    const hit = names.filter((n) => /\.gguf$/i.test(n) && n !== base &&
      !/mmproj/i.test(n) && n.toLowerCase().replace(/[-_]/g, '-').startsWith(stem.toLowerCase()))
    if (hit.length === 1) return hit[0]
  } catch { /* 目录读不到就算了 */ }
  return null
}

/** 逐个文件出报告；返回每一项（含失败项），便于上层决定退出码 */
async function runChecks(files, { jsonOut = false, kvType = 'f16', hw = makeHardware(), mmproj = null, budget = 'static' } = {}) {
  const results = []
  const extra = await visionExtra(mmproj, { jsonOut })
  for (const f of files) {
    const remote = isUrlLike(f)
    const shard = shardInfo(f)
    try {
      // 后续分片里没有元数据，读下去只会得到「magic 不匹配」这种莫名其妙的报错
      if (shard && shard.index !== 1) {
        throw new Error(t('x.shardTail', {
          n: shard.total, i: shard.index, p: String(shard.total).padStart(5, '0')
        }))
      }
      if (remote && !jsonOut) {
        console.error(paint(`  ${t('x.remote', { name: shortName(f) })}`, 'dim'))
      }
      const meta = await readGguf(remote ? f : path.resolve(f))
      // 分片模型：单片体积只是整体的 1/N，不折算会把 20 GB 的模型当成 4 GB 说「轻松装下」
      const weightsBytes = totalWeightsBytes(meta)
      /**
       * 主报告按**纯文本**算：默认启动不挂投影器，推荐档必须能用在这个状态下。
       * 带投影器的结论单独算一次（纯算术，几毫秒），给界面解释「发图要降多少」。
       * 以前是把额外开销直接并进主报告 —— 结果是视觉模型一律被判「装不下任何档」，
       * 用户以为模型不行，其实只是少了「发图才付的这笔钱」这一层区分。
       */
      const result = assess(meta, hw, { kvType, weightsBytes, budget })
      const visionFit = extra.bytes > 0
        ? assess(meta, hw, { kvType, weightsBytes, extraBytes: extra.bytes, budget })
        : null
      // 多卡合并评估：与主报告同一套 assess()，只是硬件换成合并后的虚拟卡
      const mg = mergedHardware(hw)
      const combined = mg.merged
        ? assess(meta, mg.hw, { kvType, weightsBytes, extraBytes: extra.bytes, budget })
        : null
      results.push({ meta, result, extra, visionFit, hw, mg, combined })
      if (!jsonOut) {
        const pair = meta.isVision || meta.isAssistant ? await findPair(meta.file) : null
        console.log(render(meta, hw, result, { kvType, extra, visionFit, budget, weightsBytes, pair }))
      }
    } catch (err) {
      results.push({ file: f, error: err.message })
      if (!jsonOut) {
        console.log('')
        console.log(paint(`  ✗ ${shortName(f)}`, 'red', 'bold'))
        console.log(paint(`    ${stripControl(err.message)}`, 'dim'))
        // 远程失败十有八九是网络，不是说链接写错了。不说清楚，用户会以为粘贴功能坏了。
        if (remote) {
          console.log(paint(t('x.remoteFail1'), 'dim'))
          console.log(paint(t('x.remoteFail2'), 'dim'))
        }
        console.log('')
      }
    }
  }
  return results
}


/**
 * JSON 里的速度必须和命令行主报告同一口径：公式值超过封顶时不报公式值。
 *
 * 小模型（< 2 GB）上 kernel launch / 采样是固定开销，带宽公式会给出
 * 600+ tok/s 这种物理上跑不出来的数字。命令行早就封顶了，JSON 却直接
 * Math.round 公式值 —— 消费 JSON 的界面于是显示一个大得离谱的速度。
 * 另外 CPU 推理时 speed.onVram 是 null，Math.round(null) === 0，
 * 看起来像真测出了 0 tok/s，所以非有限值一律给 null。
 */
const jsonSpeed = (v, weightsBytes) =>
  Number.isFinite(v) && v > 0
    ? Math.round(Math.min(v, speedCapFor(weightsBytes)))
    : null

function toJson(results) {
  return results.map((r) => {
    if (r.error) return r
    const { meta, result } = r
    const shard = shardInfo(meta.file)
    const totalBytes = totalWeightsBytes(meta)
    // 附加件没有可评估的上下文档位与速度：tiers / genTokPerSec 给 null/[]，
    // 让消费方按 kind 走另一条分支，而不是把 6 档全 ✓ 的空表渲染出来。
    const isAttachment = Boolean(meta.isVision || meta.isAssistant)
    // 和终端报告同一套判断：单卡连一档上下文都装不下、多卡合并能跑时，
    // JSON 里的 launchArgs 也要给多卡那套，否则脚本拿到的是照抄就 OOM 的旗标。
    // 单卡只能「专家放内存」而合并全放显存更快时，同样给合并那套 ——
    // 终端给快的那条、JSON 给慢的那条，是最难查的一类不一致。
    const mergedSpeed = r.combined?.speed?.onVram
    const preferMerged = Boolean(
      r.combined?.estimated && r.combined.weightsFit && r.combined.best &&
      result.moe?.canOffload && Number.isFinite(mergedSpeed) &&
      (!Number.isFinite(result.speed?.onRam) || mergedSpeed > result.speed.onRam * 1.15)
    )
    const splitAcrossGpus = preferMerged || Boolean(
      r.combined?.estimated && r.combined.weightsFit && r.combined.best &&
      !result.best && !result.moe?.canOffload
    )
    const launchTarget = splitAcrossGpus ? r.combined : result
    return {
      file: meta.file,
      name: meta.name,
      arch: meta.arch,
      // 附加件（mmproj / MTP 草稿）不是模型：调用方看到 kind 就该换个界面分支，
      // 而不是拿 tiers / genTokPerSec 去渲染一张空表。
      kind: meta.isVision ? 'vision' : meta.isAssistant ? 'draft' : 'model',
      sizeBytes: meta.sizeBytes,
      // 分片模型：sizeBytes 是第 1 片，weightsBytes 才是按片数折算后的整体
      shard: shard ? { index: shard.index, total: shard.total } : null,
      weightsBytes: totalBytes,
      quant: quantFromName(meta.file),
      // 投影件的文件名继承自主模型（`…12b…-mmproj.gguf`），从里面猜 12B 是纯误导
      params: meta.isVision ? null : paramCountOf(meta.file, meta.paramCount) ?? null,
      layers: meta.blockCount ?? null,
      headCount: meta.headCount ?? null,
      headKv: meta.headKv ?? null,
      attention: attentionReport(meta),
      nativeContext: meta.contextLength ?? null,
      chatTemplate: meta.chatTemplate ? { present: true, bytes: Buffer.byteLength(meta.chatTemplate) } : { present: false },
      tools: analyzeTemplate(meta.chatTemplate).level,
      gpu: result.gpu ? {
        name: result.gpu.name,
        totalBytes: result.gpu.totalBytes,
        usedBytes: result.gpu.usedBytes ?? 0,
        /** 已用显存读不到（A 卡 / 核显）：预算已按保守系数算过，界面要能解释 */
        usedUnknown: result.gpu.usedUnknown === true,
        kind: result.gpu.kind ?? 'discrete',
        unified: Boolean(result.gpu.unified),
        backend: result.gpu.backend ?? null
      } : null,
      cpuOnly: Boolean(result.onCpu),
      /**
       * 探测到的全部显卡（多卡机器不再只回一张）。recommendedCtx 等仍是针对 gpu 那张单卡。
       */
      gpus: (r.hw?.gpus ?? []).map((x) => ({
        name: x.name,
        totalBytes: x.totalBytes,
        usedBytes: x.usedBytes ?? 0,
        backend: x.backend ?? null,
        bandwidthGBps: x.bandwidthGBps ?? null,
        kind: x.kind ?? 'discrete'
      })),
      /** 多卡合并评估；单卡或附加件时为 null。显存池=各卡之和，速度按最弱卡粗估 */
      combined: !isAttachment && r.mg?.merged ? {
        cards: r.mg.cards,
        poolBytes: r.mg.hw.gpus[0].totalBytes,
        weakest: r.mg.weakestName,
        bandwidthUnknown: r.mg.bandwidthUnknown,
        limitBytes: r.combined?.limit ?? null,
        basis: r.combined?.limitBasis ?? null,
        recommendedCtx: r.combined?.best?.ctx ?? null,
        verdict: r.combined ? verdictOf(meta, r.combined) : null,
        speed: r.combined?.speed?.onVram ?? null
      } : null,
      budget: { limitBytes: result.limit, basis: result.limitBasis },
      /**
       * 看图口径：主报告（tiers / recommendedCtx）按纯文本算，这里给发图片时的结论。
       * null 表示没传投影器，或这个模型本来就没有投影器。
       */
      vision: r.extra?.bytes > 0
        ? {
          projectorBytes: r.extra.weights,
          activationBytes: r.extra.overhead,
          totalBytes: r.extra.bytes,
          /** 挂上投影器后还能开的最大档；null = 一档都不行（应退回纯文本或分层） */
          recommendedCtx: r.visionFit?.best?.ctx ?? null,
          fits: Boolean(r.visionFit?.best)
        }
        : null,
      /**
       * tight（need > limit × 0.85）必须一起序列化。
       *
       * 以前这里只挑了 ctx / needBytes / fits 三个字段，于是启动链拿不到「这一档贴着
       * 上限」这个事实 —— 8 GB 卡上 7B 模型算出 64K 占用 6.42 GB、预算 6.45 GB
       * （ratio 0.994），明明一毫米余量，还是照样推荐、照样按它启动，
       * 装不下再花 10 秒重载降档。beyondNative 同理，界面要能说明「这档是 RoPE 外推」。
       */
      tiers: isAttachment ? [] : result.rows.map((x) => ({
        ctx: x.ctx,
        needBytes: x.need,
        fits: x.fits,
        tight: x.tight === true,
        beyondNative: x.beyondNative === true
      })),
      recommendedCtx: isAttachment ? null : result.best?.ctx ?? null,
      estimated: result.estimated !== false,
      bandwidth: result.speed?.bandwidth ?? null,
      // 速度口径见 speedBasis：零上下文、batch=1、权重驻留显存时的解码峰值。
      // 封顶按速度口径的权重（MoE = 激活权重），与命令行/网页封顶同一个数。
      genTokPerSec: isAttachment
        ? null
        : jsonSpeed(result.speed?.onVram, result.speed?.basisBytes ?? totalBytes),
      genTokPerSecOnCpu: isAttachment
        ? null
        : jsonSpeed(result.speed?.onRam, result.speed?.basisBytes ?? totalBytes),
      // 按建议上下文补上 KV cache 读取代价后的折减值，用来解释峰值与实测的差距
      genTokPerSecAtCtx: isAttachment
        ? null
        : jsonSpeed(result.speed?.atCtx, result.speed?.basisBytes ?? totalBytes),
      speedCtx: result.speed?.atCtxTokens ?? null,
      speedBasis: 'zero-context-decode-peak',
      /**
       * MoE：速度按激活专家估算，显存仍按全权重。ratio=null 表示拿不到激活数、速度未修正。
       * source: kv = 元数据 expert_used_count；name = 文件名 A22B 兜底；null = 未修正。
       */
      moe: result.moe ? {
        experts: result.moe.experts,
        active: result.moe.used,
        ratio: result.moe.ratio,
        activeParamsB: result.moe.activeParamsB,
        speedBasisBytes: result.moe.activeBytes,
        corrected: result.moe.corrected,
        source: result.moe.source,
        /** 显存 + 系统 RAM 合计能否跑下（MoE 专家可 offload 到 RAM） */
        combinedFit: result.moe.combinedFit,
        canOffload: result.moe.canOffload,
        ramBytes: result.moe.ramBytes,
        usableRam: result.moe.usableRam,
        supplyBytes: result.moe.supplyBytes,
        needBytes: result.moe.needBytes,
        spillBytes: result.moe.spillBytes,
        offloadLayers: result.moe.offloadLayers
      } : null,
      /** llama.cpp 启动旗标建议（结构化，供界面直接拼命令行） */
      // 附加件给不出「怎么跑主模型」的旗标，空数组比一组误导性的 -ngl 999 好
      launchArgs: meta.isVision || meta.isAssistant
        ? []
        : launchArgsOf(meta, launchTarget, {
          kvType: r.kvType,
          merged: splitAcrossGpus ? { devices: r.mg?.devices } : null
        }),
      /** 上面那套旗标是不是多卡按层切分（单卡放不下、合并能跑时才为 true） */
      splitAcrossGpus,
      verdict: verdictOf(meta, result),
      // 这一行故意不跟 --lang 走：JSON 是给脚本消费的，要求同一份输入在任何机器上
      // 产出逐字节相同的结果。跟着系统语言变会让 CI 快照随机失败。
      disclaimer: '静态推算，仅供参考：速度为零上下文、batch=1、全权重驻留显存时的解码峰值，不含 KV cache 读取、首字延迟与工具执行，实测通常更低；需实际加载验证；参数与假设见 --about'
    }
  })
}

// ───────────────────────────── 交互模式 ─────────────────────────────

// 各平台的粘贴快捷键不一样，写死 Ctrl+V 在 macOS 上是错的
// 各平台的粘贴快捷键不一样，写死 Ctrl+V 在 macOS 上是错的
const pasteHint = () => (process.platform === 'win32'
  ? t('i.pasteWin')
  : process.platform === 'darwin' ? t('i.pasteMac') : t('i.pasteLinux'))

// 抬头做成函数：语言可能在运行中切换（交互模式里输入 lang），模板字符串会把它冻住
const banner = () => {
  const rule = asciiOnly ? '='.repeat(55) : '═'.repeat(55)
  const c = (x) => paint(x, 'cyan')
  return `
${paint('  ' + rule, 'dim')}
  ${paint('vramfit', 'bold', 'cyan')}   ${paint(t('i.mode'), 'dim')}
${paint('  ' + rule, 'dim')}

  ${paint(t('i.pasteHead'), 'bold')}

  ${t('i.paste1', { gguf: c(t('i.ggufLink')) })}
  ${t('i.paste2', { all: c(t('i.allQuant')) })}
  ${t('i.paste3')}
  ${t('i.paste4', { repo: c('owner/repo') })}

  ${paint(t('i.cmds'), 'dim')}${paint('help', 'yellow')} ${t('i.cmdHelpDesc')}   ` +
    `${paint('cls', 'yellow')} ${t('i.cmdClsDesc')}   ${paint('lang', 'yellow')} ${t('i.cmdLangDesc')}   ` +
    `${paint('q', 'yellow')} ${t('i.cmdQDesc')}
  ${paint(t('i.pasteKey'), 'dim')}${pasteHint()}${t('i.pasteMore')}
  ${t('i.pasteFallback1')}${paint('paste', 'yellow')}${t('i.pasteFallback2')}
  ${paint(t('i.footNote'), 'dim')}
`
}

/** 像不像一个"目标"：链接、.gguf、owner/repo、盘符路径 */
function looksLikeTarget(t) {
  if (/^https?:\/\//i.test(t)) return true
  if (/\.gguf$/i.test(t)) return true
  if (/^[\w.-]+\/[\w.-]+$/.test(t)) return true
  if (/^[a-zA-Z]:[\\/]/.test(t)) return true
  if (/^(?:\\\\|\/|\.{1,2}[\\/])/.test(t)) return true
  return false
}

/**
 * 一行里可能粘了好几个链接（从网页或聊天记录一次复制多条时很常见）。
 * 先按引号感知切分（这样含空格的路径不会被拆坏），再逐个确认像不像目标，
 * 顺手把"这个是啥"这种跟着粘进来的中文说明丢掉。
 */
async function splitPasted(line) {
  const raw = String(line ?? '')
  if (!/\s/.test(raw.trim())) return [cleanPasted(raw)]

  const tokens = (raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((x) => cleanPasted(x)).filter(Boolean)
  if (tokens.length <= 1) return tokens.length ? tokens : [cleanPasted(raw)]

  const kept = []
  for (const t of tokens) {
    if (looksLikeTarget(t)) { kept.push(t); continue }
    try { await fs.stat(path.resolve(t)); kept.push(t) } catch { /* 既不像目标也不存在，丢掉 */ }
  }
  // 全被丢光说明判断错了，宁可原样交回去让报错说清楚
  return kept.length ? kept : [cleanPasted(raw)]
}

/**
 * 读系统剪贴板。终端里实在粘不进来时的兜底：`paste` 命令直接取剪贴板内容。
 * 失败返回空串，不抛错。
 */
function readClipboard() {
  const run = (cmd, args) => {
    try {
      const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 8000 })
      return r.status === 0 ? (r.stdout ?? '').trim() : ''
    } catch { return '' }
  }
  if (process.platform === 'win32') {
    // 默认输出是控制台代码页，中文会变问号，这里强制 UTF-8
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw'])
  }
  if (process.platform === 'darwin') return run('pbpaste', [])
  for (const [cmd, args] of [['wl-paste', ['--no-newline']], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['-b']]]) {
    const t = run(cmd, args)
    if (t) return t
  }
  return ''
}

/**
 * 交互模式该用哪种输入方式。抽成纯函数，方便单测锁住这个回归点。
 *
 * 为什么 Windows 上不能用 readline 的 terminal 模式：
 * 它会调 setRawMode(true)，而 libuv 的 raw 模式把控制台输入模式整个换成
 * ENABLE_WINDOW_INPUT|ENABLE_VIRTUAL_TERMINAL_INPUT（实测 0x0208）——
 * 连带清掉 ENABLE_QUICK_EDIT_MODE。conhost 的 Ctrl+V / 右键粘贴正是靠这个
 * 标志工作的，于是双击 check.cmd 打开的窗口里怎么粘都没反应。
 * （Windows Terminal 不受影响，粘贴是终端自己处理的，所以这个问题只在
 *  双击 .cmd 出来的经典控制台窗口里出现。）
 * 改用熟模式：由控制台负责回显和粘贴，我们只按行读。实测熟模式下
 * QUICK_EDIT_MODE 保持开启，粘贴正常。
 */
export function inputMode({ isTTY, platform }) {
  const tty = Boolean(isTTY)
  return {
    cooked: tty && platform === 'win32',
    terminal: tty && platform !== 'win32'
  }
}

async function interactive(opts = {}) {
  const kvType = opts.kvType ?? 'f16'
  const gpuIndex = opts.gpuIndex ?? 0
  /** 只看文字就够，但带上投影器算出来的才是「发图片时」的真实预算 */
  const mmproj = opts.mmproj ?? null
  /** 预算口径要一路带到每次检查：交互模式下同一句话可能查好几次，口径不能中间掉回默认 */
  const budget = opts.budget ?? 'static'

  const mode = inputMode({ isTTY: process.stdin.isTTY, platform: process.platform })
  const cooked = mode.cooked
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: mode.terminal })

  // 用行队列而不是 rl.question：readline 一创建就进入 flowing 模式，
  // 管道输入会在第一次 question 之前就把 'line' 事件发完，内容被静默丢弃。
  const queue = []
  let waiter = null
  let closed = false
  const deliver = (v) => {
    if (waiter) { const w = waiter; waiter = null; w(v) } else queue.push(v)
  }
  rl.on('line', (l) => deliver(l))
  rl.on('close', () => { closed = true; deliver(null) })

  const nextLine = () => new Promise((resolve) => {
    if (queue.length) return resolve(queue.shift())
    if (closed) return resolve(null)
    waiter = resolve
  })

  // 熟模式下 Ctrl+C 不再被 readline 拦成 'SIGINT' 事件，而是真的发给进程
  const bye = () => {
    console.log(paint(`\n  ${t('x.bye')}\n`, 'dim'))
    rl.close()
    process.exit(0)
  }
  rl.on('SIGINT', bye)
  if (cooked) process.on('SIGINT', bye)

  // 切换语言：只认一行提示，不清屏、不重画抬头。
  //
  // 清屏看起来很"干净"，但用户敲 lang 的时候屏幕上往往正放着一份刚跑完的报告 ——
  // 顺手把历史抹掉，等于为了改个语言惩罚用户。这个工具里已经有 cls 专门干清屏，
  // 切语言不该自带这个副作用。提示符自己会变成 check >，就是最直接的确认。
  const switchLocale = (code) => {
    setLocale(code)
    console.log(paint(`  ${t('i.langSet', { name: t('i.langName') })}`, 'dim'))
  }

  console.log(banner())

  for (;;) {
    process.stdout.write(paint(`\n  ${t('x.prompt')}`, 'cyan', 'bold'))
    const typed = await nextLine()
    if (typed === null) break

    // 兜底入口：某些控制台（旧版 conhost / 安全软件接管键盘）粘贴仍是死的，
    // 让用户敲一个 paste，直接从系统剪贴板取，不依赖终端。
    let line = typed
    if (/^(paste|clip)$/i.test(cleanPasted(line))) {
      const clip = readClipboard()
      if (!clip) {
        console.log(paint(`  ${t('x.clipEmpty')}`, 'yellow'))
        continue
      }
      console.log(paint(`  ${t('x.clipGot', { t: clip.replace(/\s+/g, ' ').slice(0, 100) })}`, 'dim'))
      line = clip
    }

    // 粘贴进来的内容先洗一遍：零宽字符、包裹的引号、句末标点都会让识别失败
    const s = cleanPasted(line)
    if (!s) continue
    if (/^(q|quit|exit|:q)$/i.test(s)) break
    if (/^(help|\?|h)$/i.test(s)) { usage(); continue }
    if (/^(cls|clear)$/i.test(s)) { process.stdout.write('\x1b[2J\x1b[H'); console.log(banner()); continue }

    // 语言：lang / lang en / lang=zh / -cn / 中文
    // 命令行那边 --lang 只认 zh*/en*（脚本拼错要当场报错，猜会把 bug 藏起来），
    // 这里是给人敲的，所以宽一些。
    // 开头允许横线：用户在交互里也会顺手敲 --lang en，那串其实不是参数，
    // 直接丢给后面的识别流程只会换来一句「没认出这是链接还是文件」
    const langCmd = /^(?:lang|language)(?:[\s=:]+(.*))?$/i.exec(s.replace(/^--?/, ''))
    if (langCmd) {
      const want = (langCmd[1] ?? '').trim()
      if (!want) {
        console.log(`  ${t('i.langNow', { name: t('i.langName') })}`)
        console.log(paint(`  ${t('i.langUsage')}`, 'dim'))
        continue
      }
      const code = localeOf(want)
      if (!code) {
        console.log(paint(`  ${t('i.langBad', { v: want })}`, 'yellow'))
        continue
      }
      switchLocale(code)
      continue
    }
    // 省事写法：直接敲 en / zh / cn / -en。
    // 代价是名叫 cn 的目录得写成 ./cn —— 真碰上也算值，敲两个字母就换语言太顺手了。
    const bare = localeOf(s)
    if (bare) { switchLocale(bare); continue }

    try {
      // 每次重新读硬件：显存「已占用」随时在变，缓存住会给出错的可用值
      const hw = makeHardware(opts.manualVram ?? 0, gpuIndex)

      const repoCmd = /^(?:repo|--repo)\s+(.+)$/i.exec(s)
      if (repoCmd) {
        let name = cleanPasted(repoCmd[1])
        const hf = parseHfInput(name)
        if (hf?.kind === 'repo') name = hf.repo
        await runRepo(name, { kvType, hw, budget })
        continue
      }

      const targets = await splitPasted(line)
      const { files, repos } = await expandTargets(targets, { guessRepo: true })
      if (!files.length && !repos.length) {
        console.log(paint(`  ${t('x.unrecognized')}`, 'yellow'))
        console.log(paint(`  ${t('x.unrec1')}`, 'dim'))
        console.log(paint(`  ${t('x.unrec2')}`, 'dim'))
        console.log(paint(`  ${t('x.unrec3')}`, 'dim'))
        continue
      }
      for (const r of repos) await runRepo(r, { kvType, hw, budget })
      if (files.length) await runChecks(files, { kvType, hw, mmproj, budget })
    } catch (err) {
      console.log(paint(`\n  ✗ ${err.message}`, 'red'))
    }
  }

  rl.close()
  console.log(paint(`\n  ${t('x.bye')}\n`, 'dim'))
}

// ───────────────────────────── 命令行入口 ─────────────────────────────


/** 取一个带值选项的值，取不到返回 undefined */
function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  if (i < 0) return undefined
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : undefined
}

async function main() {
  const argv = normalizeArgv(process.argv.slice(2))

  // 语言必须第一个确定：下面每一句提示（包括 --help 和参数报错）都要用它。
  // 优先级：--lang > VRAMFIT_LANG > 系统 locale > 兜底中文。
  const wantLang = argValue(argv, '--lang')
  try {
    setLocale(wantLang ?? detectLocale({ env: process.env }))
  } catch {
    // 语言没定下来，报错也得挑一种：按系统 locale 说，用户至少看得懂
    setLocale(detectLocale({ env: process.env }))
    console.error(paint(`  ${t('in.p.langBad', { v: wantLang })}`, 'red'))
    process.exitCode = 1
    return
  }
  // --lang 只是拿来选语言的，不能漏进「文件参数」里
  if (wantLang !== undefined) argv.splice(argv.indexOf('--lang'), 2)

  if (argv.includes('--help') || argv.includes('-h')) { usage(); return }
  // --version 要能说清「这是谁的东西」：二次分发时用户查这一行就知道出自哪
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(`vramfit ${VERSION} · MIT · https://github.com/RoRoToCode/vramfit`)
    return
  }
  if (argv.includes('--about')) { about(); return }

  const jsonOut = argv.includes('--json')
  const { kvType, manualVram, gpuIndex, repo, mirror, mmproj, budget, problems } = parseOptions(argv)
  if (problems.length) {
    for (const p of problems) console.error(paint(`  ✗ ${p}`, 'red'))
    console.error(paint(`  ${t('x.helpHint')}`, 'dim'))
    process.exitCode = 1
    return
  }

  // 站点优先级：--mirror > 环境变量 > 默认镜像。
  // 设成官方地址就等于不走镜像 —— 海外用户、或镜像出问题时用得上。
  const envMirror = process.env.VRAMFIT_MIRROR
  if (mirror) setMirror(mirror)
  else if (envMirror !== undefined) setMirror(envMirror)
  if (!jsonOut && getMirror() !== DEFAULT_MIRROR) {
    console.log(paint(`  ${t('x.mirrorOn', { url: getMirror() })}`, 'dim'))
  }

  const raw = argv.filter((a, i) => {
    if (a.startsWith('--') || a === '-i') return false
    if (i > 0 && VALUE_FLAGS.has(argv[i - 1])) return false
    return true
  })

  const hw = makeHardware(manualVram, gpuIndex)

  // ── 整仓库对比模式
  if (repo) {
    // 两种模式的结果呈现完全不同，混着给会让人以为文件也被检查了
    if (raw.length) {
      console.error(paint(`  ${t('x.repoIgnore', { n: raw.length })}`, 'yellow'))
    }
    const rows = await runRepo(repo, { jsonOut, kvType, hw, budget }) ?? []
    // 整个仓库一个都读不到 → 网络问题，CI 里应当失败；只是部分变体失败不算
    if (rows.length && rows.every((r) => r?.error)) process.exitCode = 1
    return
  }

  // ── 没带参数：直接进交互模式。双击 check.cmd / 直接 node check.mjs /
  //    从管道喂链接，三种情况都走这里，粘贴链接永远可用。
  if (!raw.length) {
    if (jsonOut) { usage(); process.exitCode = 1; return }
    await interactive({ kvType, manualVram, gpuIndex, mmproj, budget })
    return
  }

  const { files, repos } = await expandTargets(raw, { jsonOut, guessRepo: true })
  for (const r of repos) {
    const rows = await runRepo(r, { jsonOut, kvType, hw, budget }) ?? []
    if (rows.length && rows.every((x) => x?.error)) process.exitCode = 1
  }
  if (!files.length) return

  const results = await runChecks(files, { jsonOut, kvType, hw, mmproj, budget })
  if (jsonOut) console.log(JSON.stringify(toJson(results), null, 2))
  // 有文件读不到时退非 0，JSON 模式才好在 CI 里用
  if (results.some((r) => r?.error)) process.exitCode = 1
}

// 对外出口：测试用，不影响 CLI 行为
export {
  VERSION,
  quantFromName, quantRank, quantTier, repoVerdict,
  shardInfo, totalWeightsBytes, attentionInterval, kvLayers, kvBytes,
  fullLayerFraction, analyzeTemplate, assess, vramCeiling, headlineOf,
  cleanPasted, parseHfInput, stripControl, normalizeArgv, parseOptions,
  render, renderRepoTable, toJson, limitBasisText, expandTargets
}

const isMain = (() => {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
})()

if (isMain) {
  main().catch((err) => {
    console.error(paint(`\n  ✗ ${err.message}\n`, 'red'))
    process.exit(1)
  })
}
