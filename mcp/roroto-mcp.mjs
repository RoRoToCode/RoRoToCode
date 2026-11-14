#!/usr/bin/env node
/**
 * RoRoToCode MCPServer（stdio 桥）。
 *
 * 有些 MCP 客户端只支持 stdio，不认 HTTP。这个脚本把 stdin 上的 JSON-RPC
 * 一条条转给本机控制面（http://127.0.0.1:<port>/mcp），再把结果写回 stdout。
 * 它自己不实现任何工具 —— 工具在跑着的 RoRoToCode 里，那边有工作区、审批和缓存。
 *
 * 用法（Cursor / Cline 的 mcp 配置里）：
 *   {
 *     "mcpServers": {
 *       "roroto": {
 *         "command": "node",
 *         "args": ["F:/RoRoToCode/mcp/roroto-mcp.mjs"],
 *         "env": { "ROROTO_DAEMON_FILE": "C:/Users/you/AppData/Roaming/RoRoToCode/daemon.json" }
 *       }
 *     }
 *   }
 *
 * 不传 ROROTO_DAEMON_FILE 时按平台猜默认路径。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'

function daemonFile() {
  if (process.env.ROROTO_DAEMON_FILE) return process.env.ROROTO_DAEMON_FILE
  const home = os.homedir()
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'RoRoToCode', 'daemon.json')
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'RoRoToCode', 'daemon.json')
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'RoRoToCode', 'daemon.json')
}

function readDaemon() {
  const raw = JSON.parse(readFileSync(daemonFile(), 'utf8'))
  if (!raw?.port || !raw?.token) throw new Error('daemon.json 里没有 port/token')
  return raw
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

async function forward(msg) {
  const { port, token } = readDaemon()
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(msg)
  })
  if (res.status === 202) return null
  const text = await res.text()
  if (!text) return null
  return JSON.parse(text)
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '这不是合法 JSON' } })
    return
  }

  // 通知（没有 id）不需要回包
  const isNotification = Array.isArray(msg)
    ? msg.every((m) => m && m.id === undefined)
    : msg && msg.id === undefined

  void forward(msg)
    .then((out) => {
      if (out && !isNotification) send(out)
    })
    .catch((err) => {
      if (isNotification) return
      const id = Array.isArray(msg) ? null : (msg?.id ?? null)
      send({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: `连不上 RoRoToCode：${err.message}。先确认程序正在运行（控制面默认 7777 端口）。`
        }
      })
    })
})
