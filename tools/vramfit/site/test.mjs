/**
 * 网页版测试（node:test，无第三方依赖）
 *
 *   cd site && node --test test.mjs
 *
 * 解析和推算不在这里测 —— 那是根目录 test.mjs 的活，两边共用同一份 core/。
 * 这里只管网页自己会出错的地方：
 *   1. 渲染：任何分支都不许出现 undefined / NaN，转义只做一次
 *   2. 显卡识别：型号表顺序、软件渲染、统一内存
 *   3. 构建：dist/ 必须和源码一致，忘了构建会在这里直接失败
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, readdir } from 'node:fs/promises'

import { assess, assumptionsList } from '../core/index.mjs'
import { buildHtml, writeSite, DIST, MODULES, sourcePath } from './build.mjs'

// 网页模块 import 的是 '../core/index.mjs'（core 就在仓库根），
// 只有构建后的 dist/ 里这个相对路径才成立。所以测试跑 dist/ 里的那份 ——
// 也就是真正会被上传的那份，而不是源码树里一个浏览器根本加载不了的副本。
const present = await readFile(path.join(DIST, 'index.html'), 'utf8').catch(() => null)
if (present === null) await writeSite(await buildHtml())

const { buildView, renderView, renderRepoTable, renderAssumptions } = await import('./dist/web/report.mjs')
const { matchGpu, buildHardware, isSoftwareRenderer } = await import('./dist/web/gpu.mjs')

const GB = 1024 ** 3

/** 网页测试共用的一份元数据：Qwen3-8B Q4_K_M，8 GB 卡 */
const meta = {
  file: 'Qwen3-8B-Q4_K_M.gguf', sizeBytes: 5027784512, arch: 'qwen3', name: 'Qwen3-8B',
  chatTemplate: '{% if tools %}<tool_call>{% endif %}', blockCount: 36, headCount: 32,
  headKv: 8, embdLength: 4096, contextLength: 40960, fileType: 15, tensorCount: 398,
  paramCount: 8.2e9
}
const hw = {
  gpus: [{ name: 'RTX 3050', totalBytes: 8 * GB, usedBytes: 0.8 * GB, bandwidthGBps: 224 }],
  ramBytes: 16 * GB, ramBandwidthGBps: 60, osPlatform: 'win32'
}

const view = (m = meta, h = hw, o = {}) => {
  const r = assess(m, h, o)
  return { r, v: buildView(m, r, o) }
}

// ───────────────────────── 报告渲染 ─────────────────────────

