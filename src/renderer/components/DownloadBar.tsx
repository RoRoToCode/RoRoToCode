import { t as tr } from '../i18n'
import type { SetupProgress } from '../../shared/types'

/** 字节数格式化 */
export function fmtBytes(n?: number): string {
  const v = n ?? 0
  if (v <= 0) return '0 B'
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 速度格式化 */
export function fmtSpeed(n?: number): string {
  const v = n ?? 0
  if (v <= 0) return ''
  if (v < 1024) return `${v.toFixed(0)} B/s`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB/s`
  return `${(v / 1024 / 1024).toFixed(1)} MB/s`
}

/** 剩余时间：约 1 分 20 秒 */
function fmtEta(remainBytes: number, speed?: number): string {
  if (!speed || speed <= 0 || remainBytes <= 0) return ''
  const sec = Math.round(remainBytes / speed)
  if (sec < 60) return tr("剩余 {sec} 秒", { sec: sec })
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return tr("剩余 {m} 分 {1} 秒", { m: m, "1": String(s).padStart(2, '0') })
  return tr("剩余 {0} 小时 {1} 分", { "0": Math.floor(m / 60), "1": m % 60 })
}

interface Props {
  p: SetupProgress
  /** 显示「取消下载」按钮时传进来 */
  onCancel?: () => void
  /** 结束（done/error）后是否还显示条 */
  finished?: boolean
}

/**
 * 下载进度条：百分比 + 已下载/总量 + 每秒速度 + 剩余时间 + 当前用的源。
 * 拿不到总长度时退化成「不确定进度」的滚动条，至少让人知道在动。
 */
export function DownloadBar({ p, onCancel, finished }: Props) {
  const total = p.totalBytes || 0
  const received = p.receivedBytes || 0
  const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0
  const known = total > 0
  const speed = fmtSpeed(p.bytesPerSec)
  const eta = fmtEta(total - received, p.bytesPerSec)
  const busy = p.state === 'downloading' || p.state === 'preparing' || p.state === 'extracting'

  const title =
    p.state === 'preparing'
      ? p.message || tr("准备中…")
      : p.state === 'extracting'
        ? p.message || tr("正在解压…")
        : p.state === 'done'
          ? tr("下载完成")
          : p.state === 'error'
            ? p.message || tr("下载失败")
            : p.file || p.message || tr("正在下载")

  return (
    <div className={`pbar ${p.state}`}>
      <div className="pbar-head">
        <span className="pbar-title" title={title}>
          {title}
        </span>
        <span className="pbar-pct">
          {p.state === 'done' ? '100%' : known ? `${pct}%` : ''}
        </span>
        {busy && onCancel && (
          <button className="pbar-cancel" onClick={onCancel} title={tr("停止下载")}>
            {tr("取消")}</button>
        )}
      </div>

      {p.state !== 'error' && (
        <div className="pbar-track">
          <div
            className={`pbar-fill ${known ? '' : 'indet'} ${p.state === 'done' ? 'done' : ''}`}
            style={known ? { width: `${Math.max(pct, 1)}%` } : undefined}
          />
        </div>
      )}

      <div className="pbar-meta">
        {known ? (
          <span>
            {fmtBytes(received)} / {fmtBytes(total)}
          </span>
        ) : (
          <span>{p.state === 'downloading' || finished ? fmtBytes(received) : ''}</span>
        )}
        {speed && <span>{speed}</span>}
        {eta && <span>{eta}</span>}
        {p.source && <span className="pbar-src">{tr("来源：")}{p.source}</span>}
      </div>
    </div>
  )
}
