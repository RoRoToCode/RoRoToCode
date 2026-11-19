import { t as tr } from '../i18n'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppConfig, LlamaDevice, ProviderConfig, ProviderKind } from '../../shared/types'
import {
  deviceClash,
  deviceList,
  isLlamaProvider,
  isLoopbackUrl,
  isMultiDevice,
  LLAMA_PORTS,
  runtimeKindOf,
} from '../../shared/providers'
import { StatusDot, type ProbeInfo, type ProbeState } from './ModelPicker'
import { LocalModels, type LocalModelsHandle } from './LocalModels'
import { ModelSpecs } from './ModelSpecs'
import { BaseTools } from './BaseTools'
import { ExternalAccess } from './ExternalAccess'
import { Chevron, useCollapse } from './Collapse'
import { ModelCombo } from './ModelCombo'

/** 四个标签页：原来「模型引导」里的三块并入设置，原供应商列表变成第 4 页 */
const TABS = [
  {
    key: 'base',
    get label() {
      return tr('① 基础核心')
    },
  },
  {
    key: 'local',
    get label() {
      return tr('② 本地模型')
    },
  },
  {
    key: 'api',
    get label() {
      return tr('③ 线上模型')
    },
  },
  {
    key: 'list',
    get label() {
      return tr('④ 模型列表')
    },
  },
] as const
export type TabKey = (typeof TABS)[number]['key']

