# 架构

[English](../architecture.md) | 简体中文

local-mr 是一个本地优先的 Git 审查工具。默认工作流根据目标分支、真实 commit 和工作区构建可切换的比较模型，在回环地址上提供一次审查会话，并在浏览器中按需渲染文件 Diff。Real 审查初始选择从 merge-base 到最新已提交 `HEAD` 的比较；工作区只有在人类显式选择时才会进入 Diff。独立的 `virtual-commit` 工作流允许 Agent 把一份严格只含已提交改动的冻结比较重排为持久化阅读序列，而不改变真实审查。

本文描述实现边界。用户工作流、CLI 生命周期、manifest schema 和故障排查见[Virtual Commit 指南](virtual-commits.md)。

## 核心约束

1. 不修改被审查仓库的真实 Git index。
2. Real 审查默认使用最新已提交比较；暂存、未暂存和未跟踪文件只能通过显式选择工作区版本进入比较。
3. HTTP 服务只监听 `127.0.0.1`，每次启动使用随机路径令牌。
4. Git 文件内容只能作为文本或经过清洗的 Markdown 进入浏览器 DOM。
5. 内存缓存必须同时具备容量上限和与仓库状态绑定的失效键。
6. 虚拟 commit 只能作为审查投影，绝不写入工作区、真实 index、refs、commit 或远端 MR。

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
  ├─ 按语言高亮可见代码和新展开的上下文
  ├─ 在单 commit 与包含首尾的连续 commit 范围之间切换
  ├─ 展开被省略的上下文
  └─ 渲染并清洗 Markdown/Mermaid 预览
```

面向 Agent 的工作流使用独立命令和服务，但 `/review` 直接复用同一套 Diff 页面：

```text
bin/local-mr virtual-commit
  └─ src/virtual-review-cli.mjs
       ├─ snapshot/show ──► src/virtual-review-core.mjs ──► 冻结的 source 存储
       ├─ create ─────────► 严格 manifest 校验 ──────────► 不可变 revision 存储
       └─ open ───────────► src/virtual-review-server.mjs
                                      │
                                      ▼
                            /review 通过 src/review-ui.html 渲染
                              ├─ Single commit：按评审顺序任意跳转
                              ├─ Commit range：选择两个包含首尾的端点
                              ├─ revision、前后导航与进度控件
                              └─ 虚拟 context 与 preview 适配层
