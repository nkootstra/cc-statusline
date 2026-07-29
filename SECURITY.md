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
- Access or refresh token values appearing in errors, logs, diagnostic output, or subprocess arguments
- A refresh token being persisted in the cc-statusline cache or transmitted by cc-statusline
- Path traversal via `--credentials-path` or any other flag accepting a file path
- Cache or install directory created with permissions more permissive than `0600` / `0700`
- Shell injection through any subprocess invocation

The v4 cache intentionally contains the current access token so background usage requests can run without blocking the statusline. It also contains the access-token expiry, usage data, and credential-source provenance. It must never contain a refresh token.

## Implemented defences

These mitigations are already in place. Reports for bypasses are in scope; reports that assume these are absent are not:

- All subprocess spawns use `shell: false` — no shell injection via argument values
- Error messages from credential and HTTP paths are sanitised before being persisted or printed; candidate access and refresh token values are replaced with `<redacted>`
- `--credentials-path` and stored explicit-file sources are validated via `realpath` and rejected if they resolve outside the user's home directory or point to a non-regular file
- The cache file is written with mode `0600`; the install directory is created with mode `0700`
- Claude Code owns token renewal. cc-statusline rereads the selected credential source when necessary and persists only the resulting access token and expiry
- A refresh token present in a source credential envelope is read in memory only. cc-statusline never writes it to cache, logs it, passes it to a subprocess, or transmits it to an OAuth or usage endpoint

## Out of scope

An attacker with read access to the user's home directory can read cc-statusline's cached access token and may also be able to read Claude Code or explicit-file credentials at their source. Home-directory-level compromise is out of scope. A refresh token found in the cc-statusline cache, diagnostics, output, subprocess arguments, or network traffic remains in scope.
