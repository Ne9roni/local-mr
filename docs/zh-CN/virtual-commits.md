# Virtual Commit 审查

[English](../virtual-commits.md) | 简体中文

Virtual Commit 可以把一份很大的已提交分支比较整理成有顺序的阅读计划，而不改写 Git 历史。真实 commit 过大、混合了多个关注点，或者开发顺序不适合评审理解时，它尤其有用。

本文介绍信任模型、推荐的 Codex 工作流、浏览器控件和 JSON CLI。实现细节见[架构文档](architecture.md)。

## 心智模型

Virtual Commit 不是 Git commit，而是一组有名称的不可变变更块和对应的评审指引。按顺序累积全部分组后，会还原冻结的目标状态：

```text
目标分支 ── merge base B ───────────── 真实 commit H
                         │   冻结 Diff D  │
                         └───────┬────────┘
                                 │ 拆成稳定变更块
                                 ▼
                         V1 → V2 → … → Vn

                  blocks(V1 … Vn) = D 中每个块恰好出现一次
                  state(after Vn) = H 对应的冻结状态
```

几个核心概念：

- **Source snapshot（源快照）：** 目标分支与当前分支 merge base 到某个选定真实 commit 的不可变比较。它包含端点 SHA、该分支 commit 的明确元数据、规范化 patch 的 SHA-256、受影响文件的 base/target 内容，以及稳定的文件和变更块目录。
- **Change block（变更块）：** 编排器允许移动的最小单位。普通文本文件会被拆成稳定的连续变更块；重命名、二进制、submodule、仅 mode 变化或其他不适合安全拆分的修改，会作为一个完整的文件级变更块。
- **Virtual commit：** 一个阅读步骤，包含一个或多个 source block，以及标题、意图、1～3 条带锚点的评审重点和风险判断。
- **Review：** 一份阅读计划的持久化身份。
- **Revision：** 这份计划的一个不可变版本，并绑定自己的冻结 source 与分支 commit。修订 review 时只会追加 revision，不会覆盖旧版本；同一 review 的不同 revision 可以使用不同 source commit。

Virtual Commit 优化的是评审顺序，而不是构建顺序。中间虚拟状态可以不完整、不能编译；最终状态必须严格完整。

## 保证与边界

以下性质由引擎强制校验，而不是依赖 Agent 自觉遵守：

1. **只接受已提交 source。** Source 必须从本次评审的 merge base 开始，在某个真实 commit 结束。工作区端点会被拒绝，因此暂存、未暂存、未跟踪和其他未提交改动无法进入快照。工作区可以是 dirty 的，但它会被忽略。
2. **输入冻结。** 快照记录完整 commit SHA 和内容寻址的文件数据。分支后来移动，不会改写已有 source 或 revision。
3. **变更块严格守恒。** 每个 source block 必须且只能出现在一个 Virtual Commit 中。未知、遗漏或重复的 block ID 会让整个 manifest 校验失败。
4. **最终状态精确相等。** `create` 会在隔离的临时 Git 仓库里物化累积状态，并验证最后一个 Virtual Commit 之后的状态等于冻结的目标 tree。
5. **完整审查等价。** Real 与 Virtual 使用相同的规范化 binary/full-index diff 参数。因此完整 Virtual range 与冻结的完整 Real range 拥有相同 patch 和渲染后 Diff。
6. **只读投影。** 整个流程不会把 Virtual Commit 应用到工作区，也不会修改真实 index、对象库、refs、commit、Git 配置或远端。

只有完整范围理应相同。任意局部 Real range 和 Virtual range 通常代表不同分组：Real 遵循 Git first-parent 历史，Virtual 遵循 Agent 编排的阅读顺序。

## 推荐：通过 Codex 使用

### 1. 选择已提交比较

Virtual 审查沿用 local-mr 的目标分支识别逻辑。可以为当前分支固定目标：

```bash
git config branch."$(git branch --show-current)".local-mr-target origin/main
```

如果某项修改只存在于工作区，而你希望它进入 Virtual 审查，请先提交。它仍可在普通 Real 审查中查看，但 Virtual snapshot 不会接受它。

### 2. 一次性安装内置 Skill

```bash
local-mr virtual-commit install-skill codex
```

需要更新已安装副本时使用 `--force`：

```bash
local-mr virtual-commit install-skill codex --force
```

安装必须显式执行，因为 Skill 负责告诉 Agent 如何分组以及应遵守哪些安全规则；local-mr 确定性的快照、校验、存储和渲染引擎本身并不依赖 Skill。

### 3. 选择评审深度并确认阅读计划

