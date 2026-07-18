# Virtual Commit Reviews

English | [简体中文](zh-CN/virtual-commits.md)

Virtual commits turn one large, committed branch comparison into an ordered reading plan without rewriting Git history. They are useful when the real commits are too large, mix unrelated concerns, or follow implementation order rather than the order in which a reviewer needs to understand the change.

This guide explains the trust model, the recommended Codex workflow, the browser controls, and the JSON CLI. For implementation details, see the [architecture guide](architecture.md).

## Mental model

A virtual commit is not a Git commit. It is a named group of immutable change blocks plus review guidance. Applying the groups in order reconstructs the frozen target state:

```text
target branch ── merge base B ───────────── real commit H
                         │   frozen diff D   │
                         └───────┬───────────┘
                                 │ split into stable blocks
                                 ▼
                         V1 → V2 → … → Vn

                  blocks(V1 … Vn) = every block in D exactly once
                  state(after Vn) = frozen state at H
```

The main terms are:

- **Source snapshot:** the immutable comparison from the merge base with a target branch to a selected real commit. It includes endpoint SHAs, explicit metadata for that branch commit, a SHA-256 of the canonical patch, the affected files' base and target content, and a stable file/block catalog.
- **Change block:** the smallest unit the planner may move. Ordinary text files are split into stable contiguous blocks. A rename, binary file, submodule, mode-only change, or other unsafe-to-split change becomes one file-level block.
- **Virtual commit:** one reading step containing one or more source blocks, a title and intent, one to three anchored review-focus notes, and a risk assessment.
- **Review:** a persistent identity for one reading plan.
- **Revision:** an immutable version of that plan, tied to its own frozen source and branch commit. Revising a review appends a new revision instead of replacing the old one; revisions in one review may use different source commits.

Virtual commits optimize review order, not build order. An intermediate virtual state is allowed to be incomplete or uncompilable; the final state is not.

## Guarantees and boundaries

The engine enforces these properties rather than relying on the agent to remember them:

1. **Committed source only.** The source must begin at the review merge base and end at a real commit. A worktree endpoint is rejected, so staged, unstaged, untracked, and other uncommitted changes cannot enter the snapshot. A dirty worktree may exist, but it is ignored.
2. **Frozen input.** The snapshot records complete commit SHAs and content-addressed file data. Later branch movement does not rewrite an existing source or revision.
3. **Exact block conservation.** Every source block must appear in exactly one virtual commit. Unknown, missing, and duplicate block IDs reject the whole manifest.
4. **Exact final state.** `create` materializes cumulative states in an isolated temporary Git repository and verifies that the state after the last virtual commit equals the frozen target tree.
5. **Equivalent complete review.** Real and Virtual use the same canonical binary/full-index diff options. The complete Virtual range therefore has the same patch and rendered Diff as the frozen complete Real range.
6. **Read-only projection.** The workflow never applies a virtual commit to the worktree and never changes the real index, object database, refs, commits, Git configuration, or remotes.

Only the complete ranges are expected to match. A partial Real range and a partial Virtual range usually represent different groupings: Real follows Git's first-parent history, while Virtual follows the agent-authored reading order.

## Recommended workflow with Codex

### 1. Select the committed comparison

Virtual review uses local-mr's normal target detection. To pin the target for the current branch:

```bash
git config branch."$(git branch --show-current)".local-mr-target origin/main
```

If a change exists only in the worktree, commit it before asking for it to be included. It remains available in ordinary Real review, but Virtual snapshot creation will not accept it.

### 2. Install the bundled Skill once

```bash
local-mr virtual-commit install-skill codex
```

Use `--force` when updating an existing installed copy:

```bash
local-mr virtual-commit install-skill codex --force
```

The install is explicit because the Skill gives the agent the grouping workflow and safety rules; it is not required by local-mr's deterministic snapshot, validation, storage, or rendering engine.

### 3. Ask Codex for a review depth and reading plan

Start Codex in the repository and make the target, preferred review depth, and reading order clear. For example:

```text
Use local-mr virtual commits to organize the committed changes against
origin/main. Use Deep review with a dependency-aware, core/risk-first reading
order and open the review when it is ready.
```

Other useful directions include:

```text
Create an Overview virtual-commit review that explains the request path before
tests. Keep generated files last.
```

```text
Revise virtual review REVIEW_ID using Deep review. Put the compatibility
boundary first, then the risky state transition, integrations, and tests.
```

Review depth controls grouping resolution, not completeness:

| Depth | Typical large-comparison route | Grouping rule |
| --- | --- | --- |
| **Overview** | 5–8 steps | Prefer broad semantic chapters and whole-file or subsystem groups. |
| **Deep review** | 10–20 steps | Make each step answer one reviewer question and split a multi-block file when useful. |

