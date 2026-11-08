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
}

export function decideApproval(input: ApprovalInput): ApprovalDecision {
  // 只读且不越界：任何模式下都不用问
  if (!input.hasRisk) return 'allow'

  // 只读档：有副作用一律拒绝，连问都不问
  if (input.mode === 'readonly') return 'deny'

  /**
   * 高危操作只认「高危专用放行」，不受普通「之后全允许」和自动模式影响。
   * 这是产品的底线：删除、越界写盘、外部 MCP 工具至少要让人看到一次。
   */
  if (input.high) return input.alwaysApproveHigh ? 'allow' : 'ask'

  if (input.alwaysApprove || input.mode === 'auto') return 'allow'
  return 'ask'
}
