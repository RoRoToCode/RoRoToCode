/**
 * 把 core 算出来的结果翻译成「人话 + HTML」。
 *
 * 这里刻意不复用命令行的 render —— 那是 ANSI 文本，塞进网页就是一坨转义码。
 * 但判据必须完全一致，所以结论、档位、速度全部取自 core，这里只做排版。
 */

import {
  GB, FILE_TYPE, quantFromName, paramCountOf, shardInfo, totalWeightsBytes,
  analyzeTemplate, attentionReport, stripControl, baseName, fmtSize,
  headlineOf, TUNING, assumptionsList
} from '../core/index.mjs'
// 界面壳子的词条表（表单、表头、状态提示）。报告正文里的结论仍由 core/i18n.mjs
// 按 core 的 locale 生成，两边在 app.mjs 里同时设定，不会各说一种语言。
import { tx } from './strings.mjs'

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/**
 * 外部来的名字先洗控制字符。
 *
 * 这里只洗不转义：转义必须发生在拼 HTML 的那一刻，而且只能发生一次。
 * 之前的 safe() 同时做了两件事，buildView 洗完一遍、renderView 又 esc 一遍，
 * 文件名里有个 & 就变成 &amp;amp; 显示在页面上。
 */
const clean = (s) => stripControl(String(s ?? ''))

/** 直接进 HTML 时用这个：先洗再转义，一步到位 */
const safe = (s) => esc(clean(s))

const fmtGB = (b) => `${(b / GB).toFixed(2)} GB`
const fmtCtx = (n) => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n))
const fmtParams = (n) => {
  if (!Number.isFinite(n) || n <= 0) return '—'
  const b = n / 1e9
  return b >= 10 ? `${b.toFixed(0)}B` : b >= 1 ? `${b.toFixed(1)}B` : `${b.toFixed(2)}B`
}

/** 显存里各项占多少，画成一条堆叠条 */
function breakdown(result) {
  const kv = result.best ? result.best.kv : 0
  // 进度条必须按「权重 + KV + 运行时开销」算 —— 只算权重会比标题数字小一大截，
  // 用户看到 7.13 GB / 7.52 GB 配一条 62% 的条，只会以为工具算错了。
  const total = result.weights + kv + result.overhead
  return {
    weights: result.weights,
    kv,
    overhead: result.overhead,
    total,
    limit: result.limit,
    ratio: Math.min(1, total / (result.limit || 1))
  }
}

export function buildView(meta, result, ctx = {}) {
  const quant = quantFromName(meta.file) ?? (meta.fileType !== undefined ? FILE_TYPE[meta.fileType] : undefined) ?? tx('rp.unknown')
  const shard = shardInfo(meta.file)
  const weights = totalWeightsBytes(meta)
  const speed = result.speed?.onVram
  const sp = Number.isFinite(speed) && speed > 0 ? Math.round(speed) : null
  const att = attentionReport(meta)
  const tpl = analyzeTemplate(meta.chatTemplate)
  const bd = breakdown(result)

  return {
    // 这几个字段来自远端文件名，只洗控制字符，转义留给拼 HTML 的地方做一次
    name: clean(meta.name || baseName(meta.file)),
    file: clean(baseName(meta.file)),
    arch: meta.arch ? clean(meta.arch) : null,
    quant: clean(quant),
    size: fmtGB(weights),
    params: fmtParams(paramCountOf(meta.file, meta.paramCount)),
    layers: meta.blockCount ?? null,
    headKv: meta.headKv ?? null,
    native: meta.contextLength ?? null,
    shard: shard && shard.total > 1 ? `${shard.index}/${shard.total}` : null,
    verdict: headlineOf(meta, result),
    bestCtx: result.best?.ctx ?? null,
    bestCtxText: result.best ? fmtCtx(result.best.ctx) : '—',
    speed: sp,
    speedOnCpu: Number.isFinite(result.speed?.onRam) && result.speed.onRam > 0
      ? Math.round(result.speed.onRam)
      : null,
    bandwidth: result.speed?.bandwidth ?? null,
    gpuName: result.gpu ? clean(result.gpu.name) : null,
    estimated: result.estimated !== false,
    limit: bd.limit,
    limitText: fmtGB(result.limit),
    totalBytes: bd.total,
    totalText: fmtGB(bd.total),
    weightsBytes: bd.weights,
    kvBytes: bd.kv,
    overheadBytes: bd.overhead,
    ratio: bd.ratio,
    onCpu: result.onCpu,
    tiers: result.rows.map((r) => ({
      ctx: r.ctx,
      ctxText: fmtCtx(r.ctx),
      need: r.need,
      needText: r.need === null ? tx('rp.cantEstimate') : fmtGB(r.need),
      fits: r.fits,
      tight: r.tight,
      beyondNative: r.beyondNative,
      best: result.best?.ctx === r.ctx
    })),
    template: { level: tpl.level, notes: tpl.notes },
    attention: att.swa
      ? tx('rp.att.swa', { n: att.kvLayers, full: att.swa.fullLayers, win: fmtCtx(att.swa.window) })
      : att.intervalInferred
        ? tx('rp.att.interval', { n: att.kvLayers, i: att.interval })
        : tx('rp.att.plain', { n: att.kvLayers }),
    moe: meta.expertCount
      ? tx('rp.moe', { n: meta.expertCount, used: meta.expertUsedCount ?? '?' })
      : null,
    kvType: ctx.kvType ?? 'f16'
  }
}

