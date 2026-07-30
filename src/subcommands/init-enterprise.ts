import type { SpawnSyncOptions } from 'node:child_process';
import { join } from 'node:path';
import {
  CredentialNotFoundError,
  discover,
  readCredentialFile,
} from '../credentials/discover';
import {
  canonicalizeFileCredentialSource,
  loadCredentialSource,
  type CredentialSource,
} from '../credentials/source';
import { readCache, type Cache } from '../cache/store';
import { fetchUsage } from '../oauth/client';
import type { OAuthCredentials } from '../credentials/envelope';
import type {
  FetchUsageResult,
  UsageResponse,
} from '../oauth/types';

const AUTH_STATUS_TIMEOUT_MS = 10_000;

export interface SpawnClaudeResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string | Buffer | null;
  error?: NodeJS.ErrnoException;
}

export type SpawnClaude = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => SpawnClaudeResult;

export interface EnterprisePreparationOptions {
  cachePath: string;
  credentialsPath?: string;
  force: boolean;
  homedir: string;
  platform: NodeJS.Platform;
  canInteract: boolean;
  discoverFn: typeof discover;
  discoverOptions: Parameters<typeof discover>[0];
  spawnClaude: SpawnClaude;
  now: () => number;
  fetchImpl?: typeof fetch;
}

export type EnterprisePreparation =
  | { kind: 'ready'; cache: Cache | null; reusedExistingCache: boolean }
  | { kind: 'exit'; code: number };

type CandidateValidation =
  | { kind: 'success'; usage: UsageResponse }
  | { kind: 'auth-failure' }
  | {
      kind: 'network-failure';
      result: Exclude<FetchUsageResult, { kind: 'success' | 'auth-fatal' }>;
    };

interface ClaudeAuthStatusJson {
  loggedIn?: unknown;
}

function discoverConfigDir(
  homedir: string,
  discoverOptions: Parameters<typeof discover>[0],
): string {
  return discoverOptions?.claudeConfigDirOverride
    ?? process.env['CLAUDE_CONFIG_DIR']
    ?? join(homedir, '.claude');
}

async function recoverFromCredentialFiles(
  homedir: string,
  discoverOptions: Parameters<typeof discover>[0],
): Promise<OAuthCredentials> {
  const configDir = discoverConfigDir(homedir, discoverOptions);

  const dotCredentialsPath = join(configDir, '.credentials.json');
  const fromDotCredentials = await readCredentialFile(dotCredentialsPath);
  if (fromDotCredentials !== null) {
    return fromDotCredentials;
  }

  const credentialsPath = join(configDir, 'credentials.json');
  const fromCredentials = await readCredentialFile(credentialsPath);
  if (fromCredentials !== null) {
    return fromCredentials;
  }

  throw new CredentialNotFoundError([
    dotCredentialsPath,
    credentialsPath,
  ]);
}

function claudeEnvironment(
  platform: NodeJS.Platform,
  homedir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (process.env['PATH'] !== undefined) env['PATH'] = process.env['PATH'];
  if (platform === 'win32') {
    env['USERPROFILE'] = homedir;
  } else {
    env['HOME'] = homedir;
  }
  if (process.env['CLAUDE_CONFIG_DIR'] !== undefined) {
    env['CLAUDE_CONFIG_DIR'] = process.env['CLAUDE_CONFIG_DIR'];
  }
  return env;
}

