const test = require('node:test')
const assert = require('node:assert/strict')
const { fallbackCandidates } = require('../dist/shared/providers.js')

/**
 * 主模型失败时的备用链。
 *
 * 修的是一个「配置上配了、实际上用不到」的缺口：手上握着两三个 key，
 * 主模型 429 之后却直接掉到本地核心小模型，因为这条链以前无条件跳过
 * role='worker' —— 而设置页又把「备用」勾去掉了，远端根本没有别的入口。
 *
 * 现在的规则：
 * - 显式 fallback:true 的一律进链（包括子智能体），排最前；
 * - 本地供应商自动进链（本机兜底不额外花钱）；
 * - 远端非 worker、没勾 fallback 的**不**自动进链（一次 5xx 悄悄产生账单更难查）；
 * - 子智能体没勾 fallback 就不进链，白天干活 / 半夜顶班是两件事。
 */

const remote = (id, over = {}) => ({
  id,
  name: id,
  kind: 'openai',
  baseUrl: 'https://api.example.com/v1',
  model: 'm',
  contextWindow: 32768,
  ...over
})
const local = (id, over = {}) => ({
  id,
  name: id,
  kind: 'llama',
  runtime: 'llama',
  baseUrl: 'http://127.0.0.1:8080',
  model: 'qwen',
  contextWindow: 8192,
  ...over
})

const ids = (list) => list.map((p) => p.id)

test('备用链：远端没勾 fallback 的不自动进链（避免悄悄产生账单）', () => {
  const list = [remote('main'), remote('other')]
  assert.deepEqual(ids(fallbackCandidates(list, 'main')), [])
})

test('备用链：子智能体勾了 fallback 就能当备胎（多 key 容灾）', () => {
  const list = [remote('main'), remote('sub', { role: 'worker', fallback: true }), local('loc')]
  const chain = ids(fallbackCandidates(list, 'main'))
  assert.equal(chain[0], 'sub', '显式勾选的排在本地之前')
  assert.ok(chain.includes('loc'))
})

test('备用链：子智能体没勾 fallback 就不进链（干活和顶班是两件事）', () => {
  const list = [remote('main'), remote('sub', { role: 'worker' })]
  assert.deepEqual(ids(fallbackCandidates(list, 'main')), [])
})

test('备用链：本地供应商自动进链，显式勾选的排在前面', () => {
  const list = [remote('main'), local('a'), local('b'), remote('api', { fallback: true })]
  assert.deepEqual(ids(fallbackCandidates(list, 'main')), ['api', 'a', 'b'])
})

test('备用链：主模型自己、没选模型的、fallback:false 的都不进链', () => {
  const list = [
    remote('main', { fallback: true }),
    remote('empty', { model: '' }),
    local('off', { fallback: false }),
    local('ok')
  ]
  assert.deepEqual(ids(fallbackCandidates(list, 'main')), ['ok'])
})

test('备用链：worker + fallback:false 是显式排除（优先级高于角色）', () => {
  const list = [remote('main'), remote('sub', { role: 'worker', fallback: false })]
  assert.deepEqual(ids(fallbackCandidates(list, 'main')), [])
})
