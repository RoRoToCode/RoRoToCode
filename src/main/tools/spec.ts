export interface ToolSpec {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
}

export const toolSpecs: ToolSpec[] = [
  {
    name: 'read_file',
    description: '读取工作区内某个文本文件的内容。修改文件前必须先读它。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的路径' },
        offset: { type: 'number', description: '起始行号（从 1 开始），可选' },
        limit: { type: 'number', description: '读取行数，可选' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: '新建或整体覆盖一个文件。只在创建新文件或需要完全重写时使用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的路径' },
        content: { type: 'string', description: '完整文件内容' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'edit_file',
    description: '对文件做精确字符串替换。old_string 必须是原文中真实存在且唯一的片段。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的路径' },
        old_string: { type: 'string', description: '要被替换的原文片段' },
        new_string: { type: 'string', description: '替换后的内容' },
        replace_all: { type: 'boolean', description: '是否替换所有匹配项，默认 false' }
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  {
    name: 'list_dir',
    description: '列出目录下的文件和子目录，用于了解项目结构。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的目录路径，默认根目录' }
      }
    }
  },
  {
    name: 'glob',
    description: '按通配符查找文件，例如 **/*.ts 或 src/**/*.tsx。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'grep',
    description: '按正则表达式搜索文件内容，返回 文件:行号: 内容。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '搜索起点目录，默认工作区根目录' },
        include: { type: 'string', description: '只搜索匹配该 glob 的文件，例如 **/*.ts' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'goto_definition',
    description:
      '跳到某个符号（变量、函数、类型、类、导入等）的定义处。改代码前想弄清某个名字到底定义在哪、长什么样时用它，比 grep 准（走类型系统，不是文本匹配）。只支持 TypeScript / JavaScript。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        line: { type: 'number', description: '符号所在行号（1 开始）' },
        col: { type: 'number', description: '符号所在列号（1 开始），默认 1' }
      },
      required: ['path', 'line']
    }
  },
  {
    name: 'find_references',
    description:
      '查找某个符号的所有引用位置。改一个函数签名、字段名或常量前，用它确认会影响哪些文件哪些行，避免漏改。只支持 TypeScript / JavaScript。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        line: { type: 'number', description: '符号所在行号（1 开始）' },
        col: { type: 'number', description: '符号所在列号（1 开始），默认 1' }
      },
      required: ['path', 'line']
    }
  },
  {
    name: 'run_shell',
    description:
      '在工作区执行命令。Windows 默认用 cmd.exe；需要 unix 命令时把 shell 设为 bash（需已安装 Git Bash）。' +
      '构建、安装依赖、跑测试这类可能超过 2 分钟的命令，把 background 设为 true 先挂到后台，再用 shell_bg 看日志。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        shell: { type: 'string', enum: ['cmd', 'powershell', 'bash'], description: '默认 cmd' },
        timeout_ms: { type: 'number', description: '超时毫秒数，默认 120000' },
        background: {
          type: 'boolean',
          description: '后台运行：立刻返回任务 id 和日志文件，用 shell_bg 查看进度'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'shell_bg',
    description:
      '查看或管理由 run_shell(background=true) 启动的后台命令：list 列出全部，log 读某个任务的日志，kill 结束它。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'log', 'kill'], description: '默认 log' },
        id: { type: 'string', description: '任务 id（list 时可省略）' },
        tail: { type: 'number', description: '只取最后多少行，默认 80' }
      },
      required: ['action']
    }
  },
  {
    name: 'web_search',
    description:
      '联网搜索，返回标题、网址和摘要。查最新资料、官方文档、报错原因、库的用法时先用它，再用 web_fetch 打开最相关的一两个链接。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，越具体越好（可以带库名和版本号）' },
        count: { type: 'number', description: '返回条数，默认 8，最多 15' }
      },
      required: ['query']
    }
  },
  {
    name: 'web_fetch',
    description:
      '抓取一个网页并转成纯文本，用来读官方文档、GitHub issue、博客。只支持公网 http/https 地址，读不了 PDF / 图片。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整网址' },
        max_chars: { type: 'number', description: '最多返回多少字符，默认 16000' }
      },
      required: ['url']
    }
  },
  {
    name: 'update_todos',
    description:
      '更新当前任务的执行计划（整表覆盖）。多步骤任务开始时先列出计划，之后每完成一步就再调用一次更新状态，让用户看得见进度。',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '完整计划，按执行顺序排列；最多 20 项',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '这一步要做什么，一句话' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: '默认 pending；同一时间最多一项 in_progress'
              }
            },
            required: ['content']
          }
        }
      },
      required: ['items']
    }
  },
  {
    name: 'remember',
    description:
      '把值得跨会话保留的事实写进本项目的长期记忆：构建/测试命令、目录约定、用户偏好、踩过的坑。下次对话会自动带上，不用重复问。',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: '一条简洁的事实，一句话说清，例如「构建用 pnpm build，测试是 vitest」' }
      },
      required: ['note']
    }
  },
  {
    name: 'board',
    description:
      '往「共享黑板」写一条便签。黑板是同一个工作区里所有档案共用的一页：巡检、审查、主控、以及别人交过来的活都会看到。适合写跨会话还有效、但这摊活干完就该扔的事——谁在改哪块、还剩什么没做、刚踩到的坑、这个分支的临时约定。不适合写永久事实（那用 remember）。写完这一轮就会生效，不用等下一次对话。',
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['rule', 'fact', 'todo'],
          description: 'rule = 这摊活的约定（别动哪块、按什么顺序改）；fact = 查到的事实（某接口在哪个文件）；todo = 还剩什么没做'
        },
        note: {
          type: 'string',
          description: '一句话，写成别人不用问你也能看懂的样子，例如「登录限流改在 src/auth/limit.ts，测试还没补」'
        }
      },
      required: ['section', 'note']
    }
  },
  {
    name: 'scratch',
    description:
      '给「这一次会话」记临时便签：待会儿要回头做的事、刚查到的关键行号、试过但没用的方案。只有当前会话能看到，别的会话和别的档案都看不到，也不会写进长期记忆。跨会话还有效的事实用 remember，跨会话的这摊活进度用 board。活干完这条便签就没意义了，别往里塞长期结论。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '要写的内容，一句话一条。不传就是读当前便签'
        },
        mode: {
          type: 'string',
          enum: ['append', 'replace'],
          description: 'append = 追加一条（默认，推荐）；replace = 整篇覆盖'
        },
        clear: { type: 'boolean', description: '清空便签（活做完了收拾现场用）' }
      },
      required: []
    }
  },
  {
    name: 'task',
    description:
      '把一个子任务派给独立的子 agent 去做。子 agent 有自己的上下文和循环，会自己读文件、改代码、跑命令，最后只把结论回传给你——中间几十次读文件的细节不会占用你的上下文。适合：① 要翻阅大量文件才能回答的问题（「这个仓库的鉴权怎么走的」）；② 互不相关的多个模块各改一处，可以一次派多个 task 并行；③ 需要大量搜索/探查的活。简单的一两步操作不要用，自己直接做更快。',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '3-5 个字的短标题，给用户看的，例如「梳理鉴权链路」' },
        prompt: {
          type: 'string',
          description:
            '给子 agent 的完整任务说明。它看不到当前对话，所以要把背景、要做什么、涉及哪些路径、期望交付什么都写清楚。并行派多个子任务时，不要让它们改同一批文件。'
        }
      },
      required: ['description', 'prompt']
    }
  },
  {
    name: 'handoff',
    description:
      '把一件独立的活交给另一个 Agent 档案（比如巡检发现登录接口没限流，交给「审查」去修）。与 task 的关键区别：task 派出去的子 agent 只是多一双手，结果要你自己汇总；handoff 交出去的是**一个有身份、有自己记忆和工具边界的档案**，它会在你这一轮结束后自己接手，你不用等结果。适合：发现的问题属于别人的职责、要改的东西不该由你动、或者这条活做完要沉淀成那个角色自己的经验。交出去之前把「凭什么」写清楚，它只拿着你给的这些开工。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '目标档案的名字或 id，从系统提示的「可以交接」里选' },
        task: { type: 'string', description: '要它做什么，一句话说清。它看不到当前对话，必须能独立看懂' },
        context: {
          type: 'string',
          description: '你查到的关键情况：文件、行号、复现步骤、为什么这是问题。这是它的全部线索，写得越具体它越不需要重查'
        },
        files: {
          type: 'array',
          description: '相关文件（相对工作区路径）。它自己会读，不要在这贴全文',
          items: { type: 'string' }
        }
      },
      required: ['to', 'task']
    }
  },
  {
    name: 'question',
    description:
      '任务遇到需要用户决策的分叉时，停下来问用户一个问题（可带选项），等用户作答后再继续。适合：选哪种技术方案、删不删某样东西、迁移到哪个库、用哪个端口这类无法替用户拍板的事。不要拿它问自己能查出来的事实（用 read_file/grep 自己查），也不要频繁打断用户。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问用户的问题，一句话说清' },
        options: {
          type: 'array',
          description: '可选的答案选项（2-6 个）。不填则让用户自由输入',
          items: { type: 'string' }
        },
        multiSelect: {
          type: 'boolean',
          description: '是否允许多选（默认 false，单选）。多选时用户可勾选多个选项，答案以逗号分隔回传'
        }
      },
      required: ['question']
    }
  },
  {
    name: 'patch',
    description:
      '一次对多个文件做改动（增/改/删/移动）。支持两种输入：① 标准 apply_patch 文本（unified diff，含 @@ 行号 hunk 与 ---/+++ 文件头），适合一次贴多文件大段改动；② edits 数组（本程序 JSON 格式，字段见下）。所有改动先整体校验（路径、old_string 唯一性等），全部通过后才统一落盘：内容先写入临时文件、全部就绪后一次性替换，校验或准备阶段任一失败都不会动到任何目标文件。适合跨文件重命名、改接口签名并同步所有引用这类必须一起改才不破坏代码的任务。单个文件的简单改动仍用 edit_file / write_file。',
    parameters: {
      type: 'object',
      properties: {
        patch: {
          type: 'string',
          description: '标准 unified diff 文本（apply_patch 格式），可选。填了它就用这段 diff，忽略 edits。格式：每个文件一个块，以 "--- a/路径" 和 "+++ b/路径" 或 "*** Update File: 路径" 开头，后跟一个或多个 "@@ -旧行号,数量 +新行号,数量 @@" hunk，行首空格=上下文、减号=删除、加号=新增。'
        },
        edits: {
          type: 'array',
          description: '要做的改动列表，按任意顺序。当 patch 文本为空时使用',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '相对工作区的文件路径' },
              op: {
                type: 'string',
                enum: ['create', 'update', 'delete', 'move'],
                description: 'create=新建(需 content)；update=字符串替换(需 old/new)；delete=删除文件；move=移动/重命名(需 new_path)'
              },
              content: { type: 'string', description: 'create 时的完整文件内容' },
              old_string: { type: 'string', description: 'update 时要替换的原文片段' },
              new_string: { type: 'string', description: 'update 时替换后的内容；未给视为删除该片段' },
              replace_all: { type: 'boolean', description: 'update 时是否替换所有匹配，默认 false' },
              new_path: { type: 'string', description: 'move 时的目标相对路径' }
            },
            required: ['path', 'op']
          }
        },
        dry_run: { type: 'boolean', description: '只校验并返回将要发生的改动清单，不写盘。默认 false' }
      }
    }
  },
  {
    name: 'terminal',
    description:
      '常驻交互式终端。run_shell 是「发一条、等它跑完」，遇到要等输入的程序（npm init、vite 的交互提示、ssh、Python REPL）会卡住；' +
      '这里保留一个长期存活的 shell，可以分多次写、分多次读。open 打开会话（同一工作区复用），write 发送输入（需要回车就带 \\n），' +
      'read 读增量（传上次返回的 seq；wait_ms 用来等新输出），close 关闭。不是完整 PTY，vim/top 这类全屏程序不支持。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'write', 'read', 'close', 'list'], description: '要做的操作' },
        shell: { type: 'string', enum: ['cmd', 'powershell', 'bash'], description: 'open 时用哪种 shell，默认 cmd' },
        session_id: { type: 'string', description: '会话 id（open 返回；write/read/close 时必填）' },
        data: { type: 'string', description: 'write 时要发送的内容，例如 "y\\n"' },
        seq: { type: 'number', description: 'read 时上次拿到的 seq，只取这之后的增量；不传则返回最后一段' },
        wait_ms: { type: 'number', description: 'read 时最多等多少毫秒的新输出，默认 0（立刻返回），最多 15000' },
        tail: { type: 'number', description: 'read 不带 seq 时返回最后多少字符，默认 8000' }
      },
      required: ['action']
    }
  },
  {
    name: 'git',
    description:
      '结构化 Git 操作，不用自己拼 git 命令。支持：status / diff / log / branches / checkout / add / commit / push / pull / stash / undo / worktree / pr。' +
      'undo 是 git reset --soft（只退提交、改动保留）；push/pull/pr 会访问网络；pr 需要本机装好并登录 GitHub CLI（gh）。' +
      '改完代码想落一个提交，用 commit；要开分支用 checkout 且 create=true。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'status', 'diff', 'log', 'branches', 'checkout', 'add', 'commit',
            'push', 'pull', 'stash', 'undo', 'worktree', 'pr'
          ],
          description: '要执行的 git 动作'
        },
        paths: { type: 'array', description: 'diff/add/commit 涉及的文件（相对工作区），不填表示全部', items: { type: 'string' } },
        message: { type: 'string', description: 'commit 的提交信息；stash push 时可作为说明' },
        branch: { type: 'string', description: 'checkout / push / pull / worktree add 的分支名' },
        create: { type: 'boolean', description: 'checkout 时是否新建分支；push 时是否设 upstream（默认 true）' },
        remote: { type: 'string', description: 'push / pull 的远端名，默认 origin' },
        steps: { type: 'number', description: 'undo 撤销几个提交，默认 1，最多 5' },
        dir: { type: 'string', description: 'worktree add/remove 的目录' },
        worktree_action: { type: 'string', enum: ['list', 'add', 'remove'], description: 'worktree 的子操作，默认 list' },
        stash_action: { type: 'string', enum: ['push', 'pop', 'list', 'drop'], description: 'stash 的子操作，默认 push' },
        title: { type: 'string', description: 'pr 的标题' },
        body: { type: 'string', description: 'pr 的正文' },
        limit: { type: 'number', description: 'log 返回多少条，默认 15' }
      },
      required: ['action']
    }
  },
  {
    name: 'format',
    description:
      '用项目自带的格式化器整理文件：prettier（js/ts/json/css）、gofmt（go）、ruff format 或 black（python）、rustfmt（rust）。' +
      '只动你指定的文件；项目里没装对应工具就跳过，不会联网安装。lint=true 时顺带跑 eslint / ruff check 报问题（不自动修）。',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', description: '要格式化的文件（相对工作区）', items: { type: 'string' } },
        lint: { type: 'boolean', description: '是否顺便跑 lint，默认 false' },
        docs: { type: 'boolean', description: '是否也格式化 md/html/yaml，默认 false' }
      },
      required: ['paths']
    }
  },
  {
    name: 'repo_map',
    description:
      '查看仓库地图：每个文件都有哪些顶层符号（函数/类/接口/导出）+ 一句话说明。' +
      '先看地图定位到几个文件，再用 read_file / grep 精读，比盲搜省几十倍上下文。' +
      'query 可以用自然语言描述你要找的东西（例如「登录是怎么校验的」「模型下载的断点续传在哪」），' +
      '程序会用本地 embedding 做语义检索并按相关度排序；没有 embedding 服务时自动退回关键词匹配。' +
      'path 只看某个子目录，refresh=true 强制重扫（默认增量更新）。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，例如「provider 配置」或「auth login」' },
        path: { type: 'string', description: '只看这个子目录（相对工作区）' },
        limit: { type: 'number', description: '最多列多少个文件，默认 120，上限 400' },
        summary: { type: 'boolean', description: '是否带每个文件的一句话说明，默认 true' },
        refresh: { type: 'boolean', description: '强制全量重建索引，默认 false（按 mtime 增量）' }
      }
    }
  },
  {
    name: 'use_skill',
    description:
      '取一个「已开启自动调用」的技能的完整做法，然后照着做。只在系统提示的「可调用技能」里列出了它、且当前任务确实对得上时才用；名字填技能名。' +
      '技能里通常包含具体步骤、脚本路径和注意事项，比你自己摸一遍更快也更稳，但不要凭技能名猜内容——必须真的取到再执行。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名，从系统提示的「可调用技能」里选' }
      },
      required: ['name']
    }
  },
  {
    name: 'write_plan',
    description:
      '在「计划模式」下产出执行计划。写完程序会把计划显示给用户，用户点「批准执行」之后你才有写文件和跑命令的权限。' +
      '计划要具体到文件与动作（改哪个文件、加什么函数、跑什么命令），不要写「优化代码」这类空话。' +
      '不在计划模式时调用它也能用，但不会解锁任何权限。',
    parameters: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: '完整的计划正文（Markdown），分步骤写清楚' },
        steps: {
          type: 'array',
          description: '步骤清单，每条一句话；会显示成可勾选的待办',
          items: { type: 'string' }
        }
      },
      required: ['plan']
    }
  }
]