/**
 * 工具调用能力四档。core 的 level 是固定枚举（strong / partial / weak / none），
 * 直接拼 key；万一出现新档位，退回原始值，不要把 ⟪key⟫ 漏到页面上。
 */
function levelText(level) {
  const out = tx('rp.tpl.' + level)
  return out.startsWith('⟪') ? level : out
}

export function renderView(v) {
  const meter = Math.max(2, Math.min(100, Math.round(v.ratio * 100)))
  // CPU 推理时 onVram 是 null，只算过 onRam；以前这里只看 onVram，
  // 于是没插独显的机器上一律显示「带宽未知，不给估计」，而 CPU 速度其实算得出来。
  const noSpeed = tx('rp.speed.unknown')
  const speedText = v.onCpu
    ? (v.speedOnCpu ? tx('rp.speed.cpu', { n: v.speedOnCpu }) : noSpeed)
    : v.speed ? tx('rp.speed.vram', { n: v.speed }) : noSpeed

  const tierRows = v.tiers.map((t) => {
    const cls = t.beyondNative ? 'beyond' : t.fits ? (t.tight ? 'tight' : 'ok') : 'no'
    const mark = t.beyondNative ? tx('rp.tier.beyond')
      : t.fits ? (t.tight ? tx('rp.tier.tight') : tx('rp.tier.ok'))
        : tx('rp.tier.no')
    return `<div class="tier ${cls}${t.best ? ' is-best' : ''}">
      <span class="t-ctx">${esc(t.ctxText)}</span>
      <span class="t-bar"><i style="width:${Math.min(100, Math.round(((t.need || 0) / (v.limit || 1)) * 100))}%"></i></span>
      <span class="t-need">${esc(t.needText)}</span>
      <span class="t-mark">${mark}</span>
    </div>`
  }).join('')

  const unknown = tx('rp.unknown')
  const read = tx('rp.src.read')
  const infoRows = [
    [tx('rp.info.arch'), v.arch ?? unknown, read],
    [tx('rp.info.params'), v.params, read],
    [tx('rp.info.layers'), v.layers ? tx('rp.info.layersVal', { n: v.layers, att: v.attention }) : unknown, read],
    [tx('rp.info.native'), v.native ? fmtCtx(v.native) : unknown, read],
    [tx('rp.info.template'), levelText(v.template.level), read],
    [tx('rp.info.kv'), v.kvType === 'f16' ? tx('rp.info.kvDefault') : v.kvType, tx('rp.src.set')]
  ]
  if (v.moe) infoRows.push([tx('rp.info.moe'), v.moe, read])
  if (v.shard) infoRows.push([tx('rp.info.shard'), tx('rp.info.shardVal', { n: v.shard }), tx('rp.src.derived')])

  const info = infoRows.map(([k, val, src]) =>
    `<div class="kv-row"><span class="k">${esc(k)}</span><span class="v">${esc(val)}</span><span class="src">${esc(src)}</span></div>`
  ).join('')

  // notes 是 {ok, text} 结构（core 层统一改造过）：以前直接 esc(字符串)，
  // 现在直接把对象塞进模板会渲染成 [object Object]。
  const tplNotes = v.template.notes
    .map((n) => `<li>${n.ok ? '<i class="ok">✓</i> ' : ''}${esc(n.text ?? n)}</li>`)
    .join('')

  // 算不出 KV 时不要画那条进度条：它的分母只有权重，进度条会显示成「几乎占满」，
  // 和「算不出来」的结论自相矛盾。
  const budget = v.estimated
    ? `<div class="meter"><i style="width:${meter}%"></i></div>
      <div class="b-legend">
        <span><i class="dot w"></i>${tx('rp.legend.weights', { size: fmtGB(v.weightsBytes) })}</span>
        <span><i class="dot k"></i>${tx('rp.legend.kv', { size: v.kvBytes ? fmtGB(v.kvBytes) : '—' })}</span>
        <span><i class="dot o"></i>${tx('rp.legend.overhead', { size: fmtSize(v.overheadBytes) })}</span>
        <span class="spd">${esc(speedText)}</span>
      </div>`
    : `<div class="b-legend"><span><i class="dot w"></i>${tx('rp.legend.weights', { size: fmtGB(v.weightsBytes) })}</span>
        <span class="spd">${esc(speedText)}</span></div>
      <p class="note">${tx('rp.note.meta')}</p>`

  return `<article class="card">
    <header class="verdict" data-level="${v.verdict.level}">
      <div class="v-main">
        <h2>${esc(v.verdict.title)}</h2>
        <p>${esc(v.verdict.why)}</p>
      </div>
      <div class="v-side">
        <div class="v-num">${v.bestCtx ? esc(v.bestCtxText) : '—'}</div>
        <div class="v-cap">${tx('rp.cap.recommended')}</div>
      </div>
    </header>

    <div class="head">
      <div class="h-name">${esc(v.name)}</div>
      <div class="h-meta">
        <span class="chip">${esc(v.quant)}</span>
        <span class="chip">${esc(v.size)}</span>
        ${v.gpuName ? `<span class="chip ghost">${esc(v.gpuName)}</span>` : ''}
      </div>
    </div>

    <section class="budget">
      <div class="b-head">
        <span>${tx('rp.budget.title')}</span>
        <span class="b-num">${esc(v.totalText)} / ${esc(v.limitText)}</span>
      </div>
      ${budget}
      ${v.onCpu ? `<p class="note">${tx('rp.note.onCpu')}</p>` : ''}
    </section>

    <section class="tiers">
      <h3>${tx('rp.tiers.title')}</h3>
      ${tierRows}
    </section>

    <section class="info">
      <h3>${tx('rp.info.title')}</h3>
      ${info}
    </section>

    <details class="tpl">
      <summary>${esc(tx('rp.tpl.summary', { level: levelText(v.template.level) }))}</summary>
      <ul>${tplNotes}</ul>
    </details>

    <footer class="disclaimer">
      ${tx('rp.disclaimer', { err: TUNING.speedErrorPct })}
    </footer>
  </article>`
}

