# cc-statusline

Usage-aware [Claude Code](https://code.claude.com) statusline. Shows your current usage in the prompt area without leaving the terminal.

## Install

```bash
npx @nkootstra/cc-statusline --plan pro
```

Use `--plan pro`, `--plan max`, or `--plan enterprise`. The installer writes the statusline command into `~/.claude/settings.json`.

Claude Code only runs custom statusline commands after the current workspace is trusted. If you see `statusline skipped · restart to fix`, accept the workspace trust prompt for the project and restart Claude Code.

## What you'll see

- **Pro / Max**: model name plus colorized 5-hour and 7-day rate-limit utilization.
- **Enterprise**: model name plus cached monthly credits used / credits limit when monthly credits are enabled. Falls back to colorized 5-hour and 7-day rate-limit utilization. The credits figure comes from a local OAuth usage cache that is refreshed in the background every 60 seconds; a ` ~` marker appears when the cached value is older than that. The stale window is configurable with `CC_STATUSLINE_ENTERPRISE_STALE_MS` and clamped to 10–300 seconds. When Claude Code reports a non-zero current-session cost, it appears separately as `session $...`; this is Claude Code's client-side estimate and may differ from actual billing.

The enterprise renderer also enforces a cooldown after API `429` responses. If the server asks a retry delay, cc-statusline will wait before refreshing usage again, and this cooldown can grow across repeated 429s (bounded to five minutes) to avoid repeated rate-limit churn.

Pro and Max use the same renderer. They are separate installer choices only because Claude users know their subscription by those names; Claude Code exposes the same statusline usage fields for both.

Example Pro / Max output:

```text
Opus 4.7 · 5h 102% · 7d 81% [Tue 20:00]
```

Example Enterprise output:

```text
Opus 4.7 · credits $780.00 / $1000.00 (78%) · session $0.08
```

## Check version

```bash
npx @nkootstra/cc-statusline --version
```

`-v` works too.

## Uninstall

```bash
npx @nkootstra/cc-statusline uninstall
```

Removes the statusline entry from `~/.claude/settings.json` and deletes the installed renderer. The OAuth refresh token is **not** revoked — it expires naturally.

## Security note

cc-statusline reads Claude Code's stored OAuth credential (macOS keychain or `~/.claude/.credentials.json`) once at install and copies it to `~/.claude/cc-statusline/cache.json` (mode `0600`). This file is rewritten as the token rotates. Compromise of your home directory exposes the same tokens Claude Code already exposes there.

## Credentials and investigation

During `init`, automatic credential discovery uses this order:

1. macOS Keychain service `Claude Code-credentials` (macOS only)
2. `~/.claude/.credentials.json`
3. `~/.claude/credentials.json`

`--credentials-path=<path>` overrides automatic discovery. The discovered OAuth envelope contains an `accessToken`, a `refreshToken`, and an expiry time. cc-statusline copies those values into its local cache and uses that cache for subsequent requests. The cache is located at `~/.claude/cc-statusline/cache.json`, or under `$CLAUDE_CONFIG_DIR/cc-statusline/cache.json` when `CLAUDE_CONFIG_DIR` is set.

The `accessToken` is sent as a Bearer token to the usage endpoint. The `refreshToken` is sent to the OAuth token endpoint only when the access token is close to expiry; rotated credentials are then written back to the local cache. Reinstalling with `--force` can therefore replace the local cache with credentials rediscovered from the original source.

`cc-statusline doctor` reports that API calls use the local cache. Current cache versions do not retain whether the cache was originally populated from Keychain, a credentials file, or `--credentials-path`, so `doctor` reports that origin as “not recorded.” The statusline’s diagnostics also cannot observe Claude Code or another application using the same account or OAuth credential; server-side/account-level evidence would be required for that.

## Diagnostics

Enterprise refresh decisions and OAuth request outcomes are recorded in a bounded, token-free JSONL log at `~/.claude/cc-statusline/debug.log`. To print the current cache state and retained diagnostic history, run:

```bash
cc-statusline doctor --logs
```

The log records endpoint labels, response status, request duration, refresh decisions, and rate-limit cooldown details. It never records access tokens, refresh tokens, authorization headers, or response bodies.

## Release

Releases are published to npm as `@nkootstra/cc-statusline` from version tags (`v*`) through the GitHub Actions release workflow. The installed executable remains `cc-statusline`.
