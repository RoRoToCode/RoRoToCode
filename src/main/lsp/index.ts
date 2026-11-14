/**
 * 诊断服务的管理层：一个工作区一个 tsserver，失败就退，不让它拖累主循环。
 *
 * 设计取舍：
 * - **懒启动**。用户可能整个会话都在读代码，一次都不写。tsserver 要占 60-100MB，
 *   一开机就起是浪费。第一次写文件时才拉起。
 * - **连续失败三次就本工作区关掉**。tsserver 起不来最常见的原因（没装 typescript、
 *   项目太大加载超时、被杀毒软件拦），重试也不会变好。开着只会让每次写文件多等 6 秒。
 * - **永不抛错**。诊断是锦上添花，它挂了绝不能影响写文件本身。
 *
 * 但「永不抛错」不等于「假装查过」：项目里没装 typescript 时以前静默返回空数组，
 * 调用方看到空数组就当成「没有编译错误」—— 模型改完一堆类型错误照样收工。
 * 所以真正的入口是 diagnoseReport()，它把「查了没查」和「有没有错」分开报；
 * diagnoseFiles() 只是要 diags 时的薄包装。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { errorsOnly, isTypeScriptFile, type Diag } from '../../shared/diagnostics'
import { TsServer } from './tsserver'
import { nativeDiagnose } from './native'
import type { LspLocation, LspReferences } from './types'

interface Slot {
  server: TsServer
  failures: number
  /** 这个工作区确认没有可用的 tsserver（没装 typescript / 起不来），别再试 */
  off: boolean
  /** 上次活动时间，用于闲置回收 */
  at: number
}

/** 为什么这批文件没做成检查 —— 调用方据此决定要不要告诉模型「别当它通过了」 */
export type DiagSkip = 'no-config' | 'no-typescript' | 'unavailable' | 'empty' | 'not-found'

export interface DiagnoseReport {
  diags: Diag[]
  /** null 表示确实检查过了（没错误也是一种结论） */
  skipped: DiagSkip | null
}

const slots = new Map<string, Slot>()
const MAX_FAILURES = 3
const IDLE_MS = 10 * 60_000

function wsKey(workspace: string): string {
  return path.resolve(workspace).replace(/\\/g, '/').toLowerCase()
}

function hasTsConfig(workspace: string): boolean {
  if (!workspace || !existsSync(workspace)) return false
  return ['tsconfig.json', 'jsconfig.json'].some((f) => existsSync(path.join(workspace, f)))
}

/** 这个项目值不值得做类型检查：有 tsconfig 或 jsconfig，且装了 typescript */
function eligible(workspace: string): boolean {
  return hasTsConfig(workspace) && TsServer.locate(workspace) !== null
}

/** TS/JS 走 tsserver 的增量诊断；失败按原策略退避 */
async function tsDiagnose(
  workspace: string,
  targets: string[]
): Promise<{ diags: Diag[]; skipped: DiagSkip | null }> {
  const k = wsKey(workspace)
  let slot = slots.get(k)
  if (!slot) {
    /**
     * 这里必须把「没配置」和「没装编译器」分开返回：
     * 前者是项目本来就不做类型检查（纯 JS 脚本、别的语言），提示也没用；
     * 后者是「应该有检查但没有」—— 正是会把模型骗过去的那种情况。
     */
    if (!hasTsConfig(workspace)) return { diags: [], skipped: 'no-config' }
    const ts = TsServer.locate(workspace)
    if (!ts) return { diags: [], skipped: 'no-typescript' }
    slot = { server: new TsServer(workspace, ts), failures: 0, off: false, at: Date.now() }
    slots.set(k, slot)
  }
  if (slot.off) return { diags: [], skipped: 'unavailable' }

  slot.at = Date.now()
  try {
    const raw = await slot.server.diagnose(targets)
    // 拿到结果就说明服务是活的：之前的失败计数清掉，
    // 否则「偶发一次超时」会一路累加到三次，把好端端的服务关掉
    slot.failures = 0
    return { diags: raw, skipped: null }
  } catch {
    slot.failures += 1
    if (slot.failures >= MAX_FAILURES) {
      slot.off = true
      slot.server.dispose()
    }
    return { diags: [], skipped: 'unavailable' }
  }
}

