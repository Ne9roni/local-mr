# Contributing

English | [简体中文](docs/zh-CN/CONTRIBUTING.md)

## Local setup

```bash
nvm use
npm ci
npm run install:link
```

If you do not use nvm, install Node.js 22 or later directly.

The repository includes an optional staged-secret hook for contributors who already have [Gitleaks](https://github.com/gitleaks/gitleaks) on their `PATH`. Check whether you already use a custom hook path before enabling it:

```bash
git config --local --get core.hooksPath
git config --local core.hooksPath .githooks
```

If another hook path is configured, integrate the Gitleaks command there instead of replacing it. Disable the repository hook with `git config --local --unset core.hooksPath`.

## Verification

- `npm run lint` checks JavaScript, Shell, and embedded browser-script syntax.
- `npm run test:unit` verifies pure logic such as the version model and server-side rendering.
- `npm run test:integration` uses temporary Git repositories to verify the CLI, HTTP endpoints, caches, installation, and state persistence.
- `npm run test:browser` uses headless Chrome to verify Markdown, Mermaid, and Diff interactions.
- `npm run build:demo` regenerates the static self-review from the repository's first two commits.
- `npm run check:demo` verifies that the committed Demo matches a clean regeneration.
- `npm run check` runs lint, Demo verification, unit tests, and integration tests.
- `npm run verify` adds the browser suite.

GitHub CI also scans the complete Git history with Gitleaks. The optional pre-commit hook scans staged changes before a commit is created.

Prefer tests at public boundaries: the CLI, HTTP responses, or real browser behavior. Run at least `npm run check` for documentation-only changes and `npm run verify` for UI, rendering, or Markdown changes. Changes to the shared review UI, renderer, or Demo plan must include a regenerated Demo. The Demo builder needs the first two commits, so fetch the complete history before running it from a shallow clone.

## Conventions

- JavaScript modules use ESM, four-space indentation, and semicolons. Embedded CSS and JavaScript in HTML use two-space indentation.
- Shell scripts use Bash and `set -euo pipefail`; always quote variable expansions.
- Never write to the real Git index of the repository being reviewed. Worktree snapshots must use a temporary index.
- Every new cache must have an explicit capacity limit and invalidation basis.
- Browser code must never insert Git file content directly as untrusted HTML.

## Sensitive data

Treat everything committed to the repository as public. Do not include credentials, private repository data, live review URLs, or unsanitized logs and screenshots. Use neutral synthetic fixtures and reserved test domains; agent-generated content follows the same rule.

If a real credential is exposed, rotate or revoke it before cleanup. A later deletion commit does not remove it from Git history.

## Merge requests

MR descriptions should explain behavior changes, verification commands, and risk boundaries. Keep each commit focused on one concern. Explicitly describe security implications when changing worktree snapshots, path parsing, browser HTML, or persisted state.
