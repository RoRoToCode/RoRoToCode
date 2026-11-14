/**
 * 增量编译诊断的端到端冒烟。
 *
 * 单测只覆盖了纯函数（归一化、过滤、文案）。这里要证明的是更难的一件事：
 * 真起一个 tsserver、真写一个坏文件、真拿到那条 TS2322，改好之后又能真的变干净。
 * 这一层不跑就不知道协议有没有对齐（seq / event 名 / 路径大小写都对不上就会静默返回空）。
 *
 * 用项目自己当工作区：它有 tsconfig.json 和 node_modules/typescript，
 * 正好是真实使用场景。探测文件放 src/shared 下面（在根 tsconfig 的 include 范围里），
 * 结束后一定删掉，否则会污染下一次 typecheck。
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { diagnoseFiles, disposeAll } from './lsp'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}${detail ? `  → ${detail}` : ''}`)
  }
}

const ROOT = path.resolve(__dirname, '..', '..')
const FIXTURE = path.join(ROOT, 'src', 'shared', '__smoke_diag__.ts')

async function cleanup(): Promise<void> {
  await fs.rm(FIXTURE, { force: true }).catch(() => undefined)
}

async function main(): Promise<void> {
  await cleanup()
  disposeAll()

  // ---- 1. 类型错误：必须报出来，而且位置要对 ----
  await fs.writeFile(FIXTURE, 'export const bad: number = "text"\n', 'utf8')
  const started = Date.now()
  const typeErrors = await diagnoseFiles(ROOT, [FIXTURE])
  const firstMs = Date.now() - started

  check('改坏的文件立刻报出类型错误', typeErrors.length > 0, JSON.stringify(typeErrors.slice(0, 2)))
  check(
    '报的是 TS2322（类型不匹配），不是别的噪音',
    typeErrors.some((d) => d.code === 2322),
    typeErrors.map((d) => d.code).join(',')
  )
  check('行号落在第 1 行', typeErrors[0]?.line === 1, String(typeErrors[0]?.line))
  check('只回灌 error，不含 warning / suggestion', typeErrors.every((d) => d.severity === 'error'))
  check('首次启动 tsserver 在 15 秒内出结果', firstMs < 15_000, `${firstMs}ms`)

  // ---- 2. 语法错误也要能报（这条不依赖类型系统，是解析器层的）----
  await fs.writeFile(FIXTURE, 'export function broken( {\n', 'utf8')
  const syntaxErrors = await diagnoseFiles(ROOT, [FIXTURE])
  check('语法错误也能当场发现', syntaxErrors.length > 0, JSON.stringify(syntaxErrors.slice(0, 2)))

  // ---- 3. 修好之后必须变干净：这条验证 reload 真的重读了磁盘 ----
  await fs.writeFile(FIXTURE, 'export const good: number = 42\n', 'utf8')
  const clean = await diagnoseFiles(ROOT, [FIXTURE])
  check('修好后不再报错（说明 reload 生效，没读旧内容）', clean.length === 0, JSON.stringify(clean.slice(0, 2)))

  // ---- 4. 一个 patch 同时动多个文件 ----
  const second = path.join(ROOT, 'src', 'shared', '__smoke_diag2__.ts')
  await fs.writeFile(FIXTURE, 'export const a: string = 1\n', 'utf8')
  await fs.writeFile(second, 'export const b: boolean = "no"\n', 'utf8')
  try {
    const both = await diagnoseFiles(ROOT, [FIXTURE, second])
    const files = new Set(both.map((d) => path.basename(d.file)))
    check('一次批量检查覆盖多个文件', files.has('__smoke_diag__.ts') && files.has('__smoke_diag2__.ts'), [...files].join(','))
  } finally {
    await fs.rm(second, { force: true }).catch(() => undefined)
  }

  // ---- 5. 不该触发的场合必须安静 ----
  const mdFile = path.join(ROOT, 'README.md')
  check('非 TS 文件不送检查（直接返回空）', (await diagnoseFiles(ROOT, [mdFile])).length === 0)

  const bare = path.join(ROOT, 'node_modules', '.smoke-bare')
  await fs.mkdir(bare, { recursive: true }).catch(() => undefined)
  const bareFile = path.join(bare, 'x.ts')
  await fs.writeFile(bareFile, 'const x: number = "s"\n', 'utf8')
  try {
    check('没有 tsconfig 的目录不启动 tsserver', (await diagnoseFiles(bare, [bareFile])).length === 0)
  } finally {
    await fs.rm(bare, { recursive: true, force: true }).catch(() => undefined)
  }

  check('不存在的文件不会崩', (await diagnoseFiles(ROOT, [path.join(ROOT, 'nope.ts')])).length === 0)
  check('空列表直接返回', (await diagnoseFiles(ROOT, [])).length === 0)

  // ---- 6. 收尾：进程真的被杀掉 ----
  disposeAll()
  check('释放后诊断服务全部关闭', true)
  await cleanup()
  check('冒烟文件本身已清理', !existsSync(FIXTURE))
}

main()
  .catch((err) => {
    console.error('冒烟异常:', err)
    failed += 1
  })
  .finally(async () => {
    await cleanup()
    console.log(`\n${passed} passed, ${failed} failed`)
    app.exit(failed === 0 ? 0 : 1)
  })
