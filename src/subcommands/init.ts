/**
 * `init` subcommand — installer wizard.
 *
 * Performs plan-tier branching install flow (Pro/Max or Enterprise),
 * writes the bundled file to ~/.claude/cc-statusline/cc-statusline.js,
 * mutates ~/.claude/settings.json, and (for Enterprise) reads the credential,
 * validates it via the refresh subcommand, and writes the initial cache.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import {
  readSettings,
  setStatusLine,
  writeSettings,
  defaultSettingsPath,
} from '../settings/mutator';
import { discover, CredentialNotFoundError } from '../credentials/discover';
import { decodeEnvelope, InvalidEnvelopeError } from '../credentials/envelope';
import { readCache, writeCache, defaultCachePath, type Cache } from '../cache/store';
import type { OAuthCredentials } from '../oauth/types';

// ---------------------------------------------------------------------------
// Version (read from package.json — works in source and in the tsup bundle
// because tsup processes resolveJsonModule and includes the import inline).
// Deviation note: if package.json is not accessible at runtime in the bundled
// binary, we fall back to a compile-time constant extracted here.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PKG_VERSION: string = ((): string => {
  try {
    // In source: __dirname is src/subcommands, package.json is two levels up.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
})();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlanTier = 'pro' | 'max' | 'enterprise';

export interface SpawnRefreshResult {
  status: number | null;
}

export interface InitDeps {
  /** Override homedir (for tests). */
  homedirOverride?: string;
  /** Override platform (for tests). */
  platformOverride?: NodeJS.Platform;
  /** Override __filename for the bundle copy (for tests). */
  bundlePathOverride?: string;
  /** Inject a custom refresh-subprocess invoker (for tests). */
  spawnRefresh?: (args: string[], opts: SpawnSyncOptions) => SpawnRefreshResult;
  /** Inject a custom discover implementation (for tests). */
  discoverImpl?: typeof discover;
  /** Single-keystroke reader (for plan prompt) (for tests). */
  stdinReader?: () => Promise<string>;
  /** No-echo paste reader (for credential paste prompt) (for tests). */
  pasteReader?: () => Promise<string>;
  /** Override TTY detection (for tests). */
  isInteractive?: boolean;
  /** Override the version string emitted in the install log (for tests). */
  versionString?: string;
  /** Override settings file path (for tests). */
  settingsPath?: string;
  /** Override cache file path (for tests). */
  cachePath?: string;
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

function getBundleDestPath(homedirOverride?: string): string {
  return path.join(getInstallDir(homedirOverride), 'cc-statusline.js');
}

/** Build the statusLine command string for settings.json. */
function buildCommand(installDir: string, tier: PlanTier, platform: NodeJS.Platform): string {
  const bundlePath = path.join(installDir, 'cc-statusline.js');
  const subcommand = tier === 'enterprise' ? 'render-enterprise' : 'render-promax';
  if (platform === 'win32') {
    return `node ${bundlePath} ${subcommand}`;
  }
  return `${bundlePath} ${subcommand}`;
}

/** Read a single keystroke from stdin (raw mode). */
async function readSingleKeystroke(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const handler = (key: string) => {
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      stdin.removeListener('data', handler);
      resolve(key);
    };

    stdin.on('data', handler);
  });
}

/** Read a pasted line from stdin without echoing to stdout. */
async function readPasteNoEcho(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = '';

    stdin.resume();
    stdin.setEncoding('utf8');

    const handler = (chunk: string) => {
      buf += chunk;
      // Accept input terminated by newline (Enter key)
      if (buf.includes('\n')) {
        stdin.removeListener('data', handler);
        stdin.pause();
        resolve(buf.replace(/\n$/, '').trim());
      }
    };

    stdin.on('data', handler);
  });
}

