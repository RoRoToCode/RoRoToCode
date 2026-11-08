import type { RemoteSkill, SkillScanResult, SkillSource } from '../shared/types'

/**
 * 在线技能源：仓库里每个 `xxx/SKILL.md` 就是一个技能（YAML frontmatter 写 name/description，
 * 正文就是指令）。这套格式在 GitHub 上已经是一批仓库的通用写法，所以直接按格式扫，
 * 不需要每个仓库单独适配。
 */
export const SOURCES: SkillSource[] = [
  {
    id: 'anthropic',
    label: 'Anthropic 官方技能',
    repo: 'anthropics/skills',
    ref: 'main',
    desc: 'PDF / Word / Excel / PPT / 前端设计 / MCP 等常用技能',
    builtin: true
  },
  {
    id: 'superpowers',
    label: 'Superpowers 开发流程',
    repo: 'obra/superpowers',
    ref: 'main',
    desc: '头脑风暴 / 写计划 / 执行计划 / 代码评审等研发流程',
    builtin: true
  },
  {
    id: 'offline',
    label: '离线内置',
    repo: '',
    ref: '',
    desc: '装在本机的基础技能，断网也能用：PDF / 图片 / Word / Excel / PPT / 归档',
    builtin: true,
    offline: true
  }
]

/** 断网兜底：不用 GitHub 也能拿到的常用技能 */
const OFFLINE: Array<{ name: string; desc: string; prompt: string }> = [
  {
    name: '读取 PDF',
    desc: '提取 PDF 的正文、表格、页数，扫描件走 OCR',
    prompt:
      '我有一个 PDF 文件，路径是：（补充路径）。请按顺序处理：\n1. 先确认环境：python 是否可用、是否装了 pypdf / pdfplumber，缺什么就装什么（pip install pypdf pdfplumber）。\n2. 读元信息和页数，再逐页提取正文；有表格的页用 pdfplumber 的 extract_tables 单独抽出来，转成 markdown 表格。\n3. 如果几乎没有文字层（扫描件），说明是扫描件，改成把页面转图片再用 OCR，并告诉我这么做的原因。\n4. 把全文存成同目录下的 同名.md，最后用几句话总结这份文档讲了什么。'
  },
  {
    name: '图片处理',
    desc: '压缩、裁剪、转格式、加水印、批量处理',
    prompt:
      '我要处理图片，目标素材在：（补充目录或文件路径），想要的效果是：（补充，比如压缩到 200KB 以内 / 统一转 jpg / 加右下角水印 / 批量裁成 1:1）。\n请用 Python 的 Pillow 写一个能重复跑的脚本：先读一张做试验并告诉我结果，确认没问题再批量跑；批量时打印每张的处理前后体积。不要覆盖原图，输出到 out/ 子目录。'
  },
  {
    name: '写 / 改 Word',
    desc: '生成 .docx、套模板、批量替换、转 PDF',
    prompt:
      '我要处理 Word 文档，需求是：（补充：新建报告 / 按模板填内容 / 批量替换关键词 / 转成 PDF），素材路径：（补充）。\n请用 python-docx 处理，保留原有的样式和标题层级；需要转 PDF 时优先用本机已有的 Word/WPS 导出，没装再考虑 LibreOffice。改之前先备份原文件，改完告诉我改了哪些地方。'
  },
  {
    name: '整理 Excel',
    desc: '读表、清洗、透视汇总、出图',
    prompt:
      '我有一个 Excel 文件：（补充路径），我要做的是：（补充：合并多表 / 去重 / 按某列分组汇总 / 画趋势图）。\n请先用 pandas 把表结构和前几行打印出来让我确认字段含义，再做处理；输出一份新的 xlsx，保留原始 sheet 不动，把统计结果放到新 sheet，并在对话里给出关键数字。'
  },
  {
    name: '做 PPT',
    desc: '按大纲生成 .pptx，含版式与配图位',
    prompt:
      '请帮我做一份 PPT，主题是：（补充主题），面向的听众和场合是：（补充），大概需要 N 页。\n先用 3-5 行列出大纲让我确认，再用 python-pptx 生成 .pptx：每页一个核心结论做标题，正文不超过 5 条要点，需要配图的位置留好占位。生成后告诉我文件路径和每页讲了什么。'
  },
  {
    name: '文件归档整理',
    desc: '按类型或日期批量改名、分目录，先列清单再动手',
    prompt:
      '请帮我整理这个目录：（补充路径）。规则是：（补充，比如按扩展名分类 / 按年月分文件夹 / 文件名统一成 日期_主题）。\n要求：第一步只扫描并列出一份「原路径 → 新路径」的清单给我确认，不要直接移动；我确认后再执行，移动用复制+校验的方式，遇到重名自动加序号，最后报告处理了多少个文件。'
  }
]