/** 量化对比表：一个仓库的全部变体 */
export function renderRepoTable(repo, rows, hwName) {
  const sorted = [...rows].sort((a, b) => {
    // 读失败的行永远沉底：它们没有量化信息，混在中间会让人以为也是候选
    if (!!a.error !== !!b.error) return a.error ? 1 : -1
    if (a.error && b.error) return 0
    const qa = a.quant ?? '', qb = b.quant ?? ''
    const na = Number((/Q(\d+)/i.exec(qa) ?? [])[1] ?? 99)
    const nb = Number((/Q(\d+)/i.exec(qb) ?? [])[1] ?? 99)
    return nb - na || (a.weights ?? 0) - (b.weights ?? 0)
  })

  const body = sorted.map((r) => {
    // 行得能点。以前表格底下写着「点任意一行可以看完整报告」，但 tr 上根本没有
    // data-url，事件绑不上去 —— 文案在承诺一个不存在的行为。
    const url = r.url ? ` data-url="${safe(r.url)}"` : ''
    if (r.error) {
      return `<tr class="err"${url}><td>${safe(r.file ?? '?')}</td><td colspan="4">${safe(r.error)}</td></tr>`
    }
    const v = r.view ?? r
    const cls = v.verdict.level
    return `<tr class="${cls}"${url}>
      <td class="q">${esc(v.quant)}</td>
      <td class="num">${esc(v.size)}</td>
      <td class="num">${v.bestCtx ? esc(v.bestCtxText) : '—'}</td>
      <td class="num">${v.speed ? `~${v.speed} tok/s` : '—'}</td>
      <td class="res">${esc(v.verdict.short ?? v.verdict.title)}</td>
    </tr>`
  }).join('')

  const clickable = sorted.some((r) => r.url)

  return `<article class="card">
    <div class="head">
      <div class="h-name">${safe(repo)}</div>
      <div class="h-meta"><span class="chip">${tx('rp.repo.variants', { n: rows.length })}</span>${hwName ? `<span class="chip ghost">${safe(hwName)}</span>` : ''}</div>
    </div>
    <table class="repo">
      <thead><tr><th>${tx('rp.col.quant')}</th><th class="num">${tx('rp.col.size')}</th><th class="num">${tx('rp.col.ctx')}</th><th class="num">${tx('rp.col.speed')}</th><th class="res">${tx('rp.col.verdict')}</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <footer class="disclaimer">
      ${tx('rp.repo.note')}
      ${clickable ? tx('rp.repo.click') : ''}
    </footer>
  </article>`
}

