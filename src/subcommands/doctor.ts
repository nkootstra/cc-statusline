import { readCache, defaultCachePath, isRefreshInFlight } from '../cache/store';

export interface DoctorDeps {
  cachePath?: string;
  now?: () => number;
}

function formatRelativeMs(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 1000) return `${ms}ms`;
  const seconds = Math.round(abs / 1000);
  if (seconds < 60) return ms < 0 ? `${seconds}s ago` : `in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return ms < 0 ? `${minutes}m ago` : `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return ms < 0 ? `${hours}h ago` : `in ${hours}h`;
}

export async function runDoctor(
  _args: string[] = [],
  deps: DoctorDeps = {},
): Promise<number> {
  const cachePath = deps.cachePath ?? defaultCachePath();
  const now = deps.now ?? (() => Date.now());

  const lines: string[] = ['cc-statusline doctor', ''];
  lines.push(`cache path:    ${cachePath}`);

  const cache = readCache(cachePath);

  if (cache === null) {
    lines.push('cache:         absent or unreadable');
    lines.push('');
    lines.push('Re-run `npx @nkootstra/cc-statusline --plan <pro|max|enterprise>` to install.');
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }

  const nowMs = now();

  lines.push(`cache:         present (schemaVersion ${cache.schemaVersion})`);
  lines.push(`authState:     ${cache.authState}`);

  const lastUsageLabel =
    cache.lastUsageRefreshAt === 0
      ? 'never'
      : formatRelativeMs(cache.lastUsageRefreshAt - nowMs);
  lines.push(`last usage:    ${lastUsageLabel}`);

  const cooldownLabel =
    cache.rateLimitedUntilMs > nowMs
      ? `cooling down ${formatRelativeMs(cache.rateLimitedUntilMs - nowMs)}`
      : 'not rate-limited';
  lines.push(`rate limit:    ${cooldownLabel}`);

  lines.push(`refresh:       ${isRefreshInFlight(cache, nowMs) ? 'in flight' : 'idle'}`);

  // Token expiry without revealing the token itself.
  const expiryLabel =
    cache.credentials.expiresAt === 0
      ? 'unknown'
      : formatRelativeMs(cache.credentials.expiresAt - nowMs);
  lines.push(`token expiry:  ${expiryLabel}`);

  lines.push(`last error:    ${cache.lastErrorMessage ?? 'none'}`);

  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
