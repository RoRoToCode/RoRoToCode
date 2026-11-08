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
  }
]

export function toolSpecByName(name: string): ToolSpec | undefined {
  return toolSpecs.find((t) => t.name === name)
}