function loggedInFrom(result: SpawnClaudeResult): boolean | null {
  if (
    (result.status !== 0 && result.status !== 1) ||
    result.stdout === undefined ||
    result.stdout === null
  ) {
    return null;
  }

  try {
    const raw = typeof result.stdout === 'string'
      ? result.stdout
      : result.stdout.toString('utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const { loggedIn } = parsed as ClaudeAuthStatusJson;
    return typeof loggedIn === 'boolean' ? loggedIn : null;
  } catch {
    return null;
  }
}

function hasUsableCachedCredentials(cache: Cache, now: number): boolean {
  return (
    cache.authState === 'ok' &&
    cache.credentials.accessToken.length > 0 &&
    Number.isFinite(cache.credentials.expiresAt) &&
    cache.credentials.expiresAt > now
  );
}

async function validateCandidate(
  credentials: OAuthCredentials,
  now: number,
  fetchImpl?: typeof fetch,
): Promise<CandidateValidation> {
  if (credentials.expiresAt <= now) {
    return { kind: 'auth-failure' };
  }

  const result = await fetchUsage(credentials.accessToken, fetchImpl);

  switch (result.kind) {
    case 'success':
      return { kind: 'success', usage: result.data };
    case 'auth-fatal':
      return { kind: 'auth-failure' };
    case 'cloudflare-blocked':
    case 'rate-limited':
    case 'transient':
      return { kind: 'network-failure', result };
  }
}

function makeValidatedCache(
  credentials: OAuthCredentials,
  source: CredentialSource,
  usage: UsageResponse,
  now: number,
): Cache {
  return {
    schemaVersion: 4,
    authState: 'ok',
    credentials: {
      accessToken: credentials.accessToken,
      expiresAt: credentials.expiresAt,
    },
    credentialSource: source,
    usage,
    lastUsageRefreshAt: now,
    lastRefreshStartedAt: 0,
    lastErrorMessage: null,
    rateLimitedUntilMs: 0,
    nextRefreshAllowedAt: 0,
    consecutiveRateLimitCount: 0,
  };
}

function printNetworkFailure(
  validation: CandidateValidation & { kind: 'network-failure' },
): void {
  if (validation.result.kind === 'cloudflare-blocked') {
    process.stderr.write(
      'init: credential validation was blocked by Cloudflare.\n' +
      'Try from a different network or disable any VPN/proxy, then re-run `cc-statusline init`.\n',
    );
    return;
  }
  if (validation.result.kind === 'rate-limited') {
    process.stderr.write(
      'init: credential validation was rate-limited; retry later.\n',
    );
    return;
  }
  process.stderr.write(
    'init: could not contact the usage API; retry later.\n',
  );
}

function printManualAuthInstructions(): void {
  process.stderr.write(
    'init: Claude Code authentication is required. Run:\n' +
    'claude auth login\n' +
    'npx @nkootstra/cc-statusline --plan enterprise\n',
  );
}

async function recoverAutomaticCredentials(
  options: EnterprisePreparationOptions,
): Promise<
  | { kind: 'success'; credentials: OAuthCredentials; usage: UsageResponse }
  | { kind: 'exit'; code: number }
> {
  let credentials: OAuthCredentials | null = null;
  let shouldRetryWithLogin = false;
  try {
    credentials = await options.discoverFn(options.discoverOptions);
  } catch (error: unknown) {
    if (!(error instanceof CredentialNotFoundError)) {
      shouldRetryWithLogin = true;
    }
  }

  if (credentials !== null) {
    const validation = await validateCandidate(
      credentials,
      options.now(),
      options.fetchImpl,
    );
    if (validation.kind === 'success') {
      return { kind: 'success', credentials, usage: validation.usage };
    }
    if (validation.kind === 'network-failure') {
      printNetworkFailure(validation);
      return { kind: 'exit', code: 4 };
    }
  }

  if (shouldRetryWithLogin) {
    process.stderr.write('init: could not read Claude Code credentials.\n');
  }

  if (credentials === null && shouldRetryWithLogin) {
    try {
      credentials = await recoverFromCredentialFiles(
        options.homedir,
        options.discoverOptions,
      );
    } catch {
      // continue to interactive recovery.
    }
  }

  if (shouldRetryWithLogin && credentials !== null) {
    const validation = await validateCandidate(
      credentials,
      options.now(),
      options.fetchImpl,
    );
    if (validation.kind === 'success') {
      return { kind: 'success', credentials, usage: validation.usage };
    }
    if (validation.kind === 'network-failure') {
      printNetworkFailure(validation);
      return { kind: 'exit', code: 4 };
    }
  }

  if (!options.canInteract) {
    printManualAuthInstructions();
    return { kind: 'exit', code: 2 };
  }

  const env = claudeEnvironment(options.platform, options.homedir);
  const status = options.spawnClaude('claude', ['auth', 'status'], {
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: AUTH_STATUS_TIMEOUT_MS,
    encoding: 'utf8',
    env,
  });
  const loggedIn = loggedInFrom(status);
  if (loggedIn === true) {
    process.stdout.write(
      'Claude Code reports an active login, but its usage credentials were rejected. Signing in again.\n',
    );
  } else if (loggedIn === false) {
    process.stdout.write('Claude Code is not logged in. Starting login.\n');
  } else {
    process.stdout.write(
      'Could not determine Claude Code login status. Starting login.\n',
    );
  }

  const login = options.spawnClaude('claude', ['auth', 'login'], {
    shell: false,
    stdio: 'inherit',
    env,
  });
  if (login.signal === 'SIGINT' || login.status === 130) {
    return { kind: 'exit', code: 130 };
  }
  if (
    (login.signal ?? null) !== null ||
    login.error !== undefined ||
    login.status !== 0
  ) {
    process.stderr.write(
      'init: `claude auth login` did not complete successfully.\n',
    );
    return { kind: 'exit', code: 3 };
  }

  try {
    credentials = await options.discoverFn(options.discoverOptions);
  } catch {
    try {
      credentials = await recoverFromCredentialFiles(
        options.homedir,
        options.discoverOptions,
      );
    } catch {
      process.stderr.write(
        'init: Claude Code credentials were not available after login.\n',
      );
      return { kind: 'exit', code: 3 };
    }
  }

  const validation = await validateCandidate(
    credentials,
    options.now(),
    options.fetchImpl,
  );
  if (validation.kind === 'auth-failure') {
    process.stderr.write(
      'init: credential validation failed after login.\n',
    );
    return { kind: 'exit', code: 3 };
  }
  if (validation.kind === 'network-failure') {
    printNetworkFailure(validation);
    return { kind: 'exit', code: 4 };
  }
  return { kind: 'success', credentials, usage: validation.usage };
}

export async function prepareEnterprise(
  options: EnterprisePreparationOptions,
): Promise<EnterprisePreparation> {
  if (!options.force && options.credentialsPath === undefined) {
    const existingCache = readCache(options.cachePath);
    if (
      existingCache !== null &&
      hasUsableCachedCredentials(existingCache, options.now())
    ) {
      return {
        kind: 'ready',
        cache: null,
        reusedExistingCache: true,
      };
    }
  }

  if (options.credentialsPath !== undefined) {
    let source: CredentialSource;
    try {
      source = await canonicalizeFileCredentialSource(
        options.credentialsPath,
        { homedirOverride: options.homedir },
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`init: ${message}\n`);
      return { kind: 'exit', code: 2 };
    }

    let credentials: OAuthCredentials;
    try {
      credentials = await loadCredentialSource(source, {
        homedirOverride: options.homedir,
      });
    } catch {
      process.stderr.write(
        'init: could not read credentials from --credentials-path.\n',
      );
      return { kind: 'exit', code: 2 };
    }

    const validation = await validateCandidate(
      credentials,
      options.now(),
      options.fetchImpl,
    );
    if (validation.kind === 'auth-failure') {
      process.stderr.write(
        'init: credential validation failed; credentials are expired or unauthorized.\n',
      );
      return { kind: 'exit', code: 3 };
    }
    if (validation.kind === 'network-failure') {
      printNetworkFailure(validation);
      return { kind: 'exit', code: 4 };
    }

    return {
      kind: 'ready',
      cache: makeValidatedCache(
        credentials,
        source,
        validation.usage,
        options.now(),
      ),
      reusedExistingCache: false,
    };
  }

  if (options.platform === 'darwin') {
    process.stdout.write(
      'note: macOS may prompt to allow keychain access — choose Always Allow to skip future prompts.\n',
    );
  }

  const recovery = await recoverAutomaticCredentials(options);
  if (recovery.kind === 'exit') return recovery;

  return {
    kind: 'ready',
    cache: makeValidatedCache(
      recovery.credentials,
      { kind: 'claude-code' },
      recovery.usage,
      options.now(),
    ),
    reusedExistingCache: false,
  };
}

export function printEnterpriseSuccess(): void {
  process.stdout.write(
    'Enterprise statusline installed. Restart Claude Code to see usage in the prompt area.\n' +
    'If Claude Code shows "statusline skipped", accept workspace trust for this project.\n',
  );
}
