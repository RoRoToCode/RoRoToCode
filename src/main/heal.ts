import type { ChatMessage, ProviderConfig, TokenUsage, ToolCall } from '../shared/types'
import { RAW_ARG_KEY, WRITE_TEXT_KEYS, HEALED_ARGS, joinContinuation, partialString, recoverArgs } from '../shared/toolargs'
import { clipSafe, clipTailSafe } from '../shared/text'
import { toolKind } from '../shared/toolguard'
import { chat } from './providers'

/** 最多续几轮。两轮已经能拼出 3 倍于单次上限的文件，再多就是模型在绕圈 */
const JOIN_ROUNDS = 2
/**
 * 值得续写的最大半成品长度。
 *
 * 取「单次写入上限」的两倍（tools/index.ts: MAX_SINGLE_WRITE_CHARS = 16000）：
 * 一次被切成两半、拼回来正好是一个正常大小的文件，还在续写的射程内；
 * 超过这个量就说明它压根没打算分段，正确解法是重来并分段，不是缝补。
 */
const MAX_HEAL_CHARS = 32000
/** 交还给模型「它上一轮说到哪儿」的尾巴长度：够它认出上下文，又不至于把 prompt 撑大 */
const JOIN_TAIL = 1200
/**
 * 续写指令。`不要道歉、不要复述` 是这句的重点 —— 少了它，小模型会先来一段
 * 「抱歉刚才被截断了，我之前在写…」，把新拿到的预算又烧掉一半。
 */
/**
 * 续写指令。`不要道歉、不要复述` 是这句的重点 —— 少了它，小模型会先来一段
 * 「抱歉刚才被截断了，我之前在写…」，把新拿到的预算又烧掉一半。
 *
 * 锚点那句是实测加的：断在 `for (let c = 0;` 时，9B 会「体贴地」跳到循环体开头
 * 写 `const bx = …`，把 ` c < cols; c++) {` 整段吃掉，拼出来是
 * `for (let c = 0;const bx = …` —— 语法直接坏掉，而括号还是配平的，结构检查抓不到。
 * 把断点那一行原样贴回去、明确要求「紧接着它」，比只说「继续」有效。
 */
const JOIN_ASK =
  '你上一条回复撞到了输出上限，被截断在中间。现在直接从断点继续输出剩余内容：' +
  '不要重复已经写过的部分，不要道歉、不要复述前文、不要加代码块围栏，只输出接下来该有的文字；'
  + '不要写任何解释、总结或「如果你需要我还可以…」这类客套话。'

/** 断点锚点：把截断处的最后一行原样交回去，并要求紧接着它写 */
function anchorHint(full: string): string {
  const nl = full.lastIndexOf('\n')
  // 尾巴可能正好切在 emoji 中间：交回给模型的必须是合法字符串
  const line = clipTailSafe(full.slice(nl + 1), 120)
  if (!line.trim()) return ''
  return `\n上一行是「${line}」——请紧接着它往下写，不要重复这一行、不要重新组织代码结构。`
}

/**
 * 把「断在半句上的尾巴」整行丢掉，退到最近一个完整语句边界。
 *
 * 为什么必须这么做：让模型在字符级断点上接着写，实测三次全坏，且坏法各不相同 ——
 *  - 重抄整行 → `x: W / 2 - paddle = { …`；
 *  - 跳过 for 头 → `for (let c = 0;const bx = …`；
 *  - 只回 4 个字符 → `ball = { x: Wr: Wx: W/2`；
 *  - 语义乱接 → `dx: 2` + `0, ball.y = …`。
 *
 * 根因不是去重不够狠，而是「断点本身不是合法位置」：模型看到的最后几个字符是
 * `dx: 2` 这种半截 token，它要么猜错、要么跳到自己觉得顺的地方。
 * 退到一个以 `;` `{` `}` `>` 结尾的行之后，交给模型的就总是一段自洽的代码，
 * 它只需要往下写，不需要猜。代价是最多丢掉末尾一行（约一百字符）。
 */
