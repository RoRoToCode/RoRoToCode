/**
 * 在线端到端成品的「视觉复核」：把游戏/产品/仪表盘三个网页真正渲染一遍，
 * 确认画面画出来、控制台无错、交互不是死的，并截图落盘供人眼/视觉模型复核。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron dist/main/smoke-online-visual.js
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { checkWebPages, formatWebCheck } from './webcheck'

const results: string[] = []

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..', '..', 'workspace', 'online-e2e')
  const allTargets: [string, string][] = [
    ['game-mwlly553', 'index.html'],
    ['product-mwllz5ii', 'index.html'],
    ['webpage-mwllzxg2', 'index.html']
  ]
  // 支持一次只渲染一个目标（批量渲染时 capturePage 会截到同一帧，逐个渲染才准）
  const only = process.env.ROROTO_VISUAL_ONLY?.trim()
  const targets = only ? allTargets.filter(([d]) => d.includes(only)) : allTargets
  const abs = targets
    .map(([d, f]) => path.join(root, d, f))
    .filter((p) => fs.existsSync(p))

  console.log('===== 在线成品视觉复核 =====')
  console.log(`待渲染页面：${abs.length}`)
  for (const p of abs) console.log(`  - ${path.relative(root, p)}`)

  const res = await checkWebPages(abs, root)
  const formatted = formatWebCheck(res, root)

  let ok = 0
  const lines: string[] = []
  lines.push(formatted)
  for (const r of res) {
    const label = path.basename(path.dirname(path.join(root, r.file)))
    if (r.ok) ok++
    lines.push(`  ${r.ok ? 'PASS' : 'FAIL'} ${label}: errors=${r.errors.length} probe=${JSON.stringify(r.probe ?? null).slice(0, 160)} shot=${r.shot ?? '无'}`)
  }
  lines.push(`\n视觉复核：${ok}/${res.length} 通过`)
  lines.push('\n=== SHOTS ===')
  for (const r of res) if (r.shot) lines.push(path.join(root, r.shot))
  const report = lines.join('\n') + '\n'
  fs.writeFileSync(path.join(root, `visual-report${only ? '-' + only : ''}.txt`), report, 'utf8')
  console.log(report)
  const exitCode = ok === res.length && res.length > 0 ? 0 : 1
  setTimeout(() => app.exit(exitCode), 300)
}

app.whenReady().then(main).catch((e) => {
  console.log('异常：', (e as Error).message)
  app.exit(2)
})
