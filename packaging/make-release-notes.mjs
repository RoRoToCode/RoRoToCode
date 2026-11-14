#!/usr/bin/env node
/**
 * 从真实打包产物生成 release/RELEASE_NOTES.md，交给 gh release create --notes-file。
 *
 * v0.1.2 的教训：Release 文案里的 SHA256 是手抄的，和 GitHub 实际存的文件对不上。
 * 这里直接从 exe 现算哈希和体积，文案不可能和资产不一致。
 *
 *   node packaging/make-release-notes.mjs                 # 版本取 package.json
 *   node packaging/make-release-notes.mjs --version 0.1.3
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const version = arg('version', pkg.version)
const asset = `RoRoToCode-${version}-portable.exe`
const exe = path.join(root, 'release', asset)

if (!fs.existsSync(exe)) {
  console.error(`找不到 ${exe}，先跑 npm run dist`)
  process.exit(1)
}
const bytes = fs.readFileSync(exe)
const sha = crypto.createHash('sha256').update(bytes).digest('hex')
const sizeMB = (bytes.length / 1024 ** 2).toFixed(1)
writeShaFile(asset, sha)

// NSIS 安装器是可选的，有就一起列出来
// 只认本次的 NSIS 安装器。release/ 里可能残留旧版本 portable exe 或别的 exe，
// 用 f !== asset 会把它们一起列进下载表格（也会算出一个误导性的哈希）。
const installers = fs.readdirSync(path.join(root, 'release'))
  .filter((f) => f.endsWith('.exe') && !f.endsWith('-portable.exe') && /setup/i.test(f))
  .map((f) => {
    const buf = fs.readFileSync(path.join(root, 'release', f))
    const h = crypto.createHash('sha256').update(buf).digest('hex')
    writeShaFile(f, h)
    return `| ${f} | ${(buf.length / 1024 ** 2).toFixed(1)} MB | \`${h}\` |`
  })

/** 每个 exe 旁边都放一份 .sha256，Release 上传时一并带上 */
function writeShaFile(name, hex) {
  fs.writeFileSync(path.join(root, 'release', `${name}.sha256`), `${hex}  ${name}\n`)
}

const lines = [
  '## 是什么',
  '',
  'RoRoTo Code 是 Windows 上的本地 coding agent，把 llama.cpp / GGUF 从「能跑起来」做到「能当 coding agent 稳定用」：按这台机器判断该用哪个模型、开多大上下文、还够跑几轮，并把启动失败、崩溃、复读、坏参数这些本地模型特有的坑整条收敛掉。',
  '',
  '## 下载',
  '',
  '| 文件 | 大小 | SHA256 |',
  '|---|---|---|',
  `| ${asset} | ${sizeMB} MB | \`${sha}\` |`,
  ...installers,
  '',
  '便携版免安装，双击即用；首次使用会自动下载 llama.cpp 与所选 GGUF 模型。',
  '',
  '已上架 winget 后可直接：`winget install RoRoToCode.RoRoToCode`（首个版本需先通过社区仓库审核）。',
  '',
  '## 本版本变更',
  '',
  `- llama.cpp 运行库、GGUF 模型与简易核心默认改存到用户数据目录，包管理器升级不再丢失已下载的模型；需要「模型跟 exe 放一起」时设 \`ROROTO_PORTABLE=1\`，自定义位置设 \`ROROTO_DATA_DIR\`。`,
  '- 发布流程自动化：tag 触发构建、打包、现算哈希并生成 Release 文案与 winget 清单。',
  '',
  '## 要求',
  '',
  'Windows 10/11。运行时会下载 llama.cpp、NVIDIA CUDA / cuBLAS / cudart 及 GGUF 模型等第三方组件，各自适用其许可（详见仓库 README）。',
  '',
  '## 验证',
  '',
  '`npm test`、`npm run typecheck`、`npm run lint` 全过；winget 清单经 `winget validate` 校验。',
  ''
]

const out = path.join(root, 'release', 'RELEASE_NOTES.md')
fs.writeFileSync(out, lines.join('\n'))
console.log(`已生成 ${out}`)
console.log(`  ${asset}  ${sizeMB} MB  sha256 ${sha}`)
