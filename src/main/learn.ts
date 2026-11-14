/**
 * /learn：把一段「已经干成的活」蒸馏成可复用的技能。
 *
 * 为什么不让模型自己写 SKILL.md：它在会话里只有一次性的上下文，写出来的多半是
 * 「这次我改了哪三个文件」—— 换个人、换个目录就失效。所以这里换个问法：
 * 把工具轨迹（调了什么、参数长什么样、结果成没成）摆出来，让它总结**方法**，
 * 而不是复述过程。轨迹是我们这边已有的数据，比录屏准，也比让用户手写省事。
 *
 * 落点是 skills.json（自定义技能）：技能面板能看、能改、能用，用户不满意随时删。
 */
import type { Skill } from '../shared/types'
import { condenseTrace, parseDistilled } from '../shared/distill'
import { loadConfig, providerForSession } from './config'
import { chat } from './providers'
import { listSkills, saveSkill } from './skills'
import * as store from './store'

export interface DistillResult {
  ok: boolean
  message: string
  skill?: Skill
}

const INSTRUCTION = `你在把一个「已经做成的事」蒸馏成可复用的技能，给下一个遇到同类任务的 agent 用。

我会给你这次会话的实际操作轨迹：[用户] 是需求，[调用] 是真正执行过的工具和参数，[结果] 是工具返回的开头。

要求：
1. 总结的是**方法**，不是这次做了什么。不要出现「这次改了 xxx.ts」这种只对本次成立的细节；除非它本身就是项目约定（比如「测试命令是 pnpm test」）。
2. prompt 写成分步指令，3~8 步。每步说清：做什么、用什么工具/命令、怎么判断这一步成了。
3. 保留真正起作用的命令、参数写法、路径约定、验证方式；去掉试探过程中走错又回头的分支。
4. 不要写「先和用户确认」这类空话，也不要写「注意安全」这种没有具体动作的话。
5. name 不超过 12 个字，desc 一句话说清「什么时候该用它」。

只输出一个 JSON 对象，不要任何解释：
{"name":"技能名","desc":"什么时候用","prompt":"分步指令，用 1. 2. 3. 编号"}`

/**
 * 蒸馏入口。失败一律返回可读的原因，不抛错 —— 它由输入框的 /learn 触发，
 * 弹一个未捕获异常对用户没有意义。
 */
export async function distillSkill(sessionId: string): Promise<DistillResult> {
  try {
    const session = await store.loadSession(sessionId)
    const calls = session.messages.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0)
    if (calls < 1) {
      return { ok: false, message: '这段对话还没执行过工具，先让它干点实际的事再来蒸馏' }
    }

    const config = await loadConfig()
    const provider = providerForSession(config, session.modelId)
    if (!provider) return { ok: false, message: '还没有配置模型' }

    const trace = condenseTrace(session.messages)
    const controller = new AbortController()
    // 蒸馏是一次性调用，卡住不如早点失败：90 秒还没结果，多半是服务端在排队
    const timer = setTimeout(() => controller.abort(new Error('蒸馏超时')), 90_000)
    let out = ''
    try {
      await chat({
        provider,
        messages: [
          {
            id: store.newId(),
            role: 'user',
            content: `${INSTRUCTION}\n\n---\n${trace}`,
            createdAt: Date.now()
          }
        ],
        tools: [],
        signal: controller.signal,
        onText: (t) => {
          out += t
        }
      })
    } finally {
      clearTimeout(timer)
    }

    // 模型没按格式回：退回「原样当指令」，至少不让用户白等一次调用
    const parsed = parseDistilled(out) ?? {
      name: (session.title || '从会话学到的做法').replace(/\s+/g, ' ').slice(0, 12),
      desc: '从一次实际会话蒸馏出来的做法',
      prompt: out.trim() || '（模型没有返回可用内容）'
    }

    /**
     * 同名技能直接改成新的：对同一条会话重复 /learn（比如中间又补了几步）
     * 应该更新那条技能，而不是在面板里堆出三个一模一样的名字。
     * 内置技能不覆盖 —— 那是产品自带的，改了就再也回不去。
     */
    const twin = (await listSkills()).find((s) => s.name === parsed.name && !s.builtin)
    const saved = await saveSkill(twin ? { id: twin.id, ...parsed } : parsed)
    if (!saved.ok) return { ok: false, message: saved.message }
    const skill = saved.skills.find((s) => s.name === parsed.name && !s.builtin) ?? null
    return {
      ok: true,
      message: `已蒸馏成技能「${parsed.name}」，在技能面板里能看到，点「调用」就能带上这套做法`,
      ...(skill ? { skill } : {})
    }
  } catch (err) {
    return { ok: false, message: `蒸馏失败：${(err as Error).message}` }
  }
}
