/**
 * 标准 apply_patch（unified diff）格式解析。
 *
 * 目标：兼容 OpenCode / Claude Code / Anthropic 通用的 `apply_patch` 文本格式，
 * 让模型用同一种「diff 文本」就能改文件，而不是必须学本程序私有的 JSON edits 格式。
 * 解析出的结果转成与 patchTool 共用的 `PatchEdit[]`，从而复用同一套
 * 校验（路径 / old_string 唯一性）与原子写盘逻辑。
 *
 * 支持的最小 diff 语法：
 *   *** Begin Patch          （可选头，忽略）
 *   *** Update File: a/b.ts  （或 Index: a/b.ts、--- a/b.ts、+++ b/b.ts）
 *    @@ -1,3 +1,3 @@
 *     上下文行（行首空格，无变化）
 *   - 删除行
 *   + 新增行
 *   *** End Patch            （可选尾，忽略）
 *
 * 设计取舍：
 * - 只做「行级替换」：一个 hunk 对应一次 update 编辑（old_string = 删除行+上下文行，
 *   new_string = 新增行+上下文行）。delete 整文件 / 新建整文件由 hunk 语义自然覆盖
 *   （old 全删 → 空 new，或空 old → 全新增）。
 * - 行号我们**不信任**（模型常算错），只用作合法性提示；真正定位靠 old_string 文本匹配。
 * - 无法解析或没有任何可落地的编辑时抛错，交由上层重试或换格式。
 */
/** 与 tools/index.ts 里的 PatchEdit 结构一致（这里不 import，避免循环依赖） */
export interface PatchEdit {
  path: string
  op: 'create' | 'update' | 'delete' | 'move'
  content?: string
  old_string?: string
  new_string?: string
  replace_all?: boolean
  new_path?: string
}

/** 一次 apply_patch 允许的最大 hunk 数，防模型塞入巨量改动 */
const MAX_HUNKS = 200

interface ParsedHunk {
  path: string
  oldLines: string[]
  newLines: string[]
}

/**
 * 从标准 patch 文本解析出 PatchEdit 列表。
 * 返回空数组表示「格式无法识别」或「没有实质改动」，调用方应给出明确报错。
 */
export function parseApplyPatch(text: string): PatchEdit[] {
  if (!text || typeof text !== 'string') return []
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  // split 产生的末尾伪空元素去掉（原文以换行结尾时会多一个 ''），
  // 否则它会被当成一个「空上下文行」污染 old/new 文本。
  while (lines.length && lines[lines.length - 1] === '') lines.pop()

  // 收集所有命中的文件块：按「文件头 + 紧随其后的若干 hunk」分组
  const blocks = splitBlocks(lines)
  if (blocks.length === 0) return []

  const edits: PatchEdit[] = []
  for (const block of blocks) {
    const path = block.path
    if (!path) continue
    const hunks = parseHunks(block.body)
    if (!hunks.length) {
      // 文件头出现了但没有 hunk：可能是「删除整个文件」的简写（空 body），
      // 或「新建空文件」——若正文为空且不是删除标记，忽略即可。
      continue
    }
    for (const h of hunks) {
      const edit = hunkToEdit(path, h)
      if (edit) edits.push(edit)
    }
  }

  return edits.slice(0, MAX_HUNKS)
}

/**
 * 把 patch 文本切成一个个「文件块」。
 * 文件头可能形如：
 *   *** Update File: src/a.ts
 *   *** Delete File: src/a.ts
 *   Index: src/a.ts
 *   --- a/src/a.ts
 *   +++ b/src/a.ts
 * 其中 --- / +++ 成对出现时，以 +++ 的路径为准（去掉 a/ 或 b/ 前缀）。
 */
