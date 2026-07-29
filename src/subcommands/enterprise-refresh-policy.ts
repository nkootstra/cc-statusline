import {
  isRefreshInFlight,
  type Cache,
} from '../cache/store';

const AUTH_RETRY_INTERVAL_MS = 5 * 60 * 1000;

export type RefreshDecisionReason =
  | 'cache-missing'
  | 'in-flight'
  | 'adaptive-backoff'
  | 'rate-limit-cooldown'
  | 'retry-cooldown'
  | 'auth-fatal-retry'
  | 'auth-fatal-throttled'
  | 'stale-cache';

export type RefreshDecision =
  | { action: 'none' }
  | {
      action: 'skip' | 'spawn';
      reason: RefreshDecisionReason;
      usageAgeMs: number | null;
      cooldownRemainingMs: number;
    };

export function refreshCooldownRemainingMs(
  cache: Cache,
  nowMs: number,
): number {
  return Math.max(
    0,
    Math.max(cache.rateLimitedUntilMs, cache.nextRefreshAllowedAt) - nowMs,
  );
}

export function rateLimitCooldownRemainingMs(
  cache: Cache,
  nowMs: number,
): number {
  if (
    cache.rateLimitedUntilMs <= nowMs &&
    cache.consecutiveRateLimitCount === 0
  ) {
    return 0;
  }
  return refreshCooldownRemainingMs(cache, nowMs);
}

export function decideEnterpriseRefresh(
  cache: Cache | null,
  nowMs: number,
  staleThresholdMs: number,
): RefreshDecision {
  if (cache === null) {
    return {
      action: 'skip',
      reason: 'cache-missing',
      usageAgeMs: null,
      cooldownRemainingMs: 0,
    };
  }

  const usageAgeMs = nowMs - cache.lastUsageRefreshAt;
  const isStale = usageAgeMs >= staleThresholdMs;
  const isAuthFatal = cache.authState === 'fatal';
  if (!isStale && !isAuthFatal) {
    return { action: 'none' };
  }

  if (
    cache.lastRefreshStartedAt !== 0 &&
    isRefreshInFlight(cache, nowMs)
  ) {
    return {
      action: 'skip',
      reason: 'in-flight',
      usageAgeMs,
      cooldownRemainingMs: 0,
    };
  }

  const cooldownRemainingMs = refreshCooldownRemainingMs(cache, nowMs);
  if (cooldownRemainingMs > 0) {
    return {
      action: 'skip',
      reason:
        cache.rateLimitedUntilMs > nowMs
          ? 'rate-limit-cooldown'
          : cache.consecutiveRateLimitCount > 0
            ? 'adaptive-backoff'
            : 'retry-cooldown',
      usageAgeMs,
      cooldownRemainingMs,
    };
  }

  if (!isAuthFatal) {
    return {
      action: 'spawn',
      reason: 'stale-cache',
      usageAgeMs,
      cooldownRemainingMs: 0,
    };
  }

  const retryEligible =
    cache.lastRefreshStartedAt === 0 ||
    nowMs - cache.lastRefreshStartedAt >= AUTH_RETRY_INTERVAL_MS;
  return {
    action: retryEligible ? 'spawn' : 'skip',
    reason: retryEligible ? 'auth-fatal-retry' : 'auth-fatal-throttled',
    usageAgeMs,
    cooldownRemainingMs: 0,
  };
}
