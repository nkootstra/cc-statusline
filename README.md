# cc-statusline

Usage-aware [Claude Code](https://code.claude.com) statusline. Shows your current usage in the prompt area without leaving the terminal.

## Install

```bash
npx @nkootstra/cc-statusline --plan pro
```

Use `--plan pro`, `--plan max`, or `--plan enterprise`. The installer writes the statusline command into `~/.claude/settings.json`.

Claude Code only runs custom statusline commands after the current workspace is trusted. If you see `statusline skipped · restart to fix`, accept the workspace trust prompt for the project and restart Claude Code.

### Enterprise authentication

Enterprise setup validates Claude Code's current credential against the usage API. If the credential is missing, expired, or rejected during an interactive install, cc-statusline checks `claude auth status` to explain what it found, then starts the official:

```bash
claude auth login
```

The status command is explanatory only. A successful usage API response is authoritative, and setup does not persist credentials until that validation succeeds.

| Enterprise init condition | Behavior |
|---|---|
| Valid, unexpired v4 cache with no `--force` or `--credentials-path` | Reuses the cache without credential discovery, network access, or login. |
| Missing, expired, or usage-API-rejected Claude Code credential in an interactive terminal | Checks status, starts one login, rediscovers the credential, and validates it before installation. |
| Authentication required with `--non-interactive` or without a TTY | Starts no Claude command and prints the manual login and install commands. |
| `--credentials-path=<path>` | Validates only that authoritative file. It never starts Claude login or falls back to automatic discovery. |
| Cloudflare block, rate limit, or transient network failure | Reports a retryable network failure without starting an unnecessary login. |
| Cancelled or failed login, missing post-login credentials, or failed post-login validation | Exits without activating a replacement and preserves any existing cache, installed bundle, and statusline setting. |

`--plan enterprise` selects the plan without disabling interactive authentication. `--force` bypasses a valid-looking cache and revalidates the current credential; it starts login only when that credential is missing, expired, or rejected.

For terminals or automation where prompts are unavailable, authenticate first and then run the installer explicitly:

```bash
claude auth login
npx @nkootstra/cc-statusline --plan enterprise --non-interactive
```

`--non-interactive` never starts login or prompts. It requires `--plan`; add `--force` when the cached credential must be revalidated or an existing statusline command must be replaced.

Enterprise users upgrading from a cache version before schema v4 must run Enterprise init once:

```bash
npx @nkootstra/cc-statusline --plan enterprise
```

Older caches are intentionally ignored. Until init creates a v4 cache, the statusline shows `usage — · run init` and does not launch background refreshes.

## What you'll see

- **Pro / Max**: model name plus colorized 5-hour and 7-day rate-limit utilization.
- **Enterprise**: model name plus cached monthly credits used / credits limit when monthly credits are enabled. Falls back to colorized 5-hour and 7-day rate-limit utilization. The credits figure comes from a local OAuth usage cache that is refreshed in the background every 60 seconds; a ` ~` marker appears when the cached value is older than that. The stale window is configurable with `CC_STATUSLINE_ENTERPRISE_STALE_MS` and clamped to 10–300 seconds. When Claude Code reports a non-zero current-session cost, it appears separately as `session $...`; this is Claude Code's client-side estimate and may differ from actual billing. If authentication cannot be repaired from the recorded source, the statusline shows `run init to repair auth`.

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

Removes the statusline entry from `~/.claude/settings.json`, the installed renderer, and cc-statusline's cache and diagnostics. It does not revoke or modify the Claude Code login or an explicit credential source; those remain owned by their source.

## Security note

The v4 cache at `~/.claude/cc-statusline/cache.json` is mode `0600` and contains an access token, its expiry, usage data, and credential-source provenance. It never contains a refresh token. Claude Code owns credential renewal: cc-statusline never sends a refresh token to an OAuth endpoint and never stores one. When cc-statusline reads a Claude Code credential envelope, any refresh token in that source exists in memory only during source loading and error sanitization.

## Credentials and investigation

During `init`, automatic credential discovery uses this order:

1. macOS Keychain service `Claude Code-credentials` (macOS only)
2. `~/.claude/.credentials.json`
3. `~/.claude/credentials.json`

Automatic discovery is recorded as the `Claude Code` credential source. `--credentials-path=<path>` instead records an `explicit file` source. The explicit path is authoritative: background refresh rereads that file and does not fall back to Keychain or another Claude Code credential location. The path is resolved with `realpath`, must remain a regular file inside the user's home directory, and is never printed by `doctor`.

Only the `accessToken` is copied into the cache and sent as a Bearer token to the Anthropic usage endpoint. The cache is located at `~/.claude/cc-statusline/cache.json`, or under `$CLAUDE_CONFIG_DIR/cc-statusline/cache.json` when `CLAUDE_CONFIG_DIR` is set.

Background refresh rereads the recorded source when the cached access token is near expiry, after a usage `401`, or while recovering from fatal authentication. With the `Claude Code` source, this lets cc-statusline pick up an access token renewed by Claude Code. cc-statusline itself does not rotate credentials. If source rereading cannot repair fatal authentication, run init as instructed by the statusline.

`cc-statusline doctor` reports `credential source: Claude Code` or `credential source: explicit file`, never the source path or token values. The statusline’s diagnostics cannot observe Claude Code or another application using the same account or OAuth credential; server-side/account-level evidence would be required for that.

## Diagnostics

Enterprise refresh decisions and OAuth request outcomes are recorded in a bounded, token-free JSONL log at `~/.claude/cc-statusline/debug.log`. To print the current cache state and retained diagnostic history, run:

```bash
cc-statusline doctor --logs
```

The log records endpoint labels, response status, request duration, refresh decisions, and rate-limit cooldown details. It never records access tokens, refresh tokens, authorization headers, or response bodies.

## Release

Releases are published to npm as `@nkootstra/cc-statusline` from version tags (`v*`) through the GitHub Actions release workflow. The installed executable remains `cc-statusline`.
