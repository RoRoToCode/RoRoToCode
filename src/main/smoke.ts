import { app } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { defaultConfig, saveConfig } from './config'
import * as store from './store'
import { AgentEngine } from './agent'
import type { AgentEvent, Session } from '../shared/types'

app.setPath('userData', path.join(os.tmpdir(), 'rorotocode-smoke'))

void app.whenReady().then(async () => {
  const workspace = process.env.SMOKE_WS || ''
  const baseUrl = process.env.SMOKE_URL || 'http://127.0.0.1:9911/v1'
  // SMOKE_KIND=ollama 时走本地 Ollama 的真实链路（原生 /api/chat + num_ctx），用来验上下文
  const kind = process.env.SMOKE_KIND === 'ollama' ? ('ollama' as const) : ('openai' as const)
  const model = process.env.SMOKE_MODEL || 'mock-coder'
  const ctx = Number(process.env.SMOKE_CTX || 32000)
  // 多轮 + 长文本：用来验证「自动压缩上下文」是否触发（SMOKE_TURNS=6 SMOKE_PAD=1200）
  const turns = Math.max(1, Number(process.env.SMOKE_TURNS || 1))
  const pad = Math.max(0, Number(process.env.SMOKE_PAD || 0))
  const filler = pad > 0 ? `补充背景资料：${'这是用于占位的历史内容，只为了让上下文变长。'.repeat(1)}`.padEnd(pad, '说明') : ''

  await saveConfig({
    ...defaultConfig(),
    workspace,
    activeId: 'mock',
    approvalMode: 'auto',
    maxSteps: 6,
    contextWindow: ctx,
    autoCompact: true,
    // SMOKE_OFF=web,memory 用来验证「软件设置」里的能力开关是否真的把工具拿掉了
    ...(process.env.SMOKE_OFF
      ? {
          webSearch: !process.env.SMOKE_OFF.includes('web'),
          memory: !process.env.SMOKE_OFF.includes('memory')
        }
      : {}),
    providers: [
      {
        id: 'mock',
        name: 'Mock',
        kind,
        baseUrl,
        apiKey: 'test',
        model,
        contextWindow: ctx,
        temperature: 0
      }
    ]
  })

  const engine = new AgentEngine((sessionId: string, event: AgentEvent) => {
    const brief =
      event.type === 'delta'
        ? `${event.type} +${event.text.length}`
        : event.type === 'tool_result'
          ? `${event.type} ${event.tool} ok=${event.ok}`
          : event.type
    console.log('[event]', brief)
  })

  const session = await store.createSession()
  try {
    for (let i = 1; i <= turns; i++) {
      const ask =
        process.env.SMOKE_ASK ||
        (turns === 1
          ? '看一下 src/a.ts 里有什么，然后告诉我'
          : `第 ${i} 轮：${filler}请用一句话记住这轮的主题是「第${i}轮」。`)
      await engine.send(session.id, ask)
      const s = await store.loadSession(session.id)
      console.log(`[round ${i}] 消息数=${s.messages.length}`)
    }
  } catch (err) {
    console.error('[error]', (err as Error).message)
  }

  const loaded: Session = await store.loadSession(session.id)
  console.log('\n--- stored messages ---')
  for (const m of loaded.messages) {
    console.log(`${m.role}${m.toolName ? `(${m.toolName})` : ''}: ${JSON.stringify(m.content).slice(0, 120)}`)
  }
  app.exit(0)
})
