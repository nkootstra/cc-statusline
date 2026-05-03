import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import writeFileAtomic from 'write-file-atomic';
import type { OAuthCredentials, UsageResponse } from '../oauth/types';

export type AuthState = 'ok' | 'fatal' | 'cloudflare-blocked';

export interface Cache {
  schemaVersion: 1;
  authState: AuthState;
  credentials: OAuthCredentials;
  usage: UsageResponse | null;
  lastUsageRefreshAt: number;     // epoch ms; 0 means never
  lastRefreshStartedAt: number;   // epoch ms; 0 means none
  lastErrorMessage: string | null; // sanitized
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

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as Record<string, unknown>)['schemaVersion'] !== 1
  ) {
    return null;
  }

  return parsed as Cache;
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
