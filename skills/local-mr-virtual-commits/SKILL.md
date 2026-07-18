---
name: local-mr-virtual-commits
description: Organize a large local-mr comparison into a persistent, human-guided sequence of virtual commits at Overview or Deep review granularity without changing Git. Use when a user wants an AI-produced or otherwise large local diff reordered for human review, requests a coarse overview or fine-grained sign-off route, wants to create or revise a virtual-commit review, or wants to reopen a saved virtual review.
---

# Local MR Virtual Commits

Turn one frozen local comparison into an ordered review projection whose blocks exactly conserve the original diff. Treat virtual commits as reading steps, never as Git commits.

Read [references/protocol.md](references/protocol.md) completely before invoking the CLI or constructing a manifest.

## Preserve the trust boundary

- Use the snapshot catalog as the sole inventory of changed blocks. Do not substitute a separately generated diff.
- Never run a Git command that changes the worktree, index, refs, commits, configuration, or remotes. Never apply a virtual commit back to Git.
- Reference only stable block IDs emitted for the frozen snapshot. Assign every block exactly once; invent, omit, duplicate, or rewrite nothing.
- Keep special file-level blocks such as binary, rename, submodule, and mode changes whole. Include them even when they are low-value review material.

## Build the review

1. Resolve any explicit review depth and reading order from the request and conversation. Treat them as independent choices. Infer **Deep review** from requests such as “split this finely” and **Overview** from requests such as “give me the big picture”; do not ask about a choice the user already supplied. If the request only reopens a saved review, skip planning and depth selection.
2. Freeze the requested local-mr comparison with `snapshot`. Keep its source ID and diff hash unchanged throughout this run.
3. If review depth is still unset, ask once after the snapshot and cite its size. Offer exactly two choices: **Deep review (recommended for large or AI-produced comparisons)** and **Overview**. State that the reading order defaults to **dependency-aware core/risk-first** unless the user supplied another order; do not ask a second question merely to confirm that default.
4. Inspect the returned file and block catalog lazily. Use `show` to request only the files and blocks needed to understand the next grouping decision; reserve `show --full` for cases that genuinely require the complete patch. Read relevant frozen context and, when useful, repository definitions, callers, data flow, and tests without modifying them.
5. Apply the selected depth without changing completeness:
   - **Overview:** Usually create 5–8 broad semantic chapters. Prefer whole-file and subsystem groupings, splitting a file only when one concern would otherwise dominate the route.
   - **Deep review:** Usually create 10–20 steps for a large comparison. Make each step answer one reviewer question, aim for roughly 400–1,000 non-generated changed lines when the block inventory permits, and place stable blocks from the same file in different steps when that improves comprehension.
   Keep indivisible blocks whole, do not manufacture boundaries to hit a count, and allow one explicit final generated/mechanical step to exceed either depth's normal size.
6. Order blocks around human understanding. By default, show the minimum required definitions and interfaces, then core or high-risk behavior, integrations and call paths, edge cases, tests, and finally generated or mechanical changes. Respect comprehension dependencies without forcing intermediate states to compile.
7. Produce a strict manifest. Record both choices in `strategy`, for example `Deep review · docs-first, then dependency/risk order`. Give each step a concise intent, one to three anchored review focuses, and an honest risk assessment. Record every material uncertainty with an anchor; use an empty array only when none remain.
8. Submit the manifest with `create` and let local-mr open the browser. Redirect stdout to a mode-`0600` temporary file so its tokenized loopback URL never enters the conversation or logs, then delete the file. On a machine-readable validation failure from stderr, correct the indicated manifest fields or block assignments and retry against the same source. Never hide an omission by adding an automatic catch-all group.
9. Do not extract, print, or return `reviewUrl`. Use `open` with the same private-output handling to reopen an existing saved review. Finish with a concise description of the route and state that the review was opened in the browser.

When changing an existing review, create a new revision under its review ID. Reset the reading plan rather than assuming prior progress. Create a separate review ID when the user wants an alternative strategy instead of a revision.