const API = 'https://api.github.com'
const RAW_MIRRORS = [
  (repo: string, ref: string, p: string) => `https://raw.githubusercontent.com/${repo}/${ref}/${p}`,
  (repo: string, ref: string, p: string) => `https://cdn.jsdelivr.net/gh/${repo}@${ref}/${p}`,
  (repo: string, ref: string, p: string) =>
    `https://ghproxy.net/https://raw.githubusercontent.com/${repo}/${ref}/${p}`,
  (repo: string, ref: string, p: string) =>
    `https://gh-proxy.com/https://raw.githubusercontent.com/${repo}/${ref}/${p}`
]

const MAX_SKILLS = 60
const MAX_FILE_BYTES = 300_000
const MAX_PROMPT = 9000
const TIMEOUT_MS = 15_000
const CACHE_MS = 10 * 60 * 1000

const cache = new Map<string, { at: number; result: SkillScanResult }>()

interface Target {
  repo: string
  ref: string
  /** 只扫这个目录下的技能，空表示整仓 */
  dir: string
}

function cleanRepo(raw: string): string | null {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(raw.replace(/\.git$/, ''))
  return m ? `${m[1]}/${m[2]}` : null
}

/**
 * 支持这些写法：
 *   owner/repo 、owner/repo@dev 、owner/repo#skills
 *   https://github.com/owner/repo[/tree/<ref>[/<dir>]]
 *   https://github.com/owner/repo/blob/<ref>/<dir>/SKILL.md
 *   https://raw.githubusercontent.com/owner/repo/<ref>/<dir>/...
 *   https://cdn.jsdelivr.net/gh/owner/repo@<ref>/<dir>/...
 */
export function parseTarget(input: string): Target | null {
  const text = String(input || '').trim()
  if (!text) return null

  // 简写：owner/repo@ref 或 owner/repo#dir
  const short = /^([\w.-]+\/[\w.-]+)(?:[@#](.+))?$/.exec(text)
  if (short) {
    const repo = cleanRepo(short[1])
    if (!repo) return null
    const tail = (short[2] ?? '').trim()
    if (!tail) return { repo, ref: 'main', dir: '' }
    return text.includes('#')
      ? { repo, ref: 'main', dir: tail.replace(/^\/+|\/+$/g, '') }
      : { repo, ref: tail, dir: '' }
  }

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  const parts = url.pathname.split('/').filter(Boolean)
  const host = url.hostname.toLowerCase()

  if (host === 'github.com' && parts.length >= 2) {
    const repo = cleanRepo(`${parts[0]}/${parts[1]}`)
    if (!repo) return null
    const kind = parts[2]
    if (kind === 'tree' || kind === 'blob') {
      const ref = parts[3] ?? 'main'
      let dir = parts.slice(4).join('/')
      if (kind === 'blob') dir = dir.replace(/\/?[^/]*\.md$/i, '')
      return { repo, ref, dir }
    }
    return { repo, ref: 'main', dir: '' }
  }

  if (host === 'raw.githubusercontent.com' && parts.length >= 3) {
    const repo = cleanRepo(`${parts[0]}/${parts[1]}`)
    if (!repo) return null
    const ref = parts[2]
    const dir = parts.slice(3).join('/').replace(/\/?[^/]*\.md$/i, '')
    return { repo, ref, dir }
  }

  if (host.endsWith('jsdelivr.net') && parts[0] === 'gh' && parts.length >= 3) {
    // https://cdn.jsdelivr.net/gh/owner/repo@ref/path
    const at = parts[2].lastIndexOf('@')
    const repo = cleanRepo(`${parts[1]}/${at > 0 ? parts[2].slice(0, at) : parts[2]}`)
    if (!repo) return null
    const ref = at > 0 ? parts[2].slice(at + 1) : 'main'
    const dir = parts.slice(3).join('/').replace(/\/?[^/]*\.md$/i, '')
    return { repo, ref, dir }
  }

  return null
}

async function getText(url: string, timeout = TIMEOUT_MS): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'RoRoToCode',
      Accept: 'application/vnd.github+json, text/plain, */*'
    },
    signal: AbortSignal.timeout(timeout)
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return await res.text()
}

