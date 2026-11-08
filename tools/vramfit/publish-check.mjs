#!/usr/bin/env node
/**
 * publish-check.mjs —— 发布前自检（零依赖）
 *
 *   node publish-check.mjs                     // 按当前 package.json 的 name 测
 *   node publish-check.mjs --name @roroto/vramfit
 *
 * 做四件事，任何一项失败退出码为 1：
 *   1. 检查发布元数据（缺 repository / author 之类的软告警，scoped 缺 access 是硬错）
 *   2. npm pack 出真 tarball，核对 files 白名单和入口文件
 *   3. 核对 tarball 内所有相对 import 都能在同包里解析到（files 漏项只会在这里暴露）
 *   4. 把 tarball 装进临时工程，跑一次 bin，确认命令名和输出都对
 *
 * 不联网、不发布、不写你的 node_modules。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const nameArg = args.includes('--name') ? args[args.indexOf('--name') + 1] : '';

const cwd = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
const pkgName = nameArg || pkg.name;

const fail = [];
const warn = [];
const ok = (msg) => console.log(`  PASS  ${msg}`);
const bad = (msg) => { console.log(`  FAIL  ${msg}`); fail.push(msg); };

function npm(argv, opts = {}) {
  return execFileSync('npm', argv, { cwd, encoding: 'utf8', stdio: 'pipe', shell: process.platform === 'win32', ...opts });
}

console.log(`\n=== 1. 元数据  ${pkgName}@${pkg.version} ===`);

if (!pkgName) bad('package.json 没有 name');
if (!pkg.version) bad('package.json 没有 version');
if (pkg.private === true) bad('private: true 的包不能发布');
if (!pkg.description) warn.push('缺 description（npm 搜索结果里就是空白）');
if (!pkg.license) warn.push('缺 license');

const scoped = pkgName.startsWith('@');
if (scoped) {
  // 关键：scoped 默认 restricted，免费账号会 402
  const access = pkg.publishConfig?.access;
  if (access === 'public') ok('scoped 包已声明 publishConfig.access=public');
  else bad('scoped 包没写 publishConfig.access=public —— 免费账号会报 402 Payment Required（命令里加 --access public 也行）');
}
if (!pkg.repository) warn.push('缺 repository（npm 页面不会有「仓库」链接）');
if (!pkg.bugs?.url) warn.push('缺 bugs.url');
if (!pkg.author) warn.push('缺 author');
if (!pkg.engines?.node) warn.push('缺 engines.node');

const bin = pkg.bin;
const binEntries = typeof bin === 'string' ? { [pkgName]: bin } : (bin || {});
if (!Object.keys(binEntries).length) warn.push('没有 bin 字段（不是 CLI 包？）');
for (const [cmd, file] of Object.entries(binEntries)) {
  const p = path.join(cwd, file);
  if (!existsSync(p)) { bad(`bin.${cmd} 指向的 ${file} 不存在`); continue; }
  const head = readFileSync(p, 'utf8').slice(0, 60);
  if (!head.startsWith('#!')) bad(`bin.${cmd} 的 ${file} 没有 #! shebang，装了也跑不起来`);
  else ok(`bin.${cmd} → ${file}（shebang 正常）`);
}

console.log(`\n=== 2. npm pack  ${pkgName}@${pkg.version} ===`);

const tmp = mkdtempSync(path.join(tmpdir(), 'publish-check-'));
let tgz = '';
let packed = [];
try {
  const raw = npm(['pack', '--json', '--pack-destination', tmp]);
  const meta = JSON.parse(raw.slice(raw.indexOf('[')))[0];
  tgz = path.join(tmp, meta.filename);
  packed = meta.files.map((f) => f.path.split(path.sep).join('/'));
  ok(`${packed.length} 个文件 / 解包 ${(meta.unpackedSize / 1024).toFixed(1)} KB / 压缩包 ${(meta.size / 1024).toFixed(1)} KB`);

  for (const [cmd, file] of Object.entries(binEntries)) {
    const norm = file.replace(/^\.\//, '');
    if (!packed.includes(norm)) bad(`bin.${cmd} 的 ${norm} 没进 tarball（files 白名单漏了）`);
  }
  if (!packed.some((f) => /^README/i.test(f))) warn.push('tarball 里没有 README，npm 页面会很空');
  if (!packed.some((f) => /^LICEN[SC]E/i.test(f))) warn.push('tarball 里没有 LICENSE');
} catch (e) {
  bad(`npm pack 失败：${e.message.split('\n')[0]}`);
}

console.log('\n=== 3. tarball 内部引用完整性 ===');
if (packed.length) {
  const set = new Set(packed);
  let missing = 0;
  for (const f of packed.filter((f) => /\.(mjs|cjs|js|ts)$/.test(f))) {
    const src = readFileSync(path.join(cwd, f), 'utf8');
    const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.[^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const t = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      const hit = set.has(t) || set.has(`${t}.mjs`) || set.has(`${t}/index.mjs`) || set.has(`${t}.js`);
      if (!hit) { console.log(`  FAIL  ${f} 引用的 ${m[1]} 不在包里`); missing++; }
    }
  }
  if (missing) fail.push(`${missing} 个相对引用在 tarball 里缺失`);
  else ok('所有相对 import 都能在包内解析到');
}

console.log('\n=== 4. 装进干净工程跑一次 ===');
if (tgz) {
  const proj = mkdtempSync(path.join(tmpdir(), 'publish-install-'));
  try {
    execFileSync('npm', ['init', '-y'], { cwd: proj, stdio: 'pipe', shell: process.platform === 'win32' });
    execFileSync('npm', ['i', tgz, '--no-audit', '--no-fund'], { cwd: proj, stdio: 'pipe', shell: process.platform === 'win32' });
    ok('安装成功');
    for (const cmd of Object.keys(binEntries).length ? Object.keys(binEntries) : [pkgName]) {
      const shim = path.join(proj, 'node_modules', '.bin', process.platform === 'win32' ? `${cmd}.cmd` : cmd);
      if (!existsSync(shim)) { bad(`没有生成 ${cmd} 命令（bin 映射有问题）`); continue; }
      const out = execFileSync(shim, ['--help'], { cwd: proj, encoding: 'utf8', stdio: 'pipe', shell: process.platform === 'win32', timeout: 20000 });
      if (!out.trim()) bad(`${cmd} --help 没有输出`);
      else {
        ok(`${cmd} --help 正常（${out.trim().split('\n').length} 行）`);
        // 帮助文本里出现 "node xxx.mjs" 这类开发期写法，对装了包的人是误导
        const dev = out.match(/node\s+[\w./-]+\.mjs/g);
        if (dev) warn.push(`帮助文本里出现开发期写法：${[...new Set(dev)].join('、')} —— 用户手上是 \`${cmd}\` 命令`);
      }
    }
  } catch (e) {
    bad(`安装或运行失败：${String(e.message).split('\n').slice(0, 3).join(' ')}`);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
} else {
  console.log('  SKIP  没有 tarball');
}

console.log('\n=== 5. GitHub Actions 工作流自检 ===');
// 工作流的语法错误代价很高：push 之后才暴露，而且 GitHub 只回一句
// 「You have an error in your yaml syntax on line 46」，连哪个键错了都不说。
// 最常见的一类就是值里带裸冒号 —— `- name: 支持 node: 内置模块` 会被 YAML
// 当成嵌套键，整份文件在解析阶段就失败，一个 job 都不启动。
const wfDir = path.join(cwd, '.github', 'workflows');
if (existsSync(wfDir)) {
  const wfFiles = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));
  let traps = 0;
  for (const f of wfFiles) {
    readFileSync(path.join(wfDir, f), 'utf8').split(/\r?\n/).forEach((raw, i) => {
      const line = raw.replace(/\s+$/, '');
      const body = line.trim();
      if (!body || body.startsWith('#')) return;
      const m = /^\s*-?\s*([\w.-]+):\s+(.+)$/.exec(line);
      if (!m) return;
      const value = m[2];
      // 引号 / 块标量 / 流式写法都是安全的，只查裸值
      if (/^["'|>&*[{]/.test(value)) return;
      if (/:\s/.test(value) || value.endsWith(':')) {
        console.log(`  FAIL  ${f}:${i + 1} 值里有裸冒号，YAML 会当成嵌套键 → ${body}`);
        traps++;
      }
    });
  }
  if (traps) fail.push(`工作流里有 ${traps} 处 YAML 冒号陷阱，GitHub 会在解析阶段直接拒绝`);
  else ok(`${wfFiles.length} 个工作流文件，没有裸冒号`);
  if (!wfFiles.length) warn.push('.github/workflows 是空的');
} else {
  console.log('  SKIP  没有 .github/workflows');
}

console.log('\n=== 结论 ===');
for (const w of warn) console.log(`  WARN  ${w}`);
if (fail.length) {
  console.log(`\n  ${fail.length} 项不通过，先别发。\n`);
  process.exitCode = 1;
} else {
  console.log(`\n  可以发。${warn.length ? `（${warn.length} 条软告警）` : ''}\n`);
}
rmSync(tmp, { recursive: true, force: true });
