import { readCache, defaultCachePath, isRefreshInFlight } from '../cache/store';
import {
  defaultDiagnosticLogPath,
  readDiagnosticLog,
} from '../diagnostics/logger';
import {
  rateLimitCooldownRemainingMs,
  refreshCooldownRemainingMs,
} from './enterprise-refresh-policy';

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
    lines.push('credential source: unavailable (cache absent)');
    lines.push(`diagnostics:   ${logPath}`);
    if (showLogs) {
      const log = await readDiagnosticLog(logPath);
      if (log.length > 0) lines.push('', log.trimEnd());
    }
    lines.push('');
    lines.push('run init to create the cache');
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }

  const nowMs = now();
  const cooldownRemainingMs = refreshCooldownRemainingMs(cache, nowMs);
  const rateLimitRemainingMs = rateLimitCooldownRemainingMs(cache, nowMs);

  lines.push(`cache:         present (schemaVersion ${cache.schemaVersion})`);
  lines.push(`authState:     ${cache.authState}`);
  lines.push(
    `credential source: ${
      cache.credentialSource.kind === 'claude-code'
        ? 'Claude Code'
        : 'explicit file'
    }`,
  );

  const lastUsageLabel =
    cache.lastUsageRefreshAt === 0
      ? 'never'
      : formatRelativeMs(cache.lastUsageRefreshAt - nowMs);
  lines.push(`last usage:    ${lastUsageLabel}`);

  const cooldownLabel =
    rateLimitRemainingMs > 0
      ? `cooling down ${formatRelativeMs(rateLimitRemainingMs)}`
      : 'not rate-limited';
  lines.push(`rate limit:    ${cooldownLabel}`);
  if (cooldownRemainingMs > 0 && rateLimitRemainingMs === 0) {
    lines.push(
      `refresh retry: cooling down ${formatRelativeMs(cooldownRemainingMs)}`,
    );
  }

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
