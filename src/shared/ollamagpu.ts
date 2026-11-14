/**
 * 从 Ollama 服务日志里解析出「这次加载落在哪张显卡上」。
 *
 * 为什么要读日志：Ollama 的 HTTP 接口只报字节数（`/api/ps` 里的 `size_vram`），
 * 不带显卡型号；而它的日志每次加载都会打印真实设备，两种都能拿到：
 *
 *   llama_prepare_model_devices: using device CUDA0 (NVIDIA GeForce RTX 2080) (0000:01:00.0) - 7113 MiB free
 *   time=… level=INFO msg="inference compute" id=0 … name=CUDA0 description="NVIDIA GeForce RTX 2080" …
 *
 * 所以这里只做纯文本解析（不碰文件、不联网），给界面一个「跑在哪张卡」的答案。
 * 解析不到时返回空数组，由调用方决定是兜底推断还是干脆不显示 —— 不在这里猜。
 */

/**
 * 一次加载开始的标志：看到这些行就说明「上一块设备清单到此为止」。
 *
 * 注意别把 `llama runner started` 算进来 —— 那是加载**结束**的日志，
 * 当成开始会多切出一个空块，结果是明明跑在显卡上却报「没读到卡」。
 * `ggml_cpu_init` 算进来是有意的：纯 CPU 加载也是一个新块，且块里没有显卡。
 */
const LOAD_START =
  /(?:ggml_cuda_init: found|ggml_vulkan: [Ff]ound|ggml_sycl: found|ggml_cpu_init|llama_model_loader: loaded meta data)/

/** 新版本 llama.cpp 一定会打的「用哪张卡」行 */
const USING_DEVICE = /llama_prepare_model_devices:\s*using device\s+(\S+)\s*(?:\(([^)]*)\))?/

/** 老版本 / 只打设备发现时：inference compute 行里的 description 才是完整型号 */
const COMPUTE = /msg="inference compute".*?description="([^"]+)"/

/**
 * 取日志尾部里**最后一次加载**用到的显卡名（多卡时按顺序多个）。
 *
 * 只看最后一块：一个进程里换模型会重复打印，用户想看的是「现在这个模型在哪张卡」；
 * 最后一块是纯 CPU 加载时返回空数组，而不是把上一轮的卡名当成现在的。
 */
export function parseOllamaLogDevices(text: string): string[] {
  if (!text) return []
  const blocks: string[][] = []
  let cur: string[] = []
  let ids = new Set<string>()
  let started = false

  const startBlock = (): void => {
    if (started) blocks.push(cur)
    cur = []
    ids = new Set()
    started = true
  }
  /** 按设备号去重：同一张卡在一次加载里会被打印多次（主模型 + 草稿模型），但两张一样的卡要算两张 */
  const push = (id: string, name: string): void => {
    const v = name.trim()
    if (!v || ids.has(id)) return
    ids.add(id)
    cur.push(v)
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line) continue

    if (LOAD_START.test(line)) startBlock()

    const use = USING_DEVICE.exec(line)
    if (use) {
      // `using device CPU` 也是一次加载：开个新块，别把上一轮的卡续到这里
      if (/^cpu$/i.test(use[1])) startBlock()
      else {
        if (!started) startBlock()
        if (use[2]) push(use[1].toUpperCase(), use[2])
      }
      continue
    }

    const c = COMPUTE.exec(line)
    if (c) {
      if (!started) startBlock()
      // 这条路没有可靠设备号，按型号去重
      push(c[1].trim(), c[1])
    }
  }

  if (!started) return []
  blocks.push(cur)
  return blocks[blocks.length - 1] ?? []
}

/**
 * 显卡名去掉厂商前缀：顶栏的小胶囊放不下 "NVIDIA GeForce RTX 2080"。
 * 和 llama.cpp 那边的口径保持一致（同样去掉 NVIDIA / GeForce），
 * 同一个模型在哪条链路上跑，看到的标签都长一样。
 */
export function shortGpuName(name: string): string {
  return name
    .replace(/\(r\)|\(tm\)/gi, '')
    .replace(/^NVIDIA\s+(?:GeForce\s+)?/i, '')
    .replace(/^AMD\s+(?:Radeon\s+)?/i, '')
    .replace(/^Intel\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}
