import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { promisify } from 'node:util'
import type { GitFile, GitStatus } from '../shared/types'
import { diffLines, unifiedText } from './diff'

const run = promisify(execFile)

/** 子进程里不能带 ELECTRON_RUN_AS_NODE，否则 git 跑不起来 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

async function git(cwd: string, args: string[], timeout = 20000): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { stdout, stderr } = await run('git', args, {
      cwd,
      timeout,
      windowsHide: true,
      env: cleanEnv(),
      maxBuffer: 8 * 1024 * 1024
    })
    return { ok: true, out: stdout, err: stderr }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, out: e.stdout ?? '', err: e.stderr || e.message || 'git 执行失败' }
  }
}

export async function gitStatus(workspace: string | null): Promise<GitStatus> {
  if (!workspace) return { ok: false, files: [], message: '还没有选择工作区' }
  const inside = await git(workspace, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out.trim() !== 'true') {
    return { ok: false, files: [], message: '这个目录不是 git 仓库（可以先在终端执行 git init）' }
  }
  const branchRes = await git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = branchRes.ok ? branchRes.out.trim() : ''
  const st = await git(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (!st.ok) return { ok: false, files: [], branch, message: st.err.trim() || 'git status 失败' }

  const parts = st.out.split('\0')
  const files: GitFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry || entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    const file = entry.slice(3)
    // 重命名会多一段原始路径
    if (x === 'R' || x === 'C') i++
    const untracked = x === '?' && y === '?'
    files.push({
      path: file,
      status: untracked ? '??' : `${x}${y}`.trim() || 'M',
      staged: !untracked && x !== ' ',
      untracked
    })
  }
  return { ok: true, branch, files }
}

export async function gitDiff(
  workspace: string | null,
  relPath: string
): Promise<{ ok: boolean; text: string; message?: string }> {
  if (!workspace) return { ok: false, text: '', message: '还没有选择工作区' }
  const tracked = await git(workspace, ['diff', '--no-color', '--', relPath])
  if (tracked.ok && tracked.out.trim()) return { ok: true, text: tracked.out }
  // 未跟踪 / 已暂存：退回自己算一份「空 → 当前内容」
  const staged = await git(workspace, ['diff', '--cached', '--no-color', '--', relPath])
  if (staged.ok && staged.out.trim()) return { ok: true, text: staged.out }
  try {
    const full = `${workspace.replace(/[\\/]+$/, '')}/${relPath}`
    const now = await fs.readFile(full, 'utf8')
    const lines = diffLines('', now)
    return { ok: true, text: unifiedText(relPath, lines) }
  } catch {
    return { ok: false, text: '', message: '读不到这个文件（可能已被删除）' }
  }
}

export async function gitCommit(
  workspace: string | null,
  message: string,
  paths?: string[]
): Promise<{ ok: boolean; message: string }> {
  if (!workspace) return { ok: false, message: '还没有选择工作区' }
  if (!message.trim()) return { ok: false, message: '提交信息不能为空' }
  const addArgs = ['add', '-A', '--', ...(paths?.length ? paths : ['.'])]
  const added = await git(workspace, addArgs)
  if (!added.ok) return { ok: false, message: added.err.trim() || 'git add 失败' }
  const committed = await git(workspace, ['commit', '-m', message])
  if (!committed.ok) {
    const text = (committed.err || committed.out).trim()
    return { ok: false, message: text.split('\n').slice(0, 4).join('\n') || 'git commit 失败' }
  }
  return { ok: true, message: committed.out.trim().split('\n')[0] || '已提交' }
}

/* ------------------------------------------------------------------ *
 * 结构化 Git：给模型一套动作，而不是让它自己拼 git 命令
 * ------------------------------------------------------------------ */

function okText(r: { ok: boolean; out: string; err: string }, fallback: string): string {
  if (!r.ok) {
    const text = (r.err || r.out || fallback).trim()
    throw new Error(text.split(/\r?\n/).slice(0, 4).join('\n') || fallback)
  }
  return r.out.trim()
}

async function currentBranch(workspace: string): Promise<string> {
  const r = await git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return r.ok ? r.out.trim() : ''
}

async function hasCommit(workspace: string): Promise<boolean> {
  const r = await git(workspace, ['rev-parse', '--verify', 'HEAD'])
  return r.ok
}

/** gh / 任意命令；ENOENT 时返回 missing=true 而不是抛错 */
function runBin(cmd: string, args: string[], cwd: string, timeout = 60_000): Promise<{ ok: boolean; missing: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout, windowsHide: true, env: cleanEnv(), maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ ok: false, missing: true, out: '', err: '' })
          return
        }
        resolve({ ok: !error, missing: false, out: String(stdout ?? ''), err: String(stderr ?? '') })
      }
    )
  })
}

export interface GitActionArgs {
  message?: string
  paths?: string[]
  branch?: string
  remote?: string
  create?: boolean
  steps?: number
  dir?: string
  title?: string
  body?: string
  limit?: number
  stashAction?: 'push' | 'pop' | 'list' | 'drop'
  worktreeAction?: 'list' | 'add' | 'remove'
}

/**
 * 统一入口：模型只传 action + 参数，具体命令在这里拼。
 * 任何失败都抛 Error，由工具层转成「执行失败：…」回灌给模型。
 */
