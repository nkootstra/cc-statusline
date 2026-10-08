import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { updateCache } from '../cache/store';
import type { Cache } from '../cache/store';
import { decideRefresh } from './refresh-policy';

type SafeSpawnOptions = SpawnOptions & { shell: false };

export type SpawnFn = (
  command: string,
  args: string[],
  opts: SafeSpawnOptions,
  onError?: (err: Error) => void,
) => void;

// The detached refresh child must reach the usage API through the same
// proxy and trust store the parent was started with; everything else
// (cloud credentials, tokens in env) is deliberately withheld.
const REFRESH_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_OPTIONS',
] as const;

function buildMinimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of REFRESH_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function defaultSpawnFn(): SpawnFn {
  return (command, args, opts, onError): void => {
    const child = spawn(command, args, {
      ...opts,
      env: opts.env ?? buildMinimalEnv(),
      shell: false,
    });
    child.on('error', (err) => onError?.(err));
    child.unref();
  };
}

async function claimRefresh(
  cachePath: string,
  nowMs: number,
  staleThresholdMs: number,
): Promise<number | null> {
  try {
    return await updateCache(cachePath, (current) => {
      const decision = decideRefresh(
        current,
        nowMs,
        staleThresholdMs,
      );
      if (decision.action !== 'spawn' || current === null) {
        return { kind: 'skip', value: null };
      }
      return {
        kind: 'write',
        cache: {
          ...current,
          lastRefreshStartedAt: nowMs,
        },
        value: nowMs,
      };
    });
  } catch {
    return null;
  }
}

async function releaseRefreshClaim(
  cachePath: string,
  claimedAt: number,
): Promise<void> {
  try {
    await updateCache(cachePath, (current) => {
      if (
        current === null ||
        current.lastRefreshStartedAt !== claimedAt
      ) {
        return { kind: 'skip', value: undefined };
      }
      return {
        kind: 'write',
        cache: {
          ...current,
          lastRefreshStartedAt: 0,
        },
        value: undefined,
      };
    });
  } catch {
    return;
  }
}

export interface RefreshSpawnOptions {
  cache: Cache | null;
  cachePath: string;
  bundlePath: string;
  spawnFn: SpawnFn;
  nowMs: number;
  staleThresholdMs: number;
}

export async function startBackgroundRefresh(options: RefreshSpawnOptions): Promise<void> {
  const { cache, cachePath, bundlePath, spawnFn, nowMs, staleThresholdMs } = options;
  const refreshDecision = decideRefresh(
    cache,
    nowMs,
    staleThresholdMs,
  );
  if (refreshDecision.action !== 'spawn') return;

  const claimedAt = await claimRefresh(cachePath, nowMs, staleThresholdMs);
  if (claimedAt === null) return;

  const release = (): void => {
    void releaseRefreshClaim(cachePath, claimedAt);
  };
  try {
    spawnFn(
      process.execPath,
      [bundlePath, 'refresh', `--claimed-at=${claimedAt}`],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: buildMinimalEnv(),
        shell: false,
      },
      release,
    );
  } catch {
    await releaseRefreshClaim(cachePath, claimedAt);
  }
}