These counts are heuristics. Indivisible blocks stay whole, and one explicit final generated/mechanical step may be larger. Reading order remains a separate choice. If depth is absent, the bundled Skill first freezes the source, then asks once using its actual size and recommends Deep review for large or AI-produced comparisons. If reading order is absent, it uses dependency-aware core/risk-first.

The agent then:

1. freezes the committed comparison with `snapshot`;
2. resolves the requested depth, asking once after the snapshot only when it was not supplied or implied;
3. inspects the returned catalog and reads only relevant files or blocks with `show`;
4. assigns every block to an ordered virtual commit and writes anchored intent, focus, uncertainty, and risk guidance;
5. submits the manifest to `create`, correcting any structured validation errors without changing the source; and
6. opens the tokenized loopback review in the browser without relaying its URL through the agent conversation.

The human chooses the review depth; the model proposes the reading strategy. local-mr independently enforces source immutability, block conservation, final-tree equality, revision persistence, and Git safety.

## Using the review page

Real and Virtual open in the same Diff workspace. A bare `local-mr` page automatically discovers saved revisions with the same canonical repository root, branch, and target ref. Source base/head/target SHAs determine freshness, not identity: when the branch advances, the old plan stays available as **Virtual · stale**; opening it shows a persistent frozen-commit/current-commit warning. Until any matching Virtual Review exists, its option remains visibly unavailable rather than being omitted. The file tree, lazy loading, side-by-side and line-by-line layouts, syntax highlighting, context expansion, Markdown/Mermaid preview, and read markers behave the same in both sources.

| Control | Real commits | Virtual commits |
| --- | --- | --- |
| **Single commit** | Compare any real commit with its preceding Git state. | Compare any `Vn` with the cumulative state after `Vn-1`. |
| **Commit range** | Compare the state before the selected first real commit through the inclusive last commit. | Compare the cumulative state before the selected first virtual commit through the inclusive last virtual commit. |
| Ordering | First-parent order from the review merge base; an explicitly selected worktree may appear last. | Manifest order `V1`, `V2`, …, `Vn`. |
| Context panel | Git subject and commit body. | Agent-authored intent, review focus, risk, and anchored guidance. |
| Extra controls | Worktree selection when available. | Previous/next navigation, reviewed progress, and immutable revision selection. |

A one-commit range is valid. A Real range that starts at the first listed commit is anchored to the review merge base rather than that commit's historical parent; this prevents target-branch-only changes from reappearing after the target was merged into the feature branch.

The defaults reflect the two jobs: Real opens the complete committed **Commit range**, while Virtual opens **Single commit** at `V1` so the reviewer starts at the beginning of the authored reading route. Explicit URL selections and Real/Virtual return links keep their selected mode and endpoints.

The revision selector labels every plan with the exact frozen branch commit's short SHA, subject, and branch. This is source metadata, not live repository state: if R2 was created later from a source snapshot at an older commit than R1, the page shows precisely that instead of implying R2 belongs to current `HEAD`.

An outdated plan remains frozen and never claims to contain later commits. When it was opened from a live Real page, the Real button returns to that live page. A Virtual link opened directly retains the frozen Real fallback for exact comparison; switching through that path preserves the virtual revision, comparison mode, endpoints, and focused file. Frozen Real is launched with the source's base, head, and target SHAs, so a moved branch or stale target configuration cannot silently change the file set. The frozen Virtual review remains readable if the original repository is moved or removed, although switching to frozen Real then requires the original Git objects to be available.

There is no Pushes comparison mode. Old `mode=push` URLs are accepted only as compatibility aliases and are normalized to Single commit or Commit range.

## JSON CLI workflow

The CLI is primarily an agent and automation interface. Every successful command emits one versioned JSON object on stdout. Failures exit nonzero and emit one structured JSON error on stderr, so callers should keep the two streams separate.

### Freeze a source

Use the detected target and the complete committed comparison through `HEAD`:

```bash
local-mr virtual-commit snapshot
```

Or choose the target explicitly:

```bash
local-mr virtual-commit snapshot --target origin/main
```

To stop at an older real commit, pass all three selection options. `FIRST_REVIEW_COMMIT_SHA` is the first first-parent commit after the merge base:

```bash
local-mr virtual-commit snapshot \
  --target origin/main \
  --mode range \
  --from FIRST_REVIEW_COMMIT_SHA \
  --to SELECTED_REAL_COMMIT_SHA
```

The selected source must still begin at the merge base. Partial ranges that start later, reversed ranges, unknown commits, and worktree endpoints are rejected.

The response's `source` contains the opaque `sourceId`, `diffHash`, repository and selection metadata, summary counts, and the file/block catalog. Treat `sourceId`, file IDs, and block IDs as opaque.

### Inspect only what is needed

