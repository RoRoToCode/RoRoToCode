# winget 清单

包标识 `RoRoToCode.RoRoToCode`，合并后安装命令：`winget install RoRoToCode.RoRoToCode`。

```
packaging/winget/
  template/          三文件模板，含 __VERSION__ / __URL__ / __SHA256__ 占位
  render.mjs         零依赖渲染脚本：从真实 exe 现算 SHA256，生成版本化清单
  0.1.2/             已通过 winget validate 的清单，对应 GitHub 上唯一已发布的 Release
  0.1.3/             打包 0.1.3 后由 render.mjs 生成（见下）
  README.md
```

## 出一份新清单

```powershell
npm run dist                                  # 产出 release/RoRoToCode-0.1.3-portable.exe 和 .sha256
node packaging/winget/render.mjs              # 版本取自 package.json，哈希从 exe 现算
winget validate --manifest packaging/winget/0.1.3
```

CI 里由 `.github/workflows/release.yml` 自动完成这三步，并把清单作为 artifact 归档。
如果本机没有 exe、但已知发布资产的哈希，用 `--sha256 <64位hex>`；URL 不在默认仓库时用 `--url <直链>`。

**不要在模板或生成后的清单里手抄哈希** —— v0.1.2 的 Release 文案就是这么写错的。
另外 CI 重新打包的 exe 与本机产物字节可能不同：提 PR 前，一定要用 **GitHub 上实际发布的那份资产**重算哈希，
用 `release.yml` 归档的 `winget-manifests-<版本>` artifact，别直接拿本地清单（详见 `GITHUB-UPDATE.md`）。

## 本地验证

```powershell
winget validate --manifest packaging\winget\0.1.3
# 端到端：
winget install --manifest packaging\winget\0.1.3
```

`validate` 只查 schema 和字段一致性。winget-pkgs 的 CI 还会下载 installer、校验 SHA256、在 Windows Sandbox 里装一遍。

**`--manifest` 本地安装默认是关着的**（安全策略所致，与清单内容无关）。直接跑会提示：

```
此功能需要由管理员启用。若要启用它，请以管理员身份运行 "winget settings --enable LocalManifestFiles"
```

要以管理员身份开一次（写进 `%LOCALAPPDATA%\Packages\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe\LocalState\settings.json`），
之后 `winget install --manifest` 才可用。`winget validate` 不需要这个开关。

**2026-11-14 端到端验证通过**（本机 winget v1.29.380）：

```
已找到 RoRoTo Code [RoRoToCode.RoRoToCode] 版本 0.1.3
正在下载 .../RoRoToCode-0.1.3-portable.exe    65.5 MB / 65.5 MB
已成功验证安装程序哈希
添加了命令行别名： "rorotocode"
已成功安装
```

落盘结果：`%LOCALAPPDATA%\Microsoft\WinGet\Packages\RoRoToCode.RoRoToCode__DefaultSource\rorotocode.exe`（65.6 MB），
`WinGet\Links\rorotocode.exe` 是指向它的符号链接，`winget list` 显示 `0.1.3`。

顺带确认了 `Commands: rorotocode` 的实际效果：winget 会把 exe 重命名为 `rorotocode.exe` 并建别名，
不是空声明。程序数据仍落在 userData（`datadir.ts` 的默认分支），换版本不会丢模型。

## 提交到 winget-pkgs（第一次必须手工）

1. fork `microsoft/winget-pkgs`；
2. 把版本目录复制到 `manifests/r/RoRoToCode/RoRoToCode/<版本>/`（分区目录取标识首字母小写 `r`）；
3. 提 PR，等自动校验 + 版主审核；
4. 或用 `wingetcreate submit packaging\winget\<版本>`（需 PAT）。

首个版本合并后，后续可用 `winget-releaser` 自动开 PR。注意：这类自动更新工具只能改版本号/URL/哈希，
**换不了 installer 类型**，首次提交时把结构选对。完整发布与提交步骤见 `packaging/GITHUB-UPDATE.md`。

## 已知前置项

- **v0.1.2 Release 文案哈希错误**：文案写 `f1e29218…`，GitHub asset digest 是
  `fbf69a83db5f0890f942613b123412527a149c21c2498def18b6e11c96e516e2`（`0.1.2/` 清单用的是后者）。
  修正文案见 `packaging/release-notes-v0.1.2-fixed.md` 和 `GITHUB-UPDATE.md` 第 2 步。
