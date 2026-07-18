# Architecture

English | [简体中文](zh-CN/architecture.md)

local-mr is a local-first Git review tool. Its default workflow builds a selectable model from the target branch, real commits, and worktree, serves one review session on the loopback interface, and renders file diffs on demand in the browser. Real review initially selects the merge base through the latest committed `HEAD`; the worktree remains available only through an explicit selection. A separate `virtual-commit` workflow lets an agent reorganize a strictly committed, frozen comparison into a persistent reading sequence without changing the real review.

This document describes implementation boundaries. For the user workflow, CLI lifecycle, manifest schema, and troubleshooting, see the [Virtual Commit guide](virtual-commits.md).

## Core constraints

1. Never modify the real Git index of the repository being reviewed.
2. Default Real review to the latest committed comparison. Expose staged, unstaged, and untracked files only through an explicit worktree selection.
3. Bind the HTTP server only to `127.0.0.1` and use a random path token for every server instance.
4. Insert Git file content into the browser DOM only as text or sanitized Markdown.
5. Give every in-memory cache both a capacity limit and invalidation keys tied to repository state.
6. Treat virtual commits only as review projections: never write them to the worktree, real index, refs, commits, or a remote MR.

## Data flow

```text
bin/local-mr
  ├─ Detect the target ref, layout, and color mode
  ├─ Compute a runtime fingerprint and reuse a healthy local server
  └─ Print an HTML snapshot and a tokenized review URL
             │
             ▼
src/version-server.mjs
  ├─ Build the version model and comparison patch
  ├─ Render the page shell and cache individual file fragments
  ├─ Serve version, file, context, and read-state endpoints
  └─ Shut down after the idle timeout
             │
             ▼
src/review-ui.html
  ├─ Load the active file diff on demand
  ├─ Highlight visible code and newly expanded context by language
  ├─ Switch between one commit and an inclusive contiguous commit range
  ├─ Expand omitted context
  └─ Render and sanitize Markdown and Mermaid previews
```

The agent-facing workflow uses a separate command and server, but renders `/review` through the same Diff page:

```text
bin/local-mr virtual-commit
  └─ src/virtual-review-cli.mjs
       ├─ snapshot/show ──► src/virtual-review-core.mjs ──► frozen source store
       ├─ create ─────────► strict manifest validation ──► immutable revision store
       └─ open ───────────► src/virtual-review-server.mjs
                                      │
                                      ▼
                            /review via src/review-ui.html
                              ├─ Single commit: jump anywhere in review order
                              ├─ Commit range: choose two inclusive endpoints
                              ├─ Revision, navigation, and progress controls
                              └─ Virtual context and preview adapters
```

## Module responsibilities

- `src/version-model.mjs` reads one ordered Git commit list, resolves single/range selections, and snapshots an explicitly selected worktree through a temporary index.
- `src/review-render.mjs` invokes diff2html and splits the rendered output into a page shell and per-file fragments.
- `src/version-server.mjs` manages the local HTTP lifecycle, caches, persisted state, and ranged file reads.
- `src/review-ui.html` is the single changed-file/Diff workspace used by both Real and Virtual review. Both expose exactly Single commit and Commit range over their own ordered commit list; Virtual adds revision and progress controls.
- `src/virtual-diff.mjs` parses frozen comparisons into stable text blocks and materializes selected blocks into intermediate file states.
- `src/virtual-review-core.mjs` captures self-contained sources, exposes their catalog, and builds cumulative virtual-commit patches in an isolated temporary Git repository.
- `src/virtual-review-manifest.mjs` validates the versioned JSON manifest, anchored guidance, limits, and exact block assignment.
- `src/virtual-review-store.mjs` persists content-addressed source blobs, immutable review revisions, each revision's frozen branch-commit metadata, and revision-local reading progress outside the repository.
- `src/virtual-review-server.mjs` adapts immutable virtual-review data into the shared `src/review-ui.html` page, ordered single/range selections, file/context/preview endpoints, revision history with exact source commits, and progress state.
- `src/virtual-review-cli.mjs` implements the machine-readable `snapshot`, `show`, `create`, `open`, `list`, `delete`, `prune`, and explicit Skill-installation commands.
- `bin/local-mr` owns CLI arguments, target-branch detection, installation-layout compatibility, and browser launch.
- `scripts/build-demo.mjs` runs the production Virtual Commit pipeline against the repository's init and feature commits, publishes Overview and Deep revisions, and freezes the resulting review as a self-contained GitHub Pages site.

