# Security Policy

## Supported versions

This project is pre-1.0. Only the latest published version on npm receives security fixes.

| Version | Supported |
| ------- | --------- |
| latest  | yes       |
| older   | no        |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately via either channel:

- **GitHub**: use [Security → Report a vulnerability](../../security/advisories/new) on this repository (private vulnerability reporting is enabled)
- **Email**: niels.kootstra@pm.me

Include as much detail as you can: steps to reproduce, affected version, and what you believe the impact to be. Please redact any token values from logs or output you share.

I aim to acknowledge reports within **7 days**. Resolution timeline depends on severity; critical issues are prioritised.

## Scope

The following are in scope:

- Credential or token exposure beyond the documented home-directory baseline (see [Out of scope](#out-of-scope))
- Token values appearing in error messages, logs, or cache files
- Path traversal via `--credentials-path` or any other flag accepting a file path
- Cache or install directory created with permissions more permissive than `0600` / `0700`
- Shell injection through any subprocess invocation

## Implemented defences

These mitigations are already in place. Reports for bypasses are in scope; reports that assume these are absent are not:

- All subprocess spawns use `shell: false` — no shell injection via argument values
- Error messages are sanitised before being written to cache: access and refresh token values are replaced with `<redacted>`
- `--credentials-path` is validated via `realpath` and rejected if it resolves outside the user's home directory or points to a non-regular file
- The cache file is written with mode `0600`; the install directory is created with mode `0700`

## Out of scope

If an attacker already has read access to your home directory, they can read the same OAuth tokens that Claude Code stores at `~/.claude/.credentials.json`. The cache at `~/.claude/cc-statusline/cache.json` does not increase that exposure. Home-directory-level compromise is out of scope.
