import {
  readCache,
  writeCache,
  isRefreshInFlight,
  sanitizeErrorMessage,
  defaultCachePath,
  type Cache,
} from '../cache/store';
import { refresh, fetchUsage } from '../oauth/client';
import {
  createDiagnosticLogger,
  defaultDiagnosticLogPath,
  type DiagnosticLogger,
} from '../diagnostics/logger';
import type {
  FetchUsageResult,
  RateLimitDiagnostics,
  RefreshResult,
} from '../oauth/types';

function formatRateLimitMessage(prefix: string, diag: RateLimitDiagnostics): string {
  const headerNote = diag.retryAfterPresent
    ? 'header present'
    : 'header absent, default applied';
  const shouldRetryNote =
    diag.xShouldRetry === null
      ? ''
      : ` x-should-retry: ${diag.xShouldRetry ? 'true' : 'false'}.`;
  return `${prefix} Retry-After: ${diag.retryAfterSeconds}s (${headerNote}).${shouldRetryNote}`;
}

export interface RefreshDeps {
  cachePath?: string;
  logPath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

type RequestEndpoint = 'token' | 'usage';
type RequestResult = RefreshResult | FetchUsageResult;
const RATE_LIMIT_BACKOFF_MAX_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_BACKOFF_CAP_EXPONENT = 6; // max ×64

function nextRateLimitCooldownUntil(
  nowMs: number,
  retryAfterSeconds: number,
  consecutiveCount: number,
): number {
  const baseMs = retryAfterSeconds * 1000;
  const exponent = Math.min(consecutiveCount + 2, RATE_LIMIT_BACKOFF_CAP_EXPONENT);
  const adaptiveMs = baseMs * (1 << exponent);
  const delayMs = Math.min(adaptiveMs, RATE_LIMIT_BACKOFF_MAX_MS);
  return nowMs + delayMs;
}

function getRefreshCooldownUntilMs(cache: Cache, nowMs: number): number {
  return Math.max(0, Math.max(cache.rateLimitedUntilMs, cache.nextRefreshAllowedAt) - nowMs);
}

function statusForResult(endpoint: RequestEndpoint, result: RequestResult): number | undefined {
  if (result.kind === 'success') return 200;
  if (result.kind === 'rate-limited') return 429;
  if (result.kind === 'auth-fatal') {
    if (result.reason === '401') return 401;
    if (endpoint === 'token' && result.reason === 'invalid_grant') return 400;
    return undefined;
  }
  return result.status;
}

async function logRequestResult(
  logger: DiagnosticLogger,
  endpoint: RequestEndpoint,
  result: RequestResult,
  durationMs: number,
  credentials: Cache['credentials'],
): Promise<void> {
  const details: Record<string, unknown> = {
    event: 'http.result',
    endpoint,
    result: result.kind,
    status: statusForResult(endpoint, result),
    durationMs,
  };

  if (result.kind === 'rate-limited') {
    details['retryAfterSeconds'] = result.retryAfterSeconds;
    details['retryAfterPresent'] = result.retryAfterPresent;
    details['xShouldRetry'] = result.xShouldRetry;
  } else if (result.kind === 'transient') {
    details['error'] = sanitizeErrorMessage(result.message, credentials);
  } else if (result.kind === 'auth-fatal') {
    details['reason'] = sanitizeErrorMessage(result.reason, credentials);
  }

  await logger.log(details);
}

export async function runRefresh(
  _args: string[],
  deps: RefreshDeps = {},
): Promise<number> {
  const cachePath = deps.cachePath ?? defaultCachePath();
  const logPath = deps.logPath ?? defaultDiagnosticLogPath(cachePath);
  const fetchImpl = deps.fetchImpl;
  const now = deps.now ?? (() => Date.now());
  const logger = createDiagnosticLogger(logPath, { now });

  try {
    // Step 1: Read cache. If null → exit 0 silently.
    const initialCache = readCache(cachePath);
    if (initialCache === null) {
      await logger.log({ event: 'refresh.skipped', reason: 'cache-missing' });
      return 0;
    }

    // Step 2: If authState is 'fatal' → exit 0 silently.
    if (initialCache.authState === 'fatal') {
      await logger.log({ event: 'refresh.skipped', reason: 'auth-fatal' });
      return 0;
    }

    // Step 2b: If still in rate-limit cooldown → exit silently. The renderer
    // also gates on this, but a stale install or a different code path could
    // still fire refresh, so guard here too.
    const cooldownRemainingMs = getRefreshCooldownUntilMs(initialCache, now());
    if (cooldownRemainingMs > 0) {
      await logger.log({
        event: 'refresh.skipped',
        reason: 'rate-limit-cooldown',
        cooldownRemainingMs,
      });
      return 0;
    }

    // Step 3: Compare-and-swap dedup.
    // Re-read to get latest state for the in-flight check.
    const casCache = readCache(cachePath);
    if (casCache === null) {
      return 0;
    }

    if (isRefreshInFlight(casCache, now())) {
      await logger.log({ event: 'refresh.skipped', reason: 'in-flight' });
      return 0;
    }

    // Mark refresh as in-flight by writing lastRefreshStartedAt.
    const startedAt = now();
    casCache.lastRefreshStartedAt = startedAt;
    await writeCache(casCache, cachePath);

    // Re-read to verify we won the CAS race.
    const verifyCache = readCache(cachePath);
    if (
      verifyCache === null ||
      verifyCache.lastRefreshStartedAt !== startedAt
    ) {
      // Another process overwrote our write; exit silently.
      await logger.log({ event: 'refresh.skipped', reason: 'cas-lost' });
      return 0;
    }

    // Work with a mutable copy of the verified cache.
    let cache: Cache = verifyCache;
    await logger.log({ event: 'refresh.started' });

    // Step 4: Token refresh decision.
    const FIVE_MINUTES_MS = 5 * 60 * 1000;
    let tokenJustRotated = false;

    if (cache.credentials.expiresAt - now() < FIVE_MINUTES_MS) {
      // Token is near expiry or already expired — refresh it.
      await logger.log({
        event: 'token.refresh.decision',
        action: 'refresh',
        expiresInMs: cache.credentials.expiresAt - now(),
      });
      const refreshArgs: Parameters<typeof refresh> = fetchImpl
        ? [cache.credentials.refreshToken, fetchImpl]
        : [cache.credentials.refreshToken];
      await logger.log({ event: 'http.request', endpoint: 'token' });
      const requestStartedAt = performance.now();
      const result = await refresh(...refreshArgs);
      await logRequestResult(
        logger,
        'token',
        result,
        Math.round(performance.now() - requestStartedAt),
        cache.credentials,
      );

      switch (result.kind) {
        case 'auth-fatal': {
          const msg = sanitizeErrorMessage(
            `Token refresh failed: ${result.reason}`,
            cache.credentials,
          );
          cache.authState = 'fatal';
          cache.lastErrorMessage = msg;
          await writeCache(cache, cachePath);
          await logger.log({ event: 'refresh.completed', outcome: 'auth-fatal' });
          return 0;
        }

        case 'cloudflare-blocked': {
          const msg = sanitizeErrorMessage(
            `Token refresh blocked by Cloudflare (status ${result.status}). ` +
              'Your network may be filtering traffic to platform.claude.com.',
            cache.credentials,
          );
          cache.authState = 'cloudflare-blocked';
          cache.lastErrorMessage = msg;
          await writeCache(cache, cachePath);
          await logger.log({ event: 'refresh.completed', outcome: 'cloudflare-blocked' });
          return 0;
        }

        case 'rate-limited': {
          const msg = sanitizeErrorMessage(
            formatRateLimitMessage('Token refresh rate-limited.', result),
            cache.credentials,
          );
          const nextRefreshAllowedAt = nextRateLimitCooldownUntil(
            now(),
            result.retryAfterSeconds,
            cache.consecutiveRateLimitCount,
          );
          cache.lastErrorMessage = msg;
          cache.rateLimitedUntilMs = now() + result.retryAfterSeconds * 1000;
          cache.nextRefreshAllowedAt = nextRefreshAllowedAt;
          cache.consecutiveRateLimitCount += 1;
          await writeCache(cache, cachePath);
          await logger.log({
            event: 'refresh.completed',
            outcome: 'rate-limited',
            cooldownUntilMs: Math.max(cache.rateLimitedUntilMs, cache.nextRefreshAllowedAt),
          });
          return 0;
        }

        case 'transient': {
          const msg = sanitizeErrorMessage(result.message, cache.credentials);
          cache.lastErrorMessage = msg;
          await writeCache(cache, cachePath);
          await logger.log({ event: 'refresh.completed', outcome: 'transient' });
          return 0;
        }

        case 'success': {
          cache.credentials = result.data;
          tokenJustRotated = true;
          break;
        }
      }
    } else {
      await logger.log({ event: 'token.refresh.decision', action: 'skip', reason: 'token-fresh' });
    }

    // Step 5: Fetch usage.
    const usageArgs: Parameters<typeof fetchUsage> = fetchImpl
      ? [cache.credentials.accessToken, fetchImpl]
      : [cache.credentials.accessToken];
    await logger.log({ event: 'http.request', endpoint: 'usage' });
    const usageRequestStartedAt = performance.now();
    const usageResult = await fetchUsage(...usageArgs);
    await logRequestResult(
      logger,
      'usage',
      usageResult,
      Math.round(performance.now() - usageRequestStartedAt),
      cache.credentials,
    );

    switch (usageResult.kind) {
      case 'auth-fatal': {
        const baseMsg = tokenJustRotated
          ? `Usage fetch failed after token rotation (server-side revocation?): ${usageResult.reason}`
          : `Usage fetch auth-fatal: ${usageResult.reason}`;
        const msg = sanitizeErrorMessage(baseMsg, cache.credentials);
        cache.authState = 'fatal';
        cache.lastErrorMessage = msg;
        await writeCache(cache, cachePath);
        await logger.log({ event: 'refresh.completed', outcome: 'auth-fatal' });
        return 0;
      }

      case 'cloudflare-blocked': {
        const msg = sanitizeErrorMessage(
          `Usage fetch blocked by Cloudflare (status ${usageResult.status}). ` +
            'Your network may be filtering traffic to api.anthropic.com.',
          cache.credentials,
        );
        cache.authState = 'cloudflare-blocked';
        cache.lastErrorMessage = msg;
        await writeCache(cache, cachePath);
        await logger.log({ event: 'refresh.completed', outcome: 'cloudflare-blocked' });
        return 0;
      }

      case 'rate-limited': {
        const msg = sanitizeErrorMessage(
          formatRateLimitMessage('Usage fetch rate-limited.', usageResult),
          cache.credentials,
        );
        const nextRefreshAllowedAt = nextRateLimitCooldownUntil(
          now(),
          usageResult.retryAfterSeconds,
          cache.consecutiveRateLimitCount,
        );
        cache.lastErrorMessage = msg;
        cache.rateLimitedUntilMs = now() + usageResult.retryAfterSeconds * 1000;
        cache.nextRefreshAllowedAt = nextRefreshAllowedAt;
        cache.consecutiveRateLimitCount += 1;
        await writeCache(cache, cachePath);
        await logger.log({
          event: 'refresh.completed',
          outcome: 'rate-limited',
          cooldownUntilMs: Math.max(cache.rateLimitedUntilMs, cache.nextRefreshAllowedAt),
        });
        return 0;
      }

      case 'transient': {
        const msg = sanitizeErrorMessage(usageResult.message, cache.credentials);
        cache.lastErrorMessage = msg;
        await writeCache(cache, cachePath);
        await logger.log({ event: 'refresh.completed', outcome: 'transient' });
        return 0;
      }

      case 'success': {
        cache.usage = usageResult.data;
        cache.lastUsageRefreshAt = now();
        cache.lastErrorMessage = null;
        cache.authState = 'ok';
        cache.rateLimitedUntilMs = 0;
        cache.nextRefreshAllowedAt = 0;
        cache.consecutiveRateLimitCount = 0;
        await writeCache(cache, cachePath);
        await logger.log({ event: 'refresh.completed', outcome: 'success' });
        return 0;
      }
    }
  } catch (err: unknown) {
    // Catastrophic uncaught error — swallow and exit 0 to be spawn-friendly.
    // This path is a last resort; the code above should handle all known cases.
    void err;
    await logger.log({ event: 'refresh.crashed' });
    return 0;
  }

  return 0;
}
