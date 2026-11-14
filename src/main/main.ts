import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeTheme,
  Notification,
  screen,
  session,
  shell
} from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { defaultProviders, effectiveWorkspace, loadConfig, saveConfig } from './config'
import {
  agentTools,
  getAgent,
  listAgents,
  removeAgent,
  setAgentsWorkspace,
  upsertAgent
} from './agents'
import { listCommands, parseCommand } from './commands'
import { describeHooks, forgetHookCache } from './hooks'
import { listRoutines, removeRoutine, runRoutine, setEnabled, startScheduler, upsertRoutine } from './routines'
import {
  cancelHandoff,
  handoffPrompt,
  listHandoffs,
  runHandoff,
  startHandoffPump,
  stopHandoffPump
} from './handoff'
import { disposeAll as disposeDiagnostics, reapIdle as reapDiagnostics } from './lsp'
import { probeSlotsConcurrency } from './slotscheck'
import * as store from './store'
import { log, logDir, logPath } from './log'
import { redact } from './redact'
import { AgentEngine, messagesTokens } from './agent'
import { clearGrants, listGrants, revokeGrant } from './grants'
import { clearScratch } from './scratch'
import { listModels } from './providers'
import { setLocalWaker } from './providers/base'
import {
  cancelLlamaInstall,
  cleanupStaleLlama,
  configureLlama,
  detectBackend,
  checkLlamaUpdate,
  findMmprojFor,
  installLlama,
  launchKvType,
  listLlamaDevices,
  listLocalModels,
  deleteLocalModel,
  llamaInstances,
  llamaSetupSnapshot,
  modelsRoot,
  startLlama,
  startIdleUnload,
  statusLlama,
  stopLlama,
  stopLlamaSync,
  wakeLlama
} from './llama'
import { cancelCoreSetup, coreModelFile, coreProvider, coreSetupSnapshot, ensureCoreProvider, setupCore } from './core'
import { isLlamaProvider, runtimeKindOf } from '../shared/providers'
import { warmWorker, workerPlan } from './worker'
import { systemSpecs } from './sysinfo'
import { checkModel, vramfitAvailable } from './vramfit'
import { appInfo, applySavedAppearance, loadPrefs, openDataDir, savePrefs, setZoom, windowBg } from './appinfo'
import { createTray, destroyTray, hintBackground, refreshTrayMenu, trayAlive } from './tray'
import { broadcastAgentEvent, setChatHandler, startDaemon, stopDaemon, subscribeChat } from './daemon'
import { clearCheckpoint, listInterruptedCheckpoints } from './checkpoint'
import {
  cancelLocalInstall,
  configureLocal,
  importLocalModel,
  installLocal,
  listImportableGgufs,
  localOrigin,
  localSetupSnapshot,
  localStatus,
  pullOllama,
  localGpuSnapshot,
  isModelLoaded,
  localServiceIdle,
  releaseIdleRuntimes,
  scheduleRuntimeRelease,
  secureGpuForActive,
  setFreedHook,
  startLocal,
} from './locals'
import { installRemoteSkills, listSkills, removeSkill, saveSkill, setSkillEnabled } from './skills'
import { distillSkill } from './learn'
import { scanSkills, SOURCES } from './skillhub'
import { checkSkillDeps } from './skilldeps'
import { attachFiles, pickFiles, searchWorkspaceFiles } from './files'
import { imagePreview, imageThumb } from './vision'
import { checkTools, installTools } from './basetools'
import { cancelDownload, downloadModel, downloadsSnapshot, listCatalog, removeModel } from './models'
import { clearMemory, memoryInfo } from './memory'
import { boardInfo, clearBoard } from './board'
import { dayUsage } from './quota'
import { findInstructions, initAgents } from './instructions'
import { loadProjectPermissionsDetailed, saveProjectPermissions } from './permissions'
import { mt, setMainLang } from './i18n'
import { applyHunks, changeDetail, clearChanges, listChanges, revertAll, revertChange } from './changes'
import { gitCommit, gitDiff, gitStatus } from './git'
import { existsDir, forgetWorkspace, listWorkspaces, rememberWorkspace } from './workspaces'
import { closeTerminal, disposeAllTerminals, listTerminals, openTerminal, readTerminal, writeTerminal } from './terminal'
import { mcpStatus, openMcpConfig, reloadMcp, shutdownMcp } from './mcp'
import { freeCatalog } from './freedir'
import { exportSessionMarkdown } from './exporter'
import { DeltaCoalescer } from './eventbuf'
import type {
  AgentEvent,
  AgentProfile,
  AppConfig,
  BaseToolId,
  CloseAction,
  HandoffResult,
  LocalRuntimeKind,
  PicoAPI,
  ProviderConfig,
  Routine,
  SendAttachment,
  TokenUsage
} from '../shared/types'

const isDev = process.env.PICODEV === '1'
let win: BrowserWindow | null = null
/** 点了「退出」才置真；点关闭按钮按用户选的 closeAction 处理，默认收进托盘 */
let quitting = false
/** 关闭按钮行为的内存副本：close 事件是同步的，来不及 await 读 prefs */
let closeAction: CloseAction = 'tray'

/** 把「软件设置 → 网络代理」应用到整个会话：联网工具和页面请求都会走它 */
async function applyProxy(proxyUrl: string | null | undefined): Promise<void> {
  const rules = (proxyUrl ?? '').trim()
  try {
    await session.defaultSession.setProxy(rules ? { proxyRules: rules } : { mode: 'direct' })
  } catch {
    // 代理地址写错不影响其它功能，联网工具会自己报错
  }
}

/**
 * 判断配置里写的模型名是否出现在服务端返回的模型列表里。
 * 本地 llama-server 可能返回绝对路径（旧版启动方式），而配置里存的是文件名，
 * 因此按文件名 + 大小写不敏感比较，避免明明加载成功却判定为不可用。
 */
function modelListed(models: string[], target: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').trim().toLowerCase()
  const want = norm(target)
  const wantBase = path.basename(want)
  return models.some((m) => {
    const cur = norm(m)
    return cur === want || path.basename(cur) === wantBase
  })
}

function resolveDataDir(): string {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  if (portableDir) {
    const dir = path.join(portableDir, 'RoRoToData')
    try {
      fs.mkdirSync(dir, { recursive: true })
      return dir
    } catch {
      // 便携版所在目录没有写权限时，退回用户目录
    }
  }
  return path.join(app.getPath('appData'), 'RoRoToCode')
}

app.setPath('userData', resolveDataDir())
// 系统标题栏跟随暗色，避免窗口顶部出现一条白边
nativeTheme.themeSource = 'dark'

/** 正文流式的合帧间隔：一帧 16ms 够跟上 60Hz 屏幕，又不至于让字一个一个蹦 */
const DELTA_FLUSH_MS = 16

/** 真正把事件送到窗口与无头订阅者 */
function deliverAgentEvent(sessionId: string, event: AgentEvent): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent:event', { sessionId, event })
  }
  // 无头 /chat 的 SSE 订阅者也要拿到同一份事件
  broadcastAgentEvent(sessionId, event)
}

/**
 * 每个 SSE chunk 都过一次 IPC 和一次 React setState 太浪费：字是肉眼看的，
 * 一帧发一次就够。顺序规则（非 delta 先 flush、换消息先 flush）在模块里有单测。
 */
const coalescer = new DeltaCoalescer(deliverAgentEvent, DELTA_FLUSH_MS)

function emit(sessionId: string, event: AgentEvent): void {
  // 出错的事件统一落一条日志：界面上 toast 会消失，日志能留着复盘
  if (event.type === 'error') log('error', 'agent', `${sessionId}: ${event.message}`)
  coalescer.push(sessionId, event)
}

const engine = new AgentEngine(emit)

