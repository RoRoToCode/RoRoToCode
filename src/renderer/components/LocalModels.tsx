import { t as tr } from '../i18n'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type {
  LlamaProbeProgress,
  LlamaUpdateInfo,
  SetupProgress,
  SetupState,
  VramfitReport,
  VramfitResult
} from '../../shared/types'
import type { PartialOffloadMode as LayerMode } from '../../shared/ctxtune'
import { partialModeOf } from '../../shared/ctxtune'
import { deviceIndex, deviceList, isMultiDevice } from '../../shared/providers'
import { Chevron, useCollapse } from './Collapse'
import { DownloadBar } from './DownloadBar'
import { LocalRuntime } from './LocalRuntime'

/** 还在进行的安装状态：切页面回来时据此决定要不要把进度条 / 按钮状态接上 */
const ACTIVE_SETUP: SetupState[] = ['preparing', 'downloading', 'extracting']

/**
 * 版本检查的节流窗口：一天一次就够。
 *
 * 以前是「打开面板查一次 + 每 30 分钟一次」，面板来回切几次就打几轮网络，
 * 而这检查要去 GitHub / 镜像站，被墙环境下每次都要试好几个地址。
 * llama.cpp 不是天天发版，缓存一天既省请求也不会漏掉真正的更新。
 */
const UPDATE_TTL_MS = 24 * 60 * 60 * 1000
const UPDATE_CACHE_KEY = 'roroto.llama.update'

/** 读缓存（24h 内直接用），过期或 force 才真的打网络 */
async function loadUpdateInfo(force = false): Promise<LlamaUpdateInfo | null> {
  if (!force) {
    try {
      const raw = localStorage.getItem(UPDATE_CACHE_KEY)
      if (raw) {
        const cached = JSON.parse(raw) as { at?: number; info?: LlamaUpdateInfo }
        if (cached?.at && cached.info && Date.now() - cached.at < UPDATE_TTL_MS) return cached.info
      }
    } catch {
      // 缓存坏了就当没有，重新查一次
    }
  }
  try {
    const info = await window.pico.llama.checkUpdate()
    try {
      localStorage.setItem(UPDATE_CACHE_KEY, JSON.stringify({ at: Date.now(), info }))
    } catch {
      // 存不进去只影响节流，不影响这次结果
    }
    return info
  } catch {
    return null
  }
}

export interface LocalModelsHandle {
  /** 顶部的「刷新」：重扫本地 .gguf，并顺带更新 Ollama / LM Studio 状态 */
  refresh: () => Promise<void>
  /** 当前扫到的模型数量（用于按钮提示） */
  count: () => number
}

/** 一个本地槽位：一条 llama.cpp 实例对应一张卡 */
type LlamaSlot = {
  id: string
  name: string
  device?: string
  model?: string
  /** 这条实例当前的角色：主（对话在用）/ 子（给子代理干活）/ 未指定 */
  role?: 'main' | 'worker'
  /** 落盘配置里的上下文档位：档位行按它高亮（这一页只改草稿，写盘走「保存到列表」） */
  contextWindow?: number
}

interface Props {
  /** 配置（草稿）里各本地供应商正在使用的模型，key 为供应商 id */
  currentModels?: Record<string, string>
  /** 在这里点选模型时回调，让「模型列表」里的选择跟着变 */
  onSelectModel?: (model: string, providerId?: string) => void
  onConfigChanged?: () => void | Promise<void>
  /**
   * 草稿里所有的 llama.cpp 实例（一卡一条）。
   *
   * 卡槽要回答的是「这张卡上是谁、用的哪个模型」，光看 currentModels 不够：
   * 那个只给了模型名，给不出「哪张卡被占、哪张还空着」。
   */
  llamaSlots?: LlamaSlot[]
  /**
   * 点一张卡 → 父组件找到（或新建）绑这张卡的实例，返回它的 id。
   *
   * 供应商的增删属于草稿，这个面板没有写权，所以只能回调上去做。
   * 返回 id 而不是 Promise：点卡的反馈必须是这一帧就切过去，
   * 等一下再切会让用户以为点空了。
   */
  onPickDevice?: (deviceId: string) => string | undefined
  /**
   * 切换「合并多卡」：把这条实例绑到多张卡上（一个模型摊开跑），或者拆回单卡。
   *
   * 会落到草稿并写盘 —— 主进程启动时读的是磁盘配置，只改内存里的草稿
   * 会出现「界面显示已合并，启动出来还是单卡」。
   */
  onToggleMultiGpu?: (providerId: string, on: boolean) => Promise<{ ok: boolean; message?: string }>
  /**
   * 「保存到列表」：把这份配置落盘，然后把视线交给「④ 模型列表」。
   *
   * 这一页是**配置**的地方：选卡、选模型、挑上下文档位，再落盘。
   * 启动与停止只在「④ 模型列表」里做 —— 这一页不再有任何启动/停止入口，
   * 避免一个模型被两处同时拉起（曾经因此并发起了两个 llama-server）。
   *
   * patch 是页面本地改过的字段（目前只有上下文档位），随这次落盘一起写进去。
   */
  onSaveToList?: (
    providerId: string,
    patch?: { contextWindow?: number }
  ) => Promise<void>
  /**
   * 档位草稿上抛：`ctx` 为 null 表示「跟随已落盘的值」（也就是没改）。
   *
   * 为什么需要：底部的「保存」和这里的「保存到列表」是同一个写盘动作的两个入口。
   * 档位只活在这一页的 state 里，父组件保存时拿不到 —— 于是「点档位 → 直接点保存」
   * 会把选的档悄悄丢掉。把待写盘的值交给父组件，两条保存路径行为才一致。
   */
  onCtxDraft?: (providerId: string, ctx: number | null) => void
}

/** 模型可能带目录，比较时只看文件名 */
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p
const sameModel = (a?: string, b?: string) =>
  !!a && !!b && baseName(a).toLowerCase() === baseName(b).toLowerCase()

/**
 * 这一页会做的动作：只有「装 / 写配置 / 扫模型」。
 *
 * 启动与停止**不在这一页** —— 它们只在「④ 模型列表」里做。
 * 一个模型只能有一个启动入口，才不会再出现两个入口同时拉起一个实例。
 */
type LlamaAction = 'install' | 'configure' | 'models' | 'merge'