/** 设置页里的大段说明默认收起，点标题展开：不占地方，需要时还能查到 */
function Fold({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const [open, toggle] = useCollapse(`settings-${id}`, false)
  return (
    <div className={`guide-fold ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="guide-fold-head"
        onClick={toggle}
        title={open ? tr('收起') : tr('展开')}
      >
        <span>{title}</span>
        <Chevron open={open} />
      </button>
      {open && <div className="guide-fold-body">{children}</div>}
    </div>
  )
}

function Code({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    const clip = navigator.clipboard
    if (!clip) return
    void clip.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <div className="guide-code">
      <code>{text}</code>
      <button className="guide-copy" onClick={copy}>
        {copied ? tr('已复制') : tr('复制')}
      </button>
    </div>
  )
}

function Link({ href }: { href: string }) {
  return (
    <a className="guide-link" href={href} target="_blank" rel="noreferrer">
      {href}
    </a>
  )
}

interface Props {
  config: AppConfig
  probes: Record<string, ProbeInfo>
  modelCache: Record<string, string[]>
  onRefresh: () => void
  onConfigChanged: () => void | Promise<void>
  onClose: () => void
  onSave: (config: AppConfig) => Promise<void>
  /** 打开时默认停在哪个标签页（首次运行引导会直接落到「① 基础核心」） */
  initialTab?: TabKey
}

const KIND_LABEL: Record<ProviderKind, string> = {
  get openai() {
    return tr('OpenAI 兼容')
  },
  anthropic: 'Anthropic',
  ollama: 'Ollama / LM Studio',
}

// 每个供应商一个可辨识的颜色（按原始顺序分配，排序后不变）
const PALETTE = [
  '#7c9cf5',
  '#4ec9b0',
  '#e0a458',
  '#c586c0',
  '#6ec1e4',
  '#d7ba7d',
  '#8fd16b',
  '#f07178',
]

const RANK: Record<ProbeState, number> = { ok: 0, checking: 1, fail: 2 }

/** 只看文件名：配置里存的、扫描到的可能是绝对路径 */
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p

/** 本地运行的三家：llama.cpp 自己管进程，Ollama / LM Studio 是常驻服务 */
type RtKind = 'llama' | 'ollama' | 'lmstudio'

const RT_LABEL: Record<RtKind, string> = {
  llama: 'llama.cpp',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
}
const RT_PORT: Record<RtKind, number> = {
  llama: 8080,
  ollama: 11434,
  lmstudio: 1234,
}

/** 供应商 → 本地运行环境（远程 API 返回 null） */
function runtimeOf(p: ProviderConfig): RtKind | null {
  if (isLlamaProvider(p)) return 'llama'
  const kind = runtimeKindOf(p)
  if (kind) return kind
  // 老配置里 kind='ollama' 但 id 是自定义名的，仍按 Ollama 处理
  return p.kind === 'ollama' ? 'ollama' : null
}

interface RtState {
  models: string[]
  running: boolean
  installed: boolean
  /** LM Studio 的真实端口可能是 1235（1234 被占用时它会自己换） */
  port?: number
}

/**
 * 把磁盘上的配置合并进当前草稿：
 * 新增的供应商（如引导面板一键创建的本地方案）直接补进来，
 * 已有的只补空字段，避免覆盖用户正在编辑的内容。
 *
 * 例外是「模型名」：在「② 本地模型」页点选并启动后会直接写盘，
 * 这时磁盘才是最新状态，除非用户在本面板里刚手动改过这一项（`touched`）。
 */
function mergeDraft(
  prev: AppConfig,
  disk: AppConfig,
  touched: Set<string>,
  keepActive = false,
  dropped?: Set<string>,
): AppConfig {
  const known = new Set(prev.providers.map((p) => p.id))
  const providers = prev.providers.map((p) => {
    const d = disk.providers.find((x) => x.id === p.id)
    if (!d) return p
    const model = touched.has(p.id) ? p.model || d.model : d.model || p.model
    return { ...p, model, baseUrl: p.baseUrl || d.baseUrl }
  })
  for (const d of disk.providers) {
    if (known.has(d.id)) continue
    /**
     * 用户刚在面板里删掉、还没保存的条目不能在合并时回来。
     *
     * 删是草稿操作，而「自动配置 / 保存到列表」会顺手 syncFromDisk ——
     * 不挡住的话，磁盘上那条立刻被并回草稿，看起来就像「删了自动重建」。
     */
    if (dropped?.has(d.id)) continue
    providers.push({ ...d })
  }
  // 用户在本面板里点过「使用」：那是没保存的显式选择，不能被后台写盘的 activeId 顶掉
  return {
    ...prev,
    providers,
    activeId: keepActive ? prev.activeId : (disk.activeId ?? prev.activeId),
  }
}

export function Settings({
  config,
  probes,
  modelCache,
  onRefresh,
  onConfigChanged,
  onClose,
  onSave,
  initialTab = 'list',
}: Props) {
  const [draft, setDraft] = useState<AppConfig>(
    () => JSON.parse(JSON.stringify(config)) as AppConfig,
  )
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)
  // 用户在本面板手动「拉取模型列表」后追加的缓存（优先于全局探测缓存）
  const [modelList, setModelList] = useState<Record<string, string[]>>({})
  // 每个供应商面板是否展开（默认全部折叠）
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  /** 当前标签页：默认落在「模型列表」，和以前打开设置就看到列表一致 */
  const [tab, setTab] = useState<TabKey>(initialTab)
  /** 「获取模型」面板（读本机参数、下载模型） */
  const [specsOpen, setSpecsOpen] = useState(false)
  /** 本地模型页的句柄：顶部「刷新」按钮直接调它重扫 */
  const localRef = useRef<LocalModelsHandle>(null)
  /** 顶部「刷新」进行中 */
  const [refreshing, setRefreshing] = useState(false)
  // 各供应商的本地运行状态（模型列表 / 服务是否在跑 / 装了没）。
  // 按 providerId 存而不是按运行时类型：双卡双模型时两台 llama.cpp 各跑各的，
  // 用类型当 key 会让两个卡片显示同一个实例的状态。
  const [rt, setRt] = useState<Record<string, RtState>>({})
  const [rtBusy, setRtBusy] = useState<string | null>(null)
  /** 正在启停的那条 llama.cpp 实例：这一页是全程序唯一的启动/停止入口 */
  const [llamaBusyId, setLlamaBusyId] = useState<string | null>(null)
  /** 各 llama.cpp 实例当前实际加载的模型文件名 */
  const [served, setServed] = useState<Record<string, string>>({})
  /**
   * 可分配的设备（值就是 -dev 认的名字：CUDA0 / CUDA1 / Vulkan1 …）。
   * 「绑定显卡」不再由用户手选：这份清单只用于新建实例时自动挑卡，
   * 以及「② 本地模型」页的卡槽展示。
   */
  const [devices, setDevices] = useState<LlamaDevice[]>([])

  // 始终指向最新的草稿，供异步回调读取（避免闭包拿到旧值）
  const draftRef = useRef(draft)
  draftRef.current = draft
  // 本面板里用户手动改过模型名的供应商：合并磁盘配置时不覆盖它
  const touchedModels = useRef<Set<string>>(new Set())
  /**
   * 本面板里点过「使用」但还没保存：这是用户的显式选择。
   * 本地模型卡片写盘后会触发 syncFromDisk，它拿磁盘的 activeId 合并草稿 ——
   * 不挡住的话，刚点好的「当前使用」会被悄悄换回上一个模型。
   */
  const touchedActive = useRef(false)
  /**
   * 本面板里删掉、还没保存的条目。
   *
   * 删除只是改草稿；「自动配置 / 保存到列表」会 syncFromDisk 把磁盘配置并回来，
   * 那条刚删的条目就会重新出现 —— 用户看到的是「删了自动重建」。
   * 记下来，合并时跳过。
   */
  const removed = useRef<Set<string>>(new Set())

  // 「② 本地模型」页的「自动配置 / 保存到列表」会直接写盘，这里把结果合并进草稿，
  // 让新建的本地模型立刻出现在列表里（并滚动过去）
  async function syncFromDisk() {
    await onConfigChanged()
    const disk = await window.pico.config.get()
    const known = new Set(draftRef.current.providers.map((p) => p.id))
    const added = disk.providers.filter((p) => !known.has(p.id)).map((p) => p.id)
    setDraft((prev) =>
      mergeDraft(prev, disk, touchedModels.current, touchedActive.current, removed.current),
    )
    // 本地服务可能换了模型 / 换了服务，重新读一次状态，两边标记才一致
    void refreshAllRuntimes()
    if (added.length) {
      setExpanded((prev) => ({
        ...prev,
        ...Object.fromEntries(added.map((id) => [id, true])),
      }))
      window.setTimeout(() => {
        document
          .getElementById(`prov-${added[0]}`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }, 100)
    }
  }

  // 模型列表：手动拉取的优先，其次用全局探测时顺带拿到的
  const modelsFor = (id: string): string[] | undefined => modelList[id] ?? modelCache[id]

  function patchProvider(id: string, patch: Partial<ProviderConfig>) {
    setDraft((prev) => ({
      ...prev,
      providers: prev.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }))
  }

  /**
   * 新增一个本地 llama.cpp 实例。
   *
   * 「多卡多模型」的前提是每个模型各占一个独立实例：必须真的造一条新供应商
   * （runtime='llama'），而不是改现有那条的绑定显卡 —— 后者只是把同一个实例
   * 挪到另一张卡上，另一张卡仍然空着，也跑不了第二个模型。
   *
   * 端口按 LLAMA_PORTS 往后排，但不写 provider.port（只写进 baseUrl）：
   * 写死 port 会被当成「用户手动指定」，一旦被占用就直接报错而不是自动避让，
   * 多实例场景里这只会制造莫名其妙的启动失败。
   *
   * 端口和显卡都改由程序自动给值（设置页不再提供这两项）：端口挑没被占用的那个，
   * 显卡挑空闲显存最大、且没被别的实例占住的那张。
   */
  function addLlamaProvider(): void {
    const used = draft.providers.filter((p) => isLlamaProvider(p))
    /**
     * 端口改为自动挑空位：设置页不再提供「实例端口」。
     * 按实例数量排会在删过实例之后撞上正在用的端口（pickLlamaSlot 早就改成按已用端口算了）。
     */
    const usedPorts = new Set<number>()
    for (const p of used) {
      const m = /:(\d+)(?:\/|$)/.exec(p.baseUrl || '')
      if (m) usedPorts.add(Number(m[1]))
    }
    const port = LLAMA_PORTS.find((x) => !usedPorts.has(x)) ?? LLAMA_PORTS[LLAMA_PORTS.length - 1]
    const id = `llamacpp-${Date.now().toString(36)}`
    /**
     * 「绑定显卡」不再由用户手选，这里必须给出确定答案，不能留空。
     *
     * - 已有「自动」实例（device 为空）要钉到第一张卡：主进程的并存判据是
     *   「两条都绑了卡、且不是同一张」，只要还留一条空 device，起新实例就会把它停掉。
     * - 新实例从剩下的空闲卡里挑**空闲显存最大**的那张：装不下大模型比换张卡更糟。
     * - 两张卡都空着时也不能留空，否则两个实例都落到 CUDA0，等于白开第二个。
     * - 合并实例占的是整组卡（`CUDA0,CUDA1`），用 deviceClash 按卡组比，
     *   字符串相等会认不出 `CUDA1` 已被占。
     */
    const unpinned = used.filter((p) => !(p.device ?? '').trim()).length
    const pinFirst = unpinned > 0 && devices.length >= 2 ? devices[0].id : undefined
    const taken = (dev: string): boolean =>
      (pinFirst !== undefined && dev.toLowerCase() === pinFirst.toLowerCase()) ||
      used.some((p) => Boolean((p.device ?? '').trim()) && deviceClash(dev, p.device))
    const free = devices.filter((d) => !taken(d.id))
    const autoDevice = free.length
      ? [...free].sort((a, b) => (b.freeMiB ?? b.vramMiB ?? 0) - (a.freeMiB ?? a.vramMiB ?? 0))[0]
          .id
      : undefined
    setDraft((prev) => {
      const providers = prev.providers.map((p) => {
        if (!isLlamaProvider(p) || (p.device ?? '').trim() || !pinFirst) return p
        return { ...p, device: pinFirst }
      })
      return {
        ...prev,
        providers: [
          ...providers,
          {
            id,
            name: tr('llama.cpp 实例 {n}', {
              n: prev.providers.filter((p) => isLlamaProvider(p)).length + 1,
            }),
            runtime: 'llama',
            kind: 'openai',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: '',
            device: autoDevice,
            contextWindow: 32768,
            temperature: 0.2,
          },
        ],
      }
    })
    setExpanded((prev) => ({ ...prev, [id]: true }))
    setTab('list')
    if (unpinned && pinFirst) {
      setNote({
        text: tr(
          '已把原来的「自动」实例固定到 {a}，新实例自动绑到 {b}：两个实例各占一张卡才会并存',
          {
            a: pinFirst,
            b: autoDevice ?? tr('自动分配'),
          },
        ),
        kind: 'ok',
      })
    }
    window.setTimeout(() => {
      document.getElementById(`prov-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 80)
  }

  /**
   * 「② 本地模型」页点一张卡：把这张卡变成「现在给它选模型」的那条实例。
   *
   * 和 addLlamaProvider 的区别：那个是「再开一个」（会切页、会滚动到卡片）；
   * 这里是「就用这张卡」，留在原地、幂等 —— 同一张卡点两次不会多出一条。
   *
   * 返回值是实例 id，让本地模型面板当帧就切过去，不用等草稿重渲染。
   */
  function pickLlamaSlot(deviceId: string): string {
    const low = deviceId.trim().toLowerCase()
    const list = draftRef.current.providers
    /**
     * 点卡等于用户显式指定「现在用这条」，和列表里点「使用」是同一件事。
     * 不设这个标记的话，紧接着的一次 syncFromDisk（启动实例后就会触发）
     * 会把草稿里的 activeId 顶回磁盘值，面板自己跳回第一张卡。
     */
    touchedActive.current = true
    /**
     * 这张卡已经被谁占了 —— 按**卡组**判断，不是按字符串相等。
     *
     * 合并实例的 device 是 `CUDA0,CUDA1`，用 `=== 'cuda1'` 比较会认不出来，
     * 于是点第二张卡会新开一条实例去跟合并实例抢同一张卡。
     */
    const pinned = list.find(
      (p) => isLlamaProvider(p) && deviceList(p.device).some((d) => d.toLowerCase() === low),
    )
    if (pinned) {
      setDraft((prev) => ({ ...prev, activeId: pinned.id }))
      return pinned.id
    }
    /**
     * 「自动」实例实际就跑在第一张卡上(不传 -dev 时 llama.cpp 挑第一块)，
     * 所以点第一张卡应该把这条钉住，而不是再建一条。
     *
     * 否则两条都落到 CUDA0：主进程起第二个实例时会把第一个停掉，
     * 用户看到的是「我的主模型突然没了」，根本联想不到是卡槽点重了。
     */
    const autoP = list.find((p) => isLlamaProvider(p) && !(p.device ?? '').trim())
    if (autoP && (devices[0]?.id ?? '').trim().toLowerCase() === low) {
      setDraft((prev) => ({
        ...prev,
        activeId: autoP.id,
        providers: prev.providers.map((p) => (p.id === autoP.id ? { ...p, device: deviceId } : p)),
      }))
      return autoP.id
    }
    /**
     * 这张卡还空着：新开一条实例绑它。
     * 端口按「已用端口」往后排而不是按实例数量 —— 删过实例之后，
     * 按数量排会直接撞到正在用的端口，表现为启动时莫名其妙的端口占用失败。
     */
    const used = list.filter((p) => isLlamaProvider(p))
    const usedPorts = new Set<number>()
    for (const p of used) {
      const m = /:(\d+)(?:\/|$)/.exec(p.baseUrl || '')
      if (m) usedPorts.add(Number(m[1]))
    }
    const port = LLAMA_PORTS.find((x) => !usedPorts.has(x)) ?? LLAMA_PORTS[LLAMA_PORTS.length - 1]
    const id = `llamacpp-${Date.now().toString(36)}`
    /**
     * 顺手把「自动」的那条钉到第一张卡。主进程的并存判据是「两条都绑了卡、
     * 且不是同一张」—— 只要还留着一条 device 为空，起新实例时就会把它停掉，
     * 用户看到的是「给第二张卡选了个模型，第一张卡的模型没了」。
     */
    const pinFirst = devices.length >= 2 ? devices[0]?.id : undefined
    setDraft((prev) => ({
      ...prev,
      activeId: id,
      providers: [
        ...prev.providers.map((p) =>
          isLlamaProvider(p) && !(p.device ?? '').trim() && pinFirst
            ? { ...p, device: pinFirst }
            : p,
        ),
        {
          id,
          name: `${tr('llama.cpp')} · ${deviceId}`,
          runtime: 'llama',
          kind: 'openai',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: '',
          device: deviceId,
          contextWindow: 32768,
          temperature: 0.2,
        },
      ],
    }))
    return id
  }

  /**
   * 切换「合并多卡 / 一卡一模型」。
   *
   * 只改 `device` 字段：单卡是 `CUDA1`，合并是 `CUDA0,CUDA1`。不引入额外的
   * 布尔开关 —— 如果两个字段并存，早晚会出现「开关是合并、device 只有一张卡」
   * 这种自相矛盾的配置，主进程还得再猜一次谁说了算。
   *
   * 改完立刻落盘：主进程启动时按磁盘配置读供应商，只改草稿会出现
   * 「界面显示合并成功，启动出来还是单卡」。
   */
  async function toggleMultiGpu(
    providerId: string,
    on: boolean,
  ): Promise<{ ok: boolean; message?: string }> {
    const list = draftRef.current.providers
    const target = list.find((p) => p.id === providerId && isLlamaProvider(p))
    if (!target) return { ok: false, message: tr('找不到这个本地实例，先刷新一下再试') }
    const ids = devices.map((d) => d.id)
    if (on && ids.length < 2) return { ok: false, message: tr('只有一张可用显卡，合并没有意义') }
    /**
     * 拆开时保留原来卡组里的第一张：模型在哪张卡上跑过，拆完就继续在哪张上跑，
     * 不要突然换到清单里的第一张（异构机器上那是另一块完全不同的卡）。
     */
    const keep = deviceList(target.device)[0] ?? ids[0] ?? ''
    const nextDevice = on ? ids.join(',') : keep
    if (!nextDevice) return { ok: false, message: tr('没有可用显卡，无法绑定') }
    const providers = list.map((p) => (p.id === target.id ? { ...p, device: nextDevice } : p))
    const next = { ...draftRef.current, providers }
    setDraft(next)
    touchedActive.current = true
    try {
      await onSave(next)
    } catch (err) {
      return {
        ok: false,
        message: tr('配置没保存成功：{0}', { '0': (err as Error).message }),
      }
    }
    /**
     * 冲突要说清楚：合并会占住**所有**卡，别的实例再启动时会把这条停掉，
     * 反之亦然。用户看到「开了合并之后另一个模型没了」时的第一反应是程序有 bug。
     */
    const others = list.filter(
      (p) => p.id !== target.id && isLlamaProvider(p) && (p.device ?? '').trim(),
    )
    const clash = on ? others.filter((p) => deviceClash(nextDevice, p.device)) : []
    const warn = clash.length
      ? tr('；注意：{0} 也占着其中的卡，启动时会互相顶掉，建议把它们改成别的卡', {
          '0': clash.map((p) => p.name).join('、'),
        })
      : ''
    return {
      ok: true,
      message: on
        ? tr('已开启合并：{0} 一起跑同一个模型（约 {1} GB），到「④ 模型列表」点「启动」生效{2}', {
            '0': deviceList(nextDevice).join(' + '),
            '1': poolGbOf(nextDevice).toFixed(0),
            '2': warn,
          })
        : tr('已拆分为单卡：这条实例固定用 {0}，别的卡可以再放别的模型{1}', {
            '0': keep,
            '1': warn,
          }),
    }
  }

  /**
   * 卡组的显存合计（GB）：合并提示里要报一个真实数字，不要写死 16。
   *
   * 用**容量**不用空闲：体检是按静态口径算的（容量 × 0.94），
   * 这里报空闲的话，两句提示会差出好几个 GB，看起来像两边算错了。
   */
  function poolGbOf(device?: string): number {
    let sum = 0
    for (const id of deviceList(device)) {
      const hit = devices.find((d) => d.id.toLowerCase() === id.toLowerCase())
      if (hit) sum += hit.vramMiB ?? hit.freeMiB ?? 0
    }
    return sum / 1024
  }

  function addProvider(): string {
    const id = `p_${Date.now().toString(36)}`
    setDraft((prev) => ({
      ...prev,
      providers: [
        ...prev.providers,
        {
          id,
          name: tr('自定义'),
          kind: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKey: '',
          model: '',
          contextWindow: 32768,
          temperature: 0.2,
        },
      ],
    }))
    setExpanded((prev) => ({ ...prev, [id]: true }))
    return id
  }

  /** 「线上模型」页的「我有 API，添加」：新增供应商，切到模型列表并滚动到它 */
  function addProviderFromApi() {
    const id = addProvider()
    setTab('list')
    window.setTimeout(() => {
      document.getElementById(`prov-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 80)
  }

  /**
   * 「多智能体」总开关：一键把主以外的模型全设成子 / 一键清空。
   *
   * 运行时 subAgentProviders() 只认 provider.role === 'worker'（并天然排除主模型），
   * 所以开关直接作用在 role 上，界面显示与运行时行为永远一致：
   * - 启用：把所有「非主」的模型（本地 + 线上）标成 worker → 成为子智能体；
   * - 关闭：清空所有 role → 池为空 → 子代理回落主模型。
   *
   * 也可以不用这个开关，直接在每张卡上点「主 / 子」逐个设 —— 两条路径改的是同一个字段。
   */
  async function toggleSubAgents(enabled: boolean) {
    try {
      setBusy(true)
      const cur = draftRef.current
      const others = cur.providers.filter(
        (p) => p.id !== cur.activeId && Boolean(p.model?.trim()),
      ).length
      if (enabled && others < 1) {
        setNote({ text: tr('至少需要第二条配好模型的条目才能设子智能体'), kind: 'err' })
        return
      }
      const next: AppConfig = {
        ...cur,
        providers: cur.providers.map((x) => {
          // 关闭：一律清空；启用：主模型留空，其余全部标成子
          if (!enabled) return { ...x, role: undefined }
          return x.id === cur.activeId ? { ...x, role: undefined } : { ...x, role: 'worker' }
        }),
      }
      await onSave(next)
      setDraft(next) // 立即刷新按钮状态，不等父组件回流
      touchedActive.current = false
      setNote({
        text: enabled
          ? tr('多智能体已启用：主以外的 {0} 个模型都成了子智能体', { '0': String(others) })
          : tr('多智能体已关闭：子代理不再换模型，统一用主模型'),
        kind: 'ok',
      })
    } catch (e) {
      setNote({ text: tr('设置子智能体失败：{0}', { '0': (e as Error).message }), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  /**
   * 「设为主」：互斥切换——被点的模型成为唯一的主，原来的主自动降级为子。
   *
   * 主模型不可能是 worker（subAgentProviders 会排除 activeId），所以主 / 子天然互斥。
   * 只有已经开了多智能体时才把原主标成 worker：否则用户只是换一个模型来对话，
   * 不该凭空多出一个子智能体。
   */
  async function promoteToMain(p: ProviderConfig) {
    if (draftRef.current.activeId === p.id) return
    try {
      setBusy(true)
      const cur = draftRef.current
      const subAgentOn = cur.providers.some(
        (x) => x.id !== cur.activeId && x.role === 'worker',
      )
      const next: AppConfig = {
        ...cur,
        activeId: p.id,
        providers: cur.providers.map((x) => {
          if (x.id === p.id) return { ...x, role: undefined } // 新主：不进子池
          // 原主降级为子；其余保持用户原来点好的角色
          if (x.id === cur.activeId && subAgentOn && x.model?.trim()) {
            return { ...x, role: 'worker' }
          }
          return x
        }),
      }
      await onSave(next)
      setDraft(next) // 立即刷新按钮状态，不等父组件回流
      touchedActive.current = false
      setNote({
        text: tr('已切换主智能体：{0}', { '0': (p.name || p.model || '').trim() }),
        kind: 'ok',
      })
    } catch (e) {
      setNote({ text: tr('切换主智能体失败：{0}', { '0': (e as Error).message }), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  /**
   * 「设为子」：把这条模型放进子智能体池。
   *
   * 只改 role，不动 activeId、不重启服务 —— 角色是「派活时用不用它」的配置，
   * 和「现在跟谁对话」是两回事。主模型那条不能设成子（同一个模型既主又子没意义）。
   */
  async function setAsSub(p: ProviderConfig) {
    const cur = draftRef.current
    if (cur.activeId === p.id || p.role === 'worker' || !p.model?.trim()) return
    try {
      setBusy(true)
      const next: AppConfig = {
        ...cur,
        providers: cur.providers.map((x) => (x.id === p.id ? { ...x, role: 'worker' } : x)),
      }
      await onSave(next)
      setDraft(next)
      touchedActive.current = false
      setNote({
        text: tr('{0} 已设为子智能体：派 task 时会分给它', {
          '0': (p.name || p.model || '').trim(),
        }),
        kind: 'ok',
      })
    } catch (e) {
      setNote({ text: tr('设置子智能体失败：{0}', { '0': (e as Error).message }), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  /** 顶部「刷新」：重扫本地模型 + 各供应商状态，任何标签页都可用 */
  async function refreshAll() {
    setRefreshing(true)
    setNote({ text: tr('正在刷新本地模型与供应商状态…'), kind: 'ok' })
    try {
      onRefresh()
      await refreshAllRuntimes()
      // 显卡绑定改为自动后，设备清单也跟着「刷新」一起重扫
      await loadDevices(true)
      if (localRef.current) await localRef.current.refresh()
      setNote({
        text: tr('已刷新：本地模型与供应商状态都是最新的'),
        kind: 'ok',
      })
    } finally {
      setRefreshing(false)
    }
  }

  /**
   * 删掉配置。每条模型都是独立的（角色、启动、删除都在自己卡片上），
   * 所以这里只按传进来的 id 删，不再有「整组一起删」的连带逻辑。
   */
  function removeProviders(ids: string[]) {
    const drop = new Set(ids)
    if (!drop.size) return
    for (const id of drop) removed.current.add(id)
    setDraft((prev) => {
      const providers = prev.providers.filter((p) => !drop.has(p.id))
      return {
        ...prev,
        providers,
        activeId:
          prev.activeId && drop.has(prev.activeId) ? (providers[0]?.id ?? null) : prev.activeId,
      }
    })
  }

  async function fetchModels(provider: ProviderConfig) {
    setNote({
      text: tr('正在读取 {name} 的模型列表…', { name: provider.name }),
      kind: 'ok',
    })
    const result = await window.pico.models.listDraft(provider)
    if (!result.ok) {
      setNote({
        text: tr('读取失败：{0}', { '0': result.error ?? tr('未知错误') }),
        kind: 'err',
      })
      return
    }
    if (!result.models.length) {
      setNote({ text: tr('该端点没有返回可用模型'), kind: 'err' })
      return
    }
    setModelList((prev) => ({ ...prev, [provider.id]: result.models }))
    if (!provider.model) {
      patchProvider(provider.id, { model: result.models[0] })
    }
    setNote({
      text: tr('已拉取 {length} 个模型，点模型名右侧箭头选取。', {
        length: result.models.length,
      }),
      kind: 'ok',
    })
  }

  /** 刷新某个本地环境：llama 扫描 .gguf，Ollama / LM Studio 探服务 + 已装模型 */
  async function refreshRuntime(p: ProviderConfig, verbose = false) {
    const kind = runtimeOf(p)
    if (!kind) return
    setRtBusy(p.id)
    try {
      if (kind === 'llama') {
        const r = await window.pico.llama.models()
        const names = Array.from(new Set(r.models.map(baseName)))
        const s = await window.pico.llama.status(p.id)
        setRt((prev) => ({
          ...prev,
          [p.id]: {
            models: names,
            running: s.running,
            installed: true,
            port: s.port ?? p.port,
          },
        }))
        setServed((prev) => ({
          ...prev,
          [p.id]: s.running ? baseName(s.models?.[0] ?? '') : '',
        }))
        if (verbose) {
          setNote({
            text: names.length
              ? tr('找到 {length} 个本地模型，可在下拉框中选择', {
                  length: names.length,
                })
              : r.message,
            kind: names.length ? 'ok' : 'err',
          })
        }
        return
      }
      const s = await window.pico.local.status(kind)
      setRt((prev) => ({
        ...prev,
        [p.id]: {
          models: s.models,
          running: s.running,
          installed: s.installed,
          port: s.port,
        },
      }))
      if (verbose) {
        setNote({
          text: s.message,
          kind: s.installed || s.running ? 'ok' : 'err',
        })
      }
    } catch (err) {
      setNote({
        text: tr('检测失败：{0}', { '0': (err as Error).message }),
        kind: 'err',
      })
    } finally {
      setRtBusy(null)
    }
  }

  async function refreshAllRuntimes() {
    for (const p of draftRef.current.providers) {
      if (runtimeOf(p)) await refreshRuntime(p)
    }
  }

  /**
   * 拉起 Ollama / LM Studio 的服务。
   *
   * 和 llama.cpp 一样，启动顺带把这条设成当前使用：点「启动」的意思就是
   * 「我要用它」，服务起来了却还按上一条发消息，那才是更怪的事。
   */
  async function startRuntime(kind: RtKind, providerId: string) {
    if (kind === 'llama' || rtBusy) return
    setRtBusy(providerId)
    touchedActive.current = true
    setDraft((prev) => ({ ...prev, activeId: providerId }))
    setNote({
      text: tr('正在启动 {0} 服务…', { '0': RT_LABEL[kind] }),
      kind: 'ok',
    })
    try {
      const r = await window.pico.local.start(kind)
      setNote({ text: r.message, kind: r.ok ? 'ok' : 'err' })
      if (r.ok) {
        setRt((prev) => ({
          ...prev,
          [providerId]: {
            models: r.models ?? prev[providerId]?.models ?? [],
            running: true,
            installed: true,
          },
        }))
        // 服务真起来了：让卡片的状态灯跟着变绿，不然按钮说启动了、灯还黄着
        await onConfigChanged()
      }
    } catch (err) {
      setNote({
        text: tr('启动失败：{0}', { '0': (err as Error).message }),
        kind: 'err',
      })
    } finally {
      setRtBusy(null)
    }
  }

  /**
   * 停掉 Ollama / LM Studio 的服务 —— 模型列表里那个按钮的另一半。
   *
   * 停完立刻把 running 抹掉：主进程那边已经等过端口真的不响应才回报，
   * 再探一次只是多等一轮，界面上还会有一段「已停止但仍显示停止键」的空窗。
   */
  async function stopRuntime(kind: RtKind, providerId: string) {
    if (kind === 'llama' || rtBusy) return
    setRtBusy(providerId)
    setNote({
      text: tr('正在停止 {0} 服务…', { '0': RT_LABEL[kind] }),
      kind: 'ok',
    })
    try {
      const r = await window.pico.local.stop(kind)
      setNote({ text: r.message, kind: r.ok ? 'ok' : 'err' })
      if (r.ok) {
        setRt((prev) => ({
          ...prev,
          [providerId]: {
            ...(prev[providerId] ?? { models: [], installed: true }),
            running: false,
          },
        }))
        setServed((prev) => ({ ...prev, [providerId]: '' }))
        // 停完让状态灯跟着变（黄灯=装了没跑），别停留在「运行中」
        await onConfigChanged()
      }
    } catch (err) {
      setNote({
        text: tr('停止失败：{0}', { '0': (err as Error).message }),
        kind: 'err',
      })
    } finally {
      setRtBusy(null)
    }
  }

  /**
   * ④ 模型列表里启动一个 llama.cpp 实例。
   *
   * 这里是全程序**唯一**的启动入口（「② 本地模型」页只配置、不启动）：
   * 一个模型只可能被一处拉起，不会再出现两个入口并发 spawn 出两个 llama-server。
   *
   * 落盘走 `window.pico.config.save`，**不走 props.onSave**：那个会顺带触发
   * App 的 activateModel（它自己也会 start 一次），两条启动叠在一起正是要修的毛病。
   * 这里自己写盘、自己启动，只有一次 spawn。
   */
  async function startLlamaProvider(p: ProviderConfig) {
    if (llamaBusyId) return
    if (!p.model) {
      setNote({
        text: tr('这条还没选模型：先在上面选一个再启动'),
        kind: 'err',
      })
      return
    }
    setLlamaBusyId(p.id)
    setNote({
      text: tr('正在启动 {0}…', { '0': baseName(p.model) }),
      kind: 'ok',
    })
    try {
      /**
       * 启动这条实例，顺带把它设为当前主智能体。
       *
       * 以前这里有一段「组内非主成员别抢主位」的判据（localWorkGroup）：工作组是
       * 隐式成组的，所以给子卡点一下启动会把主对话悄悄挪过去。现在角色是显式的：
       * 标了「子」的那条，启动就是「把子智能体拉起来」，不碰 activeId；
       * 没标「子」的按老语义「启动 = 现在用它」。
       */
      const isSubHere =
        p.role === 'worker' && draftRef.current.activeId !== p.id
      // 主进程按**磁盘**配置找供应商：刚改过的模型必须先写盘，否则它会找不到这一条
      const next: AppConfig = {
        ...draftRef.current,
        activeId: isSubHere ? draftRef.current.activeId : p.id,
      }
      const saved = await window.pico.config.save(next)
      setDraft(saved)
      touchedActive.current = false
      // activate：启动这个模型就等于「现在用它」，否则顶栏和发消息还按上一个 activeId 走
      const r = await window.pico.llama.start(p.model, undefined, {
        providerId: p.id,
        activate: !isSubHere,
      })
      setNote({
        text:
          isSubHere && r.ok
            ? tr('{0} 已在 {1} 上启动，作为子智能体；主模型不变', {
                '0': baseName(p.model),
                '1': p.device || tr('自动'),
              })
            : r.message,
        kind: r.ok ? 'ok' : 'err',
      })
      await refreshRuntime(p)
      await onConfigChanged()
    } catch (err) {
      setNote({
        text: tr('启动失败：{0}', { '0': (err as Error).message }),
        kind: 'err',
      })
    } finally {
      setLlamaBusyId(null)
    }
  }

  /** ④ 模型列表里停掉一个 llama.cpp 实例并释放显存 */
  async function stopLlamaProvider(p: ProviderConfig) {
    if (llamaBusyId) return
    setLlamaBusyId(p.id)
    setNote({ text: tr('正在停止 {0}…', { '0': p.name || p.id }), kind: 'ok' })
    try {
      const r = await window.pico.llama.stop(p.id)
      setNote({ text: r.message, kind: r.ok ? 'ok' : 'err' })
      await refreshRuntime(p)
      await onConfigChanged()
    } catch (err) {
      setNote({
        text: tr('停止失败：{0}', { '0': (err as Error).message }),
        kind: 'err',
      })
    } finally {
      setLlamaBusyId(null)
    }
  }

  // 面板一打开就把各本地环境的模型列表准备好，不用再点一次按钮
  useEffect(() => {
    void refreshAllRuntimes()
    // 只在挂载时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 拉一次设备清单：新建实例时自动挑卡、以及「② 本地模型」页的卡槽要用。
   * refresh=true 时绕过主进程的 5 秒缓存（顶部「刷新」按钮走这条）。
   */
  async function loadDevices(refresh = false): Promise<void> {
    try {
      const info = await window.pico.llama.devicesInfo(refresh)
      setDevices(info?.devices ?? [])
    } catch {
      setDevices([])
    }
  }

  useEffect(() => {
    void loadDevices()
  }, [])

  /** 「② 本地模型」页点选模型 → 同步到模型列表的草稿（反过来也成立，见 currentModels） */
  function pickLocalModel(model: string, providerId?: string) {
    const list = draftRef.current.providers
    // 引导面板传的是 'llamacpp' / 'ollama' / 'lmstudio'，先按 id 找，
    // 找不到再按「运行时类型」找（用户可能把供应商改成自定义名字了）
    const kind: RtKind | undefined =
      providerId === 'llamacpp'
        ? 'llama'
        : providerId === 'ollama' || providerId === 'lmstudio'
          ? providerId
          : undefined
    const target =
      (providerId ? list.find((p) => p.id === providerId) : undefined) ??
      (kind ? list.find((p) => runtimeOf(p) === kind) : undefined) ??
      list.find((p) => runtimeOf(p) === 'llama')
    if (!target) return
    touchedModels.current.add(target.id)
    patchProvider(target.id, { model })
  }

  /**
   * 「② 本地模型」页的出口：落盘 → 切到「④ 模型列表」。
   *
   * 不复用 handleSave：那个保存完会把整个设置面板关掉，
   * 用户根本看不到「这条配置确实进列表了」，等于没有反馈。
   */
  async function saveToList(providerId: string, patch?: { contextWindow?: number }) {
    try {
      /**
       * patch 是配置页本地改过、还没进草稿的字段（目前只有上下文档位）。
       * 先并进草稿再整体落盘，页面上选的档位才不会在保存时丢掉。
       */
      const next: AppConfig = patch
        ? {
            ...draftRef.current,
            providers: draftRef.current.providers.map((p) =>
              p.id === providerId ? { ...p, ...patch } : p,
            ),
          }
        : draftRef.current
      await onSave(next)
      if (patch) setDraft(next)
      // 已经落盘，之后以磁盘为准
      touchedActive.current = false
      const id = providerId || draftRef.current.activeId || ''
      setTab('list')
      if (id) {
        setExpanded((prev) => ({ ...prev, [id]: true }))
        // 列表要等这一帧渲染完才有那个节点
        window.setTimeout(() => {
          document
            .getElementById(`prov-${id}`)
            ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }, 80)
      }
      setNote({ text: tr('已保存到模型列表'), kind: 'ok' })
    } catch (err) {
      setNote({
        text: tr('保存失败：{0}', { '0': (err as Error).message }),
        kind: 'err',
      })
    }
  }

  /**
   * 「② 本地模型」页里点了、但还没进草稿的上下文档位。
   *
   * 档位只活在那一页的 state 里（点一下不该立刻落盘，也不该重启服务），
   * 所以底部「保存」必须把它带上 —— 否则「点档位 → 直接点保存」
   * 会出现「明明选了 32K，回来还是 64K」。null 表示用户没改过，不覆盖磁盘值。
   */
  const ctxDraft = useRef<{ id: string; ctx: number } | null>(null)

  /** 把待写盘的档位并进要保存的配置 */
  function withCtxDrafts(cfg: AppConfig): AppConfig {
    const pick = ctxDraft.current
    if (!pick) return cfg
    const target = cfg.providers.find((p) => p.id === pick.id)
    // 已经是这个值就原样返回，免得为一次没变的保存多写一次盘
    if (!target || target.contextWindow === pick.ctx) return cfg
    return {
      ...cfg,
      providers: cfg.providers.map((p) =>
        p.id === pick.id ? { ...p, contextWindow: pick.ctx } : p,
      ),
    }
  }

  async function handleSave() {
    setBusy(true)
    try {
      await onSave(withCtxDrafts(draft))
      // 已经落盘了，之后以磁盘为准：再同步时不必再护住草稿里的选择
      touchedActive.current = false
      onClose()
    } catch (err) {
      /**
       * 保存失败必须说出来。之前只有 try/finally：主进程写盘失败会 rethrow，
       * 这里既不提示也不关闭，用户看到的是「点了保存，什么都没发生」，
       * 控制台里只留一条 unhandled rejection。
       */
      setNote({
        text: tr('保存失败：{0}', { '0': (err as Error).message }),
        kind: 'err',
      })
    } finally {
      setBusy(false)
    }
  }

  // 颜色按原始顺序分配，避免排序后颜色跳动
  const colorMap: Record<string, string> = {}
  draft.providers.forEach((p, i) => {
    colorMap[p.id] = PALETTE[i % PALETTE.length]
  })

  // 可用置顶（绿），不可用沉底（红），探测中居中
  const ordered = [...draft.providers].sort((a, b) => {
    const ra = RANK[probes[a.id]?.state ?? 'checking']
    const rb = RANK[probes[b.id]?.state ?? 'checking']
    return ra - rb
  })
  /**
   * 主 / 子 是**每条模型自己的角色**，和线上模型完全一致：
   * - 主：当前对话走的那一条（activeId，全局唯一）；
   * - 子：role='worker'，进子智能体池，主 agent 派 task 时按忙闲分给它。
   *
   * 不再把「一卡一模型」折叠成一张「工作组」卡片：折叠之后用户看不见每条
   * 模型到底算主还是算子，也没法单独给某一条改角色 —— 换个当前模型整组还会
   * 跟着重排。现在每条模型一张卡，角色就在卡片头上，点一下就是结论。
   */
  const activeP = ordered.find((p) => p.id === draft.activeId) ?? null
  const subCount = draft.providers.filter(
    (p) => p.id !== draft.activeId && p.role === 'worker' && Boolean(p.model?.trim()),
  ).length
  /** 多智能体 = 至少有一个子；没有子时 task 仍可用，但会回落主模型 */
  const multiAgentOn = subCount > 0
  /** 可以作为主 / 子被选择的：选了模型的那些（空槽设了也没意义） */
  const selectableRoles = ordered.filter((p) => Boolean(p.model?.trim())).length

  return (
    <>
      <div className="overlay" onClick={onClose}>
        <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
          <div className="settings-head">
            <h2>{tr('模型设置')}</h2>
            <button className="icon-btn" onClick={onClose} title={tr('关闭')}>
              {tr('关闭')}
            </button>
          </div>

          <div className="guide-tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={`guide-tab ${tab === t.key ? 'on' : ''}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
            <div className="guide-head-actions">
              {/**
               * 只在「② 本地模型」页出现：这个按钮是给本机 llama.cpp 下 GGUF 的，
               * 和云 API、模型列表都对不上操作对象 —— 常驻在标签栏右侧时，
               * 在其它页点开只会让人以为模型列表能从这儿加。
               */}
              {tab === 'local' && (
                <button
                  className="btn primary guide-getmodels"
                  onClick={() => setSpecsOpen(true)}
                  title={tr('读取本机显卡 / CPU / 内存，按本机能力推荐并下载模型')}
                >
                  {tr('获取模型')}
                </button>
              )}
              <button
                className="btn guide-getmodels"
                disabled={refreshing}
                onClick={() => void refreshAll()}
                title={tr('重新扫描本地 .gguf 模型与各供应商可用状态')}
              >
                {refreshing ? tr('刷新中…') : tr('刷新')}
              </button>
            </div>
          </div>

          {tab === 'list' ? (
            <div className="settings-body">
              {(() => {
                /**
                 * 模型列表分「本地模型 / 线上模型」两类展示。
                 * runtimeOf 返回 null 即远程 API（OpenAI / Anthropic / 自定义端点），
                 * 非 null 是本机运行环境（llama.cpp / Ollama / LM Studio）。
                 * 两个分组只是「跑在哪」，主 / 子跟这个分类无关：本地模型同样可以是子智能体。
                 */
                const renderCard = (p: ProviderConfig) => {
                const isOpen = Boolean(expanded[p.id])
                const probe = probes[p.id] ?? {
                  state: 'checking' as ProbeState,
                }
                const color = colorMap[p.id]
                const models = modelsFor(p.id)
                const rtKind = runtimeOf(p)
                /** 这一条自己的主 / 子角色：主 = 对话在用，子 = 进池给子代理干活 */
                const isMain = draft.activeId === p.id
                const isSub = p.role === 'worker'
                const rtState = rtKind ? rt[p.id] : undefined
                const servedName = served[p.id] ?? ''
                // 本地模型下拉：扫描到的全部列出来；配置里存着但盘上已删的，补一条标「本地未找到」
                const localName = p.model ? baseName(p.model) : ''
                const localList = rtState?.models ?? []
                const localOptions =
                  localName && !localList.includes(localName)
                    ? [localName, ...localList]
                    : localList
                // 本地服务探活通过 ≠ 模型在跑：没加载的一点显存都不占，黄灯标出来。
                // 远程地址（配成远端端口的 Ollama）没有「启动」这回事，仍按可用处理
                const idle =
                  probe.idle === true ||
                  (probe.state === 'ok' &&
                    rtKind !== null &&
                    probe.running === false &&
                    isLoopbackUrl(p.baseUrl))
                /** 这条本地服务是否在跑：决定顶部那个按钮显示「启动」还是「停止」 */
                const runningNow = Boolean(rtKind && rtState?.running)
                /** 这一条正在启停：按钮转「处理中…」（同类的其他卡片一并禁用，避免并发） */
                const busyHere = rtKind === 'llama' ? llamaBusyId === p.id : rtBusy === p.id
                const anyBusy = rtKind === 'llama' ? Boolean(llamaBusyId) : Boolean(rtBusy)
                return (
                  <div
                    key={p.id}
                    id={`prov-${p.id}`}
                    className={`provider ${draft.activeId === p.id ? 'active' : ''} ${isOpen ? 'open' : ''}`}
                    style={{ borderLeftColor: color }}
                  >
                    <div
                      className="prov-head"
                      onClick={() =>
                        setExpanded((prev) => ({
                          ...prev,
                          [p.id]: !prev[p.id],
                        }))
                      }
                    >
                      <span className="prov-color" style={{ background: color }} />
                      <StatusDot state={idle ? 'ready' : probe.state} error={probe.error} />
                      <div className="prov-title">
                        <span className="prov-tname">{p.name || tr('未命名')}</span>
                        <span className="prov-tsub">{p.model || tr('未选择模型')}</span>
                      </div>
                      {/* 合成：device 写了多张卡，一个模型摊开跑；和主/子角色无关 */}
                      {isLlamaProvider(p) && isMultiDevice(p.device) && (
                        <span
                          className="prov-badge prov-merged-badge"
                          title={tr('合成：多张显卡一起跑这一个模型')}
                        >
                          {tr('合成')}
                        </span>
                      )}
                      <span className={`prov-state ${idle ? 'ready' : probe.state}`}>
                        {probe.state === 'ok'
                          ? idle
                            ? tr('可用 · 未启动')
                            : rtKind
                              ? tr('运行中')
                              : tr('可用')
                          : probe.state === 'checking'
                            ? tr('检测中')
                            : idle
                              ? tr('未启动')
                              : tr('不可用')}
                      </span>
                      {/**
                       * 主 / 子：每条模型一个两段开关，本地和线上完全一致。
                       * - 「主」= 主智能体，对话走它；全局只有一个，点一下这条就上。
                       * - 「子」= 子智能体，进池给子代理干活；可以有多条。
                       *
                       * 主那一段在自己身上是禁用的（已经是主），「子」在主身上也禁用 ——
                       * 主模型必须在，想让它变子就先点别的模型的「主」，它会自动降为子。
                       */}
                      <span className="role-seg" role="group" aria-label={tr('主 / 子')}>
                        <button
                          type="button"
                          className={`role-seg-btn${isMain ? ' on main' : ''}`}
                          disabled={isMain || !p.model || busy}
                          title={
                            isMain
                              ? tr('当前主智能体：对话正在用它')
                              : p.model
                                ? tr('设为主智能体：对话切到这条，原主自动变子')
                                : tr('这条还没选模型：先选一个再设为主')
                          }
                          onClick={(e) => {
                            e.stopPropagation()
                            void promoteToMain(p)
                          }}
                        >
                          {tr('主')}
                        </button>
                        <button
                          type="button"
                          className={`role-seg-btn${isSub ? ' on' : ''}`}
                          disabled={isMain || !p.model || busy}
                          title={
                            isMain
                              ? tr('主智能体不能同时是子：先把别的模型设为主，这条会自动变子')
                              : isSub
                                ? tr('已经是子智能体：派 task 时会把活分给它')
                                : p.model
                                  ? tr('设子智能体：进池给子代理干活，可以有多条')
                                  : tr('这条还没选模型：先选一个再设为子')
                          }
                          onClick={(e) => {
                            e.stopPropagation()
                            void setAsSub(p)
                          }}
                        >
                          {tr('子')}
                        </button>
                      </span>
                      {/**
                       * 这个按钮就是这条模型（这条本地服务）唯一的开关：
                       * - 没跑 → 「启动」（顺带设为当前使用，因为启动就等于要用它）
                       * - 在跑 → 「停止」（停服务、释放显存）
                       *
                       * llama.cpp / Ollama / LM Studio 三家的按钮形态完全一致 ——
                       * 它们对用户就是「一个能起能停的模型」，没必要因为底层不同
                       * 就摆出两套按钮。「使用」只留给真正的外部长连接（没本地进程可停）。
                       */}
                      {rtKind ? (
                        <button
                          className={`btn${runningNow ? '' : ' primary'}`}
                          disabled={anyBusy || (!runningNow && rtKind === 'llama' && !p.model)}
                          title={
                            runningNow
                              ? rtKind === 'llama'
                                ? tr('停掉这个实例并释放显存；下次发消息会自动重新加载')
                                : tr('停掉 {0} 服务并释放显存；下次发消息会自动重新启动', {
                                    '0': RT_LABEL[rtKind],
                                  })
                              : rtKind === 'llama'
                                ? p.model
                                  ? tr('启动这个实例并使用它（只会在这里启动）')
                                  : tr('这条还没选模型：先在上面选一个再启动')
                                : tr('启动 {0} 服务并使用它', {
                                    '0': RT_LABEL[rtKind],
                                  })
                          }
                          onClick={(e) => {
                            e.stopPropagation()
                            if (busyHere) return
                            if (rtKind === 'llama') {
                              void (runningNow ? stopLlamaProvider(p) : startLlamaProvider(p))
                            } else {
                              void (runningNow
                                ? stopRuntime(rtKind, p.id)
                                : startRuntime(rtKind, p.id))
                            }
                          }}
                        >
                          {busyHere ? tr('处理中…') : runningNow ? tr('停止') : tr('启动')}
                        </button>
                      ) : null}
                      {/**
                       * 删除只删这一条配置。以前工作组在列表里是一个整体，
                       * 删一张要连带删整组；现在每条都是独立的主 / 子，删谁就是谁。
                       */}
                      <button
                        className="btn danger"
                        title={tr('删除这条配置')}
                        onClick={(e) => {
                          e.stopPropagation()
                          removeProviders([p.id])
                        }}
                      >
                        {tr('删除')}
                      </button>
                      <svg
                        className={`chev ${isOpen ? 'open' : ''}`}
                        width="10"
                        height="10"
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
                    </div>
                    {isOpen && (
                      <div className="prov-body">
                        <div className="grid2">
                          <div className="field">
                            <label>{tr('名称')}</label>
                            <input
                              value={p.name}
                              onChange={(e) => patchProvider(p.id, { name: e.target.value })}
                            />
                          </div>
                          <div className="field">
                            <label>{tr('接口类型')}</label>
                            <select
                              value={p.kind}
                              onChange={(e) =>
                                patchProvider(p.id, {
                                  kind: e.target.value as ProviderKind,
                                })
                              }
                            >
                              {(Object.keys(KIND_LABEL) as ProviderKind[]).map((k) => (
                                <option key={k} value={k}>
                                  {KIND_LABEL[k]}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="field">
                            <label>Base URL</label>
                            <input
                              value={p.baseUrl}
                              onChange={(e) => patchProvider(p.id, { baseUrl: e.target.value })}
                            />
                          </div>
                          <div className="field">
                            <label>{tr('API Key（本地模型可留空）')}</label>
                            <input
                              type="password"
                              value={p.apiKey ?? ''}
                              onChange={(e) => patchProvider(p.id, { apiKey: e.target.value })}
                              placeholder="sk-..."
                            />
                            {config.undecryptable?.includes(p.id) && (
                              <p className="field-warn">
                                {tr('这个密钥在本机解密失败（换过机器或系统账户），请重新填写。')}
                              </p>
                            )}
                          </div>
                          <div className="field">
                            <label>{tr('上下文窗口（tokens）')}</label>
                            <input
                              type="number"
                              value={p.contextWindow}
                              onChange={(e) =>
                                patchProvider(p.id, {
                                  contextWindow: Number(e.target.value),
                                })
                              }
                            />
                          </div>
                          <div className="field">
                            <label>{tr('单次输出上限（tokens）')}</label>
                            <input
                              type="number"
                              value={p.maxOutputTokens ?? ''}
                              placeholder={tr('留空自动（本地 16384 / 云端 8192）')}
                              onChange={(e) => {
                                const v = Number(e.target.value)
                                patchProvider(p.id, {
                                  maxOutputTokens: v > 0 ? v : undefined,
                                })
                              }}
                            />
                          </div>
                          <div className="field">
                            <label>{tr('温度')}</label>
                            <input
                              type="number"
                              step="0.1"
                              value={p.temperature ?? 0.2}
                              onChange={(e) =>
                                patchProvider(p.id, {
                                  temperature: Number(e.target.value),
                                })
                              }
                            />
                          </div>
                          {/**
                           * 采样参数（top_p / repeat_penalty）与 JSON 输出格式不再暴露：
                           * 留空即由服务端按模型给默认值，程序不替服务端做主。
                           * 已经落盘的老配置仍照常生效，只是不再提供修改入口。
                           */}
                        </div>
                        {/**
                         * 端口与显卡绑定不再由用户填写：
                         * 端口在启动前真实探测空闲值，显卡在新建实例时自动挑空闲显存最大的卡
                         * （见 addLlamaProvider / main/portprobe.ts / main/llama.ts）。
                         * 「② 本地模型」页的卡槽仍可点选，那里是选模型而不是填参数。
                         */}
                        {rtKind ? (
                          <div className="field model-field">
                            <label>
                              {tr('本地模型')}
                              {rtState
                                ? tr('（共 {length} 个，下拉选择）', {
                                    length: rtState.models.length,
                                  })
                                : rtKind === 'llama'
                                  ? tr('（点右侧按钮扫描 models/ 与 llama.cpp/）')
                                  : tr('（点右侧按钮检测 {0}）', {
                                      '0': RT_LABEL[rtKind],
                                    })}
                            </label>
                            <div className="model-row">
                              <ModelCombo
                                value={p.model ? baseName(p.model) : ''}
                                options={localOptions}
                                placeholder={tr('（未选择模型）')}
                                title={p.model || undefined}
                                labelOf={(m) =>
                                  rtKind === 'llama' && m === servedName
                                    ? tr('{m} · 运行中', { m: m })
                                    : localName && m === localName && !localList.includes(m)
                                      ? tr('{m}（本地未找到）', { m: m })
                                      : m
                                }
                                emptyHint={
                                  rtState
                                    ? tr('没有扫描到本地模型：先到「② 本地模型」页下载或导入一个')
                                    : tr('正在扫描本地模型…')
                                }
                                onChange={(v) => {
                                  touchedModels.current.add(p.id)
                                  patchProvider(p.id, { model: v })
                                }}
                              />
                              <button
                                className="btn"
                                disabled={rtBusy === p.id}
                                onClick={() => void refreshRuntime(p, true)}
                              >
                                {rtBusy === p.id ? tr('检测中…') : tr('刷新')}
                              </button>
                              {/**
                               * 启动/停止统一收在卡片顶部那一个按钮上（启动 ↔ 停止），
                               * 三家运行时（llama.cpp / Ollama / LM Studio）都是同一副面孔。
                               * 这里再摆一个「启动服务」等于同一件事两个入口，用户还得
                               * 先判断该点哪个，反而慢。
                               */}
                            </div>
                            <div className="model-hint">
                              {rtKind === 'llama'
                                ? !rtState
                                  ? tr('正在扫描本地模型…')
                                  : rtState.models.length === 0
                                    ? tr(
                                        '还没有本地模型：到「② 本地模型」页点「获取模型」下载，或放进 models/。',
                                      )
                                    : draft.activeId !== p.id
                                      ? tr(
                                          '这条不是当前使用的：点右上角「启动」会把它设为当前使用并加载。',
                                        )
                                      : p.model && baseName(p.model) !== servedName
                                        ? servedName
                                          ? tr(
                                              '正在跑的是 {served}：要换成所选模型，先点「停止」再「启动」，约几十秒。',
                                              { served: servedName },
                                            )
                                          : tr(
                                              '保存只写配置；要加载这个模型，点卡片右上角的「启动」。',
                                            )
                                        : servedName
                                          ? tr('llama-server 正在运行：{served}', {
                                              served: servedName,
                                            })
                                          : tr(
                                              '保存只写配置；要加载这个模型，点卡片右上角的「启动」。',
                                            )
                                : !rtState
                                  ? tr('正在检测 {0}…', {
                                      '0': RT_LABEL[rtKind],
                                    })
                                  : !rtState.installed && !rtState.running
                                    ? tr('未检测到 {0}：先到「② 本地模型」安装，再启动服务。', {
                                        '0': RT_LABEL[rtKind],
                                      })
                                    : !rtState.running
                                      ? tr('{0} 未启动：点卡片右上角的「启动」。', {
                                          '0': RT_LABEL[rtKind],
                                        })
                                      : draft.activeId !== p.id
                                        ? tr(
                                            '{0} 运行中（端口 {1}）；点「停止」再「启动」可把它设为当前使用。',
                                            {
                                              '0': RT_LABEL[rtKind],
                                              '1': rtState.port ?? RT_PORT[rtKind],
                                            },
                                          )
                                        : tr(
                                            '{0} 运行中（端口 {1}）· {length} 个模型；保存后即用所选模型。',
                                            {
                                              '0': RT_LABEL[rtKind],
                                              '1': rtState.port ?? RT_PORT[rtKind],
                                              length: rtState.models.length,
                                            },
                                          )}
                            </div>
                          </div>
                        ) : (
                          <div className="field model-field">
                            <label>
                              {tr('模型名')}
                              {models
                                ? tr('（已拉取 {length} 个，可下拉选取）', {
                                    length: models.length,
                                  })
                                : ''}
                            </label>
                            <div className="model-row">
                              <ModelCombo
                                value={p.model}
                                options={models ?? []}
                                placeholder={tr('如 qwen2.5-coder:7b')}
                                title={p.model || undefined}
                                emptyHint={tr('还没拉列表：点「拉取模型列表」，或直接手输模型名。')}
                                onChange={(v) => patchProvider(p.id, { model: v })}
                              />
                              <button className="btn" onClick={() => void fetchModels(p)}>
                                {tr('拉取模型列表')}
                              </button>
                            </div>
                          </div>
                        )}
                        <div className="row">
                          <label
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              fontSize: 'calc(12px * var(--fs, 1))',
                              color: 'var(--muted)',
                            }}
                          >
                            {tr('看图能力')}
                            <select
                              value={p.vision ?? 'auto'}
                              onChange={(e) =>
                                patchProvider(p.id, {
                                  vision: e.target.value as 'auto' | 'on' | 'off',
                                })
                              }
                              style={{ width: 120 }}
                            >
                              <option value="auto">{tr('自动判断')}</option>
                              <option value="on">{tr('支持看图')}</option>
                              <option value="off">{tr('不支持')}</option>
                            </select>
                          </label>
                          <span className="note">
                            {tr('按模型名自动判断，判错可手动改；看图要选「支持看图」。')}
                          </span>
                        </div>
                        {/**
                         * 「不支持原生工具调用」与「作为备用模型」不再提供勾选：
                         * 前者由主进程遇到 400 时自动降级成文本协议并记住（rememberNoTools），
                         * 后者由 fallbackCandidates() 自动按本地供应商组链。
                         * 老配置里已经勾过的仍然生效，只是不再有修改入口。
                         */}
                        {/**
                         * 多槽并发不再需要用户手测：启动参数已固定 -np N + -kvu（共享 KV 池），
                         * 探测能力仍留在主进程 llama.probeSlots，只是不放在设置页。
                         * 主 / 子在上面卡片头部的两段开关里选，起停用卡片上的「启动 / 停止」。
                         */}
                      </div>
                    )}
                  </div>
                )
                }

                // 按运行方式归组：本地运行环境在前，线上 API 在后
                const localOnes = ordered.filter((p) => runtimeOf(p) !== null)
                const onlineOnes = ordered.filter((p) => runtimeOf(p) === null)
                const section = (title: string, items: ProviderConfig[]) =>
                  items.length === 0 ? null : (
                    <div className="model-group">
                      <div className="model-group-title">
                        <span>{tr(title)}</span>
                        <span className="model-group-count">{items.length}</span>
                      </div>
                      {items.map((p) => renderCard(p))}
                    </div>
                  )
                return (
                  <>
                    {/**
                     * 顶部一条「主 / 子」总览。角色本身在每张卡上逐个点，
                     * 这里只回答两个问题：现在谁是主、一共有几个子；
                     * 以及给一个省事的入口 —— 一键把主以外的全部标成子。
                     * 本地和线上混在一个池里，所以总览放在分组之外。
                     */}
                    <div className="agent-role-bar">
                      <span className="agent-role-main">
                        <span className="agent-role-tag main">{tr('主')}</span>
                        {activeP
                          ? activeP.model || activeP.name
                          : tr('还没有配置模型')}
                      </span>
                      <span className="agent-role-sub">
                        <span className="agent-role-tag">{tr('子')}</span>
                        {subCount}
                      </span>
                      {selectableRoles >= 2 && (
                        <button
                          className={`btn subagent-toggle${multiAgentOn ? ' primary' : ''}`}
                          disabled={busy}
                          title={
                            multiAgentOn
                              ? tr('关闭多智能体：清空所有模型的「子」角色')
                              : tr('启用多智能体：把主以外的模型都设为子，供主 agent 派活')
                          }
                          onClick={(e) => {
                            e.stopPropagation()
                            void toggleSubAgents(!multiAgentOn)
                          }}
                        >
                          {multiAgentOn ? tr('关闭多智能体') : tr('一键启用多智能体')}
                        </button>
                      )}
                    </div>
                    {section('本地模型', localOnes)}
                    {section('线上模型', onlineOnes)}
                    {!multiAgentOn && selectableRoles >= 2 && (
                      <div className="row" style={{ padding: '6px 10px' }}>
                        <span className="note">
                          {tr(
                            '现在只有主智能体：task 子代理会沿用主模型（也有独立上下文，只是不换模型）。想让它用别的模型干活，把某条设为「子」。',
                          )}
                        </span>
                      </div>
                    )}
                  </>
                )
              })()}
            </div>
          ) : (
            <div className="guide-body">
              {tab === 'base' && (
                <div className="guide-section">
                  <BaseTools />
                  {/* 开源后最常见的问题：「怎么让别的工具用上这台机器的模型」 */}
                  <Fold id="external-access" title={tr('外部接入（Cline / Cursor / 脚本）')}>
                    <ExternalAccess providers={draft.providers} />
                  </Fold>
                  <Fold id="base-doc" title={tr('手动安装说明')}>
                    <p className="guide-lead">
                      {tr('本地运行依赖以下环境；没装全就点「一键安装」，装完重启本程序。')}
                    </p>
                    <h3>{tr('必装')}</h3>
                    <ul className="guide-list">
                      <li>
                        <b>{tr('Node.js LTS（含 npm）')}</b> ——{' '}
                        <Link href="https://nodejs.org/zh-cn" />
                        <span className="note">　{tr('国内备选：')}</span>
                        <Link href="https://npmmirror.com/mirrors/node/" />
                      </li>
                      <li>
                        <b>Git for Windows</b> —— <Link href="https://git-scm.com/download/win" />
                        <span className="note">　{tr('国内备选：')}</span>
                        <Link href="https://npmmirror.com/mirrors/git-for-windows/" />
                      </li>
                    </ul>
                    <h3>{tr('可选')}</h3>
                    <ul className="guide-list">
                      <li>
                        <b>Python 3.10+</b>
                        {tr('（部分本地模型工具需要）——')}{' '}
                        <Link href="https://www.python.org/downloads/" />
                        <span className="note">　{tr('国内备选：')}</span>
                        <Link href="https://mirrors.huaweicloud.com/python/" />
                      </li>
                    </ul>
                    <h3>{tr('安装后验证')}</h3>
                    <Code text="node -v" />
                    <Code text="npm -v" />
                    <Code text="git --version" />
                  </Fold>
                </div>
              )}

              {tab === 'local' && (
                <LocalModels
                  ref={localRef}
                  // 用草稿而不是磁盘配置：本面板里刚选的模型，切过来就应该已经是选中的
                  currentModels={Object.fromEntries(
                    draft.providers.map((p) => [p.id, p.model || '']),
                  )}
                  onSelectModel={pickLocalModel}
                  onConfigChanged={syncFromDisk}
                  /**
                   * 一卡一条实例：卡槽要显示「这张卡上是哪个模型」，
                   * 点空卡则由 pickLlamaSlot 就地建一条，不用绕去模型列表页。
                   */
                  llamaSlots={draft.providers
                    .filter((p) => isLlamaProvider(p))
                    .map((p) => ({
                      id: p.id,
                      name: p.name,
                      device: p.device,
                      model: p.model,
                      // 主 / 子只是给卡槽显示用：改角色仍在「④ 模型列表」
                      role:
                        p.id === draft.activeId
                          ? ('main' as const)
                          : p.role === 'worker'
                            ? ('worker' as const)
                            : undefined,
                      // 档位行要显示「配置里现在是哪一档」：这一页只改草稿，保存时随 patch 落盘
                      contextWindow: p.contextWindow,
                    }))}
                  onPickDevice={pickLlamaSlot}
                  onSaveToList={saveToList}
                  // 档位草稿上抛：底部「保存」也要带上它，两条保存路径才一样
                  onCtxDraft={(id, ctx) => {
                    ctxDraft.current = ctx ? { id, ctx } : null
                  }}
                  onToggleMultiGpu={toggleMultiGpu}
                />
              )}

              {tab === 'api' && (
                <div className="guide-section">
                  <p className="guide-lead">
                    {tr(
                      '云端模型只要 Base URL 和 API Key：点「添加」新增一条，填地址与 Key → 拉取模型 → 保存。这里不预置任何服务商，接口全部由你自己添加。',
                    )}
                  </p>
                  <div className="guide-actions">
                    <button className="btn primary" onClick={() => addProviderFromApi()}>
                      {tr('我有 API，添加')}
                    </button>
                  </div>

                  <div className="auto-fallback">
                    <label>
                      <input
                        type="checkbox"
                        checked={draft.autoFallback !== false}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            autoFallback: e.target.checked,
                          }))
                        }
                        style={{ width: 'auto' }}
                      />
                      {tr('额度用完 / 连不上时自动切换')}
                    </label>
                    <span className="note">
                      {tr('按列表顺序自动尝试其它本地供应商；已输出一半时不切换。')}
                    </span>
                  </div>

                  <p className="note">
                    {tr(
                      'API Key 仅保存在本机配置文件中，不会上传；也不要把 Key 提交到代码仓库或分享给他人。',
                    )}
                  </p>
                </div>
              )}
            </div>
          )}
          <div className="settings-foot">
            {note && <div className={`note ${note.kind}`}>{note.text}</div>}
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn"
                  title={tr('多卡多模型：每张卡各跑一个模型，需要为每个模型建一条实例')}
                  onClick={() => addLlamaProvider()}
                >
                  {tr('+ 添加本地实例')}
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    addProvider()
                    setTab('list')
                  }}
                >
                  {tr('+ 添加供应商')}
                </button>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" onClick={onClose}>
                  {tr('取消')}
                </button>
                <button className="btn primary" onClick={() => void handleSave()} disabled={busy}>
                  {busy ? tr('保存中…') : tr('保存')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      {specsOpen && <ModelSpecs onClose={() => setSpecsOpen(false)} />}
    </>
  )
}
