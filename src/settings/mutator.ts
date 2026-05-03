import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import writeFileAtomic from 'write-file-atomic';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StatusLineConfig {
  type: 'command';
  command: string;
  padding?: number;
  refreshInterval?: number;
  hideVimModeIndicator?: boolean;
}

export interface SettingsFile {
  statusLine?: StatusLineConfig;
  [key: string]: unknown;
}

export type MutationAction = 'created' | 'updated' | 'no-change' | 'conflict';

export interface MutationResult {
  action: MutationAction;
  existing?: string;
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class MalformedSettingsError extends Error {
  constructor(filePath: string, cause?: unknown) {
    super(
      `~/.claude/settings.json (${filePath}) contains invalid JSON and cannot be parsed. Fix or delete the file and retry.`,
    );
    this.name = 'MalformedSettingsError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export class SettingsLockedError extends Error {
  constructor() {
    super(
      '~/.claude/settings.json appears locked by another process; close Claude Code and retry.',
    );
    this.name = 'SettingsLockedError';
  }
}

// ---------------------------------------------------------------------------
// Default path
// ---------------------------------------------------------------------------

/**
 * Returns the default path to settings.json.
 *
 * If `CLAUDE_CONFIG_DIR` is set in the environment, that directory is used.
 * Otherwise falls back to `~/.claude/settings.json`.
 */
export function defaultSettingsPath(): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  if (configDir) {
    return path.join(configDir, 'settings.json');
  }
  return path.join(os.homedir(), '.claude', 'settings.json');
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Reads and JSON-parses `~/.claude/settings.json` (or `filePath` if given).
 * Returns `{}` when the file does not exist.
 * Throws `MalformedSettingsError` when the file exists but is not valid JSON.
 */
export function readSettings(filePath?: string): SettingsFile {
  const target = filePath ?? defaultSettingsPath();
  let raw: string;
  try {
    raw = readFileSync(target, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }
    throw err;
  }

  try {
    return JSON.parse(raw) as SettingsFile;
  } catch (parseErr) {
    throw new MalformedSettingsError(target, parseErr);
  }
}

// ---------------------------------------------------------------------------
// Mutate
// ---------------------------------------------------------------------------

/**
 * Inspects `settings.statusLine` and determines the appropriate action.
 *
 * - `'conflict'`:   `statusLine.command` is non-empty and differs from `command`.
 *                   The settings object is NOT mutated. The caller decides whether
 *                   to overwrite (e.g. `--force`) or abort.
 * - `'no-change'`:  `statusLine.command` already equals `command`. No mutation.
 * - `'created'`:    `statusLine` was absent or had no `command` field set.
 *                   Writes the full block in place.
 * - `'updated'`:    Reserved for future use when the statusLine block exists but
 *                   fields other than `command` need updating. In v1 this case
 *                   is structurally identical to `'created'` (same write), but
 *                   the distinct action type is preserved for caller awareness.
 *
 * When a mutation is performed, it is applied **in place** on the passed
 * `settings` object. The caller should subsequently call `writeSettings` if
 * the action is neither `'no-change'` nor `'conflict'`.
 */
export function setStatusLine(settings: SettingsFile, command: string): MutationResult {
  const existing = settings.statusLine?.command;

  // Conflict: non-empty command that differs from what we want.
  if (existing !== undefined && existing !== '' && existing !== command) {
    return { action: 'conflict', existing };
  }

  // No-change: already correctly configured.
  if (existing === command) {
    return { action: 'no-change' };
  }

  // Determine whether we are creating from scratch or updating an existing
  // (but incomplete / empty) block.
  const action: MutationAction = settings.statusLine !== undefined ? 'updated' : 'created';

  // Mutate in place.
  settings.statusLine = {
    type: 'command',
    command,
    padding: 2,
    refreshInterval: 10,
  };

  return { action };
}

/**
 * Removes the `statusLine` key from `settings` and returns the same object.
 * No-op when `statusLine` is absent.
 */
export function clearStatusLine(settings: SettingsFile): SettingsFile {
  if ('statusLine' in settings) {
    delete settings.statusLine;
  }
  return settings;
}

// ---------------------------------------------------------------------------
// Write (atomic, with Windows EPERM/EBUSY retry)
// ---------------------------------------------------------------------------

const RETRY_DELAYS_MS = [50, 150, 400] as const;

/**
 * Atomically writes `settings` to `filePath` as pretty-printed JSON with a
 * trailing newline.
 *
 * On Windows, `write-file-atomic`'s rename step can fail with EPERM or EBUSY
 * when Claude Code (or another process) holds an open handle. This function
 * retries up to 3 times with exponential back-off (50ms → 150ms → 400ms) on
 * those specific error codes. Any other error is re-thrown immediately.
 *
 * After 3 consecutive EPERM/EBUSY failures a `SettingsLockedError` is thrown.
 */
export async function writeSettings(filePath: string, settings: SettingsFile): Promise<void> {
  const content = JSON.stringify(settings, null, 2) + '\n';

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    try {
      await writeFileAtomic(filePath, content);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EBUSY') {
        lastError = err as Error;
        // Only sleep between attempts, not after the last one.
        if (attempt < RETRY_DELAYS_MS.length - 1) {
          await sleep(RETRY_DELAYS_MS[attempt] as number);
        }
      } else {
        // Non-retried error: propagate immediately.
        throw err;
      }
    }
  }

  // All 3 attempts exhausted on EPERM/EBUSY.
  throw new SettingsLockedError();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
