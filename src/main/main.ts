import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, session, shell, Tray } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { defaultProviders, effectiveWorkspace, loadConfig, saveConfig } from './config'
import * as store from './store'
import { log, logDir, logPath } from './log'
import { redact } from './redact'
import { AgentEngine, messagesTokens } from './agent'
import { listModels } from './providers'
import {
  cancelLlamaInstall,
  cleanupStaleLlama,
  configureLlama,
  detectBackend,
  installLlama,
  listLlamaDevices,
  listLocalModels,
  llamaInstances,
  releaseUnpinnedLlama,
  startLlama,
  statusLlama,
  stopLlama,
  stopLlamaExcept,
  stopLlamaSync
} from './llama'
import { cancelCoreSetup, coreModelFile, coreProvider, ensureCoreProvider, setupCore } from './core'
import { isLlamaProvider, runtimeKindOf } from '../shared/providers'
import { warmWorker, workerPlan } from './worker'
import { systemSpecs } from './sysinfo'
import { checkModel, vramfitAvailable } from './vramfit'
import { appInfo, applySavedAppearance, loadPrefs, openDataDir, savePrefs, setZoom, windowBg } from './appinfo'
import { broadcastAgentEvent, setChatHandler, startDaemon, stopDaemon, subscribeChat } from './daemon'
import { clearCheckpoint, listInterruptedCheckpoints } from './checkpoint'
import {
  cancelLocalInstall,
  configureLocal,
  importLocalModel,
  installLocal,
  listImportableGgufs,
  localOrigin,
  localStatus,
  pullOllama,
  startLocal,
  unloadRuntime
} from './locals'
import { installRemoteSkills, listSkills, removeSkill, saveSkill } from './skills'
import { scanSkills, SOURCES } from './skillhub'
import { attachFiles, pickFiles, searchWorkspaceFiles } from './files'
import { imageThumb } from './vision'
import { checkTools, installTools } from './basetools'
import { cancelDownload, downloadModel, listCatalog } from './models'
import { clearMemory, memoryInfo } from './memory'
import { findInstructions, initAgents } from './instructions'
import { loadProjectPermissions, saveProjectPermissions } from './permissions'
import { mt, setMainLang } from './i18n'
import { changeDetail, clearChanges, listChanges, revertAll, revertChange } from './changes'
import { gitCommit, gitDiff, gitStatus } from './git'
import { mcpStatus, openMcpConfig, reloadMcp, shutdownMcp } from './mcp'
import { freeCatalog } from './freedir'
import { exportSessionMarkdown } from './exporter'
import type {
  AgentEvent,
  AppConfig,
  BaseToolId,
  LocalRuntimeKind,
  PicoAPI,
  ProviderConfig,
  SendAttachment
} from '../shared/types'

const isDev = process.env.PICODEV === '1'
let win: BrowserWindow | null = null
let tray: Tray | null = null
/** 点了「退出」才置真；点关闭按钮只隐藏窗口，不退出 */
let quitting = false

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

function emit(sessionId: string, event: AgentEvent): void {
  // 出错的事件统一落一条日志：界面上 toast 会消失，日志能留着复盘
  if (event.type === 'error') log('error', 'agent', `${sessionId}: ${event.message}`)
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent:event', { sessionId, event })
  }
  // 无头 /chat 的 SSE 订阅者也要拿到同一份事件
  broadcastAgentEvent(sessionId, event)
}

const engine = new AgentEngine(emit)

// 把 agent 引擎接到 HTTP 控制面，外部进程就能驱动同一个引擎跑无头任务
setChatHandler({
  createSession: async (workspace?: string | null) => {
    const s = await store.createSession(workspace ?? null)
    return s.id
  },
  send: (sessionId, text, options) =>
    engine.send(sessionId, text, undefined, { nonInteractive: true, approvalPolicy: options?.approvalPolicy ?? 'deny' }),
  abort: (sessionId) => engine.abort(sessionId),
  subscribe: (sessionId, cb) => subscribeChat(sessionId, cb),
  isRunning: (sessionId) => engine.isRunning(sessionId)
})

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
      sandbox: false
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

  // 点关闭按钮 → 隐藏到托盘后台运行，而不是退出。
  // 只有当用户从托盘菜单选「退出」或系统关闭时才真正退出（quitting 置真）。
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win?.hide()
    }
  })
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
}

