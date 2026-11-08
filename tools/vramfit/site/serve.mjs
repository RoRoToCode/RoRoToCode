#!/usr/bin/env node
/**
 * 本地预览网页版。只是把 dist/ 当静态站点发出去，没有别的功能。
 *
 *   node build.mjs           # 先构建，serve 只发 dist/ 里已有的文件
 *   node serve.mjs           # http://localhost:8788
 *   node serve.mjs 3000      # 换端口
 *
 * 部署到线上时不需要它 —— dist/ 丢给任何静态托管（Cloudflare Pages /
 * Vercel / GitHub Pages / nginx）都能跑，没有后端。
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('./dist/', import.meta.url))
const PORT = Number(process.argv[2]) || 8788

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.rar': 'application/octet-stream'
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    let rel = decodeURIComponent(url.pathname)
    if (rel.endsWith('/')) rel += 'index.html'

    // 目录穿越防护：解析后必须仍在 ROOT 内
    const full = normalize(join(ROOT, rel))
    if (!full.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
      res.writeHead(403).end('forbidden')
      return
    }

    const body = await readFile(full)
    res.writeHead(200, {
      'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache'
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404')
  }
})

// dist/ 不存在时给一句人话，而不是让人对着满屏 404 猜
await readFile(join(ROOT, 'index.html')).catch(() => {
  console.error('dist/ 里还没有 index.html。先运行：node build.mjs')
  process.exit(1)
})

server.listen(PORT, () => {
  console.log(`网页版预览：http://localhost:${PORT}`)
  console.log('按 Ctrl+C 停止')
})
