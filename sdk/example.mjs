/**
 * 最小示例：连上本机控制面，让 agent 说一句话，把流式输出打到终端。
 *
 *   node sdk/example.mjs "帮我看看 package.json 里的 scripts"
 *
 * 需要 RoRoToCode 正在运行（控制面才会写好 daemon.json）。
 */
import { RorotoClient } from './roroto.mjs'

const text = process.argv.slice(2).join(' ') || '用一句话说明你能做什么'

const client = await RorotoClient.fromDaemonFile()
console.log(`→ ${client.baseUrl}（pid ${client.info?.pid ?? '?'}）\n`)

const sessionId = await client.createSession()
let printed = 0

for await (const ev of client.events(sessionId)) {
  if (ev.type === 'delta' && ev.text) {
    process.stdout.write(ev.text)
    printed += ev.text.length
  } else if (ev.type === 'tool_start') {
    process.stdout.write(`\n\n[${ev.tool}] `)
  } else if (ev.type === 'error') {
    console.error(`\n\n出错了：${ev.message}`)
    break
  } else if (ev.type === 'done') {
    break
  }
}

if (!printed) console.log('（这一轮没有文字输出，可能只调了工具）')
console.log('\n')
