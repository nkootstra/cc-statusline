import type { Cache } from '../cache/store';
import { rateLimitCooldownRemainingMs } from '../subcommands/refresh-policy';

const STALE_THRESHOLD_DEFAULT_MS = 120 * 1000; // 2 minutes
const STALE_THRESHOLD_MIN_MS = 10 * 1000; // 10 seconds
const STALE_THRESHOLD_MAX_MS = 900 * 1000; // 15 minutes
const STALE_THRESHOLD_ENV = 'CC_STATUSLINE_ENTERPRISE_STALE_MS';

// A lone 429 is usually another client on the same account burning the shared
// quota and the next refresh succeeds, so only a repeat earns the banner.
const RATE_LIMITED_HINT_MIN_CONSECUTIVE = 2;

// Must stay at most 50 characters.
export const AUTH_FATAL_HINT = ' run init to repair auth';

export const MISSING_CACHE_HINT = 'run init';

export const CLOUDFLARE_HINT = ' refresh blocked (cloudflare); see README#cloudflare';

export const RATE_LIMITED_HINT_PREFIX = ' rate-limited; retry in ';

function formatRateLimitedHint(msUntilReset: number): string {
  const secondsRemaining = Math.max(1, Math.ceil(msUntilReset / 1000));
  if (secondsRemaining < 60) {
    return `${RATE_LIMITED_HINT_PREFIX}${secondsRemaining}s`;
  }
  const minutesRemaining = Math.ceil(secondsRemaining / 60);
  return `${RATE_LIMITED_HINT_PREFIX}${minutesRemaining}m`;
}

export function getStaleThresholdMs(): number {
  const raw = process.env[STALE_THRESHOLD_ENV];
  if (raw === undefined) {
    return STALE_THRESHOLD_DEFAULT_MS;
  }

  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return STALE_THRESHOLD_DEFAULT_MS;
  }

  const rounded = Math.floor(parsed);
  return Math.max(STALE_THRESHOLD_MIN_MS, Math.min(STALE_THRESHOLD_MAX_MS, rounded));
}

export function isCacheStale(cache: Cache | null, nowMs: number, staleThresholdMs: number): boolean {
  const staleAge = cache !== null ? nowMs - cache.lastUsageRefreshAt : Infinity;
  return staleAge >= staleThresholdMs;
}

export function buildAuthHint(cache: Cache | null, nowMs: number): string {
  if (cache === null) return '';
  if (cache.authState === 'fatal') return AUTH_FATAL_HINT;
  if (cache.authState === 'cloudflare-blocked') return CLOUDFLARE_HINT;
  const cooldownRemainingMs = rateLimitCooldownRemainingMs(cache, nowMs);
  if (
    cooldownRemainingMs > 0 &&
    cache.consecutiveRateLimitCount >= RATE_LIMITED_HINT_MIN_CONSECUTIVE
  ) {
    return formatRateLimitedHint(cooldownRemainingMs);
  }
  return '';
}
