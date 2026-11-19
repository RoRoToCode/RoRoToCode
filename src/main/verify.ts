/**
 * 自我验证：模型说「改完了」之后，程序自己判断这个项目该怎么验（测试 / 类型检查 / 构建），
 * 跑一遍再把结果喂回去。失败就让模型继续修，而不是把「已完成」直接交给用户。
 *
 * 只认几种常见工程，猜不到就静默跳过——绝不乱跑命令。
 *
 * 两个刻意的取舍：
 * 1) 有改动清单时优先只跑「受影响的测试」。改一个文件跑全量，在稍大的仓库里
 *    每轮多花几分钟，模型还得为这几分钟的输出付上下文。
 * 2) 失败时只回灌失败段落。一整屏「✓ 281 passed」对修 bug 毫无帮助，却能把
 *    小模型的窗口吃掉一半。
 */
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export interface VerifyPlan {
  command: string
  label: string
  /**
   * 是否需要对项目自带的测试脚本做独立 smoke 断言。
   * 当验证落到「模型自己写的 npm test」时，这个标记为 true，调用方据此
   * 判断这套测试有没有真的运行代码，而不是把存在性检查当成验证。
   */
  smoke?: boolean
  /**
   * 要做 smoke 断言的测试文件（相对工作区）。
   * JS/TS 由 resolveTestTarget 从 package.json 里抽；Python 没有 package.json，
   * 只能在这里直接给出来 —— 否则「存在性检查冒充运行验证」的检查对 Python 全线失效。
   */
  testFile?: string
}

const MAX_OUTPUT = 4000
const TIMEOUT = 240_000
/** 一条命令行里最多塞这么多个文件路径，再多就退化成跑全量 */
const MAX_RELATED = 12

interface PackageJson {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

async function readPackageJson(workspace: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8')) as PackageJson
  } catch {
    return null
  }
}

/**
 * 定位 `npm test` 实际会跑的脚本文件（用于独立 smoke 断言）。
 * 从 package.json 的 scripts.test 里抽出第一个形如 `node xxx.js` / `xxx.mjs` 的目标，
 * 猜不到返回 null —— 绝不乱猜乱跑。
 */