/** llama.cpp 认的设备（`--list-devices` 的解析结果），id 形如 CUDA0 / Vulkan1 */
type LlamaDevice = { id: string; name: string; vramMiB?: number; freeMiB?: number }

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`
const kctx = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n))
/** 体检没出来时仍可手选的档位，和 vramfit 的 base 档保持一致 */
const FALLBACK_TIERS = [4096, 8192, 16384, 32768, 65536]
type TierRow = {
  ctx: number
  needBytes: number | null
  fits: boolean | null
  /** 超过模型训练窗口：llama.cpp 会把 n_ctx 裁回原生值，选它没有意义 */
  beyondNative?: boolean
  /** 装得下但贴着预算上限（need > 85%）：估算稍偏就是 OOM */
  tight?: boolean
}

/** 分层模式的中文短名：按钮上只放这两个字，说明放在旁边 */
function layerModeLabel(m: LayerMode): string {
  return m === 'auto' ? tr("自动") : m === 'on' ? tr("总是") : tr("关")
}

/**
 * 三档结论的界面说法。verdict 是 vramfit 的稳定标识，文案在这里翻译，
 * 所以同一份报告切语言时不用重新体检。
 */
function verdictOf(v: VramfitReport['verdict']): { tone: 'ok' | 'warn' | 'bad'; label: string } {
  if (v === 'agent-ready') return { tone: 'ok', label: tr("能当 coding agent 用") }
  if (v === 'runs-only') return { tone: 'warn', label: tr("能跑，但只能聊天") }
  if (v === 'not-recommended') return { tone: 'bad', label: tr("这台机器上跑不动") }
  return { tone: 'warn', label: tr("元数据不全，算不出来") }
}

/**
 * 「本地模型」页：llama.cpp 卡片 + Ollama + LM Studio。
 * 顶部「获取模型 / 刷新」在设置面板里，刷新通过 ref 调进来。
 */
export const LocalModels = forwardRef<LocalModelsHandle, Props>(function LocalModels(
  {
    currentModels,
    onSelectModel,
    onConfigChanged,
    llamaSlots = [],
    onPickDevice,
    onSaveToList,
    onCtxDraft,
    onToggleMultiGpu
  },
  ref
) {
  /**
   * 当前操作的是哪个本地实例 —— 也就是「哪张卡」。
   *
   * 一个实例只绑一张卡，所以「切换显卡」和「切换实例」是同一个动作。
   * 以前这里写死 'llamacpp'：多实例时永远只认第一条，第二张卡在界面上
   * 等于不存在 —— 能看到下拉里选了 CUDA1，点启动却还是启动第一条。
   */
  const [activeId, setActiveId] = useState(() =>
    llamaSlots.some((s) => s.id === 'llamacpp') ? 'llamacpp' : (llamaSlots[0]?.id ?? 'llamacpp')
  )
  /** 实际下发给主进程的实例 id：父组件没传槽位时退回老行为，别让整块面板失灵 */
  const activePid = activeId || llamaSlots[0]?.id || 'llamacpp'
  /** llama.cpp 当前实例用的模型（其余本地服务各自从 currentModels 取） */
  const currentModel = currentModels?.[activePid] ?? ''
  const [llamaOpen, toggleLlama] = useCollapse('llama-card', true)
  const [llamaBusy, setLlamaBusy] = useState<LlamaAction | null>(null)
  const [llamaMsg, setLlamaMsg] = useState('')
  /** 「保存到列表」进行中：按钮要立刻有反应，同时防连点写两次盘 */
  const [listBusy, setListBusy] = useState(false)
  /**
   * 页面上手选的上下文档位（还没落盘）。
   *
   * 这一页只做配置：点档位不再「按它重启服务」，只是把选择记在草稿里，
   * 跟着「保存到列表」一起写进 provider.contextWindow；启动在「④ 模型列表」。
   * null = 没手选，跟随落盘值（也就没改过）。
   */
  const [ctxPick, setCtxPick] = useState<number | null>(null)
  // 换了实例（换卡）就作废上一次的档位选择，否则会把 A 卡的档写到 B 卡上
  useEffect(() => {
    setCtxPick(null)
  }, [activePid])
  /**
   * 把待写盘的档位告诉父组件：底部「保存」也要能带上它。
   *
   * 放在 effect 里而不是各个 onClick 里 —— 换卡时上面那个 effect 会把 ctxPick 抹成
   * null，这一条跟着把「待写盘」也清掉，两条保存路径看到的是同一个值。
   */
  useEffect(() => {
    onCtxDraft?.(activePid, ctxPick)
  }, [activePid, ctxPick, onCtxDraft])
  /** 安装进度（下载中带速度，解压时切文案） */
  const [setup, setSetup] = useState<SetupProgress | null>(null)
  const [llamaModels, setLlamaModels] = useState<string[]>([])
  /** 模型列表默认只露 3 个，点「展开」才显示所有（模型多了整页铺开太长） */
  const [modelsExpanded, setModelsExpanded] = useState(false)
  /** 相对路径 → 字节数；主进程 stat 出来的，拿不到的文件不会出现在这里 */
  const [sizes, setSizes] = useState<Record<string, number>>({})
  /** 每个模型的看图状态（主进程扫描时算好的：有没有配套投影器） */
  const [vision, setVision] = useState<Record<string, 'ready' | 'missing' | 'text'>>({})
  const [llamaRunning, setLlamaRunning] = useState(false)
  /**
   * 运行中实例的实时显存占用（主进程 status 里带回，节流 3 秒）。
   *
   * 这是「用户感知断层」的那一环：点 64K 后变慢，以前只能靠「实测解码」一行字
   * 猜是显存挤爆了；现在直接给一个 used/total 条，一眼看出「还剩 200 MiB」。
   * 纯 CPU 实例 / Vulkan / 没装 nvidia-smi 时拿不到，返回 null，仪表不显示。
   */
  const [vram, setVram] = useState<{ usedMiB: number; totalMiB: number; at: number } | null>(null)
  /** 所有在跑的本地实例：双卡双模型时这里会是两条 */
  const [running, setRunning] = useState<
    Array<{ key: string; port: number; model: string; device: string; ctx?: number; partial?: boolean }>
  >([])
  /** 用户选中的模型（多个模型时必须由用户决定用哪个） */
  const [picked, setPicked] = useState('')
  /** 服务当前实际加载的模型 */
  const [runningModel, setRunningModel] = useState('')
  /**
   * 本机设备清单（显卡名 + 显存）。
   * 「运行中」光写一个 CUDA0 用户看不出是哪张卡，双卡机器上更看不出，
   * 所以这里问一次 llama.cpp 自己认的设备，把 id 翻成人话。
   */
  const [devices, setDevices] = useState<LlamaDevice[]>([])
  /**
   * 分层加载模式（auto / on / off）。
   *
   * 默认 `auto`：**按模型判** —— 这个模型装不下才逐层分担，装得下的普通模型
   * 完全不动。以前是一个全局布尔开关，界面上永远显示「开」，用户看不出
   * 「我这个 9B 到底会不会被拆层」；关掉又要去设置页翻，代价太大。
   *
   * 档位按钮的可用性必须和主进程用同一份判据：主进程是
   * `mode !== off && (fits === false 或 文件比预算大) && 有卡` 才降级。
   */
  const [layerMode, setLayerMode] = useState<LayerMode>('auto')
  const [backend, setBackend] = useState<{
    backend: string
    gpuReady: boolean
    installed: boolean
    note?: string
    missing?: string[]
  } | null>(null)
  /** vramfit 是否就位；缺失时整块体检入口不出现，不留一个点了没反应的按钮 */
  const [fitReady, setFitReady] = useState(false)
  const [fit, setFit] = useState<VramfitResult | null>(null)
  const [fitBusy, setFitBusy] = useState(false)
  /**
   * 上一次探测器留下的实测结论（上下文 / 占用 / 解码速度）。
   *
   * 体检那栏给的是带宽公式算的理论上限，同一台机器实测往往差一截：
   * 9B Q4 在 3050 上公式给 33，实测单请求 13。两个数并排放，用户才知道
   * 「推荐 64K」值不值得点。
   */
  const [realProbe, setRealProbe] = useState<{
    model: string
    ctx: number
    footMiB: number
    tokPerSec?: number
  } | null>(null)

  /**
   * 自动校准上下文的进度。
   *
   * 首次启动 / 换模型 / 换硬件时会真的起停几次来确认档位，最长约 40 秒。
   * 没有这条进度，界面会一直停在「模型加载中」，看起来像卡死。
   */
  const [probe, setProbe] = useState<LlamaProbeProgress | null>(null)

  /** 只认最后一次体检的结果：连点不同模型时，慢的那个不许覆盖新的 */
  const fitSeq = useRef(0)
  /** llama.cpp 更新检查结果：有新版时安装按钮变「可更新」 */
  const [update, setUpdate] = useState<LlamaUpdateInfo | null>(null)

  // 面板关闭后不要再往已卸载的组件里写状态
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    []
  )

  useEffect(() => {
    void (async () => {
      try {
        const b = await window.pico.llama.backend()
        if (alive.current) setBackend(b)
      } catch {
        // 旧版本或不支持的平台，忽略
      }
    })()
  }, [])

  // 更新检查：一天一次。打开面板先吃缓存，超过 24h 才真的去打 GitHub / 镜像；
  // 装完 / 手动点检查才 force 穿透（版本刚变，缓存必须作废）。
  useEffect(() => {
    let stopped = false
    const check = async () => {
      const r = await loadUpdateInfo()
      if (r && !stopped && alive.current) setUpdate(r)
    }
    void check()
    const timer = window.setInterval(() => void check(), UPDATE_TTL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [])

  // vramfit 在不在（打包时可能被裁掉），决定显不显示体检入口
  useEffect(() => {
    void (async () => {
      try {
        const a = await window.pico.vramfit.available()
        if (alive.current) setFitReady(a.ok)
      } catch {
        if (alive.current) setFitReady(false)
      }
    })()
  }, [])

  /**
   * 分层模式。只读一次，但要跟着「刚保存过配置」重读 ——
   * 设置面板里改完开关不重启应用时，档位按钮的说法得立刻跟上。
   */
  useEffect(() => {
    void (async () => {
      try {
        const cfg = await window.pico.config.get()
        if (alive.current) {
          setLayerMode(partialModeOf({ mode: cfg.llamaPartialOffloadMode, enabled: cfg.llamaPartialOffload }))
        }
      } catch {
        // 读不到就按默认（auto）处理，与主进程默认值一致
      }
    })()
  }, [])

  /** 体检一次：读文件头、算显存，结果由主进程缓存，重复点同一文件很快 */
  async function runFit(file: string, deviceStr?: string) {
    if (!file) return
    const seq = ++fitSeq.current
    /**
     * 按「这条实例实际会用的卡」体检。
     *
     * 以前固定不传卡号，体检永远按第 0 张卡算 —— 双卡机器上给第二张卡选的模型
     * 拿到的是第一张卡的结论。合并模式还要把卡组容量一起传下去，否则
     * 面板报的是单卡的 8G，「合并后能跑 14B」在界面上根本看不出来。
     */
    const dev = deviceStr ?? llamaSlots.find((s) => s.id === activePid)?.device ?? ''
    const pool = isMultiDevice(dev) ? poolOf(dev) : null
    setFitBusy(true)
    try {
      const r = await window.pico.vramfit.check(file, deviceIndex(dev), pool)
      if (alive.current && seq === fitSeq.current) setFit(r)
    } catch (err) {
      if (alive.current && seq === fitSeq.current) setFit({ ok: false, message: (err as Error).message })
    } finally {
      if (alive.current && seq === fitSeq.current) setFitBusy(false)
    }
  }

  // 安装进度：主进程按 200ms 广播一次，界面据此画进度条与速度
  useEffect(
    () =>
      window.pico.llama.onSetupProgress((p) => {
        if (!alive.current || p.kind !== 'llama') return
        setSetup(p)
        // 进度条在跑就把按钮锁住：主进程里只有一个安装，别让它被点第二次
        if (ACTIVE_SETUP.includes(p.state)) setLlamaBusy((b) => b ?? 'install')
        else setLlamaBusy((b) => (b === 'install' ? null : b))
        if (p.state === 'error' && p.message) setLlamaMsg(p.message)
        // 收尾后留 5 秒让人看清结果再收起（后台下完、面板是后挂载的情况也适用）
        if (p.state === 'done' || p.state === 'error') {
          window.setTimeout(() => {
            if (alive.current) setSetup(null)
          }, 5000)
        }
      }),
    []
  )

  /**
   * 面板可能是「切走又切回来」的：llama.cpp 的下载一直在主进程里跑，
   * 这里把当前进度和按钮状态接回来，别让人以为下载被切断了、又点一次重下。
   */
  useEffect(() => {
    void window.pico.downloads
      .snapshot()
      .then((s) => {
        if (!alive.current || !s.llama) return
        if (!ACTIVE_SETUP.includes(s.llama.state)) return
        setSetup(s.llama)
        setLlamaBusy('install')
      })
      .catch(() => undefined)
  }, [])

  // 打开面板就先扫一遍本地模型，用户不用点「刷新」也能直接选
  useEffect(() => {
    void (async () => {
      try {
        const r = await window.pico.llama.models()
        const devs = await window.pico.llama.devices().catch(() => [])
        if (!alive.current) return
        setLlamaModels(r.models)
        setVision(r.vision ?? {})
        setSizes(r.sizes ?? {})
        setDevices(devs)
      } catch {
        // 扫描失败不阻塞面板
      }
    })()
  }, [])

  /**
   * 认一次「当前这张卡」的状态：挂载和切卡都走这里。
   *
   * 以前只在挂载时探一次、且固定探第一条实例。多卡之后这样会串台：
   * 切到第二张卡，徽章和显存条还停在上一张卡上 —— 看起来两张都在跑，
   * 实际只有一张；用户接下来点「停止服务」停的也是错的那个。
   */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const s = await window.pico.llama.status(activePid)
        const all = await window.pico.llama.instances().catch(() => [])
        if (cancelled || !alive.current) return
        setLlamaRunning(s.running)
        setRunning(all)
        setRunningModel(s.running ? (s.models?.[0] ?? '') : '')
        /**
         * 空闲卸载不是错误，但必须说出来：否则面板显示「未运行」，
         * 用户会以为服务崩了，跑去手动点启动（其实发消息就会自动加载）。
         */
        if (!s.running && s.idle) setLlamaMsg(s.message)
      } catch {
        // 探不到就保持原状
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activePid])

  /**
   * 订阅自动校准的进度。
   *
   * 探测期间主进程会反复起停 llama-server，这里把每一步写到消息区，
   * 结束时刷新实例列表，让档位高亮立刻跟上最终值。
   */
  useEffect(() => {
    const off = window.pico.llama.onProbe((p) => {
      if (!alive.current) return
      setLlamaMsg(p.message)
      if (p.phase === 'done' || p.phase === 'fail') {
        setProbe(null)
        void window.pico.llama
          .instances()
          .then((all) => {
            if (alive.current) setRunning(all)
          })
          .catch(() => undefined)
      } else {
        setProbe(p)
      }
    })
    return off
  }, [])

  /**
   * 运行中时轮询实时显存。
   *
   * 只在「服务运行」时才开定时器：停掉后立刻停，不空转。频率 2.5 秒一次，
   * 比主进程的 3 秒节流略密一点没关系 —— 主进程会自己复用缓存，不会多 spawn。
   * 面板卸载（alive=false）时清掉定时器，避免往已卸载组件写状态。
   */
  useEffect(() => {
    if (!llamaRunning) {
      setVram(null)
      return
    }
    let stopped = false
    const poll = async (): Promise<void> => {
      try {
        const s = await window.pico.llama.status(activePid)
        if (stopped || !alive.current) return
        if (s.running && s.vram) setVram(s.vram)
        else if (!s.running) setVram(null)
      } catch {
        // 轮询失败（端口刚关等）不打断，下轮再试
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 2500)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [llamaRunning])

  /** 重新探一次显卡清单：装完/换后端后设备名会变，失败了就退回显示设备 id */
  async function loadDevices(): Promise<void> {
    try {
      const list = await window.pico.llama.devices()
      if (alive.current) setDevices(list)
    } catch {
      // 探不到就保持原样
    }
  }

  /**
   * 设备 id → 显卡。没绑卡时 llama.cpp 会自己挑，实际就是清单里的第一块，
   * 所以空 device 也报第一块（文案里会说明是自动选的）。
   */
  function gpuOf(device?: string): LlamaDevice | null {
    const d = (device ?? '').trim()
    if (!d) return devices[0] ?? null
    const low = d.toLowerCase()
    return (
      devices.find((x) => x.id.toLowerCase() === low) ??
      devices.find((x) => low.startsWith(x.id.toLowerCase()) || x.id.toLowerCase().startsWith(low)) ??
      null
    )
  }

  /** 人话版显卡描述；清单拿不到时退回设备 id，不让界面空着 */
  function gpuText(device?: string): string {
    /**
     * 合并模式是多张卡：把每张都写上，并给出合计显存 ——
     * 只写第一张的话，用户会以为「合并开关没生效」。
     */
    const list = deviceList(device)
    if (list.length > 1) {
      const parts = list.map((d) => {
        const g = gpuOf(d)
        return g ? `${g.name}（${g.id}）` : d
      })
      const gb = poolOf(device)
      return `${parts.join(' + ')}${gb ? ` · 合计 ${gb.toFixed(1)} GB` : ''}`
    }
    const g = gpuOf(device)
    if (g) {
      const vram = g.vramMiB ? ` · ${(g.vramMiB / 1024).toFixed(1)} GB` : ''
      return `${g.name}（${g.id}${vram}）`
    }
    return (device ?? '').trim() || tr("由 llama.cpp 自动选择")
  }

  /**
   * 一组卡的显存池（GB）。
   *
   * 用**容量**而不是空闲：体检现在是静态口径（按物理容量算），
   * 单卡按容量、多卡按空闲求和会让结论「卡越多越悲观」——
   * 桌面上开着游戏时，第二张卡会直接从预算里消失。
   */
  function poolOf(device?: string): number | null {
    const list = deviceList(device)
    if (!list.length) return null
    let sum = 0
    let got = false
    for (const d of list) {
      const g = gpuOf(d)
      if (!g) continue
      const v = g.vramMiB ?? g.freeMiB
      if (typeof v !== 'number') continue
      got = true
      sum += v
    }
    return got && sum > 0 ? sum / 1024 : null
  }

  /**
   * 卡组的物理显存合计（GB）。
   *
   * 和 poolOf 的区别：那个算「现在还能用多少」，模型已经在跑时只剩几百兆，
   * 拿来标「合并后有多大」会吓人。展示容量用总量，判断装不装得下才用空闲。
   */
  function totalGbOf(device?: string): number {
    let sum = 0
    for (const id of deviceList(device)) {
      const g = gpuOf(id)
      if (g?.vramMiB) sum += g.vramMiB
    }
    return sum / 1024
  }

  /** 当前选中的那条实例（父组件没传槽位、或实例刚被删时为 null） */
  const activeSlot = llamaSlots.find((s) => s.id === activePid) ?? null

  /** 当前实例是不是「合并多卡跑一个模型」 */
  const merged = isMultiDevice(activeSlot?.device)
  /** 合并池（GB）：卡组当前空闲之和。拿不到就当没数，不要编 */
  const mergedGb = merged ? poolOf(activeSlot?.device) : null
  /** 合并实例是不是正在跑（按实例 key 对，不按模型名：两个卡组可以跑同一个模型） */
  const mergedRunning = merged && running.some((r) => r.key === activePid && isMultiDevice(r.device))
  /** 本机全部 N 卡的物理总量（GB），只用于「合并能凑出多少」这类说明 */
  const allGpuGb = devices.reduce((s, d) => s + (d.vramMiB ?? 0), 0) / 1024
  /** 合并池的物理容量（GB）：按钮上直接报「当前：合并模式 XX GB」 */
  const mergedCapGb = merged ? totalGbOf(activeSlot?.device) || allGpuGb : 0

  /**
   * 切换合并模式。
   *
   * 这里只改配置并落盘，**不顺手重启**：重启要 10 秒，用户可能只是想先看看
   * 「合并后能不能装下这个模型」（体检会立刻跟着变）。等他在「④ 模型列表」点
   * 「启动」时，startLlama 会因为 device 变了而自动重启到这个新卡组。
   */
  async function toggleMerge(on: boolean) {
    if (!onToggleMultiGpu) return
    setLlamaBusy('merge')
    setLlamaMsg('')
    try {
      const r = await onToggleMultiGpu(activePid, on)
      setLlamaMsg(r.message ?? (r.ok ? tr("已切换") : tr("切换失败")))
      if (r.ok) {
        // 卡组变了，体检结论也跟着变（8G 装不下 / 16G 装得下）——
        // 不等这里手动重算：父组件的槽位一更新，体检 effect 会自己按新卡组跑一次
        void loadDevices()
      }
    } catch (err) {
      setLlamaMsg(tr("切换失败：{0}", { "0": (err as Error).message }))
    } finally {
      setLlamaBusy(null)
    }
  }

  /**
   * 这张卡归谁 —— 显式绑定的优先。
   *
   * 「自动」实例（device 为空）实际就落在第一张卡上：llama.cpp 不传 -dev 时
   * 自己挑第一块。不做这个映射，第一张卡会显示「空闲」，用户点下去会再建一条，
   * 结果两条都压在同一张卡上 —— 起第二个时第一个还会被停掉。
   */
  function slotOwnerOf(devId: string): LlamaSlot | undefined {
    const low = devId.trim().toLowerCase()
    const pinned = llamaSlots.find((s) => (s.device ?? '').trim().toLowerCase() === low)
    if (pinned) return pinned
    if ((devices[0]?.id ?? '').trim().toLowerCase() === low) {
      return llamaSlots.find((s) => !(s.device ?? '').trim())
    }
    return undefined
  }

  /** 这张卡上有没有正在跑的实例（同样把「自动」算作第一张卡） */
  function liveOn(devId: string) {
    const low = devId.trim().toLowerCase()
    const exact = running.find((r) => (r.device ?? '').trim().toLowerCase() === low)
    if (exact) return exact
    if ((devices[0]?.id ?? '').trim().toLowerCase() === low) {
      return running.find((r) => !(r.device ?? '').trim())
    }
    return undefined
  }

  /**
   * 点一张卡：切到这张卡的实例；还没有就让父组件建一条。
   *
   * 切换后必须清掉 picked —— 否则上一张卡选的模型会被带过来，
   * 「保存到列表」就变成「把上一个卡上的模型搬到这张卡」，而不是「给这张卡选模型」。
   */
  function pickSlot(d: LlamaDevice) {
    const owner = slotOwnerOf(d.id)
    const id = onPickDevice?.(d.id) ?? owner?.id
    if (!id) return
    setActiveId(id)
    setPicked('')
    setLlamaMsg(
      tr("已切到 {0}：下面点一个模型，这张卡就把它跑起来。", { "0": `${d.id} · ${d.name}` })
    )
  }

  // 列表变化时校正选中项：优先保留用户已选，其次用配置里的当前模型，最后退回第一个
  useEffect(() => {
    setPicked((prev) => {
      if (prev && llamaModels.some((m) => sameModel(m, prev))) return prev
      const cur = llamaModels.find((m) => sameModel(m, currentModel))
      return cur ?? llamaModels[0] ?? ''
    })
  }, [llamaModels, currentModel])

  // 选中的模型自动体检：点一下就能看到「跑不跑得动、能开多大上下文」，不用再找按钮
  // 卡组变了也要重算：同一个模型在 8G 单卡上装不下、在 16G 合并池里就装得下
  useEffect(() => {
    if (!fitReady) return
    setFit(null)
    if (picked) void runFit(picked)
    // runFit 每次渲染都是新函数，放进来会无限触发；它只依赖 picked 与卡组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, fitReady, activeSlot?.device])

  /** 探一次 llama-server 状态：更新徽章、实例、当前模型，并把状态文案返回（供「自动配置」拼消息） */
  async function probeStatus(): Promise<{ running: boolean; message: string }> {
    const s = await window.pico.llama.status(activePid)
    if (!alive.current) return { running: s.running, message: s.message }
    setLlamaRunning(s.running)
    setRunning(await window.pico.llama.instances().catch(() => []))
    setRunningModel(s.running ? (s.models?.[0] ?? '') : '')
    // 实测速度只在探测器跑过一次之后才有；读配置拿上次的结论做对照
    void window.pico.config
      .get()
      .then((cfg) => {
        if (!alive.current) return
        const p = cfg.providers?.find((x) => x.id === activePid)
        setRealProbe(p?.ctxProbe ?? null)
        // 同一份配置里带着分层模式：顺手校准一次，省得单独再读一遍文件
        setLayerMode(partialModeOf({ mode: cfg.llamaPartialOffloadMode, enabled: cfg.llamaPartialOffload }))
      })
      .catch(() => undefined)
    // 实例换了显卡时设备名也要跟着更新
    void loadDevices()
    return { running: s.running, message: s.message }
  }

  /** 重新扫一遍本地模型，顺带把体积和看图状态一起更新 */
  async function refreshModels() {
    const r = await window.pico.llama.models()
    setLlamaModels(r.models)
    setSizes(r.sizes ?? {})
    if (r.vision) setVision(r.vision)
    // 选中的那个刚被删掉：退回第一个，别让「将使用 xxx」指着一个不存在的文件
    if (picked && !r.models.includes(picked)) setPicked(r.models[0] ?? '')
    return r
  }

  /**
   * 这一页只负责「装 / 写配置 / 扫模型」。
   *
   * 以前还带 action='start' | 'stop'：点一下就把 llama-server 拉起来。
   * 那正是「本地模型」页与「模型列表」页各起一个实例、最终并发起出两份的根源，
   * 现在整条启动/停止路径都从这一页删掉，改到「④ 模型列表」。
   */
  async function runLlama(action: LlamaAction) {
    if (llamaBusy) return
    // 主进程里已经有一份安装在下：切走再回来点按钮不该起第二份
    if (action === 'install' && setup && ACTIVE_SETUP.includes(setup.state)) {
      setLlamaMsg(tr("llama.cpp 正在下载中，进度在下面；切走页面也不会中断。"))
      return
    }
    setLlamaBusy(action)
    try {
      if (action === 'install') {
        setSetup({
          kind: 'llama',
          receivedBytes: 0,
          totalBytes: 0,
          state: 'preparing',
          message: tr("正在准备下载…")
        })
        setLlamaMsg(tr("正在下载 llama.cpp（有 N 卡会下 CUDA 版，约 300MB）…"))
        const r = await window.pico.llama.install()
        if (!r.ok) {
          setLlamaMsg(r.message)
          return
        }
        const b = await window.pico.llama.backend()
        if (alive.current) setBackend(b)
        // 装完立刻复核版本：按钮从「可更新」回到常态（或反过来，装失败时仍提示）
        // 这里必须 force —— 刚装的版本和缓存里那条已经不是一回事了
        void loadUpdateInfo(true).then((r) => {
          if (r && alive.current) setUpdate(r)
        })
        setLlamaMsg(tr("{message}\n正在自动创建本地模型…", { message: r.message }))
        const c = await window.pico.llama.configure()
        setLlamaMsg(`${r.message}\n${c.message}`)
        await onConfigChanged?.()
        // 成功后再留 5 秒让人看清 100%，然后收起进度条
        window.setTimeout(() => {
          if (alive.current) setSetup(null)
        }, 5000)
      } else if (action === 'configure') {
        setLlamaMsg(tr("正在写入模型配置…"))
        const r = await window.pico.llama.configure()
        if (r.ok) await onConfigChanged?.()
        // 「检测状态」已经并进来：配置完顺手探一次，把服务状态一起报出来
        const s = await probeStatus().catch(() => null)
        setLlamaMsg(s ? `${r.message}\n${s.message}` : r.message)
      } else if (action === 'models') {
        setLlamaMsg(tr("正在扫描本地 .gguf 模型…"))
        const r = await refreshModels()
        setLlamaMsg(r.message)
      }
    } catch (err) {
      setLlamaMsg(tr("操作失败：{0}", { "0": (err as Error).message }))
    } finally {
      setLlamaBusy(null)
    }
  }

  /** 取消正在进行的下载（主进程 abort，未解压的部分自动清掉） */
  async function cancelInstall() {
    const r = await window.pico.llama.cancelInstall()
    setLlamaMsg(r.message)
  }

  useImperativeHandle(ref, () => ({
    refresh: async () => {
      await runLlama('models')
    },
    count: () => llamaModels.length
  }))

  /**
   * 正在跑的那个实例：先按「当前这张卡」对上。
   *
   * 两张卡可以跑同一个模型，只按模型名匹配会挑到另一张卡上那条，
   * 「运行中的显卡」就指向了错误的一边。
   */
  const slotDevice = (activeSlot?.device ?? '').trim().toLowerCase()
  const runningInstance =
    (slotDevice
      ? running.find((r) => (r.device ?? '').trim().toLowerCase() === slotDevice)
      : undefined) ??
    running.find((r) => sameModel(r.model, runningModel)) ??
    running[0] ??
    null
  /** 它落在哪块卡上 —— 用户问的就是这句，别只给个 CUDA0 */
  const runningGpu = runningInstance ? gpuOf(runningInstance.device) : null
  /** 显卡清单拿不到时（老版本 llama.cpp）退回设备 id，总之别让这一栏空着 */
  const runningGpuLabel =
    runningInstance && isMultiDevice(runningInstance.device)
      ? tr("{0}（合计 {1} GB）", {
          "0": deviceList(runningInstance.device)
            .map((id) => gpuOf(id)?.name ?? id)
            .join('+'),
          "1": totalGbOf(runningInstance.device).toFixed(0)
        })
      : runningGpu?.name ?? (runningInstance?.device ?? '').trim()
  /** 当前实例实际开的上下文：档位行据此标「运行中那一档」 */
  const activeCtx = runningInstance?.ctx ?? null
  /** 落盘配置里的档位：手选过就以手选为准，否则显示配置里存的那一档 */
  const slotCtx = llamaSlots.find((s) => s.id === activePid)?.contextWindow ?? null
  const pickedCtx = ctxPick ?? slotCtx ?? null
  const fitReport = fit?.ok ? fit.report : null
  const fitVerdict = fitReport ? verdictOf(fitReport.verdict) : null
  const fitCtx = fitReport?.recommendedCtx ?? null
  const fitTok = fitReport ? (fitReport.genTokPerSec ?? fitReport.genTokPerSecOnCpu) : null
  /** 补上 KV cache 读取代价后的折减值：让「峰值」和主界面实测之间的差距有解释 */
  const fitCtxTok = fitReport?.genTokPerSecAtCtx ?? null
  const budgetText = fitReport ? gb(fitReport.budget.limitBytes) : '—'
  /** 只有实测的就是当前选中的这个模型时才拿来对照，别的模型的速度不能张冠李戴 */
  const probeForPicked = realProbe && picked && sameModel(realProbe.model, picked) ? realProbe : null

  /** 机器上真的有可绑的显卡（纯 CPU 没有「部分」可言） */
  const hasGpu = devices.length > 0
  /**
   * 这个模型整模型装不装得下。
   *
   * 体检只要「最小档都不可行」就说明权重本身超过预算 —— 那正是需要分层的模型。
   * 拿不到体检结果时退回文件体积 vs 预算的硬比较（同一个判据主进程也在用）。
   */
  const limited = fitReport?.budget?.limitBytes ?? 0
  const pickedBytes = picked ? (sizes[picked] ?? 0) : 0
  // 元数据不全（unknown）不是「装不下」：那种情况连档位都算不出来，别下错结论
  const modelTooBig = fitReport
    ? fitReport.verdict !== 'unknown' && !fitCtx
    : limited > 0 && pickedBytes > limited * 0.98
  /** 装不下还能不能点：模式没关 + 真有显卡，和主进程同一份判据 */
  const canLayer = layerMode !== 'off' && hasGpu
  /** 这个模型在 auto 下会不会真的分层：装不下 + 有卡 */
  const willLayer = layerMode !== 'off' && hasGpu && modelTooBig

  /**
   * 切换分层模式：自动 → 总是 → 关 → 自动。
   *
   * 先改本地 state 再落盘：保存要把整份配置读出来重新序列化，几十毫秒里
   * 按钮没反应会被当成没点上。失败就回滚，别让界面和主进程说两套话 ——
   * 界面说「开着」而主进程按「关」启动，点档就是 OOM。
   */
  async function cycleLayerMode() {
    const next: LayerMode = layerMode === 'auto' ? 'on' : layerMode === 'on' ? 'off' : 'auto'
    setLayerMode(next)
    try {
      const cfg = await window.pico.config.get()
      await window.pico.config.save({
        ...cfg,
        llamaPartialOffloadMode: next,
        // 同步写一份旧字段：降级回旧版本时不会把「关」读成「开」
        llamaPartialOffload: next !== 'off'
      })
      await onConfigChanged?.()
    } catch {
      if (alive.current) setLayerMode(layerMode)
      setLlamaMsg(tr("分层加载设置没存下来，重启后会回到原来的设置。"))
    }
  }

  /**
   * 档位行在两处复用：体检算出来了就带「装得下 / 装不下」，没算出来也能手选。
   * 点任意一档都会带 ctxExplicit 启动 —— 主进程据此锁档，不再自动升降档。
   */
  const tierButtons = (rows: TierRow[]) => (
    <>
      <div className="fit-tiers">
      {/*
        「建议」在体检还没算出档位时没有意义（点了也无从写入）→ 禁用。
        注意这里**不再启动服务**：点档位只是把选择记进草稿，随「保存到列表」落盘。
      */}
      <button
        type="button"
        className="fit-tier auto"
        disabled={!!llamaBusy || !fitCtx}
        onClick={() => fitCtx && setCtxPick(fitCtx)}
        title={
          !fitCtx
            ? tr("还没有可用档位：等体检算出来，或直接点下面某一档")
            : tr("按体检建议把 {0} 写进配置（保存后生效）", { "0": kctx(fitCtx) })
        }
      >
        {tr("自动")}
        {fitCtx ? ` · ${tr("建议 {0}", { "0": kctx(fitCtx) })}` : ''}
      </button>
      {rows.map((row) => {
        /**
         * 档位只表达一件事：多大的上下文。要不要分层由下面那个开关决定，
         * 不再在按钮上挂「分层」字样 —— 那样一排按钮看起来像出了故障，
         * 而且 32K 只是因为桌面占了 200 MiB 就变灰，用户会以为模型不行。
         *
         * 三种状态：
         * - 装得下（绿）；其中 `tight` 的标个「紧」（只剩几十上百 MiB，长对话容易挤）
         * - 装不下（灰虚框）：启动时会按显存逐层分配。开关关着时禁用并划掉
         * - 超过训练窗口：一律禁用（llama.cpp 会把窗口裁回原生值，标了也是假的）
         */
        const beyond = row.beyondNative === true
        const needsLayer = row.fits === false && !beyond
        const blocked = beyond || (needsLayer && !canLayer)
        const on = pickedCtx === row.ctx
        const suggested = fitCtx === row.ctx
        const tight = row.fits === true && row.tight === true
        return (
          <button
            key={row.ctx}
            type="button"
            className={`fit-tier ${row.fits === null ? 'unknown' : blocked ? 'bad' : needsLayer ? 'partial' : 'ok'}${on ? ' on' : ''}${suggested ? ' suggested' : ''}`}
            disabled={!!llamaBusy || blocked}
            onClick={() => setCtxPick(row.ctx)}
            title={
              beyond
                ? tr("这档超过模型训练窗口（{0}），llama.cpp 会把窗口裁回原生值，选它没有意义", {
                    "0": kctx(fitCtx ?? row.ctx)
                  })
                : needsLayer && canLayer
                  ? tr("体检判断 {0} 装不下（需要 {1} / 预算 {2}）：保存这档后，启动时会按显存逐层分配，一部分层留在 CPU/内存，能跑但明显变慢", {
                      "0": kctx(row.ctx),
                      "1": row.needBytes ? gb(row.needBytes) : '—',
                      "2": budgetText
                    })
                  : needsLayer
                    ? tr("{0} 装不下（需要 {1} / 预算 {2}），且分层加载已关闭：先打开下面那个开关", {
                        "0": kctx(row.ctx),
                        "1": row.needBytes ? gb(row.needBytes) : '—',
                        "2": budgetText
                      })
                    : tr("把 {0}（{1} tokens）写进配置：以后启动都按这一档，不再自动调档", {
                        "0": kctx(row.ctx),
                        "1": String(row.ctx)
                      })
            }
          >
            {kctx(row.ctx)}
            {suggested ? <em className="fit-tier-rec">{tr("荐")}</em> : null}
            {tight && !suggested ? <em className="fit-tier-rec fit-tier-tight">{tr("紧")}</em> : null}
          </button>
        )
      })}
      </div>
      {hasGpu ? (
        <div className="fit-layer">
          <button
            type="button"
            role="switch"
            aria-checked={willLayer}
            aria-label={tr("分层加载：{0}", { "0": layerModeLabel(layerMode) })}
            className={`fit-layer-switch ${layerMode === 'auto' ? 'auto' : layerMode === 'on' ? 'on' : 'off'}${willLayer ? ' active' : ''}`}
            disabled={!!llamaBusy}
            onClick={() => void cycleLayerMode()}
            title={
              layerMode === 'auto'
                ? tr("自动（推荐）：装不下的模型才按显存逐层分配；装得下的模型全放显存，不受影响。点一下改成「总是」")
                : layerMode === 'on'
                  ? tr("总是：即使体检说装得下也允许分层，用于体检估偏乐观的模型。点一下改成「关」")
                  : tr("关：装不下的档位点不动，装不下就直接报错。点一下回到「自动」")
            }
          >
            <i aria-hidden />
            <span>{tr("分层加载")}</span>
            <em>{layerModeLabel(layerMode)}</em>
          </button>
          <span className="fit-dim">
            {layerMode === 'auto'
              ? modelTooBig
                ? tr("自动：这个模型装不下（{0} / 预算 {1}），启动时按显存逐层分配", {
                    "0": pickedBytes ? gb(pickedBytes) : '—',
                    "1": limited ? gb(limited) : '—'
                  })
                : tr("自动：这个模型装得下，全部放显存，不会分层")
              : layerMode === 'on'
                ? tr("总是：允许分层，整模型装不进显存时按层分担")
                : tr("关：只跑装得下整模型的档，灰虚框点不动")}
          </span>
        </div>
      ) : null}
    </>
  )

  return (
    <div className="guide-section">
      <div className={`guide-card ${llamaOpen ? '' : 'collapsed'}`}>
        <div
          className="guide-card-head"
          onClick={toggleLlama}
          title={llamaOpen ? tr("收起") : tr("展开")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') toggleLlama()
          }}
        >
          <h3>{tr("方式 A：llama.cpp（本机 · 推荐先测）")}</h3>
          {backend && (
            <span className={`guide-badge ${!backend.installed ? 'muted' : backend.gpuReady ? '' : 'cpu'}`}>
              {!backend.installed
                ? tr("未安装")
                : backend.gpuReady
                  ? `GPU · ${backend.backend.toUpperCase()}`
                  : tr("CPU 版")}
            </span>
          )}
          {llamaRunning ? (
            <span
              className="guide-badge"
              title={
                runningInstance?.partial
                  ? tr("部分层在内存/CPU 上跑（显存装不下整模型），能对话但速度明显更慢")
                  : runningInstance
                    ? tr("当前显卡：{0}", { "0": gpuText(runningInstance.device) })
                    : tr("运行中")
              }
            >
              {tr("运行中")}
              {runningGpuLabel ? ` · ${runningGpuLabel}` : ''}
              {runningInstance?.partial ? ` · ${tr("部分卸载")}` : ''}
            </span>
          ) : null}
          <Chevron open={llamaOpen} />
        </div>
        {backend?.installed && !backend.gpuReady && (
          <p className="guide-warn">
            {backend.note ?? tr("当前 CPU 版：不占显存但慢；重装可换 CUDA 版。")}</p>
        )}
        {backend && !backend.installed && (
          <p className="guide-warn">
            {tr("还没装 llama.cpp：点下面「一键安装 / 下载」即可。")}</p>
        )}
        {llamaRunning && vram && vram.totalMiB > 0 && (
          <div className="guide-vram">
            <div className="guide-vram-head">
              <span>{tr("显存")}</span>
              <span className="guide-vram-num">
                {tr("{0} / {1} GB", {
                  "0": (vram.usedMiB / 1024).toFixed(1),
                  "1": (vram.totalMiB / 1024).toFixed(1)
                })}
              </span>
            </div>
            <div
              className="guide-vram-track"
              role="progressbar"
              aria-valuenow={Math.round((vram.usedMiB / vram.totalMiB) * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              title={tr("显存占用 {0}%，剩余约 {1} GB。占用过高时建议降一档上下文或换更小的量化。", {
                "0": String(Math.round((vram.usedMiB / vram.totalMiB) * 100)),
                "1": ((vram.totalMiB - vram.usedMiB) / 1024).toFixed(1)
              })}
            >
              <div
                className={`guide-vram-fill${vram.usedMiB / vram.totalMiB > 0.9 ? ' high' : ''}`}
                style={{ width: `${Math.min(100, (vram.usedMiB / vram.totalMiB) * 100)}%` }}
              />
            </div>
          </div>
        )}
        <div className="guide-actions">
          {/*
            按钮一律用基础 .btn 样式（和「自动配置」同一个颜色）：
            以前「可更新」带描边强调色、「停止服务」带红字，四个按钮摆一排像四种状态，
            眼睛先被颜色带走、反而看不出哪个是主操作。状态改由文字和图标表达
            （「可更新 → b1234」），颜色只留给这一页唯一的出口「保存到列表」。
          */}
          <button
            className="btn"
            disabled={!!llamaBusy}
            onClick={() => void runLlama('install')}
            title={
              update?.updateAvailable
                ? tr("检测到新版本 b{0}（当前 b{1}）：点击升级到最新显卡版", {
                    "0": String(update.latestBuild ?? ''),
                    "1": String(update.installedBuild ?? '')
                  })
                : tr("默认装显卡版（N 卡 CUDA / A 卡·核显 Vulkan）；自动按 直连 → gh-proxy → ghproxy.net → ghfast.top 换源，每个源至少试 15 秒")
            }
          >
            {llamaBusy === 'install'
              ? tr("安装中…")
              : update?.updateAvailable
                ? tr("可更新 → b{0}", { "0": String(update.latestBuild ?? '') })
                : tr("一键安装 / 下载")}
          </button>
          <button
            className="btn"
            disabled={!!llamaBusy}
            onClick={() => void runLlama('configure')}
            title={tr("写入本地模型配置，并顺手报一次服务状态")}
          >
            {llamaBusy === 'configure' ? tr("配置中…") : tr("自动配置")}</button>
          {/*
            合并多卡：一个模型摊到全部卡上，显存池从 8G 变成 16G。
            「每个卡单独跑一个模型」和「多卡跑一个模型」抢的是同一批卡，
            所以这是一个开关，而不是再加一个实例 —— 开着的时候卡槽整排
            合并成一块，避免用户以为还能往第二张卡上再塞一个模型。

            按钮文案只报「现在是哪种模式」（合并模式 XX GB / 一卡一模型 XX 张卡），
            不写「点了会怎样」：动词式文案在两个状态之间来回换，看一眼根本分不清
            当前落在哪种模式下。点了会做什么放在 title 里。
          */}
          <button
            className={`btn${merged ? ' on' : ''}`}
            disabled={!!llamaBusy || devices.length < 2}
            onClick={() => void toggleMerge(!merged)}
            title={
              devices.length < 2
                ? tr("只有一张可用显卡，合并没有意义")
                : merged
                  ? tr("拆回一卡一模型：每个实例各占一张卡，主 / 子在「④ 模型列表」里逐条设定")
                  : tr("把这几张卡合成一个显存池跑同一个模型（约 {0} GB）：大模型能全量上卡，不用再分层跑到 CPU", {
                      "0": allGpuGb.toFixed(0)
                    })
            }
          >
            {llamaBusy === 'merge'
              ? tr("切换中…")
              : merged
                ? tr("当前：合并模式 {0} GB", {
                    "0": mergedCapGb ? mergedCapGb.toFixed(0) : '?'
                  })
                : tr("当前：一卡一模型 · {0} 张卡", { "0": String(devices.length) })}
          </button>
          {/*
            这一页的出口，站在「停止服务」原来的位置上。
            这一页只做配置：启动与停止都搬到「④ 模型列表」，一个模型只有一个启动入口，
            才不会出现两处各拉起一个 llama-server（曾经就因为并发启动起了两个）。
          */}
          {onSaveToList && (
            <button
              className="btn primary"
              disabled={listBusy}
              title={tr("把这份配置写入磁盘，然后到「④ 模型列表」启动它")}
              onClick={() => {
                if (listBusy) return
                setListBusy(true)
                void onSaveToList(activePid, ctxPick ? { contextWindow: ctxPick } : undefined).finally(
                  () => setListBusy(false)
                )
              }}
            >
              {listBusy ? tr("保存中…") : tr("保存到列表")}
            </button>
          )}
        </div>
        {setup && <DownloadBar p={setup} onCancel={() => void cancelInstall()} />}
        {probe && (
          <div className="probe-line">
            <span className="probe-dot" />
            {tr("正在校准上下文 {0}/{1}：{2}", {
              "0": String(probe.attempt),
              "1": String(probe.budget),
              "2": kctx(probe.ctx)
            })}
          </div>
        )}
        {llamaMsg && <div className="guide-msg">{llamaMsg}</div>}
        {devices.length > 0 && (
          <div className="gpu-slots">
            <div className="gpu-slots-head">
              <b>{tr("显卡")}</b>
              {/**
                * 单卡机器上不写「共 1 张，点一张为它选模型」：卡槽自己就带
                * 「当前 / 空闲 · 点我选模型」标记，同一件事说两遍只是噪音。
                * 多卡和合并态才留说明 —— 那两种情况下「点哪张」真的会改变结果。
                */}
              {(merged || devices.length > 1) && (
                <span className="guide-pick-hint">
                  {merged
                    ? tr("合并模式：这几张卡一起跑同一个模型")
                    : tr("一卡一模型：共 {0} 张，点一张为它选模型；主 / 子在「④ 模型列表」里设定", {
                        "0": String(devices.length)
                      })}
                </span>
              )}
            </div>
            {merged ? (
              /**
               * 合并模式：整排卡槽合成一块。
               *
               * 不给「点某一张单独选模型」的入口 —— 卡已经被合并实例占住了，
               * 再点一张去建单卡实例会和它抢同一张卡，起新的时候旧的就崩。
               */
              <div className="gpu-merged">
                <div className="gpu-merged-top">
                  <span className="gpu-merged-badge">{tr("合并")}</span>
                  <span className="gpu-merged-names">
                    {deviceList(activeSlot?.device).map((id) => gpuText(id)).join('  +  ')}
                  </span>
                  {mergedRunning && <span className="gpu-slot-live">{tr("运行中")}</span>}
                </div>
                <div className="gpu-merged-sub">
                  {activeSlot?.model ? baseName(activeSlot.model) : tr("还没选模型")}
                  {mergedGb ? tr(" · 合计约 {0} GB 可用", { "0": mergedGb.toFixed(1) }) : ''}
                  {tr(" · 按层切分（-sm layer），大模型可全量上卡")}
                </div>
              </div>
            ) : (
            <div className="gpu-slot-row">
              {devices.map((d) => {
                const owner = slotOwnerOf(d.id)
                const live = liveOn(d.id)
                const on = owner?.id === activePid
                return (
                  <button
                    key={d.id}
                    type="button"
                    className={`gpu-slot ${on ? 'on' : ''} ${owner ? 'used' : 'free'}`}
                    onClick={() => pickSlot(d)}
                    title={
                      owner
                        ? tr("{0}：{1}（点了就切到这张卡，之后选的模型装在它上面）", {
                            "0": gpuText(d.id),
                            "1": owner.model ? baseName(owner.model) : tr("还没选模型")
                          })
                        : tr("{0} 还空着：点它为这张卡开一个实例并选模型", { "0": gpuText(d.id) })
                    }
                  >
                    <span className="gpu-slot-top">
                      <span className="gpu-slot-id">{d.id}</span>
                      {live && <span className="gpu-slot-live">{tr("运行中")}</span>}
                      {on && <span className="gpu-slot-here">{tr("当前")}</span>}
                      {/*
                        角色来自「④ 模型列表」：这一页只负责「这张卡上装哪个模型」，
                        主 / 子不在这里改，但必须看得见 —— 否则用户不知道这次配的
                        是给对话用的主模型，还是给子代理干活的子智能体。
                      */}
                      {owner?.role === 'main' && (
                        <span className="gpu-slot-role main">{tr("主")}</span>
                      )}
                      {owner?.role === 'worker' && (
                        <span className="gpu-slot-role">{tr("子")}</span>
                      )}
                    </span>
                    <span className="gpu-slot-name">{d.name}</span>
                    <span className="gpu-slot-sub">
                      {owner
                        ? owner.model
                          ? baseName(owner.model)
                          : tr("未选模型")
                        : tr("空闲 · 点我选模型")}
                    </span>
                    <span className="gpu-slot-vram">
                      {d.vramMiB ? `${(d.vramMiB / 1024).toFixed(0)} GB` : ''}
                      {/* 跑着实例的卡不报「空闲」：那串数是探测时的快照，
                          模型已经上去之后还写「空闲 6.9 GB」会直接把人带偏 */}
                      {!live && typeof d.freeMiB === 'number'
                        ? tr(" · 空闲 {0} GB", { "0": (d.freeMiB / 1024).toFixed(1) })
                        : ''}
                    </span>
                  </button>
                )
              })}
            </div>
            )}
          </div>
        )}
        {/**
          * 这里原来还有一整块「工作组」摘要（组名、整组 N 张卡 M 个就绪、
          * 主模型是哪张卡、逐卡的「工作模型」卡片、并行体检按钮与结果）。
          *
          * 全部去掉了：上面「显卡」那一排已经写明每张卡上是哪个模型。
          * 现在主 / 子由「④ 模型列表」显式指定，这一页不再有「自动进组」这回事，
          * 再铺一遍摘要只会和列表页的结论打架。
          */}
        {llamaModels.length > 0 && (
          <div className="guide-pick">
            <div className="guide-pick-head">
              <b>{tr("使用哪个本地模型")}</b>
              {/* 点完卡再选模型，这里回显「装到哪张卡」：两卡各一个实例时，
                  没有这行标签，用户分不清下面点的这个模型落在谁身上。
                  只有一张卡就没这个问题 —— 报个 CUDA0 只是多一行字。 */}
              {activeSlot && (merged || devices.length > 1) && (
                <span
                  className={`gpu-pick-target${merged ? ' merged' : ''}`}
                  title={
                    merged
                      ? tr("现在选的模型会摊到这几张卡上跑")
                      : tr("现在选的模型会装到这张卡上")
                  }
                >
                  {merged
                    ? tr("合并 {0}", { "0": deviceList(activeSlot.device).join('+') })
                    : activeSlot.device || tr("自动")}
                </span>
              )}
              {/* 「共 N 个，点一下选中」「当前运行：xxx」「显卡 xxx」这三句都去掉了：
                  列表本来就是点一下就选中；运行中的模型自己带「运行中」和显卡标签，
                  再在表头重复一遍只是占地方。 */}
            </div>
            {/**
              * 这一行原来是「N 个模型，共占磁盘 X GB」+「清理未使用」按钮，两样都去掉了：
              * 每个模型自己带体积标签，合计没有额外信息；而删除模型属于用户自己的磁盘操作，
              * 这个程序不该替人决定「哪些算没用的」—— 误删一次就是几十 GB 重新下载。
              */}
            <div className="guide-models">
              {(modelsExpanded ? llamaModels : llamaModels.slice(0, 3)).map((m) => {
                const on = sameModel(m, picked)
                const isRunning = llamaRunning && sameModel(m, runningModel)
                const needRestart = on && llamaRunning && !!runningModel && !isRunning
                return (
                  /**
                   * 用 div + role 而不是 button：这一行是「选中」，外层的点击区域要整片可点，
                   * 键盘可达性由 role + onKeyDown 补回来。
                   *
                   * 行尾那个「×（从磁盘删除）」已经去掉了：删模型文件是用户自己的磁盘操作，
                   * 不该做成列表里一个手滑就中的小叉。要删就去 models/ 里删。
                   */
                  <div
                    key={m}
                    role="button"
                    tabIndex={0}
                    className={`guide-model ${on ? 'on' : ''}`}
                    onClick={() => {
                      setPicked(m)
                      // 同步到「模型列表」里的下拉框，两边始终是同一个模型
                      onSelectModel?.(baseName(m), activePid)
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      e.preventDefault()
                      setPicked(m)
                      onSelectModel?.(baseName(m), activePid)
                    }}
                    title={m}
                  >
                    <span className="guide-model-dot" />
                    <span className="guide-model-name">{baseName(m)}</span>
                    {isRunning && <span className="guide-model-tag run">{tr("运行中")}</span>}
                    {/* 运行中顺便报一下吃的是哪块卡：双卡机器上「在跑」和「在哪张卡上跑」是两个问题 */}
                    {isRunning && runningGpuLabel && (
                      <span
                        className="guide-model-tag gpu"
                        title={tr("当前显卡：{0}", { "0": gpuText(runningInstance?.device) })}
                      >
                        {runningGpuLabel}
                      </span>
                    )}
                    {needRestart && <span className="guide-model-tag next">{tr("待切换")}</span>}
                    {vision[m] === 'ready' && (
                      <span
                        className="guide-model-tag vision"
                        title={tr("已配上视觉投影器，可以看图")}
                      >
                        {tr("可看图")}
                      </span>
                    )}
                    {vision[m] === 'missing' && (
                      <span
                        className="guide-model-tag novision"
                        title={tr("这是视觉模型，但目录里没有配套的 mmproj，只能用作文本模型")}
                      >
                        {tr("缺投影器")}
                      </span>
                    )}
                    {sizes[m] ? (
                      <span className="guide-model-size" title={tr("占磁盘 {0}", { "0": gb(sizes[m]) })}>
                        {gb(sizes[m])}
                      </span>
                    ) : null}
                  </div>
                )
              })}
            </div>
            {llamaModels.length > 3 && (
              <button
                type="button"
                className="guide-models-more"
                onClick={() => setModelsExpanded((v) => !v)}
                title={
                  modelsExpanded
                    ? tr('收起模型列表，只显示前 3 个')
                    : tr('展开全部 {length} 个本地模型', { length: llamaModels.length })
                }
              >
                {modelsExpanded ? tr('收起') : tr('展开全部 {length} 个', { length: llamaModels.length })}
                <svg
                  className={modelsExpanded ? 'up' : ''}
                  width="9"
                  height="9"
                  viewBox="0 0 10 10"
                  aria-hidden="true"
                >
                  <path
                    d="M2 4l3 3 3-3"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    fill="none"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )}
            {picked && vision[picked] === 'missing' && (
              <p className="guide-warn">
                {tr("缺配套投影器（mmproj），发图片会被忽略；重新下载会一起装。")}
              </p>
            )}

            {/* vramfit 体检：跑不跑得动、能开多大上下文，都是算出来的，不是猜的 */}
            {fitReady && picked && (
              <div className={`fit-box ${fitVerdict?.tone ?? ''}`}>
                <div className="fit-head">
                  <b>{tr("体检")}</b>
                  {fitBusy ? (
                    <span className="fit-dim">{tr("正在读文件头…")}</span>
                  ) : fitVerdict ? (
                    <span className={`fit-verdict ${fitVerdict.tone}`}>{fitVerdict.label}</span>
                  ) : fit && !fit.ok ? (
                    <span className="fit-verdict bad">{tr("没算出来")}</span>
                  ) : null}
                  {fitReport && (
                    <span className="fit-dim">
                      {fitReport.quant ?? '?'} · {fitReport.arch}
                      {fitReport.params ? ` · ${(fitReport.params / 1e9).toFixed(1)}B` : ''}
                    </span>
                  )}
                  <button
                    type="button"
                    className="fit-refresh"
                    disabled={fitBusy}
                    onClick={() => void runFit(picked)}
                    title={tr("重新体检（按显卡容量静态估算，与当前占用无关；改过文件或 KV 精度才需要）")}
                  >
                    {tr("重算")}
                  </button>
                </div>

                {fit && !fit.ok && <p className="fit-msg">{fit.message}</p>}

                {fitReport && (
                  <>
                    <div className="fit-grid">
                      <span>{tr("权重")}</span>
                      <span>{gb(fitReport.weightsBytes)}</span>
                      <span>{tr("可用预算")}</span>
                      <span>
                        {gb(fitReport.budget.limitBytes)}
                        {fitReport.gpu ? ` · ${fitReport.gpu.name}` : ` · ${tr("CPU 推理")}`}
                        {/*
                          静态口径：按显卡总容量算，与此刻谁占着显存无关。
                          必须写出来 —— 否则用户开着游戏点启动、速度掉下来，会以为是这份预算算错了。
                          动态口径时代这里还有一句「本地服务正占着显存，档位偏保守」，
                          现在不成立了：预算不再看当前占用。
                        */}
                        {fitReport.budget.basis === 'static' ? (
                          <em className="fit-dim">
                            {tr("（静态口径：按显卡总容量的 94% 估算，不看当前谁占着显存）")}
                          </em>
                        ) : null}
                        {/* A 卡 / 核显读不到已用显存时预算按 60% 保守估，不解释一句会被当成「算错了」 */}
                        {fitReport.gpu?.usedUnknown && fitReport.budget.basis !== 'static' ? (
                          <em className="fit-dim">
                            {tr("（读不到当前已用显存，按总显存 60% 保守估）")}
                          </em>
                        ) : null}
                      </span>
                      <span>{tr("建议上下文")}</span>
                      <span>
                        {fitCtx ? kctx(fitCtx) : '—'}
                        {fitReport.nativeContext ? (
                          <em
                            className="fit-dim"
                            title={tr(
                              "模型训练时支持的最大上下文，不是这张显卡能跑的值；实际能开多大看左边的建议"
                            )}
                          >
                            {tr("（训练窗口 {0}）", { "0": kctx(fitReport.nativeContext) })}
                          </em>
                        ) : null}
                      </span>
                      {/*
                        看图口径：默认纯文本启动，但发图片时会自动重启挂上投影器。
                        投影器本身（这里 300~900 MiB）+ CLIP 激活会挤掉一到两档，
                        不提前说清，用户只会觉得「发张图就崩了」。
                      */}
                      {fitReport.vision ? (
                        <>
                          <span
                            title={tr(
                              "发图片时 llama.cpp 会挂上视觉投影器（mmproj）：投影器文件 {p} + 编码器激活 {a}，这部分平时不占显存。这里给的是挂上之后还能开的上下文；切看图模式时会自动降到这一档。",
                              {
                                p: gb(fitReport.vision.projectorBytes),
                                a: gb(fitReport.vision.activationBytes)
                              }
                            )}
                          >
                            {tr("发图时")}
                          </span>
                          <span>
                            {fitReport.vision.recommendedCtx ? (
                              kctx(fitReport.vision.recommendedCtx)
                            ) : (
                              <b className="fit-warn">{tr("一档都装不下")}</b>
                            )}
                            <em className="fit-dim">
                              {tr("（多占 {0}）", { "0": gb(fitReport.vision.totalBytes) })}
                            </em>
                          </span>
                        </>
                      ) : null}
                      {/* 能开多大上下文 ≠ 够不够用：agent 每轮都要背着系统提示和工具定义跑 */}
                      <span>{tr("Agent 余量")}</span>
                      <span>
                        {fitReport.agent ? (
                          <>
                            {tr("约 {0} 轮", { "0": String(fitReport.agent.rounds) })}
                            <em className="fit-dim">
                              {tr("（系统提示 {0}，每轮 {1}）", {
                                "0": `${Math.round(fitReport.agent.systemTokens / 1000)}K`,
                                "1": `${(fitReport.agent.perRoundTokens / 1000).toFixed(1)}K`
                              })}
                            </em>
                          </>
                        ) : (
                          '—'
                        )}
                      </span>
                      {/* 名字里就写清口径：这是零上下文的理论上限，不是「跑起来会有多快」 */}
                      <span title={tr("零上下文、batch=1、全权重驻留显存时的理论解码上限：带宽 × 0.7 ÷ 权重 GB。不计 KV cache 读取、首字延迟、工具执行与排队，不是实测速度")}>
                        {tr("理论上限（非实测）")}
                      </span>
                      <span title={tr("按带宽公式算出的上限，不是实测；实测值见下方「实测」一栏，两者可能差一倍以上")}>
                        {fitTok ? `~${fitTok} tok/s` : '—'}
                        {fitCtxTok && fitReport.speedCtx ? (
                          <em className="fit-dim">
                            {' '}{tr("{ctx} 上下文估算约 {n} tok/s", {
                              ctx: kctx(fitReport.speedCtx),
                              n: String(fitCtxTok)
                            })}
                          </em>
                        ) : null}
                        {fitReport.moe ? (
                          <em className="fit-dim fit-sub">
                            {tr("MoE 模型：估算未计入激活比例，实测通常更快")}
                          </em>
                        ) : null}
                      </span>
                      {/*
                        实测一行：只有探测器真跑过这个模型才有。
                        这一行才是「点下去实际会有多快」的答案 —— 8 GB 卡上 9B 模型的
                        公式值是 33，实测单请求 13，差 2.5 倍，不并排放用户会以为能跑到 33。
                      */}
                      {probeForPicked?.tokPerSec ? (
                        <>
                          <span title={tr("上次探测器实际跑出来的解码速度：验证据点发了一个 max_tokens=8 的真实请求，用引擎自己上报的计时算")}>
                            {tr("实测解码")}
                          </span>
                          <span>
                            <b>{`${probeForPicked.tokPerSec.toFixed(1)} tok/s`}</b>
                            <em className="fit-dim fit-sub">
                              {tr("（{ctx} 上下文，占用 {foot}）", {
                                ctx: kctx(probeForPicked.ctx),
                                foot: `${(probeForPicked.footMiB / 1024).toFixed(1)} GB`
                              })}
                            </em>
                          </span>
                        </>
                      ) : null}
                    </div>

                    {/* 各档上下文只改配置：点哪档就记哪档，跟着「保存到列表」落盘 */}
                    <div className="fit-tier-head">
                      <b>{tr("上下文档位")}</b>
                      <span className="fit-dim">
                        {tr("点一档写进配置，保存后生效；绿=装得下、灰虚框=装不下")}
                      </span>
                      {activeCtx ? (
                        <span className="fit-tier-current">
                          {tr("运行中 {0}", { "0": kctx(activeCtx) })}
                        </span>
                      ) : null}
                    </div>
                    {tierButtons(fitReport.tiers)}

                    {/**
                      * 这里原来还有「用建议档位（X K）」按钮和「静态推算，实际以加载一次为准」：
                      * 上面那排档位按钮已经把「建议」标出来了（suggested 高亮），
                      * 再给一个按钮做同一件事只是第二个入口；那句免责声明留着也没人看。
                      * 只有「一档都装不下」还值得说一句 —— 这时用户需要一个出口，不是一段解释。
                      */}
                    {!fitCtx && !(canLayer && fitReport.tiers?.length) && (
                      <div className="fit-foot">
                        <span className="fit-dim">
                          {tr("一档上下文都装不下，建议换更小的模型或更低的量化。")}
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* 体检不可用 / 还没算出来时，档位照样能选：切上下文不该依赖 vramfit */}
            {picked && !fitReport && !fitBusy && (
              <div className="fit-box">
                <div className="fit-tier-head">
                  <b>{tr("上下文档位")}</b>
                  <span className="fit-dim">{tr("体检没出来，仍可直接选一档写进配置")}</span>
                  {activeCtx ? (
                    <span className="fit-tier-current">
                      {tr("运行中 {0}", { "0": kctx(activeCtx) })}
                    </span>
                  ) : null}
                </div>
                {tierButtons(FALLBACK_TIERS.map((ctx) => ({ ctx, needBytes: null, fits: null })))}
              </div>
            )}
          </div>
        )}
        {/**
          * 底部这行只留说明。
          *
          * 「保存到列表」已经挪到上面按钮行的末位（原「停止服务」的位置）——
          * 它是这一页唯一的出口，和「一键安装 / 自动配置」排在一起才不会看着像附注。
          */}
        <div className="guide-note-row">
          <p className="guide-note">
            {tr("端口留空自动探测；两个实例绑不同显卡即可同时跑。.gguf 放进")}<code>models/</code> {tr("或")}<code>llama.cpp/</code> {tr("即可识别。")}</p>
        </div>
        {running.length > 1 && (
          <p className="guide-note">
            {tr("当前有 {n} 个实例在跑：", { n: running.length })}
            {running.map((r) => `${r.model}@${r.port}${r.device ? `（${gpuOf(r.device)?.name ?? r.device}）` : ''}`).join('、')}
          </p>
        )}
      </div>

      <LocalRuntime
        kind="ollama"
        step={tr("方式 B")}
        title="Ollama"
        desc={tr("没装就先「一键安装 / 下载」，再点「保存到列表」。")}
        port={11434}
        canPull
        currentModel={currentModels?.ollama}
        onSelectModel={(m) => onSelectModel?.(m, 'ollama')}
        onConfigChanged={onConfigChanged}
      />

      <LocalRuntime
        kind="lmstudio"
        step={tr("方式 C")}
        title="LM Studio"
        desc={tr("自带 Local Server：装好后点「保存到列表」即可。")}
        port={1234}
        currentModel={currentModels?.lmstudio}
        onSelectModel={(m) => onSelectModel?.(m, 'lmstudio')}
        onConfigChanged={onConfigChanged}
      />

      {/* 方式 D：预留位，暂时不做，占位提示后续会加入 */}
      <div className="guide-card">
        <div className="guide-card-head" style={{ cursor: 'default' }}>
          <h3>{tr("方式 D：待扩展")}</h3>
          <span className="guide-badge muted">{tr("即将加入")}</span>
        </div>
        <p className="guide-lead">
          {tr("更多本地模型运行方式正在接入中，敬请期待。")}
        </p>
      </div>
    </div>
  )
})
