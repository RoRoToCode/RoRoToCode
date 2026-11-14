import type { ApprovalMode } from '../shared/types'

/**
 * 审批决策：把「模式 + 本次会话的放行记录 + 风险等级」压成一个纯函数。
 *
 * 抽出来的原因有两条：
 * 1. 原来这段逻辑散在 runLoop 与子 agent 的 approve 回调里，两处判断不一致；
 * 2. `RiskInfo.high` 曾经只是被写进注释，没有任何分支读它 —— 高危操作跟着
 *    「之后全允许」一起被静默放行。纯函数配上单测，以后加分支不容易再漏字段。
 */

export type ApprovalDecision = 'allow' | 'deny' | 'ask'

export interface ApprovalInput {
  mode: ApprovalMode
  /** 本次调用是否被判定为有风险（null 风险表示工具只读且不越界） */
  hasRisk: boolean
  /** 风险是否属于高危（删除 / 越界 / 网络 / 外部 MCP 工具） */
  high: boolean
  /** 本会话已点过「之后全允许」 */
  alwaysApprove: boolean
  /** 本会话已显式允许过高危操作 */
  alwaysApproveHigh: boolean
  /**
   * 用户在审批弹窗里点过「以后都这样」：这个工作区里这个工具长期放行。
   * 只可能来自非高危操作 —— 高危的「记住」不落盘（见 main/grants.ts 的说明）。
   */
  granted?: boolean
  /** 被项目规则明确拒绝：直接 deny，不弹确认框 */
  denied?: boolean
}

export function decideApproval(input: ApprovalInput): ApprovalDecision {
  // 项目规则明确拒绝：任何模式、任何放行记录都拦不住，直接 deny
  if (input.denied) return 'deny'

  // 只读且不越界：任何模式下都不用问
  if (!input.hasRisk) return 'allow'

  // 只读档 / 计划模式：有副作用一律拒绝，连问都不问。
  // 计划模式的「动手」不靠放行，而是靠用户批准后把会话模式切成 build。
  if (input.mode === 'readonly' || input.mode === 'plan') return 'deny'

  /**
   * 高危操作只认「高危专用放行」，不受普通「之后全允许」和自动模式影响。
   * 这是产品的底线：删除、越界写盘、外部 MCP 工具至少要让人看到一次。
   */
  if (input.high) return input.alwaysApproveHigh ? 'allow' : 'ask'

  /**
   * granted 是「以后都这样」的长期授权。放在 high 之后是有意的：
   * 它永远不会让高危操作跳过确认 —— 那条线不归用户的一次点击管。
   */
  if (input.alwaysApprove || input.granted || input.mode === 'auto') return 'allow'
  return 'ask'
}