## Snapshots and caches

Real review defaults to the merge base through the latest committed `HEAD`. A user may explicitly choose a worktree endpoint to inspect staged, unstaged, or untracked changes. Such worktree comparisons use temporary `GIT_INDEX_FILE` and `GIT_OBJECT_DIRECTORY` locations. The operation initializes the temporary index from `HEAD`, reads the repository's existing objects through a read-only alternate, writes new worktree objects only into the temporary directory, and removes that directory after rendering the selection. The repository's real index and object database are never refreshed or extended.

Real comparisons and frozen Virtual sources use the same canonical Git patch format: binary payloads, full object IDs, rename detection, and no external diff or text conversion. An all-commit Real range and the complete Virtual range therefore have the same patch hash and rendered Diff, not merely the same file count. Virtual subranges materialize two isolated trees and await `diff-tree` before deleting their temporary object database.

The server maintains four bounded caches: version models, patches, full pages, and file fragments. Cache keys include `HEAD`, the target ref, the worktree fingerprint, layout, or patch content. File metadata changes, a new `HEAD`, or a changed version selection invalidate the corresponding layer. Patch, page, and fragment caches are each capped at 64 MiB and also have independent entry-count limits.

## Virtual-commit review model

`local-mr virtual-commit snapshot [--target REF]` resolves a real commit and freezes exactly the comparison from its merge base with the target ref through that commit. A worktree endpoint is invalid: staged, unstaged, untracked, and all other uncommitted changes are excluded mechanically, not by convention. The snapshot stores immutable endpoint SHAs, explicit metadata for the selected branch commit, the complete patch and SHA-256, file metadata, and the base and target content of every affected file. Ordinary text changes are divided into stable contiguous blocks. Renames, binary files, submodules, and other changes that cannot be safely split become one file-level block. The resulting `SOURCE_ID` is the sole inventory an agent may use.

The CLI is a versioned JSON protocol. `snapshot` returns a metadata catalog; `show SOURCE_ID` can return one file, one block, or the full patch so large comparisons do not have to enter an agent context at once. Successful commands write JSON to stdout, while errors—including manifest validation details—are JSON on stderr.

An agent submits a manifest with an overview, strategy, uncertainties, ordered virtual commits, anchored review focuses, risk guidance, and stable block IDs. Validation is deliberately strict: every source block must be assigned exactly once, and unknown, duplicate, or omitted blocks reject the entire manifest. `create` then materializes cumulative states in an isolated temporary Git repository and verifies that the last tree equals the frozen target tree. Intermediate virtual commits are reading steps and are not required to compile.

Opening a virtual review lands directly on `/review`; there is no standalone overview UI or separate virtual page implementation. Real and Virtual use the same browser runtime, comparison controls, changed-file tree, and diff2html post-processing. Both operate on one ordered commit list and expose exactly two modes. **Single commit** compares the selected commit with its immediately preceding state and can jump to any item in review order. **Commit range** compares the state before its first endpoint with its inclusive last endpoint; the endpoints must preserve list order, and a one-commit range is valid. Real defaults to the complete committed Commit range, follows the branch's first-parent order, and may append an explicit worktree checkpoint. A Real range beginning at the first listed commit uses the review merge base as its left boundary rather than that commit's historical parent. Consequently the full range is always the exact merge-base-to-head comparison, including after the target branch was merged into an older feature history; target-only changes cannot leak back into the review. Virtual defaults to Single commit at `V1` and uses the manifest's `V1`, `V2`, … order, adding previous/next navigation, reviewed progress, and a revision selector. That selector resolves every revision's own source snapshot and displays its branch commit SHA, subject, and branch, rather than assuming all revisions describe live `HEAD`. Both sources populate one `focusedCommit` client model and one shared context panel above the Diff: Real maps the selected Git subject/body, while Virtual maps manifest title/intent/review focus/risk into an agent-authored reading index. The virtual server otherwise only adapts frozen data into fragment, context, Markdown preview, and progress services. Context is materialized from the state immediately before the selected interval, including every earlier virtual block, so expanding V2 never leaks the original base in place of V1's already-applied code. Legacy `mode=push` links are accepted only as a compatibility alias and canonicalized to Single commit or Commit range.

