#!/usr/bin/env node
/**
 * verify-publish.mjs — 发布后体检
 *
 * 分四层验证一个包是否真的发成功了：
 *   1. Registry 元数据   versions / dist-tags / tarball 是否指向真实版本（排除 0.0.0-stage 占位壳）
 *   2. 真实安装          npm install -g --prefix <临时目录>，不污染全局
 *   3. 命令可用          跑 --version，确认 bin 可执行
 *   4. 功能可用          --json 体检一个真实 gguf（可选）
 *
 * 用法：
 *   node verify-publish.mjs                      # 验 vramfit@latest
 *   node verify-publish.mjs vramfit@1.0.1        # 验指定版本
 *   node verify-publish.mjs vramfit --model x.gguf   # 加一步功能验证
 *   node verify-publish.mjs --keep               # 保留临时目录方便排查
 *
 * 只读 registry，不上传、不登录、不改全局环境。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const modelIdx = argv.indexOf('--model');
const model = modelIdx >= 0 ? argv[modelIdx + 1] : null;
const spec = argv.find((a, i) => !a.startsWith('--') && (modelIdx < 0 || i !== modelIdx + 1)) || 'vramfit';
const [pkgName, wantVersion] = spec.split('@').length > 1 ? [spec.split('@')[0], spec.split('@')[1]] : [spec, null];

const isWin = process.platform === 'win32';
const results = [];
const log = (ok, label, detail = '') => {
  results.push({ ok, label, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? `  ${detail}` : ''}`);
};

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, ...opts });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}

const npm = (args) => run(isWin ? 'npm.cmd' : 'npm', args, { shell: isWin });

console.log(`\n发布后体检：${spec}\n${'─'.repeat(52)}`);

// 1. Registry 元数据
const meta = npm(['view', pkgName, '--json']);
let info = null;
try {
  info = JSON.parse(meta.out);
} catch {
  log(false, 'Registry 可查', meta.err.split('\n')[0] || 'npm view 失败');
}

if (info) {
  const stub = info.stub === true || info.version === '0.0.0-stage';
  log(!stub, '版本不是占位壳', stub ? '只看到 0.0.0-stage（stub），真实版本没发上去' : `latest = ${info.version}`);

  const versions = Array.isArray(info.versions) ? info.versions : [info.version];
  log(versions.some((v) => /^\d+\.\d+\.\d+$/.test(v)), '存在正式版本号', versions.slice(-4).join(', '));

  if (wantVersion) {
    log(versions.includes(wantVersion), `包含指定版本 ${wantVersion}`, wantVersion && !versions.includes(wantVersion) ? '未发布' : '');
  }

  const tarball = info.dist?.tarball || '';
  log(/^https:\/\/registry\.npmjs\.org\//.test(tarball), 'tarball 指向官方 registry', tarball.replace(/^https:\/\/registry\.npmjs\.org\//, ''));

  const size = info.dist?.unpackedSize ?? 0;
  log(size > 50000, '包体大小正常', `${(size / 1024).toFixed(1)} KB 解压后` + (size < 50000 ? '（疑似空壳）' : ''));

  const owners = (info.maintainers || []).map((m) => (typeof m === 'string' ? m : m.name || m.username)).filter(Boolean);
  log(owners.length > 0, '有维护者', owners.join(', '));
}

// 2. 真实安装
let prefix = null;
let installed = false;
if (info && info.stub !== true) {
  prefix = mkdtempSync(path.join(tmpdir(), 'verify-publish-'));
  const inst = npm(['install', '-g', '--prefix', prefix, `${pkgName}@${wantVersion || 'latest'}`, '--no-fund', '--no-audit']);
  installed = inst.ok;
  log(installed, '临时目录安装成功', installed ? prefix : inst.err.split('\n')[0]);
}

// 3. 命令可用
let binOk = false;
if (installed) {
  const bin = isWin ? path.join(prefix, pkgName + '.cmd') : path.join(prefix, 'bin', pkgName);
  const exists = existsSync(bin);
  log(exists, '生成可执行命令', exists ? pkgName : `找不到 ${bin}`);

  if (exists) {
    const v = run(bin, ['--version'], { shell: isWin });
    const m = v.out.match(/(\d+\.\d+\.\d+)/);
    binOk = v.ok && !!m;
    log(binOk, '运行 --version', v.out.split('\n')[0] || v.err.split('\n')[0]);
    if (wantVersion && m && m[1] !== wantVersion) log(false, '版本与预期一致', `实际 ${m[1]}`);
  }
}

// 4. 功能可用（可选）
if (binOk && model) {
  const bin = isWin ? path.join(prefix, pkgName + '.cmd') : path.join(prefix, 'bin', pkgName);
  const r = run(bin, ['--json', model], { shell: isWin });
  let row = null;
  try {
    const arr = JSON.parse(r.out);
    row = Array.isArray(arr) ? arr[0] : arr;
  } catch {}
  log(!!row, '对真实模型出报告', row ? `verdict=${row.verdict} ctx=${row.recommendedCtx} ${row.error ? 'ERROR ' + row.error : ''}` : r.err.slice(0, 120));
}

// 清理
if (prefix && !keep) {
  try {
    rmSync(prefix, { recursive: true, force: true });
  } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`${'─'.repeat(52)}`);
console.log(failed.length === 0 ? '  全部通过，可以对外宣传安装命令。' : `  ${failed.length} 项未通过：${failed.map((f) => f.label).join('；')}`);
console.log(`  共 ${results.length} 项，注意 npm CDN 缓存最长可能滞后 5 分钟。\n`);
process.exit(failed.length === 0 ? 0 : 1);
