# GitHub 更新准备

> 这一页是「要执行的动作清单」。推送、发布 Release、提 winget-pkgs PR 都是公开的外部操作，
> 需要仓库凭据，本次没有代为执行，命令整理在这里可直接复制。

## 当前实际状态（2026-11-14 核对）

| 项 | 状态 |
|---|---|
| 本地仓库 | `main` 分支，**6 个提交，从未推送**；88 个已跟踪文件改动 + 128 个未跟踪文件（全是源码） |
| git remote | **已配置** `origin → RoRoToCode/RoRoToCode.git`（重复执行 `git remote add` 会报 already exists，属正常） |
| 本地 / 远端历史 | **完全不同源**：本地根提交 `56a0c4b`，远端根提交 `f325e9c`，无共同祖先 |
| `gh` CLI / `GITHUB_TOKEN` | 本机都没有；但 `credential.helper=manager` 已配，HTTPS 推送会弹浏览器登录 |
| 本机 git 访问 github.com | schannel `CRYPT_E_NO_REVOCATION_CHECK` —— 证书吊销列表拉不到（大陆网络常见） |
| GitHub 上的 Release | 只有 `v0.1.2` 一个，资产 `RoRoToCode-0.1.2-portable.exe` |
| v0.1.2 Release 文案 | SHA256 **写错了**（`f1e29218…`），实际是 `fbf69a83…` |
| CI | `ci.yml` 只跑 typecheck / lint / test；`release.yml` 本次新增，尚未推送生效 |

`.gitignore` 已保护 `release/`、`*.gguf`、`docs/`、`.workbuddy/`，`git add -A` 不会把几 GB 模型或本地笔记带上去。

## 第 1 步：把仓库接上 GitHub（一次性）

remote 已经配好，不用再 `add`。**真正的障碍是历史不同源**：本地 `main` 的 6 个提交和远端
`main` 的 2 个提交（`Initial commit`、`Add CONTRIBUTING, issue/PR templates, and SECURITY policy`）
没有共同祖先，直接 `git push` 会被拒（`non-fast-forward`）。

两条路，二选一：

**A. 以本地历史为准，覆盖远端 `main`（推荐）**

远端那两个提交只是 GitHub 建仓时的骨架，内容（CONTRIBUTING / SECURITY / issue 模板）本地都有，
只是尚未提交。`v0.1.2` 的 tag 指向 `c4d83b1`，**强推分支不影响 tag 和已有 Release**。

```powershell
cd F:\RoRoToCode
git branch backup-before-push        # 先留一份本地保险
git add -A
git commit -m "chore: v0.1.3 发布准备——数据落盘、winget 清单、自动发版"
git fetch origin                     # 必须：--force-with-lease 要有比对基准
git push -u origin main --force-with-lease
```

> **2026-11-14 进度**：前三步已在本机执行完毕——`backup-before-push` 分支已建，
> 全部改动已合并为单个提交（246 个文件，`chore: 同步工作区到 GitHub——0.1.3 发布准备、
> 数据落盘改造与自动发版`），工作区已无未提交内容。剩下的只有 `git fetch` + `git push`。
> 若要回退这次提交：`git reset --soft HEAD~1`（改动退回暂存区，不丢文件）。

`--force-with-lease` 比 `--force` 安全：万一远端被别人推过，它会拒绝而不是直接覆盖。
它依赖 `refs/remotes/origin/main` 作为「远端应该是什么」的基准，**从没 fetch 过就会报 `stale info` 拒绝**。
若 `git fetch` 因为网络不通失败，可以改用写死 sha 的形式（远端 main 在 2026-11-14 核对为 `c4d83b1`）：

```powershell
git push -u origin main --force-with-lease=main:c4d83b142eed5f3d08efbfd4dc70fca22839c1fe
```

**B. 保留远端历史，做一次合并（历史更完整，但会有大量冲突）**

