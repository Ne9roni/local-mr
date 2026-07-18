# 架构

[English](../architecture.md) | 简体中文

local-mr 是一个本地优先的 Git 审查工具。它把目标分支、当前 HEAD 和工作区组合成可切换的比较模型，在回环地址上提供一次审查会话，并在浏览器中按需渲染文件 Diff。

## 核心约束

1. 不修改被审查仓库的真实 Git index。
2. 默认比较包含已提交、暂存、未暂存和未跟踪文件。
3. HTTP 服务只监听 `127.0.0.1`，每次启动使用随机路径令牌。
4. Git 文件内容只能作为文本或经过清洗的 Markdown 进入浏览器 DOM。
5. 内存缓存必须同时具备容量上限和与仓库状态绑定的失效键。

## 数据流

```text
bin/local-mr
  ├─ 识别目标 ref、布局和主题
  ├─ 计算运行时指纹并复用健康的本地服务
  └─ 输出 HTML 快照与带随机令牌的 review URL
             │
             ▼
src/version-server.mjs
  ├─ 构建版本模型与比较 patch
  ├─ 渲染页面 shell，缓存单文件片段
  ├─ 提供版本、文件、上下文和已读状态端点
  └─ 空闲超时后关闭
             │
             ▼
src/review-ui.html
  ├─ 按需加载当前文件 Diff
  ├─ 切换推送版本或 commit 范围
  ├─ 展开被省略的上下文
  └─ 渲染并清洗 Markdown/Mermaid 预览
```

## 模块职责

- `src/version-model.mjs`：读取 Git 历史、生成推送/commit/工作区版本模型，并通过临时 index 快照工作区。
- `src/review-render.mjs`：调用 diff2html 生成静态 Diff，拆分页面 shell 与单文件片段。
- `src/version-server.mjs`：管理本地 HTTP 生命周期、缓存、状态持久化和范围读取端点。
- `src/review-ui.html`：包含浏览器样式和交互逻辑，不依赖构建步骤。
- `bin/local-mr`：负责 CLI 参数、目标分支探测、安装布局兼容和浏览器打开。

## 快照与缓存

工作区比较使用临时 `GIT_INDEX_FILE`：先从 HEAD 初始化，再将工作区写入临时 index，最终只读取 cached diff。临时目录在操作结束后删除，目标仓库的真实 index 不会被刷新。

服务端维护四类有界缓存：版本模型、patch、完整页面和单文件片段。缓存键包含 HEAD、目标 ref、upstream、工作区指纹、布局或 patch 内容；工作区文件元数据变化、HEAD 变化或选择范围变化都会使对应层失效。patch、页面和片段缓存分别限制为 64 MiB，条目数量也有独立上限。

## 安全边界

- 服务监听回环地址，并在所有业务路径前加入随机令牌；ready 文件权限为 `0600`。
- 默认响应禁止共享缓存；静态运行时资源只允许私有短期缓存。
- 仓库路径必须是规范化的相对 POSIX 路径，拒绝 NUL、反斜杠和目录穿越。
- 普通 Diff 上下文通过 `textContent` 写入 DOM；Markdown HTML 在插入前由 DOMPurify 清洗。
- Markdown 预览限制为 2 MiB，二进制文件不提供文本上下文。
- 已读状态限制 token 数量和长度，通过锁与原子替换写入用户状态目录。

## 测试策略

- 单元测试覆盖版本模型、patch 摘要和页面拆分。
- 集成测试在临时真实 Git 仓库中覆盖 CLI、缓存、HTTP 范围、安装/卸载和并发状态写入。
- 浏览器测试使用 headless Chrome 覆盖 Markdown 清洗、Mermaid、双栏/单栏 Diff 和上下文展开。
- GitHub CI 在 Node.js 22/24 上运行核心检查，并在 Ubuntu 24.04 上运行 Chrome 回归。
