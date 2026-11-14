/**
 * 统一的代码智能接口：诊断 + 定义跳转 + 引用查找。
 *
 * 设计目标：让「语言服务器」成为可替换的后端。
 * - 现在默认后端是 tsserver（TS/JS，零额外依赖，见 lsp/tsserver.ts）；
 * - 未来接 Python(pyright) / Rust(rust-analyzer) 等真 LSP 服务器时，
 *   只需要实现 LspBackend 这个接口，上层（工具 + 闭环）完全不用动。
 *
 * 关键约束：**永不抛错**。代码智能是锦上添花，任何后端挂了都不该影响
 * 主流程（写文件、跑命令）。所以每个方法都自己兜底，失败返回空结果。
 */
import path from 'node:path'

/** 一个位置：文件（绝对路径）+ 1-based 行/列 */
export interface LspPosition {
  file: string
  line: number
  col: number
}

/** 定义跳转的结果：可以 0 到多个目标（接口实现 / 重载） */
export interface LspLocation {
  file: string
  line: number
  col: number
  /** 目标那一行的源码片段，让模型不用再读一次文件就能判断 */
  snippet?: string
}

export interface LspReferences {
  /** 引用列表；可能很大，后端负责截断到合理数量 */
  refs: LspLocation[]
  /** 是否被截断（true 表示还有更多没列出来） */
  truncated: boolean
  /** 命中的文件数，给模型一个「影响面」的直觉 */
  fileCount: number
}

/** 语言后端要实现的最小能力 */
export interface LspBackend {
  readonly name: string
  /** 这个文件该不该交给这个后端（按扩展名 / 项目类型判断） */
  handles(file: string): boolean
  /** 取诊断（只回 error 级） */
  diagnose(files: string[]): Promise<import('../../shared/diagnostics').Diag[]>
  /** 定义跳转；找不到返回空数组 */
  definition(pos: LspPosition): Promise<LspLocation[]>
  /** 引用查找 */
  references(pos: LspPosition): Promise<LspReferences>
  dispose(): void
}

/** 相对工作区路径（界面/回灌里更短，模型不会照抄盘符） */
export function relPath(file: string, workspace?: string | null): string {
  if (!workspace) return file
  const ws = workspace.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  const f = file.replace(/\\/g, '/')
  if (f.toLowerCase().startsWith(ws.toLowerCase() + '/')) return f.slice(ws.length + 1)
  return file
}

/** 把绝对路径接回工作区相对路径（工具参数进来的多是相对路径） */
export function absPath(file: string, workspace: string | null): string {
  if (!file) return file
  if (path.isAbsolute(file)) return file
  if (!workspace) return file
  return path.resolve(workspace, file)
}