两个根提交各自都加过同一批文件，`--allow-unrelated-histories` 合起来大概率每个文件都冲突，
需要逐个 `-X ours` 或手工解：

```powershell
git fetch origin
git merge origin/main --allow-unrelated-histories -X ours
git push -u origin main
```

> 网络不通时先关掉 schannel 吊销检查（大陆网络拉不到 CRL，会报 `CRYPT_E_NO_REVOCATION_CHECK`）：
> `git config --global http.schannelCheckRevoke false`
> 代价是不校验证书吊销状态，内网/代理环境常见做法；能配代理的话优先用代理。

## 第 2 步：修正 v0.1.2 的 Release 文案

已有改好的文案 `packaging/release-notes-v0.1.2-fixed.md`（只把哈希改成正确值并加了勘误说明）。

```powershell
# 装了 gh 并登录后：
gh release edit v0.1.2 --repo RoRoToCode/RoRoToCode --notes-file packaging/release-notes-v0.1.2-fixed.md
```

没有 gh 时也可以在网页上编辑 Release，把「下载」表格里的 SHA256 换成
`fbf69a83db5f0890f942613b123412527a149c21c2498def18b6e11c96e516e2`。
**这一步影响 winget 首个版本的审核**：哈希对不上，社区仓库的 CI 会直接打回。

## 第 3 步：发 v0.1.3

`package.json` 已是 `0.1.3`，`release.yml` 会在 tag 推送后自动完成构建、三道校验、打 portable + NSIS、
现算 SHA256、生成 Release 文案和 winget 清单、上传资产。

```powershell
git tag v0.1.3
git push origin v0.1.3
```

或在 Actions 页面手动跑 `Release`（workflow_dispatch），版本取自 `package.json`。
发布完成后到 `Actions` 看运行结果，并确认 Release 里的 exe、`.sha256`、`RELEASE_NOTES.md` 都在。

手动兜底（CI 没跑通时）：

```powershell
npm ci; npm test; npm run typecheck; npm run lint
npm run dist                 # portable exe + .sha256
npm run dist:installer       # NSIS → RoRoToCode-0.1.3-setup.exe
node packaging/make-release-notes.mjs
node packaging/winget/render.mjs
winget validate --manifest packaging/winget/0.1.3
gh release create v0.1.3 `
  release/RoRoToCode-0.1.3-portable.exe `
  release/RoRoToCode-0.1.3-portable.exe.sha256 `
  release/RoRoToCode-0.1.3-setup.exe `
  --title v0.1.3 --notes-file release/RELEASE_NOTES.md
```

> `package.json` 的 `nsis.artifactName` 已定为 `RoRoToCode-${version}-setup.exe`。electron-builder
> 默认产物名是 `RoRoTo Code Setup 0.1.3.exe`（带空格），在 URL、清单和脚本里都容易踩坑，所以统一成无空格。
> 2026-11-14 实测：本机 `npm run dist:installer` 33 秒出包，`release/win-unpacked/` 与 `.blockmap`
> 不会被 `gh` 上传（只传 `*.exe` 和 `*.sha256`），无 `__uninstaller-*` 残留。

## 第 4 步：winget 首个版本（手工，只做一次）

`packaging/winget/0.1.2/` 是已经通过 `winget validate` 的三文件清单，对应 GitHub 上唯一真实存在的 Release。
先用它把包「注册」进社区仓库：

1. fork `microsoft/winget-pkgs`；
2. 复制 `0.1.2/` 到 `manifests/r/RoRoToCode/RoRoToCode/0.1.2/`；
3. 提 PR，等自动校验 + 版主审核；
4. 合并后 `winget source update`，`winget search RoRoToCode` 能看到包。

> 想让首个版本就是 0.1.3，也可以等第 3 步发布完成后改用 `packaging/winget/0.1.3/`，
> 但清单里的 URL 必须指向一个**已经存在**的 Release，否则 CI 下载 404。

## 第 5 步：后续自动更新（可选）

