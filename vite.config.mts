import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/**
 * 生产环境的 CSP。
 *
 * 为什么是这几条：
 * - `default-src 'none'` 兜底：没显式列出来的一律不许加载，新加的标签漏配会立刻暴露，
 *   而不是悄悄生效。
 * - `script-src 'self'`：界面脚本只从包内加载。没有 'unsafe-inline'，所以任何被注入的
 *   内联脚本都跑不起来 —— 这是 CSP 真正的价值所在。（配合 modulePreload.polyfill = false，
 *   Vite 默认注入的那段内联 polyfill 才不会撞上这条。）
 * - `style-src 'unsafe-inline'`：界面有 70 多处 React 内联样式（动态宽度、配色变量），
 *   style 属性受这条管，去掉会直接白屏。样式注入的风险远低于脚本，这个放宽是有意的。
 * - `img-src data:`：缩略图、正文插图都由主进程读盘后转成 base64 data URL 传进来，
 *   渲染层拿不到文件系统权限 —— 这正是它能保持只读的原因。
 * - `img-src https:`：markdown 里贴的外链图片要能显示。只放开 img，图片请求不执行脚本、
 *   读不到响应，且组件上已设 referrerPolicy="no-referrer"，不往外带来源页。
 * - `connect-src 'self'`：界面自己不直接请求网络（模型请求全在主进程），这条基本堵死。
 */
const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

/**
 * 开发环境单独一套：Vite 的 HMR 要开 websocket、React Refresh 要注入内联脚本和 eval，
 * 这些在打包产物里都不存在。用生产那套会让 dev 直接不可用。
 * 只放宽 script 和 connect 两项，其余保持与生产一致 —— 免得「dev 能跑、打包就白屏」。
 */
const DEV_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self' ws://localhost:5173 ws://127.0.0.1:5173 http://localhost:5173 http://127.0.0.1:5173",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

/**
 * 用 meta 注入而不是主进程 onHeadersReceived：
 * 生产是 file:// 加载，webRequest 拿不到响应头，header 方式对本地文件不生效。
 * meta 在 file:// 下有效，dev 和生产走同一个入口，只有内容不同。
 */
function cspPlugin(): Plugin {
  return {
    name: 'roroto-csp',
    transformIndexHtml(html, ctx) {
      const dev = Boolean(ctx.server)
      const tag = `    <meta http-equiv="Content-Security-Policy" content="${dev ? DEV_CSP : PROD_CSP}" />`
      return html.replace(/(\s*)<\/head>/, `\n${tag}$1</head>`)
    }
  }
}

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react(), cspPlugin()],
  server: { port: 5173, strictPort: true, fs: { allow: [resolve(__dirname)] } },
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    // 关掉 modulepreload 的 polyfill：它是一段内联 <script>，会撞上 script-src 'self'。
    // Electron 33 的 Chromium 原生支持 modulepreload，不需要这段垫片。
    modulePreload: { polyfill: false }
  }
})