在目标仓库里启动 Codex，并明确目标分支、偏好的评审深度和阅读顺序。例如：

```text
使用 local-mr virtual commits，把当前分支相对 origin/main 的已提交修改
整理成适合评审的顺序。使用 Deep review，并采用依赖优先、核心与风险
优先的阅读顺序。生成审查页面前，先展示有序的 Virtual Commit 标题列表。
```

也可以给出更具体的要求：

```text
创建一份 Overview Virtual Commit 审查，先讲清请求链路，再看测试，
生成文件放到最后。
```

```text
使用 Deep review 修订 Virtual Review REVIEW_ID：先看兼容边界，再看
高风险状态转换、集成和测试。
```

评审深度只控制分组分辨率，不影响完整性：

| 深度 | 大型比较的典型步骤数 | 分组规则 |
| --- | --- | --- |
| **Overview** | 5–8 | 优先采用较宽的语义章节，以及整文件或子系统分组。 |
| **Deep review** | 10–20 | 每一步只回答一个评审问题，必要时拆开同一文件的多个 block。 |

步骤数只是经验值。不可拆分的 block 必须保持完整；一个明确的最终生成物/机械改动步骤可以更大。阅读顺序是另一项独立选择。没有指定深度时，内置 Skill 会在冻结或分析 source 前询问；大型或 AI 生成的比较默认推荐 Deep review。没有指定阅读顺序时，默认采用“依赖优先、核心/风险优先”。

随后 Agent 会按带确认闸门的流程执行：

1. 解析请求中的评审深度；没有指定时，在 snapshot 和分析之前询问；
2. 用 `snapshot` 冻结已提交比较；
3. 检查目录，并通过 `show` 只读取理解分组所需的文件或变更块；
4. 把每个 block 分配到有序 Virtual Commit，并编写带锚点的意图、重点、不确定项和风险说明；
5. 展示完整、有序的 Virtual Commit 标题列表，并等待用户明确确认这版计划；
6. 仅在确认后把 manifest 交给 `create`，根据结构化校验错误修正计划，但不更换 source；
7. 在浏览器打开带随机令牌的本机回环审查，不把 URL 带回 Agent 对话。

最初的生成请求和粒度选择都不算对未展示计划的确认；如果标题列表发生变化，Agent 必须重新展示完整列表并再次等待确认。人类选择评审深度并确认阅读策略；local-mr 独立保证 source 不变、block 守恒、最终 tree 相等、revision 持久化和 Git 安全。

## 使用审查页面

Real 与 Virtual 会进入同一个 Diff 工作区。裸 `local-mr` 页面会自动发现 canonical 仓库根目录、分支和目标 ref 相同的已保存 revision。Source 的 base/head/target SHA 只决定新鲜度，不决定身份：分支继续提交后，旧计划仍会以 **Virtual · stale** 保留；进入 Virtual 后才会常驻提示冻结 commit 与当前 commit。在出现任何匹配的 Virtual Review 之前，Virtual 选项会明确显示为不可用，而不是被整个省略。两者的文件树、按需加载、双栏/单栏布局、语法高亮、上下文展开、Markdown/Mermaid 预览和已读标记行为一致。

| 控件 | Real commits | Virtual commits |
| --- | --- | --- |
| **Single commit** | 比较任意真实 commit 与其前一个 Git 状态。 | 比较任意 `Vn` 与累积到 `Vn-1` 后的状态。 |
| **Commit range** | 比较所选第一个真实 commit 之前的状态，到包含在内的最后一个 commit。 | 比较所选第一个 Virtual Commit 之前的累积状态，到包含在内的最后一个 Virtual Commit。 |
| 顺序 | 从本次评审 merge base 开始的 first-parent 顺序；显式选择时工作区可作为最后一项。 | Manifest 中的 `V1`、`V2`……`Vn` 顺序。 |
| 上下文面板 | Git subject 和 commit body。 | Agent 编写的意图、评审重点、风险和带锚点指引。 |
| 额外控件 | 存在工作区修改时可显式选择。 | 上一条/下一条、已评审进度和不可变 revision 选择。 |

单 commit 范围同样合法。Real range 从列表中第一个 commit 开始时，左边界固定为本次评审 merge base，而不是该 commit 在历史中的父节点。因此即使目标分支后来被合入 feature 分支，目标分支独有修改也不会重新出现在审查中。

两种默认值对应两种任务：Real 默认打开完整已提交的 **Commit range**；Virtual 默认以 **Single commit** 从 `V1` 开始，让评审者从阅读路线的第一步进入。显式 URL 选择以及 Real/Virtual 返回链接仍会保留已选模式和端点。

