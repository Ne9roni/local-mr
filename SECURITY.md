# Security Policy

English | [简体中文](docs/zh-CN/SECURITY.md)

## Supported versions

Security fixes target `main` and the latest release first. Older versions may need to be upgraded before receiving a fix.

## Reporting a vulnerability

Use the repository's private **Security → Report a vulnerability** form whenever possible. Do not publish exploit details, private repository paths, source code, review URLs, access tokens, or unsanitized logs and screenshots in a public issue.

If private vulnerability reporting is not enabled, open an issue without sensitive details and ask the maintainers to establish a private communication channel.

A useful report includes:

- Affected version or commit
- Operating system, Node.js version, and browser version
- Minimal reproduction steps and security impact
- Sanitized logs or screenshots
- A possible mitigation, if known

If a credential was committed, revoke or rotate it before attempting repository cleanup. A follow-up deletion commit is not sufficient because the value remains in Git history. Coordinate any history rewrite privately before force-pushing.

## Security boundaries

The following behaviors are especially important to report:

- A non-local source can access the review server or bypass its random path token
- Path traversal, arbitrary file reads, or writes to the reviewed repository's real Git index
- Script execution through diff, Markdown, or Mermaid content
- Accidental disclosure of review URLs, source code, read state, or runtime logs
- Cache invalidation errors that expose content across repositories or versions
