/**
 * 主进程文案：只管系统级对话框（安装确认、保存/选择目录等）。
 * 语言由渲染层通过 app:setLang 同步，界面按钮一按这里立刻跟着切。
 */
export type MainLang = 'zh' | 'en'

let current: MainLang = 'zh'

export function setMainLang(lang: unknown): void {
  current = lang === 'en' ? 'en' : 'zh'
}

const EN: Record<string, string> = {
  '下载并安装': 'Download & install',
  '取消': 'Cancel',
  '打开官网': 'Open website',
  '用 winget 自动安装': 'Install with winget',
  '安装基础核心': 'Install core components',
  '将安装 {n} 个组件（共约 {size}）': 'Will install {n} components (about {size} total)',
  '安装过程需要管理员权限，会弹出一次系统授权窗口；确认后全程静默安装，不会打断你正在做的事。':
    'Installation needs admin rights (one UAC prompt). After confirming it runs silently without interrupting your work.',
  '安装 {label}': 'Install {label}',
  '将下载 {label} 官方安装包（约 {size} MB）': 'Will download the official {label} installer (about {size} MB)',
  '将下载 {label} 官方安装包': 'Will download the official {label} installer',
  '下载失败会自动换源（共 {n} 个：{list}）。安装包放在系统临时目录，不会占用软件目录。':
    'If a download fails, sources are tried in order ({n} total: {list}). Installers go to the system temp folder, not the app folder.',
  '{label} 只有官方 CDN 一个下载源（国内无镜像）。安装包放在系统临时目录，下载失败时可改用 winget 自动安装。':
    '{label} has only one source (official CDN, no China mirror). Installers go to the system temp folder; if the download fails you can install via winget.',
  '{label} 下载失败': '{label} download failed',
  '安装包没下下来': 'The installer could not be downloaded',
  '可以改用 winget 自动安装（系统自带，会自己下载，但不显示进度），或者打开官网手动下载。':
    'You can install via winget instead (built into Windows, downloads on its own but shows no progress), or open the website and download manually.',
  '导出对话': 'Export chat',
  '选择工作区': 'Choose workspace folder',
  '常用文件': 'Common files',
  '所有文件': 'All files',
  '选择要发给模型的文件': 'Choose files to send to the model',
  '添加': 'Add',
  'Node.js LTS（含 npm）': 'Node.js LTS (includes npm)',
  'Python 3（可选）': 'Python 3 (optional)',
  // 托盘菜单与「收进托盘」气泡
  '显示窗口': 'Show window',
  '收起到托盘': 'Hide to tray',
  '退出 RoRoTo Code': 'Quit RoRoTo Code',
  'RoRoTo Code · 后台运行中': 'RoRoTo Code · running in background',
  'RoRoTo Code 还在后台运行': 'RoRoTo Code is still running',
  '点右下角托盘图标可以重新打开窗口；想彻底退出请右键图标选「退出」。':
    'Click the tray icon in the bottom-right corner to reopen the window. To really quit, right-click it and choose Quit.'
}

export function mt(key: string, vars?: Record<string, unknown>): string {
  const raw = current === 'en' ? (EN[key] ?? key) : key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = vars[name]
    return v === undefined || v === null ? whole : String(v)
  })
}
