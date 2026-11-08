import type { ReactNode } from 'react'
import { tokenizeInline, type InlineToken } from '../mdTokens'

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
      default:
        return <span key={key}>{t.text}</span>
    }
  })
}

interface Segment {
  kind: 'text' | 'code'
  lang?: string
  value: string
}

function splitSegments(text: string): Segment[] {
  const segments: Segment[] = []
  const re = /```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      segments.push({ kind: 'text', value: text.slice(last, match.index) })
    }
    segments.push({ kind: 'code', lang: match[1], value: match[2] })
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push({ kind: 'text', value: text.slice(last) })
  return segments
}

export function RichText({ text }: { text: string }): ReactNode {
  const segments = splitSegments(text)
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === 'code') {
          return (
            <pre className="md-code" key={`code-${i}`}>
              {seg.value}
            </pre>
          )
        }
        const paragraphs = seg.value.split(/\n{2,}/)
        return (
          <div key={`txt-${i}`}>
            {paragraphs.map((p, j) => (
              <p key={`p-${i}-${j}`}>{renderTokens(tokenizeInline(p), `${i}-${j}`)}</p>
            ))}
          </div>
        )
      })}
    </>
  )
}
