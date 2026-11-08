/**
 * 项目级权限规则：从工作区里的 roroto.json 读 permissions 数组。
 *
 * 与 instructions.ts（AGENTS.md）同属「项目级配置」这一层，但职责不同：
 * - instructions 是给模型的自然语言约定（随仓库提交、团队共享）；
 * - permissions 是给执行引擎的机器可读规则（也随仓库提交），
 *   用来在「内置风险判定」之上做加严 / 明确放行。
 *
 * 规则语义（见 risk.ts 的 PermissionRule）：
 * - deny：直接拒绝，不弹确认框，任何「之后全允许」都拦不住；
 * - allow：只对原本无风险的操作有意义，写/删/越界/网络等高危仍走内置判定。
 * - 不可逆命令的 HARD_BLOCK 硬拒永远无法被 allow 覆盖。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { PermissionRule, PermRuleWithSource } from '../shared/types'

const FILE = 'roroto.json'

/** 单次向上查找最多回溯的目录层数，防止在盘符/网络根附近瞎找 */
const MAX_UP_LEVELS = 16

/** 多层合并后的完整结果 */
export interface ProjectPermissionResult {
  /** 合并后的规则列表：外层在前、内层在后（后面的覆盖前面，即内层优先） */
  rules: PermissionRule[]
  /** 带来源标注的规则（与 rules 顺序一致），供 UI 展示 */
  detailed: PermRuleWithSource[]
  /** 命中的所有 roroto.json 文件（最内层在前） */
  files: string[]
}

/** 项目级规则文件在内存里的缓存，带 mtime 失效：文件变了自动重读，不用重启 */
let cache: { workspace: string; result: ProjectPermissionResult; mtimes: Map<string, number> } | null = null

/** 读单个 roroto.json 的 permissions，过滤出合法规则 */
async function readRules(file: string): Promise<PermissionRule[]> {
  const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { permissions?: unknown }
  if (!Array.isArray(parsed?.permissions)) return []
  return (parsed.permissions as unknown[]).filter(
    (r): r is PermissionRule =>
      !!r && typeof r === 'object' &&
      typeof (r as PermissionRule).action === 'string' && (r as PermissionRule).action.trim() !== '' &&
      typeof (r as PermissionRule).resource === 'string' && (r as PermissionRule).resource.trim() !== '' &&
      ((r as PermissionRule).effect === 'allow' || (r as PermissionRule).effect === 'deny')
  ) as PermissionRule[]
}

/**
 * 从工作区根向上逐层收集 roroto.json，把每层的 permissions 合并。
 *
 * 语义（与 instructions.ts 的 AGENTS.md 相反）：
 * - 规则是「机器可读的执行约束」，越靠近工作区的项目约束应当越具体、越能覆盖外层；
 * - 合并结果按「外层在前、内层在后」排列，配合 applyCustomRules 的
 *   「顺序遍历、后命中的覆盖先命中的」语义，正好实现「内层规则覆盖外层规则」。
 * - 同一 action+resource 在外层是 allow、内层是 deny 时，内层的 deny 生效（更安全）。
 */
export async function loadProjectPermissionsDetailed(workspace: string | null): Promise<ProjectPermissionResult> {
  const empty: ProjectPermissionResult = { rules: [], detailed: [], files: [] }
  if (!workspace) return empty
  const abs = path.resolve(workspace)

  // 收集从根向上所有命中文件（最内层在前）
  const files: string[] = []
  let dir = abs
  for (let i = 0; i < MAX_UP_LEVELS; i++) {
    const candidate = path.join(dir, FILE)
    try {
      const st = await fs.stat(candidate)
      if (st.isFile()) files.push(candidate)
    } catch {
      // 不存在，继续向上
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // mtime 缓存：所有命中文件的 mtime 都没变才复用
  if (cache && cache.workspace === abs && cache.result.files.length === files.length) {
    const mtimes = new Map<string, number>()
    let allSame = true
    for (const f of files) {
      try {
        const st = await fs.stat(f)
        mtimes.set(f, st.mtimeMs)
        if (cache.mtimes.get(f) !== st.mtimeMs) allSame = false
      } catch {
        allSame = false
      }
    }
    if (allSame) return cache.result
  }

  // 逐层读并合并：files 是最内层在前，倒序处理让最外层先进数组
  const detailed: PermRuleWithSource[] = []
  for (let i = files.length - 1; i >= 0; i--) {
    const file = files[i]
    let rules: PermissionRule[] = []
    try {
      rules = await readRules(file)
    } catch {
      rules = []
    }
    for (const r of rules) detailed.push({ ...r, from: file })
  }

  const rules: PermissionRule[] = detailed.map(({ from: _from, ...r }) => r)
  const result: ProjectPermissionResult = { rules, detailed, files }
  const mtimes = new Map<string, number>()
  for (const f of files) {
    try {
      mtimes.set(f, (await fs.stat(f)).mtimeMs)
    } catch {
      // 忽略
    }
  }
  cache = { workspace: abs, result, mtimes }
  return result
}

/** 从工作区根向上逐层读 roroto.json 的 permissions，合并后返回（不创建文件） */
export async function loadProjectPermissions(workspace: string | null): Promise<PermissionRule[]> {
  return (await loadProjectPermissionsDetailed(workspace)).rules
}

/** 清空缓存（改过 roroto.json 后调用，下次读盘重新加载） */
export function clearPermissionsCache(): void {
  cache = null
}

/**
 * 校验一条规则的合法性。返回错误文案；合法返回 null。
 * 与 loadProjectPermissions 的过滤条件保持一致，避免界面写出引擎读不到的东西。
 */
export function validateRule(r: PermissionRule): string | null {
  if (!r || typeof r !== 'object') return '规则不是对象'
  if (typeof r.action !== 'string' || !r.action.trim()) return '缺少工具名（action）'
  if (typeof r.resource !== 'string' || !r.resource.trim()) return '缺少匹配目标（resource）'
  if (r.effect !== 'allow' && r.effect !== 'deny') return '效果（effect）必须是 allow 或 deny'
  return null
}

/**
 * 把一组权限规则写回工作区的 roroto.json 的 permissions 字段。
 * 保留文件里已有的其他字段（roroto.json 未来会承载更多项目级配置），只覆盖 permissions。
 * 原子写：先写临时文件再 rename。规则全部通过校验才写，否则抛错不落盘。
 */
export async function saveProjectPermissions(
  workspace: string | null,
  rules: PermissionRule[]
): Promise<{ path: string; created: boolean; count: number }> {
  if (!workspace) throw new Error('没有工作区，无法写入权限规则')
  const abs = path.resolve(workspace)
  const file = path.join(abs, FILE)

  // 逐条校验，任何一条非法都不落盘
  for (const r of rules) {
    const err = validateRule(r)
    if (err) throw new Error(`第 ${rules.indexOf(r) + 1} 条规则不合法：${err}`)
  }

  // 读旧文件（可能不存在），保留 permissions 之外的字段
  let existing: Record<string, unknown> = {}
  let existed = false
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed
      existed = true
    }
  } catch {
    // 文件不存在或损坏：当作新建
  }

  const next: Record<string, unknown> = { ...existing, permissions: rules }
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  await fs.rename(tmp, file)

  // 立即失效缓存，下次 loadProjectPermissions 会读到新内容
  cache = null
  return { path: file, created: !existed, count: rules.length }
}