/**
 * 工具网关。
 *
 * 25 个工具的 JSON Schema 加起来约 4900 tokens —— 在 16K 窗口的本地模型上，
 * 光「工具说明书」就吃掉三成窗口，而且工具越多小模型越容易挑错。
 * 上下文紧张时只直接下发常用的十来个，其余通过这个网关调用：
 * 不带 tool 参数返回清单，带了就在执行前展开成真工具（风险、审批、钩子都按真名走）。
 *
 * 它本身不进 toolSpecs：只有真的藏了工具时才下发，否则白占一百多 token。
 */
export const TOOLBOX_SPEC: ToolSpec = {
  name: 'toolbox',
  description:
    '调用本轮没有直接列出的工具（例如 git、terminal、board、handoff、格式化等）。' +
    '不带 tool 参数时返回可用工具的清单；带 tool 时按该工具的参数调用（args 与直接调用完全一样）。',
  parameters: {
    type: 'object',
    properties: {
      tool: { type: 'string', description: '要调用的工具名，例如 git' },
      args: { type: 'object', description: '该工具的参数对象，和直接调用时一样' }
    }
  }
}

export function toolSpecByName(name: string): ToolSpec | undefined {
  if (name === TOOLBOX_SPEC.name) return TOOLBOX_SPEC
  return toolSpecs.find((t) => t.name === name)
}
