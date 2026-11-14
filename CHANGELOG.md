# 更新日志

本文件记录用户可感知的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

版本号是唯一事实来源：`package.json` 的 `version` 决定打包产物名与 Release tag（`v<版本>`），
主进程的 MCP `clientInfo.version` 也从这里读取，不再手写。

## [0.1.3] - 2026-11-14

### 变更

- **运行数据改存用户数据目录**：llama.cpp 运行库、GGUF 模型与简易核心默认落在用户数据目录，
  包管理器升级（winget 会换安装子目录）不再导致已下载的模型和 CUDA 运行库失效。
  需要「模型跟 exe 放一起」的 U 盘用法设 `ROROTO_PORTABLE=1`，自定义位置设 `ROROTO_DATA_DIR`。
  老便携版用户在旧位置已有的数据会被自动识别并继续沿用，不需要重新下载。
- **发布流程自动化**：推送 `v*` tag 触发构建、跑三道门禁、打 portable 与 NSIS 安装器、
  从真实产物现算 SHA256、生成 Release 文案与 winget 清单，再创建 Release。
  哈希不再由人手抄——v0.1.2 的 Release 文案就因为手抄与真实文件不一致而校验失败。
- **MCP 客户端版本号**改为读取 `app.getVersion()`，与 `package.json` 同步。

### 新增

- winget 清单（`packaging/winget/`）：三文件模板 + 零依赖渲染脚本，`winget validate` 通过。
  清单进入 `microsoft/winget-pkgs` 后可用 `winget install RoRoToCode.RoRoToCode` 安装。
- 打包产物旁输出 `.sha256` 校验文件，便于用户与包管理器核对。
- 单测 462 项（新增数据目录解析 9 项）。

### 安装

```powershell
# 便携版（免安装）
# 从 Releases 下载 RoRoToCode-0.1.3-portable.exe

# 安装向导（可选安装目录）
# 从 Releases 下载 RoRoToCode-0.1.3-setup.exe

# winget（清单通过社区仓库审核后可用）
winget install RoRoToCode.RoRoToCode
```

## [0.1.2] - 2026-11-11

首个公开发布。便携版单文件 exe，Windows 10/11。

> 该版本 Release 文案里的 SHA256 与实际资产不一致（文案为 `f1e29218…`，实际 `fbf69a83…`），
> 校验请以 GitHub API 返回的 asset digest 或本地 `Get-FileHash` 结果为准。0.1.3 起改为现算，不再出现此问题。

[0.1.3]: https://github.com/RoRoToCode/RoRoToCode/releases/tag/v0.1.3
[0.1.2]: https://github.com/RoRoToCode/RoRoToCode/releases/tag/v0.1.2
