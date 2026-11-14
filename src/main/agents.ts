/**
 * 常驻 Agent 档案。
 *
 * 为什么要有这一层：子 agent（task 工具）是「一次性」的，跑完就蒸发，
 * 连个名字都没留下。档案把三件事固定下来 —— 叫什么叫、负责什么、能碰什么 ——
 * 这样定时任务才有对象可唤醒，记忆也才有地方沉淀。
 *
 * 存 userData/agents.json，不写工作区：档案是「你这个人怎么用这台机器」的配置，
 * 不属于任何一个代码库，也不该被 git 提交。
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import type { AgentProfile } from '../shared/types'
import { DEFAULT_AGENT_ID } from '../shared/roster'
import { toolSpecs } from './tools/spec'
import { parseFrontmatter, splitList } from './mdmeta'
import { homeDir } from './paths'

const FILE = 'agents.json'
let cache: AgentProfile[] | null = null
/** 用户明确删掉的内置档案 id：补齐内置档案时要跳过它们，否则删了下次启动又冒出来 */
let hidden = new Set<string>()
/**
 * 项目级档案要跟着工作区走：同一个程序开不同仓库，看到的是各自 .roroto/agents/ 里的角色。
 * 工作区变了就把缓存作废，下一轮重新扫。
 */
let scanWorkspace: string | null = null

export function setAgentsWorkspace(workspace: string | null): void {
  if (workspace === scanWorkspace) return
  scanWorkspace = workspace
  cache = null
}

export function agentsPath(): string {
  return path.join(app.getPath('userData'), FILE)
}

/** 只读工具：巡检和审查都不该动代码，把它们想要「顺手改一下」的路先堵上 */
const READ_ONLY = ['read_file', 'list_dir', 'glob', 'grep', 'run_shell', 'update_todos', 'remember']

/**
 * 内置档案。
 *
 * 巡检和审查是「另一个角色」：各管一段，工具边界钉死，记忆各攒各的。
 * 主控不是角色，是「你自己在系统里的代理」——它必须和普通会话完全一致，
 * 这样才能接住别人交过来的活；多给了人格反而会偏离。
 * 再加就变成模板堆砌，用户反而不知道从哪开始。
 */
const BUILTIN: Array<Omit<AgentProfile, 'createdAt' | 'updatedAt'>> = [
  {
    id: 'agent_patrol',
    name: '巡检',
    role: [
      '你负责这个项目的日常巡检：只做检查，不擅自改代码。',
      '每次被唤醒时按这个顺序来：',
      '1. 先看最近的改动：run_shell 跑 git status 和 git diff --stat；不是 git 仓库就按文件修改时间找最近动过的文件。',
      '2. 检查有没有没做完的事：TODO/FIXME、上次没跑通的测试、明显对不上的配置。',
      '3. 只在需要确认时读文件，不要全量扫描。',
      '',
      '结论按「发现 → 位置 → 影响 → 建议」列出，最多 5 条，按严重程度排序；',
      '确实一切正常就只用一句话说明，不要为了凑字数编问题。',
      '除非明确要求，不要修改任何文件。'
    ].join('\n'),
    tools: READ_ONLY,
    ownMemory: true,
    builtin: true
  },
  {
    id: 'agent_review',
    name: '审查',
    role: [
      '你负责审查改动，判断「这段代码能不能合进去」。',
      '重点看：逻辑是否正确、边界条件、异常处理、并发与资源释放、命名与可读性、有没有顺手带进无关改动。',
      '需要证据时读文件、跑测试；不要凭印象评价。',
      '',
      '输出格式：先给一句结论（可以合 / 需要改 / 必须改），再逐条列问题，每条写清「问题 → 位置（文件:行）→ 建议改法」。',
      '没发现问题就直接说没问题，不要为了显得认真而挑刺。'
    ].join('\n'),
    tools: [...READ_ONLY, 'edit_file', 'patch'],
    ownMemory: true,
    builtin: true
  },
  {
    id: DEFAULT_AGENT_ID,
    name: '主控',
    // 刻意留空：主控不注入岗位说明，行为和普通会话完全一致。
    // 给它一段「你是兜底执行者」反而会把它变成一个角色，交过来的活会被它先评判一遍
    role: '',
    // 不填白名单 = 全部工具，将来新增的工具、MCP 都自动能用上
    // 关掉独立记忆：否则会从 <工作区>.md 切到 <工作区>-agent_default.md，把攒的常识丢掉
    ownMemory: false,
    builtin: true
  }
]

