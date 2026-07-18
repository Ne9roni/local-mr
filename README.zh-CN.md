# local-mr

[English](README.md) | 简体中文

[![CI](https://github.com/Ne9roni/local-mr/actions/workflows/ci.yml/badge.svg)](https://github.com/Ne9roni/local-mr/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-2da44e.svg)](LICENSE)

**MR 还没创建，先把它审一遍。** 在 push 前，把整个 Git 分支——包括未提交文件——放进本地浏览器里的 MR 风格页面统一审查。

local-mr 会把已提交、暂存、未暂存和未跟踪改动放在同一个审查页面中。你可以切换推送快照、单个 commit、连续 commit 范围和虚拟工作区版本，而且不会修改真实 Git index。

**无需先 commit · 仅监听本机回环地址 · 不碰真实 Git index**

## 为什么用 local-mr？

- **一次审完整个分支。** 已提交和未提交改动放在一起，不再手动拼接多次 `git diff`。
- **看清分支如何演进。** 可以对比推送快照、单个 commit、连续范围或当前工作区。
- **代码留在本机。** 服务只监听带随机路径令牌的回环地址，工作区快照使用临时 index。

## 快速开始

需要 Linux 或 WSL、Git，以及 Node.js 22 或更高版本。

无需全局安装，直接在任意 Git 仓库里试用：

```bash
cd /path/to/your/repo
npx --yes --package=github:Ne9roni/local-mr local-mr
```

或者从源码安装一份独立副本：

```bash
git clone --depth 1 https://github.com/Ne9roni/local-mr.git ~/local-mr
~/local-mr/scripts/install.sh
```

源码安装器会把命令放在 `~/.local/bin/local-mr`，运行时放在 `~/.local/share/local-mr`。请确保 `~/.local/bin` 已加入 `PATH`，然后执行：

```bash
cd /path/to/your/repo
local-mr
```

参与开发时，请 clone 仓库后运行 `npm run install:link`。也可以用 `LOCAL_MR_PREFIX` 修改源码安装前缀。

## 功能

- 在同一次审查中查看已提交、暂存、未暂存和未跟踪改动
- 左侧目录树与逐文件已读/未读状态
- 推送版本、单个 commit、连续 commit 范围和工作区对比
- 双栏与单栏 Diff，并可展开被省略的上下文
- 安全的 Markdown 预览、Mermaid 渲染和 HTML 清洗
- 深色、浅色和跟随系统主题
- 在 WSL 中自动打开 Windows 浏览器
- 文件 Diff 按需加载，并为大型审查提供有界缓存

## 使用

```bash
local-mr                         # 自动识别目标分支
local-mr origin/main             # 指定目标分支
local-mr origin/release --dark   # 强制深色
local-mr --line                  # 单栏 Diff
local-mr --no-open               # 不自动打开浏览器
```

目标分支自动识别顺序：

1. `LOCAL_MR_BASE`
2. `branch.<name>.local-mr-target`
3. VS Code 的 merge-base 配置
4. `origin/HEAD`、`origin/main`、`origin/master`、`main` 或 `master`

为当前分支记住目标分支：

```bash
git config branch."$(git branch --show-current)".local-mr-target origin/release
```

## 隐私与安全

local-mr 只在 `127.0.0.1` 上提供带随机路径令牌的审查页面，而且不会写入仓库的真实 Git index。页面仍可能包含私有源码，因此不要分享审查 URL、运行日志或未脱敏截图。安全问题请按[中文安全策略](docs/zh-CN/SECURITY.md)私下报告。

## 环境要求与限制

- Linux 或 WSL
- Git
- `curl`、GNU coreutils（`sha256sum`）
- Node.js 22 或更高版本和 npm
- 桌面浏览器；`google-chrome` 只在运行贡献者浏览器测试时需要

## 开发

```bash
nvm use
npm ci
npm run verify
```

`npm run verify` 会运行语法检查、单元与集成测试和真实 Chrome 回归。GitHub Actions 会在 Node.js 22 和 24 上运行核心检查。

版本模型、缓存失效、运行时路径和安全边界见[中文架构文档](docs/zh-CN/architecture.md)。完整贡献流程见[中文贡献指南](docs/zh-CN/CONTRIBUTING.md)，版本记录见[中文 Changelog](docs/zh-CN/CHANGELOG.md)。

## 卸载

```bash
npm run uninstall:local  # 在源码目录中执行
```

卸载会保留 `~/.local/state/local-mr` 下的已读状态。

## 致谢与许可证

Diff 渲染由 [diff2html](https://github.com/rtfpessoa/diff2html) 提供支持；Markdown 预览使用 [marked](https://github.com/markedjs/marked)、[DOMPurify](https://github.com/cure53/DOMPurify) 和 [Mermaid](https://github.com/mermaid-js/mermaid)。归属声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

local-mr 使用 [MIT License](LICENSE)。
