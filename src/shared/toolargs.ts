import type { ArgRepair, ToolCall } from './types'

/**
 * 工具参数的容错。
 *
 * 云端模型吐出来的 arguments 基本是合法 JSON；14B 级别的本地模型不是。
 * 实测常见的坏法就这么几种，而且全都高频出现：
 *
 * - 尾逗号 `{"path": "a.ts",}`
 * - 单引号 `{'path': 'a.ts'}`
 * - 键没加引号 `{path: "a.ts"}`
 * - Python 字面量 `True` / `None`
 * - 字符串里塞了裸换行（写文件时最要命）
 * - 外面包一层 ```json 或 <tool_call>
 * - 前后各来一句寒暄和总结
 * - 参数被套了一层 `{"input": {...}}` / `{"kwargs": {...}}`
 * - 写到一半被上下文截断
 * - 键名直译成 `file_path` / `filepath`，或者 `content` 写成 `text`
 *
 * 这些错原来统一表现成「缺少 path 参数」——模型据此判断是「我用法不对」，
 * 于是重读一遍工具说明、再吐一遍同样的坏 JSON，白烧两三轮还没动手。
 *
 * 所以这里分三层，能救则救，救不了就说清楚坏在哪：
 *   1. 语法层：剥外壳、修标点、补引号（relaxJson）
 *   2. 语义层：按工具 schema 强转类型、认别名（coerce）
 *   3. 兜底层：整体解不出来时按字段名逐个抢救（salvage），
 *      但**截断的字符串一律不救**——半个文件内容写进磁盘比报错糟得多
 */

/**
 * 单个工具的入参形状。
 * 两种写法都收：平铺的 `{ properties, required }`，或者 ToolSpec 那样把两部分包在 `parameters` 里 ——
 * 调用方直接把手上的工具定义丢进来就行，不用记着取 `.parameters`。
 */
export interface ArgSchema {
  properties?: Record<string, unknown>
  required?: string[]
  parameters?: { properties?: Record<string, unknown>; required?: string[] }
}

function shapeOf(schema?: ArgSchema): { properties?: Record<string, unknown>; required?: string[] } {
  if (!schema) return {}
  if (schema.parameters) return schema.parameters
  return { properties: schema.properties, required: schema.required }
}

export interface ParsedArgs {
  args: Record<string, unknown>
  repair: ArgRepair
  /** 修不出来时的原因，直接回给模型 */
  error?: string
  /** 缺了哪些必填字段 */
  missing: string[]
  /** 哪些字段「写了但被截断」——和「没写」是两回事，提示要分开说 */
  truncated?: string[]
  /** 能交给工具执行吗 */
  usable: boolean
}

/** provider 解析失败时把原始文本放在这个键上，让模型在历史里能看到自己写了什么 */
export const RAW_ARG_KEY = '_raw'

