/**
 * 托盘：窗口收起来之后，用户唯一的"程序还活着"的证据。
 *
 * 之前这里只有 build/icon.png 一条路，而那个文件根本不存在，于是 Tray 拿到的是空图，
 * 点 × 之后窗口消失、托盘看不见、进程还在——用户只能认为"后台被清除了"。
 * 现在三层保险：build/tray.png → build/icon.png 缩放 → 内嵌 base64 兜底，
 * 外加建不起来就明确告诉调用方（它会让关闭退化成"最小化到任务栏"，不会让人彻底找不到程序）。
 */
import { app, Menu, nativeImage, Tray } from 'electron'
import type { NativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { mt } from './i18n'

/** build/tray.png 缺失时的最后一道兜底：32×32 深色方块 + 提示符，肉眼可辨、可点 */
const FALLBACK_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAC5UlEQVR42sWXTUgUYRjH33v7/TGz87WzX+9+lJq5fWAo6tZmmxaFaElSKFKX6BYFQYTVIStBWCmlDoGHTlF0qZF4D5bRoVDqZkgIdQ+ELtETj8HCuM7Mjqy7L/xuz/P//WcGBl5CNhw13lCgmWyRZrIazbSw6oBZ2SJmE6MjhtOUpls0MZwCQdkeMPu/I003yFM0ShtXBSUJtQBd6CwVSKSatZBMoZagc12uRNIFQU5ASKot6EQ3iSd3F3kpAfUA3SROmzRejEM9QDeJ0kbGiTGoB+gm0UQD44QomHGkcAoGh0bBas4u6CaR+C4WDEXAiIPteVj7Deu8eDUH+1u7wGzeDui2LJDLHy8VQH6t/YFr129Vr4Aa28kCvApmDI9eguWVn7oi2tv30HmoB6x2zUA3UWMZFuDDYIUay8D041ldCWTszn2oZN8gk5FwNM38nAKVMjA4DEtfv+lKvPvwGQq9fWAnB0E3CUdSzB+UwQ4BToGJyemyt3FvYspWDrqJEkkyX1CCrdBzoh8WPi7pSsw8ma14H91EUZPMF5BgKxgWqHAf3URWKfMGRLADtp+YfFT2CcYfTNnKQTeRwwnm9QtQKf2nz8Hil2WdeH7hExw9dhLs5CDoJrISZx5fCKyQlAQ8nHla9tQ3x+5CJfubgW4iKzHm8fFgxvnhi7C88kMnfjM3D20dh8Fq1wx0E0mOMreXAyPaO/Jlv+IrV28YzjfnL0DbmdubEm3K6WbRbVlg34H2kvz5y9ewJ9tqOEv39sLlZ38NGSl+Ly8gyhHm8gTBjM5cN/QNDIHVXKSxy7TA2fFF3Ty6iSipzOUOQLWIN3dDU25kU4Ii1c2imwiSqjndfqgH6CaCGC46XT6oB+gmXj9fwDYOl6+moBPd63eDkKBoDqcXagk6Szcjp8tL/YHQ6g6HB2oButCpux86XR7KhyTN4cQh97aA2ehAl+Et2e3xFzheLHK8qHG8yKoEZhUxe6PvH9bEm5PsOX+EAAAAAElFTkSuQmCC'

let tray: Tray | null = null

export interface TrayHooks {
  /** 显示并聚焦窗口 */
  show: () => void
  /** 收起窗口（还在后台跑） */
  hide: () => void
  /** 窗口此刻是否可见 */
  visible: () => boolean
  /** 真正退出 */
  quit: () => void
}

/**
 * 拿托盘图标：优先 build/tray.png（按 16 px 逻辑尺寸专门重绘过，小尺寸更清楚），
 * 再退回 build/icon.png，最后才是内嵌图。
 * 打包后这两个文件在 app.asar 里，开发时在项目根目录，路径都走 app.getAppPath()。
 */
function trayImage(): NativeImage {
  const root = app.getAppPath()
  for (const name of ['tray.png', 'icon.png']) {
    const p = path.join(root, 'build', name)
    if (!fs.existsSync(p)) continue
    const img = nativeImage.createFromPath(p)
    if (img.isEmpty()) continue
    const small = img.resize({ width: 16, height: 16 })
    // 高 DPI 屏上让系统取 32 px 那份，不然托盘图标会糊
    if (small.isEmpty()) return img
    small.addRepresentation({ scaleFactor: 2, width: 16, height: 16, dataURL: img.toDataURL() })
    return small
  }
  return nativeImage.createFromDataURL(`data:image/png;base64,${FALLBACK_PNG}`)
}

/**
 * 建托盘。返回 false 表示这台机器上托盘用不了（图标全空 / 系统拒绝），
 * 调用方要把"点 × 收进托盘"降级成"最小化到任务栏"，否则窗口就再也找不回来了。
 */
export function createTray(hooks: TrayHooks): boolean {
  if (tray && !tray.isDestroyed()) {
    refreshTrayMenu(hooks)
    return true
  }
  const image = trayImage()
  if (image.isEmpty()) return false
  try {
    tray = new Tray(image)
  } catch {
    tray = null
    return false
  }
  tray.setToolTip('RoRoTo Code')
  refreshTrayMenu(hooks)
  // 单击就切换显示/隐藏，双击必定显示——两种习惯都照顾到
  tray.on('click', () => (hooks.visible() ? hooks.hide() : hooks.show()))
  tray.on('double-click', () => hooks.show())
  return true
}

/** 菜单跟着窗口状态变：可见时给「隐藏」，不可见时给「显示」 */
export function refreshTrayMenu(hooks: TrayHooks): void {
  if (!tray || tray.isDestroyed()) return
  const visible = hooks.visible()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: mt('显示窗口'), click: () => hooks.show(), enabled: !visible },
      { label: mt('收起到托盘'), click: () => hooks.hide(), enabled: visible },
      { type: 'separator' },
      { label: mt('退出 RoRoTo Code'), click: () => hooks.quit() }
    ])
  )
  tray.setToolTip(visible ? 'RoRoTo Code' : mt('RoRoTo Code · 后台运行中'))
}

export function trayAlive(): boolean {
  return Boolean(tray && !tray.isDestroyed())
}

/**
 * 第一次收进托盘时弹个气泡：「我还在这」。
 * 只在 Windows 上有；其它平台静默跳过，任务栏图标本身已经足够说明问题。
 */
export function hintBackground(): void {
  if (!trayAlive() || process.platform !== 'win32') return
  try {
    tray?.displayBalloon({
      title: mt('RoRoTo Code 还在后台运行'),
      content: mt('点右下角托盘图标可以重新打开窗口；想彻底退出请右键图标选「退出」。'),
      iconType: 'info',
      noSound: true
    })
  } catch {
    // 系统关了气泡通知（专注助手 / 组策略）就算了，不影响功能
  }
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
}
