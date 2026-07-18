# Project instructions

## Public repository

Treat tracked files, fixtures, generated artifacts, screenshots, commit messages, and publishable tool output as public.

- Never include credentials, private repository content or metadata, live local-mr review URLs, workstation paths, or personal contact data.
- Create examples and test fixtures from neutral synthetic input; do not copy them from prompts, logs, or another source checkout.
- Keep sensitive configuration in environment variables or GitHub Secrets.
- Run `npm run check` before committing. CI separately scans the complete Git history with Gitleaks.

If a real credential is exposed, rotate or revoke it first. Deleting it in a later commit does not remove it from Git history.