function splitBlocks(lines: string[]): Array<{ path: string; body: string[] }> {
  const blocks: Array<{ path: string; body: string[] }> = []
  let current: { path: string; body: string[] } | null = null
  let pendingPath: string | null = null

  for (const raw of lines) {
    const line = raw
    const trimmed = line.trim()

    // 文件头标记（显式声明路径）
    const mUpdate = /^\*\*\*\s*Update File:\s*(.+?)\s*$/.exec(trimmed)
    const mDelete = /^\*\*\*\s*Delete File:\s*(.+?)\s*$/.exec(trimmed)
    const mIndex = /^Index:\s*(.+?)\s*$/.exec(trimmed)
    const mAdd = /^\+\+\+\s*(.+?)\s*$/.exec(line)

    if (mUpdate || mDelete || mIndex) {
      flush()
      const p = cleanPath((mUpdate || mDelete || mIndex)![1])
      current = { path: p, body: [] }
      if (mDelete) current.body = [] // 删除标记：正文忽略，走整文件删除
      continue
    }

    if (mAdd) {
      // 遇到 +++ 就开新文件（先 flush 上一个）。--- 行紧随其后时路径从 +++ 取。
      if (pendingPath == null) {
        flush()
        pendingPath = cleanPath(mAdd[1])
        current = { path: pendingPath, body: [] }
        pendingPath = null
      }
      continue
    }

    // 标准 diff 的 --- a/x 也可能单独出现，但路径仍以 +++ 为准，这里略过
    if (/^---\s+/.test(line)) {
      // 如果还没有当前块，说明 --- 先于 +++（异常），记下后面 +++ 会接管
      continue
    }

    // 忽略 Begin/End Patch 等包裹行
    if (/^\*\*\*\s*(Begin|End) Patch/.test(trimmed)) continue
    if (/^diff --git\s+/.test(trimmed)) continue

    if (current) current.body.push(line)
  }
  flush()

  return blocks

  function flush() {
    if (current && current.path) {
      blocks.push({ path: current.path, body: current.body })
    }
    current = null
    pendingPath = null
  }
}

/** 去掉 a/ 、b/ 前缀和可能的引号 */
function cleanPath(p: string): string {
  let s = p.trim()
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1)
  if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1)
  s = s.replace(/^(a|b)\//, '')
  return s
}

/**
 * 从文件块正文里解析 hunk。每个 hunk 以 `@@ ... @@` 开头，
 * 后续行以空格（上下文）、-（删）、+（增）开头；空行保留原样（上下文）。
 */
function parseHunks(body: string[]): ParsedHunk[] {
  const hunks: ParsedHunk[] = []
  let cur: ParsedHunk | null = null

  for (const line of body) {
    if (/^@@\s/.test(line) || /^@@$/.test(line.trim())) {
      if (cur) hunks.push(cur)
      cur = { path: '', oldLines: [], newLines: [] }
      continue
    }
    if (!cur) continue // hunk 之前的内容（文件头内其他信息）跳过

    if (line.startsWith('-') && !line.startsWith('---')) {
      cur.oldLines.push(line.slice(1))
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      cur.newLines.push(line.slice(1))
    } else if (line.startsWith('\\') && /^\\\s*No newline/.test(line)) {
      // "No newline at end of file" 标记，忽略
    } else {
      // 上下文行（含空格开头、或空行）
      const ctx = line.startsWith(' ') ? line.slice(1) : line
      cur.oldLines.push(ctx)
      cur.newLines.push(ctx)
    }
  }
  if (cur) hunks.push(cur)

  return hunks
}

/** 一个 hunk → 一次 update 编辑（old_string / new_string 各自去掉行尾换行差异，用纯文本匹配） */
function hunkToEdit(path: string, h: ParsedHunk): PatchEdit | null {
  const oldText = h.oldLines.join('\n')
  const newText = h.newLines.join('\n')
  // 去掉 hunk 里「纯上下文、无增删」的空壳（nothing changed）
  if (oldText === newText) return null
  return {
    path,
    op: 'update',
    old_string: oldText,
    new_string: newText
  }
}

/** 判断一段文本是否「看起来像」标准 apply_patch 格式（有 @@ 行 或 *** Update/Delete File 头） */
export function looksLikeApplyPatch(text: unknown): boolean {
  if (typeof text !== 'string' || !text.trim()) return false
  const t = text
  return (
    /@@\s*-\d+/.test(t) ||
    /\*\*\*\s*(Update|Delete) File:/.test(t) ||
    (/\+\+\+\s+/.test(t) && /---\s+/.test(t) && /@@\s*-\d+/.test(t))
  )
}
