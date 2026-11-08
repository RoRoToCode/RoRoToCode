import { safeStorage } from 'electron'

/**
 * API Key 的落盘加密。
 *
 * 定位要说清楚：Windows 上 safeStorage 就是 DPAPI，属「当前用户 + 当前机器」级别，
 * 同一个账户跑的程序照样能解。它挡的是 config.json 被拷走、被误传、被打包进日志，
 * 不是「本机恶意程序也读不到」。
 *
 * 因此不做「加密失败就当没有 key」的静默降级：换机器 / 换用户后解不出来时，
 * 必须让用户看到「请重新填写」，否则会出现「明明填了 key 却一直 401」的鬼故事。
 */

const PREFIX = 'enc:v1:'

export function canSeal(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** 加密：已经是密文或系统不支持时原样返回（老配置因此能在下次保存时自动升级） */
export function seal(plain: string): string {
  if (!plain || plain.startsWith(PREFIX) || !canSeal()) return plain
  try {
    return PREFIX + safeStorage.encryptString(plain).toString('base64')
  } catch {
    // 加密失败不该让保存整份配置失败：这次先存明文，下次保存再试
    return plain
  }
}

/** 解密：返回 null 表示「有密文但本机解不开」，调用方要提示用户重填 */
export function unseal(stored: string): string | null {
  if (!stored) return ''
  if (!stored.startsWith(PREFIX)) return stored
  if (!canSeal()) return null
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(PREFIX.length), 'base64'))
  } catch {
    return null
  }
}

export function isSealed(value: string): boolean {
  return !!value && value.startsWith(PREFIX)
}
