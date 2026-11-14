const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { scanOllamaDisk } = require('../dist/main/ollamadir.js')

/* ── 本机 Ollama 的离线扫描 ───────────────────────────────── */

function gguf(padding) {
  return Buffer.concat([Buffer.from('GGUF', 'latin1'), Buffer.alloc(padding, 7)])
}

function withRoot(t, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roro-ollama-'))
  const prev = process.env.OLLAMA_MODELS
  process.env.OLLAMA_MODELS = root
  fs.mkdirSync(path.join(root, 'blobs'), { recursive: true })
  t.after(() => {
    if (prev === undefined) delete process.env.OLLAMA_MODELS
    else process.env.OLLAMA_MODELS = prev
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, fn }
}

function manifest(root, dir, rel, digest) {
  const file = path.join(root, dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 2,
      layers: [
        { mediaType: 'application/vnd.ollama.image.model', digest, size: 1024 },
        { mediaType: 'application/vnd.ollama.image.template', digest: 'sha256:tpl', size: 64 }
      ]
    })
  )
  return file
}

test('新布局 manifests-v2：模型能被扫到，名字要剥掉 ollama.com/library', (t) => {
  const { root } = withRoot(t)
  fs.writeFileSync(path.join(root, 'blobs', 'sha256-aa11'), gguf(256))
  manifest(root, 'manifests-v2', 'ollama.com/library/qwen3/14b', 'sha256:aa11')
  return scanOllamaDisk().then((r) => {
    assert.equal(r.ok, true)
    assert.equal(r.models.length, 1)
    assert.equal(r.models[0].name, 'qwen3:14b')
    assert.equal(r.models[0].sizeBytes, 260)
    assert.equal(r.models[0].gguf, true)
  })
})

test('只有 manifests-v2 的机器不能报「没有模型目录」', (t) => {
  const { root } = withRoot(t)
  fs.writeFileSync(path.join(root, 'blobs', 'sha256-bb22'), gguf(128))
  manifest(root, 'manifests-v2', 'ollama.com/library/llama3.2/3b', 'sha256:bb22')
  return scanOllamaDisk().then((r) => {
    assert.notEqual(r.dir, null)
    assert.deepEqual(
      r.models.map((m) => m.name),
      ['llama3.2:3b']
    )
  })
})

test('新老目录各有一份同名清单：只算一个模型，不重复', (t) => {
  const { root } = withRoot(t)
  fs.writeFileSync(path.join(root, 'blobs', 'sha256-cc33'), gguf(64))
  manifest(root, 'manifests', 'registry.ollama.ai/library/mistral/7b', 'sha256:cc33')
  manifest(root, 'manifests-v2', 'ollama.com/library/mistral/7b', 'sha256:cc33')
  return scanOllamaDisk().then((r) => {
    assert.equal(r.models.filter((m) => m.name === 'mistral:7b').length, 1)
  })
})

test('老目录里清单坏了、新目录是好的：仍然能扫到', (t) => {
  const { root } = withRoot(t)
  fs.writeFileSync(path.join(root, 'blobs', 'sha256-dd44'), gguf(64))
  const bad = path.join(root, 'manifests', 'registry.ollama.ai', 'library', 'gemma3', '4b')
  fs.mkdirSync(path.dirname(bad), { recursive: true })
  fs.writeFileSync(bad, '{ broken')
  manifest(root, 'manifests-v2', 'ollama.com/library/gemma3/4b', 'sha256:dd44')
  return scanOllamaDisk().then((r) => {
    assert.deepEqual(
      r.models.map((m) => m.name),
      ['gemma3:4b']
    )
  })
})

test('两个目录都没有 → dir 为 null，但 ok 仍是 true', (t) => {
  const { root } = withRoot(t)
  fs.rmSync(path.join(root, 'blobs'), { recursive: true, force: true })
  const prev = process.env.OLLAMA_MODELS
  process.env.OLLAMA_MODELS = path.join(root, 'nothing-here')
  t.after(() => {
    process.env.OLLAMA_MODELS = prev
  })
  return scanOllamaDisk().then((r) => {
    assert.equal(r.ok, true)
    assert.equal(r.dir, null)
    assert.deepEqual(r.models, [])
  })
})