test('网页报告：进度条百分比和标题里的 GB 数一致', () => {
  const { v } = view(meta, hw, { kvType: 'f16' })
  const html = renderView(v)
  const pct = Number(/class="meter"><i style="width:(\d+)%/.exec(html)[1])
  assert.equal(pct, Math.round(v.ratio * 100), '进度条宽度和 ratio 不一致')
  // 进度条必须按「权重 + KV + 开销」算，只算权重会比标题数字小一大截
  assert.ok(Math.abs(v.ratio - v.totalBytes / v.limit) < 1e-9, 'ratio 没算上 KV 和开销')
  assert.ok(html.includes(v.totalText), '标题里该出现总量')
})

test('网页报告：数值不会渲染成 undefined / NaN', () => {
  assert.doesNotMatch(renderView(view().v), /undefined|NaN/)
  // 没有显卡（CPU 推理）时也不能崩
  const cpu = buildHardware(null, { ramGB: 16 })
  const rc = assess(meta, cpu, {})
  const vc = buildView(meta, rc, {})
  assert.doesNotMatch(renderView(vc), /undefined|NaN/)
  assert.equal(vc.onCpu, true)
})

test('网页报告：远端文件名里的控制字符不能进入 HTML', () => {
  const evil = { ...meta, file: 'evil\x1b]0;pwned\x07<script>alert(1)</script>.gguf' }
  const r = assess(evil, hw, {})
  const html = renderView(buildView(evil, r, {}))
  assert.doesNotMatch(html, /\x1b/, '控制字符没被洗掉')
  assert.ok(!html.includes('<script>alert(1)</script>'), '文件名没有被转义')
})

test('网页报告：装不下时给的是「装不下」而不是崩溃', () => {
  const big = { ...meta, file: 'Qwen3-32B-Q8_0.gguf', sizeBytes: 34e9, paramCount: 32e9, blockCount: 64 }
  const v = buildView(big, assess(big, hw, { weightsBytes: big.sizeBytes }), {})
  assert.equal(v.verdict.level, 'bad')
  assert.equal(v.bestCtx, null)
  assert.equal(v.bestCtxText, '—')
  assert.doesNotMatch(renderView(v), /undefined|NaN/)
})

test('网页报告：量化太低时，装得下也不能推荐', () => {
  // Q2/Q1 省下的显存会以「工具调用反复失败」的形式还回来，判定必须和命令行一致
  const q2meta = { ...meta, file: 'Qwen3-8B-Q2_K.gguf', sizeBytes: 3.1e9 }
  const q2 = buildView(q2meta, assess(q2meta, hw, { weightsBytes: 3.1e9 }), {})
  assert.equal(q2.verdict.level, 'bad')
  assert.equal(q2.verdict.short, '别用')

  const q4 = view().v
  assert.equal(q4.verdict.level, 'good')
  assert.equal(q4.verdict.short, '推荐')
})

test('网页报告：文件名里的 & 只能转义一次', () => {
  // buildView 曾经既洗控制字符又转义，renderView 再转义一次，
  // 于是 "Qwen & Co" 在页面上显示成 "Qwen &amp; Co"。
  const m = { ...meta, file: 'Qwen & Co-Q4_K_M.gguf', name: 'Qwen & Co' }
  const html = renderView(buildView(m, assess(m, hw, {}), {}))
  assert.ok(html.includes('Qwen &amp; Co'), '应该转义')
  assert.ok(!html.includes('&amp;amp;'), '转义了两次')
})

test('网页报告：没显卡时给的是 CPU 速度，不是「带宽未知」', () => {
  // onVram 在纯 CPU 推理时是 null，以前只看它，于是算得出来的 CPU 速度从不显示
  const cpu = buildHardware(null, { ramGB: 16 })
  const v = buildView(meta, assess(meta, cpu, {}), {})
  assert.equal(v.onCpu, true)
  assert.ok(v.speedOnCpu > 0, 'CPU 速度应该算得出来')
  const html = renderView(v)
  assert.ok(html.includes(`CPU 约 ${v.speedOnCpu} tok/s`))
  assert.ok(!html.includes('带宽未知'))
})

test('网页报告：元数据不全是「算不出来」，不是「装不下」', () => {
  // 两者下一步动作完全不同：一个该换文件，一个该换小模型。混成一句会把人带错方向。
  const broken = { ...meta, blockCount: undefined, headKv: undefined, embdLength: undefined }
  const r = assess(broken, hw, {})
  assert.equal(r.estimated, false)
  const v = buildView(broken, r, {})
  assert.equal(v.verdict.short, '算不出')
  const html = renderView(v)
  assert.doesNotMatch(html, /undefined|NaN/)
  assert.ok(!html.includes('超过这张卡的可用上限'), '不能报成装不下')
})

// ───────────────────────── 量化对比表 ─────────────────────────

test('网页报告：量化对比表按量化档位从高到低排', () => {
  const mk = (q, size) => ({ quant: q, size, bestCtx: 8192, bestCtxText: '8K', speed: 30, verdict: { level: 'good', title: '可以跑' } })
  const html = renderRepoTable('a/b', [
    { ...mk('Q4_K_M', '4.68 GB'), file: 'x' },
    { ...mk('Q8_0', '8.5 GB'), file: 'y' },
    { ...mk('Q2_K', '3.0 GB'), file: 'z' }
  ], 'RTX 3050')
  const order = [...html.matchAll(/<td class="q">([^<]+)<\/td>/g)].map((m) => m[1])
  assert.deepEqual(order, ['Q8_0', 'Q4_K_M', 'Q2_K'])
})

test('网页报告：量化对比表每一行都能点开（文案承诺了就得做到）', () => {
  const mk = (q, url) => ({
    quant: q, size: '4.68 GB', bestCtx: 8192, bestCtxText: '8K', speed: 30,
    verdict: { level: 'good', title: '可以跑', short: '推荐' }, url, file: 'x.gguf'
  })
  const html = renderRepoTable('a/b', [mk('Q4_K_M', 'https://hf-mirror.com/a/b/resolve/main/x.gguf')], '')
  // 没有 data-url 的话 app.mjs 里的 tr[data-url] 事件绑不上，点了没反应
  assert.ok(html.includes('data-url="https://hf-mirror.com/a/b/resolve/main/x.gguf"'), '行上缺少 data-url')
  assert.ok(html.includes('点任意一行'), '有可点的行时才提示可以点')
})

// ───────────────────────── 显卡识别 ─────────────────────────

test('显卡识别：常见浏览器的渲染器字符串', () => {
  const cases = [
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'RTX 4090'],
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'RTX 3050'],
    ['ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0, D3D11)', 'RX 7900 XTX'],
    ['ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)', 'Apple M2 Pro'],
    ['NVIDIA GeForce RTX 3060/PCIe/SSE2', 'RTX 3060']
  ]
  for (const [s, want] of cases) assert.equal(matchGpu(s)?.name, want, `没认出：${s}`)
})

