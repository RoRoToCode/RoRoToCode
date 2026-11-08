import { t as tr } from '../i18n'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { SetupProgress, VramfitReport, VramfitResult } from '../../shared/types'
import { Chevron, useCollapse } from './Collapse'
import { DownloadBar } from './DownloadBar'
import { LocalRuntime } from './LocalRuntime'

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

type LlamaAction = 'install' | 'configure' | 'models' | 'start'

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`
const kctx = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n))

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
  /** 每个模型的看图状态（主进程扫描时算好的：有没有配套投影器） */
  const [vision, setVision] = useState<Record<string, 'ready' | 'missing' | 'text'>>({})
  const [llamaRunning, setLlamaRunning] = useState(false)
  /** 所有在跑的本地实例：双卡双模型时这里会是两条 */
  const [running, setRunning] = useState<
    Array<{ key: string; port: number; model: string; device: string }>
  >([])
  /** 用户选中的模型（多个模型时必须由用户决定用哪个） */
  const [picked, setPicked] = useState('')
  /** 服务当前实际加载的模型 */
  const [runningModel, setRunningModel] = useState('')
  const [warming, setWarming] = useState(false)
  const [backend, setBackend] = useState<{ backend: string; gpuReady: boolean; installed: boolean } | null>(null)
  /** vramfit 是否就位；缺失时整块体检入口不出现，不留一个点了没反应的按钮 */
  const [fitReady, setFitReady] = useState(false)
  const [fit, setFit] = useState<VramfitResult | null>(null)
  const [fitBusy, setFitBusy] = useState(false)
  /** 只认最后一次体检的结果：连点不同模型时，慢的那个不许覆盖新的 */
  const fitSeq = useRef(0)

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

  // 安装进度：主进程按 200ms 推一次，界面据此画进度条与速度
  useEffect(
    () =>
      window.pico.llama.onSetupProgress((p) => {
        if (!alive.current || p.kind !== 'llama') return
        setSetup(p)
      }),
    []
  )

  // 打开面板就先扫一遍本地模型，用户不用点「刷新」也能直接选
  useEffect(() => {
    void (async () => {
      try {
        const r = await window.pico.llama.models()
        if (!alive.current) return
        setLlamaModels(r.models)
        setVision(r.vision ?? {})
        const s = await window.pico.llama.status('llamacpp')
        const all = await window.pico.llama.instances().catch(() => [])
        if (!alive.current) return
        setLlamaRunning(s.running)
        setRunning(all)
        if (s.running && s.models?.[0]) setRunningModel(s.models[0])
      } catch {
        // 扫描失败不阻塞面板
      }
    })()
  }, [])

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
        await onConfigChanged?.()
        if (!alive.current) return
        setLlamaMsg(tr("本地模型已就绪：{0}", { "0": s.models?.[0] ?? ml.models[0] ?? tr("已加载") }))
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
    return { running: s.running, message: s.message }
  }

  async function runLlama(action: LlamaAction, ctx?: number) {
    if (llamaBusy) return
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
        const r = await window.pico.llama.models()
        setLlamaModels(r.models)
        setLlamaMsg(r.message)
      } else if (action === 'start') {
        const target = picked || llamaModels[0]
        if (!target) {
          setLlamaMsg(tr("还没有本地模型：点顶部「获取模型」下载，或放进 models/。"))
          return
        }
        setLlamaMsg(tr("正在启动 llama-server（{0}）并创建模型配置…", { "0": baseName(target) }))
        const r = await window.pico.llama.start(target, ctx, { providerId: 'llamacpp' })
        setLlamaMsg(r.message)
        if (r.ok) {
          if (r.model) setRunningModel(r.model)
          // 配置已落盘：先刷新，模型立刻出现在选择器/设置里
          await onConfigChanged?.()
          // 模型加载放到后台，就绪后再校正一次
          void watchServer()
        }
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

  const fitReport = fit?.ok ? fit.report : null
  const fitVerdict = fitReport ? verdictOf(fitReport.verdict) : null
  const fitCtx = fitReport?.recommendedCtx ?? null
  const fitTok = fitReport ? (fitReport.genTokPerSec ?? fitReport.genTokPerSecOnCpu) : null

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
          <h3>{tr("llama.cpp（本机 · 推荐先测）")}</h3>
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
            <span className="guide-badge">{tr("运行中")}</span>
          ) : (
            warming && <span className="guide-badge warming">{tr("加载中…")}</span>
          )}
          <Chevron open={llamaOpen} />
        </div>
        {backend?.installed && !backend.gpuReady && (
          <p className="guide-warn">
            {tr("当前 CPU 版：不占显存但慢；重装可换 CUDA 版。")}</p>
        )}
        {backend && !backend.installed && (
          <p className="guide-warn">
            {tr("还没装 llama.cpp：点下面「一键安装 / 下载」即可；或到「① 基础核心」用简易核心。")}</p>
        )}
        <p className="guide-lead">
          {tr("自动下载解压到")}<code>llama.cpp/</code>{tr("，用本机 GGUF 模型启动服务。")}</p>
        <div className="guide-actions">
          <button
            className="btn"
            disabled={!!llamaBusy}
            onClick={() => void runLlama('install')}
            title={tr("自动按 直连 → gh-proxy → ghproxy.net → ghfast.top 换源下载，装到 llama.cpp/ 目录")}
          >
            {llamaBusy === 'install' ? tr("安装中…") : tr("一键安装 / 下载")}
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
        </div>
        {setup && <DownloadBar p={setup} onCancel={() => void cancelInstall()} />}
        {llamaMsg && <div className="guide-msg">{llamaMsg}</div>}
        {llamaModels.length > 0 && (
          <div className="guide-pick">
            <div className="guide-pick-head">
              <b>{tr("使用哪个本地模型")}</b>
              <span className="guide-pick-hint">
                {tr("共")}{llamaModels.length} {tr("个，点一下选中")}{llamaRunning && runningModel ? tr(" · 当前运行：{0}", { "0": baseName(runningModel) }) : ''}
              </span>
            </div>
            <div className="guide-models">
              {llamaModels.map((m) => {
                const on = sameModel(m, picked)
                const isRunning = llamaRunning && sameModel(m, runningModel)
                const needRestart = on && llamaRunning && !!runningModel && !isRunning
                return (
                  <button
                    key={m}
                    type="button"
                    className={`guide-model ${on ? 'on' : ''}`}
                    onClick={() => {
                      setPicked(m)
                      // 同步到「模型列表」里的下拉框，两边始终是同一个模型
                      onSelectModel?.(baseName(m), 'llamacpp')
                    }}
                    title={m}
                  >
                    <span className="guide-model-dot" />
                    <span className="guide-model-name">{baseName(m)}</span>
                    {isRunning && <span className="guide-model-tag run">{tr("运行中")}</span>}
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
                  </button>
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
                      </span>
                      <span>{tr("建议上下文")}</span>
                      <span>
                        {fitCtx ? kctx(fitCtx) : '—'}
                        {fitReport.nativeContext ? (
                          <em className="fit-dim">{tr("（原生 {0}）", { "0": kctx(fitReport.nativeContext) })}</em>
                        ) : null}
                      </span>
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
                      <span>{tr("估算速度")}</span>
                      <span>{fitTok ? `~${fitTok} tok/s` : '—'}</span>
                    </div>

                    <div className="fit-tiers">
                      {fitReport.tiers.map((row) => (
                        <span
                          key={row.ctx}
                          className={`fit-tier ${row.fits === null ? 'unknown' : row.fits ? 'ok' : 'bad'}`}
                          title={
                            row.needBytes
                              ? tr("需要 {0}", { "0": gb(row.needBytes) })
                              : tr("元数据不全，算不出来")
                          }
                        >
                          {kctx(row.ctx)}
                        </span>
                      ))}
                    </div>

                    <div className="fit-foot">
                      {fitCtx ? (
                        <button
                          type="button"
                          className="btn primary"
                          disabled={!!llamaBusy}
                          onClick={() => void runLlama('start', fitCtx)}
                          title={tr("按体检算出的上下文启动：{0}", { "0": `${kctx(fitCtx)} tokens` })}
                        >
                          {tr("按建议上下文启动（{0}）", { "0": kctx(fitCtx) })}
                        </button>
                      ) : (
                        <span className="fit-dim">{tr("一档上下文都装不下，建议换更小的模型或更低的量化。")}</span>
                      )}
                      <span className="fit-dim">
                        {tr("静态推算，实际以加载一次为准")}
                      </span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        <p className="guide-note">
          {tr("端口留空自动探测；两个实例绑不同显卡即可同时跑。.gguf 放进")}<code>models/</code> {tr("或")}<code>llama.cpp/</code> {tr("即可识别。")}</p>
        {running.length > 1 && (
          <p className="guide-note">
            {tr("当前有 {n} 个实例在跑：", { n: running.length })}
            {running.map((r) => `${r.model}@${r.port}${r.device ? `（${r.device}）` : ''}`).join('、')}
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
    </div>
  )
})