Creating without `--review` starts a new review. Reusing a review ID appends a numbered, immutable revision; `--expected-revision` provides optimistic concurrency control. A revision retains its own `sourceId`, so revisions in one review may legitimately point to different branch commits—for example, a new reading plan generated later from an older frozen commit. Each revision has independent viewed/reviewed progress, and `list` reports the exact branch commit associated with each one. The page checks the live comparison hash when the original repository remains available and marks the frozen source stale if it changed, but it never remaps old blocks.

Real and Virtual reviews remain separate loopback services. A token-protected `/real` route on the virtual server invokes the ordinary `local-mr` launcher with the source's frozen base, head, and target SHAs, then passes a validated virtual-review backlink into the real server. The frozen comparison has its own runtime identity and never reuses a live-HEAD server; repository drift and stale per-branch target configuration therefore cannot change its file set. Legacy or worktree-backed sources without one complete committed SHA tuple are rejected instead of being silently recomputed. The real page preserves the backlink while users change Single commit/Commit range selections. Switching back restores the exact virtual revision, mode and selection endpoints, and focused file; neither service needs to share mutable state.

The saved source is self-contained for the affected files, so its review remains available when the original repository is moved or removed. Reviews, revisions, full patches, and content-addressed blobs live under `$XDG_STATE_HOME/local-mr/virtual-reviews`, or `~/.local/state/local-mr/virtual-reviews` when `XDG_STATE_HOME` is unset. `list` discovers reviews, `open` reopens a revision, `delete` removes a review or revision, and `prune` removes source snapshots and blobs that no remaining revision references.

The bundled `local-mr-virtual-commits` Codex Skill owns the human-guided review depth and reading-order policy; it is not an engine dependency and is installed only through `local-mr virtual-commit install-skill codex [--force]`. This keeps model choice, grouping granularity, and reading strategy outside the deterministic snapshot, validation, persistence, and rendering core.

## Self-review Demo

The public Demo is not a hand-written mock. Its Real side compares this repository's init commit with the commit that introduced Virtual Commits. The same frozen source is then passed through the production manifest validator and materializer twice: revision 1 provides a six-step Overview, while revision 2 provides a fourteen-step Deep review. Both start with documentation and leave release metadata until the end.

The builder proves that each revision's final tree equals the Real commit and that its complete patch is byte-for-byte equivalent to the Real comparison before writing any static pages. It pre-generates Single commit and Commit range routes, both Diff layouts, file fragments, expanded context, and Markdown previews. The result can run without a local server, but it uses the same `src/review-ui.html` and rendering code as the CLI rather than a second Demo UI.

## Security boundaries

- The server listens on the loopback interface and prefixes every application route with a random token. Ready-file permissions are `0600`.
- Virtual-review servers have the same loopback and random-token boundary. Their state directories use `0700` and stored files use `0600`.
- The virtual-review state contains full patches and private source content. It is outside the repository but remains sensitive persistent data and must not be shared through URLs, logs, or state-directory copies.
- Default responses prohibit shared caching. Static runtime assets permit only short-lived private caching.
- Repository paths must be normalized relative POSIX paths; NUL bytes, backslashes, and directory traversal are rejected.
- Ordinary diff context enters the DOM through `textContent`. Markdown HTML is sanitized by DOMPurify before insertion.
- Markdown previews are limited to 2 MiB. Binary files do not expose text context.
- Read-state tokens have count and length limits and are persisted through locking and atomic replacement.

## Test strategy

- Unit tests cover the version model, patch summaries, and rendered-page splitting.
- Virtual-review unit tests cover block parsing and materialization, strict manifest conservation, immutable revisions, revision-local progress, and content-addressed storage.
- Integration tests use real temporary Git repositories to cover the CLI, caches, HTTP ranges, installation and uninstallation, and concurrent state writes.
- Browser tests use headless Chrome to cover syntax highlighting, Markdown sanitization, Mermaid, side-by-side and line-by-line diffs, context expansion, navigation, and equivalent Real/Virtual rendering through the shared workspace.
- Demo regression tests verify both revisions, Real/Virtual switching, Single commit and complete Commit range routes, repository links, and the frozen source metadata.
- GitHub CI runs core checks on Node.js 22 and 24 and Chrome regressions on Ubuntu 24.04.