/** 从 start 处的 { 或 [ 找到配对的收尾位置；字符串和转义都跳过 */
export function balancedEnd(text: string, start: number): number {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 剥掉包在 JSON 外面的东西：BOM、代码块围栏、<tool_call>、前后寒暄。
 * 返回「里面那段」；剥不出东西时返回 null（调用方据此判断有没有发生 unwrap）。
 *
 * 注意这里**不修语法**，只负责定位。语法的活交给 relaxJson。
 */
export function stripWrapping(raw: string): string | null {
  let t = raw.trim()
  if (!t) return null
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1).trim()
  let changed = t !== raw.trim()

  // ```json … ``` / ``` … ```
  const fence = /```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/.exec(t)
  if (fence) {
    t = fence[1].trim()
    changed = true
  }

  // Qwen 一类模型的 <tool_call> 标签
  const tag = /<(?:tool_call|function_call|invoke)\b[^>]*>([\s\S]*?)<\/(?:tool_call|function_call|invoke)>/i.exec(t)
  if (tag) {
    t = tag[1].trim()
    changed = true
  }

  if (t.startsWith('{') || t.startsWith('[')) {
    const end = balancedEnd(t, 0)
    if (end === t.length - 1) return changed ? t : null
    if (end > 0) {
      const cut = t.slice(0, end + 1)
      return cut === raw.trim() && !changed ? null : cut
    }
    // 括号不配对（多半是被截断）：截到最后一个收尾符，剩下的交给 relaxJson / salvage
    const last = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'))
    if (last > 0) return t.slice(0, last + 1)
    return changed ? t : null
  }

  // 不以括号开头：从第一个 { 或 [ 起截到配对处
  const start = t.search(/[{[]/)
  if (start < 0) return changed ? t : null
  const end = balancedEnd(t, start)
  if (end > start) return t.slice(start, end + 1)
  const last = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'))
  if (last > start) return t.slice(start, last + 1)
  return t.slice(start)
}

const IDENT_START = /[A-Za-z_$\u4e00-\u9fff]/
const IDENT_PART = /[A-Za-z0-9_$\u4e00-\u9fff]/

/**
 * 把「看起来像 JSON」的文本修成真 JSON。逐字符扫描，不能用正则整体替换 ——
 * 无脑 `replace(/'/g, '"')` 会把字符串内容里的单引号也改掉，`"it's"` 变成 `"it"s"` 直接炸。
 *
 * 修的内容：单引号串、裸键、尾逗号、True/False/None、// 与 /* 注释、
 * 以及字符串里的裸换行/制表符（JSON 不允许，本地模型天天写）。
 */
export function relaxJson(src: string): string {
  let out = ''
  let i = 0
  const stack: string[] = []
  let expectKey = false

  const eatString = (quote: string): void => {
    out += '"'
    i++
    while (i < src.length) {
      const c = src[i]
      if (c === '\\') {
        const nx = src[i + 1]
        if (nx === undefined) {
          i++
          break
        }
        // 单引号串里的 \' 是转义引号，进了双引号串就该是 ' 本身
        if (nx === "'") out += "'"
        else out += '\\' + nx
        i += 2
        continue
      }
      if (c === quote) {
        i++
        break
      }
      // 用单引号开的串里遇到双引号：转义掉，否则提前闭合
      if (c === '"') {
        out += '\\"'
        i++
        continue
      }
      if (c === '\n') {
        out += '\\n'
        i++
        continue
      }
      if (c === '\r') {
        i++
        continue
      }
      if (c === '\t') {
        out += '\\t'
        i++
        continue
      }
      out += c
      i++
    }
    out += '"'
    expectKey = false
  }

  while (i < src.length) {
    const ch = src[i]

    // 注释：不是 JSON，但模型偶尔会把参数写成带注释的 JS
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl < 0 ? src.length : nl
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      i = close < 0 ? src.length : close + 2
      continue
    }

    if (ch === '"' || ch === "'") {
      eatString(ch)
      continue
    }

    if (ch === '{' || ch === '[') {
      out += ch
      stack.push(ch)
      expectKey = ch === '{'
      i++
      continue
    }

    if (ch === '}' || ch === ']') {
      stack.pop()
      // 尾逗号：只有紧挨在收尾符前面的那个才是多余的
      out = out.replace(/,\s*$/, '')
      out += ch
      expectKey = false
      i++
      continue
    }

    if (ch === ',') {
      out += ','
      expectKey = stack[stack.length - 1] === '{'
      i++
      continue
    }

    if (ch === ':') {
      out += ':'
      expectKey = false
      i++
      continue
    }

    if (IDENT_START.test(ch)) {
      // 裸键：只在「该出现键」的位置补引号，数组里的裸标识符不当键
      if (expectKey && stack[stack.length - 1] === '{') {
        let j = i
        while (j < src.length && IDENT_PART.test(src[j])) j++
        let k = j
        while (k < src.length && /\s/.test(src[k])) k++
        if (src[k] === ':') {
          out += JSON.stringify(src.slice(i, j))
          i = j
          continue
        }
      }
      const lit = /^(true|false|null|undefined|NaN|Infinity|True|False|None|TRUE|FALSE|NULL)\b/.exec(src.slice(i))
      if (lit) {
        const low = lit[1].toLowerCase()
        out += low === 'true' ? 'true' : low === 'false' ? 'false' : 'null'
        i += lit[1].length
        continue
      }
    }

    out += ch
    i++
  }

  return out
}

/** 严格解析；失败返回 null（不抛） */
function tryStrict(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 尽最大努力把一段文本解成 JSON 值。
 * 先严格、再剥壳、最后修语法。给 parseTextToolCalls 也用这条路径 ——
 * 它原来在裸键写法上会整条丢弃，把工具调用当成普通正文发出去。
 */
export function parseLoose(text: string): unknown {
  const t = text.trim()
  if (!t) return undefined
  const strict = tryStrict(t)
  if (strict !== null && strict !== undefined) return strict

  const inner = stripWrapping(t)
  const candidates = inner && inner !== t ? [inner, t] : [t]
  for (const c of candidates) {
    const v = tryStrict(c)
    if (v !== null && v !== undefined) return v
    const relaxed = tryStrict(relaxJson(c))
    if (relaxed !== null && relaxed !== undefined) return relaxed
  }
  return undefined
}

/**
 * 参数外面套了一层的常见写法。`{"input": {...}}` 在 Python 系的模型上特别常见，
 * 拆不开的话工具会一直报「缺 path」——因为真的参数被藏在里面。
 */
const WRAPPERS = new Set(['input', 'args', 'arguments', 'parameters', 'params', 'kwargs', 'arguments_json'])

/** 同一字段的不同写法。只在「目标字段缺失」时才用，避免把模型本来写对的键改掉 */
const ALIAS: Record<string, string[]> = {
  path: ['file_path', 'filepath', 'filePath', 'file_name', 'filename', 'file', 'target', 'absolute_path', 'path_name'],
  content: ['text', 'contents', 'body', 'data', 'file_content', 'new_content'],
  old_string: ['old_text', 'oldText', 'old_str', 'search', 'find', 'old'],
  new_string: ['new_text', 'newText', 'new_str', 'replace', 'replacement', 'new'],
  command: ['cmd', 'shell', 'script', 'bash', 'command_line'],
  pattern: ['query', 'regex', 'keyword', 'search_pattern'],
  url: ['link', 'href', 'address'],
  prompt: ['query', 'question', 'ask']
}

function unwrapAlias(args: Record<string, unknown>, schema?: ArgSchema): Record<string, unknown> {
  const keys = Object.keys(args)
  if (keys.length !== 1) return args
  const only = keys[0]
  if (!WRAPPERS.has(only.toLowerCase())) return args
  // schema 里真有这个字段就别拆
  if (shapeOf(schema).properties && only in (shapeOf(schema).properties ?? {})) return args
  const inner = args[only]
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as Record<string, unknown>
  return args
}

function cast(v: unknown, type: string): unknown {
  if (type === 'number' || type === 'integer') {
    if (typeof v === 'string') {
      const n = Number(v.trim())
      if (Number.isFinite(n)) return type === 'integer' ? Math.round(n) : n
      return v
    }
    if (typeof v === 'boolean') return v ? 1 : 0
    return v
  }
  if (type === 'boolean') {
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase()
      if (s === 'true' || s === 'yes' || s === '1' || s === 'on') return true
      if (s === 'false' || s === 'no' || s === '0' || s === 'off' || s === '') return false
      return v
    }
    if (typeof v === 'number') return v !== 0
    return v
  }
  if (type === 'string') {
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    return v
  }
  if (type === 'array') {
    if (Array.isArray(v)) return v
    if (v === undefined || v === null) return v
    // 单个值当一元数组：模型常把 items 直接写成一个对象
    return [v]
  }
  if (type === 'object') {
    if (typeof v === 'string') {
      const parsed = parseLoose(v)
      if (parsed && typeof parsed === 'object') return parsed
    }
    return v
  }
  return v
}

/** 按 schema 强转类型、认别名、归一键名大小写。没有 schema 就原样返回 */
function coerce(args: Record<string, unknown>, schema?: ArgSchema): Record<string, unknown> {
  const props = shapeOf(schema).properties
  if (!props) return args
  const out: Record<string, unknown> = { ...args }
  const names = Object.keys(props)

  // fileName / FILE_NAME → file_name
  for (const k of Object.keys(out)) {
    if (k in props) continue
    const norm = k.replace(/[_\-\s]/g, '').toLowerCase()
    const hit = names.find((p) => p.replace(/[_\-\s]/g, '').toLowerCase() === norm)
    if (hit && !(hit in out)) {
      out[hit] = out[k]
      delete out[k]
    }
  }

  // file_path → path
  for (const [target, aliases] of Object.entries(ALIAS)) {
    if (target in out || !(target in props)) continue
    for (const a of aliases) {
      if (a in out) {
        out[target] = out[a]
        delete out[a]
        break
      }
    }
  }

  for (const k of Object.keys(out)) {
    const p = props[k] as { type?: string } | undefined
    if (p?.type) out[k] = cast(out[k], p.type)
  }
  return out
}

/** 读到的东西：值，或者「这个字段写了但断了」 */
interface FieldReply {
  value?: unknown
  truncated?: boolean
}

/**
 * 整体解不出来时按字段名逐个抠。
 *
 * 关键防线：字符串读到末尾还没遇到闭合引号 = 被截断了，这个字段直接放弃。
 * 写文件时半个 content 落到磁盘上，比这次调用失败严重得多。
 */
function readField(raw: string, key: string): FieldReply {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`["']?${esc}["']?\\s*:\\s*`, 'i').exec(raw)
  if (!m) return {}
  let i = m.index + m[0].length
  while (i < raw.length && /\s/.test(raw[i])) i++
  if (i >= raw.length) return {}
  const ch = raw[i]

  if (ch === '"' || ch === "'") {
    let s = ''
    i++
    while (i < raw.length) {
      const c = raw[i]
      if (c === '\\') {
        const nx = raw[i + 1]
        if (nx === undefined) return { truncated: true }
        s += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx === 'r' ? '\r' : nx
        i += 2
        continue
      }
      if (c === ch) return { value: s }
      s += c
      i++
    }
    return { truncated: true } // 没闭合 = 被截断，不救
  }

  if (ch === '{' || ch === '[') {
    const end = balancedEnd(raw, i)
    if (end < 0) return { truncated: true }
    return { value: parseLoose(raw.slice(i, end + 1)) }
  }

  const lit = /^(-?\d+(?:\.\d+)?|true|false|null|True|False|None)/.exec(raw.slice(i))
  if (!lit) return {}
  const t = lit[1]
  if (/^-?\d/.test(t)) return { value: Number(t) }
  const low = t.toLowerCase()
  return { value: low === 'true' ? true : low === 'false' ? false : null }
}

