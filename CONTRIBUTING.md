# Contributing

## Development setup

Node 18 or later is required.

```bash
npm install
npm run build      # tsup bundle → dist/
npm test           # vitest
npm run typecheck  # tsc --noEmit
```

`prepublishOnly` runs all three in sequence, so a passing publish means all three pass.

## Project layout

```
src/
  cache/          token + usage cache (read/write, 0600 mode)
  credentials/    platform-aware OAuth credential discovery
  oauth/          token refresh and usage API client
  settings/       ~/.claude/settings.json mutator
  statusline/     output formatter + stdin reader for Claude Code
  subcommands/    init, uninstall, refresh, render-promax, render-enterprise
tests/
  fixtures/       static test inputs
```

## Opening an issue first

Open an issue before writing code. This applies to bug fixes too — it avoids duplicate effort, confirms the bug is reproducible, and lets us agree on the right fix before you invest time in a PR.

Changes in `credentials/`, `oauth/`, or `cache/` need an explicit **design discussion** in the issue before any code is written. These paths handle OAuth tokens, so "I'd like to refactor X" is not enough — the issue must agree on the approach first.

## Submitting a PR

- Keep PRs small and focused on one thing
- `npm test` and `npm run typecheck` must pass
- Fill in the PR template; the checklist is short

## Code style

TypeScript strict mode is enforced by `tsconfig.json`. Beyond that:

- Comments only when the *why* is non-obvious — a hidden constraint, a subtle invariant, a workaround for a specific bug
- No docstrings or block comments explaining what the code does

## Platform support

macOS and Linux are the primary targets. Windows code paths exist (`win32` branches in `init` and `buildCommand`) but are not covered by CI. Windows patches are welcome; they may not be merged without a test signal.

## Release process

Releases are published to npm automatically when a `v*` tag is pushed. Only the maintainer cuts releases.
