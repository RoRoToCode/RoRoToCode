/**
 * 联网工具：网页抓取（web_fetch）+ 搜索（web_search）。
 *
 * 不用第三方库：打包体积已经够大，这点功能用内置 fetch 就够。
 * 两个原则：
 *  - 只读：只发 GET，不提交表单、不带用户 cookie。
 *  - 不碰本机/内网地址：模型可能被网页内容牵着去抓 127.0.0.1 或局域网服务（SSRF），直接拒绝。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 RoRoToCode/0.1'

const MAX_BYTES = 3_000_000
const MAX_TEXT = 16000
const TIMEOUT = 25_000

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(Math.max(Math.round(n), min), max)
}

/** 本机 / 内网地址判定 */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::1' || h === '::') return true
  if (h.endsWith('.local') || h.endsWith('.internal')) return true
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
  }
  return false
}

function parseHttpUrl(raw: string): URL {
  const text = raw.trim()
  if (!text) throw new Error('url 不能为空')
  let url: URL
  try {
    url = new URL(/^[a-z][\w+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    throw new Error(`不是合法的网址：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`只支持 http/https，收到的是 ${url.protocol}`)
  }
  if (isPrivateHost(url.hostname)) {
    throw new Error(
      `拒绝访问本机或内网地址（${url.hostname}）。这类地址可能暴露本机服务，需要时请用 run_shell 执行 curl。`
    )
  }
  return url
}

function decodeBody(buf: Buffer, charset?: string): string {
  const cs = (charset || '').trim().toLowerCase()
  if (cs && cs !== 'utf-8' && cs !== 'utf8') {
    try {
      // Node 自带完整 ICU，gbk / gb2312 这类也能解
      return new TextDecoder(cs).decode(buf)
    } catch {
      // 不认识的编码，按 utf-8 兜底
    }
  }
  return buf.toString('utf8')
}

interface FetchOut {
  status: number
  finalUrl: string
  type: string
  body: string
}

async function request(
  url: string,
  opts: { signal?: AbortSignal; timeout?: number; accept?: string } = {}
): Promise<FetchOut> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`请求超过 ${opts.timeout ?? TIMEOUT}ms`)), opts.timeout ?? TIMEOUT)
  const forward = () => ac.abort(new Error('已取消'))
  opts.signal?.addEventListener('abort', forward, { once: true })
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'user-agent': UA,
        accept:
          opts.accept ??
          'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,text/markdown;q=0.7,*/*;q=0.5',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    })
    const type = res.headers.get('content-type') ?? ''
    const charset = type.match(/charset=["']?([\w-]+)/i)?.[1]
    const chunks: Buffer[] = []
    let size = 0
    if (res.body) {
      const reader = res.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        chunks.push(Buffer.from(value))
        size += value.byteLength
        if (size >= MAX_BYTES) {
          await reader.cancel().catch(() => undefined)
          break
        }
      }
    }
    return { status: res.status, finalUrl: res.url || url, type, body: decodeBody(Buffer.concat(chunks), charset) }
  } catch (err) {
    if (ac.signal.aborted && opts.signal?.aborted) throw new Error('已取消')
    const e = err as Error & { cause?: { code?: string } }
    const code = e.cause?.code ?? ''
    if (ac.signal.aborted) throw new Error(`请求超时（${opts.timeout ?? TIMEOUT}ms）`)
    if (code === 'ENOTFOUND') throw new Error('域名解析失败：网址拼错，或当前网络解析不了这个域名')
    if (code === 'ECONNREFUSED') throw new Error('连接被拒绝：对方服务器没在监听，或被防火墙拦了')
    if (code === 'ECONNRESET') throw new Error('连接被重置：可能是网络波动，或对方限制了访问')
    if (/CERT|SSL|TLS/i.test(code)) throw new Error(`证书校验失败（${code}），这个站点的 HTTPS 配置有问题`)
    if (e.message === 'fetch failed') {
      throw new Error('网络请求失败：可能是没联网、需要代理，或这个站点在当前网络下访问不了')
    }
    throw new Error(e.message || '网络错误')
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', forward)
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  divide: '÷',
  laquo: '«',
  raquo: '»',
  bull: '•',
  dagger: '†',
  permil: '‰',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  plusmn: '±',
  frac12: '½',
  sup2: '²',
  sup3: '³'
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (Number.isFinite(code) && code > 0 && code < 0x110000) {
        try {
          return String.fromCodePoint(code)
        } catch {
          return m
        }
      }
      return m
    }
    return ENTITIES[body.toLowerCase()] ?? m
  })
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/** 把 HTML 压成可读纯文本：丢脚本样式、保留标题层级和列表符号 */
export function htmlToText(html: string): { title: string; text: string } {
  const rawTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''
  const title = stripTags(rawTitle)

  let h = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(head|nav|footer)\b[\s\S]*?<\/\1>/gi, ' ')

  h = h
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|aside|main|blockquote|pre|tr|dd|dt|figure|figcaption|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<h[1-6][^>]*>/gi, '\n## ')
    .replace(/<td[^>]*>|<th[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')

  h = decodeEntities(h)
  const lines = h.split(/\r?\n/).map((l) => l.replace(/[ \t\u00a0\u3000]+/g, ' ').trim())
  const out: string[] = []
  for (const line of lines) {
    if (!line) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      continue
    }
    // 折叠重复的“## ”层级符号
    out.push(line.replace(/^(##\s*)+/, '## '))
  }
  return { title, text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim() }
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n…（已截断，原文共 ${text.length} 字符；需要后面部分请抓更具体的页面）`
}

/** 抓一个网页并转成文本 */
export async function webFetchTool(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const url = parseHttpUrl(String(args.url ?? ''))
  const maxChars = clamp(Number(args.max_chars ?? MAX_TEXT), 1000, 40000)
  const res = await request(url.toString(), { signal })

  if (res.status >= 400) throw new Error(`HTTP ${res.status} ${res.status >= 500 ? '（站点出错）' : '（页面不存在或无权限）'}：${res.finalUrl}`)

  const type = res.type.toLowerCase()
  if (/^(image|audio|video)\//.test(type) || /application\/(pdf|zip|x-zip|octet-stream|msword|vnd\.)/.test(type)) {
    throw new Error(
      `这个地址返回的是二进制内容（${type.split(';')[0] || '未知类型'}），网页工具只能读文本。要下载文件请用 run_shell 执行 curl。`
    )
  }

  const looksHtml = type.includes('html') || /^\s*<(!doctype|html)/i.test(res.body.slice(0, 200))
  const { title, text } = looksHtml ? htmlToText(res.body) : { title: '', text: res.body }
  const body = cut(text, maxChars).trim()

  const head = [`URL: ${res.finalUrl}`]
  if (title) head.push(`标题: ${title}`)
  if (!body) {
    head.push('（这个页面没有可读正文：可能是纯前端渲染、需要登录，或内容都在脚本里。可以换个链接或搜索其他来源）')
  }
  return `${head.join('\n')}\n\n${body}`
}

interface Hit {
  title: string
  url: string
  snippet: string
}

/** 必应的跳转链接里带着 base64 的真实地址，解出来 */
function realTarget(href: string): string {
  const h = decodeEntities(href)
  if (!/bing\.com\/ck\/a/i.test(h)) return h
  const m = h.match(/[?&]u=a1([^&]+)/)
  if (!m) return h
  try {
    const b64 = decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/')
    const out = Buffer.from(b64, 'base64').toString('utf8')
    return /^https?:\/\//.test(out) ? out : h
  } catch {
    return h
  }
}

function parseBing(html: string): Hit[] {
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? []
  const hits: Hit[] = []
  for (const b of blocks) {
    const a = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!a) continue
    const url = realTarget(a[1])
    const title = stripTags(a[2])
    const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
    const snippet = p ? stripTags(p[1]).slice(0, 260) : ''
    if (!title || !/^https?:\/\//.test(url)) continue
    hits.push({ title, url, snippet })
  }
  return hits
}

function parseDuckDuckGo(html: string): Hit[] {
  const hits: Hit[] = []
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  for (const m of html.matchAll(re)) {
    let url = decodeEntities(m[1])
    // DDG 的跳转：//duckduckgo.com/l/?uddg=<encoded>
    const uddg = url.match(/[?&]uddg=([^&]+)/)
    if (uddg) url = decodeURIComponent(uddg[1])
    if (url.startsWith('//')) url = `https:${url}`
    if (!/^https?:\/\//.test(url)) continue
    hits.push({ title: stripTags(m[2]), url, snippet: '' })
  }
  // 摘要紧跟在链接后面，单独再扫一遍配对
  const snippets = [...html.matchAll(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) =>
    stripTags(m[1]).slice(0, 260)
  )
  hits.forEach((h, i) => {
    if (snippets[i]) h.snippet = snippets[i]
  })
  return hits
}

function formatHits(query: string, hits: Hit[]): string {
  const lines = hits.map(
    (h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`
  )
  return [
    `搜索「${query}」得到 ${hits.length} 条结果：`,
    '',
    lines.join('\n\n'),
    '',
    '摘要只是片段，需要细节就用 web_fetch 打开其中最相关的链接（一次抓一两个即可）。'
  ].join('\n')
}

/** 联网搜索：必应优先（国内外都通），失败再换 DDG */
export async function webSearchTool(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const query = String(args.query ?? '').trim()
  if (!query) throw new Error('query 不能为空')
  const count = clamp(Number(args.count ?? 8), 1, 15)
  const per = Math.max(count * 2, 20)

  const engines: Array<{ url: string; parse: (html: string) => Hit[] }> = [
    { url: `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${per}`, parse: parseBing },
    { url: `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${per}`, parse: parseBing },
    {
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      parse: parseDuckDuckGo
    }
  ]

  const errors: string[] = []
  for (const engine of engines) {
    if (signal.aborted) throw new Error('已取消')
    try {
      const res = await request(engine.url, { signal, timeout: 20000 })
      if (res.status >= 400) {
        errors.push(`${new URL(engine.url).host} HTTP ${res.status}`)
        continue
      }
      const hits = engine.parse(res.body)
      if (!hits.length) {
        errors.push(`${new URL(engine.url).host} 没有解析到结果`)
        continue
      }
      return formatHits(query, hits.slice(0, count))
    } catch (err) {
      errors.push(`${new URL(engine.url).host} ${(err as Error).message}`)
    }
  }

  throw new Error(
    `搜索失败：${errors.join('；')}。可以换更短的关键词重试，或者直接 web_fetch 打开已知网址。`
  )
}
