import { t as tr } from '../i18n'
import { memo, useEffect, useState } from 'react'
import type { ChatMessage, SubAgentTask } from '../../shared/types'
import { RichText } from './Markdown'
import { isComposingKey, isPlainEnter } from '../keyboard'
import { SubAgentCard } from './SubAgentCard'

/** 缩略图按路径缓存，滚动重渲染不会反复走 IPC */
const thumbCache = new Map<string, string | null>()

function Thumb({ absPath }: { absPath: string }) {
  const [src, setSrc] = useState<string | null>(() => thumbCache.get(absPath) ?? null)

  useEffect(() => {
    if (thumbCache.has(absPath)) {
      setSrc(thumbCache.get(absPath) ?? null)
      return
    }
    let alive = true
    void window.pico.files.thumb(absPath).then((url) => {
      thumbCache.set(absPath, url)
      if (alive) setSrc(url)
    })
    return () => {
      alive = false
    }
  }, [absPath])

  if (!src) return <div className="msg-thumb placeholder" />
  return <img className="msg-thumb" src={src} alt="" />
}

function splitUserContent(content: string): { body: string; chars: number } {
  const marker = content.indexOf(tr("----- 以下"))
  if (marker < 0) return { body: content, chars: 0 }
  const body = content.slice(0, marker).trim()
  return { body: body || tr("（见附件）"), chars: content.length - marker }
}

/** 工具参数摘要：界面上只留能看懂的一小段 */
function summarizeArgs(args?: Record<string, unknown>, max = 60): string {
  if (!args) return ''
  const keys = ['path', 'pattern', 'query', 'command', 'url', 'name']
  for (const k of keys) {
    const v = args[k]
    if (typeof v === 'string' && v.trim()) {
      const one = v.replace(/\s+/g, ' ').trim()
      return one.length > max ? `${one.slice(0, max)}…` : one
    }
  }
  const json = JSON.stringify(args)
  return json.length > max ? `${json.slice(0, max)}…` : json
}

/**
 * 这条工具结果是不是失败的（和卡片上的状态判定保持一致）。
 * 主进程写进内容里的前缀永远是中文，所以这里不能用 tr()——英文界面下会取到译文而判错。
 */
function toolFailed(message: ChatMessage): boolean {
  const text = message.content || ''
  return text.startsWith('执行失败') || text.startsWith('用户拒绝') || text.startsWith('✗')
}

/** 输出很长（比如跑了一次构建）时先只露一小段，点一下再看全部 */
const LONG_OUTPUT = 900

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="msg-act"
      title={tr("复制这条回答")}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true)
          window.setTimeout(() => setDone(false), 1200)
        })
      }}
    >
      {done ? tr("已复制") : tr("复制")}
    </button>
  )
}

/** 删除按钮统一走「一整轮」：单删一条工具结果会让 tool_calls 配对断裂，模型请求直接 400 */
function TurnDelete({
  messageId,
  onDelete
}: {
  messageId: string
  onDelete: (messageId: string) => void
}) {
  return (
    <button
      type="button"
      className="turn-del"
      title={tr("删除这一轮对话（含回答和工具输出），给上下文减负")}
      onClick={() => onDelete(messageId)}
    >
      {tr("删除")}
    </button>
  )
}

interface ToolCardProps {
  message: ChatMessage
  running?: boolean
  /** 嵌在折叠组里：去掉外边距，和组头连着 */
  nested?: boolean
  onDelete?: (messageId: string) => void
}

function ToolCard({ message, running, nested, onDelete }: ToolCardProps) {
  const [showAll, setShowAll] = useState(false)
  const failed = toolFailed(message)
  const pending = Boolean(running) && !message.content
  const isVerify = Boolean(message.toolName?.startsWith(tr("自动验证")))
  const body = message.content ?? ''
  const lines = body ? body.split('\n').length : 0
  // 跑构建/测试那种几千行输出，默认只露一小段，别把整段对话顶走
  const long = body.length > LONG_OUTPUT && !showAll
  return (
    <div className={`tool-card ${isVerify ? 'verify' : ''} ${nested ? 'nested' : ''}`}>
      <div className="tool-head">
        <span className="tool-name">{message.toolName ?? 'tool'}</span>
        <span className="tool-arg">{summarizeArgs(message.toolArgs, nested ? 90 : 60)}</span>
        {/* 验证结果写在正文第一行（✓ / ✗），这里只在跑的时候给个状态，避免重复 */}
        {(!isVerify || pending) && (
          <span className={`tool-status ${pending ? 'run' : failed ? 'err' : 'ok'}`}>
            {isVerify ? tr("验证中") : pending ? tr("执行中") : failed ? tr("失败") : tr("完成")}
          </span>
        )}
        {onDelete && !running && <TurnDelete messageId={message.id} onDelete={onDelete} />}
      </div>
      {body ? <pre className={`tool-out ${long ? 'clamped' : ''}`}>{body}</pre> : null}
      {body.length > LONG_OUTPUT && (
        <button className="tool-more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? tr("收起输出") : tr("展开全部（{lines} 行）", { lines })}
        </button>
      )}
    </div>
  )
}

