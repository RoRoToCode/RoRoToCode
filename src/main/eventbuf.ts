import type { AgentEvent } from '../shared/types'

type Deliver = (sessionId: string, event: AgentEvent) => void

interface Buf {
  messageId: string
  text: string
  timer: ReturnType<typeof setTimeout>
}

/**
 * 正文增量合帧器。
 *
 * 问题：provider 每收到一个 SSE chunk 就回调一次，本地模型能到上百个 chunk/秒。
 * 每一个都过一次 IPC + 一次 React setState，渲染层还得把整段会话重排一遍 ——
 * 真正被浪费的不是带宽，是主线程。
 *
 * 规则只有三条：
 * 1. 同一条消息的 delta 攒着，最多 16ms 发一次（一帧），字数不变；
 * 2. 换成非 delta 事件（tool_start / assistant_end / error …）之前必须先 flush，
 *    否则界面会先收到「回答完了」，正文才姗姗来迟地补上；
 * 3. 换了 messageId 也要先 flush，两段不能拼成一段。
 *
 * 刻意做成不依赖 electron 的独立模块：这条逻辑最容易错在顺序上，
 * 而顺序问题靠肉眼看界面是看不出来的，必须能单测。
 */
export class DeltaCoalescer {
  private bufs = new Map<string, Buf>()

  constructor(
    private readonly deliver: Deliver,
    private readonly flushMs = 16
  ) {}

  push(sessionId: string, event: AgentEvent): void {
    if (event.type === 'delta') {
      const buf = this.bufs.get(sessionId)
      if (buf && buf.messageId === event.messageId) {
        buf.text += event.text
        return
      }
      // 上一条消息还有没发完的字：先落地，再开新的一段
      if (buf) this.flush(sessionId)
      const timer = setTimeout(() => this.flush(sessionId), this.flushMs)
      this.bufs.set(sessionId, { messageId: event.messageId, text: event.text, timer })
      return
    }

    this.flush(sessionId)
    this.deliver(sessionId, event)
  }

  /** 把攒着的正文发出去；没有缓冲时是空操作，所以可以无脑先调 */
  flush(sessionId: string): void {
    const buf = this.bufs.get(sessionId)
    if (!buf) return
    this.bufs.delete(sessionId)
    clearTimeout(buf.timer)
    if (!buf.text) return
    this.deliver(sessionId, { type: 'delta', messageId: buf.messageId, text: buf.text })
  }

  /** 退出前把每个会话残留的字都发掉，别让最后几个字丢在内存里 */
  flushAll(): void {
    for (const sessionId of [...this.bufs.keys()]) this.flush(sessionId)
  }
}
