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
- **Enterprise**: model name plus dollars-used / dollars-limit when monthly credits are enabled. Falls back to colorized 5-hour and 7-day rate-limit utilization. The spend figure comes from a local cache that is refreshed in the background every 60 seconds; a ` ~` marker appears when the cached value is older than that. The trailing cost figure (e.g. `· $0.08`) is Claude Code's current-session token spend and updates independently.

Pro and Max use the same renderer. They are separate installer choices only because Claude users know their subscription by those names; Claude Code exposes the same statusline usage fields for both.

Example Pro / Max output:

```text
Opus 4.7 · 5h 102% · 7d 81% [Tue 20:00]
```

Example Enterprise output:

```text
Opus 4.7 · $780.00 / $1000.00 (78%)
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

## Release

Releases are published to npm as `@nkootstra/cc-statusline` from version tags (`v*`) through the GitHub Actions release workflow. The installed executable remains `cc-statusline`.
