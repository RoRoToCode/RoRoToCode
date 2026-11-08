/**
 * 网页界面的词条表。和 core/i18n.mjs 是两个东西，别混：
 *
 *   core/i18n.mjs   结论、档位、假设清单 —— 命令行和网页共用，是「报告内容」
 *   本文件          表单标签、按钮、表头、状态提示 —— 只有网页有，是「界面壳子」
 *
 * 分开的理由：命令行根本不需要「粘贴链接」「松开即可检查」这些字，把它们塞进
 * core 的词条表会让 CLI 的字典白白胖胖一倍，测试里还要为网页文案写断言。
 *
 * 结构和 core 那边刻意不同：这里用对象 { zh, en }，不是 [中文, English] 数组。
 *   - 加语种只加一个字段，不用改 t() 的下标运算
 *   - 某个语种没翻时能显式回退（es → en → zh），而不是让 undefined 漏到页面上
 * core 那边是二元组，因为它要保证「两种语言必须都翻」，缺一条测试就报错；
 * 网页这边语种是逐步加的，回退比报错更合适。
 */

/** 支持的语言，第一个是兜底 */
export const UI_LOCALES = ['zh', 'en']

/** 回退顺序：当前语言 → 英文 → 中文 */
const FALLBACK = ['en', 'zh']

/**
 * 词条。key 用「区域.用途」，区域和页面结构对齐：
 *   form.*    输入框、按钮、拖拽区
 *   hw.*      硬件那条工具条
 *   gpu.*     自动识别后的提示
 *   app.*     交互过程中的状态与报错
 *   rp.*      report.mjs 渲染出来的报告
 *
 * 术语不翻：GGUF / KV cache / Q4_K_M / tok/s / MoE 在英文里也是这些字。
 * 数字和单位不本地化，全局统一 `12.34 GB`。
 */
