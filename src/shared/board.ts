/**
 * 共享黑板的解析与渲染。纯函数，不碰磁盘和 electron —— 落盘在 main/board.ts。
 *
 * 为什么要有它：多 agent 协作时，交接只能带「一句话 + 一段线索」，
 * 每个接手方都得重新交底（这个仓库用 pnpm、别动 legacy/、测试要跑某条命令）。
 * 这些事既不该塞进每个人的岗位描述（改一次改三处），也不该混进长期记忆
 * （记忆是「一直如此」，黑板是「这摊活现在到哪了」）。
 */

/** 三段的语义边界，写死在提示词里，别让模型自由发明分类 */
export type BoardSection = 'fact' | 'rule' | 'todo'

export const BOARD_SECTIONS: BoardSection[] = ['rule', 'fact', 'todo']

export const SECTION_LABEL: Record<BoardSection, string> = {
  rule: '约定',
  fact: '事实',
  todo: '待办'
}

/** 注入系统提示的最大字符数：黑板是「补充」，不该把主提示挤掉 */
export const BOARD_PROMPT_LIMIT = 900
/** 单条长度上限，超了截断：黑板是便签，不是文档 */
const MAX_NOTE = 300
/** 每段最多留多少条，多了从最旧的开始丢 */
const MAX_PER_SECTION = 40

export type BoardData = Record<BoardSection, string[]>

export function emptyBoard(): BoardData {
  return { rule: [], fact: [], todo: [] }
}

export function isSection(v: unknown): v is BoardSection {
  return v === 'rule' || v === 'fact' || v === 'todo'
}

/**
 * 从 markdown 里读回三段。
 * 认不出的小节直接忽略 —— 用户手改文件写坏一行，不该让整个黑板失效。
 */
export function parseBoard(text: string): BoardData {
  const out = emptyBoard()
  let cur: BoardSection | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const head = /^##\s+(.+?)\s*$/.exec(line)
    if (head) {
      const label = head[1]
      cur = (BOARD_SECTIONS.find((s) => SECTION_LABEL[s] === label) ?? null) as BoardSection | null
      continue
    }
    if (!cur) continue
    const bullet = /^\s*-\s+(.+)$/.exec(line)
    if (bullet) {
      const item = bullet[1].trim()
      if (item) out[cur].push(item)
    }
  }
  return out
}

/** 写回文件：始终三段齐全，空段也留着，用户打开就能直接在下面加 */
export function renderBoard(data: BoardData): string {
  const body: string[] = ['# 共享黑板', '', '> 同一个工作区里所有档案共用的一页。只放跨会话还有效的事。', '']
  for (const s of BOARD_SECTIONS) {
    body.push(`## ${SECTION_LABEL[s]}`, '')
    for (const item of data[s]) body.push(`- ${item}`)
    if (data[s].length) body.push('')
  }
  return body.join('\n')
}

/** 去重用的归一化：同一条话换个标点不该变成两条 */
function norm(s: string): string {
  return s
    .replace(/[\s`*_#>]/g, '')
    .replace(/[。，、；：！？.,;:!?]/g, '')
    .toLowerCase()
}

/**
 * 往某一段加一条。新的在上：黑板是便签，最近写的最可能是当下要看的。
 * 返回是否真的加了（重复的不加分）。
 */
export function addToBoard(data: BoardData, section: BoardSection, note: string): { data: BoardData; added: boolean; items: number } {
  const text = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE)
  const count = (d: BoardData): number => BOARD_SECTIONS.reduce((n, s) => n + d[s].length, 0)
  if (!text) return { data, added: false, items: count(data) }

  const key = norm(text)
  const dup = BOARD_SECTIONS.some((s) => data[s].some((i) => norm(i) === key || norm(i).includes(key)))
  if (dup) return { data, added: false, items: count(data) }

  const next: BoardData = { ...data, [section]: [text, ...data[section]].slice(0, MAX_PER_SECTION) }
  // 条数按「加完之后」算：写进一条却报告旧条数，界面上会显示成没写进去
  return { data: next, added: true, items: count(next) }
}

/** 清掉某一条（按原文精确匹配），给界面上的「删掉这条」用 */
export function removeFromBoard(data: BoardData, section: BoardSection, note: string): BoardData {
  return { ...data, [section]: data[section].filter((i) => i !== note) }
}

/**
 * 拼进系统提示的那段。按「约定 → 事实 → 待办」的顺序装，装不下的跳过 ——
 * 宁可少一条「待办」，也要把「约定」留下：约定错了整轮都白干。
 */
export function boardPromptText(data: BoardData): string {
  const line = (s: BoardSection, i: string): string => `- [${SECTION_LABEL[s]}] ${i}`
  const queue: Array<{ s: BoardSection; i: string }> = []
  for (const s of BOARD_SECTIONS) for (const i of data[s]) queue.push({ s, i })

  const picked: string[] = []
  let used = 0
  for (const q of queue) {
    const text = line(q.s, q.i)
    if (used + text.length + 1 > BOARD_PROMPT_LIMIT) continue
    picked.push(text)
    used += text.length + 1
  }
  return picked.join('\n')
}

/** 界面上显示的条目数 */
export function boardCount(data: BoardData): number {
  return BOARD_SECTIONS.reduce((n, s) => n + data[s].length, 0)
}
