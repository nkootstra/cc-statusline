/**
 * `uninstall` subcommand — reverses the install performed by `init`.
 *
 * Removes:
 *   - <installDir>/cc-statusline.js
 *   - <installDir>/cache.json
 *   - <installDir>/ (only if empty after above removals)
 *
 * Clears `statusLine` from ~/.claude/settings.json.
 * Idempotent: missing files/settings are no-ops.
 * Does NOT revoke tokens (deferred to v1.1).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readSettings,
  clearStatusLine,
  writeSettings,
  defaultSettingsPath,
} from '../settings/mutator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UninstallDeps {
  /** Override homedir (for tests). */
  homedirOverride?: string;
  /** Override settings file path (for tests). */
  settingsPath?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getClaudeDir(homedirOverride?: string): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  if (configDir) return configDir;
  const home = homedirOverride ?? os.homedir();
  return path.join(home, '.claude');
}

function getInstallDir(homedirOverride?: string): string {
  return path.join(getClaudeDir(homedirOverride), 'cc-statusline');
}

function tryUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw err;
    }
    // ENOENT → file did not exist, which is fine for idempotent uninstall
  }
}

function tryRmdir(dirPath: string): void {
  try {
    fs.rmdirSync(dirPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTEMPTY') {
      // ENOENT → already gone; ENOTEMPTY → user has other files, leave it
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export async function runUninstall(_args: string[], deps: UninstallDeps = {}): Promise<number> {
  const installDir = getInstallDir(deps.homedirOverride);
  const settingsFilePath = deps.settingsPath ?? defaultSettingsPath();

  // 1. Remove cc-statusline.js
  const rendererPath = path.join(installDir, 'cc-statusline.js');
  tryUnlink(rendererPath);

  // 2. Remove cache.json
  const cachePath = path.join(installDir, 'cache.json');
  tryUnlink(cachePath);

  // 3. Remove installDir if empty (leave if user added other files)
  tryRmdir(installDir);

  // 4. Clear statusLine from settings.json (if settings file exists)
  const settings = readSettings(settingsFilePath);
  // readSettings returns {} if file does not exist — check if statusLine was there
  if ('statusLine' in settings) {
    clearStatusLine(settings);
    await writeSettings(settingsFilePath, settings);
  }
  // If settings file does not exist and statusLine is absent, no-op (do NOT create file)

  process.stdout.write('cc-statusline uninstalled. Restart Claude Code to apply.\n');
  return 0;
}
