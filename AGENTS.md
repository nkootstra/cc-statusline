# cc-statusline

Usage-aware Claude Code statusline. The CLI reads OAuth tokens from the macOS keychain or `~/.claude/.credentials.json`, caches them at `~/.claude/cc-statusline/cache.json`, and renders usage in the Claude Code prompt area.

## Stack

- TypeScript strict; `noUncheckedIndexedAccess` is on — `arr[i]` yields `T | undefined`.
- vitest (`environment: 'node'`, 15s timeout); tsup builds a single-file CJS bundle to `dist/cli.cjs`.
- Sole runtime dep: `write-file-atomic` (bundled via `noExternal`).
- Node 22+.

## Development

Run before declaring a change done:

- `npm run typecheck`
- `npm run build`
- `npm test`

`prepublishOnly` runs all three.

## Security invariants — never violate

- Every `child_process.spawn` call passes `shell: false` and an argv array. Never `shell: true`, never a single string command.
- Cache files are written with mode `0600`. The install dir `~/.claude/cc-statusline/` is created with mode `0700`.
- Any error string that may have originated from token-handling or HTTP response paths is passed through `sanitizeErrorMessage(message, credentials)` before being persisted (cache, log, stderr).
- Any flag or input accepting a file path is validated with `fs.realpath` and rejected if it resolves outside the user's homedir or points to a non-regular file. Pattern: `validateCredentialsPath` in `src/subcommands/init.ts`.

Changes inside `src/credentials/`, `src/oauth/`, or `src/cache/` require a design-discussed issue before any code is written. See `CONTRIBUTING.md`.

## Test conventions

- Tests must not touch real `~/.claude/`, the macOS keychain, or the network. Use `os.tmpdir()` + `mkdtempSync` for filesystem isolation.
- Subcommand entrypoints accept a `Deps` interface (e.g. `InitDeps`) exposing override hooks: `homedirOverride`, `platformOverride`, `spawnRefresh`, `discoverImpl`, `pasteReader`, etc. Tests inject mocks via these; production calls omit them and get the defaults.
- Mock only at system boundaries — filesystem, network, `child_process`, time. Never mock internal modules.
- Fixtures live in `tests/fixtures/`.

## OAuth result handling

`refresh()` and `fetchUsage()` in `src/oauth/client.ts` return discriminated unions with a `kind` field: `success | auth-fatal | cloudflare-blocked | rate-limited | transient`. Every caller must handle every variant explicitly. Do not collapse to `try/catch` over the call.

## Cache schema

`Cache` in `src/cache/store.ts` carries a `schemaVersion` literal. Any shape change must bump the version, and `readCache` must return `null` for older versions so `init` rebuilds cleanly.

## Bundle constraints

- Cold-start budget: 150 ms on macOS/Linux, 250 ms on Windows. Enforced by `tests/build-smoke.test.ts`.
- The bundle must not `require()` anything outside Node builtins. New deps go through `noExternal` in `tsup.config.ts` or get vendored.

## Code style

- No comments explaining what the code does. Comment only when the *why* is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug.
- No block docstrings.

## Bug fixing workflow

1. Write a vitest test that reproduces the bug. Confirm it fails for the right reason.
2. Fix the code.
3. The new test must pass; the rest of the suite must not regress.
4. Commit the failing test and the fix together.

## Reference docs

- `CONTRIBUTING.md` — issue/PR policy, repo layout, platform support, release process.
- `SECURITY.md` — reporting channels, scope, implemented defences.
- `docs/plans/` — historical implementation plans (read-only context).