/** 合法工具名：内置工具 + 运行时才有的 MCP 工具（mcp__ 前缀） */
const KNOWN_TOOLS = new Set(toolSpecs.map((t) => t.name))

/**
 * 工具清单，给界面勾选白名单用。
 * description 只取首行：完整描述里有参数细节，放在勾选框里没人读，还会把行撑开。
 */
export function agentTools(): Array<{ name: string; desc: string }> {
  return toolSpecs.map((t) => ({
    name: t.name,
    desc: (t.description.split('\n')[0] ?? '').slice(0, 90)
  }))
}

function cleanTools(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input) {
    const name = String(raw ?? '').trim()
    if (!name) continue
    // 认不出的名字直接丢掉：留着会让白名单变成空集合，agent 一个工具都用不了
    if (!KNOWN_TOOLS.has(name) && !name.startsWith('mcp__')) continue
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

function normalize(input: Partial<AgentProfile>): AgentProfile {
  const now = Date.now()
  const name = String(input.name ?? '').trim().slice(0, 40)
  if (!name) throw new Error('agent 需要名字')
  const id = String(input.id ?? '').trim() || `agent_${randomBytes(4).toString('hex')}`
  const tools = cleanTools(input.tools)
  return {
    id,
    name,
    role: String(input.role ?? '').trim().slice(0, 4000),
    // 空数组 = 不限制。存成 undefined 更省事，判断时统一按「没有就是全部」处理
    tools: tools && tools.length ? tools : undefined,
    ownMemory: input.ownMemory !== false,
    modelId: input.modelId ? String(input.modelId) : null,
    workspace: input.workspace ? String(input.workspace) : null,
    builtin: input.builtin === true,
    source: input.source ?? (input.builtin === true ? 'builtin' : 'stored'),
    ...(input.filePath ? { filePath: String(input.filePath) } : {}),
    createdAt: Number(input.createdAt) || now,
    updatedAt: now
  }
}

/** 磁盘上真正存着的档案（不含 .md 文件定义的） */
async function loadStored(): Promise<AgentProfile[]> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(agentsPath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const stored = splitStore(parsed)
    hidden = new Set(stored.deleted)
    cache = stored.list
      .map((item) => {
        try {
          return normalize(item as Partial<AgentProfile>)
        } catch {
          return null
        }
      })
      .filter((a): a is AgentProfile => a !== null)
  } catch {
    // 首次运行 / 文件损坏：落一份内置档案，而不是给个空列表让用户自己从零编
    const now = Date.now()
    cache = BUILTIN.map((a) => ({ ...a, createdAt: now, updatedAt: now }))
    hidden = new Set()
    await persist()
    // persist() 里有 await：这段时间别的地方可能调 setAgentsWorkspace() 把 cache 置空，
    // 于是这里会返回 null，调用方 .map 时直接崩。宁可返回空数组，也别让启动期的 IPC 炸掉。
    return cache ?? []
  }
  // 老版本没有内置档案：补上，但不覆盖用户自己改过的同名档案，
  // 也不补用户明确删掉的那些（deleted 里有记录）
  const missing = BUILTIN.filter((b) => !hidden.has(b.id) && !(cache ?? []).some((a) => a.id === b.id))
  if (missing.length) {
    const now = Date.now()
    cache = [...(cache ?? []), ...missing.map((b) => ({ ...b, createdAt: now, updatedAt: now }))]
    await persist()
  }
  return cache ?? []
}

/**
 * 从 .md 文件定义的档案。
 *
 * 和界面里手建的档案用途不同：这些跟着仓库走（项目里的 .roroto/agents/ 可以提交），
 * 团队里每个人打开同一个仓库就得到同一批角色，不用各自在设置里点一遍。
 *
 *   ---
 *   name: 迁移手
 *   description: 负责数据库迁移脚本
 *   tools: read_file, list_dir, grep, run_shell, edit_file
 *   model: qwen2.5-coder-14b
 *   ---
 *   你负责……（正文即岗位说明）
 */
