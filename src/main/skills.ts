import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { RemoteSkill, Skill } from '../shared/types'
import { parseSkillMd } from './skillhub'

const FILE = 'skills.json'
/**
 * 开关单独存一份：内置技能和本机技能（扫 `~/.workbuddy/skills`）都不能写回源，
 * 想记住「这个技能打开了自动调用」只能另存一张 id → 布尔 的表。
 * 顺带的好处是删掉技能再装回来，开关状态还在。
 */
const TOGGLES = 'skill-toggles.json'

/**
 * 本机技能目录：WorkBuddy / 其它客户端把已安装技能统一放在 `~/.workbuddy/skills/`，
 * 每个技能一个子目录、里面一个 SKILL.md（YAML frontmatter + 正文指令）。
 * 主程序直接扫这个目录，就能把平台上架的 vramfit / pdf-workshop 等技能一并列出来用，
 * 不用再靠 GitHub 拉一份重复副本。
 */
function localSkillsDir(): string {
  return path.join(app.getPath('home'), '.workbuddy', 'skills')
}

/**
 * 内置技能：都是「直接能发给模型的具体指令」，不是空泛的标签。
 * 点「调用」后原文填进输入框，用户可以再补一句自己的需求。
 */
const BUILTIN: Array<Omit<Skill, 'createdAt'>> = [
  {
    id: 'skill_review',
    name: '代码审查',
    desc: '检查改动里的正确性、边界与异常处理问题',
    builtin: true,
    prompt:
      '请审查当前工作区最近改动的代码，重点看：逻辑是否正确、边界条件、异常处理、并发/资源释放、命名与可读性。按「问题 → 位置 → 建议改法」逐条列出，不要泛泛而谈。'
  },
  {
    id: 'skill_test',
    name: '补单元测试',
    desc: '为指定模块补充能跑起来的测试',
    builtin: true,
    prompt:
      '请先读懂目标模块的实际行为，再为它补充单元测试，覆盖正常路径、边界值和异常分支。测试要能在本机直接跑通，写完把运行结果告诉我。'
  },
  {
    id: 'skill_bug',
    name: '定位并修复 Bug',
    desc: '从报错信息一路查到根因，给出最小修复',
    builtin: true,
    prompt:
      '我遇到一个 Bug，现象是：（补充现象或报错）。请先复现并定位根因，不要凭猜测改代码；确认原因后再做最小改动修复，最后说明为什么会出问题。'
  },
  {
    id: 'skill_refactor',
    name: '重构去重',
    desc: '合并重复逻辑，保持行为不变',
    builtin: true,
    prompt:
      '请找出当前模块里重复或高度相似的逻辑，抽成共用函数并统一调用。要求行为完全不变，改完把改动点和风险说清楚。'
  },
  {
    id: 'skill_explain',
    name: '读懂这个项目',
    desc: '梳理目录结构、启动流程与关键模块',
    builtin: true,
    prompt:
      '请先读项目结构和入口文件，然后用简短的方式告诉我：这个项目是做什么的、怎么启动、有哪些关键模块、数据怎么流动。不要罗列文件清单，讲清主线关系。'
  },
  {
    id: 'skill_perf',
    name: '性能优化',
    desc: '找出真正的瓶颈再优化，不做无用改动',
    builtin: true,
    prompt:
      '请分析当前相关代码的性能瓶颈，先说明依据（复杂度、重复计算、IO 次数等），再给出优化方案并实施。不要为了优化牺牲可读性，也不要引入没有必要的缓存。'
  },
  {
    id: 'skill_doc',
    name: '补注释与文档',
    desc: '给关键逻辑写清「为什么」而不是「做了什么」',
    builtin: true,
    prompt:
      '请为当前模块补充注释和文档：只解释为什么这样做、有哪些坑和约束，不要写「这里是赋值」这类废话。对外接口补上参数与返回值说明。'
  },
  {
    id: 'skill_commit',
    name: '写提交信息',
    desc: '按改动内容生成 commit message',
    builtin: true,
    prompt:
      '请先看一遍当前的代码改动（git diff），然后生成一条提交信息：标题一行说清做了什么，正文分点说明原因和影响范围。用中文。'
  },
  {
    id: 'skill_stack',
    name: '搭建新功能骨架',
    desc: '从需求出发建好目录、接口与调用链',
    builtin: true,
    prompt:
      '我要新增一个功能：（补充功能描述）。请先给出简要方案（涉及哪些文件、接口怎么设计），再动手实现骨架，让它能跑通最小闭环。'
  },
  {
    id: 'skill_shell',
    name: '环境排障',
    desc: '查清依赖、端口、路径这类环境问题',
    builtin: true,
    prompt:
      '我的环境出了问题，现象是：（补充现象）。请按「先确认事实再下结论」的顺序排查：检查依赖版本、端口占用、路径与权限、环境变量，把每条命令的输出都看一下，最后给出结论和修复步骤。'
  }
]

function filePath(): string {
  return path.join(app.getPath('userData'), FILE)
}

function togglesPath(): string {
  return path.join(app.getPath('userData'), TOGGLES)
}

