# 怎么改这个项目

维护者视角。只是装来用的话看 [README.md](README.md)。

## 目录

```
gguf-check/                ← 仓库根，也是 npm 包根
├── check.mjs                  命令行入口
├── check.cmd                  Windows 双击启动
├── core/                      解析 + 推算（纯计算，无 IO，浏览器里也能跑）
├── net/                       HTTP Range 读取（Node / 浏览器共用）
├── cli/                       本机硬件探测（nvidia-smi / rocm-smi / sysctl）
├── test.mjs                   命令行侧用例
├── package.json
├── README.md / README.en.md   用户文档（GitHub 首页显示中文这份）
├── CONTRIBUTING.md            本文件
├── CITATION.cff / LICENSE     MIT
├── .github/workflows/ci.yml   3 平台 × 3 个 Node 版本
└── site/                      网页版，纯静态
    ├── src/                       源码：index.html + web/{app,gpu,local,report}.mjs
    ├── build.mjs                  构建：src/ + ../{core,net} → dist/
    ├── serve.mjs                  本地预览 dist/
    ├── test.mjs                   网页侧用例（跑之前先构建）
    ├── README.md                  网页版说明
    └── dist/                      构建产物（gitignore，不入库），整个目录上传到网站
```

目录名 `gguf-check` 是历史遗留（产品名早改成 vramfit 了），不影响任何东西 ——
它不出现在发布物里。

## 改完怎么跑

**只改命令行**

```bash
npm test
node check.mjs --help
```

不需要构建，`site/` 也不受影响。

**碰了 `core/` 或 `net/`**

两边都要重新验证，网页版还得重新构建，否则线上还是旧代码：

```bash
npm test
cd site && node build.mjs && npm test
```

**只改网页**

```bash
cd site && npm test          # 内含 node build.mjs
```

`site/dist/` 是生成物，手改会在下次构建时被覆盖。测试里有一条专盯「`dist/` 和源码
不一致」—— 忘了构建会直接失败，不会悄悄发一份旧代码上线。

**本地预览网页**

```bash
cd site
node build.mjs
node serve.mjs          # http://localhost:8788
```

## 三条不能破的约束

1. **`core/` 和 `net/` 不许出现 `node:` 内置模块。** 网页版直接 `import` 这两层，
   一个 `import fs` 就让页面白屏。两边的测试和 CI 都守着。
2. **`site/` 必须是仓库根的直接子目录。** `build.mjs` 按 `../core` 找解析层，挪走就构建不了。
3. **改判据就要同步改 `core/assumptions.mjs` 里的文字。** 那个文件是 `--about`、
   README 和网页共用的唯一来源，数字和说明对不上比数字错更麻烦。

## 提交前

```bash
npm test && cd site && node build.mjs && npm test
cd .. && node publish-check.mjs        # 发布前最后一道
```

`publish-check.mjs` 会打一个 tarball、装进干净工程、验证两个 bin 都能跑，
顺便核对 `check.mjs` 里写死的 `VERSION` 和 `package.json` 是否一致。

## 发布

### 1. 命令行 → GitHub

```bash
git add -A && git commit -m "..." && git push
```

CI 会在 ubuntu / windows / macos × Node 18/20/22 上跑一遍，外加 `core/` 纯净性检查。

### 2. 网页版 → 网站

```bash
cd site && node build.mjs
```

然后把 **`site/dist/` 整个目录**传上去。三点注意：

- `index.html` 必须和 `core/` `net/` `web/` 在同一层，**只传 index.html 是不行的**。
- 必须是 http(s) 访问。双击 `dist/index.html` 不会有反应 —— 浏览器禁止 `file://`
  页面加载 ES 模块。要双击请用 `dist/vramfit.html`（单文件版，约 165 KB）。
- 不需要后端。浏览器直接向 HuggingFace 的 CDN 发 Range 请求，流量不经过服务器。

Cloudflare Pages / Vercel：构建命令留空，输出目录填 `site/dist`。
nginx：把 `dist/` 里的内容拷进站点目录。

### 3. npm

```bash
npm version patch|minor|major
npm publish
```

`check.mjs` 里的 `VERSION` 是写死的（单文件 bin 不去读包元数据），改版本号要两处一起改。
测试会对不上直接失败。

## 有问题或者想法

- 不确定某个方向该不该做（比如「要不要支持 safetensors」），先开个
  [Issue](https://github.com/RoRoToCode/vramfit/issues) 聊，别先写一版再被拒。
- 发现安全问题，发邮件到 <su@roroto.com>，不要公开开 Issue。
- 觉得用法没说清楚，也是 Issue —— 那是文档的问题，不是你的问题。

## 许可

MIT。别人拿去改、商用、嵌进自己的产品都行，唯一硬性要求是保留许可声明。
网页版构建会把 `LICENSE` 复制成 `dist/LICENSE.txt`，测试守着它别丢。
改名的、二次分发的，README 里有完整说法。
