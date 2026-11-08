/**
 * 网页版的交互层。
 *
 * 和命令行的差别只有三处：
 *   1. 输入来自 <input> 和拖拽，不是 argv
 *   2. 硬件来自查表 + WebGL 识别，不是 nvidia-smi
 *   3. 输出是 HTML，不是 ANSI
 * 中间那段（解析、推算、判定）两边跑的是同一份 core。
 */

import { parseHfInput, assess, totalWeightsBytes, setLocale } from '../core/index.mjs'
import { fetchGguf, listRepoGgufs } from '../net/hf.mjs'
import { readLocalGguf, isFirstShard } from './local.mjs'
import {
  detectRenderer, matchGpu, buildHardware, gpuOptions,
  UNIFIED_SIZES, isSoftwareRenderer
} from './gpu.mjs'
import { buildView, renderView, renderRepoTable, renderAssumptions } from './report.mjs'
import { localeOf, setUiLang, tx } from './strings.mjs'

// 界面语言跟着页面走。window.__VRAMFIT_LANG 由母站注入（页面 <html lang> 也认），
// 这样同一个 app.mjs 能被 roroto 站点和独立版共用：母站已经知道该显示什么语言，
// 独立版就看页面自己的 lang。都没有时兜底中文。
// core/i18n.mjs 和本文件的词条表必须同时设定，否则会出现「中文界面 + 英文结论」。
const lang = localeOf(globalThis.__VRAMFIT_LANG || document.documentElement.lang) || 'zh'
setLocale(lang)     // core/i18n.mjs 的，只接受 zh/en
setUiLang(lang)     // 本文件的词条表

const $ = (sel) => document.querySelector(sel)
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/**
 * 把 index.html 里不会动态变化的文案换成当前语言。
 *
 * 只处理「页面一打开就固定」的那几句。按钮在忙碌时、容量标题在切换显卡时还会
 * 再变，那些由 setBusy / updateVramVisibility 各自负责，这里只负责初始形态。
 * #about 那段介绍不参与 i18n（见 index.html 里的注释）。
 */
function localizeStatic() {
  const setText = (sel, text) => {
    const el = $(sel)
    if (el) el.textContent = text
  }

  $('#target').placeholder = tx('form.ph')
  setText('#go', tx('form.go'))
  setText('#drop-lead', tx('drop.local'))
  setText('#pick', tx('drop.pick'))
  setText('#drop-hint', tx('drop.hint'))
  setText('#share', tx('drop.share'))
  setText('#ex-lead', tx('ex.lead'))
  setText('#ex-qwen', tx('ex.qwen'))
  setText('#lbl-gpu', tx('hw.gpu'))
  setText('#lbl-mem', tx('hw.mem'))
  setText('#lbl-used', tx('hw.used'))
  setText('#lbl-kv', tx('hw.kv'))

  // #dragmask 的第一行是纯文本节点（后面跟着小的说明 span），
  // 外面再包一层会套上 .dm-box span 的小字样式，所以只能改 nodeValue。
  const box = $('#dragmask .dm-box')
  const lead = box && [...box.childNodes].find((n) => n.nodeType === 3 && n.nodeValue.trim())
  if (lead) lead.nodeValue = tx('drag.drop')
  setText('#drag-sub', tx('drag.sub'))
}

const state = {
  gpu: null,        // 当前选中的显卡条目
  renderer: '',     // 浏览器报的原始字符串
  detected: false,  // 是否由自动识别填入
  kvType: 'f16',
  busy: false
}

// ───────────────────────── 硬件选择 ─────────────────────────

function initGpuSelect() {
  const sel = $('#gpu')
  const groups = gpuOptions()
  sel.innerHTML = `<option value="">${tx('gpu.none')}</option>` +
    groups.map((g) => `<optgroup label="${esc(g.label)}">${
      g.items.map((it) => `<option value="${esc(it.name)}" data-vram="${it.vram}" data-bw="${it.bw}" data-unified="${it.unified ? 1 : 0}">${esc(it.name)}</option>`).join('')
    }</optgroup>`).join('')

  const renderer = detectRenderer()
  state.renderer = renderer
  const hit = matchGpu(renderer)

  if (hit) {
    state.gpu = hit
    state.detected = true
    // 表里可能有多个同型号选项（不同显存版本），按名字反选回去
    const opt = [...sel.options].find((o) => o.value === hit.name)
    if (opt) sel.value = hit.name
    $('#vram').value = hit.vram || ''
    $('#detect-note').textContent = tx('gpu.detected', { name: hit.name })
  } else if (!renderer) {
    $('#detect-note').textContent = tx('gpu.noinfo')
  } else if (isSoftwareRenderer(renderer)) {
    // 远程桌面、无头环境、虚拟机都会落到这里，报的是 Basic Render Driver
    $('#detect-note').textContent = tx('gpu.software')
  } else {
    $('#detect-note').textContent = tx('gpu.unknown', { renderer: renderer.slice(0, 44) })
  }
  updateVramVisibility()
}

