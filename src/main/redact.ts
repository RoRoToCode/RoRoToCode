/**
 * 日志 / 错误提示脱敏。
 * 规则刻意保守：只处理最常见的几种凭据形态，宁可少替也不能把正常内容改烂。
 */

const RULES: Array<{ re: RegExp; to: string }> = [
  // Anthropic（必须排在通用 sk- 前面，否则会被更宽的规则先吃掉）
  { re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, to: 'sk-ant-***' },
  // OpenAI / DeepSeek / 多数兼容服务的 key
  { re: /\bsk-[A-Za-z0-9_-]{8,}/g, to: 'sk-***' },
  // 常见云厂商
  { re: /\b(AKIA|ASIA)[A-Z0-9]{12,}/g, to: '$1***' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, to: 'gh***' },
  // Authorization: Bearer xxx
  { re: /(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, to: '$1***' },
  // URL 里的 ?key= / token=
  { re: /([?&](?:api[_-]?key|key|token|access_token)=)[^&\s]+/gi, to: '$1***' },
  // JSON 里的 "apiKey": "xxx"
  { re: /("(?:api[_-]?key|apiKey|token|password|secret)"\s*:\s*")[^"]{4,}(")/gi, to: '$1***$2' }
]

export function redact(text: string): string {
  if (!text) return text
  let out = text
  for (const r of RULES) out = out.replace(r.re, r.to)
  return out
}

/** 错误对象也要脱敏后再落日志：message 里经常带着完整请求 URL */
export function redactError(err: unknown): string {
  if (err instanceof Error) return redact(`${err.name}: ${err.message}\n${err.stack ?? ''}`)
  return redact(String(err))
}