首个版本合并后，再接自动更新工具（它只能更新已有包，不能创建）：

- 创建 classic PAT（`public_repo`），存为仓库 secret `WINGET_TOKEN`；
- 在 `release.yml` 末尾加一个 `vedantmgoyal9/winget-releaser` 步骤，`release: [published]` 触发，
  自动用新版本 URL / 哈希向 winget-pkgs 开 PR；
- 注意该工具**换不了 installer 类型**：如果以后从 portable 单 exe 改成 zip 或 NSIS，仍需手工提一次 PR。

## 重要：哈希以「实际发布的那个 exe」为准

`packaging/winget/0.1.3/` 和 `packaging/release-notes-v0.1.3.md` 是按**本机**打出的 exe 生成的
（SHA256 `ebf6b4fe59680dab1db6770ae01bc6c134eea3d322cadc23afd3ed69fce003b8`）。
CI 在不同机器上重新打包，产物字节可能不同，哈希也会变 —— 这是正常的，不要手抄本机哈希去提 PR。

- 走 CI 发布：`release.yml` 会重新渲染清单并把哈希写进 Release 文案，用那次归档的 `winget-manifests-0.1.3` artifact。
- 手动发布本机 exe：用 `0.1.3/` 当前清单即可，但要确保 GitHub 上的资产就是本机这个文件。
- 提 winget PR 前，务必对 Release 里真实资产跑一次 `winget hash` / `Get-FileHash` 复核。

## 本次补齐的文件（2026-11-14）

推送前本地工作区缺的标准工程文件已补上，全部零依赖、不影响构建：

| 文件 | 作用 |
|---|---|
| `CHANGELOG.md` | 从 0.1.2 起的用户可见变更，含 v0.1.2 哈希勘误说明与安装方式 |
| `.editorconfig` | 与 `.gitattributes` 对齐（LF / UTF-8 / 2 空格；`*.md` 不删行尾空格，`*.{cmd,bat}` 用 CRLF） |
| `.nvmrc` | `22`，和 `package.json` 的 `engines`、CI 的 Node 版本一致 |
| `.github/dependabot.yml` | npm 月度（小版本合并成一个 PR，electron 大版本不自动合）、vramfit 独立目录、actions 季度 |
| `.github/ISSUE_TEMPLATE/feature_request.md` | 与既有 `bug_report.md` 同结构，要求填显卡/模型/后端 |
| `.github/ISSUE_TEMPLATE/config.yml` | 关掉空白 issue，把安全问题和安装问题导向 SECURITY.md / README |

顺带修掉的三处不一致：

1. `package.json` 的 `nsis.artifactName` 设为 `RoRoToCode-${version}-setup.exe`。默认产物名是
   `RoRoTo Code Setup 0.1.3.exe`（带空格），在 URL、清单和脚本里都容易出问题。
2. `release.yml` 的 `winget validate` 改为先探测 `winget` 是否存在：runner 不一定装了 App Installer，
   不能让一个加分项把已经打包好的发布卡死。
3. `README.md` / `ci.yml` 里写的「442 项单测」改成实际的 462 项。

已验证：两份 workflow、dependabot、三份 winget 清单全部通过 YAML 解析；远端仓库的完整文件清单
逐条比对本地（约 250 个条目），**没有「远端有、本地无」的文件**，强推不会删掉任何远端内容。

## 本次没有代做的事

- 提交、推送（需要你的凭据；工作区有大量未提交改动，不宜代为决定）；
- 修改 GitHub 上的 v0.1.2 Release、创建 v0.1.3 Release（公开外部动作）；
- 向 `microsoft/winget-pkgs` 提 PR（公开外部动作，且依赖首版本审核）。

本地能做的都已完成：版本号、数据落盘修复与单测、打包脚本输出 SHA256、Release 文案生成器、
winget 清单模板与渲染脚本、自动发版 workflow、勘误文案、安装器命名、标准工程文件。
