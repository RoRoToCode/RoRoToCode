import { t as tr } from '../i18n'
import { useState } from 'react'
import { DOWNLOAD_TAG_LABEL, type DownloadGuide, type DownloadSource } from '../../shared/downloads'

interface Props {
  guide: DownloadGuide
  /** 默认展开：安装失败后建议直接展开 */
  defaultOpen?: boolean
}

function Row({ source }: { source: DownloadSource }) {
  const [copied, setCopied] = useState(false)

  function copy() {
    const clip = navigator.clipboard
    if (!clip) return
    void clip.writeText(source.url).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <li className="dl-row">
      <span className={`dl-tag ${source.tag}`}>{tr(DOWNLOAD_TAG_LABEL[source.tag])}</span>
      <div className="dl-main">
        {/* target=_blank 由主进程接管，用系统浏览器打开 */}
        <a className="dl-label" href={source.url} target="_blank" rel="noreferrer" title={source.url}>
          {tr(source.label)}
        </a>
        <span className="dl-note">{tr(source.note)}</span>
      </div>
      <button className="dl-btn" onClick={copy} title={tr("复制链接，可粘到浏览器或下载工具")}>
        {copied ? tr("已复制") : tr("复制")}
      </button>
    </li>
  )
}

/**
 * 本地运行时的下载地址面板：官方 + 内地镜像 + 备用镜像，哪个通点哪个。
 * 主进程的自动下载也复用同一份清单，所以这里显示的顺序就是它的回退顺序。
 */
export function DownloadLinks({ guide, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className={`dl-box ${open ? 'open' : ''}`}>
      <button className="dl-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="dl-toggle-title">{tr("下载地址 · 含内地镜像")}</span>
        <span className="dl-toggle-hint">
          {guide.sources.length} {tr("条，打不开就换一条")}</span>
        <svg className={`dl-caret ${open ? 'open' : ''}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="dl-body">
          <p className="dl-hint">{tr(guide.hint)}</p>
          <ul className="dl-list">
            {guide.sources.map((s) => (
              <Row key={s.url} source={s} />
            ))}
          </ul>

          {guide.models && guide.models.length > 0 && (
            <>
              <div className="dl-sub">{tr("模型去哪下（.gguf）")}</div>
              <ul className="dl-list">
                {guide.models.map((s) => (
                  <Row key={s.url} source={s} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}
