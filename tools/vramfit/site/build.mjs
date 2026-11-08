/**
 * 网页版构建脚本。产出两个东西：
 *
 *   1. dist/                 纯静态部署目录，整个上传即可（多文件版）
 *   2. dist/vramfit.html  单文件版，双击即用，不需要服务器也不需要 Node
 *
 * 源码有两处：
 *   - ./src/        网页自己的东西：index.html + web/（显卡表、渲染、事件）
 *   - ../            解析与推算层：core/ + net/。命令行和网页共用这一份，
 *                   不复制、不改写，构建时直接读过来，保证两边数字永远一致。
 *
 * 所以这两个目录必须保持兄弟关系。单独把 site/ 拷到别处，dist/ 还能照常用
 * （那是完整产物），但重新构建会找不到 core/，脚本会直接说清楚缺什么。
 *
 * 为什么需要这个：浏览器不允许 file:// 页面加载 <script type="module">，
 * 所以「下载下来双击 index.html」这条路在多文件版本里根本走不通 ——
 * 页面长得正常，但拖拽、检查全都没反应，用户只会觉得工具坏了。
 * 单文件版把代码内联进同一个 <script>，双击即可用。
 *
 * 这里不做任何压缩或混淆：产物是给人看、给人改的，可读性比体积重要。
 * 打包方式是极简的模块注册表，不做作用域扁平化 —— 扁平化一遇到重名就炸，
 * 而现在每个模块各自包一个函数，天然隔离。
 */

import { readFile, writeFile, mkdir, rm, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(ROOT, 'src')
const DIST = path.join(ROOT, 'dist')
const OUT_FILE = path.join(DIST, 'vramfit.html')
// 解析层现在就在仓库根（site/ 的上一层）——不再是 ../github/。
const ENGINE = path.join(ROOT, '..')

/**
 * 模块 id 就是它在 dist/ 里的相对路径（去掉 .mjs）。
 * 顺序是拓扑序，被依赖的放前面。core/ 与 net/ 来自仓库根，web/ 来自 ./src/。
 */
const MODULES = [
  'core/util.mjs',
  // 界面文案：quant / assess / assumptions 都 import 它，必须排在它们前面
  'core/i18n.mjs',
  'core/assumptions.mjs',
  'core/gguf.mjs',
  'core/input.mjs',
  'core/quant.mjs',
  'core/assess.mjs',
  'core/index.mjs',
  'net/hf.mjs',
  // 界面词条表：gpu / report / app 都 import 它，必须排在它们前面
  'web/strings.mjs',
  'web/gpu.mjs',
  'web/local.mjs',
  'web/report.mjs',
  'web/app.mjs'
]

/** 引擎层（core / net）由命令行目录提供，其余都是网页自己的源码 */
const ENGINE_DIRS = new Set(['core', 'net'])

const modId = (file) => file.replace(/\.mjs$/, '')

/** 某个模块 id 对应的源文件绝对路径 */
export function sourcePath(file) {
  const [dir, ...rest] = file.split('/')
  const base = ENGINE_DIRS.has(dir) ? ENGINE : SRC
  return path.join(base, dir, ...rest)
}

async function readSource(file) {
  try {
    return await readFile(sourcePath(file), 'utf8')
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    const [dir] = file.split('/')
    if (ENGINE_DIRS.has(dir)) {
      throw new Error(
        `找不到 ${file}。网页版的解析层来自仓库根（core/ + net/），site/ 必须放在它下面一层。\n` +
          `  期望路径：${sourcePath(file)}`
      )
    }
    throw new Error(`找不到 ${file}（${sourcePath(file)}）`)
  }
}

/** 把 `a, b as c` 拆成 { local, exported } */
function parseSpecifiers(list) {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(\S+)\s+as\s+(\S+)$/.exec(s)
      return m ? { local: m[1], exported: m[2] } : { local: s, exported: s }
    })
}

/** 解构赋值用的写法：{ a, b: c } */
const destructure = (specs) =>
  specs.map((s) => (s.local === s.exported ? s.local : `${s.local}: ${s.exported}`)).join(', ')

/**
 * 把一个 ES module 转成 `__def(id, function (exports) { … })` 的函数体。
 *
 * 只处理本项目实际用到的语法，故意不做通用的 JS 解析：
 *   import { … } from '…'      export { … } from '…'
 *   export * from '…'          export { … }
 *   export function/async function/class/const/let/var NAME
 * 遇到别的写法（default 导出、import * as）直接报错，而不是悄悄生成错代码。
 */