function updateVramVisibility() {
  const g = state.gpu
  const need = !g || g.unified || g.vram === 0
  $('#vram-wrap').hidden = !need
  if (!need) return

  const unified = Boolean(g?.unified)
  const input = $('#vram')

  // #vram 是 <input type=number>。之前 Apple 统一内存分支往它里面写 <option>，
  // 而 input 没有子节点，innerHTML 直接被丢弃 —— 容量框永远空白，最后
  // buildHardware 拿到 0，静默退化成「CPU 推理」。改成只设 value 和取值范围。
  $('#vram-cap').textContent = unified ? tx('hw.cap.unified') : tx('hw.cap.vram')
  input.min = unified ? '8' : '1'
  input.step = unified ? '8' : '1'
  input.title = unified ? tx('hint.unified') : tx('hint.vram')
  if (unified) input.setAttribute('list', 'vram-sizes')
  else input.removeAttribute('list')

  const cur = Number(input.value)
  if (!cur || cur < (unified ? 8 : 1)) input.value = unified ? '32' : '8'
}

function onSelectChange() {
  const sel = $('#gpu')
  if (!sel.value) {
    state.gpu = null
    state.detected = false
    updateVramVisibility()
    return
  }
  const opt = sel.selectedOptions[0]
  state.gpu = {
    name: sel.value,
    vram: Number(opt.dataset.vram) || 0,
    bw: Number(opt.dataset.bw) || 0,
    unified: opt.dataset.unified === '1',
    kind: opt.dataset.unified === '1' ? 'unified' : 'discrete',
    vendor: 'other'
  }
  state.detected = false
  // Apple 芯片的显存就是买机器时选的内存，表里没有；给个常见起步值（32 GB），
  // 否则沿用上一张卡的 8 GB 会把结论算得过分悲观。
  if (state.gpu.unified) $('#vram').value = '32'
  else if (state.gpu.vram) $('#vram').value = state.gpu.vram
  updateVramVisibility()
}

function currentHardware() {
  const vramGB = Number($('#vram').value) || 0
  const ramGB = Number($('#ram').value) || 16
  return buildHardware(state.gpu, {
    vramGB,
    ramGB,
    usedGB: Number($('#used').value) || 0
  })
}

function hwLabel() {
  if (!state.gpu) return tx('hw.cpuOnly')
  const v = $('#vram').value
  return v ? `${state.gpu.name} · ${v} GB` : state.gpu.name
}

// ───────────────────────── 状态输出 ─────────────────────────

function setStatus(html, kind = '') {
  const el = $('#status')
  el.hidden = !html
  el.className = `status ${kind}`
  el.innerHTML = html
}

function setBusy(on) {
  state.busy = on
  $('#go').disabled = on
  $('#go').textContent = on ? tx('form.goBusy') : tx('form.go')
}

/**
 * 失败时给一句能照着做的话。
 *
 * 浏览器把网络、CORS、插件拦截统统报成 "Failed to fetch"，用户看不出该怎么办，
 * 也分不清是工具坏了还是网的问题。所以这里不解释技术名词，直接给下一步动作。
 */
function failHtml(e) {
  const msg = String(e?.message ?? e)
  const tips = []
  // 这些正则匹配的是「错误消息内容」，不是界面文案。消息来源有两边：
  //   - core/ 按 core 的 locale 抛，中文界面给中文、英文界面给英文；
  //   - net/hf.mjs 的网络错误目前只有中文（本工具没给 net 做翻译）。
  // 所以中英关键词都得列上，否则英文界面下永远匹配不到，tip 就一条都不给。
  if (/网络连不上|Failed to fetch|Load failed|请求超时|fetch failed|network|timeout|aborted/i.test(msg)) {
    tips.push(tx('app.tip.net'))
    tips.push(tx('app.tip.local'))
  }
  // 「不支持 Range」这句本身就含 Range，所以一条 \bRange\b 就能同时命中中英。
  if (/\bRange\b/i.test(msg)) {
    tips.push(tx('app.tip.range'))
  }
  // 中文这条由本文件和 net 抛，英文只由本文件的 tx 抛；两边关键词都要在。
  if (/没有可独立运行的|没有 \.gguf|no standalone|no \.gguf/i.test(msg)) {
    tips.push(tx('app.tip.pickFile'))
  }
  const tip = tips.length ? `<div class="status-tip">${tips.map((t) => esc(t)).join('<br>')}</div>` : ''
  return `<strong>${tx('app.err.title')}</strong><br>${esc(msg)}${tip}`
}

