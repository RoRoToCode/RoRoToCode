## 是什么

RoRoTo Code 是 Windows 上的本地 coding agent，把 llama.cpp / GGUF 从「能跑起来」做到「能当 coding agent 稳定用」：按这台机器判断该用哪个模型、开多大上下文、还够跑几轮，并把启动失败、崩溃、复读、坏参数这些本地模型特有的坑整条收敛掉。

## 下载

| 文件 | 大小 | SHA256 |
|---|---|---|
| RoRoToCode-0.1.3-portable.exe | 65.6 MB | `ebf6b4fe59680dab1db6770ae01bc6c134eea3d322cadc23afd3ed69fce003b8` |

便携版免安装，双击即用；首次使用会自动下载 llama.cpp 与所选 GGUF 模型。

已上架 winget 后可直接：`winget install RoRoToCode.RoRoToCode`（首个版本需先通过社区仓库审核）。

## 本版本变更

- llama.cpp 运行库、GGUF 模型与简易核心默认改存到用户数据目录，包管理器升级不再丢失已下载的模型；需要「模型跟 exe 放一起」时设 `ROROTO_PORTABLE=1`，自定义位置设 `ROROTO_DATA_DIR`。
- 发布流程自动化：tag 触发构建、打包、现算哈希并生成 Release 文案与 winget 清单。

## 要求

Windows 10/11。运行时会下载 llama.cpp、NVIDIA CUDA / cuBLAS / cudart 及 GGUF 模型等第三方组件，各自适用其许可（详见仓库 README）。

## 验证

`npm test`、`npm run typecheck`、`npm run lint` 全过；winget 清单经 `winget validate` 校验。
