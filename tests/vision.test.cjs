const test = require('node:test')
const assert = require('node:assert')
const { modelLooksVision, providerSupportsVision, isImagePath } = require('../dist/shared/vision.js')

test('nemotron-3.5-bolt 系列被识别为视觉模型', () => {
  assert.equal(modelLooksVision('nvidia/nemotron-3.5-bolt-e4b'), true)
  assert.equal(modelLooksVision('nemotron-3.5-bolt-e4b'), true)
  assert.equal(modelLooksVision('nemotron-3.5-lightning-30b-a3b'), true)
})

test('纯文本 coder 模型仍不被误判为视觉模型', () => {
  assert.equal(modelLooksVision('qwen2.5-coder-7b'), false)
  assert.equal(modelLooksVision('llama-3.1-8b'), false)
})

test('providerSupportsVision：vision:on 强制覆盖名字判断', () => {
  assert.equal(
    providerSupportsVision({ id: 'x', name: 'x', kind: 'openai', baseUrl: '', apiKey: '', model: 'foo-bar', contextWindow: 8192, temperature: 0.2, vision: 'on' }),
    true
  )
  assert.equal(
    providerSupportsVision({ id: 'x', name: 'x', kind: 'openai', baseUrl: '', apiKey: '', model: 'foo-bar', contextWindow: 8192, temperature: 0.2, vision: 'off' }),
    false
  )
})

test('providerSupportsVision：无开关时按模型名判断', () => {
  assert.equal(
    providerSupportsVision({ id: 'x', name: 'x', kind: 'openai', baseUrl: '', apiKey: '', model: 'nvidia/nemotron-3.5-bolt-e4b', contextWindow: 8192, temperature: 0.2 }),
    true
  )
})

test('isImagePath 识别常见图片扩展名', () => {
  assert.equal(isImagePath('/a/b/shot.png'), true)
  assert.equal(isImagePath('C:\\a\\b.jpg'), true)
  assert.equal(isImagePath('index.html'), false)
  assert.equal(isImagePath('main.ts'), false)
})
