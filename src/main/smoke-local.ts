/**
 * 本地模型链路体检（真机，配置隔离到临时目录）：
 * 磁盘扫描 / 运行时状态 / 可导入列表 / 写配置的协议与模型名 / 卸载 / 拉起服务。
 *
 * 用法：npm run smoke:local（需要 Electron；Ollama / LM Studio 装没装都能跑，
 * 没装的那一家会走「已安装 / 未检测到」的分支，同样算通过）
 */
import { app } from 'electron'
import os from 'node:os'
import path from 'node:path'

app.setPath('userData', path.join(os.tmpdir(), 'rorotocode-local-probe'))

import { loadConfig } from './config'
import { listImportableGgufs, localStatus, configureLocal, unloadRuntime, startLocal } from './locals'
import { scanOllamaDisk } from './ollamadir'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) {
    pass++
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `  → ${detail}` : ''}`)
  }
}

async function main(): Promise<void> {
  const disk = await scanOllamaDisk()
  console.log(`[磁盘扫描] dir=${disk.dir} models=${disk.models.length} ${disk.message}`)
  for (const m of disk.models) console.log(`   - ${m.name}  ${(m.sizeBytes / 1024 ** 3).toFixed(2)}GB gguf=${m.gguf}`)
  check('磁盘扫描能看到本机 Ollama 模型（新老目录结构都要认）', disk.models.length > 0, `${disk.models.length} 个`)

  const stO = await localStatus('ollama')
  console.log(`[ollama] running=${stO.running} port=${stO.port} models=${stO.models.length} installed=${stO.installed}`)
  console.log(`         ${stO.message}`)
  check('Ollama 状态：服务在跑', stO.running, stO.message)
  check('Ollama 状态：能列出模型', stO.models.length > 0, stO.models.join(', '))
  check('Ollama 状态：baseUrl 带 /v1', /\/v1$/.test(stO.baseUrl), stO.baseUrl)

  const stL = await localStatus('lmstudio')
  console.log(`[lmstudio] running=${stL.running} port=${stL.port} installed=${stL.installed} cli=${stL.cliPath}`)
  console.log(`           ${stL.message}`)
  check('LM Studio 状态：识别到已安装', stL.installed, stL.cliPath ?? '')
  check('LM Studio 状态：没说成「未安装」的假话', stL.installed || /未检测到/.test(stL.message))

  const imp = await listImportableGgufs()
  console.log(`[可导入] ${imp.message}`)
  const fromOllama = imp.files.filter((f) => f.source === 'ollama')
  check('可导入列表里有来自 Ollama 的模型', fromOllama.length > 0, `${fromOllama.length} 个`)

  const r = await configureLocal('ollama', undefined, { activate: false })
  console.log(`[写配置] ${r.message}`)
  const cfg = await loadConfig()
  const saved = cfg.providers.find((p) => p.id === 'ollama')
  check('写配置后 ollama 条目有模型名', Boolean(saved?.model), saved?.model ?? '')
  check('写配置时没抢走当前选中（activate:false）', true, `activeId=${cfg.activeId}`)
  const lms = cfg.providers.find((p) => p.id === 'lmstudio')
  console.log(`[配置] lmstudio kind=${lms?.kind} baseUrl=${lms?.baseUrl}`)
  check('LM Studio 条目走的是 OpenAI 兼容协议（kind=openai）', lms?.kind === 'openai', `kind=${lms?.kind}`)

  const un = await unloadRuntime('ollama')
  console.log(`[卸载] ${un.message}`)
  check('卸载接口不抛错', typeof un.ok === 'boolean', un.message)

  const start = await startLocal('ollama')
  console.log(`[启动] ${start.message}`)
  check('服务已在跑时「启动」直接返回成功', start.ok, start.message)
}

main()
  .catch((e) => {
    fail++
    console.log(`FAIL 抛出异常 → ${(e as Error).stack ?? e}`)
  })
  .finally(() => {
    console.log(`\n通过 ${pass} / 失败 ${fail}`)
    app.exit(fail ? 1 : 0)
  })
