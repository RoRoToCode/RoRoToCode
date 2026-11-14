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

interface Props {
  /** 配置（草稿）里各本地供应商正在使用的模型，key 为供应商 id */
  currentModels?: Record<string, string>
  /** 在这里点选模型时回调，让「模型列表」里的选择跟着变 */
  onSelectModel?: (model: string, providerId?: string) => void
  onConfigChanged?: () => void | Promise<void>
}

/** 模型可能带目录，比较时只看文件名 */
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p
const sameModel = (a?: string, b?: string) =>
  !!a && !!b && baseName(a).toLowerCase() === baseName(b).toLowerCase()

type LlamaAction = 'install' | 'configure' | 'models' | 'start' | 'stop'

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
  { currentModels, onSelectModel, onConfigChanged },
  ref
) {
  /** llama.cpp 当前用的模型（其余本地服务各自从 currentModels 取） */
  const currentModel = currentModels?.llamacpp ?? ''
  const [llamaOpen, toggleLlama] = useCollapse('llama-card', true)
  const [llamaBusy, setLlamaBusy] = useState<LlamaAction | null>(null)
  const [llamaMsg, setLlamaMsg] = useState('')
  /** 安装进度（下载中带速度，解压时切文案） */
  const [setup, setSetup] = useState<SetupProgress | null>(null)
  const [llamaModels, setLlamaModels] = useState<string[]>([])
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
  const [warming, setWarming] = useState(false)
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
  async function runFit(file: string) {
    if (!file) return
    const seq = ++fitSeq.current
    setFitBusy(true)
    try {
      const r = await window.pico.vramfit.check(file)
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
        if (!alive.current) return
        setLlamaModels(r.models)
        setVision(r.vision ?? {})
        setSizes(r.sizes ?? {})
        const s = await window.pico.llama.status('llamacpp')
        const all = await window.pico.llama.instances().catch(() => [])
        const devs = await window.pico.llama.devices().catch(() => [])
        if (!alive.current) return
        setLlamaRunning(s.running)
        setRunning(all)
        setDevices(devs)
        if (s.running && s.models?.[0]) setRunningModel(s.models[0])
        /**
         * 空闲卸载不是错误，但必须说出来：否则面板显示「未运行」，
         * 用户会以为服务崩了，跑去手动点启动（其实发消息就会自动加载）。
         */
        if (!s.running && s.idle) setLlamaMsg(s.message)
      } catch {
        // 扫描失败不阻塞面板
      }
    })()
  }, [])

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
        const s = await window.pico.llama.status('llamacpp')
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
    const g = gpuOf(device)
    if (g) {
      const vram = g.vramMiB ? ` · ${(g.vramMiB / 1024).toFixed(1)} GB` : ''
      return `${g.name}（${g.id}${vram}）`
    }
    return (device ?? '').trim() || tr("由 llama.cpp 自动选择")
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
  useEffect(() => {
    if (!fitReady) return
    setFit(null)
    if (picked) void runFit(picked)
    // runFit 每次渲染都是新函数，放进来会无限触发；它只依赖 picked
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, fitReady])

  /** 后台等 llama-server 就绪：就绪后刷新模型列表与配置（不阻塞界面） */
  async function watchServer(maxMs = 90000) {
    setWarming(true)
    const deadline = Date.now() + maxMs
    try {
      while (alive.current && Date.now() < deadline) {
        await new Promise((r) => window.setTimeout(r, 1500))
        if (!alive.current) return
        const s = await window.pico.llama.status('llamacpp')
        if (!s.running) continue
        setLlamaRunning(true)
        const ml = await window.pico.llama.models()
        if (!alive.current) return
        setLlamaModels(ml.models)
        setVision(ml.vision ?? {})
        setSizes(ml.sizes ?? {})
        await onConfigChanged?.()
        if (!alive.current) return
        setLlamaMsg(
          tr("本地模型已就绪：{0}", { "0": s.models?.[0] ?? ml.models[0] ?? tr("已加载") }) +
            tr("（已设为当前使用）")
        )
        setRunningModel(s.models?.[0] ?? ml.models[0] ?? '')
        return
      }
    } finally {
      if (alive.current) setWarming(false)
    }
  }

  /** 探一次 llama-server 状态：更新徽章、实例、当前模型，并把状态文案返回（供「自动配置」拼消息） */
  async function probeStatus(): Promise<{ running: boolean; message: string }> {
    const s = await window.pico.llama.status('llamacpp')
    if (!alive.current) return { running: s.running, message: s.message }
    setLlamaRunning(s.running)
    setRunning(await window.pico.llama.instances().catch(() => []))
    setRunningModel(s.running ? (s.models?.[0] ?? '') : '')
    // 实测速度只在探测器跑过一次之后才有；读配置拿上次的结论做对照
    void window.pico.config
      .get()
      .then((cfg) => {
        if (!alive.current) return
        const p = cfg.providers?.find((x) => x.id === 'llamacpp')
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

  /** 删一个模型文件。二次确认放在这里，主进程只负责执行和校验。 */
  async function removeOne(rel: string) {
    const name = baseName(rel)
    const ask = tr("删除「{0}」？\n文件会从磁盘移除，不能恢复。正在运行时请先点「停止服务」。", {
      "0": name
    })
    if (!window.confirm(ask)) return
    const r = await window.pico.llama.deleteModel(rel)
    setLlamaMsg(r.message)
    if (r.ok) await refreshModels()
  }

  /**
   * 清理没有被任何供应商引用的模型。
   *
   * 「未使用」的判据是 all providers 的 model 字段 + 正在跑的实例：
   * currentModels 是全部供应商的 id → model 映射，所以工人模型、备用模型
   * 都在里面，不会误删正在用的那份。
   */
  async function cleanUnused() {
    const inUse = new Set(
      Object.values(currentModels ?? {})
        .map((v) => baseName(v || '').toLowerCase())
        .filter(Boolean)
    )
    if (llamaRunning && runningModel) inUse.add(baseName(runningModel).toLowerCase())

    const unused = llamaModels.filter((m) => !inUse.has(baseName(m).toLowerCase()))
    if (!unused.length) {
      setLlamaMsg(tr("没有可清理的模型：目录里每个都被某个供应商用着"))
      return
    }
    const bytes = unused.reduce((s, m) => s + (sizes[m] ?? 0), 0)
    const ask = tr("将删除 {0} 个没有被任何供应商使用的模型，共 {1}：\n{2}\n\n删除后不能恢复。", {
      "0": String(unused.length),
      "1": gb(bytes),
      "2": unused.map((m) => baseName(m)).join('\n')
    })
    if (!window.confirm(ask)) return

    let freed = 0
    const failed: string[] = []
    for (const m of unused) {
      // 逐个删而不是并发：机械盘上并发删大文件反而更慢，也会让失败原因串在一起
      const r = await window.pico.llama.deleteModel(m)
      if (r.ok) freed += r.freedBytes ?? 0
      else failed.push(`${baseName(m)}：${r.message}`)
    }
    await refreshModels()
    setLlamaMsg(
      failed.length
        ? tr("已释放 {0}，但有 {1} 个没删掉：\n{2}", {
            "0": gb(freed),
            "1": String(failed.length),
            "2": failed.join('\n')
          })
        : tr("已清理 {0} 个模型，释放 {1}", { "0": String(unused.length), "1": gb(freed) })
    )
  }

  /**
   * ctx 不传 = 自动定档；传了 = 按这一档启动。
   * ctxExplicit 区分「用户手点的档」和「按建议按钮」之外的内部调用：
   * 手点的档要告诉主进程别在就绪后按实测显存自动升/降档。
   */
  async function runLlama(action: LlamaAction, ctx?: number, ctxExplicit = false) {
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
      } else if (action === 'start') {
        const target = picked || llamaModels[0]
        if (!target) {
          setLlamaMsg(tr("还没有本地模型：点顶部「获取模型」下载，或放进 models/。"))
          return
        }
        setLlamaMsg(
          tr("正在启动 llama-server（{0}）并创建模型配置…", { "0": baseName(target) }) +
            (ctx ? tr(" · 上下文 {0}", { "0": kctx(ctx) }) : '')
        )
        // activate：这是用户主动点的「启动并使用」，启动后必须把这条设成当前模型，
        // 否则回到对话界面还是上一个模型（顶栏、发消息都按 activeId 走）
        const r = await window.pico.llama.start(target, ctx, {
          providerId: 'llamacpp',
          activate: true,
          ctxExplicit
        })
        setLlamaMsg(r.message)
        if (r.ok) {
          if (r.model) setRunningModel(r.model)
          // 配置已落盘：先刷新，模型立刻出现在选择器/设置里
          await onConfigChanged?.()
          // 新实例起来了，顺便把实例与显卡清单捞一遍，界面上立刻能报「哪块卡在跑」
          void window.pico.llama.instances().then((all) => {
            if (alive.current) setRunning(all)
          }).catch(() => undefined)
          void loadDevices()
          // 模型加载放到后台，就绪后再校正一次
          void watchServer()
        }
      } else if (action === 'stop') {
        /**
         * 手动停止。
         *
         * 以前只有空闲卸载这一条路能收回显存，用户开个游戏前得等十分钟。
         * 这里直接调主进程的 stopLlama：它会连同子进程一起收掉并清掉「空闲卸载」记录，
         * 下次发消息走的是正常启动路径，不会被误判成「睡醒了叫起来」。
         */
        setLlamaMsg(tr("正在停止 llama-server…"))
        const r = await window.pico.llama.stop('llamacpp')
        // 停完必须复核：只信返回值的话，进程真没退干净时面板会一直写「未运行」
        const s = await probeStatus().catch(() => null)
        setLlamaMsg(s ? `${r.message}\n${s.message}` : r.message)
        void window.pico.llama.instances().then((all) => {
          if (alive.current) setRunning(all)
        }).catch(() => undefined)
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

  /** 正在跑的那个实例：先按模型名对上，对不上就取第一条（单实例时两条路结果一样） */
  const runningInstance = running.find((r) => sameModel(r.model, runningModel)) ?? running[0] ?? null
  /** 本地模型占用的磁盘总量：看不见体积的话，「清理」就无从下手 */
  const totalBytes = llamaModels.reduce((s, m) => s + (sizes[m] ?? 0), 0)
  /** 它落在哪块卡上 —— 用户问的就是这句，别只给个 CUDA0 */
  const runningGpu = runningInstance ? gpuOf(runningInstance.device) : null
  /** 显卡清单拿不到时（老版本 llama.cpp）退回设备 id，总之别让这一栏空着 */
  const runningGpuLabel = runningGpu?.name ?? (runningInstance?.device ?? '').trim()
  /** 当前实例实际开的上下文：档位行据此高亮，点别的档就是切档重启 */
  const activeCtx = runningInstance?.ctx ?? null
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
        「自动」在「一档都装不下 + 分层关着」时也会 OOM：主进程按装不下就是
        -ngl 999，进程秒退。这里一并禁掉，别只在档位按钮上拦。
      */}
      <button
        type="button"
        className="fit-tier auto"
        disabled={!!llamaBusy || (!!fitReport && !fitCtx && !canLayer)}
        onClick={() => void runLlama('start')}
        title={
          !!fitReport && !fitCtx && !canLayer
            ? tr("整模型装不下任何一档，且分层加载已关闭：先换更小的模型或打开分层")
            : tr("自动定档：按体检建议与实测显存挑一档（默认）")
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
         * - 装不下（灰虚框）：点了会按显存逐层分配。开关关着时禁用并划掉
         * - 超过训练窗口：一律禁用（llama.cpp 会把窗口裁回原生值，标了也是假的）
         */
        const beyond = row.beyondNative === true
        const needsLayer = row.fits === false && !beyond
        const blocked = beyond || (needsLayer && !canLayer)
        const on = activeCtx === row.ctx
        const suggested = fitCtx === row.ctx
        const tight = row.fits === true && row.tight === true
        return (
          <button
            key={row.ctx}
            type="button"
            className={`fit-tier ${row.fits === null ? 'unknown' : blocked ? 'bad' : needsLayer ? 'partial' : 'ok'}${on ? ' on' : ''}${suggested ? ' suggested' : ''}`}
            disabled={!!llamaBusy || blocked}
            onClick={() => void runLlama('start', row.ctx, true)}
            title={
              beyond
                ? tr("这档超过模型训练窗口（{0}），llama.cpp 会把窗口裁回原生值，选它没有意义", {
                    "0": kctx(fitCtx ?? row.ctx)
                  })
                : needsLayer && canLayer
                  ? tr("体检判断 {0} 装不下（需要 {1} / 预算 {2}）：会按显存逐层分配，一部分层留在 CPU/内存，能跑但明显变慢", {
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
                    : tr("以 {0} 上下文启动（{1} tokens），锁定该档、不再自动调档", {
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
          ) : (
            warming && <span className="guide-badge warming">{tr("加载中…")}</span>
          )}
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
        <p className="guide-lead">
          {tr("自动下载解压到")}<code>llama.cpp/</code>{tr("，用本机 GGUF 模型启动服务。")}</p>
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
            （「可更新 → b1234」），颜色只留给「一键启动」这个主按钮。
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
          <button
            className="btn primary"
            disabled={!!llamaBusy}
            onClick={() => void runLlama('start')}
            title={picked ? tr("启动并使用：{0}", { "0": baseName(picked) }) : tr("启动 llama-server")}
          >
            {llamaBusy === 'start' ? tr("启动中…") : tr("一键启动")}
          </button>
          {llamaRunning && (
            <button
              className="btn"
              disabled={!!llamaBusy}
              onClick={() => void runLlama('stop')}
              title={tr("立刻停掉本机 llama-server 并释放显存。下次发消息会自动重新加载，上下文档位保持不变。")}
            >
              {llamaBusy === 'stop' ? tr("停止中…") : tr("停止服务")}
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
        {llamaModels.length > 0 && (
          <div className="guide-pick">
            <div className="guide-pick-head">
              <b>{tr("使用哪个本地模型")}</b>
              <span className="guide-pick-hint">
                {tr("共")}{llamaModels.length} {tr("个，点一下选中")}{llamaRunning && runningModel ? tr(" · 当前运行：{0}", { "0": baseName(runningModel) }) : ''}
                {llamaRunning && runningGpuLabel
                  ? tr(" · 显卡 {0}", { "0": runningGpuLabel })
                  : ''}
              </span>
            </div>
            <div className="guide-disk">
              <span>
                {totalBytes > 0
                  ? tr("{0} 个模型，共占磁盘 {1}", {
                      "0": String(llamaModels.length),
                      "1": gb(totalBytes)
                    })
                  : tr("共 {0} 个模型", { "0": String(llamaModels.length) })}
              </span>
              <button
                type="button"
                className="btn sm"
                onClick={() => void cleanUnused()}
                title={tr("删掉没有被任何供应商引用的模型（配套投影器一起删），删前后都有确认")}
              >
                {tr("清理未使用")}
              </button>
            </div>
            <div className="guide-models">
              {llamaModels.map((m) => {
                const on = sameModel(m, picked)
                const isRunning = llamaRunning && sameModel(m, runningModel)
                const needRestart = on && llamaRunning && !!runningModel && !isRunning
                return (
                  /**
                   * 这里用 div 而不是 button：里面还要放「删除」按钮，
                   * 而 HTML 不允许按钮嵌套按钮（内层点击会冒泡成两层触发）。
                   * 键盘可达性由 role + onKeyDown 补回来。
                   */
                  <div
                    key={m}
                    role="button"
                    tabIndex={0}
                    className={`guide-model ${on ? 'on' : ''}`}
                    onClick={() => {
                      setPicked(m)
                      // 同步到「模型列表」里的下拉框，两边始终是同一个模型
                      onSelectModel?.(baseName(m), 'llamacpp')
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      e.preventDefault()
                      setPicked(m)
                      onSelectModel?.(baseName(m), 'llamacpp')
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
                    <button
                      type="button"
                      className="guide-model-del"
                      title={tr("从磁盘删除这个模型（含配套投影器），不能恢复")}
                      onClick={(e) => {
                        // 不加就同时触发外层的「选中」：删完顺手把模型也切了
                        e.stopPropagation()
                        void removeOne(m)
                      }}
                    >
                      ×
                    </button>
                  </div>
                )
              })}
            </div>
            {picked && (
              <div className="guide-pick-picked">
                {tr("将使用")}<b>{baseName(picked)}</b>
                {llamaRunning && runningModel && !sameModel(picked, runningModel)
                  ? tr("（点「一键启动」会自动停掉当前服务再加载它）")
                  : ''}
              </div>
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
                    title={tr("重新体检（显存被别的程序占用时结果会变）")}
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
                        {/* A 卡 / 核显读不到已用显存时预算按 60% 保守估，不解释一句会被当成「算错了」 */}
                        {fitReport.gpu?.usedUnknown ? (
                          <em className="fit-dim">
                            {tr("（读不到当前已用显存，按总显存 60% 保守估）")}
                          </em>
                        ) : null}
                        {/*
                          服务自己正占着显存，体检只能按「现在还剩多少」算 ——
                          于是档位会集体偏悲观，看起来像「一档都装不下」。
                          不说明的话，用户会以为模型跑不动，其实只是自己占了自己的。
                        */}
                        {llamaRunning ? (
                          <em className="fit-dim">
                            {tr("（本地服务正在跑，剩余显存被它占着；档位会偏保守，重启后才准）")}
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
                            <em className="fit-dim fit-sub">
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
                          <em className="fit-dim fit-sub">
                            {tr("{ctx} 上下文估算约 {n} tok/s", {
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

                    {/* 各档上下文直接可点：点哪档就按哪档重启服务，选中态跟着实际实例走 */}
                    <div className="fit-tier-head">
                      <b>{tr("启动上下文")}</b>
                      <span className="fit-dim">
                        {tr("点一档就按它重启服务，绿=装得下、灰虚框=装不下")}
                      </span>
                      {activeCtx ? (
                        <span className="fit-tier-current">
                          {tr("当前 {0}", { "0": kctx(activeCtx) })}
                        </span>
                      ) : null}
                    </div>
                    {tierButtons(fitReport.tiers)}

                    <div className="fit-foot">
                      {fitCtx ? (
                        <button
                          type="button"
                          className="btn primary"
                          disabled={!!llamaBusy}
                          onClick={() => void runLlama('start', fitCtx, true)}
                          title={tr("按体检算出的上下文启动并锁定该档：{0}", { "0": `${kctx(fitCtx)} tokens` })}
                        >
                          {tr("按建议上下文启动（{0}）", { "0": kctx(fitCtx) })}
                        </button>
                      ) : canLayer && fitReport.tiers?.length ? (
                        /**
                         * 整模型装不下，但开了分层：给一个能点的出口，而不是只留一句
                         * 「换更小的模型」。用最小一档 —— 档越大，KV cache 越会把显存
                         * 挤满，分到 CPU 的层就越多、越慢。
                         */
                        <>
                          <button
                            type="button"
                            className="btn"
                            disabled={!!llamaBusy}
                            onClick={() => void runLlama('start', fitReport.tiers[0].ctx, true)}
                            title={tr(
                              "整模型装不下：按 {0} 启动并交给 llama.cpp 逐层分配，一部分层会留在 CPU，能跑但明显变慢",
                              { "0": kctx(fitReport.tiers[0].ctx) }
                            )}
                          >
                            {tr("按 {0} 分层启动（会变慢）", { "0": kctx(fitReport.tiers[0].ctx) })}
                          </button>
                          <span className="fit-dim">
                            {tr("或换更小的模型 / 更低的量化，速度差好几倍。")}
                          </span>
                        </>
                      ) : (
                        <span className="fit-dim">
                          {tr("一档上下文都装不下，建议换更小的模型或更低的量化。")}
                        </span>
                      )}
                      <span className="fit-dim">
                        {tr("静态推算，实际以加载一次为准")}
                      </span>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* 体检不可用 / 还没算出来时，档位照样能选：切上下文不该依赖 vramfit */}
            {picked && !fitReport && !fitBusy && (
              <div className="fit-box">
                <div className="fit-tier-head">
                  <b>{tr("启动上下文")}</b>
                  <span className="fit-dim">{tr("体检没出来，仍可直接选一档启动")}</span>
                  {activeCtx ? (
                    <span className="fit-tier-current">
                      {tr("当前 {0}", { "0": kctx(activeCtx) })}
                    </span>
                  ) : null}
                </div>
                {tierButtons(FALLBACK_TIERS.map((ctx) => ({ ctx, needBytes: null, fits: null })))}
              </div>
            )}
          </div>
        )}
        <p className="guide-note">
          {tr("端口留空自动探测；两个实例绑不同显卡即可同时跑。.gguf 放进")}<code>models/</code> {tr("或")}<code>llama.cpp/</code> {tr("即可识别。")}</p>
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
        desc={tr("没装就先「一键安装 / 下载」，再点「一键启动」。")}
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
        desc={tr("自带 Local Server：装好后点「一键启动」即可。")}
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