/** 列仓库里所有 SKILL.md：先走 GitHub API，失败再走 jsDelivr 的文件清单 */
async function listSkillFiles(target: Target): Promise<string[]> {
  const prefix = target.dir ? `${target.dir.replace(/^\/+|\/+$/g, '')}/` : ''
  const pick = (paths: string[]) =>
    paths
      .filter((p) => /(^|\/)SKILL\.md$/i.test(p))
      .filter((p) => (prefix ? p.startsWith(prefix) : true))
      .filter((p) => p.split('/').length <= 6)
      .slice(0, MAX_SKILLS)

  try {
    const raw = await getText(
      `${API}/repos/${target.repo}/git/trees/${encodeURIComponent(target.ref)}?recursive=1`
    )
    const parsed = JSON.parse(raw) as { tree?: Array<{ path?: string; type?: string }>; message?: string }
    if (parsed.message && !parsed.tree) throw new Error(parsed.message)
    const paths = (parsed.tree ?? [])
      .filter((x) => x.type === 'blob' && typeof x.path === 'string')
      .map((x) => x.path as string)
    const hit = pick(paths)
    if (hit.length) return hit
    // 分支名可能不叫 main，退回仓库默认分支再试一次
    if (target.ref === 'main') {
      const info = JSON.parse(await getText(`${API}/repos/${target.repo}`)) as { default_branch?: string }
      if (info.default_branch && info.default_branch !== 'main') {
        return await listSkillFiles({ ...target, ref: info.default_branch })
      }
    }
    return []
  } catch (err) {
    const viaCdn = await listViaJsdelivr(target, pick)
    if (viaCdn.length) return viaCdn
    throw err
  }
}

async function listViaJsdelivr(target: Target, pick: (paths: string[]) => string[]): Promise<string[]> {
  try {
    const raw = await getText(
      `https://data.jsdelivr.com/v1/packages/gh/${target.repo}@${target.ref}?structure=flat`
    )
    const parsed = JSON.parse(raw) as { files?: Array<{ name?: string }> }
    const paths = (parsed.files ?? [])
      .map((f) => String(f.name ?? '').replace(/^\/+/, ''))
      .filter(Boolean)
    return pick(paths)
  } catch {
    return []
  }
}

async function readSkillFile(target: Target, filePath: string): Promise<string | null> {
  // 1) API contents（返回 base64，最稳）；2) 各种 raw 镜像
  try {
    const raw = await getText(
      `${API}/repos/${target.repo}/contents/${filePath}?ref=${encodeURIComponent(target.ref)}`
    )
    const parsed = JSON.parse(raw) as { content?: string; encoding?: string; size?: number }
    if (parsed.encoding === 'base64' && parsed.content) {
      const text = Buffer.from(parsed.content.replace(/\n/g, ''), 'base64').toString('utf8')
      if (text.length > MAX_FILE_BYTES) return null
      return text
    }
  } catch {
    /* 落到镜像 */
  }
  for (const mirror of RAW_MIRRORS) {
    try {
      const text = await getText(mirror(target.repo, target.ref, filePath), 6_000)
      if (text.length > MAX_FILE_BYTES) return null
      return text
    } catch {
      /* 换下一个镜像 */
    }
  }
  return null
}

function unquote(v: string): string {
  const t = v.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim()
  }
  return t
}

/**
 * 只解析顶层的 key: value。要处理 `description: >` 这种块标量，
 * 否则拿到的一行说明会是「>」或者「|-」。
 */
function parseFrontmatter(src: string): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = src.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i])
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()

    if (/^[>|][+-]?\d*$/.test(value)) {
      const folded = value.startsWith('>')
      const buf: string[] = []
      let j = i + 1
      while (j < lines.length && (lines[j].trim() === '' || /^\s/.test(lines[j]))) {
        buf.push(lines[j].trim())
        j += 1
      }
      while (buf.length && buf[buf.length - 1] === '') buf.pop()
      out[key] = folded ? buf.join(' ').replace(/\s+/g, ' ').trim() : buf.join('\n').trim()
      i = j - 1
    } else {
      out[key] = unquote(value)
    }
  }
  return out
}