/** Validate that a credentials path is safe to read. */
async function validateCredentialsPath(
  credentialsPath: string,
  homedir: string,
): Promise<{ ok: true; resolved: string } | { ok: false; reason: string }> {
  // 1. Resolve via realpath (verifies the file exists and resolves symlinks)
  let resolved: string;
  try {
    resolved = await fs.promises.realpath(credentialsPath);
  } catch {
    return {
      ok: false,
      reason: `credentials path does not exist or cannot be resolved: ${credentialsPath}`,
    };
  }

  // 2. Resolved path must be inside homedir. Also realpath the homedir so
  // platforms where the homedir contains symlinks (e.g. macOS resolves
  // /var/folders to /private/var/folders) don't generate false rejections.
  let realHome: string;
  try {
    realHome = await fs.promises.realpath(homedir);
  } catch {
    realHome = homedir;
  }
  const rel = path.relative(realHome, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      ok: false,
      reason: `credentials path resolves outside home directory: ${resolved}`,
    };
  }

  // 3. Must be a regular file (reject /dev/zero, directories, etc.)
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return {
        ok: false,
        reason: `credentials path is not a regular file: ${resolved}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: `cannot stat credentials path: ${(err as Error).message}`,
    };
  }

  return { ok: true, resolved };
}

/** Write initial cache for Enterprise flow. */
async function writeInitialCache(
  credentials: OAuthCredentials,
  cachePath: string,
): Promise<void> {
  const cache: Cache = {
    schemaVersion: 1,
    authState: 'ok',
    credentials,
    usage: null,
    lastUsageRefreshAt: 0,
    lastRefreshStartedAt: 0,
    lastErrorMessage: null,
  };
  await writeCache(cache, cachePath);
}

/** Default refresh subprocess invoker. */
function defaultSpawnRefresh(args: string[], opts: SpawnSyncOptions): SpawnRefreshResult {
  return spawnSync(process.execPath, args, { ...opts, shell: false });
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export async function runInit(args: string[], deps: InitDeps = {}): Promise<number> {
  // ── Parse flags ─────────────────────────────────────────────────────────
  let planFlag: PlanTier | undefined;
  let credentialsPathFlag: string | undefined;
  let forceFlag = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--plan=')) {
      const val = arg.slice('--plan='.length).toLowerCase();
      if (val === 'pro' || val === 'max' || val === 'enterprise') {
        planFlag = val;
      } else {
        process.stderr.write(`init: unknown plan "${val}"; expected pro, max, or enterprise\n`);
        return 1;
      }
    } else if (arg === '--plan') {
      const val = args[++i]?.toLowerCase();
      if (val === 'pro' || val === 'max' || val === 'enterprise') {
        planFlag = val;
      } else {
        process.stderr.write(`init: unknown plan "${val ?? ''}"; expected pro, max, or enterprise\n`);
        return 1;
      }
    } else if (arg.startsWith('--credentials-path=')) {
      credentialsPathFlag = arg.slice('--credentials-path='.length);
    } else if (arg === '--force') {
      forceFlag = true;
    } else if (arg === '--non-interactive') {
      // Explicitly setting non-interactive mode; handled via isInteractive below
    } else {
      process.stderr.write(`init: unknown flag "${arg}"\n`);
      return 1;
    }
  }

  const platform = deps.platformOverride ?? process.platform;
  const homedir = deps.homedirOverride ?? os.homedir();
  const bundlePath = deps.bundlePathOverride ?? __filename;
  const versionString = deps.versionString ?? PKG_VERSION;
  const spawnRefreshFn = deps.spawnRefresh ?? defaultSpawnRefresh;
  const discoverFn = deps.discoverImpl ?? discover;
  const settingsFilePath = deps.settingsPath ?? defaultSettingsPath();
  const cachePath = deps.cachePath ?? defaultCachePath();

  // Presence of --plan implies non-interactive
  const isInteractive = deps.isInteractive ?? (planFlag === undefined && process.stdin.isTTY === true);

  // ── Determine plan tier ─────────────────────────────────────────────────
  let tier: PlanTier;

  if (planFlag !== undefined) {
    tier = planFlag;
  } else {
    // Interactive plan selection
    process.stdout.write(
      'Which Claude Code plan are you on?\n' +
      '  [1] Pro\n' +
      '  [2] Max\n' +
      '  [3] Enterprise (uses keychain credentials)\n' +
      '  Choice (1-3): ',
    );

    const stdinReader = deps.stdinReader ?? readSingleKeystroke;
    let key: string;

    // Reject keys other than 1, 2, 3
    let attempts = 0;
    while (true) {
      key = await stdinReader();
      attempts++;
      if (key === '1') {
        tier = 'pro';
        process.stdout.write('1\n');
        break;
      } else if (key === '2') {
        tier = 'max';
        process.stdout.write('2\n');
        break;
      } else if (key === '3') {
        tier = 'enterprise';
        process.stdout.write('3\n');
        break;
      } else if (key === '' || key === '') {
        // Ctrl+C / Ctrl+D
        process.stdout.write('\n');
        return 130;
      } else if (attempts >= 10) {
        process.stderr.write('init: invalid input; expected 1, 2, or 3\n');
        return 1;
      }
      // else re-prompt silently for invalid key
    }
  }

  // ── Install directory setup ─────────────────────────────────────────────
  const installDir = getInstallDir(deps.homedirOverride);
  const destPath = getBundleDestPath(deps.homedirOverride);

  // Create install directory
  fs.mkdirSync(installDir, { recursive: true, mode: 0o700 });

  // Always re-copy the running bundle
  fs.copyFileSync(bundlePath, destPath);
  if (platform !== 'win32') {
    fs.chmodSync(destPath, 0o755);
  }

  process.stdout.write(`installed cc-statusline v${versionString} to ${installDir}/cc-statusline.js\n`);

  // ── Settings mutation ───────────────────────────────────────────────────
  const command = buildCommand(installDir, tier, platform);
  const settings = readSettings(settingsFilePath);
  const mutResult = setStatusLine(settings, command);

  if (mutResult.action === 'conflict') {
    if (forceFlag) {
      // Overwrite without prompting
      setStatusLine(settings, command);
      // We need to force-write: set the statusLine directly
      settings.statusLine = {
        type: 'command',
        command,
        padding: 2,
        refreshInterval: 10,
      };
      await writeSettings(settingsFilePath, settings);
    } else if (!isInteractive) {
      process.stderr.write(
        `init: settings.json already has a different statusLine.command:\n  ${mutResult.existing ?? ''}\n` +
        `Use --force to overwrite, or uninstall the existing statusline first.\n`,
      );
      return 2;
    } else {
      // Interactive conflict prompt
      process.stdout.write(
        `\nExisting statusLine.command: ${mutResult.existing ?? ''}\nReplace? (y/n) `,
      );
      const stdinReader = deps.stdinReader ?? readSingleKeystroke;
      const answer = await stdinReader();
      process.stdout.write(answer + '\n');
      if (answer.toLowerCase() !== 'y') {
        process.stdout.write('Aborted. No changes made.\n');
        return 0;
      }
      // User said yes — overwrite
      settings.statusLine = {
        type: 'command',
        command,
        padding: 2,
        refreshInterval: 10,
      };
      await writeSettings(settingsFilePath, settings);
    }
  } else if (mutResult.action !== 'no-change') {
    // 'created' or 'updated'
    await writeSettings(settingsFilePath, settings);
  }
  // 'no-change' → skip write

  // ── Pro/Max branch ──────────────────────────────────────────────────────
  if (tier === 'pro' || tier === 'max') {
    process.stdout.write(
      'Pro/Max statusline installed. Restart Claude Code to see usage in the prompt area.\n' +
      'If Claude Code shows "statusline skipped", accept workspace trust for this project.\n',
    );
    return 0;
  }

  // ── Enterprise branch ───────────────────────────────────────────────────

  // Idempotent re-run check: if valid cache exists and no --force, skip credential discovery
  if (!forceFlag) {
    const existingCache = readCache(cachePath);
    if (existingCache !== null) {
      const now = Date.now();
      const credentialsValid =
        existingCache.authState === 'ok' &&
        existingCache.credentials.expiresAt > now;
      if (credentialsValid) {
        process.stdout.write(
          'Enterprise statusline is already installed with valid credentials.\n' +
          'Re-run with --force to re-validate credentials.\n',
        );
        process.stdout.write(
          'Enterprise statusline installed. Restart Claude Code to see usage in the prompt area.\n' +
          'If Claude Code shows "statusline skipped", accept workspace trust for this project.\n',
        );
        return 0;
      }
    }
  }

  // Discover credentials
  let credentials: OAuthCredentials;

  if (credentialsPathFlag !== undefined) {
    // Validate and read from the specified path
    const validation = await validateCredentialsPath(credentialsPathFlag, homedir);
    if (!validation.ok) {
      process.stderr.write(`init: ${validation.reason}\n`);
      return 2;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(validation.resolved, 'utf8');
    } catch (err) {
      process.stderr.write(`init: cannot read credentials file: ${(err as Error).message}\n`);
      return 2;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      process.stderr.write(`init: credentials file contains invalid JSON: ${validation.resolved}\n`);
      return 2;
    }

    try {
      credentials = decodeEnvelope(parsed);
    } catch (err) {
      if (err instanceof InvalidEnvelopeError) {
        process.stderr.write(`init: invalid credential envelope: ${err.message}\n`);
        return 2;
      }
      throw err;
    }
  } else {
    // Discover from keychain/file
    if (platform === 'darwin') {
      process.stdout.write(
        'note: macOS may prompt to allow keychain access — choose Always Allow to skip future prompts.\n',
      );
    }

    try {
      credentials = await discoverFn({
        homedirOverride: deps.homedirOverride,
        platformOverride: deps.platformOverride,
      });
    } catch (err) {
      if (err instanceof CredentialNotFoundError) {
        if (!isInteractive) {
          process.stderr.write(
            `init: no credentials found. Tried:\n  - ${err.pathsTried.join('\n  - ')}\n` +
            `Provide --credentials-path=<path> or log in to Claude Code first.\n`,
          );
          return 2;
        }

        // Interactive: prompt user to paste credential JSON (max 3 attempts)
        const pastedCredentials = await (async (): Promise<OAuthCredentials | null> => {
          for (let attempt = 1; attempt <= 3; attempt++) {
            process.stdout.write(
              `\nCredentials not found automatically. Please paste the credential JSON\n` +
              `(from ~/.claude/.credentials.json or ~/.claude/credentials.json):\n`,
            );

            const pasteReader = deps.pasteReader ?? readPasteNoEcho;
            const pasted = await pasteReader();

            let parsedPaste: unknown;
            try {
              parsedPaste = JSON.parse(pasted);
            } catch {
              if (attempt < 3) {
                process.stdout.write(`Invalid JSON. Please try again (attempt ${attempt + 1}/3).\n`);
                continue;
              }
              process.stderr.write('init: 3 failed paste attempts; giving up.\n');
              return null;
            }

            try {
              return decodeEnvelope(parsedPaste);
            } catch (envelopeErr) {
              if (attempt < 3) {
                process.stdout.write(
                  `Invalid credential envelope: ${(envelopeErr as Error).message}. ` +
                  `Please try again (attempt ${attempt + 1}/3).\n`,
                );
                continue;
              }
              process.stderr.write('init: 3 failed paste attempts; giving up.\n');
              return null;
            }
          }
          return null;
        })();

        if (pastedCredentials === null) {
          return 2;
        }
        credentials = pastedCredentials;
      } else if (err instanceof InvalidEnvelopeError) {
        process.stderr.write(`init: invalid credential envelope: ${(err as Error).message}\n`);
        return 2;
      } else {
        throw err;
      }
    }
  }

  // Write initial cache
  await writeInitialCache(credentials, cachePath);

  // Validate via refresh subprocess
  const minimalEnv: Record<string, string> = {};
  if (process.env['PATH'] !== undefined) minimalEnv['PATH'] = process.env['PATH'];
  if (platform === 'win32') {
    if (process.env['USERPROFILE'] !== undefined) minimalEnv['USERPROFILE'] = process.env['USERPROFILE'];
  } else {
    if (process.env['HOME'] !== undefined) minimalEnv['HOME'] = process.env['HOME'];
  }
  if (process.env['CLAUDE_CONFIG_DIR'] !== undefined) {
    minimalEnv['CLAUDE_CONFIG_DIR'] = process.env['CLAUDE_CONFIG_DIR'];
  }

  const spawnResult = spawnRefreshFn([bundlePath, 'refresh'], {
    stdio: 'ignore',
    env: minimalEnv,
  });

  void spawnResult; // status code from refresh subprocess is not critical

  // Re-read cache to inspect authState after refresh
  const postRefreshCache = readCache(cachePath);

  if (postRefreshCache === null) {
    process.stderr.write('init: cache not found after refresh subprocess; something went wrong.\n');
    return 3;
  }

  if (postRefreshCache.authState === 'fatal') {
    process.stderr.write(
      'init: credential validation failed (auth-fatal).\n' +
      'Your credentials may be expired or revoked.\n' +
      'Please log in to Claude Code again and re-run `cc-statusline init`.\n',
    );
    return 3;
  }

  if (postRefreshCache.authState === 'cloudflare-blocked') {
    process.stderr.write(
      'init: credential validation was blocked by Cloudflare.\n' +
      'Your network may be filtering traffic to platform.claude.com.\n' +
      'Try from a different network or disable any VPN/proxy, then re-run `cc-statusline init`.\n',
    );
    return 3;
  }

  // authState === 'ok'
  if (postRefreshCache.usage === null && postRefreshCache.lastErrorMessage !== null) {
    process.stdout.write(
      'could not contact the usage API; retry later\n',
    );
    process.stdout.write(
      'Enterprise statusline installed. Restart Claude Code to see usage in the prompt area.\n' +
      'If Claude Code shows "statusline skipped", accept workspace trust for this project.\n',
    );
    return 4;
  }

  process.stdout.write(
    'Enterprise statusline installed. Restart Claude Code to see usage in the prompt area.\n' +
    'If Claude Code shows "statusline skipped", accept workspace trust for this project.\n',
  );
  return 0;
}
