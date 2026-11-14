/**
 * 输入解析：把用户粘贴的乱七八糟的文本变成「一个文件直链」或「一个仓库」。
 * 纯字符串处理，Node 和浏览器共用。
 */

import { baseName } from './util.mjs'
import { t } from './i18n.mjs'

export const OFFICIAL = 'https://huggingface.co'
export const DEFAULT_MIRROR = 'https://hf-mirror.com'
export const HF_HOSTS = new Set(['huggingface.co', 'hf-mirror.com', 'hf-mirror.net'])

/**
 * 当前走的模型站点。默认用镜像 —— 国内直连 huggingface.co 经常超时，
 * 而镜像只是把同一份文件转出来，路径结构完全一样，换过去不影响任何解析。
 *
 * 想直连官方：setMirror('')
 * 想换别的镜像：setMirror('https://你的镜像')
 *
 * 网页端不调用这两个函数，永远是默认值（浏览器里改不了，也不需要改）。
 */
let mirror = DEFAULT_MIRROR
function siteBase() {
  return mirror || OFFICIAL
}

/** 设置镜像地址，返回实际生效的站点。传空表示直连官方源。 */
export function setMirror(url) {
  const s = String(url ?? '').trim().replace(/\/+$/, '')
  mirror = /^https?:\/\//i.test(s) ? s : ''
  return siteBase()
}

/** 当前生效的站点地址 */
export function getMirror() {
  return siteBase()
}

/** 是否在用镜像（而不是官方源） */
export function usingMirror() {
  return mirror !== ''
}

// 从浏览器地址栏、微信、飞书、PDF 里复制出来的链接经常带着肉眼看不见的东西：
// 零宽空格、BOM、软连字符。String.trim() 不认这些字符，于是整条链接被判成
// "不是链接"，用户只会看到"没认出这是链接还是文件"。所以先洗一遍。
const ZERO_WIDTH = /[\u00ad\u200b-\u200f\u2060\ufeff\u180e\u2028\u2029]/g

