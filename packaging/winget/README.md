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
# 端到端（需能访问 GitHub Release，中国大陆常失败）：
winget install --manifest packaging\winget\0.1.3
```

`validate` 只查 schema 和字段一致性。winget-pkgs 的 CI 还会下载 installer、校验 SHA256、在 Windows Sandbox 里装一遍。

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

## 中国大陆网络

本机直连 GitHub Release 下载失败（TLS 握手超时），所以没跑 `winget install --manifest` 的端到端验证。
请在能访问的网络环境复核哈希并实装一次再提 PR；主 README 也保留了「手动下载 exe」的兜底路径。
