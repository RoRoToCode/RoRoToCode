#!/usr/bin/env node
/**
 * 从 template/ 渲染出一个版本化的 winget 三文件清单。
 *
 * 哈希默认从本地打包产物 release/RoRoToCode-<version>-portable.exe 现算，
 * 所以清单和真实资产永远一致，不会重现 v0.1.2「文案哈希和文件哈希对不上」的问题。
 *
 *   node packaging/winget/render.mjs                        # 版本取 package.json
 *   node packaging/winget/render.mjs --version 0.1.4
 *   node packaging/winget/render.mjs --sha256 <64位hex>      # CI 上已有资产哈希，不必有本地 exe
 *   node packaging/winget/render.mjs --url <完整下载直链>      # 覆盖默认 GitHub Release URL
 *
 * 零依赖，不联网，不写 template/，只生成 packaging/winget/<version>/。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const version = arg('version', pkg.version)
const asset = arg('asset', `RoRoToCode-${version}-portable.exe`)
const exe = path.resolve(root, arg('exe', path.join('release', asset)))
const repo = arg('repo', 'RoRoToCode/RoRoToCode')
const url = arg('url', `https://github.com/${repo}/releases/download/v${version}/${asset}`)

let sha = arg('sha256', '').trim()
if (!sha) {
  if (!fs.existsSync(exe)) {
    console.error(`找不到打包产物：${exe}`)
    console.error('先跑 npm run dist，或用 --sha256 指定已发布资产的哈希。')
    process.exit(1)
  }
  sha = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex')
}
if (!/^[0-9a-f]{64}$/i.test(sha)) {
  console.error(`SHA256 不是 64 位十六进制：${sha}`)
  process.exit(1)
}
sha = sha.toUpperCase()

if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`版本号不符合 winget 要求（需三段式，不带 v 前缀）：${version}`)
  process.exit(1)
}

const templateDir = path.join(here, 'template')
const outDir = path.join(here, version)
fs.mkdirSync(outDir, { recursive: true })

const files = fs.readdirSync(templateDir).filter((f) => f.endsWith('.yaml'))
if (files.length !== 3) {
  console.error(`template/ 应该有 3 个 yaml，实际 ${files.length} 个`)
  process.exit(1)
}
for (const f of files) {
  const text = fs.readFileSync(path.join(templateDir, f), 'utf8')
    .replaceAll('__VERSION__', version)
    .replaceAll('__ASSET__', asset)
    .replaceAll('__URL__', url)
    .replaceAll('__SHA256__', sha)
  fs.writeFileSync(path.join(outDir, f), text)
}

console.log(`版本      ${version}`)
console.log(`资产      ${asset}`)
console.log(`URL       ${url}`)
console.log(`SHA256    ${sha}`)
console.log(`清单目录  ${outDir}`)
console.log('\n下一步：winget validate --manifest ' + path.relative(root, outDir))
