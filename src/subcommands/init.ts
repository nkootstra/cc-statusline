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
import {
  prepareEnterprise,
  printEnterpriseSuccess,
  type SpawnClaude,
  type UsageApiPlan,
} from './init-enterprise';

export type { SpawnClaudeResult } from './init-enterprise';

const PKG_VERSION: string = ((): string => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
})();

export type PlanTier = 'pro' | 'max' | 'enterprise';

const PLAN_LABELS: Record<PlanTier, string> = {
  pro: 'Pro',
  max: 'Max',
  enterprise: 'Enterprise',
};

const RENDER_SUBCOMMANDS = [
  'render',
  'render --payload-only',
  'render-promax',
  'render-enterprise',
] as const;

// Claude Code's statusline payload carries no per-model weekly windows, so
// every plan but an explicit Pro reads the usage API too, as Enterprise does.
function usageApiPlan(tier: PlanTier | undefined): UsageApiPlan | 'auto' | null {
  if (tier === undefined) return 'auto';
  return tier === 'pro' ? null : tier;
}

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

function buildCommand(
  installDir: string,
  tier: PlanTier | undefined,
  platform: NodeJS.Platform,
): string {
  const subcommand = usageApiPlan(tier) === null ? 'render --payload-only' : 'render';
  return commandFor(installDir, subcommand, platform);
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
  let planFlag: PlanTier | undefined;
  let credentialsPathFlag: string | undefined;
  let forceFlag = false;
  let nonInteractiveFlag = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--plan=')) {
      const value = arg.slice('--plan='.length).toLowerCase();
      if (value !== 'pro' && value !== 'max' && value !== 'enterprise') {
        process.stderr.write(
          `init: unknown plan "${value}"; expected pro, max, or enterprise\n`,
        );
        return 1;
      }
      planFlag = value;
    } else if (arg === '--plan') {
      const value = args[++i]?.toLowerCase();
      if (value !== 'pro' && value !== 'max' && value !== 'enterprise') {
        process.stderr.write(
          `init: unknown plan "${value ?? ''}"; expected pro, max, or enterprise\n`,
        );
        return 1;
      }
      planFlag = value;
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

  const tier = planFlag;
  const installDir = getInstallDir(deps.homedirOverride);
  const destinationPath = getBundleDestPath(deps.homedirOverride);
  const command = buildCommand(installDir, tier, platform);
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

  const apiPlan = usageApiPlan(tier);
  const enterprisePreparation = apiPlan === null
    ? null
    : await prepareEnterprise({
        plan: apiPlan,
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
  if (enterprisePreparation?.kind === 'exit') {
    return enterprisePreparation.code;
  }

  fs.mkdirSync(installDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(bundleSourcePath, destinationPath);
  if (platform !== 'win32') {
    fs.chmodSync(destinationPath, 0o755);
  }
  if (
    enterprisePreparation !== null &&
    enterprisePreparation.kind === 'ready' &&
    enterprisePreparation.cache !== null
  ) {
    await writeCache(enterprisePreparation.cache, cacheFilePath);
  }
  if (settingsPreparation.shouldWrite) {
    await writeSettings(settingsFilePath, settings);
  }

  process.stdout.write(
    `installed cc-statusline v${versionString} to ${installDir}/cc-statusline.js\n`,
  );

  if (apiPlan === null) {
    process.stdout.write(
      'Pro statusline installed. Restart Claude Code to see usage in the prompt area.\n' +
      'If Claude Code shows "statusline skipped", accept workspace trust for this project.\n',
    );
    return 0;
  }

  const label = tier === undefined ? 'Usage-aware' : PLAN_LABELS[tier];
  if (enterprisePreparation?.reusedExistingCache === true) {
    process.stdout.write(
      `${label} statusline is already installed with valid credentials.\n` +
      'Re-run with --force to re-validate credentials.\n',
    );
  }
  printEnterpriseSuccess(label);
  return 0;
}