export async function scanFileAgents(workspace: string | null = scanWorkspace): Promise<AgentProfile[]> {
  const dirs: Array<{ dir: string; scope: 'user' | 'project' }> = [
    { dir: path.join(homeDir(), '.roroto', 'agents'), scope: 'user' }
  ]
  if (workspace) {
    dirs.push({ dir: path.join(workspace, '.roroto', 'agents'), scope: 'project' })
  }

  const byName = new Map<string, AgentProfile>()
  for (const { dir } of dirs) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.md')) continue
      const file = path.join(dir, ent.name)
      let text: string
      try {
        text = await fs.readFile(file, 'utf8')
      } catch {
        continue
      }
      const { meta, body } = parseFrontmatter(text)
      const name = (meta.name || ent.name.replace(/\.md$/i, '')).trim().slice(0, 40)
      if (!name) continue
      const tools = cleanTools(splitList(meta.tools))
      // 项目目录后扫，同名时覆盖用户目录那份
      byName.set(name.toLowerCase(), {
        id: `file_${createHash('sha1').update(file).digest('hex').slice(0, 10)}`,
        name,
        role: body.slice(0, 4000),
        tools: tools && tools.length ? tools : undefined,
        ownMemory: meta['own-memory'] !== 'false' && meta.ownmemory !== 'false',
        modelId: meta.model || null,
        workspace,
        builtin: true,
        source: 'file',
        filePath: file,
        createdAt: 0,
        updatedAt: 0
      })
    }
  }
  return [...byName.values()]
}

/** 全部档案：.md 定义的 + 磁盘存的（同 id 以磁盘为准，等于「界面里改过」） */
export async function listAgents(): Promise<AgentProfile[]> {
  const stored = (await loadStored()) ?? []
  const files = await scanFileAgents()
  const known = new Set(stored.map((a) => a.id))
  return [...files.filter((f) => !known.has(f.id)), ...stored]
}

/**
 * 磁盘格式。老版本直接存一个数组；为了能记住「用户删了哪个内置档案」，
 * 现在存成 { list, deleted }。读的时候两种都认，写回去一律用新格式。
 */
function splitStore(parsed: unknown): { list: unknown[]; deleted: string[] } {
  if (Array.isArray(parsed)) return { list: parsed, deleted: [] }
  const obj = (parsed ?? {}) as { list?: unknown; deleted?: unknown }
  return {
    list: Array.isArray(obj.list) ? obj.list : [],
    deleted: Array.isArray(obj.deleted) ? obj.deleted.map(String) : []
  }
}

async function persist(): Promise<void> {
  await fs.mkdir(path.dirname(agentsPath()), { recursive: true })
  const body = { list: cache ?? [], deleted: [...hidden] }
  await fs.writeFile(agentsPath(), JSON.stringify(body, null, 2), 'utf8')
}

export async function getAgent(id: string | null | undefined): Promise<AgentProfile | null> {
  if (!id) return null
  const list = await listAgents()
  return list.find((a) => a.id === id) ?? null
}

export async function upsertAgent(input: Partial<AgentProfile>): Promise<AgentProfile> {
  // 只动磁盘上那份：.md 档案是扫出来的，写进 agents.json 会变成两份
  const list = await loadStored()
  const next = normalize({ ...input, source: input.source === 'file' ? 'stored' : input.source })
  const idx = list.findIndex((a) => a.id === next.id)
  const merged: AgentProfile = idx >= 0 ? { ...list[idx], ...next, createdAt: list[idx].createdAt } : next
  const out = idx >= 0 ? list.map((a) => (a.id === merged.id ? merged : a)) : [...list, merged]
  cache = out
  // 手动保存等于「我要它」：即使之前删过同名内置档案，也不再拦着
  hidden.delete(merged.id)
  await persist()
  return merged
}

export async function removeAgent(id: string): Promise<{ removed: boolean; reason?: string }> {
  const list = await loadStored()
  const target = list.find((a) => a.id === id)
  if (!target) {
    // 可能是 .md 定义的：不能悄悄吞掉，要告诉用户去删文件
    const fileAgent = (await scanFileAgents()).find((a) => a.id === id)
    if (fileAgent) {
      return {
        removed: false,
        reason: `「${fileAgent.name}」来自 ${fileAgent.filePath}，删掉那个文件即可（或在界面里改它，会变成独立档案）`
      }
    }
    return { removed: false, reason: '没有这个 agent' }
  }
  // 内置档案允许删：用户说不要就是不要，记一笔 deleted，下次启动不再补回来
  if (target.builtin) hidden.add(id)
  cache = list.filter((a) => a.id !== id)
  await persist()
  return { removed: true }
}

/** 只给自检用：丢掉内存缓存，逼下一次 listAgents 重新读盘（否则测不到「重启后」的行为） */
export function forgetAgentCache(): void {
  cache = null
}

/** 测试与「恢复默认」用 */
export async function resetAgents(): Promise<AgentProfile[]> {
  const now = Date.now()
  cache = BUILTIN.map((a) => ({ ...a, createdAt: now, updatedAt: now }))
  hidden = new Set()
  await persist()
  return cache
}
