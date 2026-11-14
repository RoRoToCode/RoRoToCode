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
      `tests/${dir}/test_${base}.py`
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
    return { command: 'npm test --silent', label: '测试' }
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

  const pyMarker = ['pyproject.toml', 'pytest.ini', 'setup.py', 'tests'].some((f) =>
    existsSync(path.join(workspace, f))
  )
  if (pyMarker) {
    const tests = files.length ? await pythonTestsFor(workspace, files) : []
    if (tests.length) {
      return { command: `python -m pytest -q --maxfail=1 ${tests.map(quote).join(' ')}`, label: '相关测试' }
    }
    return { command: 'python -m pytest -q --maxfail=1', label: '测试' }
  }

  return null
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