function salvage(
  raw: string,
  schema?: ArgSchema
): { args: Record<string, unknown>; truncated: string[] } | null {
  const props = shapeOf(schema).properties
  if (!props) return null
  const args: Record<string, unknown> = {}
  const truncated: string[] = []
  for (const k of Object.keys(props)) {
    const r = readField(raw, k)
    if (r.value !== undefined) args[k] = r.value
    else if (r.truncated) truncated.push(k)
  }
  if (!Object.keys(args).length && !truncated.length) return null
  return { args, truncated }
}

/** 把 JSON.parse 的报错翻译成「第几个字符附近坏了」——模型据此能直接重发 */
function explainFailure(raw: string): string {
  const t = raw.trim()
  let detail = '不是合法 JSON'
  try {
    JSON.parse(t)
  } catch (e) {
    const msg = (e as Error).message
    const at = /position (\d+)/i.exec(msg)
    if (at) {
      const n = Number(at[1])
      const head = t.slice(Math.max(0, n - 40), n)
      const bad = t.slice(n, n + 20)
      detail = `不是合法 JSON：第 ${n} 个字符附近有问题（…${head}【${bad}】…）`
    } else {
      detail = `不是合法 JSON（${msg}）`
    }
  }
  if (!t) return '是空的'
  return detail
}

