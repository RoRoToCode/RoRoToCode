/**
 * GGUF 元数据解析。纯逻辑，不碰文件系统、不碰网络。
 *
 * 调用方只需要提供一个「随机读取器」，形状和 Node 的 FileHandle 一致：
 *   fh.read(buffer, offset, length, position) -> { bytesRead }
 *
 * Node 传 fs 的 FileHandle，浏览器传 fetch+Range 的适配器或 File.slice 的适配器，
 * 解析代码一个字都不用改。
 *
 * 全程用 Uint8Array + DataView，不用 Buffer —— Buffer 在浏览器里不存在，
 * 而这个模块要同时跑在 Node 和网页上。
 */

export const MAGIC = 0x46554747 // "GGUF" 小端

export const T = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5,
  FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12
}

export const FIXED_SIZE = {
  [T.UINT8]: 1, [T.INT8]: 1, [T.UINT16]: 2, [T.INT16]: 2,
  [T.UINT32]: 4, [T.INT32]: 4, [T.FLOAT32]: 4, [T.BOOL]: 1,
  [T.UINT64]: 8, [T.INT64]: 8, [T.FLOAT64]: 8
}

/** general.file_type → 量化名（llama.cpp 的 llama_ftype 枚举） */
export const FILE_TYPE = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1',
  10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L',
  14: 'Q4_K_S', 15: 'Q4_K_M', 16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K',
  19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'Q2_K_S', 22: 'IQ3_XS', 23: 'IQ3_XXS',
  24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M', 28: 'IQ2_S',
  29: 'IQ2_M', 30: 'IQ4_XS', 31: 'IQ1_M', 32: 'BF16',
  36: 'TQ1_0', 37: 'TQ2_0'
}

/** 带小窗口缓存的顺序读取器：跳大块数据时只挪指针，不读盘 */
export class Cursor {
  #buf = new Uint8Array(0)
  #view = new DataView(new ArrayBuffer(0))
  #base = 0
  #dec = new TextDecoder()
  pos = 0

  constructor(fh, size, blockSize = 128 * 1024) {
    this.fh = fh
    this.size = size
    // 远程读取每次都要发请求，块太小会拖慢；本地维持 128KB
    this.blockSize = blockSize
  }

  async #ensure(n) {
    const rel = this.pos - this.#base
    if (rel >= 0 && rel + n <= this.#buf.length) return
    if (this.pos + n > this.size) throw new Error('文件被截断')

    let lastErr = null
    // 慢镜像上整段请求会超时。与其原地重试同一个大块，不如把步子迈小一半：
    // 1 MB 拿不到就试 512 KB，再不行 256 KB。快的时候完全走不到这里。
    for (let attempt = 0; attempt < 4; attempt++) {
      const len = Math.min(Math.max(n, this.blockSize), this.size - this.pos)
      const b = new Uint8Array(len)
      try {
        const { bytesRead } = await this.fh.read(b, 0, len, this.pos)
        if (bytesRead < n) throw new Error('文件被截断')
        this.#buf = b.subarray(0, bytesRead)
        this.#view = new DataView(b.buffer, b.byteOffset, bytesRead)
        this.#base = this.pos
        return
      } catch (e) {
        lastErr = e
        // 限流 / 404 / 地址不是文件：换块大小也没用
        if (/限流|HTTP 40|不是文件直链/.test(e.message)) throw e
        if (this.blockSize <= 256 * 1024) throw e
        this.blockSize = Math.floor(this.blockSize / 2)
      }
    }
    throw lastErr
  }

  async u32() {
    await this.#ensure(4)
    const v = this.#view.getUint32(this.pos - this.#base, true)
    this.pos += 4
    return v
  }

