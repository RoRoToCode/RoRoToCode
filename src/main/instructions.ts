/**
 * 项目级规则：AGENTS.md / CLAUDE.md 的只读发现与注入。
 *
 * 与 memory.ts 的分工要分清楚，这是最容易踩的坑：
 * - memory.ts 的 MEMORY.md 是「程序自动维护」的记忆，故意不放工作区根目录，
 *   因为那是用户代码库，塞自动维护的文件会污染项目、容易被误 git 提交。
 * - 这里的 AGENTS.md / CLAUDE.md 恰恰相反：是「人写、应该随仓库提交、团队共享」
 *   的项目约定。所以它是只读的（程序绝不写它），另建一套发现机制，不复用 memory。
 *
 * 发现规则（对标 OpenCode / WorkBuddy 的通用约定）：
 * 从工作区根向上逐层找，最近的文件优先（子目录的约定覆盖父目录），
 * 同级优先 AGENTS.md、其次 CLAUDE.md，只取第一个命中的目录层（不做跨层拼接）。
 * 单文件有字符上限，避免把过大的项目文档整个塞进本地小模型的上下文。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 注入系统提示的规则正文最大字符数，超了从尾部截断 */
export const INSTRUCTIONS_LIMIT = 6000

/** 单次向上查找最多回溯的目录层数，防止在盘符/网络根附近瞎找 */
const MAX_UP_LEVELS = 16

const CANDIDATE_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const

export interface InstructionsResult {
  /** 命中的规则文件绝对路径（多份时取最近的一份）；没有则为 null */
  path: string | null
  /** 规则正文（多份已合并，按上限截断）；没有则为 '' */
  text: string
  /** 正文是否被截断过 */
  truncated: boolean
  /** 命中的文件名（AGENTS.md / CLAUDE.md），用于界面显示来源 */
  name: string | null
}

/** 单份命中的规则文件（供 UI 展示完整来源列表） */
export interface InstructionsHit {
  path: string
  name: string
  text: string
}

/** 判断一个文件名是否是支持的项目规则文件（供 UI / 工具侧复用） */
export function isInstructionFile(name: string): boolean {
  return (CANDIDATE_NAMES as readonly string[]).includes(name)
}

/**
 * 从工作区根向上逐层找 AGENTS.md / CLAUDE.md，返回**所有**命中的文件，
 * 按「最近层在前」排序（子目录/工作区根的约定覆盖父目录）。
 * 同级优先 AGENTS.md、其次 CLAUDE.md（同一层只取一份，避免重复注入）。
 * 纯函数式的读取，不会写任何文件；任何 IO 失败都静默降级。
 */