/** 解析 SKILL.md：YAML frontmatter 里取 name/description，正文作为指令 */
export function parseSkillMd(text: string, fallbackName: string): {
  name: string
  desc: string
  prompt: string
} {
  let meta: Record<string, string> = {}
  let body = text

  const fm = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text)
  if (fm) {
    meta = parseFrontmatter(fm[1])
    body = text.slice(fm[0].length)
  }

  body = body.trim()
  const heading = /^#\s+(.+)$/m.exec(body.slice(0, 400))
  const name = (meta.name || heading?.[1] || fallbackName).trim().slice(0, 40)

  let desc = (meta.description || '').replace(/\s+/g, ' ').trim()
  if (!desc) {
    const para = body
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim())
      .find((p) => p.length > 12 && !p.startsWith('```'))
    desc = (para ?? '').slice(0, 90)
  }
  desc = desc.replace(/^["']|["']$/g, '').slice(0, 120)

  const prompt = body.length > MAX_PROMPT ? `${body.slice(0, MAX_PROMPT)}\n\n…（原文过长已截断）` : body
  return { name, desc, prompt }
}

function skillKey(repo: string, ref: string, p: string): string {
  return `${repo}@${ref}:${p}`
}

export function offlineSkills(): RemoteSkill[] {
  return OFFLINE.map((s) => ({
    key: `builtin:${s.name}`,
    name: s.name,
    desc: s.desc,
    prompt: s.prompt,
    path: '',
    repo: '本机内置',
    url: '',
    installed: false
  }))
}

export async function scanSkills(input: { repo?: string; sourceId?: string }): Promise<SkillScanResult> {
  const preset = input.sourceId ? SOURCES.find((s) => s.id === input.sourceId) : undefined
  if (preset?.offline) {
    return { ok: true, repo: '本机内置', ref: '', skills: offlineSkills(), offline: true }
  }

  const target = parseTarget(String(input.repo || preset?.repo || ''))
  if (!target) {
    return {
      ok: false,
      repo: '',
      ref: '',
      skills: [],
      offline: false,
      message: '看不懂这个地址。可以填 owner/repo、https://github.com/owner/repo，或者仓库里某个目录的链接。'
    }
  }

  const cacheKey = `${target.repo}@${target.ref}#${target.dir}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result

  let files: string[] = []
  try {
    files = await listSkillFiles(target)
  } catch (err) {
    const msg = (err as Error).message || ''
    const limited = /403|429|rate.?limit/i.test(msg)
    return {
      ok: false,
      repo: target.repo,
      ref: target.ref,
      skills: [],
      offline: false,
      message: limited
        ? 'GitHub 接口限流了（未登录每小时 60 次），等几分钟再试，或者先点「离线内置」用本机技能。'
        : `没能读到这个仓库：${msg}。检查一下仓库名/分支，或者网络是否通畅。`
    }
  }

  if (files.length === 0) {
    return {
      ok: false,
      repo: target.repo,
      ref: target.ref,
      skills: [],
      offline: false,
      message: `${target.repo} 里没有找到 SKILL.md。这个技能源要求仓库里有 xxx/SKILL.md 文件。`
    }
  }

  // 并发读文件，别把 API 打爆
  const skills: RemoteSkill[] = []
  const queue = [...files]
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    for (;;) {
      const p = queue.shift()
      if (!p) return
      const text = await readSkillFile(target, p)
      if (!text) continue
      const base = p.split('/').slice(-2, -1)[0] ?? 'skill'
      const parsed = parseSkillMd(text, base)
      if (!parsed.prompt) continue
      skills.push({
        key: skillKey(target.repo, target.ref, p),
        name: parsed.name,
        desc: parsed.desc,
        prompt: parsed.prompt,
        path: p,
        repo: target.repo,
        url: `https://github.com/${target.repo}/blob/${target.ref}/${p}`,
        installed: false
      })
    }
  })
  await Promise.all(workers)
  skills.sort((a, b) => a.name.localeCompare(b.name))

  const result: SkillScanResult = {
    ok: skills.length > 0,
    repo: target.repo,
    ref: target.ref,
    skills,
    offline: false,
    message: skills.length
      ? undefined
      : `找到了 ${files.length} 个 SKILL.md，但正文没取下来（可能被限流或网络中断），过一会儿再试。`
  }
  if (result.ok) cache.set(cacheKey, { at: Date.now(), result })
  return result
}
