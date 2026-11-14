/**
 * 真机冒烟：空闲卸载与按需唤醒。
 *
 * 这两件事只有在真进程上才能验证：
 *   1. 「停掉」之后显存真的回来了吗（进程没了 ≠ 显存释放，句柄/子进程都可能残留）；
 *   2. `wakeLlama` 重新拉起后，窗口档位还是不是原来那个（不能叫醒一次就退回默认 16K）；
 *   3. 服务已经在跑时再去「叫醒」，必须什么都不做 —— 否则每个请求都会重启一次模型。
 *
 * 用法（本机 ELECTRON_RUN_AS_NODE=1 必须 unset，否则 app 是假的）：
 *   ROROTO_SMOKE_MODEL=xxx.gguf env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron dist/main/smoke-idle.js
 */
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 配置隔离：这个脚本会改 contextWindow / llamaIdleMin，不能动用户真实那份
app.setPath('userData', path.join(os.tmpdir(), 'rorotocode-idle-smoke'))

const repoRelease = path.resolve(__dirname, '..', '..', 'release')
if (!process.env.PORTABLE_EXECUTABLE_DIR && fs.existsSync(path.join(repoRelease, 'llama.cpp'))) {
  process.env.PORTABLE_EXECUTABLE_DIR = repoRelease
}

import { loadConfig, saveConfig } from './config'
import {
  idleUnloadedList,
  llamaInstances,
  localGgufFiles,
  startIdleUnload,
  startLlama,
  statusLlama,
  stopIdleUnload,
  stopLlama,
  wakeLlama
} from './llama'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}${detail ? `  → ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function portAlive(port: number): Promise<boolean> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 1500)
  try {
    await fetch(`http://127.0.0.1:${port}/props`, { signal: ctl.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function waitReady(timeoutMs: number): Promise<{ ready: boolean; ctx: number | null; port: number | null }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const st = await statusLlama('llamacpp').catch(() => null)
    if (st?.running) {
      const inst = llamaInstances().find((i) => i.key === 'llamacpp') ?? llamaInstances()[0]
      return { ready: true, ctx: inst?.ctx ?? null, port: inst?.port ?? st.port ?? null }
    }
    await sleep(500)
  }
  return { ready: false, ctx: null, port: null }
}

async function main(): Promise<void> {
  // 选模型：环境变量优先，否则用目录里第一个真实 gguf（跳过投影器）
  const all = await localGgufFiles()
  const cand = all.filter((f) => !/mmproj/i.test(f.name))
  const model = process.env.ROROTO_SMOKE_MODEL?.trim() || (cand[0]?.name ?? '')
  console.log(`===== idle smoke =====\n模型：${model || '(未找到)'}`)
  if (!model) {
    console.log('没有可用的 .gguf，跳过')
    process.exit(1)
  }

  // 空闲卸载设成「关闭」，脚本自己控制时机，不靠等 10 分钟
  const cfg = await loadConfig()
  await saveConfig({ ...cfg, llamaIdleMin: 0 })

  // 1) 起服务。带 ctxExplicit：模拟「用户手点 4K 档」，这档不该被就绪后的自动调档抬走
  const first = await startLlama(model, 4096, { providerId: 'llamacpp', activate: true, ctxExplicit: true })
  check('启动返回 ok', first.ok, first.message)
  const r1 = await waitReady(180_000)
  check('服务就绪', r1.ready)
  const port = r1.port ?? 0
  check('端口在应答', await portAlive(port))
  check('实例记录了窗口 4096', r1.ctx === 4096, `实际 ${r1.ctx}`)
  const before = llamaInstances()[0]
  check('实例不带「部分卸载」标记', before?.partial === false, String(before?.partial))

  // 2) 服务在跑时叫醒：必须是空操作，pid 与端口都不变
  const provider = (await loadConfig()).providers.find((p) => p.id === 'llamacpp') ?? null
  check('配置里能找到 llamacpp 供应商', !!provider)
  if (provider) {
    const w0 = await wakeLlama(provider)
    const after = llamaInstances()[0]
    check('已在跑时叫醒返回 true（无需动作）', w0 === true)
    check('已在跑时叫醒不会重启实例', after?.pid === before?.pid && after?.port === before?.port,
      `pid ${before?.pid} -> ${after?.pid}`)
  }

  // 3) 停掉 → 显存释放、端口关闭。先记下停之前真正在用的窗口
  const ctxBeforeStop = llamaInstances()[0]?.ctx ?? null
  const stop = await stopLlama('llamacpp')
  check('停止返回 ok', stop.ok, stop.message)
  await sleep(1200)
  check('停掉后没有实例', llamaInstances().length === 0, JSON.stringify(llamaInstances()))
  check('停掉后端口不再应答', !(await portAlive(port)))

  // 4) 按需唤醒：用同样的窗口重新拉起
  if (provider) {
    const t0 = Date.now()
    const woken = await wakeLlama(provider)
    const ms = Date.now() - t0
    check('空闲卸载后能被叫醒', woken === true, `耗时 ${ms}ms`)
    check('叫醒后端口恢复应答', await portAlive(port))
    const back = llamaInstances()[0]
    check(
      '叫醒后沿用停掉前的窗口（没有退回默认档）',
      back?.ctx === ctxBeforeStop && back?.ctx === 4096,
      `停前 ${ctxBeforeStop} / 叫醒后 ${back?.ctx}`
    )
    check('叫醒后实例只有一个（没有起出第二个进程）', llamaInstances().length === 1)
  }

  // 5) 真实空闲回收：只有设了 ROROTO_SMOKE_IDLE_E2E=1 才跑（要等两三分钟）
  if (process.env.ROROTO_SMOKE_IDLE_E2E === '1') {
    console.log('\n--- 真实空闲回收（约 2~3 分钟）---')
    await saveConfig({ ...(await loadConfig()), llamaIdleMin: 1 })
    const again = await startLlama(model, 4096, { providerId: 'llamacpp', ctxExplicit: true })
    check('重新启动', again.ok, again.message)
    check('就绪', (await waitReady(180_000)).ready)
    startIdleUnload()
    const deadline = Date.now() + 210_000
    let stoppedByWatcher = false
    while (Date.now() < deadline) {
      await sleep(5000)
      if (llamaInstances().length === 0) {
        stoppedByWatcher = true
        break
      }
    }
    stopIdleUnload()
    check('闲置到点后服务被自动停掉', stoppedByWatcher, `${Math.round((Date.now() - (deadline - 210_000)) / 1000)}s`)
    const idleSt = await statusLlama('llamacpp').catch(() => null)
    check('状态里标成「空闲卸载」而不是「未运行」', !!idleSt?.idle, JSON.stringify(idleSt?.message ?? ''))
    // 收尾：把配置改回「不卸载」，避免影响后面的手工操作
    await saveConfig({ ...(await loadConfig()), llamaIdleMin: 0 })
  }

  // 6) 收尾
  await stopLlama('llamacpp')
  await sleep(800)
  const st = await statusLlama('llamacpp').catch(() => null)
  check('收尾后服务不在', !st?.running)
  // 手动停掉后不该残留「已空闲卸载」的说明（那是给用户看的，会误导）
  check('手动停止后没有残留的空闲卸载记录', idleUnloadedList().length === 0, JSON.stringify(idleUnloadedList()))

  console.log(`\n===== ${passed} passed, ${failed} failed =====`)
  app.exit(failed ? 1 : 0)
}

void app.whenReady().then(main).catch((err) => {
  console.error('冒烟异常', err)
  app.exit(1)
})
