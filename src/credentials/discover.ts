/**
 * Platform-aware credential discovery for Claude Code's stored OAuth tokens.
 *
 * Discovery sequence (mirrors `nkootstra/claude-usage` KeychainReader.swift):
 *   1. macOS only — spawn `security find-generic-password -s "Claude Code-credentials" -w`
 *      (no shell:true, argv only — avoids shell injection).
 *   2. All platforms — `<home>/.claude/.credentials.json`
 *   3. All platforms — `<home>/.claude/credentials.json`
 *
 * A malformed file (JSON parse error or InvalidEnvelopeError) throws immediately
 * with context naming the file — it is NOT silently skipped.
 *
 * An EACCES file error is surfaced as a typed error naming the path — the
 * install wizard can display "permission denied on X — check ownership".
 *
 * Security notes:
 *   - spawn never uses shell:true (prevents shell injection via item name).
 *   - CredentialNotFoundError includes paths tried, never file contents.
 *   - InvalidEnvelopeError includes field name, never token values (ADV-003).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { readFile as nodeReadFile } from 'node:fs/promises';
import { homedir as nodeHomedir } from 'node:os';
import { join } from 'node:path';
import { decodeEnvelope, type OAuthCredentials } from './envelope.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CredentialNotFoundError extends Error {
  constructor(public readonly pathsTried: string[]) {
    super(`No Claude Code credentials found. Tried:\n  - ${pathsTried.join('\n  - ')}`);
    this.name = 'CredentialNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DiscoverOptions {
  /** Override homedir for testing. */
  homedirOverride?: string;
  /** Override platform for testing. */
  platformOverride?: NodeJS.Platform;
  /**
   * Custom spawn function for testing the macOS keychain path.
   * Must match the signature of `node:child_process`.spawn.
   */
  spawnOverride?: typeof import('node:child_process').spawn;
  /** Custom file reader for testing the file paths. */
  readFileOverride?: typeof import('node:fs/promises').readFile;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const SPAWN_TIMEOUT_MS = 10_000;

/**
 * Attempt to read the credential from the macOS keychain via `security(1)`.
 *
 * Returns `null` on non-zero exit or timeout (fall through to file paths).
 * Returns the decoded `OAuthCredentials` on success.
 * Propagates `InvalidEnvelopeError` on a malformed envelope (caller must not
 * swallow it — the keychain item exists but is corrupt).
 */
function readFromKeychain(
  spawnFn: typeof nodeSpawn,
): Promise<OAuthCredentials | null> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SPAWN_TIMEOUT_MS);

    let stdout = '';
    let timedOut = false;

    const child = spawnFn(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      {
        shell: false,
        signal: controller.signal,
      },
    );

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // AbortError means we timed out — fall through.
      if (err.name === 'AbortError' || (err as NodeJS.ErrnoException).code === 'ABORT_ERR') {
        timedOut = true;
        resolve(null);
      } else {
        // security binary not found or other OS error — fall through.
        resolve(null);
      }
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve(null);
        return;
      }
      if (code !== 0) {
        // Item not found (44) or any other non-zero exit — fall through.
        resolve(null);
        return;
      }
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve(null);
        return;
      }
      // Parse and decode — propagate errors to the caller.
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Keychain returned non-JSON — treat as not found.
        resolve(null);
        return;
      }
      // decodeEnvelope may throw InvalidEnvelopeError; propagate it.
      try {
        resolve(decodeEnvelope(parsed));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Attempt to read the credential from a file path.
 *
 * Returns `null` on ENOENT (fall through to next candidate).
 * Throws on EACCES with a message naming the path.
 * Throws `SyntaxError` or `InvalidEnvelopeError` on malformed content
 * (wraps with context naming the file).
 */
async function readFromFile(
  filePath: string,
  readFileFn: typeof nodeReadFile,
): Promise<OAuthCredentials | null> {
  let raw: string;
  try {
    // The overloaded signature makes TS unhappy with the union; cast to any to
    // call with explicit 'utf-8' encoding and get a string back.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw = await (readFileFn as any)(filePath, 'utf-8') as string;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return null;
    }
    if (e.code === 'EACCES') {
      throw new Error(
        `Permission denied reading credential file: ${filePath} — check file ownership and mode.`,
      );
    }
    // Any other I/O error: propagate with file context.
    throw new Error(
      `Failed to read credential file ${filePath}: ${e.message ?? String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Credential file ${filePath} contains invalid JSON: ${(err as Error).message}`,
    );
  }

  // decodeEnvelope throws InvalidEnvelopeError on missing/invalid fields.
  // Do not catch — the file exists but is malformed; surface immediately.
  try {
    return decodeEnvelope(parsed);
  } catch (err) {
    throw new Error(
      `Credential file ${filePath} has an invalid envelope: ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover and decode Claude Code's stored OAuth credentials.
 *
 * Tries the macOS keychain first (Darwin only), then two well-known file
 * paths, then throws `CredentialNotFoundError` with the full list of
 * locations that were checked.
 *
 * @throws {CredentialNotFoundError} when no credential source yields a result.
 * @throws {Error} (including `InvalidEnvelopeError`) when a source is found
 *   but malformed — the caller should surface this to the user, not swallow it.
 */
export async function discover(options?: DiscoverOptions): Promise<OAuthCredentials> {
  const platform = options?.platformOverride ?? process.platform;
  const home = options?.homedirOverride ?? nodeHomedir();
  const spawnFn = options?.spawnOverride ?? nodeSpawn;
  const readFileFn = options?.readFileOverride ?? nodeReadFile;

  const pathsTried: string[] = [];

  // ── Step 1: macOS keychain ──────────────────────────────────────────────
  if (platform === 'darwin') {
    pathsTried.push('macOS keychain (Claude Code-credentials)');
    const keychainResult = await readFromKeychain(spawnFn);
    if (keychainResult !== null) {
      return keychainResult;
    }
    // Non-zero exit or timeout: fall through.
  }

  // ── Step 2: ~/.claude/.credentials.json ────────────────────────────────
  const dotCredPath = join(home, '.claude', '.credentials.json');
  pathsTried.push(dotCredPath);
  const dotCredResult = await readFromFile(dotCredPath, readFileFn);
  if (dotCredResult !== null) {
    return dotCredResult;
  }

  // ── Step 3: ~/.claude/credentials.json ─────────────────────────────────
  const credPath = join(home, '.claude', 'credentials.json');
  pathsTried.push(credPath);
  const credResult = await readFromFile(credPath, readFileFn);
  if (credResult !== null) {
    return credResult;
  }

  // ── Step 4: Nothing found ───────────────────────────────────────────────
  throw new CredentialNotFoundError(pathsTried);
}