/** 托盘：常驻后台时用户唯一的入口，菜单给「显示」和「退出」 */
function createTray(): void {
  if (tray) return
  const iconPath = path.join(app.getAppPath(), 'build', 'icon.png')
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('RoRoTo Code')
  const menu = Menu.buildFromTemplate([
    { label: '显示 RoRoTo Code', click: () => showWindow() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
  // 单击托盘图标也恢复窗口
  tray.on('click', () => showWindow())
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
 * 切换模型时释放「这次用不到」的本地运行时。
 *
 * 两条规则，对应两种机器：
 * - 绑了显卡的 llama.cpp 实例**不动**：那是用户明确安排的「双卡双模型」，切走也得留着，
 *   否则第二张卡白空着，等于把刚做好的功能又关掉。
 * - 没绑卡的老实例照旧清掉：单张卡上再起一个必然抢显存（8 GB 上两个 7B 直接 OOM）。
 *
 * keepId 是「接下来要用的供应商」，它自己的实例和它同类的运行时都保留。
 */
async function releaseIdleRuntimes(keepId: string | null): Promise<string[]> {
  const freed: string[] = []
  const config = await loadConfig()
  const keep = keepId ? config.providers.find((p) => p.id === keepId) ?? null : null
  const keepKind = keep ? runtimeKindOf(keep) : null
  const keepLocalLlama = keep ? isLlamaProvider(keep) : false

  // 切到远端模型：本地主模型该让出显存，但工人模型要留着给子代理用
  if (keep && !keepLocalLlama && !keepKind) {
    const worker = config.providers.find((p) => p.role === 'worker' && p.model)
    const keepKeys = worker && isLlamaProvider(worker) ? [worker.id] : []
    const r = await stopLlamaExcept(keepKeys).catch(() => null)
    if (r?.stopped.length) freed.push(`llama.cpp 已停止 ${r.stopped.join('、')}，显存已释放`)
  } else {
    // 本地模型之间切换：只清理没绑卡的实例，绑了不同卡的留着（双卡双模型）
    const r = await releaseUnpinnedLlama(keep?.id ?? null).catch(() => null)
    if (r?.stopped.length) freed.push(`llama.cpp 已停止 ${r.stopped.join('、')}，显存已释放`)
  }

  for (const kind of ['ollama', 'lmstudio'] as const) {
    if (keepKind === kind) continue
    const rr = await unloadRuntime(kind).catch(() => null)
    if (rr?.released.length) {
      freed.push(`${kind === 'ollama' ? 'Ollama' : 'LM Studio'} 已卸载 ${rr.released.join('、')}`)
    }
  }

  return freed
}

function registerIpc(): void {
  ipcMain.handle('config:get', async () => {
    // 每次读配置都顺手校正本地端口：用户可能刚在 LM Studio 里换了端口
    const config = await loadConfig()
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
    const rules = await loadProjectPermissions(ws)
    return { workspace: ws, path: ws ? path.join(ws, 'roroto.json') : null, rules }
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
    return dir
  })

  ipcMain.handle('sessions:list', async () => await store.listSessions())
  ipcMain.handle('sessions:create', async (_e, workspace?: string | null) => {
    const target = workspace ?? (await loadConfig()).workspace ?? null
    return await store.createSession(target)
  })
  ipcMain.handle('sessions:load', async (_e, id: string) => await store.loadSession(id))
  ipcMain.handle('sessions:remove', async (_e, id: string) => {
    // 只移进回收站，改动快照先留着：恢复会话后撤销记录还能用
    await store.removeSession(id)
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
  ipcMain.handle('sessions:rename', async (_e, id: string, title: string) => await store.renameSession(id, title))
  ipcMain.handle('sessions:setWorkspace', async (_e, id: string, workspace: string | null) => {
    await store.setSessionWorkspace(id, workspace)
  })
  ipcMain.handle('sessions:setModel', async (_e, id: string, modelId: string | null) => {
    await store.setSessionModel(id, modelId)
  })
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
  ipcMain.handle('chat:regenerate', async (_e, sessionId: string) => await engine.regenerate(sessionId))
  ipcMain.handle(
    'chat:editAndResend',
    async (_e, sessionId: string, messageId: string, text: string) =>
      await engine.editAndResend(sessionId, messageId, text)
  )
  ipcMain.handle('chat:resume', async (_e, sessionId: string) => await engine.resume(sessionId))

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
  ipcMain.handle('changes:revertAll', async (_e, sessionId: string) => await revertAll(sessionId))

  // 工作区 git
  ipcMain.handle('git:status', async (_e, workspace: string | null) => await gitStatus(workspace))
  ipcMain.handle('git:diff', async (_e, workspace: string | null, file: string) => await gitDiff(workspace, file))
  ipcMain.handle(
    'git:commit',
    async (_e, workspace: string | null, message: string, paths?: string[]) =>
      await gitCommit(workspace, message, paths)
  )

  // MCP 外部工具
  ipcMain.handle('mcp:status', async () => await mcpStatus())
  ipcMain.handle('mcp:reload', async () => await reloadMcp())
  ipcMain.handle('mcp:openConfig', async () => await openMcpConfig())

  // 免费模型目录（OpenRouter 动态 + 固定推荐位）
  ipcMain.handle('free:list', async (_e, opts?: { refresh?: boolean }) => await freeCatalog(opts?.refresh))

  ipcMain.on('approval:respond', (_e, id: string, approved: boolean, always?: boolean) => {
    engine.respondApproval(id, approved, always)
  })

  ipcMain.on('question:respond', (_e, id: string, answer: string) => {
    engine.respondQuestion(id, answer)
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
      return { ok: false, models: [], error: (err as Error).message }
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

    // 本地 llama.cpp 正在加载模型时返回 503，这属于"加载中"而非"不可用"
    if (isLlamaProvider(provider)) {
      const st = await statusLlama(provider.id)
      if (st.loading) return { ok: false, models: [], error: '模型加载中…', loading: true }
      if (!st.running) return { ok: false, models: [], error: '本地服务未启动（点「一键启动」）' }
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
      return { ok: true, models }
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
  ipcMain.handle('skills:save', async (_e, input: { id?: string; name: string; desc?: string; prompt: string }) =>
    await saveSkill(input)
  )
  ipcMain.handle('skills:remove', async (_e, id: string) => await removeSkill(id))
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
  ipcMain.handle('files:attach', async (_e, paths: string[]) => await attachFiles(paths))
  ipcMain.handle('files:list', async (_e, query?: string) => {
    const config = await loadConfig()
    return await searchWorkspaceFiles(await effectiveWorkspace(config), query)
  })
  ipcMain.handle('files:thumb', (_e, absPath: string) => imageThumb(absPath))

  // 一键安装 / 下载：下载压缩包时把进度（含每秒速度）推给发起的窗口
  ipcMain.handle('llama:install', async (e) => {
    const sender = e.sender
    return await installLlama((p) => {
      if (!sender.isDestroyed()) sender.send('local:setupProgress', p)
    })
  })
  ipcMain.handle('llama:cancelInstall', async () => cancelLlamaInstall())
  ipcMain.handle('llama:configure', async () => await configureLlama())
  ipcMain.handle('llama:models', async () => await listLocalModels())
  ipcMain.handle(
    'llama:start',
    async (_e, model?: string, ctx?: number, opts?: { providerId?: string; device?: string | null; port?: number }) =>
      await startLlama(model, ctx, opts)
  )
  ipcMain.handle('llama:status', async (_e, providerId?: string) => await statusLlama(providerId))
  ipcMain.handle('llama:stop', async (_e, providerId?: string) => await stopLlama(providerId))
  // 当前有几个本地实例在跑：双卡双模型时界面要显示「两个都在跑」
  ipcMain.handle('llama:instances', async () => llamaInstances())
  // 可绑定的设备清单：直接问 llama-server，名字和 -dev 参数完全一致
  ipcMain.handle('llama:devices', async () => await listLlamaDevices())
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
  // 简易核心：建 core/ → 下模型 → 装 llama.cpp → 配置 → 加载 → 自检，一路跑完再回界面
  ipcMain.handle('core:setup', async (e) => {
    const sender = e.sender
    return await setupCore((p) => {
      if (!sender.isDestroyed()) sender.send('core:progress', p)
    })
  })
  ipcMain.handle('core:cancel', async () => cancelCoreSetup())
  // 体检：本地模型到底跑不跑得动、能开多大上下文，由 vramfit 算
  ipcMain.handle('vramfit:available', async () => vramfitAvailable())
  ipcMain.handle('vramfit:check', async (_e, file: string, gpuIndex?: number) => await checkModel(file, gpuIndex ?? 0))
  ipcMain.handle('local:status', async (_e, kind: LocalRuntimeKind) => await localStatus(kind))
  ipcMain.handle('local:start', async (_e, kind: LocalRuntimeKind) => await startLocal(kind))
  ipcMain.handle(
    'local:configure',
    async (_e, kind: LocalRuntimeKind, model?: string) => await configureLocal(kind, model)
  )
  // 切换模型后释放用不到的本地实例：绑了显卡的「双卡双模型」实例不动，只清没绑卡的
  ipcMain.handle('local:release', async (_e, providerId: string | null) => {
    const freed = await releaseIdleRuntimes(providerId)
    return { ok: true, freed }
  })

  ipcMain.handle('local:pull', async (_e, name: string) => await pullOllama(name))
  // 复用本程序下载的 GGUF：列出来 → 导入到 Ollama / LM Studio
  ipcMain.handle('local:ggufs', async () => await listImportableGgufs())
  ipcMain.handle(
    'local:import',
    async (_e, kind: LocalRuntimeKind, file: string, label?: string) => await importLocalModel(kind, file, label)
  )

  // 一键安装 / 下载：下载安装包时把进度推给发起的窗口
  ipcMain.handle('local:install', async (e, kind: LocalRuntimeKind) => {
    const sender = e.sender
    return await installLocal(kind, (p) => {
      if (!sender.isDestroyed()) sender.send('local:setupProgress', p)
    })
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
  // 渲染层切换中/英时同步过来，主进程的系统对话框用同一套语言
  ipcMain.handle('app:setLang', (_e, lang: 'zh' | 'en') => {
    setMainLang(lang)
  })
  ipcMain.handle('app:setPrefs', async (_e, patch: Partial<import('../shared/types').AppPrefs>) => {
    const saved = await savePrefs(patch)
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
  ipcMain.handle('tools:install', async (e, ids: BaseToolId[]) => {
    const sender = e.sender
    return await installTools(ids, (p) => {
      if (!sender.isDestroyed()) sender.send('tools:progress', p)
    })
  })

  // 可下载模型：目录 + 下载（进度推给发起的窗口）
  ipcMain.handle('models:catalog', async (_e, opts?: { query?: string; refresh?: boolean }) => await listCatalog(opts))
  ipcMain.handle('models:download', async (e, id: string) => {
    const sender = e.sender
    return await downloadModel(id, (p) => {
      if (!sender.isDestroyed()) sender.send('models:progress', p)
    })
  })
  ipcMain.on('models:cancel', (_e, id: string) => cancelDownload(id))
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
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
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

    createWindow()
    createTray()
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
    tray?.destroy()
    tray = null
    stopDaemon()
    stopLlamaSync()
    shutdownMcp()
  })
}

export type { PicoAPI }
