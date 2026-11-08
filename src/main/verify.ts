/**
 * 自我验证：模型说「改完了」之后，程序自己判断这个项目该怎么验（测试 / 类型检查 / 构建），
 * 跑一遍再把结果喂回去。失败就让模型继续修，而不是把「已完成」直接交给用户。
 *
 * 只认几种常见工程，猜不到就静默跳过——绝不乱跑命令。
 */
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export interface VerifyPlan {
  command: string
  label: string
}

const MAX_OUTPUT = 4000
const TIMEOUT = 240_000

async function readPackageJson(workspace: string): Promise<{ scripts?: Record<string, string> } | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 按项目类型挑一条最有价值的验证命令；挑不出来返回 null */
export async function detectVerifyPlan(workspace: string): Promise<VerifyPlan | null> {
  if (!workspace || !existsSync(workspace)) return null

  const pkg = await readPackageJson(workspace)
  const scripts = pkg?.scripts ?? {}
  // npm 默认的 test 脚本只会报错退出，当成没有
  if (scripts.test && !/no test specified/i.test(scripts.test)) {
    return { command: 'npm test --silent', label: '测试' }
  }
  if (scripts.typecheck) return { command: 'npm run typecheck --silent', label: '类型检查' }
  if (scripts.build) return { command: 'npm run build --silent', label: '构建' }
  if (scripts.lint) return { command: 'npm run lint --silent', label: 'Lint' }

  const tsc = process.platform === 'win32' ? 'node_modules\\.bin\\tsc.cmd' : 'node_modules/.bin/tsc'
  if (existsSync(path.join(workspace, 'tsconfig.json')) && existsSync(path.join(workspace, tsc))) {
    return { command: `"${tsc}" --noEmit`, label: '类型检查' }
  }

  if (existsSync(path.join(workspace, 'Cargo.toml'))) return { command: 'cargo check --quiet', label: '编译检查' }
  if (existsSync(path.join(workspace, 'go.mod'))) return { command: 'go build ./...', label: '编译检查' }

  const pyMarker = ['pyproject.toml', 'pytest.ini', 'setup.py', 'tests'].some((f) =>
    existsSync(path.join(workspace, f))
  )
  if (pyMarker) return { command: 'python -m pytest -q --maxfail=1', label: '测试' }

  return null
}

function cut(text: string, max = MAX_OUTPUT): string {
  const t = text.trim()
  if (t.length <= max) return t
  // 测试输出通常「错误在末尾」，保留头部少量上下文 + 尾部大部分
  return `${t.slice(0, 800)}\n…（中间省略 ${t.length - max} 字符）\n${t.slice(-(max - 800))}`
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  // 这些变量会让子进程（尤其是 electron 自带的 node）行为异常，跑构建/测试时必须去掉
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  delete env.ELECTRON_ENABLE_LOGGING
  env.CI = '1'
  env.NO_COLOR = '1'
  env.FORCE_COLOR = '0'
  env.GIT_PAGER = 'cat'
  env.PAGER = 'cat'
  return env
}

export interface VerifyResult {
  ok: boolean
  command: string
  label: string
  output: string
  durationMs: number
}

/** 跑验证命令；超时/取消都会杀掉整个进程树 */
export function runVerify(workspace: string, plan: VerifyPlan, signal: AbortSignal): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(plan.command, {
      cwd: workspace,
      shell: true,
      windowsHide: true,
      env: childEnv()
    })

    let out = ''
    let done = false
    const finish = (code: number | null, extra?: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      const body = [out.trim(), extra].filter(Boolean).join('\n')
      resolve({
        ok: code === 0,
        command: plan.command,
        label: plan.label,
        output: cut(body) || '（命令没有任何输出）',
        durationMs: Date.now() - started
      })
    }

    const kill = () => {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
        } else {
          child.kill('SIGKILL')
        }
      } catch {
        child.kill()
      }
    }

    const timer = setTimeout(() => {
      kill()
      finish(null, `\n[超过 ${Math.round(TIMEOUT / 1000)} 秒，已终止。可能是构建卡住或测试在等输入]`)
    }, TIMEOUT)

    const onAbort = () => {
      kill()
      finish(null, '\n[已取消]')
    }
    signal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < MAX_OUTPUT * 4) out += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (out.length < MAX_OUTPUT * 4) out += d.toString('utf8')
    })
    child.on('error', (err) => finish(null, `[无法启动验证命令：${err.message}]`))
    child.on('close', (code) => finish(code))
  })
}
