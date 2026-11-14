import { memo, useCallback, useEffect, useState, type ReactNode } from 'react'
import { tokenizeInline, type InlineToken } from '../mdTokens'
import { parseMarkdownBlocks, type MdBlock, type MdListItem } from '../../shared/mdblocks'
import { t as tr } from '../i18n'

/** 一张图按地址缓存，滚动重渲染不重复走 IPC */
const imageCache = new Map<string, string | null>()

/** 已经是可以在浏览器里直接用的地址：网址或 data URL */
function directImage(src: string): string | null {
  return /^(https?:\/\/|data:image\/)/i.test(src) ? src : null
}

/**
 * 正文里的图片。
 *
 * 两种来源走两条路：网址 / data URL 直接给 `<img>`；本地路径（模型刚生成的截图、
 * 仓库里的 png）交给主进程读文件转 data URL —— 渲染层没有文件系统权限，而且
 * 主进程那边会按扩展名和大小做白名单，模型写个 `![](C:\Windows\...)` 也读不出东西来。
 *
 * 点一下放大：本地图先转成 1280 长边的预览图，够看清文字，又不用把原图塞进 DOM。
 */
function MdImage({ src, alt }: { src: string; alt: string }): ReactNode {
  const direct = directImage(src)
  const cached = imageCache.get(src)
  const [url, setUrl] = useState<string | null>(() => direct ?? cached ?? null)
  const [failed, setFailed] = useState(() => !direct && cached === null && imageCache.has(src))
  const [zoom, setZoom] = useState(false)

  useEffect(() => {
    if (direct) {
      setUrl(direct)
      setFailed(false)
      return
    }
    if (imageCache.has(src)) {
      const got = imageCache.get(src) ?? null
      setUrl(got)
      setFailed(!got)
      return
    }
    let alive = true
    void window.pico.files
      .image(src)
      .then((r) => {
        const got = r && r.ok && r.url ? r.url : null
        imageCache.set(src, got)
        if (!alive) return
        setUrl(got)
        setFailed(!got)
      })
      .catch(() => {
        imageCache.set(src, null)
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [src, direct])

  const close = useCallback(() => setZoom(false), [])
  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom])

  if (failed || (!url && !direct)) {
    if (failed) {
      return (
        <span className="md-img-bad" title={src}>
          {alt || tr('图片打不开：{src}', { src })}
        </span>
      )
    }
    // 还在读盘：占个位，避免正文高度跳一下
    return <span className="md-img-wait" aria-label={alt} />
  }

  return (
    <span className="md-fig">
      <img
        className="md-img"
        src={url ?? src}
        alt={alt}
        title={alt ? `${alt}（${tr('点击放大')}）` : tr('点击放大')}
        loading="lazy"
        referrerPolicy="no-referrer"
        onClick={() => setZoom(true)}
      />
      {alt ? <span className="md-img-cap">{alt}</span> : null}
      {zoom ? (
        <div className="md-zoom" onClick={close} role="presentation">
          <img className="md-zoom-img" src={url ?? src} alt={alt} onClick={close} />
        </div>
      ) : null}
    </span>
  )
}

function renderTokens(tokens: InlineToken[], keyPrefix: string): ReactNode[] {
  return tokens.map((t, i) => {
    const key = `${keyPrefix}-${i}`
    switch (t.kind) {
      case 'code':
        return (
          <code className="md-inline" key={key}>
            {t.text}
          </code>
        )
      case 'strong':
        return (
          <strong className="md-strong" key={key}>
            {renderTokens(t.children, key)}
          </strong>
        )
      case 'link':
        // 不带 target 也能用，但显式 target=_blank 会走主进程的
        // setWindowOpenHandler → shell.openExternal（系统浏览器），窗口自己不会跳走。
        return (
          <a
            className="md-link"
            href={t.href}
            target="_blank"
            rel="noopener noreferrer"
            title={t.href}
            key={key}
          >
            {t.text}
          </a>
        )
      case 'image':
        return <MdImage key={key} src={t.src} alt={t.alt} />
      default:
        return <span key={key}>{t.text}</span>
    }
  })
}

/** 列表项按缩进组成树，再按「相邻且同类」分组渲成 ul / ol */
interface ListNode {
  item: MdListItem
  children: ListNode[]
}

function buildListTree(items: MdListItem[]): ListNode[] {
  const roots: ListNode[] = []
  const stack: Array<{ node: ListNode; depth: number }> = []
  for (const item of items) {
    const node: ListNode = { item, children: [] }
    while (stack.length && stack[stack.length - 1].depth >= item.depth) stack.pop()
    if (stack.length) stack[stack.length - 1].node.children.push(node)
    else roots.push(node)
    stack.push({ node, depth: item.depth })
  }
  return roots
}

function renderListNodes(nodes: ListNode[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  let i = 0
  let group = 0
  while (i < nodes.length) {
    const ordered = nodes[i].item.ordered
    let j = i
    while (j < nodes.length && nodes[j].item.ordered === ordered) j++
    const slice = nodes.slice(i, j)
    const items = slice.map((n, k) => (
      <li className="md-li" key={`${keyPrefix}-${i + k}`}>
        {n.item.checked !== null ? (
          <span className={n.item.checked ? 'md-check on' : 'md-check'} aria-hidden="true">
            {n.item.checked ? '☑' : '☐'}
          </span>
        ) : null}
        {renderTokens(tokenizeInline(n.item.text), `${keyPrefix}-li${i + k}`)}
        {n.children.length ? renderListNodes(n.children, `${keyPrefix}-${i + k}`) : null}
      </li>
    ))
    const gk = `${keyPrefix}-g${group++}`
    out.push(
      ordered ? (
        <ol className="md-list md-ol" key={gk} start={slice[0].item.start}>
          {items}
        </ol>
      ) : (
        <ul className="md-list md-ul" key={gk}>
          {items}
        </ul>
      )
    )
    i = j
  }
  return out
}

function renderBlock(block: MdBlock, key: string): ReactNode {
  switch (block.kind) {
    case 'code':
      return (
        <pre className="md-code" key={key} data-lang={block.lang || undefined}>
          {block.value}
        </pre>
      )
    case 'table':
      return (
        // 列多的时候表格自己横向滚，不要把整个对话区域顶宽
        <div className="md-table-wrap" key={key}>
          <table className="md-table">
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i} style={block.align[i] ? { textAlign: block.align[i] as 'left' } : undefined}>
                    {renderTokens(tokenizeInline(cell), `${key}-h${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      style={block.align[ci] ? { textAlign: block.align[ci] as 'left' } : undefined}
                    >
                      {renderTokens(tokenizeInline(cell), `${key}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'list':
      return <div className="md-listbox" key={key}>{renderListNodes(buildListTree(block.items), key)}</div>
    case 'heading': {
      const lv = Math.min(6, Math.max(1, block.level))
      // 标签按层级选，样式统一走 md-h 类；h5/h6 在对话里和 h4 一样大就够了
      const Tag = (lv === 1 ? 'h1' : lv === 2 ? 'h2' : lv === 3 ? 'h3' : lv === 4 ? 'h4' : lv === 5 ? 'h5' : 'h6') as 'h1'
      return (
        <Tag className={`md-h md-h${lv}`} key={key}>
          {renderTokens(tokenizeInline(block.text), key)}
        </Tag>
      )
    }
    case 'quote':
      return (
        <blockquote className="md-quote" key={key}>
          {renderTokens(tokenizeInline(block.text), key)}
        </blockquote>
      )
    case 'hr':
      return <hr className="md-hr" key={key} />
    default:
      return <p key={key}>{renderTokens(tokenizeInline(block.text), key)}</p>
  }
}

/**
 * 正文渲染。memo 的意义在于：分词（parseMarkdownBlocks + tokenizeInline）是纯 CPU 活，
 * 流式输出时父组件每帧重渲染，但已经写完的那几条 text 没变，不该再分一次词。
 */
function RichTextInner({ text }: { text: string }): ReactNode {
  const blocks = parseMarkdownBlocks(text)
  return <>{blocks.map((b, i) => renderBlock(b, `b${i}`))}</>
}

export const RichText = memo(RichTextInner)
