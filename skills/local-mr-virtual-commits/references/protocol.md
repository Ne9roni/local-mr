# Virtual commit CLI protocol

Treat IDs as opaque strings. Successful commands write exactly one JSON value to stdout. Failures exit nonzero and write one machine-readable JSON error to stderr.

## Commands

```text
local-mr virtual-commit snapshot [--target REF] [--mode MODE --from VALUE --to VALUE]
local-mr virtual-commit show SOURCE_ID [--file PATH | --block ID | --full]
local-mr virtual-commit create SOURCE_ID [--manifest FILE] [--review ID] [--expected-revision N] [--no-open]
local-mr virtual-commit open REVIEW_ID [--revision NUMBER] [--no-open]
local-mr virtual-commit list
```

- `snapshot` freezes the selected comparison. Omit all options to use local-mr's detected target and default comparison. Supply `--target` to select another target. Supply `--mode`, `--from`, and `--to` together to select an existing comparison range. Its `source.branchCommit` identifies the exact real branch commit at the frozen `to` endpoint; `source.files` is the metadata catalog to inspect first.
- `show SOURCE_ID` returns the metadata catalog as `item`. `--file` returns that file's blocks plus frozen base and target text. For ordinary text, `--block` returns only the selected block and its `oldLines`/`newLines`, without repeating the whole file; a special file-level block includes its complete text when text exists. `--full` returns the complete frozen patch. Use only one selector and prefer the narrowest request. Quote paths exactly as returned.
- `create` reads the manifest from stdin when `--manifest` is omitted or is `-`; otherwise it reads the named file. From this Skill, call it only after the user has explicitly approved the latest displayed ordered title list. Omit `--no-open` so local-mr opens the browser, redirect stdout to a mode-`0600` temporary file, and remove that file immediately after checking the exit status. Omit `--review` to create a review. Supply an existing review ID to append an immutable revision, and pass its latest revision as `--expected-revision` to reject concurrent updates.
- `open` starts or reuses the loopback review server for an existing saved review. From this Skill, let it open the browser and protect stdout in the same way as `create`. Omit `--revision` for the newest revision.
- `list` returns saved reviews and revisions. Every revision includes `branchCommit` metadata resolved from its own source, so do not assume that revision order and branch commit order are the same. Use it only to resolve an existing review requested by the user.

Success responses include root-level `schemaVersion: 1` and `ok: true`. The command response shapes are:

```json
{"schemaVersion":1,"ok":true,"source":{"schemaVersion":1,"sourceId":"opaque","diffHash":"hex","repository":{"branchName":"branch"},"branchCommit":{"sha":"full-sha","shortSha":"short-sha","subject":"subject"},"selection":{},"summary":{},"files":[]}}
{"schemaVersion":1,"ok":true,"item":{}}
{"schemaVersion":1,"ok":true,"reviewId":"opaque","revision":1,"sourceId":"opaque","reviewUrl":"http://127.0.0.1:PORT/TOKEN/..."}
{"schemaVersion":1,"ok":true,"reviewId":"opaque","revision":1,"reviewUrl":"http://127.0.0.1:PORT/TOKEN/..."}
{"schemaVersion":1,"ok":true,"reviews":[{"reviewId":"opaque","revisions":[{"revision":1,"sourceId":"opaque","branchCommit":{"sha":"full-sha","shortSha":"short-sha","subject":"subject","branchName":"branch"}}]}]}
```

These lines correspond to `snapshot`, `show`, `create`, `open`, and `list`. Treat `reviewUrl` as a local secret: never print it, log it, commit it, or include it in an agent response. The Skill should open the browser instead.

## Manifest

Submit UTF-8 JSON with exactly this top-level shape:

```json
{
  "schemaVersion": 1,
  "title": "Review the request-routing change",
  "strategy": "Deep review · dependency-aware core/risk-first",
  "overview": {
    "summary": "Introduce policy-driven request routing and cover fallback behavior.",
    "routeRationale": "Establish the policy types, inspect the risky selection path, then verify integrations and tests.",
    "uncertainties": [
      {
        "text": "The deployment source of this generated table is unclear.",
        "targets": ["block:b_opaque"]
      }
    ]
  },
  "virtualCommits": [
    {
      "title": "Define the routing policy",
      "intent": "Give the selection logic the smallest necessary conceptual foundation.",
      "reviewFocus": [
        {
          "text": "Check that policy precedence matches the intended fallback order.",
          "targets": ["block:b_opaque", "file:src/policy.ts"]
        }
      ],
      "risk": {
        "level": "high",
        "reason": "A precedence error can send production requests to the wrong backend."
      },
      "blocks": ["b_opaque", "b_other"]
    }
  ]
}
```

Apply these constraints:

- Set `schemaVersion` to integer `1`.
- Keep `title`, `strategy`, `summary`, `routeRationale`, commit titles, intents, focus text, and risk reasons concise and human-readable.
- When using the bundled Skill, record both the selected review depth and reading order in `strategy`; the engine treats this as descriptive text and enforces completeness independently.
- Express `overview.uncertainties` as zero or more `{text, targets}` objects. Never state speculation as fact.
- Give each virtual commit one to three `reviewFocus` objects.
- Encode anchors as `block:<stable-block-id>` or `file:<exact-repo-relative-path>`. Every focus and every nonempty uncertainty must have at least one valid target.
- Set `risk.level` to `low`, `medium`, `high`, or `critical`, and justify it in `risk.reason`.
- Put raw stable block IDs, without the `block:` prefix, in `blocks`.
- Assign every catalog block to one and only one virtual commit. The ordered union must equal the snapshot catalog exactly.

## Validation failures

A manifest validation error is written to stderr. Its `details` value is a flat array of independently actionable entries:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "INVALID_MANIFEST",
    "message": "Virtual review manifest is invalid",
    "details": [
      {
        "code": "MISSING_BLOCK",
        "path": "virtualCommits",
        "message": "Source block is not assigned to any virtual commit",
        "blockId": "b_missing"
      },
      {
        "code": "DUPLICATE_BLOCK",
        "path": "virtualCommits[1].blocks[0]",
        "message": "Block is assigned more than once",
        "blockId": "b_duplicate",
        "firstPath": "virtualCommits[0].blocks[2]"
      },
      {
        "code": "UNKNOWN_TARGET",
        "path": "virtualCommits[0].reviewFocus[0].targets[0]",
        "message": "Target does not exist in the source snapshot",
        "target": "block:b_unknown"
      }
    ]
  }
}
```

Handle every `details` entry by its `code`, `path`, and attached identifier. Correct only the reported plan or schema defects and retry `create` with the same source and review intent, preserving private stdout handling. Re-read relevant catalog entries when an ID or target is invalid. Do not take a new snapshot, mutate Git, discard blocks, or silently change the human's strategy to make validation pass.
