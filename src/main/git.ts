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
