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
import type { PermissionRule } from './risk'

const FILE = 'roroto.json'

/** 项目级规则文件在内存里的缓存，带 mtime 失效：文件变了自动重读，不用重启 */
let cache: { workspace: string; rules: PermissionRule[]; mtimeMs: number } | null = null

/** 从工作区根读 roroto.json 的 permissions 字段（只读，不创建） */
export async function loadProjectPermissions(workspace: string | null): Promise<PermissionRule[]> {
  if (!workspace) return []
  const abs = path.resolve(workspace)
  const file = path.join(abs, FILE)

  try {
    const st = await fs.stat(file)
    if (cache && cache.workspace === abs && cache.mtimeMs === st.mtimeMs) return cache.rules
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as { permissions?: unknown }
    const rules = Array.isArray(parsed.permissions)
      ? (parsed.permissions.filter(
          (r): r is PermissionRule =>
            !!r && typeof r === 'object' &&
            typeof (r as PermissionRule).action === 'string' &&
            typeof (r as PermissionRule).resource === 'string' &&
            ((r as PermissionRule).effect === 'allow' || (r as PermissionRule).effect === 'deny')
        ) as PermissionRule[])
      : []
    cache = { workspace: abs, rules, mtimeMs: st.mtimeMs }
    return rules
  } catch {
    // 文件不存在 / 读失败：视为无规则，但仍记录「已查过、无文件」的缓存态
    if (cache && cache.workspace === abs) return cache.rules
    cache = { workspace: abs, rules: [], mtimeMs: 0 }
    return []
  }
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
