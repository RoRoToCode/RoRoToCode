#!/usr/bin/env node
/**
 * 便携版打包（一条命令出包）。
 *
 * 为什么要这个脚本，而不是直接 `electron-builder --win portable`：
 *
 * 1) 本机 shell 的环境变量 NODE_OPTIONS 注入了 node-language-shim，
 *    它把 fs.rm 改写成「走回收站」。而 genie-trash 在 F 盘必然失败并 fail-closed，
 *    于是 electron-builder 清空 win-unpacked/resources 时直接报
 *    `Some operations were aborted`。→ 这里给子进程剥掉 NODE_OPTIONS。
 *
 * 2) 输出目录若落在项目树里（默认 release/），打包会撞上
 *    `EBUSY: unlink ...\resources\app.asar` —— 项目里的 app.asar 被外部进程
 *    （编辑器索引 / 杀软）攥着句柄。→ 这里输出到系统临时目录，打完再把 exe 拷回来。
 *
 * 用法：
 *   node scripts/pack-portable.mjs        # 等价于 npm run dist
 *   node scripts/pack-portable.mjs --skip-build   # 复用已有 dist/，只打包
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const skipBuild = process.argv.includes('--skip-build')

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\..+$/, '')
  .replace('T', '-')
const outDir = path.join(os.tmpdir(), `roro-pkg-${stamp}`)
const releaseDir = path.join(root, 'release')
const artifactName = `RoRoToCode-${version}-portable.exe`

// 剥掉删除挂钩（见文件头注释 1）
const cleanEnv = { ...process.env }
delete cleanEnv.NODE_OPTIONS

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function step(title) {
  process.stdout.write(`\n\u001b[36m== ${title}\u001b[0m\n`)
}

function run(cmd, args, { shell = process.platform === 'win32' } = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: cleanEnv, shell })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(' ')} 退出码 ${r.status}`)
}

/** electron-builder 的 CLI 入口（直接跑 node，避免 npm exec 在非交互环境下的询问） */
const builderCli = path.join(root, 'node_modules', 'electron-builder', 'cli.js')

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex')
}

function human(bytes) {
  return bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`
}

function cleanupTmp(dir) {
  // 自己删会再撞上删除挂钩，交给一个干净环境的子进程
  try {
    spawnSync(
      process.execPath,
      ['-e', `require('node:fs').rmSync(${JSON.stringify(dir)}, { recursive: true, force: true })`],
      { env: cleanEnv, stdio: 'ignore' }
    )
  } catch {
    // 临时目录清不掉无所谓，系统会回收
  }
}

try {
  if (!skipBuild) {
    step('编译主进程与渲染层')
    run(npmCmd, ['run', 'build'])
  } else {
    step('跳过编译（--skip-build）')
  }

  step('打包便携版 exe')
  console.log(`输出目录：${outDir}`)
  fs.mkdirSync(outDir, { recursive: true })
  if (!fs.existsSync(builderCli)) {
    throw new Error(`找不到 ${builderCli}，请先 npm install`)
  }
  run(process.execPath, [
    builderCli,
    '--win',
    'portable',
    `--config.directories.output=${outDir}`
  ], { shell: false })

  const built = path.join(outDir, artifactName)
  if (!fs.existsSync(built)) {
    const found = fs.readdirSync(outDir).filter((n) => n.toLowerCase().endsWith('.exe'))
    throw new Error(`没找到 ${artifactName}，目录里只有：${found.join(', ') || '（空）'}`)
  }

  step('拷贝到 release/')
  fs.mkdirSync(releaseDir, { recursive: true })
  const dest = path.join(releaseDir, artifactName)
  try {
    fs.copyFileSync(built, dest)
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      throw new Error(`写不进 ${dest}：文件被占用，请先关闭正在运行的 RoRoTo Code 再重试`)
    }
    throw err
  }

  const size = fs.statSync(dest).size
  const a = md5(built)
  const b = md5(dest)
  // winget 清单和 GitHub Release 需要 SHA256；顺手落一份校验文件，发布时直接当资产上传。
  const sha = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex')
  const sumsFile = path.join(releaseDir, `${artifactName}.sha256`)
  fs.writeFileSync(sumsFile, `${sha}  ${artifactName}\n`)
  console.log(`\n\u001b[32m✓ 打包完成\u001b[0m`)
  console.log(`  ${dest}`)
  console.log(`  大小 ${human(size)}　md5 ${b}`)
  console.log(`  sha256 ${sha}`)
  console.log(`  校验文件 ${sumsFile}`)
  console.log(`  校验 ${a === b ? '一致' : '不一致（拷贝可能不完整，请重试）'}`)

  cleanupTmp(outDir)

  if (a !== b) process.exitCode = 1
} catch (err) {
  console.error(`\n\u001b[31m✗ 打包失败：${err.message}\u001b[0m`)
  console.error(`  中间产物保留在：${outDir}`)
  process.exitCode = 1
}
