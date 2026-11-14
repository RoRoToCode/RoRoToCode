/**
 * 自定义斜杠命令。
 *
 * 一个 .md 文件就是一条命令：frontmatter 写说明和提示，正文就是发给模型的话。
 * 这样「每次都要手打一遍的长提示」可以固化成 /fix-ci、/release-notes，
 * 而且能跟着仓库一起提交，团队共用。
 *
 * 位置（同名时项目覆盖用户）：
 *   ~/.roroto/commands/*.md
 *   <工作区>/.roroto/commands/*.md
 *
 * 例：.roroto/commands/fix-ci.md
 *   ---
 *   description: 拉最近一次失败的 CI 日志并修掉
 *   argument-hint: [run-id]
 *   ---
 *   去看 CI 最近的失败（run $1），定位原因并修复。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SlashCommand } from '../shared/types'
import { parseFrontmatter } from './mdmeta'
import { homeDir } from './paths'

const BUILTIN: SlashCommand[] = [
  {
    name: 'init',
    desc: '为这个项目生成 AGENTS.md：构建、测试、目录约定一次写清',
    hint: '',
    source: 'builtin',
    body: [
      '请先读懂这个项目，再在工作区根目录写一份 AGENTS.md（如果已存在就更新而不是覆盖掉有价值的内容）。',
      '用前面几步的工具去确认事实，不要凭猜测：读 package.json / pyproject.toml / Cargo.toml 这类清单，看目录结构，找已有的构建脚本和测试命令。',
      '',
      'AGENTS.md 里写这几块，用简短的项目符号，不要长篇大论：',
      '1. 项目是做什么的（两三句）',
      '2. 怎么安装依赖、怎么启动、怎么跑测试（必须是这个仓库里真能跑的命令）',
      '3. 目录结构与关键模块（只说主干，不列文件清单）',
      '4. 编码约定与禁区（格式化工具、命名习惯、不许改的生成文件等）',
      '5. 已知的坑（构建慢在哪、哪个测试不稳定）',
      '',
      '这个文件会被后续每个会话读进上下文，所以只写「不看代码就不知道」的信息，不要复述目录名。'
    ].join('\n')
  },
  {
    name: 'review',
    desc: '审查当前改动，按「问题 → 位置 → 改法」列出',
    hint: '[范围]',
    source: 'builtin',
    body:
      '请审查当前工作区的改动（$ARGUMENTS）。先用 git status / git diff 看清实际改了什么，再逐条检查：逻辑是否正确、边界条件、异常处理、并发与资源释放、有没有顺手带进无关改动。按「问题 → 位置（文件:行）→ 建议改法」输出；没发现问题就直接说没问题。'
  }
]

async function readDir(dir: string, source: 'project' | 'user'): Promise<SlashCommand[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: SlashCommand[] = []
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.md')) continue
    const file = path.join(dir, ent.name)
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    const { meta, body } = parseFrontmatter(text)
    if (!body) continue
    const name = (meta.name || ent.name.replace(/\.md$/i, '')).replace(/^\//, '').trim()
    if (!/^[\w-]+$/.test(name)) continue
    out.push({
      name,
      desc: (meta.description || meta.desc || body.split(/\r?\n/)[0].replace(/^#+\s*/, '')).slice(0, 90),
      hint: meta['argument-hint'] || meta.hint || undefined,
      source,
      body,
      path: file,
      model: meta.model || undefined,
      agent: meta.agent || undefined,
      tools: meta.tools
        ? meta.tools
            .split(/[,\s]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined
    })
  }
  return out
}

/** 列出全部命令：内置 + 用户 + 项目（同名后来者覆盖前者） */
export async function listCommands(workspace: string | null): Promise<SlashCommand[]> {
  const home = path.join(homeDir(), '.roroto', 'commands')
  const user = await readDir(home, 'user')
  const project = workspace ? await readDir(path.join(workspace, '.roroto', 'commands'), 'project') : []

  const seen = new Map<string, SlashCommand>()
  for (const c of [...BUILTIN, ...user, ...project]) seen.set(c.name.toLowerCase(), c)
  return [...seen.values()].sort((a, b) => {
    // 内置的排前面，其余按名字
    if (a.source === 'builtin' !== (b.source === 'builtin')) return a.source === 'builtin' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/** 把命令正文里的占位符替换成真实参数 */
export function expandCommandBody(body: string, args: string): string {
  const rest = args.trim()
  const parts = rest ? rest.split(/\s+/) : []
  const withArgs = body
    .replace(/\{\{\s*args\s*\}\}/gi, rest)
    .replace(/\$ARGUMENTS\b/g, rest)
    .replace(/\$(\d)/g, (_m, d: string) => parts[Number(d) - 1] ?? '')

  // 正文没写占位符但用户带了参数：接在末尾，别把用户输入吞掉
  const hasSlot = /\$ARGUMENTS\b|\{\{\s*args\s*\}\}|\$\d/.test(body)
  if (rest && !hasSlot) return `${withArgs}\n\n${rest}`
  return withArgs.replace(/[ \t]+$/gm, '').trim()
}

/** 解析用户输入里的一条命令。不是命令就返回 null */
export async function parseCommand(
  text: string,
  workspace: string | null
): Promise<{ command: SlashCommand; args: string; prompt: string } | null> {
  const m = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!m) return null
  const name = m[1].toLowerCase()
  // /learn 有独立流程（要调模型蒸馏），不当普通命令展开
  if (name === 'learn') return null
  const list = await listCommands(workspace)
  const command = list.find((c) => c.name.toLowerCase() === name)
  if (!command) return null
  const args = (m[2] ?? '').trim()
  return { command, args, prompt: expandCommandBody(command.body, args) }
}