interface StepGroupProps {
  /** 一段连续的执行过程：助手旁白 + 工具结果交替，顺序保留 */
  messages: ChatMessage[]
  running?: boolean
  onDelete?: (messageId: string) => void
}

/**
 * 把「一段执行过程」折成一张卡。
 *
 * 模型干活是「说一句 → 调工具 → 再说一句 → 再调工具」的循环。慢任务（下载依赖、跑长构建）
 * 会连着几十条「仍在继续，继续等待」加命令卡，几屏都是重复的等待，把真正的结论顶没了。
 * 这里把连续的「助手旁白 + 工具卡」整体收进一张卡，组头只留步数、成功/失败条数，
 * 想看细节再展开 —— 过程不丢，但默认不占地方。
 */
export function StepGroup({ messages, running, onDelete }: StepGroupProps) {
  const [open, setOpen] = useState(false)
  const tools = messages.filter((m) => m.role === 'tool')
  const pending = running ? tools.filter((m) => !m.content).length : 0
  const failed = tools.filter((m) => Boolean(m.content) && toolFailed(m)).length
  const ok = tools.length - pending - failed
  const last = tools[tools.length - 1]
  return (
    <div className="msg">
      <div className={`tool-stack ${open ? 'open' : ''}`}>
        <button
          className="tool-stack-head"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? tr("收起这一段执行过程") : tr("展开这一段里的每一步和输出")}
        >
          <span className={`tool-stack-chev ${open ? 'open' : ''}`}>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M6.5 4 10.5 8l-4 4"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="tool-name">{tr("执行过程")}</span>
          <span className="tool-stack-count">{tr("{n} 步", { n: tools.length })}</span>
          {!open && <span className="tool-arg">{summarizeArgs(last?.toolArgs, 80)}</span>}
          <span className="tool-stack-tags">
            {pending > 0 && (
              <span className="tool-status run">
                {tr("执行中")}{pending > 1 ? ` ${pending}` : ''}
              </span>
            )}
            {failed > 0 && <span className="tool-status err">{tr("{n} 条失败", { n: failed })}</span>}
            {ok > 0 && <span className="tool-status ok">{tr("{n} 条完成", { n: ok })}</span>}
          </span>
          <span className="tool-stack-hint">{open ? tr("收起") : tr("展开")}</span>
          {/* 组头本身是 button，里面不能再放 button：用可聚焦的 span 并阻止冒泡，别把折叠状态一起改了 */}
          {onDelete && (
            <span
              className="turn-del"
              role="button"
              tabIndex={0}
              title={tr("删除这一轮对话（含回答和工具输出），给上下文减负")}
              onClick={(e) => {
                e.stopPropagation()
                onDelete(messages[0].id)
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                e.stopPropagation()
                onDelete(messages[0].id)
              }}
            >
              {tr("删除")}
            </span>
          )}
        </button>
        {open && (
          <div className="tool-stack-body">
            {messages.map((m) =>
              m.role === 'tool' ? (
                <ToolCard key={m.id} message={m} nested onDelete={onDelete} />
              ) : (
                <div className="step-say" key={m.id}>
                  {m.content}
                  {onDelete && <TurnDelete messageId={m.id} onDelete={onDelete} />}
                </div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  )
}

interface Props {
  message: ChatMessage
  running?: boolean
  /** 只在最后一条助手消息上给「重新生成」 */
  canRegenerate?: boolean
  onRegenerate?: () => void
  /** 改掉自己的提问后重发 */
  onEdit?: (messageId: string, text: string) => void
  /** 删掉这条消息所在的一整轮，给上下文减负 */
  onDelete?: (messageId: string) => void
  /** 从这条消息处复制一份新会话，原会话保留（两条路各走各的） */
  onFork?: (messageId: string) => void
  /** 这条工具结果是子 agent 派出去的活，带上它的实时状态 */
  subTask?: SubAgentTask
}

/**
 * 一条消息。刻意 memo：
 * 流式输出时每帧都会换掉「正在写的那一条」，其余几十条不该跟着重新渲染、
 * 更不该把正文重新分词一遍。前提是父组件传进来的回调引用稳定（见 App.tsx 的 ref 转发）。
 */
function MessageItemInner({
  message,
  running,
  canRegenerate,
  onRegenerate,
  onEdit,
  onDelete,
  onFork,
  subTask
}: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)

  if (message.role === 'user') {
    const view = splitUserContent(message.content)
    return (
      <div className="msg user">
        <div className="msg-role">{tr("你")}</div>
        {editing ? (
          <div className="bubble editing">
            <textarea
              className="msg-edit"
              rows={3}
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // 输入法选字时按回车只是确认候选，不该顺手把消息发出去
                if (isComposingKey(e)) return
                if (e.key === 'Escape') setEditing(false)
                if (isPlainEnter(e)) {
                  e.preventDefault()
                  if (draft.trim() && !running) {
                    onEdit?.(message.id, draft.trim())
                    setEditing(false)
                  }
                }
              }}
            />
            <div className="msg-edit-actions">
              <span className="msg-edit-tip">{tr("Enter 发送 · Shift+Enter 换行 · Esc 取消")}</span>
              <button className="btn sm" onClick={() => setEditing(false)}>
                {tr("取消")}</button>
              <button
                className="btn primary sm"
                disabled={!draft.trim() || running}
                onClick={() => {
                  if (!draft.trim()) return
                  onEdit?.(message.id, draft.trim())
                  setEditing(false)
                }}
              >
                {tr("重发")}</button>
            </div>
          </div>
        ) : (
          <div className="bubble">
            {message.images?.length ? (
              <div className="msg-thumbs">
                {message.images.map((p, i) => (
                  <Thumb key={`${p}-${i}`} absPath={p} />
                ))}
              </div>
            ) : null}
            {view.body}
            {view.chars > 0 && (
              <div className="bubble-note">
                {message.images?.length
                  ? tr("附件已处理：{length} 张图 + 约 {chars} 字说明", { length: message.images.length, chars: view.chars })
                  : tr("附件正文已读取（约 {chars} 字），此处不展开", { chars: view.chars })}
              </div>
            )}
            {!running && (onEdit || onDelete || onFork) && (
              <div className="msg-acts">
                {onEdit && !view.chars && (
                  <button
                    className="msg-act"
                    title={tr("修改这句话后重新发送（会丢掉后面的回答）")}
                    onClick={() => {
                      setDraft(message.content)
                      setEditing(true)
                    }}
                  >
                    {tr("编辑重发")}</button>
                )}
                {onFork && (
                  <button
                    className="msg-act"
                    title={tr("从这句话处复制一份新会话重新走，原来这条对话保留不动")}
                    onClick={() => onFork(message.id)}
                  >
                    {tr("从这里分叉")}</button>
                )}
                {onDelete && <TurnDelete messageId={message.id} onDelete={onDelete} />}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  if (message.role === 'tool') {
    // 子 agent 的活单独一张卡：能看到它走到第几步、调了哪些工具
    if (message.toolName === 'task') {
      return <SubAgentCard message={message} task={subTask} onDelete={onDelete} />
    }
    return (
      <div className="msg">
        <ToolCard message={message} running={running} onDelete={onDelete} />
      </div>
    )
  }

  if (!message.content) {
    // 「正在思考」已固定在输入区上方状态栏的左侧（和上下文同一行）。
    // 这里不再放占位消息，免得同一句提示在消息区和状态栏之间来回跳、
    // 还把消息列表的高度推得一动一动。
    return null
  }

  return (
    <div className="msg assistant">
      <div className="msg-role">RoRoTo Code</div>
      <div className="msg-body">
        <RichText text={message.content} />
      </div>
      {!running && (
        <div className="msg-acts">
          <CopyButton text={message.content} />
          {canRegenerate && onRegenerate && (
            <button className="msg-act" title={tr("丢掉这条回答，让模型重新生成")} onClick={onRegenerate}>
              {tr("重新生成")}</button>
          )}
          {onDelete && <TurnDelete messageId={message.id} onDelete={onDelete} />}
        </div>
      )}
    </div>
  )
}

export const MessageItem = memo(MessageItemInner)
