# cc-statusline

Usage-aware [Claude Code](https://code.claude.com) statusline. Shows your current usage in the prompt area without leaving the terminal.

## Install

```bash
npx @nkootstra/cc-statusline
```

No plan choice is needed. The installer writes one `render` command into `~/.claude/settings.json`, and every render picks its layout from what Claude Code sends (see [What you'll see](#what-youll-see)). If Claude Code's login works with the usage API, init also writes a usage cache. The cache adds per-model weekly windows such as Fable (Claude Code 2.1.278 does not forward those on its statusline payload) and Enterprise spend credits. You can switch between a personal subscription and an Enterprise seat with `/login` without re-running init.

`--plan` is now an optional override:

| Flag | Behavior |
|---|---|
| none | Tries Claude Code's credentials. If they are missing or rejected, it installs anyway without a cache: 5h/7d still show from the payload. Interactive terminals get a `y/N` offer to run `claude auth login` (default No); non-interactive installs print a one-line hint instead. |
| `--plan pro` | Installs `render --payload-only`. It never reads credentials, writes a cache, or starts a background refresh. |
| `--plan max`, `--plan enterprise` | Require valid credentials at install, as before (see below). They install the same `render` command. |

Pro accounts can use Fable as well, but Anthropic bills it there from usage credits rather than from a weekly Fable allowance ([Claude Fable models on your plan](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan)), so a Pro account has no per-model window to show.

Existing `render-promax` and `render-enterprise` settings keep working as aliases (`render --payload-only` and `render`). Re-running init rewrites them to the new command without a conflict prompt.

Claude Code only runs custom statusline commands after the current workspace is trusted. If you see `statusline skipped · restart to fix`, accept the workspace trust prompt for the project and restart Claude Code.

### Max and Enterprise authentication

With `--plan max` or `--plan enterprise`, setup requires Claude Code's current credential to pass the usage API. If the credential is missing, expired, or rejected during an interactive install, cc-statusline checks `claude auth status` to explain what it found, then starts the official:

```bash
claude auth login
```

The status command is explanatory only. A successful usage API response is authoritative, and setup does not persist credentials until that validation succeeds.

| `--plan max` / `--plan enterprise` init condition | Behavior |
|---|---|
| Valid, unexpired v4 cache with no `--force` or `--credentials-path` | Reuses the cache without credential discovery, network access, or login. |
| Missing, expired, or usage-API-rejected Claude Code credential in an interactive terminal | Checks status, starts one login, rediscovers the credential, and validates it before installation. |
| Authentication required with `--non-interactive` or without a TTY | Starts no Claude command and prints the manual login and install commands. |
| `--credentials-path=<path>` (with or without `--plan`) | Validates only that authoritative file. It never starts Claude login or falls back to automatic discovery. |
| Cloudflare block, rate limit, or transient network failure | Reports a retryable network failure without starting an unnecessary login. Without `--plan`, init reports it and installs without a cache. |
| Cancelled or failed login, missing post-login credentials, or failed post-login validation | Exits without activating a replacement and preserves any existing cache, installed bundle, and statusline setting. |

`--force` bypasses a valid-looking cache and revalidates the current credential; it starts login only when that credential is missing, expired, or rejected.

For terminals or automation where prompts are unavailable, authenticate first and then run the installer:

```bash
claude auth login
npx @nkootstra/cc-statusline --non-interactive
```

`--non-interactive` never starts login or prompts. Add `--force` when the cached credential must be revalidated or an existing statusline command must be replaced.

Users upgrading from a cache version before schema v4 must run init once:

```bash
npx @nkootstra/cc-statusline
```

Older caches are intentionally ignored. Until init creates a v4 cache, an account whose payload has no rate limits shows `usage — · run init` and does not launch background refreshes.

## What you'll see

The `render` command chooses a layout on every render:

| Claude Code payload | Usage cache | Shows |
|---|---|---|
| Gateway mode | ignored | model and context only (see [LLM gateways](#llm-gateways)) |
| `rate_limits.five_hour` or `seven_day` present (Pro and Max) | any | 5h/7d from the payload, plus per-model weekly windows and `extra $used / $limit` from the cache when it has them |
| no rate limits, cache has monthly credits (Enterprise) | present | credits used / limit |
| no rate limits, cache has 5h/7d | present | 5h/7d from the cache (before Claude Code's first API response) |
| no rate limits | missing | `usage — · run init` |

The statusline uses two lines: the model, context usage, and prompt cache hit ratio on the first, and usage figures on the second. Every plan shows the session's prompt cache hit ratio after the context figure, for example `cache 87%`. It is the share of all input tokens this session that were read from cache, as reported by Claude Code (2.1.251 or later) on the statusline payload. Green means at least 80%, yellow at least 50%, red below that. The segment is dimmed once the cached prefix has outlived its TTL, and it is omitted until the session's first API response or when no response has reported cache tokens.

- **Pro and Max**: model name plus colorized 5-hour and 7-day utilization straight from Claude Code, so they are never older than the last API response. Per-model weekly windows from the usage endpoint's `limits` rows (for example Fable) follow under the label the server sends, with their own reset time shown only when it differs from the 7-day reset. If Claude Code ever forwards those windows on its payload, the payload wins. Max accounts with extra usage enabled keep this layout and get a trailing `extra $used / $limit` segment. Without a cache you see only the payload figures, with no `run init` nag. Claude Code's session cost appears as `$...`.
- **Enterprise**: model name plus cached monthly credits used / credits limit, then per-model weekly windows. When Claude Code reports a non-zero current-session cost, it appears separately as `session $...`; this is Claude Code's client-side estimate and may differ from actual billing.

Cached figures come from a local OAuth usage cache that is refreshed in the background every two minutes; a ` ~` marker appears when the cached value is older than that. The stale window is configurable with `CC_STATUSLINE_ENTERPRISE_STALE_MS` and clamped to 10–900 seconds. If the payload shows 5h/7d but the cache holds only credits, the cache most likely belongs to the account you just switched away from: its figures are hidden and a refresh starts within a minute. If authentication cannot be repaired from the recorded source, the statusline shows `run init to repair auth`.

The renderer also enforces a cooldown after API `429` responses. The usage endpoint's limit is shared by every client signed in to the same account, including Claude Code itself and tools such as CodexBar, so a 429 usually means another client used the quota. If the server sends a `Retry-After` delay, cc-statusline waits that long; without one it waits five minutes, the same default CodexBar uses. Each further consecutive 429 doubles the wait, bounded to fifteen minutes. A single 429 only leaves the ` ~` marker on the last known figures; the ` rate-limited; retry in …` hint appears once two refreshes in a row have been rejected.

Example Pro output:

```text
Opus 4.7 · ctx 42% · cache 87%
5h 102% · 7d 81% [Tue 20:00]
```

Example Max output (with extra usage enabled):

```text
Opus 4.7 · ctx 42% · cache 87%
5h 102% · 7d 81% [Tue 20:00] · Fable 12% · extra $780.00 / $1000.00
```

Example Enterprise output with monthly credits:

```text
Opus 4.7 · ctx 42% · cache 87%
credits $780.00 / $1000.00 (78%) · Fable 12% [Tue 20:00] · session $0.08
```

### LLM gateways

When Claude Code is routed through a different LLM gateway or provider, subscription usage does not apply, so every plan shows only the model, context usage, and prompt cache hit ratio, and the renderer skips the background usage refresh. Gateway mode is on when `ANTHROPIC_BASE_URL` points at a host outside `anthropic.com`, or when `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, or `CLAUDE_CODE_USE_FOUNDRY` is set to `1`, `true`, `yes`, or `on`. The statusline inherits Claude Code's environment, including the `env` block in `settings.json`.

```text
Opus 4.7 · ctx 42% · cache 87%
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

1. macOS Keychain service `Claude Code-credentials` for the current user's account, the item Claude Code itself reads and writes, then the same service for any account (macOS only)
2. `~/.claude/.credentials.json`
3. `~/.claude/credentials.json`

Automatic discovery is recorded as the `Claude Code` credential source. When a discovered credential cannot be decoded, init names the source and the offending envelope field; it never prints token values or an explicit `--credentials-path` path. `--credentials-path=<path>` instead records an `explicit file` source. The explicit path is authoritative: background refresh rereads that file and does not fall back to Keychain or another Claude Code credential location. The path is resolved with `realpath`, must remain a regular file inside the user's home directory, and is never printed by `doctor`.

Only the `accessToken` is copied into the cache and sent as a Bearer token to the Anthropic usage endpoint. The cache is located at `~/.claude/cc-statusline/cache.json`, or under `$CLAUDE_CONFIG_DIR/cc-statusline/cache.json` when `CLAUDE_CONFIG_DIR` is set.

Background refresh rereads the recorded source on every refresh (at most once per stale window, in the detached refresh process, never while rendering). With the `Claude Code` source, this lets cc-statusline pick up an access token renewed by Claude Code, and follow `/login` to another account even while the previous account's token is still valid. When the reread token differs from the cached one and the usage fetch then fails, cc-statusline adopts the new token and clears the cached figures instead of showing the previous account's usage. If the reread itself fails while the cached token is still valid, the refresh continues with the cached token. cc-statusline itself does not rotate credentials. If source rereading cannot repair fatal authentication, run init as instructed by the statusline.

`cc-statusline doctor` reports `credential source: Claude Code` or `credential source: explicit file`, never the source path or token values. The statusline’s diagnostics cannot observe Claude Code or another application using the same account or OAuth credential; server-side/account-level evidence would be required for that.

## Diagnostics

Refresh decisions and OAuth request outcomes are recorded in a bounded, token-free JSONL log at `~/.claude/cc-statusline/debug.log`. To print the current cache state and retained diagnostic history, run:

```bash
cc-statusline doctor --logs
```

`doctor` also reports the layout detected from the cached usage (`5h/7d windows`, `5h/7d windows + extra spend`, or `credits`), when the diagnostics last saw the access token change (a Claude Code renewal or a `/login` account switch), and whether `--plan pro` overrides layout detection.

The log records endpoint labels, response status, request duration, refresh decisions, and rate-limit cooldown details. It never records access tokens, refresh tokens, authorization headers, or response bodies.

## Release

Releases are published to npm as `@nkootstra/cc-statusline` from version tags (`v*`) through the GitHub Actions release workflow. The installed executable remains `cc-statusline`.
