import { t as tr } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import type { CoreProgress, CoreSetupResult, SetupProgress } from '../../shared/types'
import { Chevron, useCollapse } from './Collapse'
import { DownloadBar } from './DownloadBar'

interface Props {
  /** 准备完成后让设置面板重新读盘：新建的本地供应商要立刻出现在列表里 */
  onChanged?: () => void | Promise<void>
}

/**
 * 简易核心：把「建目录 → 下模型 → 装 llama.cpp → 配置 → 加载 → 自检」做成一键。
 *
 * 这些事「② 本地模型」页都能一件件手动做，这里是给「我只想能聊起来」的人走的直线。
 * 每一步的结果都摆出来 —— 装到哪一步、卡在哪一步，一眼能看见。
 */
export function SimpleCore({ onChanged }: Props) {
  const [open, toggle] = useCollapse('simple-core-card', true)
  const [busy, setBusy] = useState(false)
  const [prog, setProg] = useState<CoreProgress | null>(null)
  const [res, setRes] = useState<CoreSetupResult | null>(null)
  const [err, setErr] = useState('')

  const alive = useRef(true)
  /** 这轮准备是不是本面板发起的（不是的话只能靠轮询判断什么时候结束） */
  const owned = useRef(false)
  useEffect(
    () => () => {
      alive.current = false
    },
    []
  )

  useEffect(() => {
    const off = window.pico.core.onProgress((p) => {
      if (alive.current) setProg(p)
    })
    // 切走再切回来：准备流程（含下载 llama.cpp / 核心模型）还在主进程里跑，把进度接上
    void window.pico.downloads
      .snapshot()
      .then((s) => {
        if (!alive.current || !s.core.running) return
        if (s.core.progress) setProg(s.core.progress)
        setBusy(true)
      })
      .catch(() => undefined)
    return off
  }, [])

  /**
   * 这轮准备是别的面板发起的（本面板是切回来的）：没有本地 Promise 可等，
   * 只能隔几秒问一次主进程还跑不跑，跑完了把按钮解锁。
   */
  useEffect(() => {
    if (!busy || owned.current) return
    const timer = window.setInterval(() => {
      void window.pico.downloads
        .snapshot()
        .then((s) => {
          if (!alive.current) return
          if (s.core.running) {
            if (s.core.progress) setProg(s.core.progress)
            return
          }
          setBusy(false)
          setProg(null)
          setErr(tr("上一轮准备已结束。需要看结果就再点一次「简易核心」，已装好的部分会跳过。"))
        })
        .catch(() => undefined)
    }, 4000)
    return () => window.clearInterval(timer)
  }, [busy])

  async function run() {
    if (busy) return
    owned.current = true
    setBusy(true)
    setErr('')
    setRes(null)
    setProg({ phase: 'dir', message: tr("正在创建核心目录…") })
    try {
      const r = await window.pico.core.setup()
      if (!alive.current) return
      setRes(r)
      if (r.ok) await onChanged?.()
    } catch (e) {
      if (alive.current) setErr(tr("准备失败：{0}", { "0": (e as Error).message }))
    } finally {
      owned.current = false
      if (alive.current) {
        setBusy(false)
        setProg(null)
      }
    }
  }

  async function cancel() {
    const r = await window.pico.core.cancel()
    if (alive.current) setProg((p) => (p ? { ...p, message: r.message } : p))
  }

  // 只有真的在传字节时才画进度条；解压 / 等待加载这类阶段只有文字
  const bar: SetupProgress | null =
    prog && (prog.phase === 'model' || prog.phase === 'llama') && (prog.totalBytes ?? 0) > 0
      ? {
          kind: 'llama',
          receivedBytes: prog.receivedBytes ?? 0,
          totalBytes: prog.totalBytes ?? 0,
          bytesPerSec: prog.bytesPerSec,
          state: 'downloading',
          message: prog.message
        }
      : null

  return (
    <div className={`guide-card core-card ${open ? '' : 'collapsed'}`}>
      <div
        className="guide-card-head"
        onClick={toggle}
        title={open ? tr("收起") : tr("展开")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') toggle()
        }}
      >
        <h3>{tr("简易核心")}</h3>
        {busy ? (
          <span className="guide-badge warming">{tr("准备中…")}</span>
        ) : res?.ok ? (
          <span className="guide-badge">{tr("已就绪")}</span>
        ) : res ? (
          <span className="guide-badge cpu">{tr("未完成")}</span>
        ) : null}
        <Chevron open={open} />
      </div>
      <p className="guide-lead">
        {tr("一次点完：在软件根目录建")}<code>core/</code>
        {tr("目录，下核心模型、装 llama.cpp 并自检，等于手动流程全自动。")}
      </p>
      <div className="guide-actions">
        <button
          className="btn primary"
          disabled={busy}
          onClick={() => void run()}
          title={tr("建 core/ → 下载核心模型 → 安装 llama.cpp → 写配置 → 加载模型 → 自检")}
        >
          {busy ? tr("准备中…") : tr("简易核心")}
        </button>
        {busy && (
          <button className="btn" onClick={() => void cancel()}>
            {tr("取消")}
          </button>
        )}
      </div>

      {bar && <DownloadBar p={bar} onCancel={() => void cancel()} />}
      {busy && prog?.message && !bar && <div className="guide-msg">{prog.message}</div>}
      {err && <div className="guide-msg">{err}</div>}

      {res && (
        <>
          <div className="core-steps">
            {res.steps.map((s) => (
              <div key={s.id} className={`core-step ${s.state}`}>
                <span className="core-step-dot" aria-hidden="true">
                  {s.state === 'ok' ? '✓' : s.state === 'error' ? '✗' : '—'}
                </span>
                <span className="core-step-name">{tr(s.label)}</span>
                <span className="core-step-msg" title={s.message}>
                  {s.message}
                </span>
              </div>
            ))}
          </div>
          <div className={`guide-msg ${res.ok ? '' : 'err'}`}>{res.message}</div>
          <p className="guide-note">
            {tr("核心目录：")}
            <code>{res.dir}</code>
            {res.providerId ? tr("　到「④ 模型列表」点「使用」就能切到它对话。") : ''}
          </p>
        </>
      )}
    </div>
  )
}
