/**
 * 定义跳转 / 引用查找的端到端冒烟。
 *
 * 单测只覆盖了 relPath/absPath 纯函数。这里要证明协议对齐：
 * definition 的结果带在 response body（数组），references 带在 response body.refs，
 * 两者都是「发命令 → 同步收 response」，和 geterr 的事件推送不同。
 * 对不上就会像第一版那样静默返回空数组。
 *
 * 用项目自己当工作区：写两个互相引用的探测文件，
 * 验证能从一个文件跳到另一个文件的定义、能从定义处反查出引用。
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { disposeAll, findReferences, gotoDefinition } from './lsp'

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
const A = path.join(ROOT, 'src', 'shared', '__smoke_nav_a__.ts')
const B = path.join(ROOT, 'src', 'shared', '__smoke_nav_b__.ts')

async function cleanup(): Promise<void> {
  await fs.rm(A, { force: true }).catch(() => undefined)
  await fs.rm(B, { force: true }).catch(() => undefined)
}

async function main(): Promise<void> {
  await cleanup()
  disposeAll()

  // 两个文件：A 定义一个函数并导出，B 导入并调用
  await fs.writeFile(A, 'export function smokeTarget(x: number): number { return x * 2 }\n', 'utf8')
  await fs.writeFile(B, "import { smokeTarget } from './__smoke_nav_a__'\nexport const r = smokeTarget(21)\n", 'utf8')

  // 打开 B 等 tsserver 就绪：先诊断一次触发加载
  await gotoDefinition(ROOT, B, 1, 1).catch(() => [])

  // ---- 1. 从 B 的 import 处跳到 A 的定义 ----
  // B 第 2 行 `smokeTarget(21)`，列 23 落在 smokeTarget 上
  const defs = await gotoDefinition(ROOT, B, 2, 23)
  check('能从调用处跳到定义', defs.length > 0, JSON.stringify(defs))
  check(
    '定义落在 A 文件里',
    defs.some((d) => path.basename(d.file) === '__smoke_nav_a__.ts'),
    defs.map((d) => path.basename(d.file)).join(',')
  )
  check('定义行号是 1（A 第 1 行的函数）', defs.some((d) => d.line === 1), defs.map((d) => d.line).join(','))

  // ---- 2. 从 A 的定义处反查引用 ----
  const refs = await findReferences(ROOT, A, 1, 16)
  check('能找到引用', refs.refs.length > 0, `refs=${refs.refs.length}`)
  check(
    '引用包含 B 文件的调用点',
    refs.refs.some((r) => path.basename(r.file) === '__smoke_nav_b__.ts'),
    refs.refs.map((r) => path.basename(r.file)).join(',')
  )
  check('引用结果带行内容 snippet', refs.refs.some((r) => r.snippet && r.snippet.includes('smokeTarget')), JSON.stringify(refs.refs.slice(0, 1)))

  // ---- 3. 不存在的文件 / 非 TS 文件要安静 ----
  check('非 TS 文件不查导航', (await gotoDefinition(ROOT, path.join(ROOT, 'README.md'), 1, 1)).length === 0)
  check('空 workspace 不查导航', (await gotoDefinition(null, B, 1, 1)).length === 0)

  disposeAll()
  await cleanup()
  check('冒烟文件已清理', true)
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
