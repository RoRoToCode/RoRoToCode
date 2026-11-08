import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

/**
 * 极简 GGUF 头解析：只取三个字符串型元数据。
 *
 * 用途：把本程序下载的 GGUF 导入 Ollama 时，Modelfile 需要 `TEMPLATE`，
 * 否则模型没有对话模板，一问一答会变成「接着往下写」。
 * GGUF 里本来就带着 `tokenizer.chat_template`，直接读出来即可，不用让用户手抄。
 *
 * 只解析元数据区（tensor 数据在后面，一律跳过），并且按需读盘，
 * 不会把几 GB 的模型读进内存。
 */

const MAGIC = 0x46554747 // "GGUF" 小端

/** 元数据类型（GGUF v2/v3） */
const enum VType {
  Uint8 = 0,
  Int8 = 1,
  Uint16 = 2,
  Int16 = 3,
  Uint32 = 4,
  Int32 = 5,
  Float32 = 6,
  Bool = 7,
  String = 8,
  Array = 9,
  Uint64 = 10,
  Int64 = 11,
  Float64 = 12
}

const FIXED_SIZE: Record<number, number> = {
  [VType.Uint8]: 1,
  [VType.Int8]: 1,
  [VType.Uint16]: 2,
  [VType.Int16]: 2,
  [VType.Uint32]: 4,
  [VType.Int32]: 4,
  [VType.Float32]: 4,
  [VType.Bool]: 1,
  [VType.Uint64]: 8,
  [VType.Int64]: 8,
  [VType.Float64]: 8
}

/** 带小窗口缓存的顺序读取器：跳大块数据时只挪偏移，不读盘 */
class Cursor {
  private buf = Buffer.alloc(0)
  private base = 0
  pos = 0

  constructor(
    private readonly fh: FileHandle,
    readonly size: number
  ) {}

  private async ensure(n: number): Promise<void> {
    const rel = this.pos - this.base
    if (rel >= 0 && rel + n <= this.buf.length) return
    if (this.pos + n > this.size) throw new Error('文件被截断')
    const len = Math.min(Math.max(n, 128 * 1024), this.size - this.pos)
    const b = Buffer.allocUnsafe(len)
    const { bytesRead } = await this.fh.read(b, 0, len, this.pos)
    if (bytesRead < n) throw new Error('文件被截断')
    this.buf = b.subarray(0, bytesRead)
    this.base = this.pos
  }

  async u32(): Promise<number> {
    await this.ensure(4)
    const v = this.buf.readUInt32LE(this.pos - this.base)
    this.pos += 4
    return v
  }

  async u64(): Promise<number> {
    await this.ensure(8)
    const v = Number(this.buf.readBigUInt64LE(this.pos - this.base))
    this.pos += 8
    if (!Number.isSafeInteger(v) || v < 0) throw new Error('长度字段异常')
    return v
  }

  /** 只挪指针；真正读之前会自然落到别处，不浪费 IO */
  skip(n: number): void {
    if (n < 0 || this.pos + n > this.size) throw new Error('文件被截断')
    this.pos += n
  }

  /** 读字符串；超过 max 或越界时返回 null（并跳过内容） */
  async str(max: number): Promise<string | null> {
    const len = await this.u64()
    if (len === 0) return ''
    if (len > max || this.pos + len > this.size) {
      if (this.pos + len > this.size) throw new Error('文件被截断')
      this.skip(len)
      return null
    }
    await this.ensure(len)
    const s = this.buf.toString('utf8', this.pos - this.base, this.pos - this.base + len)
    this.skip(len)
    return s
  }

  /** 跳过任意类型的值 */
  async skipValue(type: number): Promise<void> {
    if (type === VType.String) {
      const len = await this.u64()
      this.skip(len)
      return
    }
    if (type === VType.Array) {
      const elem = await this.u32()
      const count = await this.u64()
      if (count > 5_000_000) throw new Error('元数据数组过大，疑似文件损坏')
      if (elem === VType.String) {
        // 词表、merge 列表都走这里：逐个跳过，只做指针运算
        for (let i = 0; i < count; i++) {
          const len = await this.u64()
          this.skip(len)
        }
        return
      }
      const sz = FIXED_SIZE[elem]
      if (!sz) throw new Error(`不认识的数组元素类型 ${elem}`)
      this.skip(sz * count)
      return
    }
    const sz = FIXED_SIZE[type]
    if (!sz) throw new Error(`不认识的元数据类型 ${type}`)
    this.skip(sz)
  }
}

export interface GgufMeta {
  /** 架构名，如 llama / qwen2 / gemma3 / clip */
  architecture?: string
  /** general.type：主模型是 model，多模态投影器是 mmproj */
  type?: string
  /** tokenizer.chat_template，可直接写进 Ollama Modelfile */
  chatTemplate?: string
  /** general.name，模型作者给的展示名 */
  name?: string
  /** 参数规模（十亿），解析不出来就是 undefined */
  paramsB?: number
}

/** 只读元数据区，出错一律返回空对象（导入时按「没有模板」处理，不阻断流程） */
export async function readGgufMeta(file: string): Promise<GgufMeta> {
  let fh: FileHandle | null = null
  try {
    fh = await fs.open(file, 'r')
    const size = (await fh.stat()).size
    const c = new Cursor(fh, size)

    if ((await c.u32()) !== MAGIC) return {}
    const version = await c.u32()
    if (version < 2 || version > 3) return {}
    await c.u64() // tensor_count
    const kvCount = await c.u64()
    if (kvCount > 100_000) return {}

    const out: GgufMeta = {}
    let paramCount: number | undefined

    for (let i = 0; i < kvCount; i++) {
      const key = await c.str(512)
      const type = await c.u32()
      if (!key || type !== VType.String) {
        await c.skipValue(type)
        continue
      }
      // 只关心这几个键，其余字符串直接跳过（不读内容）
      if (
        key === 'general.architecture' ||
        key === 'general.type' ||
        key === 'tokenizer.chat_template' ||
        key === 'general.name'
      ) {
        const val = await c.str(4 * 1024 * 1024)
        if (val) {
          if (key === 'general.architecture') out.architecture = val.trim()
          else if (key === 'general.type') out.type = val.trim()
          else if (key === 'general.name') out.name = val.trim()
          else out.chatTemplate = val.replace(/\u0000+$/g, '')
        }
      } else {
        await c.skipValue(type)
      }
      if (out.architecture && out.chatTemplate && out.name && paramCount !== undefined) break
    }

    // 参数规模只在名字里带 7B / 1.5B 这类标记时才认，免得瞎猜
    const guess = /(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/.exec(out.name ?? file)
    if (guess) {
      const n = Number(guess[1])
      if (n > 0 && n < 1000) paramCount = n
    }
    if (paramCount !== undefined) out.paramsB = paramCount
    return out
  } catch {
    return {}
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

/** 把 chat template 包成 Modelfile 的 TEMPLATE 块；含三引号时宁可不写，也不生成坏文件 */
export function modelfileTemplate(tpl?: string): string | null {
  if (!tpl) return null
  const body = tpl.trim()
  if (!body || body.includes('"""')) return null
  return `TEMPLATE """${body}"""`
}