export async function findAllInstructions(workspace: string | null): Promise<InstructionsHit[]> {
  if (!workspace) return []
  const hits: InstructionsHit[] = []
  let dir = path.resolve(workspace)
  for (let i = 0; i < MAX_UP_LEVELS; i++) {
    for (const name of CANDIDATE_NAMES) {
      const candidate = path.join(dir, name)
      try {
        const stat = await fs.stat(candidate)
        if (!stat.isFile()) continue
        const raw = await fs.readFile(candidate, 'utf8')
        const text = raw.replace(/\r\n/g, '\n').trim()
        if (!text) continue
        hits.push({ path: candidate, name, text })
        break // 同一层只取优先命中的一份（AGENTS.md 优先于 CLAUDE.md）
      } catch {
        // 文件不存在 / 无权限，继续找下一个候选名
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return hits
}

/**
 * 把多份规则合并成一段注入文本，带上各自来源标注，总长受 INSTRUCTIONS_LIMIT 约束。
 * 多份时从最近的开始拼，越靠近工作区的越靠前；超长从尾部（最远的一层）截断。
 */
export function mergeInstructions(hits: InstructionsHit[]): InstructionsResult {
  if (!hits.length) return { path: null, text: '', truncated: false, name: null }
  const blocks: string[] = []
  let used = 0
  let truncated = false
  const headerFor = (hit: InstructionsHit) => (hits.length > 1 ? `【${hit.name} · ${hit.path}】\n` : '')

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]
    const header = headerFor(hit)
    const body = header + hit.text
    if (used + body.length > INSTRUCTIONS_LIMIT) {
      // 塞不下：当前这份截断到剩余空间（若它是第一份且超长，截到上限），更远的整体丢弃
      const room = INSTRUCTIONS_LIMIT - used
      if (room > 0) {
        blocks.push(body.slice(0, room))
        used = INSTRUCTIONS_LIMIT
      }
      truncated = true
      break
    }
    blocks.push(body)
    used += body.length + 2 // 块间空行
  }
  const text = blocks.join('\n\n')
  return {
    path: hits[0].path,
    text,
    truncated,
    name: hits[0].name
  }
}

/**
 * 从工作区根向上逐层找 AGENTS.md / CLAUDE.md，合并所有命中层后返回。
 * 兼容旧签名：返回合并后的单一 InstructionsResult（path/text 为合并结果）。
 */
export async function findInstructions(workspace: string | null): Promise<InstructionsResult> {
  const hits = await findAllInstructions(workspace)
  return mergeInstructions(hits)
}

/**
 * 生成一段用于塞进系统提示的规则段。
 * 没有规则时返回 ''，调用方直接跳过，不占 token。
 */
export function instructionsBlock(result: InstructionsResult): string {
  if (!result.path) return ''
  const lines = [
    '【项目规则】以下是当前工作区里由作者维护的项目约定，处理任务时必须遵守，不要质疑或重复询问（已按「越靠近工作区越优先」合并，多份规则均已标注来源）：',
    result.text
  ]
  if (result.truncated) {
    lines.push('（规则过长，已按上限截断；较远层级的完整内容可读 ' + result.path + ' 所在目录）')
  }
  return lines.join('\n')
}

/** 生成 AGENTS.md 的默认模板。只输出文本，由调用方决定写到哪个目录。 */
export function agentsTemplate(workspace: string): string {
  const name = path.basename(workspace) || '本项目'
  return [
    '# 项目规则',
    '',
    '这是本项目的协作约定，所有 AI 助手（RoRoTo Code、OpenCode、WorkBuddy 等）都应遵守。',
    '请用最精炼的语言写，这里的内容每次对话都会注入到模型上下文里。',
    '',
    '## 项目简介',
    '',
    `${name} 是……（一句话说明它是做什么的）`,
    '',
    '## 构建与测试命令',
    '',
    '- 安装依赖：`npm install`',
    '- 构建：`npm run build`',
    '- 测试：`npm test`',
    '- 类型检查：`npm run typecheck`',
    '',
    '## 目录约定',
    '',
    '- （例如：源码在 src/，产物在 dist/，脚本在 tools/）',
    '',
    '## 代码风格与约束',
    '',
    '- （例如：用 TypeScript、提交前必须过 typecheck、不要引入新依赖）',
    '',
    '## 踩过的坑',
    '',
    '- （例如：xxx 模块的鉴权逻辑在 yyy 文件，改动前先读它）',
    ''
  ].join('\n')
}

/**
 * 在工作区根目录生成一份 AGENTS.md。
 * 已存在则不覆盖，返回 { created: false }，避免覆盖用户已有的约定。
 */
export async function initAgents(workspace: string | null): Promise<{
  created: boolean
  path: string
}> {
  const ws = workspace ? path.resolve(workspace) : ''
  const target = ws ? path.join(ws, 'AGENTS.md') : ''
  if (!target) return { created: false, path: '' }
  try {
    await fs.access(target)
    return { created: false, path: target }
  } catch {
    // 不存在，继续创建
  }
  try {
    await fs.writeFile(target, agentsTemplate(ws), 'utf8')
    return { created: true, path: target }
  } catch {
    // 写失败（无权限等）时如实返回，由 UI 提示
    return { created: false, path: target }
  }
}