  async u64() {
    await this.#ensure(8)
    const v = Number(this.#view.getBigUint64(this.pos - this.#base, true))
    this.pos += 8
    if (!Number.isSafeInteger(v) || v < 0) throw new Error('长度字段异常')
    return v
  }

  /** 读定长数值；返回 number */
  async num(type) {
    const size = FIXED_SIZE[type]
    if (size === undefined) throw new Error(`不认识的类型 ${type}`)
    await this.#ensure(size)
    const o = this.pos - this.#base
    const v = this.#view
    let out
    switch (type) {
      case T.UINT8: out = v.getUint8(o); break
      case T.INT8: out = v.getInt8(o); break
      case T.UINT16: out = v.getUint16(o, true); break
      case T.INT16: out = v.getInt16(o, true); break
      case T.UINT32: out = v.getUint32(o, true); break
      case T.INT32: out = v.getInt32(o, true); break
      case T.FLOAT32: out = v.getFloat32(o, true); break
      case T.BOOL: out = v.getUint8(o) !== 0 ? 1 : 0; break
      case T.UINT64: out = Number(v.getBigUint64(o, true)); break
      case T.INT64: out = Number(v.getBigInt64(o, true)); break
      case T.FLOAT64: out = v.getFloat64(o, true); break
    }
    this.pos += size
    return out
  }

  skip(n) {
    if (n < 0 || this.pos + n > this.size) throw new Error('文件被截断')
    this.pos += n
  }

  async str(max = 512) {
    const len = await this.u64()
    if (len === 0) return ''
    if (len > max) {
      if (this.pos + len > this.size) throw new Error('文件被截断')
      this.skip(len)
      return null
    }
    await this.#ensure(len)
    const at = this.pos - this.#base
    const s = this.#dec.decode(this.#buf.subarray(at, at + len))
    this.skip(len)
    return s
  }

  /** 跳过任意值。字符串数组只做指针运算，不读内容（词表常有十几万条） */
  async skipValue(type) {
    if (type === T.STRING) {
      this.skip(await this.u64())
      return
    }
    if (type === T.ARRAY) {
      const elem = await this.u32()
      const count = await this.u64()
      if (count > 20_000_000) throw new Error('元数据数组过大，疑似损坏')
      if (elem === T.STRING) {
        for (let i = 0; i < count; i++) this.skip(await this.u64())
        return
      }
      const sz = FIXED_SIZE[elem]
      if (!sz) throw new Error(`不认识的数组元素类型 ${elem}`)
      this.skip(sz * count)
      return
    }
    const sz = FIXED_SIZE[type]
    if (!sz) throw new Error(`不认识的数据类型 ${type}`)
    this.skip(sz)
  }

  /** 读字符串数组的第一个元素（有些模型的 chat_template 存成数组） */
  async firstStringOfArray() {
    const elem = await this.u32()
    const count = await this.u64()
    if (elem !== T.STRING || count === 0 || count > 64) {
      // 不是字符串数组，整体跳过
      this.pos -= 12
      await this.skipValue(T.ARRAY)
      return null
    }
    const first = await this.str(4 * 1024 * 1024)
    for (let i = 1; i < count; i++) this.skip(await this.u64())
    return first
  }

  /**
   * 读数值数组的逐个元素（只给 `head_count_kv` 这类逐层数组用，长度 = 层数）。
   *
   * 只取第一个元素是不够的：LFM2/LFM3 这类「卷积层 + 注意力层」交替的混合架构，
   * 卷积层的 head_count_kv 写的是 0，首层正好是卷积层 —— 取第一个就把整个模型
   * 判成「没有 KV 头、算不出来」，而实际上有一半层带 KV。
   */
  async numArray(limit = 4096) {
    const elem = await this.u32()
    const count = await this.u64()
    const sz = FIXED_SIZE[elem]
    if (sz === undefined || count === 0 || count > limit) {
      this.pos -= 12
      await this.skipValue(T.ARRAY)
      return null
    }
    const out = []
    for (let i = 0; i < count; i++) out.push(await this.num(elem))
    return out
  }
}

/**
 * 从读取器解析出元数据。失败抛错，由调用方给出可读提示。
 *
 * @param fh    { read(buf, off, len, pos) -> { bytesRead } }
 * @param size  文件总字节数
 * @param label 显示用的文件名 / URL，只用于报告
 */
export async function parseGguf(fh, size, label = '') {
  const isRemote = /^https?:\/\//i.test(label)
  // 远程每次都要发请求，块太小会拖慢；但慢镜像上大块很容易整段超时。
  // 1 MB 是折中：正常网络下二十来段、十几秒读完；被限速时也不至于一段都拿不到。
  // Cursor 还会在超时后自动把块减半重试，所以这里只是起点。
  const c = new Cursor(fh, size, isRemote ? 1024 * 1024 : 128 * 1024)

  if ((await c.u32()) !== MAGIC) throw new Error('不是 GGUF 文件（magic 不匹配）')
  const version = await c.u32()
  if (version < 2 || version > 3) throw new Error(`不支持的 GGUF 版本 v${version}`)
  const tensorCount = await c.u64()
  const kvCount = await c.u64()
  if (kvCount > 200_000) throw new Error('元数据条数异常，疑似文件损坏')

  const kv = new Map()          // key → string | number
  const extraTemplates = new Map()

  for (let i = 0; i < kvCount; i++) {
    const key = await c.str(512)
    const type = await c.u32()

    if (!key) {
      await c.skipValue(type)
      continue
    }

    // 数组：只读 chat_template 和逐层 KV head 数，其余（词表等）一律跳过
    if (type === T.ARRAY) {
      if (key === 'tokenizer.chat_template' && !kv.has(key)) {
        const v = await c.firstStringOfArray()
        if (v) kv.set(key, v.replace(/\u0000+$/g, ''))
      } else if (/\.attention\.head_count_kv$/.test(key)) {
        // 逐层数组：留存整条，后面取「最大值」当 KV 头数、「非零个数」当真正带 KV 的层数
        const v = await c.numArray()
        if (v !== null) kv.set(key, v)
      } else {
        await c.skipValue(type)
      }
      continue
    }

    if (type === T.STRING) {
      const interesting =
        key === 'general.architecture' || key === 'general.name' ||
        key === 'general.basename' || key === 'general.size_label' ||
        key === 'tokenizer.chat_template' || key.startsWith('tokenizer.chat_template.')
      const val = await c.str(interesting ? 4 * 1024 * 1024 : 512)
      if (val === null) continue
      if (interesting) {
        const clean = val.replace(/\u0000+$/g, '')
        if (key.startsWith('tokenizer.chat_template.')) extraTemplates.set(key.slice(24), clean)
        else kv.set(key, clean)
      }
      continue
    }

    // 数值类型都很小，全部收下（后面按 arch 前缀取用）
    if (FIXED_SIZE[type] !== undefined) {
      kv.set(key, await c.num(type))
      continue
    }

    await c.skipValue(type)
  }

  const arch = kv.get('general.architecture') ?? ''
  const pick = (suffix) => {
    const v = kv.get(`${arch}.${suffix}`)
    return typeof v === 'number' ? v : undefined
  }

  // head_count_kv 可能是逐层数组（Llama3/Qwen2 每层 GQA 比例不同，
  // LFM2/3 这种「卷积层 + 注意力层」交替的架构则有一半写成 0）。
  // 头数取数组最大值，同时记下「非零层数」—— 那才是真正要分配 KV cache 的层数。
  // 只看第一个元素会把混合架构判成没有 KV 头，整份报告退化成「算不出来」。
  const headCount = pick('attention.head_count')
  const kvRaw = kv.get(`${arch}.attention.head_count_kv`)
  const kvArr = Array.isArray(kvRaw) ? kvRaw.filter((x) => typeof x === 'number') : null
  const headKv = kvArr && kvArr.length
    ? Math.max(...kvArr)
    : (typeof kvRaw === 'number' ? kvRaw : headCount)
  // 数组里出现 0，说明确实有层不带 KV（卷积 / 线性注意力）；全是 0 就当没给
  const kvLayerCount = kvArr && kvArr.length && headKv > 0
    ? kvArr.filter((x) => x > 0).length
    : undefined
  const embd = pick('embedding_length')
  // 视觉投影件（mmproj）：arch 是 clip，带 has_vision_encoder，没有 block_count。
  // 它不能单独加载，只能作为主模型的附加件 —— 当成普通模型体检会给出荒谬结论
  // （0.16 GB 的文件被报成 12B 参数、128K 上下文装得下）。
  const isVision = arch === 'clip' || Boolean(kv.get('clip.has_vision_encoder'))
  // 推测解码草稿件（MTP / assistant）：arch 带 -assistant 后缀，或所有层都是 MTP 层。
  // 同理不能单独跑，必须和主模型一起用（llama.cpp 的 -md）。
  const isAssistant = /-assistant$/i.test(arch) ||
    (typeof pick('nextn_predict_layers') === 'number' &&
      pick('nextn_predict_layers') === pick('block_count'))

  // 混合线性注意力（Mamba / Gated DeltaNet）的判据。
  // 光看 full_attention_interval 不够：Qwen3-Next 这类模型的 GGUF 里根本没有这个键，
  // 只留下 ssm.* 一组参数。少这个判断就会把 48 层全按带 KV 算，KV 高估 4 倍。
  const ssmStateSize = pick('ssm.state_size')
  const ssmInnerSize = pick('ssm.inner_size')
  const ssmConvKernel = pick('ssm.conv_kernel')
  const hasLinearLayers = ssmStateSize !== undefined || ssmInnerSize !== undefined || ssmConvKernel !== undefined

  return {
    file: label,
    sizeBytes: size,
    version,
    tensorCount,
    kvCount,
    arch: arch || undefined,
    name: (kv.get('general.name') ?? kv.get('general.basename')) || undefined,
    sizeLabel: kv.get('general.size_label') || undefined,
    chatTemplate: kv.get('tokenizer.chat_template') || [...extraTemplates.values()][0] || undefined,
    templateVariants: [...extraTemplates.keys()],
    paramCount: typeof kv.get('general.parameter_count') === 'number' ? kv.get('general.parameter_count') : undefined,
    blockCount: pick('block_count'),
    headCount,
    headKv,
    // 真正带 KV cache 的层数（逐层 head_count_kv 里的非零个数）；与 blockCount 相等时不返回
    kvLayerCount: kvLayerCount !== undefined && kvLayerCount !== pick('block_count') ? kvLayerCount : undefined,
    // 附加件（不是独立模型）：视觉投影件 / 推测解码草稿
    isVision,
    isAssistant,
    embdLength: embd,
    contextLength: pick('context_length') ?? pick('context_length_train'),
    keyLength: pick('attention.key_length'),
    valueLength: pick('attention.value_length'),
    // 滑窗层用另一套更小的 head_dim（Gemma 系列）
    keyLengthSwa: pick('attention.key_length_swa'),
    valueLengthSwa: pick('attention.value_length_swa'),
    slidingWindow: pick('attention.sliding_window'),
    // 混合架构（Mamba/SSM + Attention，如 Qwen3-Next / qwen35）：
    // 每 N 层只有 1 层是 full attention，其余是线性注意力，KV 不随上下文增长。
    // 不识别这个字段会把 KV cache 高估数倍。
    fullAttentionInterval: pick('full_attention_interval'),
    // MLA（Multi-head Latent Attention，DeepSeek V2/V3/R1 系列）：
    // KV 不按注意力头逐个缓存完整 K/V，而是先压成一个低秩潜向量再存，
    // 显存只随 kv_lora_rank 增长，与 head 数无关。
    // llama.cpp 的 is_mla() 要求下面两个 *_mla 键同时存在；缺任一个就仍走普通 GQA 路径
    // （早期的 deepseek2 转换就是 16 个 KV 头、192/128 长度、没有 *_mla 键）。
    keyLengthMla: pick('attention.key_length_mla'),
    valueLengthMla: pick('attention.value_length_mla'),
    kvLoraRank: pick('attention.kv_lora_rank'),
    // 参与 RoPE 的那部分维度（DeepSeek 是 64），潜向量 + 它是每 token 的 K 行宽
    ropeDimCount: pick('rope.dimension_count'),
    qLoraRank: pick('attention.q_lora_rank'),
    // MTP / 多 token 预测层，llama.cpp 会忽略，不算进推理层数
    nextnLayers: pick('nextn_predict_layers'),
    ssmStateSize,
    ssmInnerSize,
    hasLinearLayers,
    // MoE：实际只激活部分专家，速度估算按整体体积算会偏保守
    expertCount: pick('expert_count'),
    expertUsedCount: pick('expert_used_count'),
    feedForwardLength: pick('feed_forward_length'),
    fileType: typeof kv.get('general.file_type') === 'number' ? kv.get('general.file_type') : undefined
  }
}