- **数据落盘**：已修。`src/shared/datadir.ts` 让 llama.cpp / 模型 / 简易核心默认落在 userData，
  包管理器升级换目录不再丢模型；老便携版已有数据自动沿用旧位置，`ROROTO_PORTABLE=1` 可强制跟 exe 走。
- **CI 自动发版**：已加 `release.yml`，tag `v*` 触发，哈希全部现算。推送到 GitHub 后才生效。

## installer 类型选型（重要）

当前清单用 `InstallerType: portable` 直接指向单个 exe。winget 会把它放进 Packages 目录并在
`WinGet\Links` 建符号链接；对「依赖同目录 DLL / 会往自身目录写数据」的程序，这是已知风险点
（数据落盘已修，主要剩符号链接这一条）。winget-pkgs 若因此打回，二选一：

**A. 改成 zip（推荐，schema 1.9.0+）** —— Release 额外上传一个含 exe 的 zip：

```yaml
InstallerType: zip
NestedInstallerType: portable
NestedInstallerFiles:
  - RelativeFilePath: RoRoToCode-0.1.3-portable.exe
    PortableCommandAlias: rorotocode
ArchiveBinariesDependOnPath: true
ManifestVersion: 1.9.0
```

`ArchiveBinariesDependOnPath` 让 winget 把真实安装目录加入 PATH 而不建 symlink，exe 能找到同目录依赖。

**B. 出 NSIS 安装器**（`npm run dist:installer`，配置已在 package.json）：改用
`InstallerType: nullsoft` + `InstallerSwitches: Silent: /S, SilentWithProgress: /S`，安装位置稳定。

改类型要同步改 `template/`，因为后续版本都由它渲染。

## 当前提交状态（2026-11-14）

- PR：https://github.com/microsoft/winget-pkgs/pull/479989 ，标题 `RoRoToCode.RoRoToCode version 0.1.3`，
  标签 `New-Package`，3 个文件 / +54 行，`mergeable: true`。
- **自动化全部通过**：`license/cla` → `success（All CLA requirements met）`；
  标签 `Validation-Completed` 与 `Azure-Pipeline-Passed` 均已打上。
- **只差版主人工审核**。机器人 07:52 留言：「check-in policies require a moderator to approve PRs from
  the community」，版主是社区志愿者，耐心等，别反复催。
- 合并前 `winget search` / `winget show` 一律返回 `NO_APPLICATIONS_FOUND`，`manifests/r/RoRoToCode` 是 404 —— 这是正常的，
  清单只在合并后进 master，之后 winget 客户端才能查到。
- 小瑕疵：`@microsoft-github-policy-service agree` 误发了两条（08:10:43 / 08:10:57），不影响结果，
  想清理可 `gh api -X DELETE /repos/microsoft/winget-pkgs/issues/comments/6874344064`。

## 提交路径（本机已装 gh）

`wingetcreate` 在 winget 源里就有，它会自己 fork 仓库、复制清单、开 PR。token 不用另建 PAT，
直接复用 `gh` 的登录凭据：

```cmd
winget install --id Microsoft.WingetCreate -e

:: 取 gh 当前 token（含 repo 权限，够 fork + 开 PR）
for /f %i in ('gh auth token') do set GHTOKEN=%i

wingetcreate submit F:\RoRoToCode\packaging\winget\0.1.3 --token %GHTOKEN%
```

不想给 token 就走网页，三个文件手拖：

1. fork `microsoft/winget-pkgs`；
2. 在新仓库里依次 `manifests` → `r` → `RoRoToCode` → `RoRoToCode` → 新建 `0.1.3` 目录；
3. 把 `packaging\winget\0.1.3\` 下三个 yaml 拖进去，commit；
4. 回原仓库点 `Contribute` → `Open pull request`。

## 中国大陆网络

2026-11-14 复测：GitHub Release 资产已可正常下载（96 字节的 `.sha256` 与 66 MB 的 exe 都能取），
上传/下载不再是障碍。唯一的阻塞是 `LocalManifestFiles` 策略，见上面「本地验证」。