// 包裹符号：从聊天窗口、文档里复制出来的链接常被这些东西夹住
const LEAD_WRAP = /^["'`<\u2018\u2019\u201c\u201d\u300c\u300d\u300e\u300f\u3010\u3011]+/
const TRAIL_WRAP = /["'`>\u2018\u2019\u201c\u201d\u300c\u300d\u300e\u300f\u3011]+$/

/**
 * 清洗用户粘贴进来的原始文本：去不可见字符、去包裹的引号尖括号、
 * 去句子末尾的标点、把 HTML 实体还原、截掉链接后面的中文说明。
 * 只做"还原成本来的样子"，不改写链接内容本身。
 */
export function cleanPasted(input) {
  let s = String(input ?? '').replace(ZERO_WIDTH, '')
  s = s.replace(/[\u00a0\u3000\t\r\n]/g, ' ').trim()
  if (!s) return ''

  // 从网页复制会带 HTML 实体
  if (/&(?:amp|quot|#39|lt|gt);/.test(s)) {
    s = s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  }

  // 链接前面还挂着一句"帮我看看"：只要后面确实跟着 http(s) 链接，就把前缀切掉
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const at = s.search(/https?:\/\//i)
    if (at > 0) s = s.slice(at)
  }

  // 被引号 / 尖括号 / 中文书名号包住
  s = s.replace(LEAD_WRAP, '').replace(TRAIL_WRAP, '')

  // 链接后面常跟着一句"这个模型怎么样" —— 只有确实是个链接时才截，
  // 否则会把 D:\模型\xxx.gguf 这种中文路径截断
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const cjk = s.search(/[\u4e00-\u9fff]/)
    if (cjk > 8) s = s.slice(0, cjk)
  }

  // 上一轮去尾部引号发生在截中文之前，`"https://…c.gguf" 这个模型行吗`
  // 截完还剩「引号 + 空格」的尾巴，必须再洗一次，否则整个链接被判成"不是 .gguf"
  s = s.replace(/\s+$/, '').replace(TRAIL_WRAP, '')

  // 句末标点（中文句号最容易跟着复制过来）
  s = s.replace(/[。，、；：！？,;]+$/, '')
  s = s.replace(/\.+$/, '')

  // 整体被括号包住：(url) / [url]
  if (/^\([^()]*\)$/.test(s) || /^\[[^[\]]*\]$/.test(s)) s = s.slice(1, -1)

  // 不配对的半个括号才是"多余的"，配对的可能是 URL 自己的一部分
  const count = (t, a, b) => (t.split(a).length - t.split(b).length)
  if (/^[([]/.test(s) && count(s, '(', ')') + count(s, '[', ']') > 0) s = s.replace(/^[([]+/, '')
  if (/[)\]]$/.test(s) && count(s, ')', '(') + count(s, ']', '[') > 0) s = s.replace(/[)\]]+$/, '')

  return s.trim()
}

/**
 * 认 hf / 镜像的各种链接。
 * 用户从浏览器复制出来的通常不是文件直链，而是模型主页或 blob 页面，
 * 这些地址返回的是 HTML，直接 fetch 只会得到「拿不到文件大小」。
 * 这里统一归一化成两种东西：文件直链，或者「整个仓库，列全部量化」。
 *
 * 返回 null 表示这不是 HF 链接（交给本地路径逻辑处理）。
 */
export function parseHfInput(input) {
  const s = cleanPasted(input)
  if (!s) return null
  let u
  try {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      // 允许直接粘 hf-mirror.com/xxx（不带协议头）
      if (!/^(?:www\.)?(?:huggingface\.co|hf-mirror\.(?:com|net))\//i.test(s)) {
        if (/modelscope\.(?:cn|com)/i.test(s)) {
          return { kind: 'invalid', reason: t('in.modelscope') }
        }
        return null
      }
      u = new URL(`https://${s}`)
    } else {
      u = new URL(s)
    }
  } catch { return null }
  const host = u.hostname.replace(/^www\./i, '').toLowerCase()
  if (/modelscope\.(?:cn|com)$/i.test(host)) {
    return { kind: 'invalid', reason: t('in.modelscope') }
  }
  if (!HF_HOSTS.has(host)) return null

  const parts = u.pathname.split('/').filter(Boolean)
  if (parts[0] === 'models') parts.shift()   // 有人会贴 /models/owner/repo
  if (!parts.length) return { kind: 'invalid', reason: t('in.noRepo') }

  // 少数情况下 & 被当成了路径的一部分（从 HTML 复制），仓库名里不会有 &
  const cleanName = (x) => x.replace(/[?&].*$/, '')
  const owner = cleanName(parts[0])
  const name = parts[1] ? cleanName(parts[1]) : undefined
  if (!name) return { kind: 'invalid', reason: t('in.noRepo2') }

  // 文件直链：/owner/repo/resolve|blob/<revision>/<path>
  if (parts[2] === 'resolve' || parts[2] === 'blob') {
    const rev = parts[3] || 'main'
    const file = parts.slice(4).join('/')
    if (!file) return { kind: 'repo', repo: `${owner}/${name}`, note: t('in.repoNote') }
    if (!/\.gguf$/i.test(file)) {
      return { kind: 'invalid', reason: t('in.notGguf', { file: baseName(file) }) }
    }
    return {
      kind: 'file',
      url: `${siteBase()}/${owner}/${name}/resolve/${rev}/${file}`,
      note: parts[2] === 'blob' ? t('in.blobNote') : undefined
    }
  }

  // 其余（模型主页 / tree / discussions …）一律按仓库处理，列出全部量化
  return {
    kind: 'repo',
    repo: `${owner}/${name}`,
    note: parts.length === 2 ? t('in.modelPageNote') : undefined
  }
}

/** 国内直连 huggingface.co 常不通，自动换成镜像；setMirror('') 之后保持原样 */
export function normalizeUrl(u) {
  if (/^https?:\/\/(www\.)?huggingface\.co\//i.test(u)) {
    return u.replace(/^https?:\/\/(www\.)?huggingface\.co\//i, `${siteBase()}/`)
  }
  return u
}

/**
 * 清掉字符串里的终端控制序列。
 * 仓库名、文件名、显卡名都来自外部（HF 仓库的文件名是上传者随便起的），
 * 一个 \x1b]0;标题\x07 就能改窗口标题，\x1b[2J 能清屏伪造输出。
 * 进终端之前统一洗一遍，保留换行和制表符。
 *
 * 网页侧同样要洗 —— 文件名会进 innerHTML 之外的任何地方，留着迟早出事。
 */
export function stripControl(s) {
  return String(s ?? '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')                 // CSI：颜色、清屏、光标
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')  // OSC：窗口标题、超链接
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}

// ───────────────────────────── 命令行参数 ─────────────────────────────

export const KV_TYPES = new Set(['f16', 'q8_0', 'q4_0', 'k8v16'])

/** 只有这几个选项带值，其余（--json / --no-color）是开关 */
export const VALUE_FLAGS = new Set(['--kv', '--vram', '--gpu', '--repo', '--mirror', '--lang', '--mmproj'])

/**
 * 把 --kv=q8_0 / --vram=8 / --repo=a/b 拆成两个参数。
 * 原先只认空格写法，等号写法会被 main 里「以 -- 开头就丢掉」的过滤整条吃掉，
 * 于是 --vram=99999 被静默忽略、按真实显存出报告 —— 正是上一轮刚修掉的那类问题。
 */
export function normalizeArgv(argv) {
  const out = []
  for (const a of argv) {
    const m = /^(--[a-z][a-z-]*)=(.+)$/i.exec(a)
    if (m && VALUE_FLAGS.has(m[1])) out.push(m[1], m[2])
    else out.push(a)
  }
  return out
}

/**
 * 解析 --kv / --vram / --repo。
 * 原先非法值会静默回落到默认值（--kv banana 等于没写，--vram -3 等于自动探测），
 * 用户看到的报告和参数对不上，却没有任何提示。
 */
export function parseOptions(argv) {
  const problems = []

  const kvIdx = argv.indexOf('--kv')
  let kvType = 'f16'
  if (kvIdx >= 0) {
    const v = argv[kvIdx + 1]
    if (!v || v.startsWith('--')) problems.push(t('in.p.kvNeeds'))
    else if (!KV_TYPES.has(v.toLowerCase())) problems.push(t('in.p.kvBad', { v }))
    else kvType = v.toLowerCase()
  }

  const vramIdx = argv.indexOf('--vram')
  let manualVram = 0
  if (vramIdx >= 0) {
    const raw = argv[vramIdx + 1]
    const n = Number(raw)
    if (!raw || raw.startsWith('--')) problems.push(t('in.p.vramNeeds'))
    else if (!Number.isFinite(n) || n <= 0) problems.push(t('in.p.vramBad', { v: raw }))
    else if (n > 1024) problems.push(t('in.p.vramHuge', { n }))
    else manualVram = n
  }

  // 选卡：一台机器两块卡时，第二个模型要按它自己那张卡的余量算，
  // 拿第一块卡的数去估必然出错。索引就是 nvidia-smi / llama-server 的设备序号。
  const gpuIdx = argv.indexOf('--gpu')
  let gpuIndex = 0
  if (gpuIdx >= 0) {
    const raw = argv[gpuIdx + 1]
    const n = Number(raw)
    if (!raw || raw.startsWith('--')) problems.push(t('in.p.gpuNeeds'))
    else if (!Number.isInteger(n) || n < 0) problems.push(t('in.p.gpuBad', { v: raw }))
    else gpuIndex = n
  }

  const repoIdx = argv.indexOf('--repo')
  let repo = null
  if (repoIdx >= 0) {
    const v = argv[repoIdx + 1]
    if (!v || v.startsWith('--')) problems.push(t('in.p.repoNeeds'))
    else {
      const hf = parseHfInput(v)
      repo = hf?.kind === 'repo' ? hf.repo : cleanPasted(v)
    }
  }

  // 换站点：默认走镜像，写官方地址就是直连。解析放在这里，
  // 真正生效（setMirror）由调用方做 —— core 不碰全局状态以外的东西。
  const mirIdx = argv.indexOf('--mirror')
  let mirror = null
  if (mirIdx >= 0) {
    const v = argv[mirIdx + 1]
    if (!v || v.startsWith('--')) {
      problems.push(t('in.p.mirrorNeeds'))
    } else if (!/^https?:\/\//i.test(v)) {
      problems.push(t('in.p.mirrorBad', { v }))
    } else {
      mirror = v
    }
  }

  /**
   * 视觉投影器：给了就把它的体积和激活开销算进预算。
   *
   * 这是「体检说装得下、发图片就崩」的根因：9B 模型带 mmproj 实测多占 680 MiB，
   * 而体检只算主模型文件。调用方在启动前知道会不会挂投影器，所以由它传进来。
   * 只做路径存在性检查（体积由 CLI 读），这里不碰文件系统 —— core 要能在浏览器跑。
   */
  const mmIdx = argv.indexOf('--mmproj')
  let mmproj = null
  if (mmIdx >= 0) {
    const v = argv[mmIdx + 1]
    if (!v || v.startsWith('--')) problems.push(t('in.p.mmprojNeeds'))
    else mmproj = cleanPasted(v)
  }

  return { kvType, manualVram, gpuIndex, repo, mirror, mmproj, problems }
}