test('显卡识别：带后缀的型号不能被短的抢先匹配', () => {
  // 表里 5070 Ti 必须排在 5070 前面，否则 5070 Ti 会被认成 5070（显存少 4 GB）
  assert.equal(matchGpu('NVIDIA GeForce RTX 5070 Ti')?.name, 'RTX 5070 Ti')
  assert.equal(matchGpu('NVIDIA GeForce RTX 4080 SUPER')?.name, 'RTX 4080 SUPER')
  assert.equal(matchGpu('NVIDIA GeForce RTX 3090 Ti')?.name, 'RTX 3090 Ti')
})

test('显卡识别：软件渲染不能当成真显卡', () => {
  for (const s of ['Microsoft Basic Render Driver', 'ANGLE (Google, Vulkan 1.3 SwiftShader)', '']) {
    assert.equal(matchGpu(s), null, `不该认出显卡：${s}`)
    assert.equal(isSoftwareRenderer(s), true)
  }
  assert.equal(isSoftwareRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 4090...)'), false)
})

test('显卡识别：Apple 统一内存按用户填的容量算', () => {
  const h = buildHardware({ name: 'Apple M2 Pro', vram: 0, bw: 200, unified: true }, { vramGB: 32, ramGB: 32 })
  assert.equal(h.gpus[0].totalBytes, 32 * GB)
  assert.equal(h.gpus[0].unified, true)
  assert.equal(h.gpus[0].usedBytes, 0, '统一内存不该扣已占用')
})

// ───────────────────────── 参数面板 ─────────────────────────

test('参数与假设：面板分组齐全、内容已转义', () => {
  const html = renderAssumptions()
  // 用 assumptionsList() 而不是原始 ASSUMPTIONS：后者是 [中文, English] 数组，
  // includes() 会把它当成 "中文,English" 去匹配，正好把这个 bug 盖住了。
  for (const g of assumptionsList()) {
    assert.ok(html.includes(g.group), `面板里缺少「${g.group}」`)
  }
  assert.ok(html.includes('200 MiB'), '运行时开销那一条要写具体数值')
  assert.doesNotMatch(html, /undefined|NaN/)
})

// ───────────────────────── 架构约束 ─────────────────────────

test('架构：网页引用的 DOM id 都存在于 src/index.html', async () => {
  const app = await readFile(new URL('./src/web/app.mjs', import.meta.url), 'utf8')
  const html = await readFile(new URL('./src/index.html', import.meta.url), 'utf8')
  const ids = [...new Set([...app.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]))]
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `index.html 里没有 #${id}`)
})

