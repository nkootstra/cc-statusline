# cc-statusline

Usage-aware [Claude Code](https://code.claude.com) statusline. It shows your plan usage, context window, and prompt cache hit ratio in the prompt area, so you never have to leave the terminal to check how much of your 5-hour, weekly, per-model, or Enterprise credit allowance is left.

```text
Opus 4.7 · ctx 42% · cache 87%
5h 61% [18:30] · 7d 81% [Tue 20:00] · Fable 12% · extra $780.00 / $1000.00
```

## Key features

- **One installer for every plan.** The installer writes a single `render` command. On every render it picks the layout from what Claude Code sends: 5h/7d windows for Pro and Max, monthly spend credits for Enterprise. You don't choose a plan, and `/login` account switches are followed without re-running init.
- **Per-model weekly windows** (for example Fable) and Max extra-usage spend, taken from Anthropic's OAuth usage endpoint. Claude Code does not forward these on its statusline payload.
- **Prompt cache hit ratio** for the session, colour-coded and dimmed once the cache has gone cold.
- **Rendering never blocks.** Every render reads only stdin and a local cache. Network work runs in a detached background process that respects rate limits.
- **Credentials stay with Claude Code.** cc-statusline reuses Claude Code's login, keeps only the access token in a `0600` cache, never stores a refresh token, and never renews credentials itself.
- **LLM gateway aware.** With Bedrock, Vertex, Foundry, or a custom `ANTHROPIC_BASE_URL`, the usage lookup is skipped.

## Table of contents

- [Requirements](#requirements)
- [Install](#install)
  - [What changed in the installer (`--plan` removed)](#what-changed-in-the-installer---plan-removed)
  - [Init options](#init-options)
  - [Authentication](#authentication)
  - [Non-interactive and CI installs](#non-interactive-and-ci-installs)
  - [Upgrading](#upgrading)
- [What you'll see](#what-youll-see)
  - [Layout selection](#layout-selection)
  - [Segments](#segments)
  - [Freshness, refresh, and rate limits](#freshness-refresh-and-rate-limits)
  - [LLM gateways](#llm-gateways)
- [Commands](#commands)
- [Environment variables](#environment-variables)
- [Files](#files)
- [Credentials](#credentials)
- [Security](#security)
- [Diagnostics](#diagnostics)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [How it works](#how-it-works)
- [Development](#development)
- [Release](#release)
- [License](#license)

## Requirements

- Node.js 22 or later on `PATH`. Claude Code runs the statusline with your environment.
- Claude Code. The cache hit ratio segment needs Claude Code 2.1.251 or later.
- Optional: a Claude Code login (`claude auth login`) to show per-model windows, Max extra usage, and Enterprise credits. Without it you still get the 5h/7d figures Claude Code sends.
- macOS, Linux, or Windows. CI runs on Windows too.

## Install

```bash
npx @nkootstra/cc-statusline
```

Then restart Claude Code. Running with no arguments, with any `--flag`, or with the explicit `init` subcommand all do the same thing.

Init does the following:

1. Copies the bundled renderer to `~/.claude/cc-statusline/cc-statusline.js` (or `$CLAUDE_CONFIG_DIR/cc-statusline/`).
2. Tries Claude Code's credentials against the usage API. If they work, it writes a usage cache (see [Credentials](#credentials)).
3. Writes this `statusLine` block into `~/.claude/settings.json`:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "/Users/you/.claude/cc-statusline/cc-statusline.js render",
       "padding": 2,
       "refreshInterval": 10
     }
   }
   ```

   On Windows the command is `node <path>\cc-statusline.js render`.

Claude Code only runs custom statusline commands in trusted workspaces. If you see `statusline skipped · restart to fix`, accept the workspace trust prompt for the project and restart Claude Code.

### What changed in the installer (`--plan` removed)

Up to 0.10.0 the installer needed `--plan pro|max|enterprise` and installed a plan-specific renderer. That is gone:

- **`--plan` is removed.** The layout is detected on every render. The flag is still accepted so old instructions keep working, but init ignores it and prints `init: --plan is no longer needed and is ignored`.
- **Payload-only mode is removed.** Settings written by older versions (`render-promax`, `render-enterprise`, `render --payload-only`) keep working as aliases of `render`. Re-running init rewrites them without the replace prompt.
- **Failed credentials never block the install.** Without a usable login, init installs without a cache and 5h/7d still show from the payload.
- **A bare `npx @nkootstra/cc-statusline` installs.** It used to print the help text; use `--help` for that now.
- **No re-init is needed** after upgrading from 0.10.0. The cache schema is still v4.

Pro accounts can use Fable as well, but Anthropic bills it from usage credits there rather than from a weekly Fable allowance ([Claude Fable models on your plan](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan)). A Pro account therefore has no per-model window to show.

### Init options

```text
cc-statusline [init] [--credentials-path=<path>] [--non-interactive] [--force]
```

| Flag | Description |
|---|---|
| `--credentials-path=<path>` | Use this credential file instead of automatic discovery. Only the `=` form is accepted. See [Credentials](#credentials). |
| `--non-interactive` | Never prompt and never start `claude auth login`. Also implied when stdin or stdout is not a TTY. |
| `--force` | Revalidate credentials even when a valid cache exists, and replace a different existing `statusLine.command` without asking. |
| `--plan …` | Ignored, with a notice. Kept for old instructions. |

If `settings.json` already has a different `statusLine.command`, init asks `Replace? (y/n)` before making any changes. Answer `n` and nothing is changed. Without a TTY, or with `--non-interactive`, init exits with code 2 unless you pass `--force`. A replaced `statusLine` block is overwritten entirely, so custom fields in it are dropped.

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Installed (with or without a cache), already installed, or replace prompt declined |
| `1` | Unknown command or flag, or an unexpected crash |
| `2` | Settings conflict without `--force`, or a `--credentials-path` that is invalid or unreadable |
| `3` | Login failed, or the credential was rejected after login or from `--credentials-path` |
| `4` | Network failure while validating the credential after login or from `--credentials-path` |
| `130` | Interrupted (Ctrl-C / Ctrl-D at a prompt) |

### Authentication

Failed credentials never block the install: init falls back to a cache-less install. In an interactive terminal it first offers:

```text
No usable Claude Code credentials found. 5h/7d still show without them. Sign in now to add per-model windows or Enterprise credits? (y/N)
```

When you accept, cc-statusline runs `claude auth status` to explain what it found and then starts the official login:

```bash
claude auth login
```

`claude auth status` only feeds the explanation. A successful usage API response is what counts, and setup does not persist credentials until that validation succeeds. Both Claude commands run with a minimal environment: `PATH`, `HOME`/`USERPROFILE`, and `CLAUDE_CONFIG_DIR`.

| Init condition | Behavior |
|---|---|
| Valid, unexpired v4 cache, without `--force` or `--credentials-path` | Reuses the cache with no credential discovery, network access, or login. |
| Missing, expired, or rejected credential, interactive | Offers login (default No). On yes, starts one login, rediscovers the credential, and validates it before installing. On no, installs without a cache. |
| Missing or rejected credential with `--non-interactive` or without a TTY | Starts no Claude command, prints a one-line login hint, and installs without a cache. |
| Claude Code credential that cannot be read | Reports why and installs without a cache. |
| Cloudflare block, rate limit, or transient network failure | Reports a retryable failure and installs without a cache, without starting a login. |
| `--credentials-path=<path>` | Validates only that file and fails init if it does not work (exit 2, 3, or 4). It never starts a Claude login or falls back to automatic discovery. |
| Cancelled or failed login, missing post-login credentials, or failed post-login validation | Exits without changes. Any existing cache, installed bundle, and statusline setting are kept. |

On macOS, init prints a note before discovery because macOS may ask you to allow keychain access.

### Non-interactive and CI installs

```bash
claude auth login
npx @nkootstra/cc-statusline --non-interactive
```

`--non-interactive` never starts a login or shows a prompt. Add `--force` to revalidate the cached credential or replace an existing statusline command.

### Upgrading

Re-run `npx @nkootstra/cc-statusline` to install the latest bundle. Caches written before schema v4 are ignored on purpose. Until init creates a v4 cache, an account whose payload has no rate limits shows `usage — · run init` and starts no background refreshes.

## What you'll see

The statusline has two lines. The first shows the model, context usage, and prompt cache hit ratio. The second shows the usage figures.

Pro (payload only):

```text
Opus 4.7 · ctx 42% · cache 87%
5h 61% [18:30] · 7d 81% [Tue 20:00] · $0.42
```

Max with a usage cache and extra usage enabled:

```text
Opus 4.7 · ctx 42% · cache 87%
5h 61% [18:30] · 7d 81% [Tue 20:00] · Fable 12% · extra $780.00 / $1000.00 · $0.42
```

Enterprise with monthly credits:

```text
Opus 4.7 · ctx 42% · cache 87%
credits $780.00 / $1000.00 (78%) · Fable 12% [Tue 20:00] · session $0.08
```

### Layout selection

`render` chooses the layout on every render:

| Claude Code payload | Usage cache | Shows |
|---|---|---|
| Gateway mode | ignored | model, context, and cache ratio only (see [LLM gateways](#llm-gateways)) |
| `rate_limits.five_hour` or `seven_day` present (Pro and Max) | any | 5h/7d from the payload, plus per-model weekly windows and `extra $used / $limit` from the cache when it has them |
| no rate limits | credits enabled (Enterprise) | credits used / limit, then per-model windows |
| no rate limits | 5h/7d only | 5h/7d from the cache (before Claude Code's first API response) |
| no rate limits | present but not yet fetched | `usage — · fetching…` |
| no rate limits | missing | `usage — · run init` |

If the payload shows 5h/7d but the cache holds only credits, the cache most likely belongs to the account you just switched away from. Its figures are hidden and a refresh starts within a minute.

### Segments

| Segment | Source | Notes |
|---|---|---|
| Model name | payload | |
| `ctx N%` | payload | Context window usage. |
| `cache N%` | payload (`prompt_cache`, Claude Code ≥ 2.1.251) | Share of the session's input tokens read from cache. Green at 80% or more, yellow at 50% or more, red below that. Dimmed when Claude Code reports the cached prefix as no longer warm (past its TTL). Omitted before the first API response and when no caching has been observed. |
| `5h N%`, `7d N%` | payload, or cache as a fallback | Green below 70%, yellow from 70% to 89%, red at 90% or more. |
| `[18:30]`, `[Tue 20:00]`, `[<5m]` | reset time | Local 24-hour time. Shows only the time when the reset is today, and `<5m` when it is under five minutes away. Per-model windows show their own reset only when it differs from the 7-day reset. |
| `Fable 12%` etc. | cache (usage endpoint `limits` rows) | Per-model weekly windows, labelled with the name the server sends. If Claude Code ever forwards these on its payload, the payload wins. |
| `extra $used / $limit` | cache | Max accounts with extra usage enabled. |
| `credits $used / $limit (N%)` | cache | Enterprise monthly spend. |
| `$0.42` / `session $0.08` | payload | Claude Code's client-side session cost estimate. It may differ from actual billing. Enterprise shows it only when it is non-zero. |

Set `NO_COLOR` to any non-empty value to turn off colour and dimming.

### Freshness, refresh, and rate limits

Cache-derived figures come from a local usage cache. There is no timer: when a render finds the cache older than the stale window (default two minutes), it starts one detached background refresh. No renders means no refreshes.

- A ` ~` marker and dimming appear on cache-derived figures when they are older than the stale window. Payload 5h/7d figures never get the marker, because they are only as old as Claude Code's last API response.
- Set the stale window with `CC_STATUSLINE_ENTERPRISE_STALE_MS`, in milliseconds. It is clamped to 10 000–900 000, and invalid values fall back to 120 000.
- After a transient, Cloudflare, or credential-source failure, the next refresh waits 60 seconds. While authentication is fatal, a retry runs at most every five minutes.
- If authentication cannot be repaired from the recorded credential source, the statusline shows `run init to repair auth`.

**Rate limits (HTTP 429).** The usage endpoint's limit is shared by every client signed in to the same account, including Claude Code itself and tools such as CodexBar, so a 429 usually means another client used the quota. cc-statusline waits for the server's `Retry-After` delay, capped at 15 minutes. Without a usable `Retry-After` it waits five minutes, the same default CodexBar uses. Each further consecutive 429 doubles the wait, up to 15 minutes. A single 429 only leaves the ` ~` marker on the last known figures. The `rate-limited; retry in …` hint appears once two refreshes in a row have been rejected.

### LLM gateways

When Claude Code is routed through a different LLM gateway or provider, subscription usage does not apply. Every plan then shows a single line with the model, context usage, and cache hit ratio, and the renderer skips the background usage refresh:

```text
Opus 4.7 · ctx 42% · cache 87%
```

Gateway mode is on when either of these holds:

- `ANTHROPIC_BASE_URL` points at a host outside `anthropic.com`, or is not a valid URL.
- `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, or `CLAUDE_CODE_USE_FOUNDRY` is set to `1`, `true`, `yes`, or `on` (case-insensitive).

The statusline inherits Claude Code's environment, including the `env` block in `settings.json`.

## Commands

All commands run through `npx @nkootstra/cc-statusline <command>`. The installed bundle (`~/.claude/cc-statusline/cc-statusline.js`) accepts the same commands, but `cc-statusline` itself is not put on your `PATH`.

| Command | Description |
|---|---|
| *(none)*, `[flags]`, or `init [flags]` | Install or update. |
| `uninstall` | Remove the statusline. See [Uninstall](#uninstall). |
| `doctor [--logs]` | Print cache and credential-source diagnostics. No tokens are printed. |
| `render` | Called by Claude Code. Reads the statusline JSON from stdin. Extra arguments are ignored. |
| `render-promax`, `render-enterprise` | Deprecated aliases for `render`, kept for older settings. |
| `refresh` | Internal. The detached background usage refresh. |
| `--version`, `-v` | Print the version. Must be the first argument. |
| `--help`, `-h` | Print help. |

## Environment variables

| Variable | Effect | Default |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | Claude config directory. Used for `settings.json`, the install directory, the cache, the debug log, and credential-file discovery. | `~/.claude` |
| `CC_STATUSLINE_ENTERPRISE_STALE_MS` | Stale window for cache-derived figures, in ms. Despite the name, it applies to every layout. | `120000` (clamped 10000–900000) |
| `NO_COLOR` | Any non-empty value disables ANSI colour and dimming. | unset |
| `ANTHROPIC_BASE_URL` | A non-Anthropic host enables gateway mode. | unset |
| `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` | A truthy value enables gateway mode. | unset |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` (either case), `NODE_USE_ENV_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_OPTIONS` | Passed to the background refresh process for proxy and corporate CA setups. Other variables are not passed on. | unset |

## Files

Everything lives under `~/.claude/cc-statusline/`, or `$CLAUDE_CONFIG_DIR/cc-statusline/` when that variable is set. The directory is created with mode `0700`.

| Path | Purpose |
|---|---|
| `cc-statusline.js` | Installed renderer bundle (mode `0755` on macOS/Linux). |
| `cache.json` | Usage cache, schema v4, mode `0600`. |
| `cache.json.locks/` | Short-lived lock directory that serializes cache writers. |
| `debug.log`, `debug.log.1` | Token-free JSONL diagnostics, mode `0600`, rotated at 256 KiB. |
| `debug.log.disabled` | Disables diagnostics logging when present. |

## Credentials

During init, automatic discovery checks, in order:

1. The macOS Keychain service `Claude Code-credentials` for the current user's account (the item Claude Code itself reads and writes), then the same service for any account. macOS only.
2. `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR/.credentials.json`).
3. `~/.claude/credentials.json` (or `$CLAUDE_CONFIG_DIR/credentials.json`).

Automatic discovery is recorded as the `Claude Code` credential source. When a discovered credential cannot be decoded, init names the source and the offending envelope field. It never prints token values or an explicit path.

`--credentials-path=<path>` records an `explicit file` source instead, and that path is authoritative: background refresh rereads that file and never falls back to the Keychain or another Claude Code location. The path is resolved with `realpath`, must be a regular file inside your home directory, and is never printed by `doctor`. A bad path exits with code 2. A rejected credential exits with code 3.

Only the `accessToken` is copied into the cache and sent as a Bearer token to `https://api.anthropic.com/api/oauth/usage`.

**Following Claude Code renewals and `/login` switches.** The background refresh rereads the recorded source each time it runs (at most once per stale window, never during a render). With the `Claude Code` source, cc-statusline picks up an access token Claude Code has renewed, and follows `/login` to another account even while the previous account's token is still valid. Two cases differ:

- The reread token is different, and the usage fetch then fails with a network, Cloudflare, or rate-limit error. cc-statusline adopts the new token and clears the cached figures, so the previous account's usage is not shown.
- The usage fetch is rejected with HTTP 401. The cache is marked as an authentication failure and its last figures are dimmed until a later refresh or `init` repairs it.

If the reread itself fails while the cached token still has at least five minutes left, the refresh continues with the cached token. Otherwise it retries after 60 seconds. cc-statusline never rotates credentials itself. If rereading the source cannot repair fatal authentication, run init as the statusline tells you to.

## Security

- The v4 cache at `~/.claude/cc-statusline/cache.json` has mode `0600` and holds an access token, its expiry, usage data, and credential-source provenance. It **never** contains a refresh token, and a cache that has one is rejected.
- Claude Code owns credential renewal. cc-statusline never sends a refresh token to an OAuth endpoint and never stores one. When it reads a Claude Code credential envelope, any refresh token in it stays in memory only during source loading and error sanitization.
- Error messages are stripped of token values before they reach the cache, the log, or stderr.
- Every child process is spawned without a shell, with an argument array and an allowlisted environment.
- `doctor` and the debug log never show access tokens, refresh tokens, authorization headers, response bodies, or explicit credential paths.
- The statusline's diagnostics cannot see Claude Code or another application using the same account or OAuth credential. Only server-side, account-level evidence could show that.

See [SECURITY.md](SECURITY.md) for reporting channels and scope.

## Diagnostics

```bash
npx @nkootstra/cc-statusline doctor          # current state
npx @nkootstra/cc-statusline doctor --logs   # plus retained debug log history
```

`doctor` prints:

- the cache path and whether the cache exists
- the auth state
- the credential source: `Claude Code` or `explicit file`, never a path or token
- when usage was last fetched, and the token expiry
- the **layout** detected from the cache:
  - `5h/7d windows`
  - `5h/7d windows + extra spend`
  - `credits`
  - `no usage figures`
  - `unknown (no usage fetched yet)`
- when the access token last changed: a Claude Code renewal or a `/login` switch
- rate-limit cooldown, refresh retry, whether a refresh is in flight, and the last error

The debug log at `~/.claude/cc-statusline/debug.log` records refresh decisions, endpoint labels, response status, request duration, and rate-limit cooldown details. It never records tokens, authorization headers, or response bodies.

## Troubleshooting

### `statusline skipped · restart to fix`

Claude Code hasn't trusted the workspace yet. Accept the trust prompt and restart Claude Code.

### `usage — · run init`

There is no usable v4 cache and the payload has no rate limits (Enterprise, or before Claude Code's first response). Run `npx @nkootstra/cc-statusline`.

### `run init to repair auth`

The usage API rejected the token and rereading the credential source didn't fix it. Make sure `claude auth login` works, then run `npx @nkootstra/cc-statusline --force`.

### `rate-limited; retry in …`

Another client signed in to the same account is using the usage endpoint's quota. cc-statusline backs off on its own. See [rate limits](#freshness-refresh-and-rate-limits).

### Cloudflare

`refresh blocked (cloudflare)` means the usage endpoint answered with HTTP 403, usually a Cloudflare challenge for your network or IP. This is common behind VPNs and corporate proxies. Refreshes retry after 60 seconds. If you are behind a proxy, make sure Claude Code's environment carries your proxy settings (`HTTPS_PROXY`, `NODE_USE_ENV_PROXY`) and CA certificates (`NODE_EXTRA_CA_CERTS`); the background refresh inherits them. Payload 5h/7d figures keep working either way.

### Figures from the wrong account after `/login`

The cache is rebuilt on the next refresh, within about a minute. To force it, run `npx @nkootstra/cc-statusline --force`.

### `init: settings.json already has a different statusLine.command`

Another statusline is configured. Re-run interactively to get the replace prompt, or pass `--force`.

## Uninstall

```bash
npx @nkootstra/cc-statusline uninstall
```

This removes:

- the `statusLine` block from `settings.json`, whichever tool wrote it
- the installed renderer
- `cache.json` and the debug logs
- the install directory, if it is then empty

It does not revoke or change the Claude Code login or an explicit credential source; those stay owned by their source. Restart Claude Code afterwards.

## How it works

```text
Claude Code ──stdin JSON──▶ render ──▶ two-line statusline (stdout)
                              │  reads
                              ▼
                       cache.json (v4, 0600)
                              ▲  writes (locked)
       stale? spawn ──▶ refresh (detached)
                              │ reread credential source
                              ▼
                 GET api.anthropic.com/api/oauth/usage
```

1. Claude Code runs `cc-statusline.js render` every `refreshInterval` seconds and on prompt updates, sending the statusline JSON on stdin. The read times out after one second and then prints an empty line.
2. `render` parses the payload, checks for gateway mode, reads the cache, picks a layout, and writes its output **before** any other work.
3. If the cache is stale and no refresh is in flight or cooling down, `render` claims the refresh slot and spawns a detached `refresh` process (hidden window on Windows, allowlisted environment).
4. `refresh` rereads the credential source, calls the usage endpoint (10-second timeout), classifies the result as `success`, `auth-fatal`, `cloudflare-blocked`, `rate-limited`, or `transient`, and atomically updates the cache under a lock.

Source layout:

```text
src/
  cli.ts          entry point and command routing (lazy imports keep render cold-start small)
  cache/          v4 cache store and ticket lock
  credentials/    discovery, credential envelope decoding, source rereading
  diagnostics/    bounded JSONL debug log
  oauth/          usage API client and response decoding
  settings/       settings.json mutator
  statusline/     stdin parsing, formatting, gateway detection, cache ratio, and the identity, subscription, and cached-usage rows
  subcommands/    init, init-credentials (credential discovery, login, validation), render, background-refresh (detached refresh launcher), refresh, refresh-policy, doctor, uninstall
tests/            vitest suites, fixtures, helpers
bin/              npm bin shim that loads dist/cli.cjs
```

## Development

Requires Node 22 or later.

```bash
git clone https://github.com/nkootstra/cc-statusline.git
cd cc-statusline
npm install
npm run build      # tsup → dist/cli.cjs (single CJS bundle)
npm run typecheck  # tsc --noEmit
npm test           # vitest: main suite, then the isolated build-smoke and runtime suites
```

| Script | Description |
|---|---|
| `npm run build` | Bundle `src/cli.ts` into minified `dist/cli.cjs`. `write-file-atomic` is bundled in. |
| `npm run typecheck` | Strict TypeScript check. |
| `npm test` | `test:suite` followed by `test:isolated`. |
| `npm run test:suite` | All tests except the build-smoke and runtime tests. |
| `npm run test:isolated` | Build-smoke and render runtime tests, single worker. They run against `dist/`, so **build first**. |
| `npm run test:watch` | Vitest in watch mode. |

The build-smoke tests enforce a render cold-start budget (150 ms on macOS/Linux, 250 ms on Windows) and check that the bundle requires only Node builtins. Tests never touch your real `~/.claude`, the Keychain, or the network.

To try a local build in Claude Code:

```bash
npm run build && node dist/cli.cjs init --force
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR. Changes to `src/credentials/`, `src/oauth/`, or `src/cache/` need a design discussion in an issue first.

## Release

Releases are published to npm as `@nkootstra/cc-statusline`. A `chore: release X.Y.Z` PR bumps the version, and pushing a `v*` tag runs the release workflow (typecheck, build, test, `npm publish --provenance`). The installed executable is still called `cc-statusline`.

## License

[MIT](LICENSE)