export function cutToBoundary(text: string): string {
  /**
   * 尾部空白连同换行一起去掉。
   *
   * 只去空格时，末尾那个 `\n` 会造出一个「空行」，而空行又算安全边界 ——
   * 于是判定立刻停在原地，一个字都不切（端到端跑出来的就是这个结果）。
   */
  const trimmed = text.replace(/\s+$/, '')
  /** 已经停在完整语句上：原样交回去，一个字都不丢 */
  if (/[;{}]\s*$/.test(trimmed)) return trimmed

  let end = trimmed.length
  let tries = 0
  while (tries++ < 60) {
    const nl = trimmed.lastIndexOf('\n', end - 1)
    const line = trimmed.slice(nl + 1, end)
    if (/[;{}]\s*$/.test(line) || !line.trim()) {
      /**
       * 关键：`slice(0, end)` 是**包含**这一行的。
       *
       * 第一版写成 `slice(0, nl + 1)`，把判定为安全的这一行自己也切掉了 ——
       * 模型看到的尾巴停在上一行，它不知道中间少了 `function update() {`，
       * 直接就从函数体开始写，拼出来是 `}\n\n* -1;` 这种没头的东西。
       * 判定的那一行必须留下，模型才会有「从这里往下接」的感觉。
       */
      const head = trimmed.slice(0, end)
      // 退得太多说明整段都没有边界（压缩过的一行代码之类），不如原样拼
      return head.length >= 200 ? head : text
    }
    if (nl < 0) break
    end = nl
  }
  return text
}

/**
 * 模型有时不是在「接着写」，而是把整份文件重写一遍。
 *
 * 实测（同样的打砖块 prompt，8 轮里有 2 轮这样）：断在 966 字符处，续写直接吐了
 * 8056 字符的完整文档。`joinContinuation` 只在「公共前缀够长」时才当重写处理，
 * 而重写只要开头几个字不同（多点缩进、换个变量名）就会分叉，于是被判成追加 ——
 * 拼出来 13556 字符、两份 `<html>`、两份 `<script>`，比不救还糟。
 *
 * 文档级重写有明确信号：正文里出现 `<!DOCTYPE` 或 `<html`，而手上这份已经有了。
 * 这种情况直接换成新版，不拼。
 */
export function restartsDocument(chunk: string, soFar: string): boolean {
  if (!soFar) return false
  const head = clipSafe(chunk, 400, '')
  if (!/<!doctype html|<html[\s>]/i.test(head)) return false
  return /<!doctype html|<html[\s>]/i.test(soFar)
}

/**
 * 续写里自带的代码块围栏要清掉。
 *
 * `joinContinuation` 只处理首尾，管不了模型在段落中间又套一层 ``` —— 实测拼完的
 * HTML 里出现了围栏行，文件能打开但多出三行脏字符。只在原文本来没有围栏时才清，
 * 免得把 markdown 里合法的围栏也一起吃掉。
 */