function missingOf(args: Record<string, unknown>, schema?: ArgSchema): string[] {
  return (shapeOf(schema).required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === '')
}

function finish(
  args: Record<string, unknown>,
  repair: ArgRepair,
  schema?: ArgSchema,
  truncated?: string[]
): ParsedArgs {
  const coerced = coerce(args, schema)
  const missing = missingOf(coerced, schema)
  return {
    args: coerced,
    repair,
    missing,
    ...(truncated?.length ? { truncated } : {}),
    usable: missing.length === 0
  }
}

/**
 * 解析一次工具调用的参数。
 *
 * 传对象时（Ollama 的原生 arguments、或者上一轮已经解好的）只做 schema 层强转。
 */
export function parseArgs(
  input: string | Record<string, unknown> | null | undefined,
  schema?: ArgSchema,
  depth = 0
): ParsedArgs {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return finish(unwrapAlias(input as Record<string, unknown>, schema), 'none', schema)
  }

  const raw = typeof input === 'string' ? input : ''
  const trimmed = raw.trim()
  if (!trimmed) return finish({}, 'none', schema)

  // 最常见的一条路：原样合法，也顺带给大文件写入留了零开销
  const strict = tryStrict(trimmed)
  if (strict && typeof strict === 'object' && !Array.isArray(strict)) {
    return finish(unwrapAlias(strict as Record<string, unknown>, schema), 'none', schema)
  }

  /**
   * 二次编码：模型把整个参数对象又 stringify 了一遍，解出来还是个字符串。
   * 只往下钻一层 —— 再深就是模型在绕圈子，救回来也没意义。
   */
  if (typeof strict === 'string' && depth < 2) {
    const again = strict.trim()
    if (again && again !== trimmed) {
      const inner = parseArgs(again, schema, depth + 1)
      if (inner.repair !== 'failed') return { ...inner, repair: inner.repair === 'none' ? 'syntax' : inner.repair }
    }
  }

  const value = parseLoose(trimmed)
  const inner = stripWrapping(trimmed)
  const repair: ArgRepair = inner && inner !== trimmed ? 'unwrapped' : 'syntax'

  if (value && typeof value === 'object') {
    // `[{...}]` 这种多包一层的写法：单元素数组直接取第一个
    const obj = Array.isArray(value)
      ? value.length === 1 && value[0] && typeof value[0] === 'object' && !Array.isArray(value[0])
        ? (value[0] as Record<string, unknown>)
        : null
      : (value as Record<string, unknown>)
    if (obj) return finish(unwrapAlias(obj, schema), repair, schema)
  }

  // 整体解不出来：按字段名抢救。但只在 schema 认识这些字段时才有意义
  const saved = salvage(trimmed, schema)
  if (saved) return finish(unwrapAlias(saved.args, schema), 'salvaged', schema, saved.truncated)

  return {
    args: {},
    repair: 'failed',
    error: explainFailure(trimmed),
    missing: (shapeOf(schema).required ?? []).slice(),
    usable: false
  }
}

