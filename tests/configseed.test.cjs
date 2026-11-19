/**
 * 配置读取时的「回填」行为。
 *
 * 这里锁的是一条被用户反复踩到的规则：**删掉的条目不能再自己回来**。
 * 老实现里有一条「列表里没有 llama.cpp 本地就补一条」的升级逻辑，
 * 判据在用户主动删除后同样成立，于是每次启动都补回来。
 *
 * 用 Module._load 打桩 electron：config.ts 只用到 app.getPath / isPackaged / getAppPath，
 * 以及 secrets 里的 safeStorage（桩里关掉加密，落盘就是明文，便于断言）。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roroto-cfg-'))
  const app = {
    getPath: () => dir,
    isPackaged: false,
    getAppPath: () => dir
  }
  const orig = Module._load
  Module._load = function (req, parent, isMain) {
    if (req === 'electron') {
      return {
        app,
        safeStorage: {
          isEncryptionAvailable: () => false,
          encryptString: (s) => Buffer.from(s),
          decryptString: (b) => b.toString()
        }
      }
    }
    return orig.call(this, req, parent, isMain)
  }
  const file = path.join(dir, 'config.json')
  const mod = require.resolve('../dist/main/config.js')
  delete require.cache[mod]
  return {
    dir,
    file,
    /** 重新 require 一份，模拟「重启应用」 */
    fresh() {
      delete require.cache[mod]
      return require('../dist/main/config.js')
    },
    read() {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    },
    write(cfg) {
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8')
    },
    done() {
      Module._load = orig
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

const llamaGroup = [
  {
    id: 'llamacpp-a',
    name: 'llama.cpp · CUDA0',
    kind: 'openai',
    runtime: 'llama',
    device: 'CUDA0',
    baseUrl: 'http://127.0.0.1:8080/v1',
    apiKey: 'no-key',
    model: 'm.gguf',
    contextWindow: 16384,
    temperature: 0.2
  },
  {
    id: 'llamacpp-b',
    name: 'llama.cpp · CUDA1',
    kind: 'openai',
    runtime: 'llama',
    device: 'CUDA1',
    baseUrl: 'http://127.0.0.1:8081/v1',
    apiKey: 'no-key',
    model: 'm.gguf',
    contextWindow: 16384,
    temperature: 0.2
  }
]

test('删掉的 llama.cpp 本地不会被补回来', async () => {
  const box = sandbox()
  try {
    box.write({
      providers: llamaGroup,
      activeId: 'llamacpp-a',
      workspace: null,
      approvalMode: 'ask',
      maxSteps: 30,
      contextLimit: false,
      contextWindow: 32768,
      autoCompact: true,
      autoVerify: true,
      diagnoseOnWrite: true,
      webSearch: true,
      memory: true,
      proxyUrl: '',
      mcpEnabled: true
    })
    const cfg = await box.fresh().loadConfig()
    assert.equal(
      cfg.providers.some((p) => p.id === 'llamacpp'),
      false,
      '配置里没有 llama.cpp 本地时不能再自动建一条'
    )
    assert.equal(cfg.providers.length, 2)
    // 落盘结果同样不该多出一条
    assert.equal(box.read().providers.some((p) => p.id === 'llamacpp'), false)
  } finally {
    box.done()
  }
})

test('列表被删空就留空，不再拿默认条目顶上', async () => {
  const box = sandbox()
  try {
    box.write({ providers: [], activeId: null })
    const cfg = await box.fresh().loadConfig()
    assert.deepEqual(cfg.providers, [])
    assert.equal(box.read().providers.length, 0)
  } finally {
    box.done()
  }
})

test('配置里根本没有 providers 字段时给一份默认条目（首次启动）', async () => {
  const box = sandbox()
  try {
    box.write({ activeId: null })
    const cfg = await box.fresh().loadConfig()
    assert.ok(cfg.providers.length > 0)
    assert.equal(cfg.activeId, cfg.providers[0].id)
  } finally {
    box.done()
  }
})

test('activeId 指向已删除的条目时挪到第一条', async () => {
  const box = sandbox()
  try {
    box.write({ providers: [llamaGroup[0]], activeId: 'llamacpp-b' })
    const cfg = await box.fresh().loadConfig()
    assert.equal(cfg.activeId, 'llamacpp-a')
  } finally {
    box.done()
  }
})
