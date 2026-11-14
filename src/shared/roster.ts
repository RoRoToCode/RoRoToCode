/**
 * 交接名单规则。
 *
 * 单独放一个文件是因为它要同时被三处用：引擎拼提示词、界面显示、单元测试。
 * 放在 main/agents.ts 里会让测试必须拉起 electron（那里要读 userData 路径）。
 */
import type { AgentProfile } from './types'

/**
 * 内置「主控」档案的 id。
 *
 * 它不是「另一个角色」，而是你本人在系统里的代理：工具不限、不注入岗位说明、
 * 记忆仍写工作区那一份、工作区跟随当前选择 —— 行为和普通会话完全一致，
 * 唯一多出来的能力是「能被交接、能被定时任务唤醒」。
 */
export const DEFAULT_AGENT_ID = 'agent_default'

/**
 * 可以交接的对象。
 *
 * - 排除自己：同一份提示词、同一份记忆、同一套工具，交给「自己」等于用 task。
 * - 排除「主控」给没有档案的会话：不绑档案的会话本身就是主控，再交给它只是
 *   白开一个会话，而且会让模型误以为有两个自己。
 */
export function handoffTargets(all: AgentProfile[], selfId?: string | null): AgentProfile[] {
  return all.filter((a) => a.id !== selfId && !(a.id === DEFAULT_AGENT_ID && !selfId))
}

/** 岗位说明的第一行，够放在提示词的一行里。只要 role（可选 id），别处传半截对象也能用 */
export function agentBrief(a: { id?: string; role?: string }): string {
  const line = (a.role || '').split('\n')[0].trim()
  if (line) return line
  // 主控刻意没有岗位说明，不兜一句的话提示词里会出现「- 主控：」这种空冒号
  return a.id === DEFAULT_AGENT_ID ? '通用执行者，工具与记忆跟普通会话一样' : '（没写岗位说明）'
}