export function stripFenceLines(text: string, file: string): string {
  const ext = (file.split('.').pop() || '').toLowerCase()
  if (!['html', 'htm', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'json'].includes(ext)) return text
  if (!/^[ \t]*```/m.test(text)) return text
  return text.replace(/^[ \t]*```[A-Za-z0-9_-]*[ \t]*\r?\n/gm, '').replace(/^[ \t]*```[ \t]*$/gm, '')
}

/**
 * 掐掉文件首尾的「聊天话」。
 *
 * 实测：模型把 `</html>` 补完之后又写了一段英文客套
 * 「If you'd like, I can output one clean complete version of the entire file…」，
 * 这段被当作文件正文写进了 index.html。文件本身能跑，但末尾挂着一段散文，
 * 用户打开只会觉得莫名其妙。
 *
 * 只对 HTML 做：`</html>` 是明确的终止标记，切在它后面绝对安全。
 * JS/CSS 没有等价标记，硬切容易砍掉真实代码，宁可不处理。
 */
export function stripOuterChatter(text: string, file: string): string {
  const ext = (file.split('.').pop() || '').toLowerCase()
  if (ext !== 'html' && ext !== 'htm' && !/<html[\s>]/i.test(text)) return text
  let out = text
  const end = out.toLowerCase().lastIndexOf('</html>')
  if (end >= 0) out = out.slice(0, end + 7)
  const start = out.search(/<!doctype html|<html[\s>]/i)
  if (start > 0 && start < 400) out = out.slice(start)
  return out
}

/**
 * 续写停下、但文件明显还没收尾时的追加指令。
 *
 * 实测会撞上：9B 续了 2000 字符就自己 `stop` 了 —— 它认为「这一轮写够了」，
 * 而文件其实还停在 `loop();`，`</script></body></html>` 一个都没有。
 * 这时如果按 `finish_reason !== 'length'` 判定「拼完了」，就会把一份缺收尾的文件写进磁盘。
 */
const JOIN_FINISH_ASK =
  '还没写完：文件结尾缺少闭合（标签或括号没关）。继续从断点往下写，' +
  '直到内容完整、把该闭合的都闭合（例如 </script></body></html>）为止，不要重复已写过的部分，也不要写任何解释或客套话。'

/** 括号/标签是否配对：字符串与注释内的符号跳过，避免把 `"{"` 当成结构 */
function balanced(src: string): boolean {
  const stack: string[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '/' && n === '/') {
      const j = src.indexOf('\n', i)
      i = j < 0 ? src.length : j
      continue
    }
    if (c === '/' && n === '*') {
      const j = src.indexOf('*/', i + 2)
      i = j < 0 ? src.length : j + 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === c) break
        j++
      }
      // 字符串没闭合本身就是没写完
      if (j >= src.length) return false
      i = j + 1
      continue
    }
    if (c === '{' || c === '(' || c === '[') stack.push(c)
    else if (c === '}' || c === ')' || c === ']') {
      const open = stack.pop()
      if (!open) return false
      if ((open === '{' && c !== '}') || (open === '(' && c !== ')') || (open === '[' && c !== ']')) return false
    }
    i++
  }
  return stack.length === 0
}

/**
 * 拼完之后，内容看起来是不是还没收尾。
 *
 * 只判有把握的几类，宁可漏判也不误判 —— 误判会让引擎多要一轮续写、或者在提示里
 * 说一句并不成立的话。`.md` / `.txt` 这类没有结构可言的一律返回 false。
 */
export function looksIncomplete(text: string, file: string): boolean {
  if (!text.trim()) return true
  const ext = (file.split('.').pop() || '').toLowerCase()
  const tag = (re: RegExp) => (text.match(re) || []).length

  if (ext === 'html' || ext === 'htm' || /<html[\s>]/i.test(text)) {
    if (tag(/<script\b/gi) > tag(/<\/script>/gi)) return true
    if (tag(/<style\b/gi) > tag(/<\/style>/gi)) return true
    // 有人故意只写片段，所以「有没有 </html>」只在它自己写了 <html> 时才算数
    if (/<html[\s>]/i.test(text) && !/<\/html>/i.test(text)) return true
    return false
  }
  if (ext === 'json') {
    try {
      JSON.parse(text)
      return false
    } catch {
      return true
    }
  }
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'vue', 'svelte'].includes(ext)) {
    return !balanced(text)
  }
  return false
}

export interface HealOptions {
  provider: ProviderConfig
  /** 这一轮的完整上下文；续写要用它，不然模型不知道自己在哪个文件里干活 */
  messages: ChatMessage[]
  /** 本次回复里解析出来的工具调用（原地改） */
  calls: ToolCall[]
  signal: AbortSignal
  /**
   * 上下文快到窗口上限时先把历史折一遍再续写。
   *
   * 续写请求本来该比原请求轻 —— 原请求就是因为「prompt 太大 + 输出太长」才被挤断的，
   * 拿同一份满窗的 prompt 再发一次，大概率直接失败，然后安静退回「拦下」。
   */
  shrink?: (messages: ChatMessage[]) => ChatMessage[]
  /** 续写消耗的用量：并回这一轮，否则用户看到的 token 数会比真实少一半 */
  onUsage?: (usage: TokenUsage) => void
  /** 界面提示；子 agent 没有界面，不传 */
  onHint?: (message: string) => void
  /**
   * 续写拼完、但结构仍不完整时要拦下这条写入。这里把已经拼出来的内容存起来，
   * 返回给模型看的路径（读不到就返回 null）。
   *
   * 为什么值得多这一步：拒绝执行之后，模型唯一的出路是「重写整份文件」——
   * 那意味着把 2 万字符再吐一遍，还是可能再被切一次。把半成品留着，
   * 它只需要 read_file 看一眼再 edit_file 补尾巴，成本差一个数量级。
   */
  onSalvage?: (text: string, target: string) => string | null
}

export interface HealResult {
  /** 补全成功（含「只差收尾」直接补齐的） */
  healed: number
  /** 正文写完、只差收尾，没发续写请求 */
  sealed: number
  /** 真的续写过 */
  resumed: number
  /** 续写后结构检查仍显示没闭合（已如实告知，不当作静默成功） */
  unclosed: number
  /** 因为「拼完仍然不完整」而拒绝执行的条数：这些调用不会被写进文件 */
  rejected: number
  /**
   * 半成品大到「续写也拼不完」而被放弃的条数。
   *
   * 调用方据此**跳过升档重发**：升档是给「输出预算差一点」用的，
   * 而 5.8 万字符的半成品不是差一点，是根本没打算分段 —— 再发一次只会
   * 再吐一遍同样大的东西，白烧一轮五分钟。
   */
  oversize: number
}

/**
 * 把被输出上限切断的写入补完。
 *
 * 判据不依赖 `finish_reason`：中转网关和部分 Ollama 版本会返回 `stop` 甚至不给这个字段，
 * 但参数断在字符串中间就是没写完，这一点和 finish_reason 无关。
 * 正文已经闭合、只差收尾花括号的，直接补齐参数 —— 那时再让模型「接着写」
 * 会把正文续出重复段落。
 */
export async function healTruncatedWrites(opts: HealOptions): Promise<HealResult> {
  const { provider, signal } = opts
  const broken = opts.calls.filter(
    (c) => toolKind(c.name) === 'write' && c.argRepair && typeof c.args?.[RAW_ARG_KEY] === 'string'
  )
  const out: HealResult = { healed: 0, sealed: 0, resumed: 0, unclosed: 0, rejected: 0, oversize: 0 }
  if (!broken.length) return out

  let seq = 0

  for (const call of broken) {
    if (signal.aborted) return out
    const raw = String((call.args as Record<string, unknown>)[RAW_ARG_KEY])
    const part = partialString(raw, WRITE_TEXT_KEYS)
    if (!part) continue

    const recovered = recoverArgs(raw, ['path', 'file_path', 'filepath', 'file_name', 'filename', 'file'])

    /**
     * 字符串已闭合：正文写完了，被切掉的是收尾的引号和花括号。
     *
     * 这一步必须排在「内容太短就不救」之前：补齐参数不发任何请求、零成本，
     * 而跳过它的后果是这条调用带着残缺参数继续往下走 —— `isTruncatedWrite` 见到
     * 字符串已闭合会放行，工具拿不到 content 直接报「缺少参数」，用户看到的是
     * 「写文件失败」，文件一点没动，而其实只差一个花括号。
     */
    if (part.closed) {
      call.args = { ...recovered, [part.key]: part.text }
      Object.defineProperty(call.args, HEALED_ARGS, { value: true, enumerable: false })
      delete call.argRepair
      out.healed += 1
      out.sealed += 1
      continue
    }

    // 太短的不值得再发一次请求：可能只是模型写了个开头就去干别的了
    if (part.text.length < 200) continue

    /**
     * 太大的半成品不续写，直接退回「拦下 + 教它分段」。
     *
     * 实测账单：一次生成 58829 字符被切断后，续写两轮花掉 10 分钟、2 万 token，
     * 最后只拼出 1192 字符的骨架 —— 因为 5.8 万字符的单文件本来就不可能靠
     * 续写拼完，而且它压根没打算分段。续写在这里不是在救它，是在替它把
     * 错误的路走完。
     *
     * 阈值取 2 倍单次上限：一次被切成两半、拼回来刚好是一个正常大小的文件，
     * 这还在续写的射程内；超过这个量，正确解法是重来并分段，不是缝补。
     */
    if (part.text.length > MAX_HEAL_CHARS) {
      out.oversize += 1
      continue
    }

    if (out.resumed === 0) {
      opts.onHint?.(
        `输出被截断，${call.name} 只写了一半（已生成 ${part.text.length} 字符），正在自动续写剩下的部分…`
      )
    }
    out.resumed += 1

    /** 满窗的 prompt 再发一次多半直接失败：先折一次历史，让续写真的有地方落 */
    let base = opts.messages
    if (opts.shrink) {
      const shrunk = opts.shrink(base)
      if (shrunk?.length) base = shrunk
    }

    let full = cutToBoundary(part.text)
    let complete = false
    /** 模型自己停下来了，但文件还没收尾 */
    let unclosed = false
    /** 下一轮要不要用「还没写完」的措辞 */
    let needFinish = false
    const target = String(recovered.path ?? recovered.file_path ?? recovered.filepath ?? '')

    for (let round = 0; round < JOIN_ROUNDS + 1; round++) {
      let next
      try {
        next = await chat({
          provider,
          /**
           * 必须保持「assistant → user」的交替：直接在末尾追加一条 user 会出现
           * 连续两条 user，llama.cpp 的 jinja 模板会直接报错或把内容拼错。
           * 把尾巴当成 assistant 的历史发言放回去，语义上也正好对：
           * 那就是它刚才说到一半的地方。
           */
          messages: [
            ...base,
            { id: `heal-a-${Date.now()}-${seq++}`, role: 'assistant', content: clipTailSafe(full, JOIN_TAIL), createdAt: Date.now() },
            {
              id: `heal-u-${Date.now()}-${seq++}`,
              role: 'user',
              content: (needFinish ? JOIN_FINISH_ASK : JOIN_ASK) + anchorHint(full),
              createdAt: Date.now()
            }
          ],
          tools: [],
          // 续写出来的是文件正文，不该灌进聊天界面；界面只看到上面那条提示
          signal,
          onText: () => undefined
        })
      } catch {
        break
      }
      if (next.usage) opts.onUsage?.(next.usage)
      if (!next.text.trim()) break
      /**
       * 极短回复直接丢掉，不能拼。
       *
       * 实测：第一轮只回了 4 个字符（`r: W`）就 `stop` 了 —— 既非空、又完全不是内容。
       * 以前会老老实实拼进去，接缝变成 `ball = { x: Wr: Wx: W/2`，整份文件废掉。
       * 这不是「写得少」，是这一轮没说话，重试一次比把垃圾写进文件划算。
       */
      if (next.text.trim().length < 8) {
        if (round >= JOIN_ROUNDS) break
        continue
      }
      full = restartsDocument(next.text, full) ? next.text : joinContinuation(full, next.text)
      // 又被切：说明还得接着写，下一轮用普通续写措辞
      if (next.finishReason === 'length') {
        needFinish = false
        continue
      }
      complete = true
      /**
       * 停下来了不等于写完了。
       *
       * 实测：9B 续了 2028 字符就 `stop`，文件停在 `loop();`，`</script></body></html>`
       * 一个都没有。以前这里直接认定成功，把缺收尾的文件写进磁盘 —— 属于「静默写坏」。
       * 现在先看结构：没闭合就额外要一轮，并明确要求收尾；已经多给过一轮就接受，
       * 但在提示里如实说明，别让用户以为一切正常。
       */
      unclosed = looksIncomplete(full, target)
      if (!unclosed) break
      if (round >= JOIN_ROUNDS) break
      needFinish = true
    }
    /**
     * 硬闸：拼完仍然不完整，这条写入不能执行。
     *
     * 以前这里只是「记一笔 unclosed 然后照常落参」—— 把一份缺 `</script></body></html>`
     * 的文件当成功写进磁盘，最后用户打开才发现是坏的。续写本身可以赌，
     * 但「赌输的内容写进文件」不行：它会覆盖掉用户原本能用的版本。
     *
     * 实测这个概率不低：10 轮里 4 轮被结构检查标出没闭合。
     *
     * 拒绝之后不能就这么算了 —— 已经拼出来的两万字符是真金白银生成的，
     * 存一份让模型 read_file 接着补，比让它重吐一遍省一个数量级。
     */
    if (!complete || unclosed) {
      if (unclosed) out.unclosed += 1
      out.rejected += 1
      const keep = opts.onSalvage?.(full, target) ?? null
      const what = !complete ? '续写两轮都又被切断了' : '续写停下来了，但结尾没有闭合（缺标签或括号）'
      call.truncRejected =
        `[已拦下·续写未完成] 上一条回复撞到输出上限，这次「${call.name}」${what}，` +
        `所以没有执行，${target || '目标文件'} 保持原样（半截内容写下去会把它覆盖成残废）。\n` +
        (keep
          ? `已经生成的 ${full.length} 字符存在 ${keep}，可以用 read_file 读出它，` +
            '再用 edit_file 把缺的部分补上；不要整份重写。'
          : `已经生成的 ${full.length} 字符没有落盘。接下来把文件拆小写：` +
            '先 write_file 只写骨架（函数签名和结构），再用 edit_file 一段一段填实现。')
      continue
    }

    if (!/```/.test(part.text)) full = stripFenceLines(full, target)
    full = stripOuterChatter(full, target)
    call.args = { ...recovered, [part.key]: full }
    // 续写拼出来的内容不适用单次写入上限（见 HEALED_ARGS 的说明）
    Object.defineProperty(call.args, HEALED_ARGS, { value: true, enumerable: false })
    // 清掉 argRepair：这一条已经补全了，再留着会被 isTruncatedWrite 当成半截写入拦掉
    delete call.argRepair
    out.healed += 1
  }

  if (out.healed) {
    const bits: string[] = []
    if (out.sealed) bits.push(`补齐了 ${out.sealed} 个只差收尾的写入`)
    if (out.resumed) bits.push(`续写了 ${out.resumed} 个被切断的写入`)
    opts.onHint?.(`${bits.join('，')}，内容拼接完成。`)
  }
  /**
   * 拒绝执行对用户是「看起来什么都没发生」，必须说出来。
   * 不说的话，界面上的正文明明写完了，文件却还是旧的 —— 用户会以为是程序坏了。
   */
  if (out.rejected) {
    opts.onHint?.(
      `${out.rejected} 个写入续写后仍不完整，已拦下没有执行，文件保持原样；` +
        '已把这部分内容存到工作区，正在让模型接着补。'
    )
  }
  return out
}
