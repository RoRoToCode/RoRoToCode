# vramfit 网页版

在线地址：<https://www.roroto.com/tools/vramfit/>

贴一个 HuggingFace 链接，或者拖一个本地 `.gguf` 进来，不下载模型就能知道：
**这台机器能开多大上下文、它到底能不能驱动 coding agent。**

纯静态，没有后端，没有环境变量，不需要数据库。服务器只发 HTML 和几个 `.mjs`。

> **语言**：中文和英文。页面文案在 `src/web/strings.mjs`（界面）和根目录的
> `core/i18n.mjs`（判定结论），两者都按页面的 `<html lang>` 定语言，
> 所以独立版（`dist/`）跟着 `index.html` 的 `zh-CN` 走中文，而挂到 roroto 站点上时
> 母站会先注入 `window.__VRAMFIT_LANG`，同一个 `app.mjs` 就能渲染对应语种。
> 新增语种时注意：这两个词条表要一起加，只加一边会出现「中文界面 + 英文结论」。
> 西班牙语还没做。
>
> **所有结论都是静态推算，仅供参考，需实际加载运行验证。**
> 算式、参数、误差范围见 [`../README.md`](../README.md#免责声明与参数说明)，
> 页面上也能展开同一份清单。

## 这个目录是什么

命令行版在仓库根，网页版是这里 —— **各自能单独用**，网页版不依赖命令行的入口文件。

```
site/
├── src/                 网页自己的源码
│   ├── index.html       页面（含样式）
│   └── web/
│       ├── app.mjs      事件绑定、URL 参数还原、分享链接
│       ├── gpu.mjs      浏览器显卡识别（WebGL 渲染器 → 型号 → 显存/带宽表）
│       ├── local.mjs    本地文件读取（File.slice 只读头部，不上传）
│       ├── strings.mjs  页面界面文案的中英词条 + tx() 取值函数
│       └── report.mjs   HTML 渲染
├── build.mjs            构建：src/ + ../{core,net} → dist/
├── serve.mjs            本地预览 dist/
├── test.mjs             网页侧测试（渲染 / 显卡识别 / 产物是否过期）
├── package.json
└── dist/                构建产物，整个目录上传
```

解析和推算**不在这里**。`core/`（GGUF 解析、KV 推算、显存预算）和 `net/`（HTTP Range）
都在仓库根（`site/` 的上一层），构建时直接读过来，不复制。所以命令行和网页拿到的是同一份
`meta` 和 `assess()` 结果，数字不会分叉。

代价只有一个：`site/` 必须是仓库根的直接子目录，否则找不到 `core/`。
单独把 `site/` 拷走，`dist/` 还能照常用，但重新构建会报"找不到 core"。

## 构建与预览

需要 Node 18+（只用于构建，部署时完全不需要）。

```bash
cd site
node build.mjs      # 生成 dist/：多文件版 + 单文件版
node serve.mjs      # http://localhost:8788
```

`dist/` 里是什么：

| 文件 | 说明 |
|---|---|
| `index.html` + `core/` `net/` `web/` | 多文件版，**必须用 http(s) 打开** |
| `vramfit.html` | 单文件版，双击即用，不需要服务器也不需要 Node |
| `README.txt` | 就是给你看的部署提醒 |

改了 `src/` 或根目录的 `{core,net}` 之后必须重新 `node build.mjs`。
`npm test` 会先构建再跑测试，其中一条专门比对 `dist/` 和源码是否逐字一致 ——
忘了构建会直接失败，而不是悄悄发一份旧代码上线。

## 部署

把 **`dist/` 整个目录**传上去（不是 `site/`，那里面有源码和构建脚本）。

线上实际用的是另一种挂法：<https://www.roroto.com/tools/vramfit/> 这一页由 roroto 站点自己的
`build.mjs` 生成外壳（站头、面包屑、侧栏、页脚），工作区里注入的是这里的表单和报告模块。
所以那边**不用** `dist/index.html`，只同步 `src/web/*.mjs` 和根目录的 `core/` `net/`，
样式则逐条加上 `.vfit` 前缀，避免 `body` / `h1` / `button` 这类通用选择器改坏站点。
改了这里的源码，要两边各构建一次（先 `node site/build.mjs`，再站点那边同步 + 构建）。

独立部署（自己的域名、Pages、内网）仍旧按下面来：

- **Cloudflare Pages / Vercel**：构建命令留空，输出目录填 `site/dist`
- **nginx**：把 `dist/` 里的内容拷进站点目录，比如 `/gguf/`
- **GitHub Pages**：把 `dist/` 的内容推到 `gh-pages` 分支

三点必须注意：

1. `index.html` 必须和 `core/` `net/` `web/` 在同一层，**只传 index.html 是不行的**。
2. 必须是 http(s) 访问。直接双击 `dist/index.html` 不会有反应 —— 浏览器禁止
   `file://` 页面加载 ES 模块，脚本一条都不执行，但页面长得完全正常。
   那个场景要用 `dist/vramfit.html`（单文件版，脚本内联）。
3. 不需要后端，也不需要 CORS 配置：浏览器直连 HuggingFace CDN，`Range` 属于
   CORS 安全列表请求头，单一区间连预检都不触发。

## 显存是怎么来的

浏览器拿不到真实显存 —— `navigator.gpu` 和 WebGL 只给型号，`maxBufferSize` 被 clamp 到 256 MB。
所以网页版走的是另一条路：

```
WebGL UNMASKED_RENDERER_WEBGL → 正则抽型号 → 内置显卡表拿显存和带宽
                              ↓ 认不出
                        下拉框手选 / 直接填数字
```

这带来两个必须知道的限制：

- **笔记本双显卡会报错卡。** 浏览器进程默认跑在核显上，报的是 Intel UHD 而不是 RTX 4060。
  所以下拉框永远可改。
- **已占用显存只能估。** 默认按 0.8 GB（桌面 + 浏览器）算，可以在「已占用」里改。
  命令行版本读的是 `nvidia-smi` 实测值。

Apple Silicon 报得出型号但报不出内存，认到 M 系列后手动填统一内存容量即可。

## 为什么不做后端代理

一旦服务器开始转发模型字节，这个工具就从「解析器」变成了「镜像站」——
带宽成本和合规风险一起上门。现在服务器只发 HTML 和几个 `.mjs`，零带宽成本。

## 拖拽本地文件

**拖到页面任何位置**都行，不只是那条虚线。拖进来时会铺一层遮罩，松手即开始读。
也可以点「选择文件」走文件选择器 —— 触控板用户和远程桌面场景下比拖拽靠谱。

文件不上传、不出浏览器：只用 `File.slice()` 读头部那十几 MB，
所以 20 GB 的模型也是秒出结果，内存里始终只有一小块。

## 测试

```bash
cd site && npm test        # node build.mjs && node --test test.mjs
```

22 个用例，不联网：

- 渲染：进度条百分比必须和标题里的 GB 数对得上、远端文件名里的控制字符和 `<script>`
  不能进 HTML、`&` 只能被转义一次、任何分支都不许出现 `undefined` / `NaN`、
  Q2 量化装得下也不许判「推荐」、量化对比表每一行都得真的能点开、没显卡时给的是
  CPU 速度而不是"带宽未知"、元数据不全报"算不出来"而不是"装不下"。
- 显卡识别：`ANGLE` / Firefox / Metal 各种渲染器字符串、`5070 Ti` 不能被 `5070`
  抢先匹配（显存差 4 GB）、软件渲染（SwiftShader / Basic Render Driver）不能被当成真显卡。
- 架构：`web/app.mjs` 引用的 DOM id 必须都存在于 `src/index.html`；
  `src/web/` 里出现 `node:` 模块直接判失败。
- 产物：`dist/` 必须和源码逐字一致；单文件版里不许残留 `import` / `export`。

## 许可

MIT。`dist/` 里的代码和仓库根是同一份，别人拿去部署、改造、嵌进自己的产品都行，
**唯一要求是保留许可声明**——所以构建会把根目录的 `LICENSE` 复制成 `dist/LICENSE.txt`，
测试里有一条守着它别丢。

如果你是这个项目的作者本人，部署到自己的站点时想删掉 `LICENSE.txt` 也没问题
（版权本来就在你手上），但留着更省事，改了源码顺手重新构建就自动带上了。

## 已知短板


- `dist/` 是构建产物，**不进仓库**（见 `.gitignore`）。部署前先 `node build.mjs`，
  再把整个目录传上去。测试会先构建再跑，所以源码和产物不会悄悄对不上。
- 显卡表没有覆盖所有型号，认不出就让用户手选或手填。
- 笔记本双显卡、外接显卡坞这类场景，浏览器报的型号可能就是错的，页面上只能提示、改不了。
- 模型站点固定走默认镜像，页面上改不了。镜像限流或临时挂掉时只能提示稍后重试 ——
  这是纯静态、无后端的代价。命令行那边可以用 `--mirror` 换源。
