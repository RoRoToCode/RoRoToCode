/**
 * 量化标记、分片、参数量 —— 全部基于文件名的纯函数。
 */

import { baseName } from './util.mjs'
import { t } from './i18n.mjs'

/** 量化名：文件名的标记通常比 general.file_type 更具体（Q4_K_M vs Q4_K_S） */
export function quantFromName(file) {
  const base = baseName(file)
  // 注意顺序：Q4_K_XL / Q4_K_L 这类变体必须整体匹配，否则会被降级成 Q4_K，
  // 在对比表里出现两个同名的不同体积条目。
  const m = /(IQ\d+_[A-Z0-9]+|Q\d+_K_[A-Z]+|Q\d+_K|Q\d+_\d+|Q\d+_[01]|BF16|F16|F32|MXFP4)/i.exec(base)
  return m ? m[1].toUpperCase() : undefined
}

/** 分片模型：只有第一片带头部元数据，后续片子读出来的东西没有意义 */
export function shardInfo(file) {
  const m = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(baseName(file))
  return m ? { index: Number(m[1]), total: Number(m[2]) } : null
}

export function isShardTail(file) {
  const s = shardInfo(file)
  return !!s && s.index !== 1
}

/**
 * 分片模型的整体体积。
 * llama.cpp 切分时各片大小基本相等，所以按「第 1 片 × 片数」估；
 * 不折算的话，一个 5 片的 20 GB 模型会被当成 4 GB，结论完全相反。
 */
export function totalWeightsBytes(meta) {
  const s = shardInfo(meta.file)
  return s && s.total > 1 ? meta.sizeBytes * s.total : meta.sizeBytes
}

/** 从文件名猜参数量（B 为单位），仅在没有 general.parameter_count 时用 */
export function paramsFromName(file) {
  const base = baseName(file).replace(/\.gguf$/i, '')
  const m = /(?:^|[^a-z0-9])(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z0-9])/.exec(base)
  if (!m) return undefined
  const n = Number(m[1])
  return n > 0 && n < 10000 ? n : undefined
}

/** 参数量：优先用元数据里的 general.parameter_count，其次从文件名里的「8B」猜 */
export function paramCountOf(file, explicit) {
  if (typeof explicit === 'number' && explicit > 0) return explicit
  const named = paramsFromName(file)
  return named ? named * 1e9 : undefined
}

export function quantRank(q) {
  if (!q) return -1
  if (/BF16|F16|F32/i.test(q)) return 50
  const m = /Q(\d+)|IQ(\d+)/i.exec(q)
  return m ? Number(m[1] ?? m[2]) : 0
}

/**
 * 量化质量分级。这是纯经验数据，不是算出来的：模板完整不代表模型能干活，
 * 1–2 bit 的量化输出本身就不稳定，工具调用必然翻车。
 * tier 越高越好；agent 场景建议 tier >= 3。
 *
 * label / note 存词条 key，取的时候才翻译 —— 表是数据，不该在模块加载那一刻
 * 就固化成某一种语言（网页会先 setLocale 再查表）。
 */
export const QUANT_TIERS = [
  { re: /^IQ1|^Q1_|^Q1$/i, tier: 0, labelKey: 'q.t0.label', noteKey: 'q.t0.note1' },
  { re: /^IQ2_XXS|^IQ2_XS/i, tier: 0, labelKey: 'q.t0.label', noteKey: 'q.t0.note2' },
  { re: /^IQ2|^Q2_/i, tier: 1, labelKey: 'q.t1.label', noteKey: 'q.t1.note' },
  { re: /^IQ3|^Q3_/i, tier: 2, labelKey: 'q.t2.label', noteKey: 'q.t2.note' },
  { re: /^IQ4|^Q4_/i, tier: 3, labelKey: 'q.t3.label', noteKey: 'q.t3.note' },
  { re: /^Q5_/i, tier: 4, labelKey: 'q.t4.label', noteKey: 'q.t4.note1' },
  { re: /^Q6_/i, tier: 4, labelKey: 'q.t4.label', noteKey: 'q.t4.note2' },
  { re: /^Q8_|BF16|F16|F32/i, tier: 5, labelKey: 'q.t5.label', noteKey: 'q.t5.note' },
]

/** 表里一条 → 当前语言的 label / note */
const tierOut = (row) => ({
  tier: row.tier,
  labelKey: row.labelKey,
  label: t(row.labelKey),
  note: t(row.noteKey)
})

export function quantTier(q) {
  if (!q) return { tier: 2, labelKey: 'q.unknown.label', label: t('q.unknown.label'), note: t('q.unknown.note1') }
  for (const row of QUANT_TIERS) if (row.re.test(q)) return tierOut(row)
  return { tier: 2, labelKey: 'q.unknown.label', label: t('q.unknown.label'), note: t('q.unknown.note2') }
}

/**
 * 仓库对比里的结论：先看装不装得下，再看模板，最后看量化质量够不够驱动 agent。
 *
 * key / rank 是稳定标识，label 只用来显示。判断逻辑必须按 rank 走，
 * 绝不能拿 label 比字符串 —— 一换语言，推荐行就会整个变空。
 */
export function repoVerdict(r) {
  const out = (key, color, rank) => ({ key, label: t(key), color, rank })
  if (!r.hasTemplate) return out('rv.noTemplate', 'red', -1)
  // 元数据不全 → KV 算不出来。报「装不下」会让人去换更小的模型，方向完全错
  if (r.estimated === false) return out('rv.cantEstimate', 'yellow', -1)
  if (!r.best) return out('rv.noFit', 'red', -1)
  if (r.tier <= 1) return out('rv.avoid', 'red', 0)
  // 有模板但模板里没有 tools 分支：能对话，不能被 agent 驱动。这和「无模板」是两件事。
  if (!r.toolOk) return out('rv.noTools', 'yellow', 1)
  if (r.tier === 2) return out('rv.borderline', 'yellow', 1)
  if (r.best < 8192) return out('rv.smallCtx', 'yellow', 1)
  return out('rv.ok', 'green', 2)
}
