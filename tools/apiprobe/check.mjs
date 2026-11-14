/**
 * public-apis 连通性体检：同一个 endpoint 分别走「系统代理 / 直连 / Node 原生 fetch」。
 *
 * 为什么三种出口都要测：
 *  - curl 默认读 HTTP_PROXY/HTTPS_PROXY，代表「命令行 + 代理」；
 *  - curl --noproxy '*' 代表 RoRoToCode 的 run_shell —— safeEnv() 是白名单，不传代理变量；
 *  - Node fetch 代表主进程 web_fetch / basetools 这类用全局 fetch 的代码路径。
 * 三者不等价，只测一种很容易得出错误结论。
 *
 * 零依赖，Node 22+，需要本机有 curl。
 *
 *   node tools/apiprobe/check.mjs
 *   node tools/apiprobe/check.mjs --json
 *   node tools/apiprobe/check.mjs --csv > result.csv
 *   node tools/apiprobe/check.mjs --concurrency 4 --timeout 20
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 全部是免密钥、GET、返回文本/JSON 的地址；少数是网络环境对照 */
const BASE_ENDPOINTS = [
  { name: 'Cat Facts', cat: 'Animals', url: 'https://catfact.ninja/fact' },
  { name: 'Dog CEO', cat: 'Animals', url: 'https://dog.ceo/api/breeds/image/random' },
  { name: 'GitHub API', cat: 'Development', url: 'https://api.github.com/repos/public-apis/public-apis' },
  { name: 'GitHub Zen', cat: 'Development', url: 'https://api.github.com/zen' },
  { name: 'JSONPlaceholder', cat: 'Test Data', url: 'https://jsonplaceholder.typicode.com/todos/1' },
  { name: 'DummyJSON', cat: 'Test Data', url: 'https://dummyjson.com/products/1' },
  { name: 'PokeAPI', cat: 'Games & Comics', url: 'https://pokeapi.co/api/v2/pokemon/1' },
  { name: 'REST Countries', cat: 'Open Data', url: 'https://restcountries.com/v3.1/name/china?fields=name' },
  { name: 'Open-Meteo', cat: 'Weather', url: 'https://api.open-meteo.com/v1/forecast?latitude=39.9&longitude=116.4&current=temperature_2m' },
  { name: 'wttr.in', cat: 'Weather', url: 'https://wttr.in/Beijing?format=j1' },
  { name: 'Frankfurter', cat: 'Currency Exchange', url: 'https://api.frankfurter.app/latest?from=USD&to=CNY' },
  { name: 'CoinGecko', cat: 'Cryptocurrency', url: 'https://api.coingecko.com/api/v3/ping' },
  { name: 'ipify', cat: 'Development', url: 'https://api.ipify.org?format=json' },
  { name: 'ipapi.co', cat: 'Geocoding', url: 'https://ipapi.co/json/' },
  { name: 'httpbin', cat: 'Development', url: 'https://httpbin.org/get' },
  { name: 'Nager.Date', cat: 'Calendar', url: 'https://date.nager.at/api/v3/NextPublicHolidays/CN' },
  { name: 'Open Library', cat: 'Books', url: 'https://openlibrary.org/search.json?q=typescript&limit=1' },
  { name: 'Wikipedia', cat: 'Open Data', url: 'https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json' },
  { name: 'Agify', cat: 'Personality', url: 'https://api.agify.io/?name=mei' },
  { name: 'Nationalize', cat: 'Personality', url: 'https://api.nationalize.io/?name=mei' },
  { name: 'Chuck Norris', cat: 'Entertainment', url: 'https://api.chucknorris.io/jokes/random' },
  { name: 'ExchangeRate open', cat: 'Currency Exchange', url: 'https://open.er-api.com/v6/latest/USD' },
  { name: 'WorldTimeAPI', cat: 'Calendar', url: 'https://worldtimeapi.org/api/timezone/Asia/Shanghai' },
  { name: 'US NWS', cat: 'Weather', url: 'https://api.weather.gov/points/39.9,-77.0' },
  { name: 'Random User', cat: 'Test Data', url: 'https://randomuser.me/api/' },
  { name: 'Quotable', cat: 'Entertainment', url: 'https://api.quotable.io/random' },
  { name: 'Google', cat: '对照', url: 'https://www.google.com/' },
  { name: 'OpenAI', cat: '对照', url: 'https://api.openai.com/v1/models' },
  { name: 'Baidu', cat: '对照', url: 'https://www.baidu.com/' },
  { name: 'npmmirror', cat: '对照', url: 'https://registry.npmmirror.com/react/latest' },
  { name: 'Gitee', cat: '对照', url: 'https://gitee.com/api/v5/repos/oschina/git-osc' }
]

