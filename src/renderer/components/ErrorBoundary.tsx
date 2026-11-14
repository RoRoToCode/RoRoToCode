import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t as tr } from '../i18n'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  componentStack: string
}

/**
 * 界面兜底。
 *
 * 没有它的时候，任何一处 render 抛错（数据形状不对、某个字段是 undefined、
 * 第三方内容触发了没考虑到的分支）都会被 React 卸载整棵树 —— 用户看到的是
 * 一片纯白，连"出事了"都不知道，只能杀进程。会话与文件都在磁盘上没丢，
 * 但用户没法知道这一点。
 *
 * 这里只做三件事：说清楚出了什么、给一次恢复的机会、把现场留下来可复制。
 * 不做自动重试 —— 同样的 props 再渲染一次大概率还是同样的错。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] 界面渲染失败', error, info.componentStack)
    this.setState({ componentStack: info.componentStack ?? '' })
  }

  private reload = (): void => {
    window.location.reload()
  }

  private copy = (): void => {
    const { error, componentStack } = this.state
    const detail = [error?.stack || String(error), componentStack].filter(Boolean).join('\n\n')
    void navigator.clipboard?.writeText(detail).catch(() => undefined)
  }

  render(): ReactNode {
    const { error, componentStack } = this.state
    if (!error) return this.props.children

    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg)',
          color: 'var(--text)',
          padding: 24
        }}
      >
        <div
          style={{
            width: 620,
            maxWidth: '100%',
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '22px 24px'
          }}
        >
          <div style={{ fontSize: 'calc(15px * var(--fs, 1))', fontWeight: 600, marginBottom: 8 }}>
            {tr("界面出错了")}
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 'calc(12.5px * var(--fs, 1))', lineHeight: 1.8 }}>
            {tr("这不是你的操作问题：界面在渲染时抛了错，已经停在这里，避免继续显示错误的内容。")}
            <br />
            {tr("会话记录和项目文件都还在磁盘上，没有丢。重新加载即可继续。")}
          </div>
          <pre
            style={{
              marginTop: 14,
              maxHeight: 220,
              overflow: 'auto',
              background: 'var(--code-bg)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '10px 12px',
              fontSize: 'calc(11.5px * var(--fs, 1))',
              lineHeight: 1.6,
              color: 'var(--text-soft)',
              whiteSpace: 'pre-wrap'
            }}
          >
            {error.message}
            {componentStack ? `\n${componentStack}` : ''}
          </pre>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn" onClick={this.copy}>
              {tr("复制错误详情")}</button>
            <button className="btn primary" onClick={this.reload}>
              {tr("重新加载界面")}</button>
          </div>
        </div>
      </div>
    )
  }
}