/** 给模型看的说明。写短，模型才会读 */
const REPAIR_LABEL: Record<Exclude<ArgRepair, 'none' | 'failed'>, string> = {
  unwrapped: '参数外面多包了一层（代码块或说明文字），已把 JSON 取出来',
  syntax: '参数的 JSON 有语法问题（尾逗号 / 单引号 / 键没加引号 / 换行没转义这几类），已自动修正',
  salvaged: '参数不是完整合法的 JSON，只按字段名恢复了其中一部分，字段可能不全'
}

export interface SettledArgs {
  args: Record<string, unknown>
  /** 参数坏到不能执行：这是要回给模型的话 */
  blocked?: string
  /** 参数被修过：附在工具结果前面的说明 */
  note?: string
}

function blockedNote(p: ParsedArgs): string {
  /**
   * 截断单独说：模型看到「缺少 content」会以为是自己漏写了，
   * 于是补一句 `"content": ""` 再发一遍 —— 那才是真的把文件清空了。
   */
  if (p.truncated?.length) {
    const names = p.truncated.map((t) => `「${t}」`).join('、')
    return [
      `这次工具调用没有执行：参数里的 ${names} 写到一半被截断了（字符串没有闭合），内容不完整。`,
      '写文件这类操作不能用不完整的内容：请重新完整输出一次。',
      '内容太长（比如整个文件）就分成几次写：先写一个骨架，再用 edit_file 分段补。'
    ].join('\n')
  }
  if (p.repair === 'failed') {
    return [
      `这次工具调用没有执行：参数${p.error}。`,
      '请重新输出一个 JSON 对象作为参数：不要包代码块、不要加解释文字、键名和字符串都用双引号、不要留尾逗号。',
      '参数很长时（比如整个文件内容）宁可分几次写，也不要一次写完被截断。'
    ].join('\n')
  }
  if (p.missing.length) {
    return `这次工具调用没有执行：缺少必填参数 ${p.missing.map((m) => `「${m}」`).join('、')}。请补上后再调用。`
  }
  return '这次工具调用没有执行：参数不完整，请重新输出一次。'
}

/**
 * 执行前的最后一道：按工具 schema 定位问题，决定「能不能跑」和「要不要提醒模型」。
 *
 * 坏参数不执行，也**不弹审批框** —— 用户看到一个路径是空的删除确认，只会更困惑。
 */
export function settleToolArgs(
  call: Pick<ToolCall, 'args' | 'argRepair'>,
  schema?: ArgSchema
): SettledArgs {
  const args = call.args ?? {}
  const keys = Object.keys(args)
  const raw = keys.length === 1 && keys[0] === RAW_ARG_KEY && typeof args[RAW_ARG_KEY] === 'string'
    ? (args[RAW_ARG_KEY] as string)
    : null

  // provider 没解出来，原始文本还在：带 schema 再试一遍（这次能认字段别名）
  if (raw !== null) {
    const parsed = parseArgs(raw, schema)
    if (!parsed.usable) return { args: parsed.args, blocked: blockedNote(parsed) }
    return {
      args: parsed.args,
      note: parsed.repair === 'none' ? undefined : `[参数容错] ${REPAIR_LABEL[parsed.repair as keyof typeof REPAIR_LABEL]}。`
    }
  }

  const coerced = coerce(args, schema)
  const missing = missingOf(coerced, schema)
  if (missing.length) return { args: coerced, blocked: blockedNote({ ...finish(coerced, 'none', schema), missing }) }

  const repair = call.argRepair
  const note =
    repair && repair !== 'none' && repair !== 'failed' && REPAIR_LABEL[repair]
      ? `[参数容错] ${REPAIR_LABEL[repair]}。`
      : undefined
  return { args: coerced, note }
}
