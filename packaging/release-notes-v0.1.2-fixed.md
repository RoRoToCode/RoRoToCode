## 是什么

RoRoTo Code 是 Windows 上的本地 coding agent，把 llama.cpp / GGUF 从「能跑起来」做到「能当 coding agent 稳定用」：按这台机器判断该用哪个模型、开多大上下文、还够跑几轮，并把启动失败、崩溃、复读、坏参数这些本地模型特有的坑整条收敛掉。

## 本版本亮点

- **GGUF 显存体检**：读真实文件头（不按参数量估），给出档位建议、建议上下文、预估 tok/s 与 agent 余量
- **显卡后端自证**：三层探测选 CUDA / Vulkan / CPU，装完和启动前各跑一次 `--list-devices`，缺运行库直接点名，不再「假装 GPU」
- **上下文探测链**：体检建议 → 起一次量一次 → 带环境指纹落盘，超预算自动转部分卸载
- **小模型护栏**：坏 JSON 三层修复、截断不落盘、防复读流式熔断、重复动作护栏、思考预算封顶

## 下载

| 文件 | 大小 | SHA256 |
|---|---|---|
| RoRoToCode-0.1.2-portable.exe | 65.5 MB | `fbf69a83db5f0890f942613b123412527a149c21c2498def18b6e11c96e516e2` |

> 修正说明：本页初版把 SHA256 误写为 `f1e29218…`，与 GitHub 实际存储的文件不符。正确值取自 GitHub Release asset digest，请用上表校验。

便携版免安装，双击即用；首次使用会自动下载 llama.cpp 与所选 GGUF 模型。

## 要求

Windows 10/11。运行时会下载 llama.cpp、NVIDIA CUDA / cuBLAS / cudart 及 GGUF 模型等第三方组件，各自适用其许可（详见仓库 README）。

## 验证

`npm test` 442 项全过，`typecheck` 与 `lint` 零报错。
