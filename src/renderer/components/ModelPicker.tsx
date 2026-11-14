import { t as tr } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import { shortGpuName } from '../../shared/ollamagpu'
import type { LocalGpuSnapshot, ProviderConfig, RunningLocalModel } from '../../shared/types'

export type ProbeState = 'checking' | 'ok' | 'fail'

/**
 * 状态点：绿 = 模型已加载在跑，黄 = 能用但没启动，红叉 = 连不上 / 模型不存在。
 *
 * 探活通过（ok）只能说明「端点通、模型在列表里」——Ollama / LM Studio 的列表列的是
 * **已下载**的模型，没加载的连一兆显存都没占，给它绿灯会让人以为它在跑。
 */
export type DotState = ProbeState | 'running' | 'ready'

export interface ProbeInfo {
  state: ProbeState
  error?: string
  /** 探活时主进程顺带判断的「模型是否真的加载着」；本地服务才有 */
  running?: boolean
  /** 本地服务装了但没起来：能用，只是没启动 */
  idle?: boolean
}

export function StatusDot({ state, error, title }: { state: DotState; error?: string; title?: string }) {
  if (state === 'running' || state === 'ok') {
    return <span className="dot ok" title={title ?? (state === 'running' ? tr("运行中") : tr("可用"))} />
  }
  if (state === 'ready') {
    return <span className="dot ready" title={title ?? tr("可用，尚未启动")} />
  }
  if (state === 'fail') {
    return (
      <span className="dot fail" title={error ? tr("不可用：{error}", { error: error }) : tr("不可用")}>
        <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M1.8 1.8l6.4 6.4M8.2 1.8l-6.4 6.4"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
      </span>
    )
  }
  return <span className="dot checking" title={tr("检测中")} />
}

/** 小显卡图标：模型菜单里区分「跑在哪张卡上」比文字更快认出来 */
function GpuIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="1.2" y="3.2" width="9.6" height="5.6" rx="1.1" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="4.4" cy="6" r="1.1" stroke="currentColor" strokeWidth="1" />
      <path d="M7.6 4.9h2M7.6 7.1h2" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
}

interface Props {
  providers: ProviderConfig[]
  activeId: string | null
  probes: Record<string, ProbeInfo>
  onSelect: (id: string) => void
  onRefresh: () => void
  /** 一个模型都没有时，引导去模型设置 */
  onOpenSettings?: () => void
}

type Device = { id: string; name: string; vramMiB?: number; freeMiB?: number }
type Instance = { key: string; port: number; model: string; device: string; pid: number | null; ctx: number }

/** 模型名对齐：Ollama 的 `/api/ps` 一定带 tag，配置里的名字可能省略 `:latest` */
const normModelName = (s?: string): string => (s ?? '').trim().toLowerCase().replace(/:latest$/, '')

/** 只认本机服务：配了远程地址的「Ollama」条目，本机这份运行清单跟它没关系 */
const isLoopbackUrl = (url?: string): boolean =>
  !url || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(url)

/** 6.3 GB，显存说明用 */
const gb = (n: number): string => `${(n / 1024 ** 3).toFixed(1)} GB`