test('架构：网页自己的模块不许引 node: 内置模块', async () => {
  // 这一层要原样跑在浏览器里，一个 node: 就会白屏
  const dir = new URL('./src/web/', import.meta.url)
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.mjs')) continue
    const src = await readFile(new URL(f, dir), 'utf8')
    assert.doesNotMatch(src, /from ['"]node:/, `web/${f} 引入了 node: 模块，网页会崩`)
  }
})

// ───────────────────────── 构建产物 ─────────────────────────

test('单文件版：产物里不能残留 import / export 语句', async () => {
  // 漏掉一条 import 会让打包后的脚本直接 SyntaxError，
  // 而页面看起来完全正常 —— 只有交互全失效，和 file:// 那个坑一模一样。
  const html = await buildHtml()
  const code = html.slice(html.indexOf('<script>\n/* ── 极简模块表'))
  assert.doesNotMatch(code, /^\s*import\s+[{*]/m, '产物里还有 import 语句')
  assert.doesNotMatch(code, /^\s*export\s+(const|function|class|\{|\*)/m, '产物里还有 export 语句')
  // file:// 警告必须去掉，否则双击打开会看到一句没用的红字
  assert.doesNotMatch(html, /build:file-warning/, '单文件版不该保留 file:// 警告')
})

test('部署目录：dist/ 必须和源码逐字一致（改了源码就要重新构建）', async () => {
  // 这类失误很隐蔽：源码改好了、测试也过了，但用户下载到的还是旧产物。
  // 刚 clone 下来时 dist/ 可能还不存在，先补生成一次再比，免得一上来就红。
  const present = await readFile(path.join(DIST, 'index.html'), 'utf8').catch(() => null)
  if (present === null) await writeSite(await buildHtml())

  for (const id of MODULES) {
    const src = await readFile(sourcePath(id), 'utf8')
    const deployed = await readFile(path.join(DIST, id), 'utf8').catch(() => null)
    assert.ok(deployed !== null, `dist/${id} 不存在，跑 node build.mjs`)
    assert.equal(deployed, src, `dist/${id} 已过期，跑 node build.mjs`)
  }

  const single = await readFile(path.join(DIST, 'vramfit.html'), 'utf8').catch(() => null)
  assert.equal(single, await buildHtml(), 'dist/vramfit.html 已过期，跑 node build.mjs')

  // MIT 要求许可声明跟着副本走；dist/ 是会被部署/转手的那一份
  const lic = await readFile(path.join(DIST, 'LICENSE.txt'), 'utf8').catch(() => null)
  assert.equal(lic, await readFile(new URL('../LICENSE', import.meta.url), 'utf8'),
    'dist/LICENSE.txt 缺失或与根目录 LICENSE 不一致，跑 node build.mjs')
})

test('部署目录：多文件版要保留 file:// 提示，单文件版要删掉', async () => {
  const deployed = await readFile(path.join(DIST, 'index.html'), 'utf8').catch(() => null)
  assert.ok(deployed, 'dist/index.html 不存在，跑 node build.mjs')
  const single = await readFile(path.join(DIST, 'vramfit.html'), 'utf8')
  assert.match(deployed, /build:file-warning/, '多文件版双击打开时必须提示')
  assert.doesNotMatch(single, /build:file-warning/, '单文件版内联了脚本，这句提示反而会误导')
  assert.match(deployed, /src="\.\/web\/app\.mjs"/)
  assert.doesNotMatch(single, /src="\.\/web\/app\.mjs"/)
})

test('网页报告：模板说明不能渲染成 [object Object]', () => {
  // core 的 analyzeTemplate().notes 从「字符串数组」改成了 {ok, text}：
  // 调用方只要还按字符串塞进模板，页面上就是一行 [object Object]，而且不报错。
  const html = renderView(view().v)
  assert.doesNotMatch(html, /\[object Object\]/)
  assert.match(html, /模板含 tools 分支/, '模板说明的正文丢了')
  assert.match(html, /<i class="ok">✓<\/i>/, 'tools 分支那一行应该有 ✓ 标记')
})

test('网页报告：语言跟着页面走，界面与结论必须同一种语言', async () => {
  // 以前页面文案只有中文，core 却会跟着 locale 走，所以 app.mjs 把语言钉死在中文。
  // 现在文案进了词条表，语言改由页面决定（__VRAMFIT_LANG / <html lang>，默认中文），
  // 但 core 和界面词条表仍必须同时设定，否则英文系统上会出现「中文界面 + 英文结论」。
  const app = await readFile(new URL('./src/web/app.mjs', import.meta.url), 'utf8')
  assert.match(app, /localeOf\(globalThis\.__VRAMFIT_LANG \|\| document\.documentElement\.lang\)/)
  assert.match(app, /setLocale\(lang\)/, 'core 的语言要跟着页面设定')
  assert.match(app, /setUiLang\(lang\)/, '界面词条表也要跟着页面设定')
  assert.ok(buildView(meta, assess(meta, hw, {}), {}).verdict.title.includes('可以当')
    || buildView(meta, assess(meta, hw, {}), {}).verdict.title.includes('能跑'), '结论不是中文')
})