// 把 agent 引擎接到 HTTP 控制面，外部进程就能驱动同一个引擎跑无头任务
setChatHandler({
  createSession: async (workspace?: string | null, agentId?: string | null) => {
    const s = await store.createSession(workspace ?? null, agentId ?? null)
    return s.id
  },
  send: (sessionId, text, options) =>
    engine.send(sessionId, text, undefined, { nonInteractive: true, approvalPolicy: options?.approvalPolicy ?? 'deny' }),
  abort: (sessionId) => engine.abort(sessionId),
  subscribe: (sessionId, cb) => subscribeChat(sessionId, cb),
  isRunning: (sessionId) => engine.isRunning(sessionId),
  running: () => engine.runningRuns()
})

/** 定时任务跑完给个系统提示：它多半是在用户不在电脑前的时候跑的 */
function notifyRoutine(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return
    new Notification({ title, body: body.slice(0, 200), silent: false }).show()
  } catch {
    // 通知失败不影响任务本身
  }
}

/**
 * 定时任务的执行体。
 *
 * 关键点：任务不是「一条独立的执行路径」，而是**建一个普通会话，然后发一条消息**。
 * 这样它和用户手打的一模一样 —— 有历史、有 diff、有 checkpoint、能重跑、能删，
 * 出问题的时候用户看得见现场，而不是一个后台黑盒。
 */
startScheduler({
  busy: () => engine.hasRunning(),
  // 连续失败到上限时任务会被停用，这条通知是用户唯一会看到的东西，
  // 不能只让他看到「又失败了一次」
  disabled: (routine) => {
    notifyRoutine(`定时任务已停用：${routine.name}`, '连续失败，先停了。改好配置在面板里重新启用')
    win?.webContents.send('routines:changed')
  },
  fire: async (routine) => {
    const agent = routine.agentId ? await getAgent(routine.agentId) : null
    const created = await store.createSession(
      agent?.workspace ?? null,
      // agentId 照实写入：哪怕档案已经被删了，也留下「这条是谁跑的」的痕迹
      routine.agentId || null,
      agent?.modelId ?? null
    )
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
    await store.renameSession(created.id, `${routine.name} · ${stamp}`).catch(() => undefined)

    try {
      await engine.send(created.id, routine.prompt, undefined, {
        nonInteractive: true,
        approvalPolicy: routine.approvalPolicy === 'allow' ? 'allow' : 'deny',
        workspace: agent?.workspace ?? null,
        // 按表跑的活：排队时让到用户提问后面（见 shared/runqueue 的优先级说明）
        reason: 'routine'
      })
    } catch (err) {
      // 跑到一半失败（模型没起来、断网）：会话已经建了，把 id 挂到错误上带出去，
      // 否则用户只看到「失败」两个字，找不到现场
      const withSession = err as Error & { sessionId?: string }
      withSession.sessionId = created.id
      notifyRoutine(`定时任务失败：${routine.name}`, withSession.message)
      win?.webContents.send('routines:changed')
      throw withSession
    }

    notifyRoutine(`定时任务已完成：${routine.name}`, '点开软件查看结果')
    win?.webContents.send('routines:changed')
    return created.id
  }
})

/**
 * 交接的放行器：和定时任务共用「建会话 + 发消息」这条路径，
 * 区别只在触发者 —— 那边是时间，这边是另一个 agent 的判断。
 */
startHandoffPump({
  // 和定时任务同一条规矩：本地一份模型服务，不让两条长任务互相抢
  busy: () => engine.hasRunning(),
  launch: async (handoff, sessionId) => {
    win?.webContents.send('handoffs:changed')
    // 先记下跑之前的累计用量：回执要的是「这一手花了多少」，不是整条会话
    const before = (await store.loadSession(sessionId).catch(() => null))?.usage
    try {
      await engine.send(sessionId, await handoffPrompt(handoff), undefined, {
        nonInteractive: true,
        // 策略在入队时就定好了，这里不允许改：交接只能继承权限，不能给自己提权
        approvalPolicy: handoff.approvalPolicy,
        workspace: handoff.workspace,
        reason: 'handoff'
      })
    } catch (err) {
      notifyRoutine(`交接失败：${handoff.toName ?? '接手方'}`, (err as Error).message)
      win?.webContents.send('handoffs:changed')
      throw err
    }
    const receipt = await handoffReceipt(sessionId, before)
    notifyRoutine(`「${handoff.toName ?? '接手方'}」已接手`, receipt.summary || handoff.task.slice(0, 60))
    win?.webContents.send('handoffs:changed')
    win?.webContents.send('routines:changed')
    return receipt
  }
})

/**
 * 交接回执：接手方干完之后留下的交代。
 *
 * 只放三样「一眼能判断该不该点进去看」的东西：最后一句结论、这一手用掉的 token、
 * 改了哪些文件。过程在会话里，不在这里重复一遍。
 */