```bash
local-mr virtual-commit show SOURCE_ID
local-mr virtual-commit show SOURCE_ID --file src/router.ts
local-mr virtual-commit show SOURCE_ID --block BLOCK_ID
local-mr virtual-commit show SOURCE_ID --full
```

With no selector, `show` returns the catalog. `--file` adds the file's frozen base and target text, `--block` returns one block, and `--full` returns the canonical patch. Use only one selector and prefer the narrowest response for large reviews.

### Create a review

Pass a manifest file:

```bash
local-mr virtual-commit create SOURCE_ID --manifest manifest.json
```

Or provide it on stdin and suppress automatic browser launch for automation:

```bash
local-mr virtual-commit create SOURCE_ID --no-open < manifest.json
```

The success response contains `reviewId`, `revision`, `sourceId`, and `reviewUrl`. Without `--no-open`, the browser opens automatically.

### Reopen, revise, and remove reviews

```bash
local-mr virtual-commit list
local-mr virtual-commit open REVIEW_ID
local-mr virtual-commit open REVIEW_ID --revision 2
```

Append a revision using the latest known revision as an optimistic-concurrency guard:

```bash
local-mr virtual-commit create SOURCE_ID \
  --manifest revised-manifest.json \
  --review REVIEW_ID \
  --expected-revision 2
```

If another writer has already added a revision, `REVISION_CONFLICT` reports the expected and current values instead of overwriting anything. Each revision keeps its own `sourceId`, frozen branch-commit metadata, and independent viewed/reviewed progress. `list` reports that branch commit for every saved revision, so callers can distinguish an older plan from a later plan generated against older code.

Delete one revision or the whole review, then remove source snapshots and blobs no remaining revision references:

```bash
local-mr virtual-commit delete REVIEW_ID --revision 2
local-mr virtual-commit delete REVIEW_ID
local-mr virtual-commit prune
```

`delete` does not implicitly run `prune`, which makes accidental data loss less likely and lets multiple revisions share content-addressed data safely.

## Manifest format

A schema-version-1 manifest has this shape. This example assumes the source contains exactly three blocks; replace its paths and block IDs with exact values from the frozen source catalog:

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

Important rules:

- `schemaVersion` must be the integer `1`.
- `overview.uncertainties` is always an array; use `[]` when there are no known uncertainties.
- Every virtual commit needs a nonempty title, intent, risk reason, at least one block, and one to three `reviewFocus` items.
- `risk.level` is `low`, `medium`, `high`, or `critical`.
- Guidance targets use `block:<exact-id>` or `file:<exact-repository-path>`. The `blocks` array uses raw block IDs without the `block:` prefix.
- Every source block must occur once across all `blocks` arrays. Do not add a silent catch-all group to hide planning mistakes.
- A manifest is limited to 1 MiB and 100 virtual commits. Text fields and uncertainty counts also have bounded validation limits.

Validation failures use stable error codes and field paths. For example, `MISSING_BLOCK`, `DUPLICATE_BLOCK`, `UNKNOWN_BLOCK`, and `UNKNOWN_TARGET` identify the exact assignment or anchor to fix. Retry with the same `SOURCE_ID`; taking a new snapshot would change the inventory being reviewed.

## Storage, privacy, and cleanup

Snapshots and reviews are stored outside the repository under:

```text
$XDG_STATE_HOME/local-mr/virtual-reviews
```

When `XDG_STATE_HOME` is unset, the default is:

```text
~/.local/state/local-mr/virtual-reviews
```

Directories use mode `0700` and stored files use `0600`. The store contains full patches and affected private source content, and it persists across repository deletion and local-mr uninstallation. Protect it like a source checkout. Do not share review URLs, server logs, screenshots containing private code, or copies of the state directory.

Review servers listen only on `127.0.0.1` and put a random token in every application path. No virtual-commit command contacts or modifies a remote MR. Use `delete` followed by `prune` when a saved review is no longer needed.

## Common failures

| Error | Meaning and action |
| --- | --- |
| `VIRTUAL_SOURCE_REQUIRES_COMMIT` | There is no committed change after the merge base. Commit the intended change or use ordinary Real review for worktree-only changes. |
| `INVALID_VIRTUAL_SOURCE_BOUNDARY` | The source does not start at the merge base or ends at the worktree. Select a complete merge-base-to-real-commit range. |
| `INVALID_MANIFEST` | One or more schema, anchor, or block-conservation rules failed. Fix every entry in `error.details` and retry with the same source. |
| `REVISION_CONFLICT` | The review gained another revision. Read the current revision, rebuild the intended update, and retry with the new `--expected-revision`. |
| `SKILL_EXISTS` | The Codex Skill is already installed. Use `install-skill codex --force` only when intentionally updating it. |