// 第二轮补测：包元数据 / 代码搜索 / 漏洞库 / 学术 / 地理等对开发者更有用的端点。
const EXTRA_ENDPOINTS = [
  { name: 'npm registry 包元数据', cat: 'Development', use: '查包版本/依赖', url: 'https://registry.npmjs.org/react/latest' },
  { name: 'npm 下载量', cat: 'Development', use: '查包周下载量', url: 'https://api.npmjs.org/downloads/point/last-week/react' },
  { name: 'npm 搜索', cat: 'Development', use: '搜 npm 包', url: 'https://registry.npmjs.org/-/v1/search?text=typescript&size=1' },
  { name: 'PyPI 包元数据', cat: 'Development', use: '查 Python 包', url: 'https://pypi.org/pypi/requests/json' },
  { name: 'crates.io', cat: 'Development', use: '查 Rust crate', url: 'https://crates.io/api/v1/crates/serde' },
  { name: 'RubyGems', cat: 'Development', use: '查 gem 版本', url: 'https://api.rubygems.org/api/v1/versions/rails/latest.json' },
  { name: 'NuGet 版本索引', cat: 'Development', use: '查 .NET 包版本', url: 'https://api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json' },
  { name: 'Go module proxy', cat: 'Development', use: '查 Go 模块版本', url: 'https://proxy.golang.org/github.com/gin-gonic/gin/@v/list' },
  { name: 'jsDelivr 包版本', cat: 'Development', use: '查 CDN 可用版本', url: 'https://data.jsdelivr.com/v1/package/npm/react' },
  { name: 'cdnjs 库列表', cat: 'Development', use: '查前端 CDN 库', url: 'https://api.cdnjs.com/libraries?search=react' },
  { name: 'Bundlephobia 体积', cat: 'Development', use: '查 npm 包打包体积', url: 'https://bundlephobia.com/api/size?package=react' },
  { name: 'GitHub releases', cat: 'Development', use: '查最新发行版', url: 'https://api.github.com/repos/nodejs/node/releases/latest' },
  { name: 'GitHub 安全公告', cat: 'Security', use: '查 npm 生态漏洞', url: 'https://api.github.com/advisories?ecosystem=npm&per_page=1' },
  { name: 'GitHub 仓库搜索', cat: 'Development', use: '搜开源仓库', url: 'https://api.github.com/search/repositories?q=public-apis&per_page=1' },
  { name: 'grep.app 代码搜索', cat: 'Development', use: '跨仓库搜代码片段', url: 'https://grep.app/api/search?q=useState' },
  { name: 'HN Algolia 搜索', cat: 'Development', use: '搜 Hacker News', url: 'https://hn.algolia.com/api/v1/search?query=typescript&hitsPerPage=1' },
  { name: 'Hacker News item', cat: 'Development', use: '读 HN 条目', url: 'https://hacker-news.firebaseio.com/v0/item/1.json' },
  { name: 'Stack Exchange', cat: 'Development', use: '查 SO 站点信息', url: 'https://api.stackexchange.com/2.3/info?site=stackoverflow' },
  { name: 'arXiv', cat: 'Science & Math', use: '搜论文（Atom XML）', url: 'https://export.arxiv.org/api/query?search_query=all:electron&max_results=1' },
  { name: 'Crossref', cat: 'Science & Math', use: '查 DOI / 文献', url: 'https://api.crossref.org/works?query.title=typescript&rows=1' },
  { name: 'OpenAlex', cat: 'Science & Math', use: '查学术文献', url: 'https://api.openalex.org/works?search=typescript&per-page=1' },
  { name: 'Semantic Scholar', cat: 'Science & Math', use: '查论文检索', url: 'https://api.semanticscholar.org/graph/v1/paper/search?query=typescript&limit=1' },
  { name: 'OSV 漏洞库', cat: 'Security', use: '按 GHSA/CVE 查漏洞', url: 'https://api.osv.dev/v1/vulns/GHSA-9hjg-9r4m-mvj7' },
  { name: 'NVD CVE', cat: 'Security', use: '查 CVE 详情', url: 'https://services.nvd.nist.gov/rest/json/cves/2.0?resultsPerPage=1' },
  { name: 'crt.sh 证书透明', cat: 'Security', use: '查域名签发证书', url: 'https://crt.sh/?q=github.com&output=json' },
  { name: 'SSL Labs info', cat: 'Security', use: '查 SSL 检测服务状态', url: 'https://api.ssllabs.com/api/v3/info' },
  { name: 'urlscan.io 搜索', cat: 'Security', use: '查网站扫描记录', url: 'https://urlscan.io/api/v1/search/?q=domain:github.com&size=1' },
  { name: 'icanhazip', cat: 'Development', use: '查出口 IP（纯文本）', url: 'https://icanhazip.com/' },
  { name: 'ifconfig.me', cat: 'Development', use: '查出口 IP（纯文本）', url: 'https://ifconfig.me/ip' },
  { name: 'ipwho.is', cat: 'Geocoding', use: 'IP 归属地 / 时区', url: 'https://ipwho.is/' },
  { name: 'timeapi.io', cat: 'Calendar', use: '查指定时区当前时间', url: 'https://timeapi.io/api/Time/current/zone?timeZone=Asia%2FShanghai' },
  { name: 'Google DoH', cat: '对照', use: 'DNS over HTTPS（境外对照）', url: 'https://dns.google/resolve?name=example.com&type=A' },
  { name: 'Open-Meteo 地理编码', cat: 'Geocoding', use: '地名转经纬度', url: 'https://geocoding-api.open-meteo.com/v1/search?name=Beijing&count=1' },
  { name: 'Nominatim', cat: 'Geocoding', use: 'OSM 地名检索（需 UA）', url: 'https://nominatim.openstreetmap.org/search?q=Beijing&format=json&limit=1' },
  { name: 'Sunrise-Sunset', cat: 'Weather', use: '查日出日落时间', url: 'https://api.sunrise-sunset.org/json?lat=39.9&lng=116.4&formatted=0' },
  { name: 'Zippopotam', cat: 'Geocoding', use: '邮编查地区', url: 'https://api.zippopotam.us/us/90210' },
  { name: 'MET Norway', cat: 'Weather', use: '北欧气象预报（需 UA）', url: 'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=39.9&lon=116.4' },
  { name: 'Coinbase 行情', cat: 'Cryptocurrency', use: '查 BTC 现货价', url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot' },
  { name: 'CoinCap', cat: 'Cryptocurrency', use: '查加密资产', url: 'https://api.coincap.io/v2/assets/bitcoin' },
  { name: 'Blockchain.info ticker', cat: 'Blockchain', use: '查 BTC 行情', url: 'https://blockchain.info/ticker' },
  { name: 'ISS 位置', cat: 'Science & Math', use: '查空间站实时坐标', url: 'https://api.wheretheiss.at/v1/satellites/25544' },
  { name: 'NASA 图片库', cat: 'Open Data', use: '搜 NASA 图像', url: 'https://images-api.nasa.gov/search?q=moon&page_size=1' },
  { name: '大都会博物馆', cat: 'Art & Design', use: '查藏品对象', url: 'https://collectionapi.metmuseum.org/public/collection/v1/objects/1' },
  { name: '芝加哥艺术馆', cat: 'Art & Design', use: '搜馆藏作品', url: 'https://api.artic.edu/api/v1/artworks/search?q=monet&limit=1' },
  { name: 'Postman Echo', cat: 'Test Data', use: 'HTTP 请求回显', url: 'https://postman-echo.com/get' },
  { name: 'JokeAPI', cat: 'Entertainment', use: '随机笑话', url: 'https://v2.jokeapi.dev/joke/Any' },
  { name: 'Advice Slip', cat: 'Entertainment', use: '随机建议', url: 'https://api.adviceslip.com/advice' },
  { name: 'Useless Facts', cat: 'Entertainment', use: '随机冷知识', url: 'https://uselessfacts.jsph.pl/api/v2/facts/random' }
]

// 第一轮条目补用途，让 CSV 输出与 docs/public-apis-可用清单.csv 的口径一致
const USE_BASE = {
  'Cat Facts': '随机猫知识', 'Dog CEO': '随机狗狗图片（JSON）', 'GitHub API': '查仓库元数据',
  'GitHub Zen': '连通性冒烟', 'JSONPlaceholder': '假 todo 数据', 'DummyJSON': '假商品数据',
  'PokeAPI': '宝可梦数据', 'REST Countries': '国家信息', 'Open-Meteo': '全球天气预报',
  'wttr.in': '终端天气（JSON）', 'Frankfurter': '历史/最新汇率', 'CoinGecko': '加密行情（本轮不通）',
  ipify: '查出口 IP（本轮不通）', 'ipapi.co': 'IP 归属地（403）', httpbin: 'HTTP 请求回显',
  'Nager.Date': '各国公共节假日', 'Open Library': '图书检索（本轮不通）',
  Wikipedia: '维基百科 API（本轮不通）', Agify: '按名字推测年龄', Nationalize: '按名字推测国籍',
  'Chuck Norris': '随机笑话', 'ExchangeRate open': '汇率（无需注册）',
  WorldTimeAPI: '时区时间（本轮不通）', 'US NWS': '美国气象局点位数据',
  'Random User': '假用户数据', Quotable: '随机名言', Google: '境外对照',
  OpenAI: '需密钥对照', Baidu: '境内对照', npmmirror: '境内对照', Gitee: '境内对照'
}

const ENDPOINTS = [
  ...BASE_ENDPOINTS.map((e) => ({ ...e, use: USE_BASE[e.name] || '' })),
  ...EXTRA_ENDPOINTS
]

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback
}
const asJson = process.argv.includes('--json')
const asCsv = process.argv.includes('--csv')
const TIMEOUT = arg('--timeout', 20) // 秒
const CONCURRENCY = arg('--concurrency', 4)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 RoRoToCode-apiprobe/1.0'
const ok = (r) => /^[23]\d\d$/.test(r.status)