/** 开关表：只认布尔值，坏一条就丢一条，不能让整张表失效把技能全关掉 */
async function readToggles(): Promise<Record<string, boolean>> {
  try {
    const raw = await fs.readFile(togglesPath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v
    }
    return out
  } catch {
    // 文件不存在（从没开过开关）就当作全关
    return {}
  }
}

async function writeToggles(map: Record<string, boolean>): Promise<void> {
  await fs.mkdir(path.dirname(togglesPath()), { recursive: true })
  await fs.writeFile(togglesPath(), JSON.stringify(map, null, 2), 'utf8')
}

async function readCustom(): Promise<Skill[]> {
  try {
    const raw = await fs.readFile(filePath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x): x is Skill => Boolean(x) && typeof (x as Skill).id === 'string')
      .map((s) => ({
        id: s.id,
        name: String(s.name ?? '未命名技能'),
        desc: String(s.desc ?? ''),
        prompt: String(s.prompt ?? ''),
        source: s.source ? String(s.source) : undefined,
        sourcePath: s.sourcePath ? String(s.sourcePath) : undefined,
        url: s.url ? String(s.url) : undefined,
        createdAt: Number(s.createdAt ?? Date.now())
      }))
  } catch {
    // 文件不存在或坏了都按「没有自定义技能」处理，不能因此打不开面板
    return []
  }
}

async function writeCustom(list: Skill[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath()), { recursive: true })
  await fs.writeFile(filePath(), JSON.stringify(list, null, 2), 'utf8')
}

/**
 * 扫 `~/.workbuddy/skills/` 下每个子目录的 SKILL.md，转成可用的技能。
 * 只读：这些技能归 WorkBuddy 管，主程序不写回去、不提供删除（标记 builtin 防误删）。
 * 目录里可能还有 pdf-workshop 这种「一个技能拆成几十个 action」的结构，一律按 SKILL.md 逐个列出，
 * 与平台保持一致。
 */
