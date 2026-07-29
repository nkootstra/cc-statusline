import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import writeFileAtomic from 'write-file-atomic';
import type { OAuthCredentials } from '../credentials/envelope';
import type { UsageResponse } from '../oauth/types';
import { decodeUsageResponse } from '../oauth/usage';
import type { CredentialSource } from '../credentials/source';
import { withCacheLock } from './lock';

export type AuthState = 'ok' | 'fatal' | 'cloudflare-blocked';

export type CachedCredentials = Pick<OAuthCredentials, 'accessToken' | 'expiresAt'>;

export interface Cache {
  schemaVersion: 4;
  authState: AuthState;
  credentials: CachedCredentials;
  credentialSource: CredentialSource;
  usage: UsageResponse | null;
  lastUsageRefreshAt: number;     // epoch ms; 0 means never
  lastRefreshStartedAt: number;   // epoch ms; 0 means none
  lastErrorMessage: string | null; // sanitized
  rateLimitedUntilMs: number;     // epoch ms; 0 means not rate-limited
  // Adaptive 429 backoff. nextRefreshAllowedAt may be > rateLimitedUntilMs.
  nextRefreshAllowedAt: number;   // epoch ms; 0 means no extra cooldown
  // Consecutive backoff depth for repeated 429s.
  consecutiveRateLimitCount: number; // 0 when no backoff streak
}

export type CacheUpdate<T> =
  | { kind: 'write'; cache: Cache; value: T }
  | { kind: 'skip'; value: T };

interface CachedCredentialsJson {
  accessToken?: unknown;
  expiresAt?: unknown;
}

interface CredentialSourceJson {
  kind?: unknown;
  path?: unknown;
}

interface CacheJson {
  schemaVersion?: unknown;
  authState?: unknown;
  credentials?: unknown;
  credentialSource?: unknown;
  usage?: unknown;
  lastUsageRefreshAt?: unknown;
  lastRefreshStartedAt?: unknown;
  lastErrorMessage?: unknown;
  rateLimitedUntilMs?: unknown;
  nextRefreshAllowedAt?: unknown;
  consecutiveRateLimitCount?: unknown;
}

function parseCachedCredentials(value: unknown): CachedCredentials | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as CachedCredentialsJson;
  if (
    typeof candidate.accessToken !== 'string' ||
    candidate.accessToken.length === 0 ||
    typeof candidate.expiresAt !== 'number' ||
    !Number.isFinite(candidate.expiresAt) ||
    Object.hasOwn(value, 'refreshToken')
  ) {
    return null;
  }
  return {
    accessToken: candidate.accessToken,
    expiresAt: candidate.expiresAt,
  };
}

function parseCredentialSource(value: unknown): CredentialSource | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as CredentialSourceJson;
  if (candidate.kind === 'claude-code') {
    return { kind: 'claude-code' };
  }
  if (
    candidate.kind !== 'file' ||
    typeof candidate.path !== 'string' ||
    candidate.path.length === 0
  ) {
    return null;
  }
  return { kind: 'file', path: candidate.path };
}

function parseCache(value: unknown): Cache | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as CacheJson;
  const credentials = parseCachedCredentials(candidate.credentials);
  const credentialSource = parseCredentialSource(candidate.credentialSource);
  const usage = candidate.usage === null
    ? null
    : decodeUsageResponse(candidate.usage);
  const authState = candidate.authState;
  const lastErrorMessage = candidate.lastErrorMessage;

  if (
    candidate.schemaVersion !== 4 ||
    (authState !== 'ok' &&
      authState !== 'fatal' &&
      authState !== 'cloudflare-blocked') ||
    credentials === null ||
    credentialSource === null ||
    (usage === null && candidate.usage !== null) ||
    typeof candidate.lastUsageRefreshAt !== 'number' ||
    !Number.isFinite(candidate.lastUsageRefreshAt) ||
    typeof candidate.lastRefreshStartedAt !== 'number' ||
    !Number.isFinite(candidate.lastRefreshStartedAt) ||
    (lastErrorMessage !== null && typeof lastErrorMessage !== 'string') ||
    typeof candidate.rateLimitedUntilMs !== 'number' ||
    !Number.isFinite(candidate.rateLimitedUntilMs) ||
    typeof candidate.nextRefreshAllowedAt !== 'number' ||
    !Number.isFinite(candidate.nextRefreshAllowedAt) ||
    typeof candidate.consecutiveRateLimitCount !== 'number' ||
    !Number.isInteger(candidate.consecutiveRateLimitCount) ||
    candidate.consecutiveRateLimitCount < 0
  ) {
    return null;
  }

  return {
    schemaVersion: 4,
    authState,
    credentials,
    credentialSource,
    usage,
    lastUsageRefreshAt: candidate.lastUsageRefreshAt,
    lastRefreshStartedAt: candidate.lastRefreshStartedAt,
    lastErrorMessage,
    rateLimitedUntilMs: candidate.rateLimitedUntilMs,
    nextRefreshAllowedAt: candidate.nextRefreshAllowedAt,
    consecutiveRateLimitCount: candidate.consecutiveRateLimitCount,
  };
}

export function defaultCachePath(): string {
  const configDir =
    process.env['CLAUDE_CONFIG_DIR'] ??
    path.join(os.homedir(), '.claude');
  return path.join(configDir, 'cc-statusline', 'cache.json');
}

export function readCache(cachePath?: string): Cache | null {
  const filePath = cachePath ?? defaultCachePath();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return parseCache(parsed);
}

async function writeCacheUnlocked(cache: Cache, filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const persistedCache: Cache = {
    ...cache,
    credentials: {
      accessToken: cache.credentials.accessToken,
      expiresAt: cache.credentials.expiresAt,
    },
  };
  const content = JSON.stringify(persistedCache, null, 2) + '\n';
  await writeFileAtomic(filePath, content, { mode: 0o600 });
}

export async function writeCache(
  cache: Cache,
  cachePath?: string,
): Promise<void> {
  const filePath = cachePath ?? defaultCachePath();
  await withCacheLock(filePath, () => writeCacheUnlocked(cache, filePath));
}

export async function updateCache<T>(
  cachePath: string,
  updater: (current: Cache | null) => CacheUpdate<T>,
): Promise<T> {
  return withCacheLock(cachePath, async () => {
    const update = updater(readCache(cachePath));
    if (update.kind === 'write') {
      await writeCacheUnlocked(update.cache, cachePath);
    }
    return update.value;
  });
}

export function isRefreshInFlight(cache: Cache, now: number = Date.now()): boolean {
  return (
    cache.lastRefreshStartedAt !== 0 &&
    now - cache.lastRefreshStartedAt < 45_000
  );
}

export function sanitizeErrorMessage(
  message: string,
  credentials: CachedCredentials | OAuthCredentials,
  candidateCredentials?: OAuthCredentials,
): string {
  let result = message;
  const candidates = [credentials, candidateCredentials];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    if (candidate.accessToken.length > 0) {
      result = result.split(candidate.accessToken).join('<redacted>');
    }
    const refreshToken =
      'refreshToken' in candidate ? candidate.refreshToken : undefined;
    if (typeof refreshToken === 'string' && refreshToken.length > 0) {
      result = result.split(refreshToken).join('<redacted>');
    }
  }
  return result;
}
