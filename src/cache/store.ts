import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import writeFileAtomic from 'write-file-atomic';
import type { OAuthCredentials, UsageResponse } from '../oauth/types';

export type AuthState = 'ok' | 'fatal' | 'cloudflare-blocked';

export interface Cache {
  schemaVersion: 3;
  authState: AuthState;
  credentials: OAuthCredentials;
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

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const version = obj['schemaVersion'];

  if (version === 3) {
    return obj as unknown as Cache;
  }

  if (version === 2) {
    return {
      ...(obj as Omit<
        Cache,
        'schemaVersion' | 'nextRefreshAllowedAt' | 'consecutiveRateLimitCount'
      >),
      schemaVersion: 3,
      nextRefreshAllowedAt: 0,
      consecutiveRateLimitCount: 0,
    };
  }

  // v1/v2 → v3: additive migration to add adaptive backoff fields.
  // Bumping cleanly per AGENTS.md (every shape change bumps the version) while
  // preserving the user's tokens + usage across upgrade. Anything older or
  // unrecognized falls through to null so init can rebuild.
  if (version === 1) {
    return {
      ...(obj as Omit<
        Cache,
        'schemaVersion' |
          'rateLimitedUntilMs' |
          'nextRefreshAllowedAt' |
          'consecutiveRateLimitCount'
      >),
      schemaVersion: 3,
      rateLimitedUntilMs: 0,
      nextRefreshAllowedAt: 0,
      consecutiveRateLimitCount: 0,
    };
  }

  return null;
}

export async function writeCache(cache: Cache, cachePath?: string): Promise<void> {
  const filePath = cachePath ?? defaultCachePath();
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const content = JSON.stringify(cache, null, 2) + '\n';
  await writeFileAtomic(filePath, content, { mode: 0o600 });
}

export function isRefreshInFlight(cache: Cache, now: number = Date.now()): boolean {
  return now - cache.lastRefreshStartedAt < 1000;
}

export function sanitizeErrorMessage(
  message: string,
  credentials: OAuthCredentials,
): string {
  let result = message;
  if (credentials.accessToken.length > 0) {
    result = result.split(credentials.accessToken).join('<redacted>');
  }
  if (credentials.refreshToken.length > 0) {
    result = result.split(credentials.refreshToken).join('<redacted>');
  }
  return result;
}
