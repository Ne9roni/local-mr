# 贡献指南

[English](../../CONTRIBUTING.md) | 简体中文

## 本地准备

```bash
nvm use
npm ci
npm run install:link
```

如果不使用 nvm，请直接安装 Node.js 22 或更高版本。

仓库提供一个可选的 staged-secret hook，供已经把 [Gitleaks](https://github.com/gitleaks/gitleaks) 安装到 `PATH` 的贡献者使用。启用前先确认当前 checkout 是否已有自定义 hook 路径：

```bash
git config --local --get core.hooksPath
git config --local core.hooksPath .githooks
```

如果已经配置其他 hook 路径，请把 Gitleaks 命令整合进去，不要直接覆盖。运行 `git config --local --unset core.hooksPath` 可以停用仓库 hook。

## 验证

- `npm run lint`：检查 JavaScript、Shell 和内嵌浏览器脚本语法。
- `npm run test:unit`：验证版本模型和服务端渲染等纯逻辑。
- `npm run test:integration`：使用临时 Git 仓库验证 CLI、HTTP、缓存、安装和状态持久化。
- `npm run test:browser`：使用 headless Chrome 验证 Markdown、Mermaid 和 Diff 交互。
- `npm run build:demo`：根据仓库最前面的两个 commit 重新生成静态自审 Demo。
- `npm run check:demo`：校验已提交 Demo 是否与干净重建结果一致。
- `npm run check`：运行 lint、Demo 校验、单元测试和集成测试。
- `npm run verify`：在此基础上增加浏览器测试。

GitHub CI 还会使用 Gitleaks 扫描完整 Git 历史；可选的 pre-commit hook 会在生成 commit 前扫描暂存区。

修改时优先在公开边界补测试：CLI、HTTP 响应或真实浏览器行为。纯文档改动至少运行 `npm run check`；涉及 UI、渲染或 Markdown 时运行 `npm run verify`。共享 review UI、渲染器或 Demo 计划发生变化时，必须一并重新生成 Demo。生成器需要仓库最前面的两个 commit，因此浅克隆环境需先补齐完整历史。

## 约定

- JavaScript 模块使用 ESM、4 空格缩进和分号；HTML 内嵌的 CSS/JavaScript 使用 2 空格缩进。
- Shell 脚本使用 Bash 和 `set -euo pipefail`，变量引用必须加引号。
- 不向目标 Git 仓库的真实 index 写入数据；工作区快照只能使用临时 index。
- 新缓存必须有明确容量上限和失效依据。
- 浏览器端不得把 Git 文件内容直接作为不可信 HTML 插入。

## 敏感信息

仓库中的所有内容都应视为公开信息。不得提交凭据、私有仓库数据、实时 review URL，或未经脱敏的日志和截图。测试使用中性的合成夹具与保留测试域名；Agent 生成内容同样遵守这一规则。

如果真实凭据已经暴露，应先撤销或轮换再清理；后续删除 commit 不能把它从 Git 历史中移除。

## Merge Request

MR 描述应说明行为变化、验证命令和风险边界。请保持一次提交只解决一个问题；如果修改工作区快照、路径解析、浏览器 HTML 或持久化状态，需要明确说明安全影响。
