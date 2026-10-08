import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  readSettings,
  setStatusLine,
  clearStatusLine,
  writeSettings,
  defaultSettingsPath,
  type SettingsFile,
} from '../settings/mutator';
import { discover } from '../credentials/discover';
import { writeCache, defaultCachePath } from '../cache/store';
import { prepareCredentials, type SpawnClaude } from './init-credentials';

export type { SpawnClaudeResult } from './init-credentials';

const PKG_VERSION: string = ((): string => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
})();

// Commands earlier versions wrote; init replaces them without a conflict prompt.
const RENDER_SUBCOMMANDS = [
  'render',
  'render --payload-only',
  'render-promax',
  'render-enterprise',
] as const;

export interface InitDeps {
  homedirOverride?: string;
  platformOverride?: NodeJS.Platform;
  bundlePathOverride?: string;
  discoverImpl?: typeof discover;
  stdinReader?: () => Promise<string>;
  isInteractive?: boolean;
  versionString?: string;
  settingsPath?: string;
  cachePath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  spawnClaude?: SpawnClaude;
}

type SettingsPreparation =
  | { kind: 'ready'; shouldWrite: boolean }
  | { kind: 'exit'; code: number };

function getClaudeDir(homedirOverride?: string): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  if (configDir) return configDir;
  return path.join(homedirOverride ?? os.homedir(), '.claude');
}

function getInstallDir(homedirOverride?: string): string {
  return path.join(getClaudeDir(homedirOverride), 'cc-statusline');
}

function getBundleDestPath(homedirOverride?: string): string {
  return path.join(getInstallDir(homedirOverride), 'cc-statusline.js');
}

function commandFor(
  installDir: string,
  subcommand: string,
  platform: NodeJS.Platform,
): string {
  const bundlePath = path.join(installDir, 'cc-statusline.js');
  return platform === 'win32'
    ? `node ${bundlePath} ${subcommand}`
    : `${bundlePath} ${subcommand}`;
}

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

function replaceStatusLine(settings: SettingsFile, command: string): void {
  clearStatusLine(settings);
  setStatusLine(settings, command);
}

async function prepareSettings(
  settings: SettingsFile,
  command: string,
  ownCommands: readonly string[],
  force: boolean,
  canInteract: boolean,
  stdinReader: () => Promise<string>,
): Promise<SettingsPreparation> {
  const mutation = setStatusLine(settings, command);
  if (mutation.action === 'no-change') {
    return { kind: 'ready', shouldWrite: false };
  }
  if (mutation.action !== 'conflict') {
    return { kind: 'ready', shouldWrite: true };
  }
  if (force || ownCommands.includes(mutation.existing ?? '')) {
    replaceStatusLine(settings, command);
    return { kind: 'ready', shouldWrite: true };
  }
  if (!canInteract) {
    process.stderr.write(
      `init: settings.json already has a different statusLine.command:\n  ${mutation.existing ?? ''}\n` +
      'Use --force to overwrite, or uninstall the existing statusline first.\n',
    );
    return { kind: 'exit', code: 2 };
  }

  process.stdout.write(
    `\nExisting statusLine.command: ${mutation.existing ?? ''}\nReplace? (y/n) `,
  );
  const answer = await stdinReader();
  process.stdout.write(`${answer}\n`);
  if (answer.toLowerCase() !== 'y') {
    process.stdout.write('Aborted. No changes made.\n');
    return { kind: 'exit', code: 0 };
  }

  replaceStatusLine(settings, command);
  return { kind: 'ready', shouldWrite: true };
}

export async function runInit(args: string[], deps: InitDeps = {}): Promise<number> {
  let credentialsPathFlag: string | undefined;
  let forceFlag = false;
  let nonInteractiveFlag = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    // Older instructions still pass --plan; the layout is now detected.
    if (arg === '--plan' || arg.startsWith('--plan=')) {
      if (arg === '--plan' && args[i + 1]?.startsWith('--') === false) i++;
      process.stderr.write('init: --plan is no longer needed and is ignored\n');
    } else if (arg.startsWith('--credentials-path=')) {
      credentialsPathFlag = arg.slice('--credentials-path='.length);
    } else if (arg === '--force') {
      forceFlag = true;
    } else if (arg === '--non-interactive') {
      nonInteractiveFlag = true;
    } else {
      process.stderr.write(`init: unknown flag "${arg}"\n`);
      return 1;
    }
  }

  const platform = deps.platformOverride ?? process.platform;
  const homedir = deps.homedirOverride ?? os.homedir();
  const bundleSourcePath = deps.bundlePathOverride ?? __filename;
  const versionString = deps.versionString ?? PKG_VERSION;
  const discoverFn = deps.discoverImpl ?? discover;
  const settingsFilePath = deps.settingsPath ?? defaultSettingsPath();
  const cacheFilePath = deps.cachePath ?? defaultCachePath();
  const now = deps.now ?? Date.now;
  const spawnClaude = deps.spawnClaude ?? spawnSync;
  const canInteract =
    !nonInteractiveFlag &&
    (deps.isInteractive ??
      (process.stdin.isTTY === true && process.stdout.isTTY === true));
  const stdinReader = deps.stdinReader ?? readSingleKeystroke;

  const installDir = getInstallDir(deps.homedirOverride);
  const destinationPath = getBundleDestPath(deps.homedirOverride);
  const command = commandFor(installDir, 'render', platform);
  const settings = readSettings(settingsFilePath);
  const settingsPreparation = await prepareSettings(
    settings,
    command,
    RENDER_SUBCOMMANDS.map((subcommand) => commandFor(installDir, subcommand, platform)),
    forceFlag,
    canInteract,
    stdinReader,
  );
  if (settingsPreparation.kind === 'exit') return settingsPreparation.code;

  const credentialPreparation = await prepareCredentials({
    cachePath: cacheFilePath,
    credentialsPath: credentialsPathFlag,
    force: forceFlag,
    homedir,
    platform,
    canInteract,
    discoverFn,
    discoverOptions: {
      homedirOverride: deps.homedirOverride,
      platformOverride: deps.platformOverride,
    },
    spawnClaude,
    stdinReader,
    now,
    fetchImpl: deps.fetchImpl,
  });
  if (credentialPreparation.kind === 'exit') {
    return credentialPreparation.code;
  }

  fs.mkdirSync(installDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(bundleSourcePath, destinationPath);
  if (platform !== 'win32') {
    fs.chmodSync(destinationPath, 0o755);
  }
  if (credentialPreparation.cache !== null) {
    await writeCache(credentialPreparation.cache, cacheFilePath);
  }
  if (settingsPreparation.shouldWrite) {
    await writeSettings(settingsFilePath, settings);
  }

  process.stdout.write(
    `installed cc-statusline v${versionString} to ${installDir}/cc-statusline.js\n`,
  );

  if (credentialPreparation.reusedExistingCache) {
    process.stdout.write(
      'Usage-aware statusline is already installed with valid credentials.\n' +
      'Re-run with --force to re-validate credentials.\n',
    );
  }
  process.stdout.write(
    'Usage-aware statusline installed. Restart Claude Code to see usage in the prompt area.\n' +
    'If Claude Code shows "statusline skipped", accept workspace trust for this project.\n',
  );
  return 0;
}
