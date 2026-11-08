import { useState } from 'react'
import type { ProviderConfig } from '../../shared/types'
import { t as tr } from '../i18n'

/**
 * 外部接入：把「这台机器上的本地模型」变成别的工具能直接用的地址。
 *
 * 以前这块只有 `node -v` 这种环境验证命令，用户想拿 Cline / Cursor / 脚本
 * 接本地模型，得自己去翻配置找端口、猜模型 id。这里直接把可粘贴的字段摊开。
 *
 * 只给 OpenAI 兼容协议：llama-server 实现的就是这套，别写成「支持 Claude Code」
 * —— Claude Code 走 Anthropic 协议，直连会失败。
 */

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    const clip = navigator.clipboard
    if (!clip) return
    void clip.writeText(value).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <div className="guide-code">
      <span style={{ opacity: 0.65, marginRight: 8, flexShrink: 0 }}>{label}</span>
      <code style={{ flex: 1, overflow: 'auto', whiteSpace: 'nowrap' }}>{value}</code>
      <button className="guide-copy" onClick={copy}>
        {copied ? tr('已复制') : tr('复制')}
      </button>
    </div>
  )
}

export function ExternalAccess({ providers }: { providers: ProviderConfig[] }) {
  // 只列真的能对外提供服务的：有 baseUrl、且是本地运行时（llama / ollama / lmstudio）
  const locals = providers.filter((p) => p.baseUrl && (p.runtime || /127\.0\.0\.1|localhost/.test(p.baseUrl)))
  if (!locals.length) {
    return (
      <p className="guide-lead">
        {tr("还没有本地模型：先到「② 本地模型」启动一个。")}
      </p>
    )
  }

  return (
    <div>
      <p className="guide-lead">
        {tr(
          "给 Cline / Cursor / Continue 等兼容客户端用；模型需先启动。"
        )}
      </p>
      {locals.map((p) => (
        <div key={p.id} style={{ marginBottom: 18 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{p.name}</div>
          <CopyRow label={tr('接口地址')} value={p.baseUrl ?? ''} />
          <CopyRow label={tr('模型 ID')} value={p.model || tr('（未设置）')} />
          <CopyRow label={tr('API Key')} value="local" />
        </div>
      ))}
      <p className="guide-lead" style={{ marginTop: 4 }}>
        {tr(
          "控制面需要 token：见启动控制台或 userData/daemon.json。"
        )}
      </p>
      <CopyRow label={tr('控制面')} value="http://127.0.0.1:7788/status" />
    </div>
  )
}