export function ModelPicker({ providers, activeId, probes, onSelect, onRefresh, onOpenSettings }: Props) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)
  /** llama.cpp 认到的设备（CUDA0 / Vulkan0 …），用来把配置里的 device 翻译成人能看的显卡名 */
  const [devices, setDevices] = useState<Device[]>([])
  /** 正在跑的实例：配置里没绑卡时，这里才有「实际落到哪张卡、哪个端口」的答案 */
  const [instances, setInstances] = useState<Instance[]>([])
  /**
   * Ollama / LM Studio 里已经加载的模型 + 服务认到的显卡。
   * 这两家不是本程序拉起来的，没有 device 字段，只能问服务自己。
   */
  const [local, setLocal] = useState<LocalGpuSnapshot>({
    running: false,
    devices: [],
    guessed: false,
    models: [],
    loaded: []
  })
  /**
   * 实时数据（实例 / 已加载清单）到底问到过没有。
   * 问不到时按探活结果兜底，否则每次 IPC 出错都会把在跑的模型误判成「没启动」。
   */
  const [liveReady, setLiveReady] = useState(false)

  // 设备清单基本不变，进界面读一次就够
  useEffect(() => {
    let alive = true
    void window.pico?.llama
      ?.devices?.()
      .then((list) => {
        if (alive) setDevices(list ?? [])
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  // 实例会随启动 / 退出变化：展开菜单时、挂载时各问一遍，之后每 15 秒刷一次
  // （现在只有真在跑的实例才显示显卡，不轮询的话，从本地模型页启动后顶栏会一直不亮）
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.pico?.llama
        ?.instances?.()
        .then((list) => {
          if (!alive) return
          setInstances(list ?? [])
          setLiveReady(true)
        })
        .catch(() => undefined)
    }
    load()
    const id = window.setInterval(load, 15000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [open])

  // 本地服务加载了哪个模型、占了多少显存：换模型 / 空闲卸载都会变，跟着菜单开关刷一次
  const hasOllama = providers.some((p) => p.kind === 'ollama' || p.runtime === 'ollama')
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.pico?.local
        ?.gpu?.()
        .then((snap) => {
          if (!alive || !snap) return
          setLocal(snap)
          setLiveReady(true)
        })
        .catch(() => undefined)
    }
    load()
    // 没装 Ollama 的机器不用轮询；有的话 15 秒问一次，模型被换掉 / 空闲卸载后标签能自己变
    if (!hasOllama) {
      return () => {
        alive = false
      }
    }
    const id = window.setInterval(load, 15000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [open, hasOllama])

  /** 这条 Ollama 配置的模型当前加载着吗？没加载 = 还没占显卡 */
  /** 这条配置是不是本机常驻服务（Ollama）：它们由外部进程托管，没有 device 字段 */
  function isResident(p: ProviderConfig): boolean {
    if (p.runtime === 'llama') return false
    if (p.kind !== 'ollama' && p.runtime !== 'ollama') return false
    return isLoopbackUrl(p.baseUrl)
  }

  /**
   * 这条 Ollama 配置的模型**现在真的加载着**吗？
   * 没加载就没有「用了哪张卡」这回事 —— 显存一点都没占，报卡名是假的。
   */
  function loadedOf(p: ProviderConfig): RunningLocalModel | null {
    if (!isResident(p)) return null
    const want = normModelName(p.model)
    if (!want) return null
    return local.models.find((r) => normModelName(r.model) === want) ?? null
  }

  /** 这条配置是不是跑在本机：远程 API 一直在线，没有「启动了没有」这回事 */
  function isLocalProvider(p: ProviderConfig): boolean {
    if (p.runtime === 'llama') return true
    if (p.kind === 'ollama' || p.runtime === 'ollama') return isLoopbackUrl(p.baseUrl)
    if (p.runtime === 'lmstudio') return isLoopbackUrl(p.baseUrl)
    // 老配置里 LM Studio 常被写成 openai + 1234 / 1235 端口
    if (p.id === 'lmstudio') return isLoopbackUrl(p.baseUrl)
    const port = Number(/:(\d+)(?:\/|$)/.exec(p.baseUrl || '')?.[1] ?? 0)
    return isLoopbackUrl(p.baseUrl) && (port === 1234 || port === 1235)
  }

  /** 这条配置的模型**此刻真的在跑**吗：llama.cpp 看活的实例，常驻服务看已加载清单 */
  function runningOf(p: ProviderConfig): boolean {
    if (p.runtime === 'llama') return instances.some((i) => i.key === p.id)
    const want = normModelName(p.model)
    if (!want) return false
    return local.loaded.some((l) => normModelName(l.model) === want)
  }

  /**
   * 状态点：探活负责「能不能用」，实时数据负责「在不在跑」。
   * 实时数据还没到手时（首次挂载那一瞬间）退回探活结果，别把在跑的模型误标成待启动。
   */
  function dotOf(p: ProviderConfig | null, probe?: ProbeInfo): DotState {
    if (!probe) return 'checking'
    if (probe.state === 'checking') return 'checking'
    // 装了但没启动：黄灯。红叉只给真的跑不了的（没装 / 模型不存在 / 端口被占）
    if (probe.state === 'fail') return probe.idle ? 'ready' : 'fail'
    if (!p || !isLocalProvider(p)) return 'ok'
    const live = liveReady ? runningOf(p) : probe.running === true
    // llama.cpp 的实例表只记本进程拉起的进程：端口上已经有服务（残留进程 / 手动启动）时
    // 表是空的，但探活说在跑 —— 这种情况不能标成「未启动」
    const alive = p.runtime === 'llama' ? live || probe.running === true : live
    return alive ? 'running' : 'ready'
  }

  /**
   * 已加载模型的显卡标签：这里的卡是「实测结论」，
   * 显存只占了一部分时要说清楚（部分层还在内存里跑，速度会明显更慢）。
   */
  function liveGpu(r: RunningLocalModel): { text: string; title: string } {
    if (r.vramBytes <= 0) {
      return { text: 'CPU', title: tr("模型现在跑在内存里（没占到显存）：{0}", { "0": r.model }) }
    }
    const pct = r.sizeBytes > 0 ? Math.min(100, Math.round((r.vramBytes / r.sizeBytes) * 100)) : 100
    const names = r.devices
    const head = names[0] ? shortGpuName(names[0]) : 'GPU'
    const text = names.length > 1 ? `${head} +${names.length - 1}` : head
    const facts = [
      tr("运行中：{0}", { "0": r.model }),
      r.sizeBytes > 0
        ? tr("显存 {0} / {1}", { "0": gb(r.vramBytes), "1": gb(r.sizeBytes) })
        : tr("显存 {0}", { "0": gb(r.vramBytes) }),
      pct >= 95 ? tr("全部在显卡上") : tr("只有 {0}% 在显卡上，其余在内存", { "0": String(pct) }),
      names.length > 1 ? tr("用到 {0} 张卡", { "0": String(names.length) }) : '',
      names.length ? names.join('、') : tr("型号没读到，只确认占用了显存"),
      r.guessed ? tr("显卡名按本机推断") : ''
    ].filter(Boolean)
    return { text, title: facts.join(' · ') }
  }

  /**
   * 这条配置跑在哪张卡上。
   *
   * 判据只有一条：**现在真的在跑**。
   * - Ollama：模型在 `/api/ps` 里（加载着）才有答案，没加载就一点显存没占，报卡名是假的
   * - llama.cpp：本进程里有活的实例才算，停掉的条目不再显示上一轮的卡
   * 多卡并行时每个条目各报自己的卡：两条配置分别绑 CUDA0 / CUDA1，就各显示各的。
   */
  function gpuOf(p: ProviderConfig): { text: string; title: string } | null {
    const live = loadedOf(p)
    if (live) return liveGpu(live)
    if (isResident(p)) return null
    if (p.runtime !== 'llama') return null

    const inst = instances.find((i) => i.key === p.id)
    // 没在跑：不显示显卡。绑没绑卡是配置，不是现状
    if (!inst) return null

    const suffix = tr(" · 运行中 :{0} · {1}K 上下文", { "0": inst.port, "1": String(Math.round(inst.ctx / 1024)) })
    const raw = (inst.device || '').trim()
    if (!raw) {
      const auto = devices[0]
      // 没绑卡（auto）：实际就是 list-devices 的第一块，写清楚这是自动选的
      if (!auto) return { text: tr("自动"), title: tr("运行中，由 llama.cpp 自动选择") + suffix }
      return {
        text: auto.name.replace(/^NVIDIA\s+(GeForce\s+)?/i, ''),
        title: tr("运行中，由 llama.cpp 自动选择（{0}）", { "0": auto.name }) + suffix
      }
    }
    if (raw.toUpperCase() === 'CPU') {
      return { text: 'CPU', title: tr("运行在处理器上，不占显存") + suffix }
    }
    const low = raw.toLowerCase()
    const hit =
      devices.find((d) => d.id.toLowerCase() === low) ??
      devices.find((d) => low.startsWith(d.id.toLowerCase()) || d.id.toLowerCase().startsWith(low)) ??
      null
    if (!hit) return { text: raw, title: tr("已绑定显卡：{0}", { "0": raw }) + suffix }
    const mem =
      hit.vramMiB && hit.vramMiB > 0 ? tr("{0} GB 显存", { "0": (hit.vramMiB / 1024).toFixed(0) }) : ''
    return {
      // 名字去掉 NVIDIA / GeForce 前缀，顶栏那个小胶囊才放得下
      text: hit.name.replace(/^NVIDIA\s+(GeForce\s+)?/i, ''),
      title: tr("已绑定显卡：{0}（{1}）{2}", { "0": hit.name, "1": hit.id, "2": mem }) + suffix
    }
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const empty = providers.length === 0
  const active = providers.find((p) => p.id === activeId) ?? providers[0] ?? null
  const activeProbe = probes[active?.id ?? ''] ?? { state: 'checking' as ProbeState }
  const activeGpu = active ? gpuOf(active) : null

  return (
    <div className="model-picker" ref={boxRef}>
      <button
        className={`model-trigger ${open ? 'open' : ''}`}
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) onRefresh()
        }}
        title={activeGpu ? tr("切换模型 · 当前显卡：{0}", { "0": activeGpu.text }) : tr("切换模型")}
      >
        {empty ? (
          <span className="model-trigger-warn">!</span>
        ) : (
          <StatusDot state={dotOf(active, activeProbe)} error={activeProbe.error} />
        )}
        <span className="model-trigger-text">
          {empty ? tr("还没有模型 · 点这里添加") : active ? tr("{name} · {1}", { name: active.name, "1": active.model || tr("未选择模型") }) : tr("未配置模型")}
        </span>
        {activeGpu && (
          <span className="model-trigger-gpu" title={activeGpu.title}>
            <GpuIcon />
            <span className="gpu-label">{activeGpu.text}</span>
          </span>
        )}
        <svg className="chev" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="model-menu">
          <div className="model-menu-head">
            <span>{tr("选择模型")}</span>
            <button
              className="model-menu-refresh"
              onClick={() => onRefresh()}
              title={tr("重新检测可用性")}
            >
              {tr("重新检测")}</button>
          </div>
          {empty && (
            <div className="model-menu-empty">
              <div className="model-menu-empty-title">{tr("还没有任何模型")}</div>
              <div className="model-menu-empty-tip">{tr("请点击模型设置 添加模型")}</div>
              {onOpenSettings && (
                <button
                  className="btn primary sm"
                  onClick={() => {
                    setOpen(false)
                    onOpenSettings()
                  }}
                >
                  {tr("打开模型设置")}</button>
              )}
            </div>
          )}
          {providers.map((p) => {
            const probe = probes[p.id] ?? { state: 'checking' as ProbeState }
            const dot = dotOf(p, probe)
            const gpu = gpuOf(p)
            return (
              <button
                key={p.id}
                className={`model-item ${p.id === active?.id ? 'active' : ''}`}
                onClick={() => {
                  onSelect(p.id)
                  setOpen(false)
                }}
              >
                <StatusDot state={dot} error={probe.error} />
                <span className="model-item-body">
                  <span className="model-item-name">
                    {p.name}
                    <span className="model-item-id">{p.model || tr("未选择模型")}</span>
                  </span>
                  {gpu && (
                    <span className="model-item-gpu" title={gpu.title}>
                      <GpuIcon />
                      <span className="gpu-label">{gpu.text}</span>
                    </span>
                  )}
                  {probe.state === 'checking' && (
                    <span className="model-item-state checking">{probe.error ?? tr("正在检测…")}</span>
                  )}
                  {probe.state === 'ok' && (
                    <span className={`model-item-state ${dot === 'running' ? 'ok' : 'ready'}`}>
                      {dot === 'running' ? tr("运行中") : tr("可用 · 未启动")}
                    </span>
                  )}
                  {probe.state === 'fail' && probe.error && (
                    // 未启动用黄字，别和「连不上 / 模型不存在」混成一个颜色
                    <span className={probe.idle ? 'model-item-state ready' : 'model-item-error'}>
                      {probe.error}
                    </span>
                  )}
                </span>
                {p.id === active?.id && <span className="model-item-check">{tr("当前")}</span>}
              </button>
            )
          })}
          {!empty && (
            <div className="model-menu-foot">
              {tr("绿点=模型已加载在跑，黄点=可用但没启动，红叉=连不上或模型不存在")}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