function curl(ep, direct) {
  return new Promise((resolve) => {
    const body = path.join(os.tmpdir(), `apiprobe-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`)
    const args = [
      '-k', '-sS', '-L', '--max-time', String(TIMEOUT), '-A', UA,
      '-o', body, '-w', '%{http_code}|%{time_total}|%{remote_ip}'
    ]
    // -k 是刻意的：本机代理会做 TLS 中间人，证书错误会掩盖「服务能不能通」这个问题。
    if (direct) args.push('--noproxy', '*')
    args.push(ep.url)
    execFile('curl', args, { timeout: (TIMEOUT + 3) * 1000, windowsHide: true }, (err, stdout, stderr) => {
      try { fs.unlinkSync(body) } catch { /* 没生成就算了 */ }
      const p = String(stdout || '').trim().split('|')
      resolve({
        status: p[0] || 'ERR',
        secs: Number(p[1] || 0),
        ip: p[2] || '',
        err: err ? String(stderr || err.message).trim().slice(0, 120) : ''
      })
    })
  })
}

async function nodeFetch(ep) {
  const t = Date.now()
  try {
    const r = await fetch(ep.url, {
      signal: AbortSignal.timeout(TIMEOUT * 1000),
      headers: { 'user-agent': UA, accept: 'application/json' },
      redirect: 'follow'
    })
    await r.text()
    return { status: r.status, secs: (Date.now() - t) / 1000, ip: '', err: '' }
  } catch (e) {
    return {
      status: 'ERR', secs: (Date.now() - t) / 1000, ip: '',
      err: `${e.name}: ${e.cause?.code || e.cause?.message || e.message}`.slice(0, 120)
    }
  }
}