Revision 选择器会用短 SHA、subject 和分支标明每份计划精确对应的冻结分支 commit。这是 source 元数据，不是仓库实时状态：如果 R2 虽然后生成，却使用了一个比 R1 更早的 commit 快照，页面会如实显示，而不会暗示 R2 属于当前 `HEAD`。

过期计划始终保持冻结，也不会声称包含后续提交。从 live Real 页面进入时，其中的 Real 按钮会返回同一个 live 页面；直接打开 Virtual 历史链接时，则保留 frozen Real 作为精确对照，并在往返时保留 revision、比较模式、端点和当前文件。Frozen Real 使用 source 的 base、head、target SHA 启动，因此分支移动或陈旧的 target 配置不会静默改变文件集合。即使原仓库被移动或删除，冻结的 Virtual 审查仍能阅读；但此时要切换到 frozen Real，需要原 Git 对象仍可访问。

页面不再提供 Pushes 比较模式。旧 `mode=push` URL 只作为兼容别名接受，并会规范化为 Single commit 或 Commit range。

## JSON CLI 工作流

CLI 主要面向 Agent 和自动化。每个成功命令只向 stdout 输出一个带版本的 JSON 对象；失败时以非零状态退出，并只向 stderr 输出一个结构化 JSON 错误，因此调用方应分开处理两个输出流。

### 冻结 source

使用自动识别的目标分支，冻结到 `HEAD` 为止的完整已提交比较：

```bash
local-mr virtual-commit snapshot
```

或显式指定目标分支：

```bash
local-mr virtual-commit snapshot --target origin/main
```

如果要结束在更早的真实 commit，必须同时传入以下三个选择参数。`FIRST_REVIEW_COMMIT_SHA` 是 merge base 之后 first-parent 顺序里的第一个 commit：

```bash
local-mr virtual-commit snapshot \
  --target origin/main \
  --mode range \
  --from FIRST_REVIEW_COMMIT_SHA \
  --to SELECTED_REAL_COMMIT_SHA
```

所选 source 仍必须从 merge base 开始。起点更晚的局部范围、反向范围、未知 commit 和工作区端点都会被拒绝。

响应中的 `source` 包含不透明的 `sourceId`、`diffHash`、仓库与选择元数据、摘要计数，以及文件/block 目录。请把 `sourceId`、file ID 和 block ID 都视为不透明标识符。

### 只读取需要的内容

```bash
local-mr virtual-commit show SOURCE_ID
local-mr virtual-commit show SOURCE_ID --file src/router.ts
local-mr virtual-commit show SOURCE_ID --block BLOCK_ID
local-mr virtual-commit show SOURCE_ID --full
```

不传选择器时，`show` 返回目录；`--file` 增加该文件冻结的 base/target 文本，`--block` 返回单个变更块，`--full` 返回规范化完整 patch。一次只能使用一个选择器；大型审查应优先请求最窄的结果。

### 创建 review

传入 manifest 文件：

```bash
local-mr virtual-commit create SOURCE_ID --manifest manifest.json
```

也可以从 stdin 输入，并在自动化场景禁止自动打开浏览器：

```bash
local-mr virtual-commit create SOURCE_ID --no-open < manifest.json
```

成功响应包含 `reviewId`、`revision`、`sourceId` 和 `reviewUrl`。未传 `--no-open` 时会自动打开浏览器。

### 重开、修订与删除 review

```bash
local-mr virtual-commit list
local-mr virtual-commit open REVIEW_ID
local-mr virtual-commit open REVIEW_ID --revision 2
```

追加 revision 时，把当前已知的最新 revision 作为乐观并发保护：

```bash
local-mr virtual-commit create SOURCE_ID \
  --manifest revised-manifest.json \
  --review REVIEW_ID \
  --expected-revision 2
```

如果另一调用方已经追加 revision，`REVISION_CONFLICT` 会报告预期值和当前值，而不会覆盖任何内容。每个 revision 都保留自己的 `sourceId`、冻结分支 commit 元数据和独立的已查看/已评审进度。`list` 会报告每个已保存 revision 对应的分支 commit，调用方因此能区分旧计划与后来基于旧代码生成的新计划。

删除单个 revision 或整个 review，再清理已不被任何 revision 引用的 source snapshot 和 blob：

```bash
local-mr virtual-commit delete REVIEW_ID --revision 2
local-mr virtual-commit delete REVIEW_ID
local-mr virtual-commit prune
```

`delete` 不会隐式运行 `prune`，这样既可降低误删风险，也允许多个 revision 安全共享内容寻址数据。

