/**
 * 交接（handoff）：一个档案把一件独立的活交给另一个档案。
 *
 * 和 `task`（子 agent）的区别，是这套东西值不值得存在的关键：
 * - `task`：父 agent 等结果、自己汇总，子 agent 只是「多一双手」；
 * - `handoff`：父 agent 说完就走，接手的是一个有身份、有记忆、有自己工具边界的档案。
 *
 * 只有后者能让「巡检发现问题 → 审查去修」这条链路自动跑起来，中间不用人搬。
 * 这个文件只放纯函数（提示词、标题、上限），落盘与调度在 main/handoff.ts，
 * 这样单测不需要 electron。
 */

/** 一条链路最多传几手。超过就不是分工，是踢皮球 */
export const MAX_HANDOFF_DEPTH = 3
/** 同一个会话最多交出几件活。防止模型一口气撒出去十条，把队列塞满 */
export const MAX_PER_SESSION = 2

export interface HandoffPromptInput {
  fromName?: string | null
  toName: string
  toRole?: string | null
  task: string
  context?: string | null
  files?: string[] | null
  /** 下游能不能真的动文件。不能的话要明确告诉它别硬试，把改法写出来 */
  canWrite: boolean
}

/** 交接单。接手方只拿这一份开工，所以必须自足：干什么、凭什么、看哪里、边界在哪 */
export function buildHandoffPrompt(input: HandoffPromptInput): string {
  const from = input.fromName?.trim() || '另一个档案'
  const task = input.task.trim()
  const context = (input.context ?? '').trim()
  const files = (input.files ?? []).map((f) => f.trim()).filter(Boolean)

  return [
    `【交接】下面这件事由「${from}」交过来，不是用户新提的需求。它已经查过一轮，你不用从头再查一遍。`,
    '',
    '要你做的事：',
    task,
    '',
    ...(context ? ['它看到的情况：', context, ''] : []),
    ...(files.length
      ? ['相关文件（动手前先用 read_file 看清现状，不要凭记忆改）：', ...files.map((f) => `- ${f}`), '']
      : []),
    '边界：',
    '- 只处理上面这一处，不要顺手重构、不要扩大到别的模块。',
    '- 做完用几句话交代：改了什么、依据是什么、怎么验证的。不要长篇总结。',
    ...(input.canWrite
      ? []
      : [
          '- 这次是后台自动运行，没有人会逐条确认你的操作：写文件、执行命令都会被拒绝。',
          '  所以不要反复尝试写文件；把「具体改哪一行、改成什么」写清楚交回来，人在界面里接手。'
        ]),
    ''
  ].join('\n')
}

/** 会话标题：一眼看出这是交接来的活，以及大概是什么事 */
export function handoffTitle(toName: string, task: string): string {
  const brief = task.replace(/\s+/g, ' ').trim().slice(0, 24)
  return `↳ ${toName}${brief ? ` · ${brief}` : ''}`
}
