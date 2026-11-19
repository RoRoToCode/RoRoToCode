/**
 * 静默中断后的「自动续跑」判定：被吐字前超时 / 生成中断打断时，
 * 给用户一个倒计时窗口，到期自动从断点续跑；窗口内可取消。
 *
 * 判定规则和 agent.ts 的 quietTimeout 完全一致 —— 这里把它抽成共享纯函数，
 * 主进程（决定发不发倒计时事件）和引擎（决定要不要缩上下文重试）共用一份，
 * 免得两边正则各自漂移，出现「界面说要续跑、引擎其实当普通错误」这种错位。
 */

/** 倒计时长度：60 秒。够用户看清发生了什么、也够服务端从限流里缓过来 */
export const AUTO_RESUME_SECONDS = 60

/**
 * 只有「一个字没拿到 / 生成到一半断流」这类静默中断才自动续跑。
 *
 * 这些错误的共性是：请求本身多半没问题，只是这次流没送达；从 checkpoint 接着走
 * 通常就能完成。反之 HTTP 401/402、上下文溢出、连接失败这些，续跑只会再撞一次墙，
 * 必须让用户先处理（换 Key / 缩上下文 / 检查网络），所以不在这里触发。
 */
export function isSilentStall(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return /仍然没有拿到第一个字|没有任何输出|生成中断|请求超时/.test(msg)
}

/** 埋掉可能很长的服务端原文，界面卡片只显示一句能懂的原因 */
export function stallReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (/生成中断/.test(msg)) return '生成中断：连接长时间没有返回内容'
  if (/请求超时/.test(msg)) return '请求超时：服务端没有在时限内响应'
  if (/仍然没有拿到第一个字|没有任何输出/.test(msg)) return '模型没有返回内容（可能卡在预填充）'
  return msg.slice(0, 120)
}