/**
 * 取一批文件的诊断，并如实报告「这批文件到底查没查」。
 *
 * 返回的 skipped 只描述 TS/JS 这一路：Python/Go/Rust/Java 走项目自带命令，
 * 没有可用编译器时同样返回空数组，但它们本来就没有「配置齐全却静默跳过」的歧义，
 * 不值得为它们再加一套状态。
 */
export async function diagnoseReport(workspace: string | null, files: string[]): Promise<DiagnoseReport> {
  if (!workspace || files.length === 0) return { diags: [], skipped: 'empty' }

  const existing = files.filter((f) => existsSync(f))
  if (existing.length === 0) return { diags: [], skipped: 'not-found' }

  const tsTargets = existing.filter((f) => isTypeScriptFile(f))
  const nativeTargets = existing.filter((f) => !isTypeScriptFile(f))

  const out: Diag[] = []
  let skipped: DiagSkip | null = null
  if (tsTargets.length) {
    const ts = await tsDiagnose(workspace, tsTargets)
    out.push(...ts.diags)
    skipped = ts.skipped
  }
  if (nativeTargets.length) out.push(...(await nativeDiagnose(workspace, nativeTargets)))
  return { diags: errorsOnly(out), skipped }
}

/**
 * 取一批文件的编译错误（只要结果、不关心查没查时的旧入口）。
 * 返回空数组表示「没错误、或这项能力不可用」——需要区分两者请用 diagnoseReport。
 */
export async function diagnoseFiles(workspace: string | null, files: string[]): Promise<Diag[]> {
  return (await diagnoseReport(workspace, files)).diags
}

/** 回收闲置实例。由 main 的定时器调用 */
export function reapIdle(): void {
  const now = Date.now()
  for (const [k, slot] of slots) {
    if (now - slot.at < IDLE_MS) continue
    slot.server.dispose()
    slots.delete(k)
  }
}

/**
 * 取一个工作区的 tsserver（没装 typescript / 之前已经判 off 就返回 null）。
 * definition / references 复用 diagnose 的同一套懒启动 + 失败退避。
 */
function getServer(workspace: string): TsServer | null {
  const k = wsKey(workspace)
  let slot = slots.get(k)
  if (!slot) {
    if (!eligible(workspace)) return null
    const ts = TsServer.locate(workspace)
    if (!ts) return null
    slot = { server: new TsServer(workspace, ts), failures: 0, off: false, at: Date.now() }
    slots.set(k, slot)
  }
  if (slot.off) return null
  slot.at = Date.now()
  return slot.server
}

/**
 * 定义跳转。只支持 TS/JS（别的语言还没接后端）。
 * 任何失败都返回空数组——导航能力绝不能让主流程抛错。
 */
export async function gotoDefinition(
  workspace: string | null,
  file: string,
  line: number,
  col: number
): Promise<LspLocation[]> {
  if (!workspace || !file || !isTypeScriptFile(file)) return []
  const server = getServer(workspace)
  if (!server) return []
  try {
    return await server.definition(file, Math.max(1, line), Math.max(1, col))
  } catch {
    return []
  }
}

/** 引用查找。失败返回空结果 */
export async function findReferences(
  workspace: string | null,
  file: string,
  line: number,
  col: number
): Promise<LspReferences> {
  if (!workspace || !file || !isTypeScriptFile(file)) return { refs: [], truncated: false, fileCount: 0 }
  const server = getServer(workspace)
  if (!server) return { refs: [], truncated: false, fileCount: 0 }
  try {
    return await server.references(file, Math.max(1, line), Math.max(1, col))
  } catch {
    return { refs: [], truncated: false, fileCount: 0 }
  }
}

export function disposeAll(): void {
  for (const slot of slots.values()) slot.server.dispose()
  slots.clear()
}

/** 只用于测试：把状态清干净，避免用例之间互相影响 */
export function resetDiagnostics(): void {
  disposeAll()
}
