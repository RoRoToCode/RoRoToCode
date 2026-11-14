import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AgentEventEnvelope,
  AppConfig,
  AppPrefs,
  BaseToolId,
  CatalogStreamItem,
  CoreProgress,
  DownloadProgress,
  LlamaProbeProgress,
  LocalGpuSnapshot,
  LocalRuntimeKind,
  PermissionRule,
  PicoAPI,
  ProviderConfig,
  RemoteSkill,
  SendAttachment,
  SetupProgress,
  ToolSetupProgress
} from './shared/types'

const api: PicoAPI = {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    save: (config: AppConfig) => ipcRenderer.invoke('config:save', config),
    defaults: () => ipcRenderer.invoke('config:defaults')
  },
  workspace: {
    choose: () => ipcRenderer.invoke('workspace:choose'),
    list: () => ipcRenderer.invoke('workspace:list'),
    remember: (dir: string) => ipcRenderer.invoke('workspace:remember', dir),
    forget: (dir: string) => ipcRenderer.invoke('workspace:forget', dir),
    exists: (dir: string) => ipcRenderer.invoke('workspace:exists', dir)
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: (workspace?: string | null, agentId?: string | null) =>
      ipcRenderer.invoke('sessions:create', workspace, agentId),
    load: (id: string) => ipcRenderer.invoke('sessions:load', id),
    remove: (id: string) => ipcRenderer.invoke('sessions:remove', id),
    deleteTurn: (id: string, messageId: string) =>
      ipcRenderer.invoke('sessions:deleteTurn', id, messageId),
    rename: (id: string, title: string) => ipcRenderer.invoke('sessions:rename', id, title),
    setWorkspace: (id: string, workspace: string | null) =>
      ipcRenderer.invoke('sessions:setWorkspace', id, workspace),
    setModel: (id: string, modelId: string | null) =>
      ipcRenderer.invoke('sessions:setModel', id, modelId),
    setModelOverride: (id: string, model: string | null) =>
      ipcRenderer.invoke('sessions:setModelOverride', id, model),
    setMode: (id: string, mode: 'plan' | 'build' | null) =>
      ipcRenderer.invoke('sessions:setMode', id, mode),
    approvePlan: (id: string) => ipcRenderer.invoke('sessions:approvePlan', id),
    fork: (id: string, messageId?: string | null) =>
      ipcRenderer.invoke('sessions:fork', id, messageId ?? null),
    search: (query: string) => ipcRenderer.invoke('sessions:search', query),
    export: (id: string) => ipcRenderer.invoke('sessions:export', id),
    trash: () => ipcRenderer.invoke('sessions:trash'),
    restore: (file: string) => ipcRenderer.invoke('sessions:restore', file),
    purgeTrash: (file: string) => ipcRenderer.invoke('sessions:purgeTrash', file),
    purgeAllTrash: () => ipcRenderer.invoke('sessions:purgeAllTrash'),
  },
  chat: {
    send: (sessionId: string, text: string, files?: SendAttachment[]) =>
      ipcRenderer.invoke('chat:send', sessionId, text, files),
    abort: (sessionId: string) => ipcRenderer.invoke('chat:abort', sessionId),
    /** 这个会话此刻是否在跑：切会话回来时用它恢复状态，别把后台正在跑的显示成空闲 */
    isRunning: (sessionId: string) => ipcRenderer.invoke('chat:isRunning', sessionId),
    steer: (sessionId: string, text: string) => ipcRenderer.invoke('chat:steer', sessionId, text),
    regenerate: (sessionId: string) => ipcRenderer.invoke('chat:regenerate', sessionId),
    editAndResend: (sessionId: string, messageId: string, text: string) =>
      ipcRenderer.invoke('chat:editAndResend', sessionId, messageId, text),
    resume: (sessionId: string) => ipcRenderer.invoke('chat:resume', sessionId)
  },
  changes: {
    list: (sessionId: string) => ipcRenderer.invoke('changes:list', sessionId),
    detail: (sessionId: string, id: string) => ipcRenderer.invoke('changes:detail', sessionId, id),
    revert: (sessionId: string, id: string) => ipcRenderer.invoke('changes:revert', sessionId, id),
    applyHunks: (sessionId: string, id: string, keep: number[]) =>
      ipcRenderer.invoke('changes:applyHunks', sessionId, id, keep),
    revertAll: (sessionId: string) => ipcRenderer.invoke('changes:revertAll', sessionId)
  },
  git: {
    status: (workspace: string | null) => ipcRenderer.invoke('git:status', workspace),
    diff: (workspace: string | null, file: string) => ipcRenderer.invoke('git:diff', workspace, file),
    commit: (workspace: string | null, message: string, paths?: string[]) =>
      ipcRenderer.invoke('git:commit', workspace, message, paths)
  },
  terminal: {
    open: (workspace: string, shell?: 'cmd' | 'powershell' | 'bash') =>
      ipcRenderer.invoke('terminal:open', workspace, shell),
    write: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
    read: (id: string, since?: number, opts?: { tail?: number; waitMs?: number }) =>
      ipcRenderer.invoke('terminal:read', id, since, opts),
    close: (id: string) => ipcRenderer.invoke('terminal:close', id),
    list: () => ipcRenderer.invoke('terminal:list')
  },
  mcp: {
    status: () => ipcRenderer.invoke('mcp:status'),
    reload: () => ipcRenderer.invoke('mcp:reload'),
    openConfig: () => ipcRenderer.invoke('mcp:openConfig')
  },
  free: {
    list: (opts?: { refresh?: boolean }) => ipcRenderer.invoke('free:list', opts)
  },
  approval: {
    respond: (id: string, approved: boolean, always?: boolean, persist?: boolean) =>
      ipcRenderer.send('approval:respond', id, approved, always, persist)
  },
  approvals: {
    list: () => ipcRenderer.invoke('approvals:list'),
    revoke: (workspace: string, tool: string) => ipcRenderer.invoke('approvals:revoke', workspace, tool),
    clear: () => ipcRenderer.invoke('approvals:clear')
  },
  question: {
    respond: (id: string, answer: string) => ipcRenderer.send('question:respond', id, answer)
  },
  checkpoints: {
    interrupted: () => ipcRenderer.invoke('checkpoints:interrupted'),
    dismiss: (sessionId: string) => ipcRenderer.invoke('checkpoints:dismiss', sessionId)
  },
  models: {
    list: (providerId: string) => ipcRenderer.invoke('models:list', providerId),
    probe: (providerId: string) => ipcRenderer.invoke('models:probe', providerId),
    listDraft: (provider: ProviderConfig) => ipcRenderer.invoke('models:listDraft', provider),
    probeDraft: (provider: ProviderConfig) => ipcRenderer.invoke('models:probeDraft', provider),
    catalog: (opts?: { query?: string; refresh?: boolean; runId?: string; localOnly?: boolean }) =>
      ipcRenderer.invoke('models:catalog', opts),
    // 流式目录：主进程解析出一条就发一条，界面按 runId 渐进渲染
    onCatalogItem: (cb: (item: CatalogStreamItem) => void) => {
      const listener = (_e: unknown, item: CatalogStreamItem) => cb(item)
      ipcRenderer.on('models:catalog:item', listener)
      return () => {
        ipcRenderer.removeListener('models:catalog:item', listener)
      }
    },
    download: (id: string) => ipcRenderer.invoke('models:download', id),
    cancel: (id: string) => ipcRenderer.send('models:cancel', id),
    remove: (id: string) => ipcRenderer.invoke('models:remove', id),
    onProgress: (cb: (p: DownloadProgress) => void) => {
      const listener = (_e: unknown, p: DownloadProgress) => cb(p)
      ipcRenderer.on('models:progress', listener)
      return () => {
        ipcRenderer.removeListener('models:progress', listener)
      }
    }
  },
  // 下载都在主进程跑：面板挂载时先问一次快照，切页面回来进度条还在
  downloads: {
    snapshot: () => ipcRenderer.invoke('downloads:snapshot')
  },
  shell: {
    showItemInFolder: (target: string) => ipcRenderer.send('shell:showItem', target),
    openPath: (target: string) => ipcRenderer.invoke('shell:openPath', target)
  },
  commands: {
    list: (workspace: string | null) => ipcRenderer.invoke('commands:list', workspace),
    expand: (text: string, workspace: string | null) =>
      ipcRenderer.invoke('commands:expand', text, workspace)
  },
  hooks: {
    describe: (workspace: string | null) => ipcRenderer.invoke('hooks:describe', workspace),
    reload: () => ipcRenderer.invoke('hooks:reload')
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    save: (input: { id?: string; name: string; desc?: string; prompt: string }) =>
      ipcRenderer.invoke('skills:save', input),
    remove: (id: string) => ipcRenderer.invoke('skills:remove', id),
    toggle: (id: string, enabled: boolean) => ipcRenderer.invoke('skills:toggle', id, enabled),
    distill: (sessionId: string) => ipcRenderer.invoke('skills:distill', sessionId),
    sources: () => ipcRenderer.invoke('skills:sources'),
    scan: (input: { repo?: string; sourceId?: string }) => ipcRenderer.invoke('skills:scan', input),
    install: (items: RemoteSkill[]) => ipcRenderer.invoke('skills:install', items),
    checkDeps: () => ipcRenderer.invoke('skills:checkDeps')
  },
  files: {
    pick: () => ipcRenderer.invoke('files:pick'),
    attach: (paths: string[]) => ipcRenderer.invoke('files:attach', paths),
    thumb: (absPath: string) => ipcRenderer.invoke('files:thumb', absPath),
    // 正文里引用的本地图片：主进程读盘 → data URL（扩展名与大小都在主进程校验）
    image: (src: string) => ipcRenderer.invoke('files:image', src),
    list: (query?: string) => ipcRenderer.invoke('files:list', query),
    captureScreen: () => ipcRenderer.invoke('screen:capture'),
    // 浏览器只给 File 对象，真实路径要在 preload 里问 Electron 要
    pathOf: (file: File) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    }
  },
  llama: {
    install: () => ipcRenderer.invoke('llama:install'),
    cancelInstall: () => ipcRenderer.invoke('llama:cancelInstall'),
    configure: () => ipcRenderer.invoke('llama:configure'),
    models: () => ipcRenderer.invoke('llama:models'),
    deleteModel: (rel: string) => ipcRenderer.invoke('llama:deleteModel', rel),
    start: (
      model?: string,
      ctx?: number,
      opts?: { providerId?: string; device?: string | null; port?: number; activate?: boolean; ctxExplicit?: boolean }
    ) => ipcRenderer.invoke('llama:start', model, ctx, opts),
    status: (providerId?: string) => ipcRenderer.invoke('llama:status', providerId),
    stop: (providerId?: string) => ipcRenderer.invoke('llama:stop', providerId),
    instances: () => ipcRenderer.invoke('llama:instances'),
    devices: () => ipcRenderer.invoke('llama:devices'),
    probeSlots: (providerId?: string) => ipcRenderer.invoke('llama:probeSlots', providerId),
    backend: () => ipcRenderer.invoke('llama:backend'),
    checkUpdate: () => ipcRenderer.invoke('llama:checkUpdate'),
    onSetupProgress: (cb: (p: SetupProgress) => void) => {
      const listener = (_e: unknown, p: SetupProgress) => cb(p)
      ipcRenderer.on('local:setupProgress', listener)
      return () => {
        ipcRenderer.removeListener('local:setupProgress', listener)
      }
    },
    onProbe: (cb: (p: LlamaProbeProgress) => void) => {
      const listener = (_e: unknown, p: LlamaProbeProgress) => cb(p)
      ipcRenderer.on('llama:probe', listener)
      return () => {
        ipcRenderer.removeListener('llama:probe', listener)
      }
    }
  },
  core: {
    setup: () => ipcRenderer.invoke('core:setup'),
    cancel: () => ipcRenderer.invoke('core:cancel'),
    onProgress: (cb: (p: CoreProgress) => void) => {
      const listener = (_e: unknown, p: CoreProgress) => cb(p)
      ipcRenderer.on('core:progress', listener)
      return () => {
        ipcRenderer.removeListener('core:progress', listener)
      }
    }
  },
  system: {
    specs: () => ipcRenderer.invoke('system:specs')
  },
  vramfit: {
    available: () => ipcRenderer.invoke('vramfit:available'),
    check: (file: string, gpuIndex?: number) => ipcRenderer.invoke('vramfit:check', file, gpuIndex)
  },
  worker: {
    plan: (providerId?: string) => ipcRenderer.invoke('worker:plan', providerId),
    warm: (providerId?: string) => ipcRenderer.invoke('worker:warm', providerId)
  },
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
    close: () => ipcRenderer.send('win:close'),
    onMaximize: (cb: (maximized: boolean) => void) => {
      const listener = (_e: unknown, max: boolean) => cb(Boolean(max))
      ipcRenderer.on('win:maximized', listener)
      return () => {
        ipcRenderer.removeListener('win:maximized', listener)
      }
    }
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    prefs: () => ipcRenderer.invoke('app:prefs'),
    setZoom: (factor: number) => ipcRenderer.invoke('app:setZoom', factor),
    setPrefs: (patch: Partial<AppPrefs>) => ipcRenderer.invoke('app:setPrefs', patch),
    openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
    openLogs: () => ipcRenderer.invoke('app:openLogs'),
    setLang: (lang) => ipcRenderer.invoke('app:setLang', lang)
  },
  tools: {
    check: () => ipcRenderer.invoke('tools:check'),
    install: (ids: BaseToolId[]) => ipcRenderer.invoke('tools:install', ids),
    onProgress: (cb: (p: ToolSetupProgress) => void) => {
      const listener = (_e: unknown, p: ToolSetupProgress) => cb(p)
      ipcRenderer.on('tools:progress', listener)
      return () => {
        ipcRenderer.removeListener('tools:progress', listener)
      }
    }
  },
  local: {
    status: (kind: LocalRuntimeKind) => ipcRenderer.invoke('local:status', kind),
    start: (kind: LocalRuntimeKind) => ipcRenderer.invoke('local:start', kind),
    configure: (kind: LocalRuntimeKind, model?: string, opts?: { activate?: boolean }) =>
      ipcRenderer.invoke('local:configure', kind, model, opts),
    pull: (name: string) => ipcRenderer.invoke('local:pull', name),
    /** 切换模型后释放其他本地运行时的显存；providerId 为空表示全部释放 */
    release: (providerId: string | null) =>
      ipcRenderer.invoke('local:release', providerId) as Promise<{ ok: boolean; freed: string[] }>,
    /** 切换模型后，主进程后台卸载其它运行时的通知（延迟复查那一轮） */
    onFreed: (cb: (freed: string[]) => void) => {
      const listener = (_e: unknown, p: { freed: string[] }) => cb(p?.freed ?? [])
      ipcRenderer.on('local:freed', listener)
      return () => {
        ipcRenderer.removeListener('local:freed', listener)
      }
    },
    /** 本地服务此刻用着哪张显卡：已加载的模型 + 显存占用（Ollama 走 /api/ps + 服务日志） */
    gpu: () => ipcRenderer.invoke('local:gpu') as Promise<LocalGpuSnapshot>,
    ggufs: () => ipcRenderer.invoke('local:ggufs'),
    importModel: (kind: LocalRuntimeKind, file: string, label?: string) =>
      ipcRenderer.invoke('local:import', kind, file, label),
    install: (kind: LocalRuntimeKind) => ipcRenderer.invoke('local:install', kind),
    cancelInstall: () => ipcRenderer.invoke('local:cancelInstall'),
    onSetupProgress: (cb: (p: SetupProgress) => void) => {
      const listener = (_e: unknown, p: SetupProgress) => cb(p)
      ipcRenderer.on('local:setupProgress', listener)
      return () => {
        ipcRenderer.removeListener('local:setupProgress', listener)
      }
    }
  },
  memory: {
    info: () => ipcRenderer.invoke('memory:info'),
    clear: () => ipcRenderer.invoke('memory:clear')
  },
  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
    tools: () => ipcRenderer.invoke('agents:tools'),
    save: (agent) => ipcRenderer.invoke('agents:save', agent),
    remove: (id) => ipcRenderer.invoke('agents:remove', id),
    running: () => ipcRenderer.invoke('agents:running')
  },
  routines: {
    list: () => ipcRenderer.invoke('routines:list'),
    save: (routine) => ipcRenderer.invoke('routines:save', routine),
    remove: (id) => ipcRenderer.invoke('routines:remove', id),
    enable: (id, enabled) => ipcRenderer.invoke('routines:enable', id, enabled),
    run: (id) => ipcRenderer.invoke('routines:run', id)
  },
  handoffs: {
    list: () => ipcRenderer.invoke('handoffs:list'),
    cancel: (id) => ipcRenderer.invoke('handoffs:cancel', id),
    run: (id) => ipcRenderer.invoke('handoffs:run', id)
  },
  board: {
    get: () => ipcRenderer.invoke('board:get'),
    clear: () => ipcRenderer.invoke('board:clear')
  },
  quota: {
    today: () => ipcRenderer.invoke('quota:today')
  },
  onChange: (channel, cb) => {
    // 白名单而不是拼字符串：注释写「只放行这两个频道」时，代码得真的只放行这两个
    const ALLOWED = new Set(['routines', 'handoffs'])
    if (!ALLOWED.has(channel)) throw new Error(`不允许监听频道：${channel}`)
    const name = `${channel}:changed`
    const handler = (): void => cb()
    ipcRenderer.on(name, handler)
    return () => {
      ipcRenderer.removeListener(name, handler)
    }
  },
  instructions: {
    info: () => ipcRenderer.invoke('instructions:info'),
    init: () => ipcRenderer.invoke('instructions:init')
  },
  permissions: {
    info: () => ipcRenderer.invoke('permissions:info'),
    save: (rules: PermissionRule[]) => ipcRenderer.invoke('permissions:save', rules)
  },
  onEvent: (cb: (payload: AgentEventEnvelope) => void) => {
    const listener = (_e: unknown, payload: AgentEventEnvelope) => cb(payload)
    ipcRenderer.on('agent:event', listener)
    return () => {
      ipcRenderer.removeListener('agent:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('pico', api)
