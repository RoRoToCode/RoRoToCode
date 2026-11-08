import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AgentEventEnvelope,
  AppConfig,
  AppPrefs,
  BaseToolId,
  CoreProgress,
  DownloadProgress,
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
    choose: () => ipcRenderer.invoke('workspace:choose')
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: (workspace?: string | null) => ipcRenderer.invoke('sessions:create', workspace),
    load: (id: string) => ipcRenderer.invoke('sessions:load', id),
    remove: (id: string) => ipcRenderer.invoke('sessions:remove', id),
    deleteTurn: (id: string, messageId: string) =>
      ipcRenderer.invoke('sessions:deleteTurn', id, messageId),
    rename: (id: string, title: string) => ipcRenderer.invoke('sessions:rename', id, title),
    setWorkspace: (id: string, workspace: string | null) =>
      ipcRenderer.invoke('sessions:setWorkspace', id, workspace),
    setModel: (id: string, modelId: string | null) =>
      ipcRenderer.invoke('sessions:setModel', id, modelId),
    search: (query: string) => ipcRenderer.invoke('sessions:search', query),
    export: (id: string) => ipcRenderer.invoke('sessions:export', id),
    trash: () => ipcRenderer.invoke('sessions:trash'),
    restore: (file: string) => ipcRenderer.invoke('sessions:restore', file),
    purgeTrash: (file: string) => ipcRenderer.invoke('sessions:purgeTrash', file)
  },
  chat: {
    send: (sessionId: string, text: string, files?: SendAttachment[]) =>
      ipcRenderer.invoke('chat:send', sessionId, text, files),
    abort: (sessionId: string) => ipcRenderer.invoke('chat:abort', sessionId),
    regenerate: (sessionId: string) => ipcRenderer.invoke('chat:regenerate', sessionId),
    editAndResend: (sessionId: string, messageId: string, text: string) =>
      ipcRenderer.invoke('chat:editAndResend', sessionId, messageId, text),
    resume: (sessionId: string) => ipcRenderer.invoke('chat:resume', sessionId)
  },
  changes: {
    list: (sessionId: string) => ipcRenderer.invoke('changes:list', sessionId),
    detail: (sessionId: string, id: string) => ipcRenderer.invoke('changes:detail', sessionId, id),
    revert: (sessionId: string, id: string) => ipcRenderer.invoke('changes:revert', sessionId, id),
    revertAll: (sessionId: string) => ipcRenderer.invoke('changes:revertAll', sessionId)
  },
  git: {
    status: (workspace: string | null) => ipcRenderer.invoke('git:status', workspace),
    diff: (workspace: string | null, file: string) => ipcRenderer.invoke('git:diff', workspace, file),
    commit: (workspace: string | null, message: string, paths?: string[]) =>
      ipcRenderer.invoke('git:commit', workspace, message, paths)
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
    respond: (id: string, approved: boolean, always?: boolean) =>
      ipcRenderer.send('approval:respond', id, approved, always)
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
    catalog: (opts?: { query?: string; refresh?: boolean }) => ipcRenderer.invoke('models:catalog', opts),
    download: (id: string) => ipcRenderer.invoke('models:download', id),
    cancel: (id: string) => ipcRenderer.send('models:cancel', id),
    onProgress: (cb: (p: DownloadProgress) => void) => {
      const listener = (_e: unknown, p: DownloadProgress) => cb(p)
      ipcRenderer.on('models:progress', listener)
      return () => {
        ipcRenderer.removeListener('models:progress', listener)
      }
    }
  },
  shell: {
    showItemInFolder: (target: string) => ipcRenderer.send('shell:showItem', target),
    openPath: (target: string) => ipcRenderer.invoke('shell:openPath', target)
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    save: (input: { id?: string; name: string; desc?: string; prompt: string }) =>
      ipcRenderer.invoke('skills:save', input),
    remove: (id: string) => ipcRenderer.invoke('skills:remove', id),
    sources: () => ipcRenderer.invoke('skills:sources'),
    scan: (input: { repo?: string; sourceId?: string }) => ipcRenderer.invoke('skills:scan', input),
    install: (items: RemoteSkill[]) => ipcRenderer.invoke('skills:install', items)
  },
  files: {
    pick: () => ipcRenderer.invoke('files:pick'),
    attach: (paths: string[]) => ipcRenderer.invoke('files:attach', paths),
    thumb: (absPath: string) => ipcRenderer.invoke('files:thumb', absPath),
    list: (query?: string) => ipcRenderer.invoke('files:list', query),
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
    start: (model?: string, ctx?: number, opts?: { providerId?: string; device?: string | null; port?: number }) =>
      ipcRenderer.invoke('llama:start', model, ctx, opts),
    status: (providerId?: string) => ipcRenderer.invoke('llama:status', providerId),
    stop: (providerId?: string) => ipcRenderer.invoke('llama:stop', providerId),
    instances: () => ipcRenderer.invoke('llama:instances'),
    devices: () => ipcRenderer.invoke('llama:devices'),
    backend: () => ipcRenderer.invoke('llama:backend'),
    onSetupProgress: (cb: (p: SetupProgress) => void) => {
      const listener = (_e: unknown, p: SetupProgress) => cb(p)
      ipcRenderer.on('local:setupProgress', listener)
      return () => {
        ipcRenderer.removeListener('local:setupProgress', listener)
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
    configure: (kind: LocalRuntimeKind, model?: string) => ipcRenderer.invoke('local:configure', kind, model),
    pull: (name: string) => ipcRenderer.invoke('local:pull', name),
    /** 切换模型后释放其他本地运行时的显存；providerId 为空表示全部释放 */
    release: (providerId: string | null) =>
      ipcRenderer.invoke('local:release', providerId) as Promise<{ ok: boolean; freed: string[] }>,
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
