/**
 * 本地运行时的下载地址清单：每个运行时都给「官方 + 内地镜像 + 备用镜像」多条，
 * 不同地区/不同网络能挑一条通的用。渲染层只负责展示，主进程下载时也按这个顺序回退。
 */

export type DownloadTag = 'official' | 'cn' | 'global'

export interface DownloadSource {
  label: string
  url: string
  /** 这条链接给的是什么、什么时候该用它 */
  note: string
  tag: DownloadTag
}

export interface DownloadGuide {
  title: string
  /** 一段总说明 */
  hint: string
  sources: DownloadSource[]
  /** 顺带告诉用户模型去哪下（可选） */
  models?: DownloadSource[]
}

export const DOWNLOAD_TAG_LABEL: Record<DownloadTag, string> = {
  official: '官方',
  cn: '内地镜像',
  global: '海外'
}

const HF_MIRROR: DownloadSource = {
  label: 'Hugging Face 国内镜像（hf-mirror）',
  url: 'https://hf-mirror.com/models?search=gguf',
  note: '官方站打不开时用这个下 .gguf，速度和域名都友好',
  tag: 'cn'
}

const MODELSCOPE: DownloadSource = {
  label: '魔搭 ModelScope（GGUF）',
  url: 'https://modelscope.cn/models?search=gguf',
  note: '国内站，Qwen / DeepSeek 等中文模型齐全',
  tag: 'cn'
}

const HF_OFFICIAL: DownloadSource = {
  label: 'Hugging Face 官方站（GGUF）',
  url: 'https://huggingface.co/models?library=gguf',
  note: '模型最全；需要能直连海外',
  tag: 'global'
}

/** 境外能否直连 GitHub 不稳定，所以每条 GitHub 资源都配了加速前缀镜像 */
const GH = 'https://github.com/ggml-org/llama.cpp'
const OLLAMA_GH = 'https://github.com/ollama/ollama'

export const DOWNLOAD_GUIDES: Record<'llama' | 'ollama' | 'lmstudio', DownloadGuide> = {
  llama: {
    title: 'llama.cpp 下载地址（官方 + 4 条镜像）',
    hint: '官方包在 GitHub 上，内地经常连不上或断流。任意一条能打开就行，下完解压到软件根目录的 llama.cpp/ 里，或直接点「一键安装 / 下载」让它自己挑一条通的。',
    sources: [
      {
        label: 'GitHub 官方 Releases（推荐海外）',
        url: `${GH}/releases/latest`,
        note: '页面里找 llama-b<版本号>-bin-win-cuda-12.4-x64.zip（N 卡）或 -bin-win-cpu-x64.zip（纯 CPU）',
        tag: 'official'
      },
      {
        label: 'gh-proxy 镜像（推荐内地）',
        url: `https://gh-proxy.com/${GH}/releases/latest`,
        note: '和官方页面完全一样，下载走加速；一键安装优先用它',
        tag: 'cn'
      },
      {
        label: 'ghproxy.net 镜像',
        url: `https://ghproxy.net/${GH}/releases/latest`,
        note: '内地备用，gh-proxy 抽风时换它',
        tag: 'cn'
      },
      {
        label: 'ghfast.top 镜像',
        url: `https://ghfast.top/${GH}/releases/latest`,
        note: '第二条备用镜像，个别地区不通就往前换',
        tag: 'cn'
      },
      {
        label: '官方编译说明（想自己编）',
        url: `${GH}/blob/master/docs/build.md`,
        note: '有 VS / CMake 环境时可直接编译，不依赖发布包',
        tag: 'official'
      }
    ],
    models: [HF_MIRROR, MODELSCOPE, HF_OFFICIAL]
  },
  ollama: {
    title: 'Ollama 下载地址（官方 + 2 条镜像）',
    hint: '官方安装包直链在内地有时会中途断掉。下面两个 GitHub 镜像下的是同一个官方安装包（永远指向最新版），下载失败就换一条。',
    sources: [
      {
        label: '官方 Windows 下载页',
        url: 'https://ollama.com/download/windows',
        note: '最稳的入口，会自动匹配系统',
        tag: 'official'
      },
      {
        label: '官方安装包直链',
        url: 'https://ollama.com/download/OllamaSetup.exe',
        note: '「一键安装 / 下载」默认用它；断流就换下面两条',
        tag: 'official'
      },
      {
        label: 'gh-proxy 镜像 · 官方安装包',
        url: `https://gh-proxy.com/${OLLAMA_GH}/releases/latest/download/OllamaSetup.exe`,
        note: '内地推荐，内容和官方一致（最新版）',
        tag: 'cn'
      },
      {
        label: 'ghproxy.net 镜像 · 官方安装包',
        url: `https://ghproxy.net/${OLLAMA_GH}/releases/latest/download/OllamaSetup.exe`,
        note: '备用镜像，第一条不通用它',
        tag: 'cn'
      },
      {
        label: 'GitHub Releases（历史版本）',
        url: `${OLLAMA_GH}/releases`,
        note: '需要固定某个旧版本时在这找',
        tag: 'official'
      }
    ],
    models: [
      {
        label: 'Ollama 官方模型库',
        url: 'https://ollama.com/library',
        note: '拉到本地用「ollama pull 模型名」，如 qwen2.5-coder:7b',
        tag: 'official'
      },
      HF_MIRROR,
      MODELSCOPE
    ]
  },
  lmstudio: {
    title: 'LM Studio 下载地址',
    hint: '新版安装包已改名 Bionic（约 780 MB），官方没有国内镜像。第一条「一键安装 / 下载」用的就是 latest 直链；这条不通时可改用 winget 自动安装，或直接把安装包地址粘到浏览器/下载器里。',
    sources: [
      {
        label: '官方直链（latest，安装包为 Bionic）',
        url: 'https://lmstudio.ai/download/bionic/latest/win32/x64',
        note: '会 302 到当前版本的 CDN 直链，「一键安装 / 下载」默认用它；支持断点续传，可交给 IDM/迅雷',
        tag: 'official'
      },
      {
        label: '官方安装包 CDN',
        url: 'https://bionic-installers.lmstudio.ai/win32/x64/1.1.10-8/Bionic-1.1.10-8-x64.exe',
        note: '固定版本直链（1.1.10-8），latest 那条解析不出来时用它',
        tag: 'official'
      },
      {
        label: '官方下载页',
        url: 'https://lmstudio.ai/download',
        note: '会自动识别系统并给出对应安装包',
        tag: 'official'
      },
      {
        label: '官方文档 · Local Server',
        url: 'https://lmstudio.ai/docs/app/api/endpoints/openai',
        note: '怎么开 1234 端口的本地服务，看这一页',
        tag: 'official'
      }
    ],
    models: [HF_MIRROR, MODELSCOPE, HF_OFFICIAL]
  }
}