```

## 模块职责

- `src/version-model.mjs`：读取一份有序 Git commit 列表、解析单 commit/连续范围选择，并通过临时 index 快照显式选择的工作区。
- `src/review-render.mjs`：调用 diff2html 生成静态 Diff，拆分页面 shell 与单文件片段。
- `src/version-server.mjs`：管理本地 HTTP 生命周期、缓存、状态持久化和范围读取端点。
- `src/review-ui.html`：Real 与 Virtual 审查唯一共用的改动树/Diff 工作区。两者都只在各自的有序 commit 列表上提供 Single commit 和 Commit range；Virtual 额外附加 revision/进度控件。
- `src/virtual-diff.mjs`：把冻结的比较解析成稳定文本变更块，并将选定变更块物化为中间文件状态。
- `src/virtual-review-core.mjs`：捕获自包含 source、提供目录，并在隔离的临时 Git 仓库中构建累积虚拟 commit patch。
- `src/virtual-review-manifest.mjs`：校验带版本的 JSON manifest、带锚点的指引、各项限制和精确的变更块分配。
- `src/virtual-review-store.mjs`：在仓库外持久化内容寻址 source blob、不可变 review revision、每个 revision 对应的冻结分支 commit 元数据，以及 revision 独立的阅读进度。
- `src/virtual-review-server.mjs`：把不可变虚拟审查数据适配到共享的 `src/review-ui.html` 页面，包括有序的单 commit/连续范围选择、文件/context/preview 端点、带精确 source commit 的 revision 历史和进度状态。
- `src/virtual-review-cli.mjs`：实现机器可读的 `snapshot`、`show`、`create`、`open`、`list`、`delete`、`prune` 和显式 Skill 安装命令。
- `bin/local-mr`：负责 CLI 参数、目标分支探测、安装布局兼容和浏览器打开。
- `scripts/build-demo.mjs`：用生产环境的 Virtual Commit 流程处理本仓库的 init 与功能 commit，生成 Overview 和 Deep 两个 revision，并把结果冻结成自包含的 GitHub Pages 站点。

## 快照与缓存

Real 审查默认比较 merge-base 到最新已提交 `HEAD`。人类可以显式选择工作区端点，查看暂存、未暂存或未跟踪改动。这类工作区比较同时使用临时 `GIT_INDEX_FILE` 和 `GIT_OBJECT_DIRECTORY`：先从 `HEAD` 初始化临时 index，通过只读 alternate 读取仓库已有对象，并且只把新的工作区对象写入临时目录；渲染完该选择后删除临时目录。目标仓库的真实 index 和对象数据库都不会被刷新或扩展。

Real 比较与冻结的 Virtual source 使用同一套规范 Git patch 格式：包含二进制载荷、完整对象 ID 和重命名检测，并禁用外部 diff 与 textconv。因此包含全部 commit 的 Real 范围和完整 Virtual 范围不只是文件数量相同，patch 哈希与渲染 Diff 也完全一致。Virtual 子范围会物化两棵隔离文件树，并在 `diff-tree` 完成后才删除临时对象库。

服务端维护四类有界缓存：版本模型、patch、完整页面和单文件片段。缓存键包含 HEAD、目标 ref、工作区指纹、布局或 patch 内容；工作区文件元数据变化、HEAD 变化或选择范围变化都会使对应层失效。patch、页面和片段缓存分别限制为 64 MiB，条目数量也有独立上限。

## 虚拟 commit 审查模型

`local-mr virtual-commit snapshot [--target REF]` 会解析一个真实 commit，并严格冻结其与目标 ref 的 merge-base 到该 commit 之间的比较。工作区端点非法：暂存、未暂存、未跟踪及其他所有未提交改动都由机制排除，而不是依赖使用约定。快照保存不可变的端点 SHA、所选分支 commit 的明确元数据、完整 patch 及其 SHA-256、文件元数据，以及每个受影响文件的基准和目标内容。普通文本改动被拆成稳定的连续变更块；重命名、二进制文件、子模块及其他无法安全拆分的改动会成为单个文件级变更块。生成的 `SOURCE_ID` 是 Agent 唯一可以使用的变更清单。

CLI 是带版本的 JSON 协议。`snapshot` 返回元数据目录；`show SOURCE_ID` 可以只返回一个文件、一个变更块或完整 patch，避免一次把大型比较全部放进 Agent 上下文。命令成功时向 stdout 写入 JSON；包括 manifest 校验详情在内的错误向 stderr 写入 JSON。

Agent 提交的 manifest 包含总览、策略、不确定项、有序虚拟 commit、带锚点的审查重点、风险指引和稳定变更块 ID。校验会严格拒绝任何未知、重复或遗漏的变更块，确保 source 中的每个变更块恰好分配一次。随后 `create` 在隔离的临时 Git 仓库中物化累积状态，并校验最后的文件树与冻结的目标文件树一致。中间虚拟 commit 只是阅读步骤，不要求能够编译。

打开虚拟审查会直接进入 `/review`，不存在独立总览 UI 或第二套虚拟页面实现。Real 与 Virtual 使用同一个浏览器运行时、比较控件、改动树和 diff2html 后处理流程。两者都在一份有序 commit 列表上只提供两个模式。**Single commit** 比较所选 commit 与其紧邻前一状态，并可按评审顺序跳转任意条目；**Commit range** 比较第一个端点之前的状态与包含在内的最后端点，两个端点必须保持列表顺序，单 commit 范围同样合法。Real 默认打开完整已提交的 Commit range，按分支的 first-parent 顺序展示 commit，并可显式追加工作区检查点。当 Real 范围从列表第一个 commit 开始时，左边界使用本次评审的 merge base，而不是该 commit 在历史中的父节点。因此完整范围始终精确等于 merge-base 到 head 的比较；即使把目标分支合入较旧的 feature 历史，目标分支上独有的修改也不会泄漏回审查中。Virtual 默认以 Single commit 从 `V1` 开始，并使用 manifest 的 `V1`、`V2`……顺序，额外提供前后导航、已评审进度和 revision 选择器。该选择器会解析每个 revision 自己的 source snapshot，并显示其分支 commit SHA、subject 与分支，而不是假设所有 revision 都描述实时 `HEAD`。两种来源还会填充同一个 `focusedCommit` 客户端模型和 Diff 上方的共享上下文面板：真实比较映射所选 Git subject/body，虚拟比较则把 manifest 的 title/intent/review focus/risk 映射成 Agent 编写的阅读索引。除此之外，虚拟服务只把冻结数据适配成片段、上下文、Markdown 预览与进度服务。上下文按所选区间之前的状态物化，并包含所有更早的虚拟变更块，因此在 V2 展开代码时不会错误地用最初 base 覆盖已经应用的 V1 内容。旧 `mode=push` 链接只作为兼容别名接受，并会规范化为 Single commit 或 Commit range。

不传 `--review` 会创建新 review；复用 review ID 会追加一个带序号且不可变的 revision，`--expected-revision` 提供乐观并发控制。Revision 会保留各自的 `sourceId`，因此同一 review 的不同 revision 可以合理地指向不同分支 commit，例如后来基于较早冻结 commit 生成一份新的阅读计划。每个 revision 都有独立的已查看/已评审进度，`list` 会报告每个 revision 精确对应的分支 commit。原仓库仍可访问时，页面会检查当前比较哈希；如果发生变化则把冻结 source 标记为过期，但绝不会重新映射旧变更块。

Real 与 Virtual 审查仍由两个独立的回环服务提供。虚拟服务中受随机令牌保护的 `/real` 路由，会使用 source 中冻结的 base、head、target SHA 调用普通 `local-mr` launcher，再把经过校验的虚拟审查返回地址传给真实服务。冻结比较拥有独立的运行时身份，不会复用基于实时 `HEAD` 的服务，因此仓库漂移和陈旧的分支 target 配置都无法改变文件集合。缺少完整已提交 SHA 组的旧 source 或工作区 source 会被明确拒绝，不再静默重新计算。用户在真实页面切换 Single commit/Commit range 时，返回地址会持续保留；切回 Virtual 会精确恢复原 revision、模式、选择端点和当前文件，两个服务不需要共享可变状态。

保存的 source 对受影响文件是自包含的，因此原仓库被移动或删除后仍可打开审查。review、revision、完整 patch 和内容寻址 blob 位于 `$XDG_STATE_HOME/local-mr/virtual-reviews`；未设置 `XDG_STATE_HOME` 时位于 `~/.local/state/local-mr/virtual-reviews`。`list` 用于发现 review，`open` 重新打开 revision，`delete` 删除 review 或 revision，`prune` 删除已不被任何 revision 引用的 source 快照和 blob。

项目内置的 `local-mr-virtual-commits` Codex Skill 负责与人类协商评审深度和阅读顺序；它不是内核依赖，只能通过 `local-mr virtual-commit install-skill codex [--force]` 显式安装。这样模型选择、分组粒度和阅读策略位于确定性的快照、校验、持久化与渲染内核之外。

## 自审 Demo

公开 Demo 不是手写的假页面。Real 侧比较本仓库的 init commit 与引入 Virtual Commits 的功能 commit；同一份冻结 source 随后两次通过生产环境的 manifest 校验与物化流程：revision 1 是 6 步 Overview，revision 2 是 14 步 Deep review。两版都先读文档，最后再处理发布元数据。

生成器会先证明每个 revision 的最终文件树等于 Real commit，并且完整 patch 与 Real 比较逐字节一致，然后才写入静态页面。它会预生成 Single commit、Commit range、两种 Diff 布局、文件片段、展开上下文和 Markdown 预览。最终站点不需要本地服务，但仍复用 CLI 使用的 `src/review-ui.html` 与渲染代码，而不是维护第二套 Demo UI。

## 安全边界

- 服务监听回环地址，并在所有业务路径前加入随机令牌；ready 文件权限为 `0600`。
- 虚拟审查服务同样只监听回环地址并使用随机令牌；状态目录权限为 `0700`，存储文件权限为 `0600`。
- 虚拟审查状态包含完整 patch 和私有源码。即使它位于仓库外，仍是敏感的持久化数据，不应通过 URL、日志或状态目录副本分享。
- 默认响应禁止共享缓存；静态运行时资源只允许私有短期缓存。
- 仓库路径必须是规范化的相对 POSIX 路径，拒绝 NUL、反斜杠和目录穿越。
- 普通 Diff 上下文通过 `textContent` 写入 DOM；Markdown HTML 在插入前由 DOMPurify 清洗。
- Markdown 预览限制为 2 MiB，二进制文件不提供文本上下文。
- 已读状态限制 token 数量和长度，通过锁与原子替换写入用户状态目录。

## 测试策略

- 单元测试覆盖版本模型、patch 摘要和页面拆分。
- 虚拟审查单元测试覆盖变更块解析与物化、严格 manifest 守恒、不可变 revision、revision 独立进度和内容寻址存储。
- 集成测试在临时真实 Git 仓库中覆盖 CLI、缓存、HTTP 范围、安装/卸载和并发状态写入。
- 浏览器测试使用 headless Chrome 覆盖语法高亮、Markdown 清洗、Mermaid、双栏/单栏 Diff、上下文展开、导航，以及 Real/Virtual 通过共享工作区得到的等价渲染。
- Demo 回归测试覆盖两个 revision、Real/Virtual 切换、Single commit 与完整 Commit range、仓库链接和冻结 source 元数据。
- GitHub CI 在 Node.js 22/24 上运行核心检查，并在 Ubuntu 24.04 上运行 Chrome 回归。