export async function gitAction(workspace: string | null, action: string, a: GitActionArgs): Promise<string> {
  if (!workspace) throw new Error('还没有选择工作区')
  const inside = await git(workspace, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out.trim() !== 'true') throw new Error('这个目录不是 git 仓库（可以先 git init）')

  switch (action) {
    case 'status': {
      const st = await gitStatus(workspace)
      if (!st.ok) throw new Error(st.message || 'git status 失败')
      const lines = st.files.map((f) => `${f.status.padEnd(2)} ${f.path}`)
      return `分支 ${st.branch || '(detached)'}${lines.length ? `\n${lines.join('\n')}` : '\n工作区干净'}`
    }
    case 'diff': {
      const p = a.paths?.[0]
      const r = p ? await gitDiff(workspace, p) : { ok: true, text: okText(await git(workspace, ['diff', '--no-color']), 'git diff 失败') }
      if (!r.ok) throw new Error(r.message || 'git diff 失败')
      return r.text.trim() || '（没有未提交的改动）'
    }
    case 'log': {
      const n = Math.min(Math.max(Number(a.limit) || 15, 1), 100)
      if (!(await hasCommit(workspace))) return '（还没有提交）'
      const r = await git(workspace, ['log', `-${n}`, '--oneline', '--decorate', '--no-color'])
      return okText(r, 'git log 失败') || '（没有提交）'
    }
    case 'branches': {
      const r = await git(workspace, ['branch', '-a', '--no-color'])
      const cur = await currentBranch(workspace)
      return `当前分支：${cur || '(detached)'}\n${okText(r, 'git branch 失败')}`
    }
    case 'checkout': {
      const branch = String(a.branch || '').trim()
      if (!branch) throw new Error('checkout 需要 branch')
      const r = a.create
        ? await git(workspace, ['checkout', '-b', branch])
        : await git(workspace, ['checkout', branch])
      return `已切换到 ${branch}\n${okText(r, 'git checkout 失败')}`
    }
    case 'add': {
      const paths = a.paths?.length ? a.paths : ['.']
      return `已暂存 ${paths.join('、')}\n${okText(await git(workspace, ['add', '--', ...paths]), 'git add 失败')}`
    }
    case 'commit': {
      const msg = String(a.message || '').trim()
      if (!msg) throw new Error('commit 需要 message')
      const r = await gitCommit(workspace, msg, a.paths)
      if (!r.ok) throw new Error(r.message)
      return r.message
    }
    case 'push': {
      const remote = String(a.remote || 'origin').trim()
      const branch = String(a.branch || (await currentBranch(workspace))).trim()
      if (!branch) throw new Error('当前是 detached HEAD，push 需要显式给 branch')
      const args = ['push']
      if (a.create !== false) args.push('-u')
      args.push(remote, branch)
      return `已推送 ${branch} → ${remote}\n${okText(await git(workspace, args, 120_000), 'git push 失败')}`
    }
    case 'pull': {
      const args = ['pull', '--no-edit']
      if (a.remote) args.push(String(a.remote))
      if (a.branch) args.push(String(a.branch))
      return `拉取完成\n${okText(await git(workspace, args, 120_000), 'git pull 失败')}`
    }
    case 'stash': {
      const sub = a.stashAction || 'push'
      if (sub === 'list') return okText(await git(workspace, ['stash', 'list']), 'git stash list 失败') || '（没有 stash）'
      if (sub === 'push') {
        const msg = String(a.message || '').trim()
        return `已 stash\n${okText(await git(workspace, ['stash', 'push', ...(msg ? ['-m', msg] : [])]), 'git stash 失败')}`
      }
      if (sub === 'pop') return `已恢复 stash\n${okText(await git(workspace, ['stash', 'pop']), 'git stash pop 失败')}`
      return `已丢弃一条 stash\n${okText(await git(workspace, ['stash', 'drop']), 'git stash drop 失败')}`
    }
    case 'undo': {
      const steps = Math.min(Math.max(Number(a.steps) || 1, 1), 5)
      if (!(await hasCommit(workspace))) throw new Error('还没有提交可以撤销')
      // --soft：只退提交指针，改动留在暂存区，不会丢代码
      return `已撤销最近 ${steps} 个提交（改动保留在暂存区）\n${okText(
        await git(workspace, ['reset', '--soft', `HEAD~${steps}`]),
        'git reset --soft 失败'
      )}`
    }
    case 'worktree': {
      const sub = a.worktreeAction || 'list'
      if (sub === 'list') return okText(await git(workspace, ['worktree', 'list']), 'git worktree list 失败')
      if (sub === 'add') {
        const dir = String(a.dir || '').trim()
        if (!dir) throw new Error('worktree add 需要 dir')
        const args = ['worktree', 'add', dir]
        if (a.branch) args.push('-b', String(a.branch))
        return `已创建 worktree ${dir}\n${okText(await git(workspace, args), 'git worktree add 失败')}`
      }
      const dir = String(a.dir || '').trim()
      if (!dir) throw new Error('worktree remove 需要 dir')
      return `已移除 worktree ${dir}\n${okText(await git(workspace, ['worktree', 'remove', dir]), 'git worktree remove 失败')}`
    }
    case 'pr': {
      const title = String(a.title || '').trim()
      if (!title) throw new Error('pr 需要 title')
      const body = String(a.body || '').trim()
      const r = await runBin('gh', ['pr', 'create', '--title', title, '--body', body || title], workspace, 120_000)
      if (r.missing) throw new Error('没有安装 GitHub CLI（gh）。请先安装 gh 并登录，或手动在网页上建 PR。')
      if (!r.ok) throw new Error((r.err || r.out).trim().split(/\r?\n/).slice(0, 4).join('\n') || 'gh pr create 失败')
      return `已创建 PR：${r.out.trim()}`
    }
    default:
      throw new Error(`未知 git 动作：${action}`)
  }
}