async function handoffReceipt(sessionId: string, before?: TokenUsage): Promise<HandoffResult> {
  const session = await store.loadSession(sessionId).catch(() => null)
  const usage = session?.usage
  const last = [...(session?.messages ?? [])]
    .reverse()
    .find((m) => m.role === 'assistant' && m.content.trim())
  const files = (await listChanges(sessionId).catch(() => [])).map((c) => c.path).slice(0, 20)
  return {
    status: 'ok',
    // 结论常常带换行和一堆 markdown，面板里只放一行，压平再截断
    summary: String(last?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    tokens: {
      prompt: Math.max(0, (usage?.prompt ?? 0) - (before?.prompt ?? 0)),
      completion: Math.max(0, (usage?.completion ?? 0) - (before?.completion ?? 0))
    },
    ...(files.length ? { files } : {}),
    at: Date.now()
  }
}

function createWindow(): void {
  // 窗口/任务栏图标：打包后从 app.asar 里取，开发时直接读项目根目录
  const iconPath = path.join(app.getAppPath(), 'build', 'icon.png')
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d0d0f',
    show: false,
    autoHideMenuBar: true,
    title: 'RoRoTo Code',
    // 不要系统那条标题栏：它的底色和界面不同步，还会重复显示一遍软件名。
    // 顶栏完全由页面自己画（软件名留在左侧会话栏，右侧是自绘的最小化/最大化/关闭）。
    frame: false,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 渲染层只通过 preload 暴露的 window.pico 说话，不需要任何 Node 能力。
      // preload 编译后只有一句 require('electron')，在沙箱里是可用的，
      // 所以这里能直接开 —— 代价是 preload 里不能用 fs/path，
      // 需要文件系统时一律走 ipcRenderer.invoke 交给主进程。
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win?.show())

  // 最大化状态同步给渲染层：右上角那个按钮的图标要跟着在「最大化 / 还原」之间切换
  const pushMax = (): void => {
    if (win && !win.isDestroyed()) win.webContents.send('win:maximized', win.isMaximized())
  }
  win.on('maximize', pushMax)
  win.on('unmaximize', pushMax)

  // 页面加载完再套上次的缩放比 / 配色 / 字号：导航到新页面后 zoomFactor 会被重置，
  // CSS 变量也会跟着重新初始化，所以都挂在 did-finish-load 上
  win.webContents.on('did-finish-load', () => {
    if (win && !win.isDestroyed()) void applySavedAppearance(win)
    // --smoke-shot：GUI 冒烟截图。加载完成后等恢复提示条渲染，截图存到 release/gui-smoke/ 再退出。
    if (process.argv.some((a) => a.startsWith('--smoke-shot'))) {
      void (async () => {
        try {
          // --smoke-shot=名字：换个文件名；--smoke-click=选择器：截图前先点一下（用来看设置面板）
          const shotArg = process.argv.find((a) => a.startsWith('--smoke-shot')) ?? ''
          const shotName = shotArg.includes('=') ? shotArg.split('=').slice(1).join('=') : 'gui-full'
          const clickSel = (process.argv.find((a) => a.startsWith('--smoke-click=')) ?? '').split('=').slice(1).join('=')
          // --smoke-scroll=选择器：截图前把它滚到视口中间（面板内部滚动区也能滚）
          const scrollSel = (process.argv.find((a) => a.startsWith('--smoke-scroll=')) ?? '').split('=').slice(1).join('=')
          await new Promise((r) => setTimeout(r, 2500))
          if (clickSel && win && !win.isDestroyed()) {
            // 多个选择器用 || 串起来，依次点，方便一层层打开面板
            for (const sel of clickSel.split('||').filter(Boolean)) {
              await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(sel)})?.click()`)
              await new Promise((r) => setTimeout(r, 700))
            }
            await new Promise((r) => setTimeout(r, 500))
          }
          if (scrollSel && win && !win.isDestroyed()) {
            await win.webContents.executeJavaScript(
              `document.querySelector(${JSON.stringify(scrollSel)})?.scrollIntoView({ block: 'center' })`
            )
            await new Promise((r) => setTimeout(r, 400))
          }
          const outDir = path.join(app.getAppPath(), 'release', 'gui-smoke')
          fs.mkdirSync(outDir, { recursive: true })
          if (win && !win.isDestroyed()) {
            const banner = (await win.webContents.executeJavaScript(
              `(() => { const el = document.querySelector('.resume-banner'); return el ? el.innerText : '' })()`
            )) as string
            const img = await win.webContents.capturePage()
            fs.writeFileSync(path.join(outDir, `${shotName}.png`), img.toPNG())
            console.log(`[smoke-shot] 窗口截图 -> ${path.join(outDir, `${shotName}.png`)}`)
            console.log(`[smoke-shot] 恢复提示条：${banner ? `已渲染（${banner.replace(/\\s+/g, ' ')}）` : '未出现'}`)
          }
        } catch (err) {
          console.error('[smoke-shot] 截图失败：', (err as Error).message)
        } finally {
          quitting = true
          app.quit()
        }
      })()
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    // 设置页的「联系作者」是 mailto:，交给系统邮件客户端，别让窗口自己导航
    if (/^mailto:/i.test(url)) {
      event.preventDefault()
      void shell.openExternal(url)
      return
    }
    if (!url.startsWith('http://localhost:5173')) event.preventDefault()
  })

  if (isDev) {
    void win.loadURL('http://localhost:5173')
  } else {
    void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  }

  win.on('closed', () => {
    win = null
  })

  /**
   * 点 × 之后怎么办（软件设置里可改，默认收进托盘）。
   *
   * 关键点：托盘图标必须真的看得见，否则「收进托盘」等于把程序藏起来——
   * 之前 build/ 里没有任何图标文件，Tray 拿到的是空图，窗口一关就再也找不回来。
   * 所以托盘建不起来时自动降级成最小化到任务栏，绝不让窗口消失得无影无踪。
   */
  win.on('close', (e) => {
    if (quitting) return
    if (closeAction === 'quit') {
      quitting = true
      app.quit()
      return
    }
    e.preventDefault()
    if (closeAction === 'minimize' || !trayAlive()) {
      win?.minimize()
      return
    }
    win?.hide()
    refreshTrayMenu(trayHooks())
    // 第一次收进托盘弹一次气泡：告诉他程序还在，去哪儿找
    void loadPrefs().then((p) => {
      if (p.trayHinted) return
      void savePrefs({ trayHinted: true })
      hintBackground()
    })
  })
  win.on('show', () => refreshTrayMenu(trayHooks()))
  win.on('hide', () => refreshTrayMenu(trayHooks()))
}

/** 托盘菜单/点击要用到的动作，集中在这里，避免各处自己拼 win 状态 */
function trayHooks(): Parameters<typeof createTray>[0] {
  return {
    show: () => showWindow(),
    hide: () => {
      win?.hide()
      refreshTrayMenu(trayHooks())
    },
    visible: () => Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()),
    quit: () => {
      quitting = true
      app.quit()
    }
  }
}

/** 显示主窗口（从托盘恢复或首次创建） */
function showWindow(): void {
  if (!win) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  refreshTrayMenu(trayHooks())
}

/**
 * 建托盘：常驻后台时用户唯一的入口（显示 / 收起 / 退出）。
 * 建不起来（图标全空或被系统拒绝）就明确记为失败——关闭按钮会因此退化成最小化，
 * 不让人点了 × 之后满桌面找不到窗口。
 */
function setupTray(): boolean {
  const ok = createTray(trayHooks())
  if (!ok) log('warn', 'tray', '托盘不可用，关闭按钮降级为最小化到任务栏')
  return ok
}

/**
 * 把配置里的本地地址换成本地运行时的真实地址。
 *
 * 为什么需要：LM Studio 的端口不是固定的（默认 1234，被占用时它自己换，实测本机是 1235），
 * 配置文件里一旦存了旧端口，探测和对话就永远是「不可用」，用户完全看不出原因。
 */
async function withLiveLocalUrl(p: ProviderConfig): Promise<ProviderConfig> {
  const kind = runtimeKindOf(p)
  if (!kind) return p
  const origin = await localOrigin(kind).catch(() => '')
  if (!origin) return p
  const current = p.baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '')
  if (current.toLowerCase() === origin.toLowerCase()) return p
  return { ...p, baseUrl: `${origin}/v1` }
}

/** 启动时把过期的本地地址一次改对并写回磁盘，后续对话直接就能用 */
async function healLocalUrls(): Promise<void> {
  const config = await loadConfig()
  const providers = await Promise.all(config.providers.map((p) => withLiveLocalUrl(p)))
  const changed = providers.some((p, i) => p.baseUrl !== config.providers[i].baseUrl)
  if (!changed) return
  await saveConfig({ ...config, providers }).catch(() => undefined)
  console.log(
    '[local] 已按真实端口校正本地地址：',
    providers
      .filter((p, i) => p.baseUrl !== config.providers[i].baseUrl)
      .map((p) => `${p.name} → ${p.baseUrl}`)
      .join('; ')
  )
}

/**
 * 下载进度统一广播给所有窗口，而不是只回发起的那个 `e.sender`。
 *
 * 下载跑在主进程，本来就和界面无关；但进度以前只发给「点了按钮的那个窗口」，
 * 面板一卸载 / 窗口一换，进度就断了，用户看到的是「切个页面下载就没了」。
 * 广播 + 快照（见 `downloads:snapshot`）之后，谁在前台谁都能接上。
 */
function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    const wc = w.webContents
    if (wc.isDestroyed()) continue
    try {
      wc.send(channel, payload)
    } catch {
      // 帧正在销毁时报错，忽略即可：下次快照还能补上
    }
  }
}

function registerIpc(): void {
  // 后台卸载其它运行时（延迟复查那几轮）后，把结果告诉界面
  setFreedHook((freed) => broadcast('local:freed', { freed }))
  ipcMain.handle('config:get', async () => {
    // 每次读配置都顺手校正本地端口：用户可能刚在 LM Studio 里换了端口
    const config = await loadConfig()
    setAgentsWorkspace(config.workspace ?? null)
    const providers = await Promise.all(config.providers.map((p) => withLiveLocalUrl(p)))
    if (!providers.some((p, i) => p.baseUrl !== config.providers[i].baseUrl)) return config
    const next = { ...config, providers }
    // 写回磁盘：发消息时主进程读的是磁盘配置，只改返回值对话仍会打到旧端口
    void saveConfig(next).catch(() => undefined)
    return next
  })
  ipcMain.handle('config:defaults', async () => defaultProviders())
  ipcMain.handle('config:save', async (_e, config: AppConfig) => {
    try {
      const saved = await saveConfig(config)
      // 工作区换了：项目级档案（.roroto/agents/*.md）要重新扫
      setAgentsWorkspace(saved.workspace ?? null)
      if (saved.workspace) {
        await rememberWorkspace(app.getPath('userData'), saved.workspace).catch(() => undefined)
      }
      await applyProxy(saved.proxyUrl)
      return saved
    } catch (err) {
      log('error', 'config', '保存配置失败', err)
      throw err
    }
  })

  // 项目长期记忆：按当前实际工作区（未选目录时用默认 workspace/）
  ipcMain.handle('memory:info', async () => {
    const ws = await effectiveWorkspace(await loadConfig())
    return await memoryInfo(ws)
  })
  ipcMain.handle('memory:clear', async () => {
    const ws = await effectiveWorkspace(await loadConfig())
    await clearMemory(ws)
    return { ok: true }
  })

  // 共享黑板：和记忆一样按当前实际工作区，只是内容更「临时」——这摊活到哪了
  ipcMain.handle('board:get', async () => {
    const ws = await effectiveWorkspace(await loadConfig())
    return await boardInfo(ws)
  })
  ipcMain.handle('board:clear', async () => {
    const ws = await effectiveWorkspace(await loadConfig())
    return await clearBoard(ws)
  })

  // 今日 token 用量：设置页显示，方便对照「每日上限」看还剩多少
  ipcMain.handle('quota:today', async () => ({ used: await dayUsage() }))

  // ---- 常驻档案与定时任务 ----
  // 界面暂时还没做面板，先把通道铺好：HTTP 控制面和将来的 UI 走的是同一套实现，
  // 不会出现「网页能建、软件里建不了」的两套逻辑。

  ipcMain.handle('agents:list', async () => await listAgents())
  ipcMain.handle('agents:tools', async () => agentTools())
  ipcMain.handle('agents:running', async () => engine.runningRuns())
  ipcMain.handle('agents:save', async (_e, agent: Partial<AgentProfile>) => await upsertAgent(agent))
  ipcMain.handle('agents:remove', async (_e, id: string) => await removeAgent(id))

  // ---- 自定义斜杠命令 / 钩子 ----
  // 两样都是「按工作区扫文件」，所以 workspace 缺省时统一回落到当前实际工作区，
  // 避免界面没传参数时列出来的是用户目录那一份。
  const resolveWs = async (workspace?: string | null): Promise<string> =>
    workspace ?? (await effectiveWorkspace(await loadConfig()))

  ipcMain.handle('commands:list', async (_e, workspace?: string | null) =>
    await listCommands(await resolveWs(workspace))
  )
  ipcMain.handle('commands:expand', async (_e, text: string, workspace?: string | null) => {
    const parsed = await parseCommand(String(text ?? ''), await resolveWs(workspace))
    if (!parsed) return { ok: false, prompt: '', message: '这条不是可识别的命令' }
    return { ok: true, prompt: parsed.prompt, command: parsed.command.name }
  })
  ipcMain.handle('hooks:describe', async (_e, workspace?: string | null) =>
    await describeHooks(await resolveWs(workspace))
  )
  ipcMain.handle('hooks:reload', async () => {
    forgetHookCache()
    return { ok: true }
  })

  ipcMain.handle('routines:list', async () => await listRoutines())
  ipcMain.handle('routines:save', async (_e, routine: Partial<Routine>) => {
    const saved = await upsertRoutine(routine)
    win?.webContents.send('routines:changed')
    return saved
  })
  ipcMain.handle('routines:remove', async (_e, id: string) => {
    const ok = await removeRoutine(id)
    win?.webContents.send('routines:changed')
    return { ok }
  })
  ipcMain.handle('routines:enable', async (_e, id: string, enabled: boolean) => {
    const r = await setEnabled(id, enabled)
    win?.webContents.send('routines:changed')
    return r
  })
  ipcMain.handle('routines:run', async (_e, id: string) => {
    const r = await runRoutine(id)
    win?.webContents.send('routines:changed')
    return r
  })

  ipcMain.handle('handoffs:list', async () => await listHandoffs())
  ipcMain.handle('handoffs:cancel', async (_e, id: string) => {
    const r = await cancelHandoff(id)
    win?.webContents.send('handoffs:changed')
    return r
  })
  ipcMain.handle('handoffs:run', async (_e, id: string) => {
    const r = await runHandoff(id)
    win?.webContents.send('handoffs:changed')
    return r
  })

  ipcMain.handle('instructions:info', async () => {
    const ws = await effectiveWorkspace(await loadConfig())
    return await findInstructions(ws)
  })
  ipcMain.handle('instructions:init', async () => {
    const ws = await effectiveWorkspace(await loadConfig())
    return await initAgents(ws)
  })

  // 项目级权限规则（roroto.json 的 permissions）：读当前规则 + 写回
  ipcMain.handle('permissions:info', async () => {
    const ws = await effectiveWorkspace(await loadConfig())
    const result = await loadProjectPermissionsDetailed(ws)
    return {
      workspace: ws,
      path: ws ? path.join(ws, 'roroto.json') : null,
      rules: result.rules,
      detailed: result.detailed,
      files: result.files
    }
  })
  ipcMain.handle('permissions:save', async (_e, rules: unknown) => {
    const ws = await effectiveWorkspace(await loadConfig())
    const list = Array.isArray(rules) ? (rules as unknown[]) : []
    // 主进程侧兜底校验，避免渲染层直接写进非法数据
    return await saveProjectPermissions(
      ws,
      list.map((r) => r as import('./risk').PermissionRule)
    )
  })

  ipcMain.handle('workspace:choose', async () => {
    const result = await dialog.showOpenDialog({
      title: mt('选择工作区'),
      properties: ['openDirectory'],
      defaultPath: app.getPath('documents')
    })
    if (result.canceled || !result.filePaths.length) return null
    const dir = result.filePaths[0]
    const config = await loadConfig()
    await saveConfig({ ...config, workspace: dir })
    await rememberWorkspace(app.getPath('userData'), dir)
    return dir
  })

  // 工作区登记簿：换走过的目录还能点回来，不必先有会话
  ipcMain.handle('workspace:list', async () => await listWorkspaces(app.getPath('userData')))
  ipcMain.handle('workspace:remember', async (_e, dir: string) =>
    await rememberWorkspace(app.getPath('userData'), dir)
  )
  ipcMain.handle('workspace:forget', async (_e, dir: string) =>
    await forgetWorkspace(app.getPath('userData'), dir)
  )
  ipcMain.handle('workspace:exists', async (_e, dir: string) => await existsDir(dir))

  ipcMain.handle('sessions:list', async () => await store.listSessions())
  ipcMain.handle('sessions:create', async (_e, workspace?: string | null, agentId?: string | null) => {
    const target = workspace ?? (await loadConfig()).workspace ?? null
    // 在这个目录里开工了，就把它记进「最近工作区」
    if (target) await rememberWorkspace(app.getPath('userData'), target).catch(() => undefined)
    return await store.createSession(target, agentId ?? null)
  })
  ipcMain.handle('sessions:load', async (_e, id: string) => await store.loadSession(id))
  ipcMain.handle('sessions:remove', async (_e, id: string) => {
    // 只移进回收站，改动快照先留着：恢复会话后撤销记录还能用
    await store.removeSession(id)
    // 会话级便签只属于这条会话，会话进回收站了它也就不用留了
    await clearScratch(id).catch(() => undefined)
  })
  ipcMain.handle('sessions:deleteTurn', async (_e, id: string, messageId: string) => {
    // 运行中改历史会让正在跑的那一轮拿到错位的数据（摘要缓存还是按索引记的）
    if (engine.isRunning(id)) throw new Error('这个会话正在运行中，请先停止再删除消息')
    const { session, removed } = await store.deleteTurn(id, messageId)
    // 摘要覆盖的范围按消息下标记录，删过之后必须作废，否则会喂回已删内容
    engine.forgetSummary(id)
    return {
      session,
      removed: removed.length,
      savedTokens: messagesTokens(removed)
    }
  })
  ipcMain.handle('sessions:trash', async () => await store.listTrash())
  ipcMain.handle('sessions:restore', async (_e, file: string) => await store.restoreSession(file))
  ipcMain.handle('sessions:purgeTrash', async (_e, file: string) => {
    const id = await store.purgeTrashFile(file)
    // 真的永久删除了，这一条的改动快照才没意义
    await clearChanges(id)
  })
  ipcMain.handle('sessions:purgeAllTrash', async () => {
    const ids = await store.purgeAllTrash()
    // 一次性删一批：快照也要跟着清，否则磁盘上会留下永远不会被读到的 diff
    for (const id of ids) await clearChanges(id).catch(() => undefined)
    return ids.length
  })
  ipcMain.handle('sessions:rename', async (_e, id: string, title: string) => await store.renameSession(id, title))
  ipcMain.handle('sessions:setWorkspace', async (_e, id: string, workspace: string | null) => {
    await store.setSessionWorkspace(id, workspace)
  })
  ipcMain.handle('sessions:setModel', async (_e, id: string, modelId: string | null) => {
    await store.setSessionModel(id, modelId)
  })
  ipcMain.handle('sessions:setModelOverride', async (_e, id: string, model: string | null) => {
    await store.setSessionModelOverride(id, model)
  })
  ipcMain.handle('sessions:setMode', async (_e, id: string, mode: 'plan' | 'build' | null) => {
    await store.setSessionMode(id, mode)
  })
  ipcMain.handle('sessions:approvePlan', async (_e, id: string) => await store.approveSessionPlan(id))
  // 分叉：复制历史，原会话不动。父会话可能正在跑，这里也不该拦 —— 读的是落盘的快照
  ipcMain.handle('sessions:fork', async (_e, id: string, messageId: string | null) =>
    store.forkSession(id, messageId)
  )
  ipcMain.handle('sessions:search', async (_e, query: string) => await store.searchSessions(query))
  ipcMain.handle('sessions:export', async (_e, id: string) => {
    const session = await store.loadSession(id)
    return await exportSessionMarkdown(session)
  })

  ipcMain.handle('chat:send', async (_e, sessionId: string, text: string, files?: SendAttachment[]) => {
    try {
      await engine.send(sessionId, text, files)
    } catch (err) {
      log('error', 'chat', `send 失败（${sessionId}）`, err)
      emit(sessionId, { type: 'error', message: (err as Error).message })
    }
  })
  ipcMain.handle('chat:abort', async (_e, sessionId: string) => engine.abort(sessionId))
  ipcMain.handle('chat:isRunning', async (_e, sessionId: string) => engine.isRunning(sessionId))
  /**
   * 运行中插话。返回 false 表示这一轮其实已经结束了 ——
   * 界面拿到 false 会改走正常发送，不会把话吞掉。
   */
  ipcMain.handle('chat:steer', async (_e, sessionId: string, text: string) => engine.steer(sessionId, text))
  /**
   * 「重跑」类入口共用的错误兜底。
   *
   * 只有 chat:send 兜了的话，其余几个一旦失败，错误会以
   * `Error invoking remote method 'chat:editAndResend': TypeError: terminated`
   * 这种形式原样弹到界面上 —— 那是 IPC 的包装信息，不是人话。
   * 统一改成：记日志 + 发 error 事件，界面按正常错误气泡显示，运行状态也能复位。
   */
  const runChatIpc = async (
    channel: string,
    sessionId: string,
    fn: () => Promise<void>
  ): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      log('error', 'chat', `${channel} 失败（${sessionId}）`, err)
      emit(sessionId, { type: 'error', message: (err as Error).message })
    }
  }
  ipcMain.handle('chat:regenerate', async (_e, sessionId: string) =>
    await runChatIpc('regenerate', sessionId, () => engine.regenerate(sessionId))
  )
  ipcMain.handle(
    'chat:editAndResend',
    async (_e, sessionId: string, messageId: string, text: string) =>
      await runChatIpc('editAndResend', sessionId, () => engine.editAndResend(sessionId, messageId, text))
  )
  ipcMain.handle('chat:resume', async (_e, sessionId: string) =>
    await runChatIpc('resume', sessionId, () => engine.resume(sessionId))
  )

  // 崩溃自动恢复：查上次没跑完的会话 + 用户选择忽略时清除标记
  ipcMain.handle('checkpoints:interrupted', async () => {
    const list = await listInterruptedCheckpoints()
    return list.map((cp) => ({
      sessionId: cp.sessionId,
      workspace: cp.workspace,
      todos: cp.todos.filter((t) => t.status !== 'completed'),
      touched: cp.touched,
      updatedAt: cp.updatedAt
    }))
  })
  ipcMain.handle('checkpoints:dismiss', async (_e, sessionId: string) => await clearCheckpoint(sessionId))

  // 文件改动：列 / 看 diff / 撤销
  ipcMain.handle('changes:list', async (_e, sessionId: string) => await listChanges(sessionId))
  ipcMain.handle('changes:detail', async (_e, sessionId: string, id: string) => await changeDetail(sessionId, id))
  ipcMain.handle('changes:revert', async (_e, sessionId: string, id: string) => await revertChange(sessionId, id))
  ipcMain.handle('changes:applyHunks', async (_e, sessionId: string, id: string, keep: number[]) =>
    await applyHunks(sessionId, id, keep)
  )
  ipcMain.handle('changes:revertAll', async (_e, sessionId: string) => await revertAll(sessionId))

  // 工作区 git
  ipcMain.handle('git:status', async (_e, workspace: string | null) => await gitStatus(workspace))
  ipcMain.handle('git:diff', async (_e, workspace: string | null, file: string) => await gitDiff(workspace, file))
  ipcMain.handle(
    'git:commit',
    async (_e, workspace: string | null, message: string, paths?: string[]) =>
      await gitCommit(workspace, message, paths)
  )

  // 常驻交互式终端
  ipcMain.handle('terminal:open', async (_e, workspace: string, shell?: 'cmd' | 'powershell' | 'bash') =>
    openTerminal(workspace, shell)
  )
  ipcMain.handle('terminal:write', async (_e, id: string, data: string) => writeTerminal(id, data))
  ipcMain.handle(
    'terminal:read',
    async (_e, id: string, since?: number, opts?: { tail?: number; waitMs?: number }) =>
      readTerminal(id, since, opts)
  )
  ipcMain.handle('terminal:close', async (_e, id: string) => closeTerminal(id))
  ipcMain.handle('terminal:list', async () => listTerminals())

  // MCP 外部工具
  ipcMain.handle('mcp:status', async () => await mcpStatus())
  ipcMain.handle('mcp:reload', async () => await reloadMcp())
  ipcMain.handle('mcp:openConfig', async () => await openMcpConfig())

  // 免费模型目录（OpenRouter 动态 + 固定推荐位）
  ipcMain.handle('free:list', async (_e, opts?: { refresh?: boolean }) => await freeCatalog(opts?.refresh))

  ipcMain.on(
    'approval:respond',
    (_e, id: string, approved: boolean, always?: boolean, persist?: boolean) => {
      engine.respondApproval(id, approved, always === true, persist === true)
    }
  )

  ipcMain.on('question:respond', (_e, id: string, answer: string) => {
    engine.respondQuestion(id, answer)
  })

  // 「以后都这样」的授权：给设置页看，也允许单条撤销 / 全部清除
  ipcMain.handle('approvals:list', async () => await listGrants())
  ipcMain.handle('approvals:revoke', async (_e, workspace: string, tool: string) => {
    const ok = await revokeGrant(workspace, tool)
    if (ok) engine.forgetGrants()
    return ok
  })
  ipcMain.handle('approvals:clear', async () => {
    const n = await clearGrants()
    engine.forgetGrants()
    return n
  })

  ipcMain.handle('models:list', async (_e, providerId: string) => {
    const config = await loadConfig()
    const found = config.providers.find((p) => p.id === providerId)
    if (!found) return { ok: false, models: [], error: '配置不存在' }
    const provider = await withLiveLocalUrl(found)
    try {
      const models = await listModels(provider)
      return { ok: true, models }
    } catch (err) {
      return { ok: false, models: [], error: (err as Error).message }
    }
  })

  // 用表单里的（可能尚未保存的）配置直接拉取模型列表
  ipcMain.handle('models:listDraft', async (_e, draft: ProviderConfig) => {
    if (!draft?.baseUrl) return { ok: false, models: [], error: '缺少接口地址' }
    const provider = await withLiveLocalUrl(draft)
    try {
      const models = await listModels(provider)
      return { ok: true, models }
    } catch (err) {
      return { ok: false, models: [], error: (err as Error).message }
    }
  })

  // 用表单里的配置探测可用性：端点连通且配置的模型在列表里才算 ok
  ipcMain.handle('models:probeDraft', async (_e, draft: ProviderConfig) => {
    if (!draft?.baseUrl) return { ok: false, models: [], error: '缺少接口地址' }
    // 表单里可能还写着旧端口（1234），探测前先换成本地运行时的真实地址
    const provider = await withLiveLocalUrl(draft)
    let timer: NodeJS.Timeout | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('连接超时')), 8000)
      })
      const models = await Promise.race([listModels(provider), timeout])
      if (models.length === 0) return { ok: false, models, error: '端点已连通，但没有发现可用模型' }
      if (!provider.model) return { ok: false, models, error: `已连通，请选择模型（可用：${models.slice(0, 3).join('、')}）` }
      if (!modelListed(models, provider.model)) return { ok: false, models, error: `列表中没有 ${provider.model}` }
      return { ok: true, models }
    } catch (err) {
      // 常驻服务没起来时连不上是正常的：装了就是黄灯，别报成红叉
      const idle = await localServiceIdle(provider).catch(() => false)
      return {
        ok: false,
        models: [],
        error: idle ? `${provider.name || '本地服务'}未启动（点「一键启动」）` : (err as Error).message,
        idle
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  })

  // 判断某个配置当前是否真的能用：端点能连通，且配置的模型在列表里
  ipcMain.handle('models:probe', async (_e, providerId: string) => {
    const config = await loadConfig()
    const found = config.providers.find((p) => p.id === providerId)
    if (!found) return { ok: false, models: [], error: '配置不存在' }
    if (!found.baseUrl) return { ok: false, models: [], error: '缺少接口地址' }
    // 关键：配置里可能是过期端口（LM Studio 换过端口），纠正后再探测，否则永远红点
    const provider = await withLiveLocalUrl(found)

    /**
     * 探活通过只说明「端点通、模型在列表里」，不代表模型已经加载进显存。
     * 界面要区分「可用未启动（黄）」和「正在运行（绿）」，所以这里顺带把实情带回去。
     */
    let running = false

    // 本地 llama.cpp 正在加载模型时返回 503，这属于"加载中"而非"不可用"
    if (isLlamaProvider(provider)) {
      const st = await statusLlama(provider.id)
      if (st.loading) return { ok: false, models: [], error: '模型加载中…', loading: true }
      if (!st.running) {
        /**
         * 二进制和模型都在、只是没起来：这是「可用未启动」（黄灯），
         * 红叉只留给真的跑不了的情况（没装 / 没有模型）。
         */
        const canStart = st.code !== 'BINARY_MISSING' && st.code !== 'MODEL_MISSING'
        return {
          ok: false,
          models: st.models ?? [],
          error: canStart ? '本地服务未启动（点「一键启动」）' : st.message,
          idle: canStart
        }
      }
      // llama-server 是带着 -m 起来的：进程在，模型就是加载着的
      running = true
    } else {
      running = await isModelLoaded(provider).catch(() => false)
    }

    let timer: NodeJS.Timeout | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('连接超时')), 8000)
      })
      const models = await Promise.race([listModels(provider), timeout])
      if (models.length === 0) {
        return { ok: false, models, error: '端点已连通，但没有发现可用模型' }
      }
      if (!provider.model) {
        return { ok: false, models, error: `已连通，请选择模型（可用：${models.slice(0, 3).join('、')}）` }
      }
      if (!modelListed(models, provider.model)) {
        return { ok: false, models, error: `列表中没有 ${provider.model}` }
      }
      return { ok: true, models, running }
    } catch (err) {
      return { ok: false, models: [], error: (err as Error).message }
    } finally {
      if (timer) clearTimeout(timer)
    }
  })

  ipcMain.on('shell:showItem', (_e, target: string) => {
    if (target) shell.showItemInFolder(target)
  })

  // 输出面板里点文件名：用系统默认程序打开，打不开就把原因带回去
  ipcMain.handle('shell:openPath', async (_e, target: string) => {
    if (!target) return { ok: false, message: '路径为空' }
    const err = await shell.openPath(target)
    return err ? { ok: false, message: err } : { ok: true }
  })

  // 技能库
  ipcMain.handle('skills:list', async () => await listSkills())
  // 只读探测：不装包、不联网、不改环境，缺什么只给一行可复制的命令
  ipcMain.handle('skills:checkDeps', async () => await checkSkillDeps())
  // /learn：把一段会话的操作轨迹蒸馏成技能。要调模型，所以放在主进程
  ipcMain.handle('skills:distill', async (_e, sessionId: string) => await distillSkill(sessionId))
  ipcMain.handle('skills:save', async (_e, input: { id?: string; name: string; desc?: string; prompt: string }) =>
    await saveSkill(input)
  )
  ipcMain.handle('skills:remove', async (_e, id: string) => await removeSkill(id))
  ipcMain.handle('skills:toggle', async (_e, id: string, enabled: boolean) =>
    await setSkillEnabled(id, enabled === true)
  )
  ipcMain.handle('skills:sources', async () => SOURCES)
  ipcMain.handle('skills:scan', async (_e, input: { repo?: string; sourceId?: string }) => {
    const result = await scanSkills(input ?? {})
    // 标记哪些已经装过：仓库 + 文件路径一致就算已装
    const installed = new Set(
      (await listSkills())
        .filter((s) => s.source)
        .map((s) => `${s.source}:${s.sourcePath ?? ''}`)
    )
    result.skills = result.skills.map((s) => ({
      ...s,
      installed: s.path ? installed.has(`${s.repo}:${s.path}`) : installed.has(`本机内置:`)
    }))
    return result
  })
  ipcMain.handle('skills:install', async (_e, items: Parameters<typeof installRemoteSkills>[0]) =>
    await installRemoteSkills(items)
  )

  ipcMain.handle('files:pick', async (e) => await pickFiles(BrowserWindow.fromWebContents(e.sender)))
  /**
   * 截当前屏幕给模型看。
   *
   * 走和拖文件完全相同的 attachFiles 通道：截图先落到临时目录，再当成一个普通图片附件，
   * 于是缩放、复制进工作区 inbox、视觉模型的格式转换这些逻辑一行都不用重写。
   */
  ipcMain.handle('screen:capture', async () => {
    try {
      const display = screen.getPrimaryDisplay()
      // 高分屏按缩放因子取像素，但别超过 2560：再大只会被 vision.ts 缩回去
      const width = Math.min(2560, Math.round(display.size.width * display.scaleFactor))
      const height = Math.min(1600, Math.round(display.size.height * display.scaleFactor))
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height }
      })
      const shot = sources[0]
      if (!shot) return { items: [], errors: ['没有拿到屏幕画面（可能是权限被拒绝）'] }
      const file = path.join(app.getPath('temp'), `roroto-shot-${Date.now()}.png`)
      fs.writeFileSync(file, shot.thumbnail.toPNG())
      return await attachFiles([file])
    } catch (err) {
      return { items: [], errors: [`截屏失败：${(err as Error).message}`] }
    }
  })
  ipcMain.handle('files:attach', async (_e, paths: string[]) => await attachFiles(paths))
  ipcMain.handle('files:list', async (_e, query?: string) => {
    const config = await loadConfig()
    return await searchWorkspaceFiles(await effectiveWorkspace(config), query)
  })
  ipcMain.handle('files:thumb', (_e, absPath: string) => imageThumb(absPath))
  /**
   * 正文里的本地图片（模型写的 `![](./shot.png)`）。
   * 渲染层没有文件系统权限，读盘、格式白名单、大小限制都在这里做。
   */
  ipcMain.handle('files:image', async (_e, src: string) => {
    const cfg = await loadConfig().catch(() => null)
    return imagePreview(src, cfg?.workspace ?? null)
  })

  // 一键安装 / 下载：下载压缩包时把进度（含每秒速度）广播出去
  ipcMain.handle('llama:install', async () => {
    return await installLlama((p) => broadcast('local:setupProgress', p))
  })
  ipcMain.handle('llama:cancelInstall', async () => cancelLlamaInstall())
  ipcMain.handle('llama:configure', async () => await configureLlama())
  ipcMain.handle('llama:models', async () => await listLocalModels())
  // 删除本地模型文件：路径校验、占用检查、配套投影器清理都在主进程里做
  ipcMain.handle('llama:deleteModel', async (_e, rel: string) => await deleteLocalModel(rel))
  ipcMain.handle(
    'llama:start',
    async (
      _e,
      model?: string,
      ctx?: number,
      opts?: { providerId?: string; device?: string | null; port?: number; activate?: boolean; ctxExplicit?: boolean }
    ) => {
      const r = await startLlama(model, ctx, opts)
      // 启动并使用 = 切模型：立刻清掉其它运行时的显存占用，再隔几秒复查
      if (r.ok && opts?.activate) await secureGpuForActive()
      return r
    }
  )
  ipcMain.handle('llama:status', async (_e, providerId?: string) => await statusLlama(providerId))
  ipcMain.handle('llama:stop', async (_e, providerId?: string) => await stopLlama(providerId))
  // 当前有几个本地实例在跑：双卡双模型时界面要显示「两个都在跑」
  ipcMain.handle('llama:instances', async () => llamaInstances())
  // 可绑定的设备清单：直接问 llama-server，名字和 -dev 参数完全一致
  ipcMain.handle('llama:devices', async () => await listLlamaDevices())
  /**
   * 实测多槽并发。要真打服务端，所以用当前（或指定）供应商的真实配置，
   * 不走全局闸门 —— 那道闸门会按槽位排队，把要测的并发变成串行。
   */
  ipcMain.handle('llama:probeSlots', async (_e, providerId?: string) => {
    const cfg = await loadConfig()
    const p = providerId
      ? cfg.providers.find((x) => x.id === providerId)
      : cfg.providers.find((x) => x.id === cfg.activeId)
    if (!p) {
      return {
        verdict: 'error',
        slots: 0,
        testCtx: 0,
        singleMs: null,
        concurrentMs: null,
        promptTokens: null,
        message: '没找到要测的模型配置。先在模型页选中一个本地 provider。'
      }
    }
    return await probeSlotsConcurrency({
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model: p.model,
      contextWindow: p.contextWindow
    })
  })
  /**
   * 工人模型能不能和当前对话模型并行跑。界面用它显示状态与原因，
   * 不再让用户以为「配了就在并行」。
   */
  ipcMain.handle('worker:plan', async (_e, providerId?: string) => {
    const config = await loadConfig()
    const main = providerId
      ? config.providers.find((p) => p.id === providerId)
      : config.providers.find((p) => p.id === config.activeId)
    if (!main) return null
    return await workerPlan(main, config)
  })
  /**
   * 后台预热工人模型的本地实例。不 await 加载完成：模型加载几十秒，
   * 等它只会让界面卡住，用户该先聊起来。
   */
  ipcMain.handle('worker:warm', async (_e, providerId?: string) => {
    const config = await loadConfig()
    const main = providerId
      ? config.providers.find((p) => p.id === providerId)
      : config.providers.find((p) => p.id === config.activeId)
    if (!main) return { ok: false, message: '找不到当前模型' }
    return await warmWorker(main, config)
  })
  ipcMain.handle('llama:backend', async () => await detectBackend())
  ipcMain.handle('llama:checkUpdate', async () => await checkLlamaUpdate())
  // 简易核心：建 core/ → 下模型 → 装 llama.cpp → 配置 → 加载 → 自检，一路跑完再回界面
  ipcMain.handle('core:setup', async () => {
    return await setupCore((p) => broadcast('core:progress', p))
  })
  ipcMain.handle('core:cancel', async () => cancelCoreSetup())
  // 体检：本地模型到底跑不跑得动、能开多大上下文，由 vramfit 算
  ipcMain.handle('vramfit:available', async () => vramfitAvailable())
  ipcMain.handle(
    'vramfit:check',
    // 体检要按「真正会用的 KV 精度」算，否则界面上的建议上下文会比实际能力小一档。
    // KV 精度本身也跟卡走：双卡机器上 2080 只有 -ctk，4090 是 -ctk+-ctv，
    // 拿第一张卡的精度去体检第二张，结论必然偏。
    async (_e, file: string, gpuIndex?: number) => {
      /**
       * 带上这个模型自己的投影器：界面上的报告必须和启动时的口径一致。
       * 否则会出现「面板说 32K 装得下 → 点启动也给你 32K → 发张图直接 OOM」。
       */
      const mm = await findMmprojFor(file).catch(() => null)
      return await checkModel(file, gpuIndex ?? 0, await launchKvType(gpuIndex ?? 0), mm)
    }
  )
  ipcMain.handle('local:status', async (_e, kind: LocalRuntimeKind) => await localStatus(kind))
  ipcMain.handle('local:start', async (_e, kind: LocalRuntimeKind) => await startLocal(kind))
  ipcMain.handle(
    'local:configure',
    async (_e, kind: LocalRuntimeKind, model?: string, opts?: { activate?: boolean }) => {
      const r = await configureLocal(kind, model, opts)
      // 一键启动 Ollama / LM Studio 也是「切过去用」：llama.cpp 那边该让出显存
      if (r.ok && opts?.activate) await secureGpuForActive()
      return r
    }
  )
  // 切换模型后释放用不到的本地实例：绑了显卡的「双卡双模型」实例不动，只清没绑卡的
  ipcMain.handle('local:release', async (_e, providerId: string | null) => {
    const freed = await releaseIdleRuntimes(providerId)
    // 正在加载中的模型这会儿还看不到，过几秒再复查（见 scheduleRuntimeRelease）
    scheduleRuntimeRelease(providerId)
    return { ok: true, freed }
  })

  ipcMain.handle('local:pull', async (_e, name: string) => await pullOllama(name))
  // 本地服务里现在加载着哪些模型、用哪张卡：顶栏的显卡标签与本地模型面板都读它
  ipcMain.handle('local:gpu', async () => await localGpuSnapshot())
  // 复用本程序下载的 GGUF：列出来 → 导入到 Ollama / LM Studio
  ipcMain.handle('local:ggufs', async () => await listImportableGgufs())
  ipcMain.handle(
    'local:import',
    async (_e, kind: LocalRuntimeKind, file: string, label?: string) => await importLocalModel(kind, file, label)
  )

  // 一键安装 / 下载：下载安装包时把进度广播出去
  ipcMain.handle('local:install', async (_e, kind: LocalRuntimeKind) => {
    return await installLocal(kind, (p) => broadcast('local:setupProgress', p))
  })
  ipcMain.handle('local:cancelInstall', async () => cancelLocalInstall())
  ipcMain.handle('system:specs', async () => await systemSpecs())
  ipcMain.handle('app:info', async () => await appInfo())
  // 自绘标题栏的三个按钮
  ipcMain.on('win:minimize', () => win?.minimize())
  ipcMain.on('win:toggleMaximize', () => {
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('win:close', () => win?.close())
  ipcMain.handle('app:prefs', async () => await loadPrefs())
  ipcMain.handle('app:setZoom', async (_e, factor: number) => await setZoom(factor))
  // 渲染层切换中/英时同步过来，主进程的系统对话框（含托盘菜单）用同一套语言
  ipcMain.handle('app:setLang', (_e, lang: 'zh' | 'en') => {
    setMainLang(lang)
    refreshTrayMenu(trayHooks())
  })
  ipcMain.handle('app:setPrefs', async (_e, patch: Partial<import('../shared/types').AppPrefs>) => {
    const saved = await savePrefs(patch)
    // 关闭按钮的行为可能刚被改过，内存副本跟上，托盘菜单文案也刷一遍
    if (patch.closeAction !== undefined) {
      closeAction = saved.closeAction
      refreshTrayMenu(trayHooks())
    }
    // 换配色时把窗口底色一起换掉，拖大小时不会露出旧底色
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.setBackgroundColor(windowBg(saved.theme))
    }
    return saved
  })
  ipcMain.handle('app:openDataDir', async () => await openDataDir())
  ipcMain.handle('app:openLogs', async () => {
    const err = await shell.openPath(logDir())
    return err ? { ok: false, message: err } : { ok: true }
  })

  // 基础核心库：检测 + 一键安装（下载进度推给发起的窗口）
  ipcMain.handle('tools:check', async () => await checkTools())
  ipcMain.handle('tools:install', async (_e, ids: BaseToolId[]) => {
    return await installTools(ids, (p) => broadcast('tools:progress', p))
  })

  // 可下载模型：目录 + 下载（进度广播；下载本身不依赖任何界面）
  // 目录改成流式：每解析出一个模型就广播一条，界面「刷出一个显示一个」，
  // 不用等 300 条的体积全部 HEAD 完。runId 让界面能丢掉上一次检索的迟到条目。
  ipcMain.handle(
    'models:catalog',
    async (_e, opts?: { query?: string; refresh?: boolean; runId?: string; localOnly?: boolean }) =>
      await listCatalog(opts, (model, runId) => {
        broadcast('models:catalog:item', { runId, model, dir: modelsRoot() })
      })
  )
  ipcMain.handle('models:download', async (_e, id: string) => {
    return await downloadModel(id, (p) => broadcast('models:progress', p))
  })
  ipcMain.on('models:cancel', (_e, id: string) => cancelDownload(id))
  ipcMain.handle('models:remove', async (_e, id: string) => await removeModel(id))
  /**
   * 当前还在跑的下载快照：面板（重新）挂载时先问一下，把进度条接回来。
   * 这条通道是「切页面不中断」的另一半 —— 光不中断不够，回来还得看得见。
   */
  ipcMain.handle('downloads:snapshot', async () => ({
    models: downloadsSnapshot(),
    llama: llamaSetupSnapshot(),
    local: localSetupSnapshot(),
    core: coreSetupSnapshot()
  }))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  /**
   * 无窗口模式：`roro.exe --headless`。
   *
   * 只跳过建窗口这一步，其余（清理残留、heal 旧端口、HTTP 控制面）照常跑。
   * 注意 Electron 没有真正意义的 headless —— Chromium 仍在进程里，省不了内存；
   * 它的价值是「不用人点」：能被 systemd / nssm 托管、能进 CI、能被别的 agent 调用。
   */
  const HEADLESS = process.argv.includes('--headless')
  const argOf = (name: string): string | undefined => {
    const hit = process.argv.find((a) => a.startsWith(`${name}=`))
    return hit ? hit.slice(name.length + 1) : undefined
  }

  app.on('second-instance', () => {
    if (!win) {
      createWindow()
      return
    }
    // 收进托盘时窗口是隐藏的，只 focus 叫不回来
    showWindow()
  })

  void app.whenReady().then(async () => {
    // 先挂全局异常捕获：启动阶段最容易因为配置损坏 / 端口占用静默退出
    process.on('uncaughtException', (err) => {
      log('error', 'process', 'uncaughtException', err)
      if (!HEADLESS) {
        try {
          dialog.showErrorBox('RoRoTo Code 出错', redact(err.message))
        } catch {
          // 弹窗都失败就只留日志
        }
      }
    })
    process.on('unhandledRejection', (reason) => {
      log('error', 'process', 'unhandledRejection', reason)
    })
    log('info', 'app', `启动 v${app.getVersion()}，日志：${logPath()}`)

    registerIpc()
    // 清理上次异常退出遗留的本地模型进程
    cleanupStaleLlama()
    /**
     * 空闲卸载：本地服务闲着就释放显存，下次发消息自动拉起。
     *
     * 挂在 whenReady 而不是 llama 模块顶层：模块顶层注册定时器会在
     * 测试 / 无头模式下也跑起来，那时根本没有实例，白占一个计时器。
     */
    startIdleUnload()
    /**
     * 空闲卸载的反向操作：请求进来时把服务叫醒。
     *
     * 注册在 providers 层而不是在 agent 里逐个调用点埋：本地服务的所有流量
     * （主对话、标题生成、子代理、定时任务）都走 OpenAI 兼容通道，一处就够。
     */
    setLocalWaker((provider) => wakeLlama(provider))
    // 启动就把「配置里写死的旧端口」修对（LM Studio 会自己换端口）
    await healLocalUrls().catch((err) => log('warn', 'startup', '修正本地端口失败', err))
    // 装过简易核心的机器：配置里没有那条「核心模型」就补上（不切 activeId），
    // 让它在「④ 模型列表」里看得见，也保证兜底时一定有东西可用
    void (async () => {
      try {
        const file = await coreModelFile()
        if (file && !(await coreProvider())) await ensureCoreProvider(file)
      } catch (err) {
        log('warn', 'startup', '补核心模型配置失败', err)
      }
    })()
    try {
      const config = await loadConfig()
      await applyProxy(config.proxyUrl)
      await store.adoptOrphanSessions(config.workspace)
      // 会话归档：只把「超出数量上限且很久没动」的移进回收站，可恢复。
      // 放在 purgeTrash 之前——先归档再清过期的，刚移进去的不会被当成过期删掉。
      const pruned = await store.pruneSessions().catch((err) => {
        log('warn', 'startup', '会话归档失败', err)
        return null
      })
      if (pruned && pruned.archived > 0) {
        log(
          'info',
          'startup',
          `会话归档：${pruned.archived} 个长期未动的会话移入回收站（原有 ${pruned.scanned} 个，释放 ${Math.round(pruned.archivedBytes / 1024)} KB）`
        )
      }
      // 回收站里超过保留期的会话：连改动快照一起清掉
      for (const id of await store.purgeTrash()) await clearChanges(id).catch(() => undefined)
    } catch (err) {
      log('error', 'startup', '配置 / 会话迁移失败', err)
    }

    // HTTP 控制面：GUI 和 headless 都开。没有它，外部进程连「模型到底加载完没有」都问不到
    try {
      const d = await startDaemon({ port: Number(argOf('--port') ?? NaN) })
      // headless 下没有窗口可显示，这行就是用户唯一的入口提示
      console.log(`[roro] 控制面已启动：http://127.0.0.1:${d.port}`)
      console.log(`[roro] token：${d.token}`)
      console.log(`[roro] 试用：curl -H "Authorization: Bearer ${d.token}" http://127.0.0.1:${d.port}/status`)
      if (HEADLESS) {
        console.log('[roro] headless 模式：未创建窗口，Ctrl+C 退出')
        return
      }
    } catch (err) {
      // 控制面起不来不该拖垮整个应用
      console.error(`[roro] 控制面启动失败：${(err as Error).message}`)
      if (HEADLESS) app.quit()
    }

    // 关闭按钮的行为要先读进内存：close 事件是同步的，不能在里面等磁盘
    closeAction = (await loadPrefs().catch(() => null))?.closeAction ?? 'tray'
    createWindow()
    setupTray()
    // 闲置的 tsserver 每十分钟清一次：一个实例占 60-100MB，不用了就该退
    setInterval(reapDiagnostics, 10 * 60_000).unref()
  })

  app.on('window-all-closed', () => {
    // 关窗即后台运行：不退出，保留托盘和控制面。真正退出走托盘「退出」或系统关闭。
    if (process.platform !== 'darwin' && !quitting) {
      // 什么都不做：进程常驻后台
    }
  })

  // 退出前释放本地模型显存
  app.on('before-quit', () => {
    quitting = true
    // 退出前把还攒着的正文发掉，别让最后几个字只活在内存里
    coalescer.flushAll()
    destroyTray()
    stopDaemon()
    stopLlamaSync()
    shutdownMcp()
    // 交接队列的定时器也要收掉，否则退出过程中还会试着发消息
    stopHandoffPump()
    // 类型检查服务是子进程，不主动杀会留一堆孤儿 node
    disposeDiagnostics()
    // 交互式终端也是常驻子进程，同样要收掉
    disposeAllTerminals()
  })
}

export type { PicoAPI }