const DICT = {
  // ── 输入区 ──
  'form.ph': { zh: '粘贴 hf-mirror / huggingface 链接，或 owner/repo', en: 'Paste an hf-mirror or HuggingFace link, or owner/repo' },
  'form.go': { zh: '检查', en: 'Check' },
  'form.goBusy': { zh: '检查中…', en: 'Checking…' },
  'drop.local': { zh: '本地模型：直接拖进来，或', en: 'Local model: drop it here, or' },
  'drop.pick': { zh: '选择文件', en: 'choose a file' },
  'drop.hint': { zh: '（文件不出浏览器，只读头部几 MB）', en: '(the file never leaves your browser — only the first few MB are read)' },
  'drop.share': { zh: '复制分享链接', en: 'Copy share link' },
  'drop.shared': { zh: '已复制', en: 'Copied' },
  'drop.shareFail': { zh: '复制失败，可以手动复制地址栏', en: "Copy failed — you can copy the address bar by hand" },
  'ex.lead': { zh: '没想好查什么？', en: 'Not sure what to check?' },
  'ex.qwen': { zh: '看 Qwen3-8B 的全部量化', en: 'See every quant of Qwen3-8B' },
  'drag.drop': { zh: '松开即可检查', en: 'Drop to check' },
  'drag.sub': { zh: '.gguf · 不会上传，只读头部', en: '.gguf · never uploaded, only the header is read' },

  // ── 硬件工具条 ──
  'hw.gpu': { zh: '显卡', en: 'GPU' },
  'hw.mem': { zh: '系统内存', en: 'System RAM' },
  'hw.used': { zh: '已占用', en: 'In use' },
  'hw.kv': { zh: 'KV 精度', en: 'KV precision' },
  'hw.cap.vram': { zh: '显存', en: 'VRAM' },
  'hw.cap.unified': { zh: '统一内存', en: 'Unified memory' },
  'hw.cpuOnly': { zh: 'CPU 推理', en: 'CPU inference' },
  'hw.other': { zh: '其它', en: 'Other' },
  'hw.igpu.arc': { zh: 'Intel Arc 核显', en: 'Intel Arc iGPU' },
  'hw.igpu.intel': { zh: 'Intel 核显', en: 'Intel iGPU' },
  'hw.igpu.amd': { zh: 'AMD 核显', en: 'AMD iGPU' },

  // ── 显卡识别提示 ──
  'gpu.none': { zh: '没认出来 / 选一下你的卡', en: 'Not detected — pick your card' },
  'gpu.detected': { zh: '浏览器报的是 {name}', en: 'The browser reports {name}' },
  'gpu.noinfo': { zh: '浏览器没给出显卡信息，请在左边手动选', en: 'The browser gave no GPU information — pick one on the left' },
  'gpu.software': { zh: '没检测到独立显卡（当前是软件渲染），请在左边手动选', en: 'No discrete GPU detected (software rendering) — pick one on the left' },
  'gpu.unknown': { zh: '认不出这个型号，请在左边手动选：{renderer}', en: 'Unrecognised model — pick one on the left: {renderer}' },
  'hint.vram': { zh: '显卡显存容量，单位 GB；不确定就查一下型号', en: 'VRAM capacity in GB; look up the model if unsure' },
  'hint.unified': { zh: 'Apple Silicon 的统一内存就是买机器时选的内存容量，浏览器读不到，请按实际填', en: 'On Apple Silicon, unified memory is the RAM you picked when buying the machine. The browser cannot read it, so enter the real value.' },

  // ── 状态与报错 ──
  'app.st.parse': { zh: '正在识别输入…', en: 'Reading the input…' },
  'app.st.header': { zh: '只读文件头部，不下载整个模型…', en: 'Reading only the file header, not the whole model…' },
  'app.st.list': { zh: '正在取 {repo} 的文件列表…', en: 'Fetching the file list of {repo}…' },
  'app.st.reading': { zh: '读取中 {done}/{total}…', en: 'Reading {done}/{total}…' },
  'app.st.readOne': { zh: '读取 {name}…', en: 'Reading {name}…' },
  'app.st.firstOnly': { zh: '共收到 {n} 个文件，只查了第一个（分片模型只认第一片）', en: '{n} files received — only the first one was checked (only the first shard of a split model counts)' },
  'app.err.notInput': { zh: '没认出这是链接还是文件。贴 HuggingFace 的模型页地址，或者把 .gguf 拖进来', en: 'That is neither a link nor a file. Paste a HuggingFace model page URL, or drop a .gguf here.' },
  'app.err.noGgufInRepo': { zh: '这个仓库里没有可独立运行的 .gguf', en: 'This repository has no .gguf you could run on its own' },
  'app.err.noGgufInFiles': { zh: '这些文件里没有 .gguf', en: 'None of these files is a .gguf' },
  'app.err.title': { zh: '没查成', en: 'Check failed' },
  'app.tip.net': { zh: '确认能打开 hf-mirror.com。浏览器里开了代理一般没问题，公司网络或广告拦截插件可能拦住请求。', en: 'Make sure hf-mirror.com opens in the browser. A normal proxy is fine; corporate networks and ad blockers sometimes block the request.' },
  'app.tip.local': { zh: '已经把 .gguf 下载到本地的，直接拖进来 —— 本地文件完全不经过网络。', en: 'If you already downloaded the .gguf, just drop it here — local files never touch the network.' },
  'app.tip.range': { zh: '这个地址只会整份下载。换成 hf-mirror 的直链，或者先下载到本地再拖进来。', en: 'This address can only be fetched whole. Use a direct hf-mirror link, or download the file first and drop it here.' },
  'app.tip.pickFile': { zh: '换个仓库，或者直接贴具体那个 .gguf 文件页面的地址。', en: 'Try another repository, or paste the URL of that specific .gguf file page.' },

  // ── 报告：概览 ──
  'rp.unknown': { zh: '未知', en: 'Unknown' },
  'rp.cantEstimate': { zh: '算不出', en: "Can't estimate" },
  'rp.cap.recommended': { zh: '推荐上下文', en: 'Suggested context' },
  'rp.budget.title': { zh: '显存占用', en: 'VRAM usage' },
  'rp.tiers.title': { zh: '不同上下文要多少显存', en: 'VRAM needed at each context size' },
  'rp.info.title': { zh: '模型信息', en: 'Model information' },
  'rp.note.meta': { zh: '缺元数据，KV cache 无法推算，所以只有权重体积可信。', en: 'Metadata is missing, so the KV cache cannot be derived. Only the weight size is trustworthy here.' },
  'rp.note.onCpu': { zh: '没有可用显卡，按 CPU 推理估算', en: 'No usable GPU — estimated as CPU inference' },
  'rp.legend.weights': { zh: '权重 {size}', en: 'Weights {size}' },
  'rp.legend.kv': { zh: 'KV {size}', en: 'KV {size}' },
  'rp.legend.overhead': { zh: '开销 {size}', en: 'Overhead {size}' },

  // ── 报告：速度与档位 ──
  'rp.speed.vram': { zh: '约 {n} tok/s', en: 'about {n} tok/s' },
  'rp.speed.cpu': { zh: 'CPU 约 {n} tok/s', en: 'about {n} tok/s on CPU' },
  'rp.speed.unknown': { zh: '带宽未知，不给估计', en: 'Bandwidth unknown — no speed estimate' },
  'rp.tier.ok': { zh: '够', en: 'Fits' },
  'rp.tier.tight': { zh: '勉强', en: 'Tight' },
  'rp.tier.no': { zh: '不够', en: "Won't fit" },
  'rp.tier.beyond': { zh: '超出原生', en: 'Past native' },

  // ── 报告：信息行 ──
  'rp.info.arch': { zh: '架构', en: 'Architecture' },
  'rp.info.params': { zh: '参数量', en: 'Parameters' },
  'rp.info.layers': { zh: '层数', en: 'Layers' },
  'rp.info.native': { zh: '原生上下文', en: 'Native context' },
  'rp.info.template': { zh: '对话模板', en: 'Chat template' },
  'rp.info.kv': { zh: 'KV 精度', en: 'KV precision' },
  'rp.info.moe': { zh: 'MoE', en: 'MoE' },
  'rp.info.shard': { zh: '分片', en: 'Shard' },
  'rp.info.layersVal': { zh: '{n} 层 · {att}', en: '{n} layers · {att}' },
  'rp.info.kvDefault': { zh: 'f16（默认）', en: 'f16 (default)' },
  'rp.info.shardVal': { zh: '第 {n} 片，体积按整模估算', en: 'shard {n}; size estimated from the whole model' },
  'rp.src.read': { zh: '读到', en: 'read' },
  'rp.src.derived': { zh: '算出', en: 'derived' },
  'rp.src.set': { zh: '设定', en: 'set' },

  // ── 报告：注意力与工具调用 ──
  'rp.att.plain': { zh: '{n} 层带 KV', en: '{n} carry KV' },
  'rp.att.swa': { zh: '{n} 层带 KV，其中 {full} 层全注意力、滑窗窗口 {win}', en: '{n} layers carry KV, of which {full} are full attention with a {win} sliding window' },
  'rp.att.interval': { zh: '{n} 层带 KV（混合线性注意力，按 {i}:1 推断）', en: '{n} layers carry KV (hybrid linear attention, inferred as {i}:1)' },
  'rp.moe': { zh: '{n} 专家，每 token 激活 {used} 个', en: '{n} experts, {used} active per token' },
  'rp.tpl.strong': { zh: '支持工具调用', en: 'supported' },
  'rp.tpl.partial': { zh: '支持工具调用（部分）', en: 'partially supported' },
  'rp.tpl.weak': { zh: '格式不全', en: 'format incomplete' },
  'rp.tpl.none': { zh: '不支持', en: 'not supported' },
  'rp.tpl.summary': { zh: '工具调用能力（{level}）', en: 'Tool calling ({level})' },
  'rp.disclaimer': { zh: '<strong>以上全部是静态推算，不是实测。</strong> 权重按文件体积、KV 按层数×head、速度按带宽÷权重算出来的，误差通常在 ±{err}% 以内，但要看实际驱动和参数设置。模板里有 tools 分支也不等于模型真会调工具。结论只用来排掉「根本不可能」的选项，不能当合格证 —— 请实际加载跑一次再决定。', en: '<strong>Everything above is a static estimate, not a measurement.</strong> Weights come from file size, KV from layers × heads, speed from bandwidth ÷ weight size, and the error is usually within ±{err}%. Real drivers and settings still decide. A tools branch in the template does not mean the model will reliably call tools. Use this to rule out what cannot possibly work, never as a certificate — load the model once before you commit.' },

  // ── 仓库对比表 ──
  'rp.repo.variants': { zh: '{n} 个变体', en: '{n} variants' },
  'rp.col.quant': { zh: '量化', en: 'Quant' },
  'rp.col.size': { zh: '体积', en: 'Size' },
  'rp.col.ctx': { zh: '上下文', en: 'Context' },
  'rp.col.speed': { zh: '速度', en: 'Speed' },
  'rp.col.verdict': { zh: '结论', en: 'Verdict' },
  'rp.repo.note': { zh: '静态推算，仅供参考；体积、上下文、速度都是估算值，下载后仍要实际加载验证。', en: 'Static estimates for reference only; size, context and speed are all approximate. Load the model after downloading to confirm.' },
  'rp.repo.click': { zh: '点任意一行可以看这个量化的完整报告。', en: 'Click any row for the full report on that quant.' },

  // ── 参数与假设面板 ──
  'rp.asm.summary': { zh: '这些数字是怎么算出来的（参数与假设）', en: 'How these numbers are produced (parameters and assumptions)' },
  'rp.asm.lead': { zh: '本工具不加载模型、不跑推理。下面每一个数字都写死在 <code>core/assumptions.mjs</code> 里，报告、网页、README 显示的是同一份。改动它们等于改结论，所以列出完整清单，而不是只给一句「仅供参考」。', en: 'This tool loads no model and runs no inference. Every number below lives in <code>core/assumptions.mjs</code>, and the report, the web page and the README all read the same copy. Changing them changes the verdict, so the full list is shown rather than a vague “for reference only”.' },
  'rp.asm.howto': { zh: '怎么读这份报告', en: 'How to read this report' },
  'rp.asm.read.k': { zh: '读到', en: 'read' },
  'rp.asm.read.v': { zh: '直接从 GGUF 元数据里取出的值', en: 'Taken straight from the GGUF metadata' },
  'rp.asm.read.n': { zh: '架构、层数、head 数、原生上下文', en: 'architecture, layers, head count, native context' },
  'rp.asm.derived.k': { zh: '算出', en: 'derived' },
  'rp.asm.derived.v': { zh: '用上面的参数推出来的值', en: 'Computed from the parameters above' },
  'rp.asm.derived.n': { zh: 'KV cache、显存占用、推荐上下文', en: 'KV cache, VRAM footprint, suggested context' },
  'rp.asm.set.k': { zh: '设定', en: 'set' },
  'rp.asm.set.v': { zh: '你在这页面上选的', en: 'What you chose on this page' },
  'rp.asm.set.n': { zh: '显卡、显存、已占用、KV 精度', en: 'GPU, VRAM, memory in use, KV precision' },
}

