/**
 * 离线技能的依赖清单与报告生成（纯数据 + 纯函数，不碰子进程，方便单测）。
 *
 * 为什么要有它：技能面板里的「读 PDF / 写 Word / 整理 Excel / 做 PPT / 图片处理」
 * 都是让模型用 Python 脚本干活，指令里写着「缺什么就 pip install」。
 * 但本地模型经常把这句当成背景说明略过，跑一半才报 ModuleNotFoundError，
 * 用户看到的就是「技能装了、开关开了、还是干不成」。
 * 与其靠提示词，不如装之前先替用户查一次，缺什么直接给出一行可复制的命令。
 */

export interface DepModule {
  /** pip 包名 */
  pip: string
  /** import 时用的模块名（Pillow → PIL、python-docx → docx，不一样） */
  mod: string
}

export interface SkillDepSpec {
  /** 与 skillhub.ts 里 OFFLINE 技能同名，别改 */
  skill: string
  modules: DepModule[]
  note?: string
}

export const SKILL_DEPS: SkillDepSpec[] = [
  {
    skill: '读取 PDF',
    modules: [
      { pip: 'pypdf', mod: 'pypdf' },
      { pip: 'pdfplumber', mod: 'pdfplumber' }
    ],
    note: '扫描件 OCR 另需本机装 tesseract / paddleocr，属可选'
  },
  {
    skill: '图片处理',
    modules: [{ pip: 'Pillow', mod: 'PIL' }]
  },
  {
    skill: '写 / 改 Word',
    modules: [{ pip: 'python-docx', mod: 'docx' }],
    note: '转 PDF 优先用本机 Word / WPS，没装才考虑 LibreOffice'
  },
  {
    skill: '整理 Excel',
    modules: [
      { pip: 'pandas', mod: 'pandas' },
      { pip: 'openpyxl', mod: 'openpyxl' }
    ]
  },
  {
    skill: '做 PPT',
    modules: [{ pip: 'python-pptx', mod: 'pptx' }]
  },
  {
    skill: '文件归档整理',
    modules: [],
    note: '只用标准库，不需要额外安装'
  }
]

export interface SkillDepItem {
  skill: string
  ok: boolean
  /** 缺的 pip 包名 */
  missing: string[]
  note?: string
}

export interface SkillDepReport {
  ok: boolean
  /** 能用的 python 命令（python / py / python3），没装就是 null */
  python: string | null
  version: string
  items: SkillDepItem[]
  /** 一次补齐所有缺失包的命令；不缺就是空串 */
  installCmd: string
  message: string
}

export function allModules(): string[] {
  return [...new Set(SKILL_DEPS.flatMap((s) => s.modules.map((m) => m.mod)))]
}

export function buildInstallCommand(missing: string[], python: string | null): string {
  const pkgs = [...new Set(missing)].filter(Boolean)
  if (!pkgs.length || !python) return ''
  return `${python} -m pip install ${pkgs.join(' ')}`
}

/** 把「哪些 import 找得到」翻译成人能看懂的报告。主进程负责探测，这里只做判定 */
export function summarizeDeps(
  python: string | null,
  version: string,
  found: Record<string, boolean>
): SkillDepReport {
  if (!python) {
    return {
      ok: false,
      python: null,
      version: '',
      items: SKILL_DEPS.map((s) => ({
        skill: s.skill,
        ok: false,
        missing: s.modules.map((m) => m.pip),
        note: s.note
      })),
      installCmd: '',
      message: '本机没找到可用的 Python。装一个 Python 3.9+ （Windows 记得勾选 Add to PATH），再来检查一次。'
    }
  }

  const items: SkillDepItem[] = SKILL_DEPS.map((s) => {
    const missing = s.modules.filter((m) => found[m.mod] !== true).map((m) => m.pip)
    return { skill: s.skill, ok: missing.length === 0, missing, note: s.note }
  })
  const allMissing = items.flatMap((i) => i.missing)
  const installCmd = buildInstallCommand(allMissing, python)
  const ok = allMissing.length === 0

  return {
    ok,
    python,
    version,
    items,
    installCmd,
    message: ok
      ? `${version}：6 个离线技能的依赖都齐了，可以直接装来用。`
      : `${version}：还缺 ${new Set(allMissing).size} 个包。可在终端跑一次下面的命令补齐，或在技能里让 agent 自己装。`
  }
}