export async function resolveTestTarget(workspace: string): Promise<string | null> {
  const pkg = await readPackageJson(workspace)
  const test = pkg?.scripts?.test
  if (!test || /no test specified/i.test(test)) return null

  // 抓 `node 路径`、`xxx.mjs`、`xxx.cjs`、`xxx.js` 里最像脚本文件的那一个
  const candidates = [
    ...test.matchAll(/node\s+([^\s&|;]+)/g),
    ...test.matchAll(/(?:^|[\s&|;])([^\s&|;]+\.(?:mjs|cjs|js))\b/g)
  ].map((m) => m[1].replace(/^['"]|['"]$/g, ''))

  for (const c of candidates) {
    if (/\.(?:mjs|cjs|js)$/i.test(c)) {
      const abs = path.resolve(workspace, c)
      if (existsSync(abs)) return abs
    }
  }
  return null
}

/**
 * 独立 smoke 断言：不看模型自己写的测试，而是检查「这个测试脚本到底有没有真的运行代码」。
 *
 * 起因是一次实测：模型把 Playwright 下载卡住后，把「真浏览器验收」降级成一串
 * `html.includes('xxx')` 字符串检查，26 项全过，但一行游戏代码都没运行，
 * 核心控制 bug（键盘失灵）一个都没抓到。这种「让测试通过」而不是「让程序正确」
 * 的脚本是模型自写自验最常见的造假形态。
 *
 * 这里的判据是启发式、可解释的，专抓那一类：把「文件里有没有某个字符串」当作
 * 「功能是否正常」的测试。它不拦截合法的快照/文本比对测试，只点名那种
 * 把存在性检查冒充为运行验证的脚本。
 */
export interface SmokeAssertion {
  /** 命中的可疑断言，逐条点名 */
  suspicious: string[]
  /** 是否看起来只是在检查字符串存在性（没有启动任何运行时） */
  existenceOnly: boolean
}

const EXISTENCE_PATTERNS = [
  // fs.readFileSync(...).includes('...')  /  content.includes('...') 这类
  /\.includes\(\s*['"`]/,
  /\.indexOf\(\s*['"`]/,
  /\.match\(\s*['"`]/,
  /assert(?:Equal)?\.match/,
  // 读文件后只做文本比对
  /readFileSync\([^)]*\)\s*\.?\s*(?:\.includes|\.indexOf)/
]

/** 有没有任何「真的执行了程序」的迹象：启动浏览器 / 子进程 / 导入模块 / 调函数 */
const EXECUTION_PATTERNS = [
  /playwright|puppeteer|chromium|selenium|webdriver/i,
  /spawn\(|exec\(|execSync\(|fork\(/,
  // require 一个非内置模块才算「引进了程序」；require('fs')/'path' 这种只是拿工具，
  // 不能当成「运行了被测程序」，否则纯 includes 检查会因 require('fs') 被放过去
  /require\(['"](?!fs['"]|path['"]|os['"]|util['"]|assert['"]|node:)[^'"]+['"]\)/,
  /import\s*\(/,
  /\.launch\(|\.goto\(|\.click\(|\.press\(|new\s+Browser|open\(/,
  /getContext\(|requestAnimationFrame|\.render\(|\.animate\(/,
  /\.run\(|\.execute\(|\.eval\(/
]

/** 读进某个测试脚本，判断它是不是「存在性检查冒充运行验证」 */
export async function assertSmoke(testPath: string): Promise<SmokeAssertion> {
  const suspicious: string[] = []
  let existenceOnly = false
  try {
    const src = await fs.readFile(testPath, 'utf8')
    if (src.length < 40) return { suspicious, existenceOnly }

    const lines = src.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (EXISTENCE_PATTERNS.some((re) => re.test(line))) {
        suspicious.push(`第 ${i + 1} 行：${line.trim().slice(0, 120)}`)
      }
    }

    const hasExecution = EXECUTION_PATTERNS.some((re) => re.test(src))
    existenceOnly = suspicious.length > 0 && !hasExecution
  } catch {
    /* 读不到就不断言，不让 smoke 自己变成新的失败源 */
  }
  return { suspicious, existenceOnly }
}

function hasDep(pkg: PackageJson | null, name: string): boolean {
  if (!pkg) return false
  return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name])
}

function quote(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p
}

function uniq(list: string[]): string[] {
  return [...new Set(list)]
}

function rel(workspace: string, file: string): string {
  const r = path.relative(workspace, path.isAbsolute(file) ? file : path.join(workspace, file))
  return r.split(path.sep).join('/')
}

/** Python 项目的 marker：requirements.txt 也要算——轻量项目常常只有它 */
const PY_MARKERS = ['pyproject.toml', 'pytest.ini', 'setup.py', 'tests', 'requirements.txt']

/** 扫描时跳过的目录：这些里面不可能放我们要跑的测试 */
const PY_SCAN_SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  'release',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  'site-packages',
  '.idea',
  '.vscode',
  'coverage',
  '.cache',
  '.turbo',
  '.mypy_cache',
  '.pytest_cache',
  '.tox'
])

const PY_SCAN_MAX_FILES = 400
const PY_SCAN_MAX_DEPTH = 3

export interface PyProject {
  /** 工作区里的 .py 源文件（相对路径） */
  sources: string[]
  /** 其中的 test_*.py / *_test.py */
  tests: string[]
}

/**
 * 扫一遍工作区找 .py 和测试文件。
 *
 * 为什么要扫而不是只看 marker：一次实测里模型做了个围棋程序，只有 `main.py`
 * 和 `.roroto/tmp/test_main.py`，既没有 pyproject/pytest.ini，也没有 tests 目录 ——
 * 判定不成立，自动验证静默跳过，模型说「全部完成」就直接交付，两个核心 bug
 * 全靠用户手点才发现。所以「有 .py + 有 test_*.py」本身就必须算 Python 项目。
 *
 * 深度和文件数都有上限，且跳过 node_modules / venv 这类目录：这是「猜项目类型」，
 * 不是索引整个仓库，扫太深只会让每轮多做无用的 IO。
 */
export async function scanPyProject(workspace: string): Promise<PyProject> {
  const out: PyProject = { sources: [], tests: [] }
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth < 0 || out.sources.length >= PY_SCAN_MAX_FILES) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.sources.length >= PY_SCAN_MAX_FILES) return
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        // .roroto 只进 tmp：spill / trash / shots 里全是一次性产物
        if (e.name === '.roroto') {
          await walk(path.join(abs, 'tmp'), depth - 1)
          continue
        }
        if (PY_SCAN_SKIP.has(e.name) || e.name.startsWith('.')) continue
        await walk(abs, depth - 1)
        continue
      }
      if (!e.name.endsWith('.py')) continue
      const r = path.relative(workspace, abs).split(path.sep).join('/')
      out.sources.push(r)
      if (/^test_.*\.py$|_test\.py$/i.test(e.name)) out.tests.push(r)
    }
  }
  await walk(workspace, PY_SCAN_MAX_DEPTH)
  return { sources: uniq(out.sources), tests: uniq(out.tests) }
}

/** Python：按「模块名 → 可能的测试文件」猜，猜不到就不缩小范围 */
async function pythonTestsFor(workspace: string, changed: string[]): Promise<string[]> {
  const found: string[] = []
  for (const file of changed.slice(0, MAX_RELATED)) {
    if (!file.endsWith('.py')) continue
    const base = path.basename(file, '.py')
    if (base.startsWith('test_')) {
      found.push(rel(workspace, file))
      continue
    }
    const dir = path.dirname(rel(workspace, file))
    const candidates = [
      `tests/test_${base}.py`,
      `test/test_${base}.py`,
      `test_${base}.py`,
      `${dir}/test_${base}.py`,
      `tests/${dir}/test_${base}.py`,
      // 模型的一次性验证脚本按提示写在 .roroto/tmp/ 下，这里必须能找到
      `.roroto/tmp/test_${base}.py`
    ]
    for (const c of candidates) {
      if (existsSync(path.join(workspace, c))) {
        found.push(c)
        break
      }
    }
  }
  return uniq(found).filter((f) => existsSync(path.join(workspace, f)))
}

/**
 * 这台机器上 python 能不能 `-m pytest`。
 *
 * 只在「有 test_*.py 但没有 pytest marker」时问一次，结果在进程内缓存：
 * 每次收工都探一遍是白花的启动开销。探不到就按「脚本直跑」处理 ——
 * 轻量工作区里 `python test_x.py` 才是最可能跑得起来的那条路。
 */
let pytestProbe: Promise<boolean> | null = null

function pytestAvailable(): Promise<boolean> {
  if (!pytestProbe) {
    pytestProbe = new Promise<boolean>((resolve) => {
      let child
      try {
        child = spawn('python', ['-m', 'pytest', '--version'], { windowsHide: true })
      } catch {
        resolve(false)
        return
      }
      let settled = false
      const done = (v: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      }
      const timer = setTimeout(() => {
        try {
          if (process.platform === 'win32' && child.pid) {
            spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
          } else {
            child.kill()
          }
        } catch {
          /* 杀不掉就让它自己超时退出，不阻塞判定 */
        }
        done(false)
      }, 10_000)
      child.on('error', () => done(false))
      child.on('close', (code) => done(code === 0))
    })
  }
  return pytestProbe
}

/** Makefile 里有 test / check 目标才算数：没有目标就乱跑 make 等于什么都没验 */
async function makeTarget(workspace: string): Promise<'test' | 'check' | null> {
  try {
    const src = await fs.readFile(path.join(workspace, 'Makefile'), 'utf8')
    for (const t of ['test', 'check'] as const) {
      if (new RegExp(`^${t}\\s*:`, 'm').test(src)) return t
    }
  } catch {
    /* 没有 Makefile / 读不到就不猜 */
  }
  return null
}

/** Go：改动文件所在的包 */
function goPackages(changed: string[]): string[] {
  const dirs = changed
    .filter((f) => f.endsWith('.go'))
    .map((f) => path.posix.dirname(f.replace(/\\/g, '/')))
    .filter((d) => d && d !== '.')
  return uniq(dirs).slice(0, MAX_RELATED)
}

/**
 * 按项目类型挑一条最有价值的验证命令；挑不出来返回 null。
 * changed 是这一轮改过的相对路径（可空）；给了就有机会只跑相关部分。
 */
export async function detectVerifyPlan(workspace: string, changed: string[] = []): Promise<VerifyPlan | null> {
  if (!workspace || !existsSync(workspace)) return null

  const pkg = await readPackageJson(workspace)
  const scripts = pkg?.scripts ?? {}
  const files = changed.map((f) => rel(workspace, f)).filter(Boolean)
  const jsFiles = files.filter((f) => /\.(?:[cm]?[jt]sx?)$/i.test(f)).slice(0, MAX_RELATED)

  // ① JS/TS：优先只跑受影响用例（jest / vitest 都有官方支持）
  if (jsFiles.length) {
    const list = jsFiles.map(quote).join(' ')
    if (hasDep(pkg, 'vitest')) {
      return { command: `npx vitest related ${list} --run`, label: '相关测试' }
    }
    if (hasDep(pkg, 'jest')) {
      return { command: `npx jest --findRelatedTests ${list} --silent`, label: '相关测试' }
    }
  }

  // ② 回落到项目自己的脚本
  if (scripts.test && !/no test specified/i.test(scripts.test)) {
    // 模型自写的测试要做独立 smoke 断言：存在性检查冒充运行验证是最常见的造假
    return { command: 'npm test --silent', label: '测试', smoke: true }
  }
  if (scripts.typecheck) return { command: 'npm run typecheck --silent', label: '类型检查' }
  if (scripts.build) return { command: 'npm run build --silent', label: '构建' }
  if (scripts.lint) return { command: 'npm run lint --silent', label: 'Lint' }

  const tsc = process.platform === 'win32' ? 'node_modules\\.bin\\tsc.cmd' : 'node_modules/.bin/tsc'
  if (existsSync(path.join(workspace, 'tsconfig.json')) && existsSync(path.join(workspace, tsc))) {
    return { command: `"${tsc}" --noEmit`, label: '类型检查' }
  }

  // ③ 其它语言
  if (existsSync(path.join(workspace, 'Cargo.toml'))) return { command: 'cargo check --quiet', label: '编译检查' }

  if (existsSync(path.join(workspace, 'go.mod'))) {
    const pkgs = goPackages(files)
    if (pkgs.length) {
      return { command: `go vet ${pkgs.map((p) => `./${p}`).join(' ')}`, label: '编译检查（改动包）' }
    }
    return { command: 'go build ./...', label: '编译检查' }
  }

  const pyMarker = PY_MARKERS.some((f) => existsSync(path.join(workspace, f)))
  /**
   * 没有 marker 也不能直接放弃：中文用户让模型做的轻量 Python 项目几乎不长 marker，
   * 结果就是「自动验证静默跳过、初版带病交付」。有 .py 就继续往下看。
   * 注意仍然保持保守：只有源码、一个 test_*.py 都没有时，下面什么都不返回。
   */
  const py = await scanPyProject(workspace)
  // marker 只在真的有 .py 时才算数：一个只有 tests/ 目录的 JS 项目不该被推进 pytest
  const isPy = (pyMarker && py.sources.length > 0) || py.tests.length > 0
  if (isPy) {
    const related = files.length ? await pythonTestsFor(workspace, files) : []
    // 找不到「相关」测试就退回工作区里能找到的测试文件（上限几条，别把整个仓库跑一遍）
    const target = related.length ? related : py.tests.slice(0, 8)
    if (target.length) {
      if (await pytestAvailable()) {
        return {
          command: `python -m pytest -q --maxfail=1 ${target.map(quote).join(' ')}`,
          label: related.length ? '相关测试' : '测试',
          smoke: true,
          testFile: target[0]
        }
      }
      // 没装 pytest：test_*.py 通常就是自带 assert 的脚本，逐条直跑，
      // 出错会以非零码退出，比「什么都没跑」强得多
      return {
        command: target.map((t) => `python ${quote(t)}`).join(' && '),
        label: '测试（脚本直跑）',
        smoke: true,
        testFile: target[0]
      }
    }
    if (pyMarker) {
      return { command: 'python -m pytest -q --maxfail=1', label: '测试', smoke: true }
    }
    // 只有源码、没有任何测试：不猜、不跑，保持静默跳过
    return null
  }

  // ④ Makefile：C/C++ 等没有包管理器的工程，唯一能问的就是它自己
  const mk = await makeTarget(workspace)
  if (mk) return { command: `make ${mk}`, label: mk === 'test' ? '测试' : '检查' }

  return null
}

/**
 * 「验证通过了，但没验证到核心交互」的提示。
 *
 * 起因：围棋程序初版交付时轮次乱、AI 自杀点卡死，而当时的自动验证是
 * `import ui` + 几条字符串检查，全过。`assertSmoke()` 只抓「没运行代码」，
 * 抓不到「运行了但没有状态断言」—— 一个只 import 成功、断言 `hasattr` 的测试
 * 照样能过。这里补上第二层判断，但只提示不拦：
 * 猜错项目形态时误拦的代价，比少提示一次大得多。
 */
const GUI_SOURCE =
  /(?:^|\n)\s*(?:import|from)\s+(?:tkinter|pygame|flask|fastapi|PyQt5|PyQt6|PySide2|PySide6|dearpygui|arcade)\b|class\s+(?:Board|Game|Player|GameState|Match|Scene)\b/

const ASSERTION_RE = /\bassert\b|assertEqual|assertTrue|assertRaises|assertIn|self\.assert|expect\(|assert\.\w+\(/

/**
 * 状态类词汇：测试里碰过任意一个，就算「摸到了交互状态」。
 * 刻意不含 board / move 这种纯名词 —— `assert hasattr(ui, 'Board')` 会命中它们，
 * 而那正是要抓的「只检查结构、不验证状态」。
 */
const STATE_WORD_RE = /\b(?:turn|round|player|current|legal|valid|state|score|winner|phase|next|switch)\b|轮次|回合|当前|合法|胜负|落子/i

function countMatches(re: RegExp, text: string): number {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  return (text.match(g) ?? []).length
}

async function readSmall(file: string, max = 200_000): Promise<string | null> {
  try {
    const st = await fs.stat(file)
    if (!st.isFile() || st.size > max) return null
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * 项目像「带交互状态的 GUI / 状态机」、测试却一条状态断言都没有时，返回一句提示；
 * 其余情况返回 null（不打扰）。
 */
export async function stateCoverageGap(workspace: string, changed: string[] = []): Promise<string | null> {
  try {
    const py = await scanPyProject(workspace)
    if (!py.tests.length) return null

    const reordered = uniq([
      ...changed.map((f) => rel(workspace, f)).filter((f) => f.endsWith('.py')),
      ...py.sources
    ]).slice(0, 8)

    let gui = false
    for (const f of reordered) {
      const text = await readSmall(path.join(workspace, f))
      if (text && GUI_SOURCE.test(text)) {
        gui = true
        break
      }
    }
    if (!gui) return null

    let asserts = 0
    let states = 0
    for (const f of py.tests.slice(0, 6)) {
      const text = await readSmall(path.join(workspace, f))
      if (!text) continue
      asserts += countMatches(ASSERTION_RE, text)
      states += countMatches(STATE_WORD_RE, text)
    }

    if (asserts === 0) {
      return (
        '【覆盖度提示】验证通过了，但测试里一条断言都没有 —— 这只证明「模块能被导入」，' +
        '不能证明程序是对的。轮次错乱、非法落子、AI 卡死这类问题一条都抓不到。' +
        '请补一个状态机级测试：构造初始局面 → 走一步 → 断言轮次已切换、非法走法被拒绝。'
      )
    }
    if (states === 0) {
      return (
        '【覆盖度提示】验证通过了，但测试里没有任何关于交互状态的断言（轮次 / 合法性 / 回合推进 / 胜负）。' +
        '这类测试通常只验证了导入、语法或结构，状态类 bug 照样会漏到用户手上。' +
        '建议补一条：走一步之后断言「轮到谁」「这步是否合法」「终局判定对不对」。'
      )
    }
    return null
  } catch {
    /* 判断不出来就什么都不说：覆盖度提示绝不能变成新的失败源 */
    return null
  }
}

function cut(text: string, max = MAX_OUTPUT): string {
  const t = text.trim()
  if (t.length <= max) return t
  // 测试输出通常「错误在末尾」，保留头部少量上下文 + 尾部大部分
  return `${t.slice(0, 800)}\n…（中间省略 ${t.length - max} 字符）\n${t.slice(-(max - 800))}`
}

const FAIL_LINE =
  /(?:^|\s)(?:FAIL|Failed|FAILED|✕|✗|×|AssertionError|Traceback|panic:|error(?:\[|:)|ERROR:|Expected|expected\b|but got|not ok )/i

/**
 * 只留下失败相关的行（带少量上下文）。
 *
 * 判据保守：宁可多留几十行，也不要把真正的报错切掉。
 * 一条失败信息通常需要前一行（用例名）和后两行（期望/实际）才读得懂。
 */
export function slimFailure(text: string): string {
  const src = text.trim()
  if (!src) return src
  // 本来就不长，没必要动
  if (src.length <= 1800) return src

  const lines = src.split(/\r?\n/)
  const keep = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    if (FAIL_LINE.test(lines[i])) {
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 3); j++) keep.add(j)
    }
  }

  if (!keep.size) return cut(src)

  const picked: string[] = []
  let skipped = 0
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      if (skipped > 0) {
        picked.push(`…（省略 ${skipped} 行）`)
        skipped = 0
      }
      picked.push(lines[i])
    } else {
      skipped++
    }
  }

  const body = picked.join('\n').trim()
  // 切完还是很长（例如一个巨大的 stack trace）就再按长度截
  return body.length > MAX_OUTPUT ? cut(body) : `${body}\n\n（已省略通过的部分，共 ${lines.length} 行）`
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  // 这些变量会让子进程（尤其是 electron 自带的 node）行为异常，跑构建/测试时必须去掉
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  delete env.ELECTRON_ENABLE_LOGGING
  env.CI = '1'
  env.NO_COLOR = '1'
  env.FORCE_COLOR = '0'
  env.GIT_PAGER = 'cat'
  env.PAGER = 'cat'
  // 与 tools/env.ts 同一个理由：Windows 的 Python 默认按 GBK 输出，中文断言信息会变成 ??
  env.PYTHONIOENCODING = 'utf-8'
  return env
}

export interface VerifyResult {
  ok: boolean
  command: string
  label: string
  output: string
  durationMs: number
}

/** 跑验证命令；超时/取消都会杀掉整个进程树 */
export function runVerify(workspace: string, plan: VerifyPlan, signal: AbortSignal): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(plan.command, {
      cwd: workspace,
      shell: true,
      windowsHide: true,
      env: childEnv()
    })

    let out = ''
    let done = false
    const finish = (code: number | null, extra?: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      const body = [out.trim(), extra].filter(Boolean).join('\n')
      // 失败才做「只留失败行」的瘦身；通过时保留原样，用户想看细节还在
      const shaped = code === 0 ? cut(body) : slimFailure(body)
      resolve({
        ok: code === 0,
        command: plan.command,
        label: plan.label,
        output: shaped || '（命令没有任何输出）',
        durationMs: Date.now() - started
      })
    }

    const kill = () => {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
        } else {
          child.kill('SIGKILL')
        }
      } catch {
        child.kill()
      }
    }

    const timer = setTimeout(() => {
      kill()
      finish(null, `\n[超过 ${Math.round(TIMEOUT / 1000)} 秒，已终止。可能是构建卡住或测试在等输入]`)
    }, TIMEOUT)

    const onAbort = () => {
      kill()
      finish(null, '\n[已取消]')
    }
    signal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < MAX_OUTPUT * 4) out += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (out.length < MAX_OUTPUT * 4) out += d.toString('utf8')
    })
    child.on('error', (err) => finish(null, `[无法启动验证命令：${err.message}]`))
    child.on('close', (code) => finish(code))
  })
}