let current = UI_LOCALES[0]

/** 把各种写法归一：zh-CN / zh_CN / zh → zh，en-US → en；认不出返回 null */
export function localeOf(value) {
  const s = String(value ?? '').trim().toLowerCase()
  if (!s) return null
  if (/^zh\b/.test(s) || s === 'cn' || s === 'chs') return 'zh'
  if (/^en\b/.test(s)) return 'en'
  if (/^es\b/.test(s)) return 'en'   // 西语还没翻，先按英文显示，不要漏出中文
  return null
}

/** 显式设定界面语言。认不出就保持原样并返回当前值，不抛错 —— 页面语言由站点决定 */
export function setUiLang(v) {
  const hit = localeOf(v)
  if (hit && UI_LOCALES.includes(hit)) current = hit
  return current
}

export function uiLang() {
  return current
}

/**
 * 取界面文案。占位符 {name}，多余变量忽略、缺失变量原样保留 ——
 * 和 core/i18n.mjs 的 t() 保持同一套语义，漏传参数时看到的是 {n} 而不是 undefined。
 */
export function tx(key, vars) {
  const e = DICT[key]
  if (!e) return `⟪${key}⟫`
  let s = e[current] ?? e[FALLBACK[0]] ?? e[FALLBACK[1]]
  if (s === undefined) return `⟪${key}⟫`
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])))
  return s
}

/** 词条清单与完整性检查，测试用 */
export function uiDictStats() {
  const keys = Object.keys(DICT)
  const broken = keys.filter((k) => {
    const e = DICT[k]
    return !e || typeof e !== 'object' || !e.zh || !e.en
  })
  return { count: keys.length, keys, broken }
}
