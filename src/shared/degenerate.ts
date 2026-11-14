/**
 * 生成退化（degeneration）检测：本地小模型在低温度 + 长输出预算下会
 * 陷进「同一段话反复吐」的循环，直到 max_tokens 耗尽。
 *
 * 这不是「幻觉」，是解码层面的故障：贪心解码一旦进入高概率重复路径，
 * 每个后续 token 都更像继续重复，模型自己出不来。所以光靠提示词说
 * 「不要重复」没用，必须在服务端采样 + 客户端流式两层拦。
 *
 * 判据（宁可漏判也别误伤正常回答）：
 * 1. 取末尾 64 字当探针，在末尾 6000 字窗口里至少出现 3 次；
 * 2. 最后三次出现的间距近似相等（说明是周期性循环，不是碰巧引用了同一句话）；
 * 3. 首次出现到末尾至少隔 120 字，避免把排比句、表格表头当循环。
 */

const WINDOW = 6000
const PROBE_LEN = 64
const MIN_HITS = 3
const MIN_SPAN = 120

export interface RepetitionHit {
  /** 建议截断点：保留第一份完整内容，从这里开始是重复 */
  cut: number
  /** 探针在窗口里出现的次数 */
  hits: number
  probe: string
}

export function findRepetition(text: string): RepetitionHit | null {
  if (text.length < PROBE_LEN * 3) return null
  const offset = Math.max(0, text.length - WINDOW)
  const w = text.slice(offset)
  const end = w.replace(/\s+$/, '').length
  if (end < PROBE_LEN) return null
  const probe = w.slice(end - PROBE_LEN, end)
  // 空白串成的探针没有判别力
  if (!probe.replace(/\s/g, '')) return null

  const positions: number[] = []
  for (let from = 0; ; ) {
    const i = w.indexOf(probe, from)
    if (i < 0) break
    positions.push(i)
    from = i + 1
  }
  if (positions.length < MIN_HITS) return null

  const last3 = positions.slice(-3)
  const d1 = last3[1] - last3[0]
  const d2 = last3[2] - last3[1]
  // 间距相等 = 同一个块在周期复读；允许一点误差（块里偶尔多个标点）
  if (Math.abs(d1 - d2) > Math.max(24, PROBE_LEN)) return null
  // 跨度过小说明只是短句巧合，不是整段循环
  if (end - PROBE_LEN - positions[0] < MIN_SPAN) return null

  // 探针取自块尾部：第一次出现处 + 探针长度，正好是第一份完整内容的末尾
  return { cut: offset + positions[0] + PROBE_LEN, hits: positions.length, probe }
}

/** 把循环尾巴剪掉，返回可直接入库 / 展示的干净文本 */
export function trimRepetition(text: string): { text: string; trimmed: boolean } {
  const hit = findRepetition(text)
  if (!hit) return { text, trimmed: false }
  return { text: text.slice(0, hit.cut).replace(/\s+$/, ''), trimmed: true }
}

/**
 * 流式护栏：一边收 delta 一边检测。
 *
 * 命中后 `push` 返回 false，调用方就别再把后续 delta 推给界面了——
 * 否则用户会眼看着同一段话滚十几屏。后台生成仍会跑到 max_tokens，
 * 但界面和历史里都只留干净的那一份。
 */
export function createLoopGuard() {
  let buf = ''
  let stopped = false
  let checkedAt = 0
  return {
    push(delta: string): boolean {
      if (stopped) return false
      buf += delta
      // 每攒 120 字查一次，别每个 token 都做一遍 O(n²) 扫描
      if (buf.length - checkedAt >= 120) {
        checkedAt = buf.length
        if (findRepetition(buf)) stopped = true
      }
      return !stopped
    },
    apply(text: string): { text: string; trimmed: boolean } {
      return trimRepetition(text)
    },
    isStopped(): boolean {
      return stopped
    }
  }
}