async function pool(items, worker) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) {
      const k = i++
      out[k] = await worker(items[k])
    }
  }))
  return out
}

const [proxy, direct, nodefetch] = [
  await pool(ENDPOINTS, (ep) => curl(ep, false)),
  await pool(ENDPOINTS, (ep) => curl(ep, true)),
  await pool(ENDPOINTS, nodeFetch)
]

const results = ENDPOINTS.map((ep, i) => ({
  name: ep.name, category: ep.cat, purpose: ep.use || '', url: ep.url,
  proxy: proxy[i], direct: direct[i], nodefetch: nodefetch[i],
  verdict: [proxy[i], direct[i], nodefetch[i]].filter(ok).length === 3
    ? 'ok'
    : [proxy[i], direct[i], nodefetch[i]].some(ok) ? 'partial' : 'failed'
}))

if (asJson) {
  console.log(JSON.stringify(results, null, 2))
} else if (asCsv) {
  const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"'
  console.log(['name', 'category', 'purpose', 'url', 'proxy', 'direct', 'node_fetch', 'verdict'].join(','))
  for (const r of results) {
    console.log([r.name, r.category, r.purpose, r.url, r.proxy.status, r.direct.status, r.nodefetch.status, r.verdict].map(esc).join(','))
  }
} else {
  const pad = (s, n) => String(s).padEnd(n, ' ').slice(0, n)
  const cell = (r) => `${ok(r) ? 'OK ' : 'X  '}${r.status}`
  console.log(`${ENDPOINTS.length} 个端点 × 3 种出口（超时 ${TIMEOUT}s，并发 ${CONCURRENCY}）\n`)
  console.log(pad('API', 24), pad('代理', 10), pad('直连', 10), pad('Node fetch', 12), '结论')
  for (const r of results) {
    console.log(pad(r.name, 24), pad(cell(r.proxy), 10), pad(cell(r.direct), 10), pad(cell(r.nodefetch), 12), r.verdict)
  }
  const real = results.filter((r) => r.category !== '对照')
  const n = (k) => real.filter((r) => ok(r[k])).length
  console.log(`\n真实 API ${real.length} 个：代理 ${n('proxy')} / 直连 ${n('direct')} / Node fetch ${n('nodefetch')} 可达`)
  console.log(`三通道全通 ${real.filter((r) => r.verdict === 'ok').length} 个，完全不通 ${real.filter((r) => r.verdict === 'failed').length} 个`)
  console.log('\n说明：单次超时不等于服务下线，网络抖动明显；结果需结合重试与对方限流策略判断。')
}