## Manifest 格式

Schema version 1 的 manifest 结构如下。这个例子假设 source 恰好包含三个 block；请把其中的路径和 block ID 替换为冻结 source 目录中的精确值：

```json
{
  "schemaVersion": 1,
  "title": "Review the request-routing change",
  "strategy": "Dependency-aware core/risk-first",
  "overview": {
    "summary": "Introduce policy-driven routing and cover fallback behavior.",
    "routeRationale": "Read the policy contract, risky selection path, integrations, then tests.",
    "uncertainties": [
      {
        "text": "The deployment owner of the generated table is unclear.",
        "targets": ["block:BLOCK_ID_3"]
      }
    ]
  },
  "virtualCommits": [
    {
      "title": "Define the routing policy",
      "intent": "Establish the contract needed to understand selection behavior.",
      "reviewFocus": [
        {
          "text": "Check that precedence matches the intended fallback order.",
          "targets": ["block:BLOCK_ID_1", "file:src/policy.ts"]
        }
      ],
      "risk": {
        "level": "high",
        "reason": "A precedence error can route requests to the wrong backend."
      },
      "blocks": ["BLOCK_ID_1", "BLOCK_ID_2"]
    },
    {
      "title": "Review the generated integration table",
      "intent": "Confirm the mechanical output after the routing behavior is understood.",
      "reviewFocus": [
        {
          "text": "Verify that every generated route has a corresponding policy entry.",
          "targets": ["block:BLOCK_ID_3"]
        }
      ],
      "risk": {
        "level": "medium",
        "reason": "A stale generated entry can bypass the intended policy."
      },
      "blocks": ["BLOCK_ID_3"]
    }
  ]
}
```

重要规则：

- `schemaVersion` 必须是整数 `1`。
- `overview.uncertainties` 始终是数组；没有已知不确定项时使用 `[]`。
- 每个 Virtual Commit 都需要非空标题、意图、风险原因、至少一个 block，以及 1～3 条 `reviewFocus`。
- `risk.level` 只能是 `low`、`medium`、`high` 或 `critical`。
- 指引锚点使用 `block:<精确 ID>` 或 `file:<精确仓库相对路径>`；`blocks` 数组使用不带 `block:` 前缀的原始 block ID。
- 所有 `blocks` 数组合计必须让 source 的每个 block 恰好出现一次。不要用静默的兜底分组掩盖规划错误。
- Manifest 上限为 1 MiB、最多 100 个 Virtual Commit；文本字段和不确定项数量也有明确上限。

校验错误会返回稳定的错误码和字段路径。例如 `MISSING_BLOCK`、`DUPLICATE_BLOCK`、`UNKNOWN_BLOCK`、`UNKNOWN_TARGET` 会指出需要修正的具体分配或锚点。请使用同一个 `SOURCE_ID` 重试；重新创建 snapshot 会改变当前评审的清单。

## 存储、隐私与清理

Snapshot 和 review 保存在仓库外：

```text
$XDG_STATE_HOME/local-mr/virtual-reviews
```

未设置 `XDG_STATE_HOME` 时，默认路径为：

```text
~/.local/state/local-mr/virtual-reviews
```

目录权限为 `0700`，存储文件权限为 `0600`。状态目录包含完整 patch 和受影响的私有源码，并且在仓库删除和 local-mr 卸载后仍会保留，请像保护源码仓库一样保护它。不要分享审查 URL、服务日志、包含私有代码的截图或状态目录副本。

Review 服务只监听 `127.0.0.1`，并为所有业务路径加入随机令牌。Virtual Commit 命令不会访问或修改远端 MR。不再需要已保存审查时，请先执行 `delete`，再执行 `prune`。

## 常见错误

| 错误 | 含义与处理方式 |
| --- | --- |
| `VIRTUAL_SOURCE_REQUIRES_COMMIT` | Merge base 之后没有已提交修改。先提交希望纳入的修改；只有工作区修改时请使用普通 Real 审查。 |
| `INVALID_VIRTUAL_SOURCE_BOUNDARY` | Source 没有从 merge base 开始，或结束在工作区。请选择完整的 merge-base 到真实 commit 范围。 |
| `INVALID_MANIFEST` | Schema、锚点或 block 守恒规则失败。修正 `error.details` 中的每一项，并用同一个 source 重试。 |
| `REVISION_CONFLICT` | Review 已被追加了其他 revision。读取当前 revision，重新生成预期修订，再用新的 `--expected-revision` 重试。 |
| `SKILL_EXISTS` | Codex Skill 已安装。只有明确要更新它时才使用 `install-skill codex --force`。 |
