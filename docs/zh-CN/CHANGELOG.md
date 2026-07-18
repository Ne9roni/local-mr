# 变更日志

[English](../../CHANGELOG.md) | 简体中文

## 尚未发布

- 在同一个本机浏览器工作区审查已提交修改、连续 commit 范围，以及显式选择的工作区检查点。
- 在不改变 Git 历史的前提下切换 Real commits 与不可变的 Virtual Commit revisions。
- 将大型或 AI 生成的 Diff 整理成 Overview 或 Deep review 路线，同时严格保证 block 守恒与最终文件树一致。
- 按需渲染双栏或单栏 Diff，提供语言感知高亮、上下文展开，以及 Markdown 与 Mermaid 预览。
- 将源码、评审状态和带随机令牌的页面留在本机，并通过 CI Gitleaks 历史扫描与可选 staged hook 防止凭据进入仓库。