// ───────────────────────── 主流程 ─────────────────────────

async function run(rawInput, { fromUrl = false } = {}) {
  if (state.busy) return
  const raw = String(rawInput ?? '').trim()
  if (!raw) return

  const out = $('#output')
  out.innerHTML = ''
  setBusy(true)
  setStatus(tx('app.st.parse'))

  try {
    const parsed = parseHfInput(raw)
    if (parsed?.kind === 'invalid') throw new Error(parsed.reason)
    if (parsed?.note) setStatus(esc(parsed.note))

    const hw = currentHardware()

    if (parsed?.kind === 'repo') {
      await runRepo(parsed.repo, hw)
      return
    }
    if (parsed?.kind === 'file') {
      await runFile(parsed.url, hw)
      return
    }

    // 不是 HF 链接：可能是 owner/repo
    if (/^[\w.-]+\/[\w.-]+$/.test(raw)) {
      await runRepo(raw, hw)
      return
    }

    throw new Error(tx('app.err.notInput'))
  } catch (e) {
    setStatus(failHtml(e), 'bad')
  } finally {
    setBusy(false)
  }
}

async function runFile(url, hw) {
  setStatus(tx('app.st.header'))
  const meta = await fetchGguf(url)
  const result = assess(meta, hw, {
    kvType: state.kvType,
    weightsBytes: totalWeightsBytes(meta)
  })
  const view = buildView(meta, result, { kvType: state.kvType })
  $('#output').innerHTML = renderView(view)
  setStatus('')
  syncUrl({ u: url, gpu: state.gpu?.name, vram: $('#vram').value || '', kv: state.kvType })
}

async function runRepo(repo, hw) {
  setStatus(tx('app.st.list', { repo: esc(repo) }))
  const list = await listRepoGgufs(repo)
  if (!list.urls.length) throw new Error(tx('app.err.noGgufInRepo'))

  const rows = []
  const total = list.urls.length
  let done = 0
  const limit = 3          // 同时只读 3 个，再多会把镜像打出限流

  const queue = [...list.urls]
  async function worker() {
    while (queue.length) {
      const url = queue.shift()
      try {
        const meta = await fetchGguf(url)
        const result = assess(meta, hw, {
          kvType: state.kvType,
          weightsBytes: totalWeightsBytes(meta)
        })
        const view = buildView(meta, result, { kvType: state.kvType })
        rows.push({ ...view, url, file: meta.file, hasTemplate: !!meta.chatTemplate, best: view.bestCtx })
      } catch (e) {
        rows.push({ error: e.message, file: url, url })
      }
      done++
      setStatus(tx('app.st.reading', { done, total }))
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, total) }, worker))

  $('#output').innerHTML = renderRepoTable(repo, rows, hwLabel())
  // 行点击 → 看这一份的完整报告
  $('#output').querySelectorAll('tr[data-url]').forEach((tr) => {
    tr.addEventListener('click', () => {
      $('#target').value = tr.dataset.url
      run(tr.dataset.url)
    })
  })
  setStatus('')
  syncUrl({ m: repo, gpu: state.gpu?.name, vram: $('#vram').value || '', kv: state.kvType })
}

async function runLocalFiles(files) {
  if (state.busy) return
  setBusy(true)
  $('#output').innerHTML = ''
  try {
    const hw = currentHardware()
    const ggufs = [...files].filter((f) => /\.gguf$/i.test(f.name))
    if (!ggufs.length) throw new Error(tx('app.err.noGgufInFiles'))

    const first = ggufs.find((f) => isFirstShard(f.name)) ?? ggufs[0]
    setStatus(tx('app.st.readOne', { name: esc(first.name) }))
    const meta = await readLocalGguf(first)
    const result = assess(meta, hw, {
      kvType: state.kvType,
      weightsBytes: totalWeightsBytes(meta)
    })
    const view = buildView(meta, result, { kvType: state.kvType })
    $('#output').innerHTML = renderView(view)
    setStatus(ggufs.length > 1 ? tx('app.st.firstOnly', { n: ggufs.length }) : '')
    syncUrl({ gpu: state.gpu?.name, vram: $('#vram').value || '', kv: state.kvType })
  } catch (e) {
    setStatus(failHtml(e), 'bad')
  } finally {
    setBusy(false)
  }
}

