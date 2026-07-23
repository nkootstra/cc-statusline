import { readCache, defaultCachePath, isRefreshInFlight } from '../cache/store';
import {
  defaultDiagnosticLogPath,
  readDiagnosticLog,
} from '../diagnostics/logger';

export interface DoctorDeps {
  cachePath?: string;
  logPath?: string;
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
  args: string[] = [],
  deps: DoctorDeps = {},
): Promise<number> {
  const cachePath = deps.cachePath ?? defaultCachePath();
  const logPath = deps.logPath ?? defaultDiagnosticLogPath(cachePath);
  const now = deps.now ?? (() => Date.now());
  const showLogs = args.includes('--logs');

  const lines: string[] = ['cc-statusline doctor', ''];
  lines.push(`cache path:    ${cachePath}`);

  const cache = readCache(cachePath);

  if (cache === null) {
    lines.push('cache:         absent or unreadable');
    lines.push('credential use: unavailable (cache absent)');
    lines.push('credential origin: not recorded');
    lines.push(`diagnostics:   ${logPath}`);
    if (showLogs) {
      const log = await readDiagnosticLog(logPath);
      if (log.length > 0) lines.push('', log.trimEnd());
    }
    lines.push('');
    lines.push('Re-run `npx @nkootstra/cc-statusline --plan <pro|max|enterprise>` to install.');
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }

  const nowMs = now();
  const cooldownUntilMs = Math.max(cache.rateLimitedUntilMs, cache.nextRefreshAllowedAt);

  lines.push(`cache:         present (schemaVersion ${cache.schemaVersion})`);
  lines.push(`authState:     ${cache.authState}`);
  lines.push('credential use: local cache (cache.json)');
  lines.push('credential origin: not recorded');

  const lastUsageLabel =
    cache.lastUsageRefreshAt === 0
      ? 'never'
      : formatRelativeMs(cache.lastUsageRefreshAt - nowMs);
  lines.push(`last usage:    ${lastUsageLabel}`);

  const cooldownLabel =
    cooldownUntilMs > nowMs
      ? `cooling down ${formatRelativeMs(cooldownUntilMs - nowMs)}`
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
  lines.push(`diagnostics:   ${logPath}`);

  if (showLogs) {
    const log = await readDiagnosticLog(logPath);
    lines.push('', log.length > 0 ? log.trimEnd() : '(no diagnostic events)');
  }

  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