function transform(file, src) {
  const dir = path.posix.dirname(file)
  const resolve = (spec) => {
    if (!spec.startsWith('.')) throw new Error(`${file}: 不支持的裸模块 ${spec}`)
    return modId(path.posix.normalize(path.posix.join(dir, spec)))
  }

  const exported = []

  if (/^\s*export\s+default/m.test(src)) throw new Error(`${file}: 不支持 export default`)
  if (/^\s*import\s+\*/m.test(src)) throw new Error(`${file}: 不支持 import * as`)

  // export * from './x.mjs' —— core/index.mjs 就是全靠这个转发
  src = src.replace(/^export\s+\*\s+from\s*(['"])([^'"]+)\1[ \t]*;?/gm, (_, q, spec) => {
    const id = resolve(spec)
    return `Object.assign(exports, __imp(${JSON.stringify(id)}))`
  })

  // export { a, b as c } from './x.mjs'
  src = src.replace(/^export\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2[ \t]*;?/gm, (_, list, q, spec) => {
    const specs = parseSpecifiers(list)
    for (const s of specs) exported.push(s.exported)
    return `const { ${destructure(specs)} } = __imp(${JSON.stringify(resolve(spec))})`
  })

  // export { a, b }（本地已经声明过）
  src = src.replace(/^export\s*\{([^}]*)\}[ \t]*;?/gm, (_, list) => {
    const specs = parseSpecifiers(list)
    for (const s of specs) exported.push(s.exported)
    return specs.map((s) => (s.local === s.exported ? '' : `exports.${s.exported} = ${s.local}`)).join('\n')
  })

  // import { a, b } from './x.mjs'
  src = src.replace(/^import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2[ \t]*;?/gm, (_, list, q, spec) => {
    const specs = parseSpecifiers(list)
    return `const { ${destructure(specs)} } = __imp(${JSON.stringify(resolve(spec))})`
  })

  // export function / async function / class / const / let / var
  src = src.replace(
    /^export\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    (_, kind, name) => {
      exported.push(name)
      return `${kind} ${name}`
    }
  )

  // 兜底：残留的裸 import 说明有没覆盖到的写法，宁可报错也不要生成坏产物
  const leftover = /^\s*import\s/m.exec(src)
  if (leftover) throw new Error(`${file}: 还有没处理的 import 语句`)

  const unique = [...new Set(exported)]
  const tail = unique.length ? `\n  Object.assign(exports, { ${unique.join(', ')} })` : ''
  return `__def(${JSON.stringify(modId(file))}, function (exports) {\n${src}${tail}\n})`
}

const RUNTIME = `
/* ── 极简模块表：让上面打包进来的模块能互相 import ── */
const __M = {}
function __def(id, fn) {
  const exports = {}
  __M[id] = exports
  fn(exports)
}
function __imp(id) {
  const m = __M[id]
  if (!m) throw new Error('模块没有打包进来：' + id)
  return m
}
`

/**
 * 生成单文件 HTML 的内容。
 *
 * 抽成函数是为了让测试能直接比对 —— 「改了源码忘了构建」是这类项目
 * 最容易发生的失误，而且线上表现是「功能没生效」，很难往构建上想。
 */
export async function buildHtml() {
  const parts = []
  for (const file of MODULES) {
    parts.push(transform(file, await readSource(file)))
  }

  const bundle = `${RUNTIME}\n${parts.join('\n\n')}`

  let html = await readFile(path.join(SRC, 'index.html'), 'utf8')

  // file:// 警告在单文件版里没有意义：这里脚本是内联的，本来就能跑
  html = html.replace(/<!-- build:file-warning -->[\s\S]*?<!-- \/build:file-warning -->/, '')

  const tag = '<script type="module" src="./web/app.mjs"></script>'
  if (!html.includes(tag)) throw new Error('src/index.html 里没找到外链 script，构建可能已经过时')
  html = html.replace(tag, `<script>\n${bundle}\n</script>`)

  return html
}

const SITE_README = `这个目录是构建产物，不要直接改。

源码分两处：
    ../src/        网页自己的（index.html + web/）
    ../../            解析与推算层（core/ + net/），命令行和网页共用

改完源码后在 site/ 目录运行：
    node build.mjs

目录里是什么：
    index.html        网页版入口（多文件版，需要 http 打开）
    core/ net/ web/   index.html 依赖的 ES 模块，路径不能动
    vramfit.html      单文件版，双击就能用，不需要服务器也不需要 Node
    LICENSE.txt       MIT 许可全文。把本目录部署出去时请保留它 —— 这是 MIT 的唯一硬性要求

部署：整个目录原样上传到任意静态托管（Cloudflare Pages / Vercel / GitHub Pages / nginx），
不需要 Node、不需要后端、不需要环境变量。
`

async function writeSite(html) {
  // 先清空再写：上一版残留的模块会让人以为「改了没生效」
  await rm(DIST, { recursive: true, force: true })
  await mkdir(DIST, { recursive: true })

  for (const rel of MODULES) {
    const dest = path.join(DIST, rel)
    await mkdir(path.dirname(dest), { recursive: true })
    await writeFile(dest, await readSource(rel), 'utf8')
  }

  await writeFile(path.join(DIST, 'index.html'), await readFile(path.join(SRC, 'index.html'), 'utf8'), 'utf8')
  await writeFile(OUT_FILE, html, 'utf8')
  await writeFile(path.join(DIST, 'README.txt'), SITE_README, 'utf8')
  // MIT 要求把许可声明跟着副本走。别人把 dist/ 拿去部署时，这条就是他的义务凭证。
  await writeFile(path.join(DIST, 'LICENSE.txt'), await readFile(path.join(ENGINE, 'LICENSE'), 'utf8'), 'utf8')
  return MODULES.length + 4
}

async function main() {
  // 早报错：两个目录被拆散时，后面每一步都会变成看不懂的 ENOENT
  await access(path.join(ENGINE, 'core', 'index.mjs')).catch(() => {
    throw new Error(`找不到 ${path.join(ENGINE, 'core')}。site/ 必须放在仓库根里面一层。`)
  })

  const html = await buildHtml()
  await mkdir(DIST, { recursive: true })
  await writeFile(OUT_FILE, html, 'utf8')

  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)
  console.log(`已生成 dist/vramfit.html（${kb} KB，内联 ${MODULES.length} 个模块）`)

  const n = await writeSite(html)
  console.log(`已生成 dist/（${n} 个文件，整个目录上传静态托管）`)
}

export { DIST, MODULES, writeSite }

// 被测试 import 时不要执行构建，只有直接运行才写文件
const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (direct) {
  main().catch((e) => {
    console.error('构建失败:', e.message)
    process.exit(1)
  })
}
