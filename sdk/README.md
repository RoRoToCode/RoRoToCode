# RoRoToCode SDK

零依赖客户端，包住本机控制面（`127.0.0.1:7788`）。适合：

- CI / 脚本里让 agent 改代码、跑测试
- 别的编辑器（VS Code 插件、Obsidian 插件）接进来
- 用 curl 之外的方式做自动化

## 装

不需要 `npm install`，仓库里直接带上：

```bash
node sdk/example.mjs
```

从别处引用时把 `sdk/roroto.mjs` 拷过去即可（只有一个文件，用到了 Node 18+ 的 `fetch`）。

## 最快的用法

```js
import { RorotoClient } from './sdk/roroto.mjs'

const client = await RorotoClient.fromDaemonFile()   // 自动读端口和 token
const { text } = await client.run({
  text: '跑一下测试，失败就修',
  workspace: 'F:/my-project',
  approvalPolicy: 'allow'                            // 无人值守必须显式给 allow
})
console.log(text)
```

`run()` = 建会话 + 订阅事件 + 发消息 + 等 `done`，返回整段回答和事件列表。

## 想看过程

```js
for await (const ev of client.events(sessionId)) {
  if (ev.type === 'delta') process.stdout.write(ev.text)
  if (ev.type === 'tool_start') console.log(`\n[调用 ${ev.tool}]`)
  if (ev.type === 'done') break
}
```

事件类型见 `src/shared/types.ts` 里的 `AgentEvent`：
`delta / assistant_start / assistant_end / tool_start / tool_result / approval / question / usage / todos / error / done` 等。

## 手动控制

```js
const id = await client.createSession({ workspace: 'F:/p', agentId: 'agent_review' })
await client.send(id, '审查这次改动', { approvalPolicy: 'allow' })
// ……需要时
await client.abort(id)
```

注意：

- `send()` 立刻返回 202，结果只能从事件流拿，不要指望它的返回值。
- 需要审批的操作在 `approvalPolicy: 'deny'` 下会直接被拒（模型会收到「用户拒绝」），所以无人值守要显式给 `allow`。
- token 每次启动都会换，脚本里别写死；`fromDaemonFile()` 读的是 `%APPDATA%/RoRoToCode/daemon.json`。

## 端点一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 探活（免鉴权） |
| GET | `/openapi.json` | OpenAPI 3.1 描述（免鉴权） |
| GET | `/status?provider=` | 本地实例状态 |
| GET | `/events` | 进程事件流（SSE） |
| POST | `/start` `/stop` | 启动 / 停止 llama-server |
| POST | `/chat/session` | 建会话 |
| POST | `/chat/send` | 发消息（异步，202） |
| POST | `/chat/abort` | 停止本轮 |
| GET | `/chat/events?session=` | 会话事件流（SSE） |
| GET/POST/DELETE | `/agents` | 档案增删查 |
| GET/POST/DELETE | `/routines` | 定时任务 |
| GET/POST | `/handoffs` `/handoffs/run` `/handoffs/cancel` | 交接队列 |

鉴权：`Authorization: Bearer <token>`；SSE 用 `?token=`（EventSource 不能带头）。

## 用 curl 试一下

```bash
TOKEN=$(node -e "console.log(require(process.env.APPDATA+'/RoRoToCode/daemon.json').token)")
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7788/status
```

## 生成别的语言客户端

`/openapi.json` 是标准 3.1，可以直接喂给 `openapi-generator`：

```bash
curl -s http://127.0.0.1:7788/openapi.json > openapi.json
npx @openapitools/openapi-generator-cli generate -i openapi.json -g python -o ./client
```