// ───────────────────────── 分享链接 ─────────────────────────

function syncUrl(params) {
  const u = new URL(location.href)
  u.search = ''
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v)
  history.replaceState(null, '', u.toString())
  const btn = $('#share')
  btn.hidden = false
  btn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(u.toString())
      btn.textContent = tx('drop.shared')
      setTimeout(() => { btn.textContent = tx('drop.share') }, 1600)
    } catch {
      setStatus(tx('drop.shareFail'))
    }
  }
}

function restoreFromUrl() {
  const q = new URLSearchParams(location.search)
  const gpuName = q.get('gpu')
  const vram = q.get('vram')
  const kv = q.get('kv')
  if (kv === 'q8_0' || kv === 'q4_0' || kv === 'f16') {
    state.kvType = kv
    $('#kv').value = kv
  }
  if (gpuName) {
    const sel = $('#gpu')
    const opt = [...sel.options].find((o) => o.value === gpuName)
    if (opt) {
      sel.value = gpuName
      onSelectChange()
    }
  }
  if (vram) $('#vram').value = vram

  const u = q.get('u')
  const m = q.get('m')
  if (u) { $('#target').value = u; run(u, { fromUrl: true }) }
  else if (m) { $('#target').value = m; run(m, { fromUrl: true }) }
}

// ───────────────────────── 初始化 ─────────────────────────

function init() {
  localizeStatic()
  initGpuSelect()

  // Apple 统一内存的常见档位，做成输入框的候选列表（不强制）
  const dl = document.createElement('datalist')
  dl.id = 'vram-sizes'
  dl.innerHTML = UNIFIED_SIZES.map((n) => `<option value="${n}">`).join('')
  document.body.appendChild(dl)

  // 参数与假设直接由 core 渲染，不在这里写死文案 —— 两边各写一份迟早对不上
  const asm = $('#assumptions')
  if (asm) asm.innerHTML = renderAssumptions()

  $('#gpu').addEventListener('change', onSelectChange)
  $('#vram').addEventListener('change', () => {
    if (state.busy) return
    const t = $('#target').value.trim()
    if (t) run(t)
  })
  $('#kv').addEventListener('change', () => {
    state.kvType = $('#kv').value
    const t = $('#target').value.trim()
    if (t) run(t)
  })

  $('#form').addEventListener('submit', (e) => {
    e.preventDefault()
    run($('#target').value)
  })

  // 示例：一点就跑，省掉「我该贴什么」的犹豫
  document.querySelectorAll('.ex').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.target
      $('#target').value = t
      run(t)
    })
  })

  // 拖拽：整页都能接，不再只是那条虚线。
  // 原先只在 #drop 上监听，文件拖到页面中间时浏览器会用默认行为「打开」它 ——
  // 页面直接跳走，用户看到的就是「拖拽不好用」。这里改成 window 级接管，
  // 并且拖入时铺一层遮罩，让「可以松手了」这件事一眼可见。
  const mask = $('#dragmask')
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files')
  let dragDepth = 0

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth++
    mask.classList.add('on')
  })
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()              // 不阻止默认行为的话 drop 事件根本不会触发
    e.dataTransfer.dropEffect = 'copy'
  })
  window.addEventListener('dragleave', (e) => {
    // 拖过子元素也会触发 dragleave，用计数抵消掉闪烁
    if (!hasFiles(e)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) mask.classList.remove('on')
  })
  window.addEventListener('drop', (e) => {
    e.preventDefault()              // 无条件拦掉，否则浏览器会打开这个文件
    dragDepth = 0
    mask.classList.remove('on')
    const dt = e.dataTransfer
    if (dt?.files?.length) { runLocalFiles(dt.files); return }
    const text = dt?.getData('text/uri-list') || dt?.getData('text/plain')
    if (text) { $('#target').value = text.trim(); run(text) }
  })

  // 不想拖的人走这条。没有这个入口时，触控板/远程桌面用户基本没法用本地文件。
  $('#pick').addEventListener('click', () => $('#file').click())
  $('#file').addEventListener('change', (e) => {
    if (e.target.files?.length) runLocalFiles(e.target.files)
    e.target.value = ''             // 清空，否则选同一个文件不会再触发 change
  })

  // 粘贴链接时直接开跑，省一次点击
  $('#target').addEventListener('paste', () => {
    setTimeout(() => {
      const v = $('#target').value.trim()
      if (/gguf|huggingface|hf-mirror|^[\w.-]+\/[\w.-]+$/i.test(v)) run(v)
    }, 60)
  })

  restoreFromUrl()
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
else init()