async function scanLocalSkills(): Promise<Skill[]> {
  const dir = localSkillsDir()
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    // 目录不存在（没装过平台技能）就当作没有
    return []
  }

  const out: Skill[] = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    if (ent.name.startsWith('.')) continue
    const skillMd = path.join(dir, ent.name, 'SKILL.md')
    let text: string
    try {
      text = await fs.readFile(skillMd, 'utf8')
    } catch {
      continue
    }
    const parsed = parseSkillMd(text, ent.name)
    if (!parsed.prompt) continue
    const skillDir = path.join(dir, ent.name)
    // 平台技能的正文用 <skill_dir> 占位符引用脚本，这里替换成真实绝对路径，
    // 否则模型拿到指令也不知道脚本在哪、跑不起来。
    // Windows 路径里的反斜杠原样保留（传给 node 当命令行参数用），只把占位符换成路径。
    const prompt = parsed.prompt.split('<skill_dir>').join(skillDir)
    out.push({
      // id 由目录名算出来，稳定且不会和 skills.json 里的自定义/内置技能撞名
      id: `local_${createHash('sha1').update(ent.name).digest('hex').slice(0, 10)}`,
      name: parsed.name,
      desc: parsed.desc,
      prompt,
      builtin: true,
      source: 'workbuddy',
      sourcePath: path.join('.workbuddy', 'skills', ent.name, 'SKILL.md'),
      localPath: path.join(dir, ent.name),
      createdAt: 0
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

export async function listSkills(): Promise<Skill[]> {
  const custom = await readCustom()
  const builtin: Skill[] = BUILTIN.map((s, i) => ({ ...s, createdAt: i }))
  const local = await scanLocalSkills()
  const toggles = await readToggles()
  /**
   * 默认全关：打开开关就意味着这个技能的说明会进系统提示、模型可能自己调用它，
   * 那是要花上下文的事，不能让用户装完一批技能就悄悄付了这笔账。
   */
  const mark = (s: Skill): Skill => ({ ...s, enabled: toggles[s.id] === true })
  return [...builtin, ...local, ...custom].map(mark)
}

/** 打开开关的技能：只有这些会进系统提示的「可调用技能」，也只有它们能被 use_skill 取到 */
export async function enabledSkills(): Promise<Skill[]> {
  return (await listSkills()).filter((s) => s.enabled)
}

/** 切换一个技能的自动调用开关 */
export async function setSkillEnabled(
  id: string,
  enabled: boolean
): Promise<{ ok: boolean; message: string; skills: Skill[] }> {
  const all = await listSkills()
  const target = all.find((s) => s.id === id)
  if (!target) {
    return { ok: false, message: '技能不存在，可能已被删除', skills: all }
  }
  const toggles = await readToggles()
  // 关掉就把键删掉，表里不堆一堆 false；默认值本来就是关
  if (enabled) toggles[id] = true
  else delete toggles[id]
  await writeToggles(toggles)
  return {
    ok: true,
    message: enabled ? `已开启「${target.name}」的自动调用` : `已关闭「${target.name}」的自动调用`,
    skills: await listSkills()
  }
}

/**
 * use_skill 的落地：按名字（或 id）取一份技能的完整说明。
 *
 * 只认打开了开关的技能 —— 开关就是「允许模型自己拿这份说明」的授权，
 * 关着的技能即便名字被模型猜到也不给，否则那个开关等于没有。
 */
export async function readSkillBody(want: string): Promise<string> {
  const key = String(want ?? '').trim()
  const all = await listSkills()
  const on = all.filter((s) => s.enabled)
  if (!key) {
    return on.length
      ? `要给技能名。已开启自动调用的有：${on.map((s) => s.name).join('、')}`
      : '现在没有任何开启自动调用的技能。让用户到技能面板打开开关，或者直接把需求说清楚由你自己做。'
  }
  const lower = key.toLowerCase()
  const hit =
    on.find((s) => s.id === key) ??
    on.find((s) => s.name === key) ??
    on.find((s) => s.name.toLowerCase() === lower) ??
    on.find((s) => s.id.toLowerCase() === lower)
  if (!hit) {
    return on.length
      ? `没有名为「${key}」的已开启技能。已开启的有：${on.map((s) => s.name).join('、')}。别硬套，没有合适的就按常规做法自己做。`
      : `「${key}」这个技能的自动调用开关是关着的。没有已开启的技能可用，按常规做法自己做，或提醒用户去技能面板打开它。`
  }
  return [
    `【技能：${hit.name}】下面是你需要的完整做法，照它执行；它没写到的细节按实际情况判断：`,
    hit.prompt,
    '（以上来自技能库，不是用户消息，不要复述这段。）'
  ].join('\n\n')
}

export async function saveSkill(input: {
  id?: string
  name: string
  desc?: string
  prompt: string
}): Promise<{ ok: boolean; message: string; skills: Skill[] }> {
  const name = input.name.trim()
  const prompt = input.prompt.trim()
  if (!name) return { ok: false, message: '技能名称不能为空', skills: await listSkills() }
  if (!prompt) return { ok: false, message: '技能指令不能为空', skills: await listSkills() }

  const custom = await readCustom()

  if (input.id) {
    if (BUILTIN.some((s) => s.id === input.id)) {
      return { ok: false, message: '内置技能不支持修改', skills: await listSkills() }
    }
    const idx = custom.findIndex((s) => s.id === input.id)
    if (idx < 0) return { ok: false, message: '技能不存在，可能已被删除', skills: await listSkills() }
    custom[idx] = { ...custom[idx], name, desc: (input.desc ?? '').trim(), prompt }
    await writeCustom(custom)
    return { ok: true, message: `已更新「${name}」`, skills: await listSkills() }
  }

  const skill: Skill = {
    id: `skill_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    desc: (input.desc ?? '').trim(),
    prompt,
    createdAt: Date.now()
  }
  custom.push(skill)
  await writeCustom(custom)
  return { ok: true, message: `已添加「${name}」`, skills: await listSkills() }
}

export async function removeSkill(id: string): Promise<{ ok: boolean; message: string; skills: Skill[] }> {
  if (BUILTIN.some((s) => s.id === id)) {
    return { ok: false, message: '内置技能不能删除', skills: await listSkills() }
  }
  const custom = await readCustom()
  const next = custom.filter((s) => s.id !== id)
  if (next.length === custom.length) {
    return { ok: false, message: '技能不存在，可能已被删除', skills: await listSkills() }
  }
  await writeCustom(next)
  return { ok: true, message: '已删除', skills: await listSkills() }
}

/** 从 GitHub 装技能：id 由「仓库 + 文件路径」算出来，重复安装就是覆盖更新，不会长出两份 */
export async function installRemoteSkills(
  items: RemoteSkill[]
): Promise<{ ok: boolean; message: string; skills: Skill[] }> {
  const list = (items ?? []).filter((x) => x && x.name && x.prompt)
  if (list.length === 0) {
    return { ok: false, message: '没有可安装的技能', skills: await listSkills() }
  }

  const custom = await readCustom()
  let added = 0
  let updated = 0

  for (const item of list) {
    const ident = item.path ? `${item.repo}:${item.path}` : item.key
    const id = `hub_${createHash('sha1').update(ident).digest('hex').slice(0, 10)}`
    const idx = custom.findIndex((s) => s.id === id)
    const next: Skill = {
      id,
      name: item.name.trim().slice(0, 40) || '未命名技能',
      desc: (item.desc ?? '').trim().slice(0, 160),
      prompt: item.prompt,
      source: item.repo,
      sourcePath: item.path || undefined,
      url: item.url || undefined,
      createdAt: idx >= 0 ? custom[idx].createdAt : Date.now()
    }
    if (idx >= 0) {
      custom[idx] = next
      updated += 1
    } else {
      custom.push(next)
      added += 1
    }
  }

  await writeCustom(custom)
  const parts: string[] = []
  if (added) parts.push(`新装 ${added} 个`)
  if (updated) parts.push(`更新 ${updated} 个`)
  return { ok: true, message: `技能已${parts.join('、')}`, skills: await listSkills() }
}