/**
 * 「参数与假设」面板。
 *
 * 网页上不写死文案，直接渲染 core/assumptions.mjs 里的清单 ——
 * 和 assess() 用的是同一份常量，改一处三处同步，不会出现「文档说 200 MiB、
 * 代码算 400 MiB」这种最难查的问题。
 */
export function renderAssumptions() {
  // 走 assumptionsList()：它按当前 locale 把 [中文, English] 展开成一个值。
  // 直接用 ASSUMPTIONS 拼字符串会把两个语种一起印出来（"权重体积,Weight size"）。
  const groups = assumptionsList().map((g) => `
    <div class="asm-group">
      <h4>${esc(g.group)}</h4>
      <dl>${g.items.map((it) => `
        <dt>${esc(it.k)}</dt>
        <dd><b>${esc(it.v)}</b>${it.note ? `<span>${esc(it.note)}</span>` : ''}</dd>`).join('')}
      </dl>
    </div>`).join('')

  return `<details class="assumptions">
    <summary>${tx('rp.asm.summary')}</summary>
    <p class="asm-lead">
      ${tx('rp.asm.lead')}
    </p>
    ${groups}
    <div class="asm-group">
      <h4>${tx('rp.asm.howto')}</h4>
      <dl>
        <dt>${tx('rp.asm.read.k')}</dt><dd><b>${tx('rp.asm.read.v')}</b><span>${tx('rp.asm.read.n')}</span></dd>
        <dt>${tx('rp.asm.derived.k')}</dt><dd><b>${tx('rp.asm.derived.v')}</b><span>${tx('rp.asm.derived.n')}</span></dd>
        <dt>${tx('rp.asm.set.k')}</dt><dd><b>${tx('rp.asm.set.v')}</b><span>${tx('rp.asm.set.n')}</span></dd>
      </dl>
    </div>
  </details>`
}
