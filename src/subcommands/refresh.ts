import {
  readCache,
  writeCache,
  isRefreshInFlight,
  sanitizeErrorMessage,
  defaultCachePath,
  type Cache,
} from '../cache/store';
import { refresh, fetchUsage } from '../oauth/client';

export interface RefreshDeps {
  cachePath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export async function runRefresh(
  _args: string[],
  deps: RefreshDeps = {},
): Promise<number> {
  const cachePath = deps.cachePath ?? defaultCachePath();
  const fetchImpl = deps.fetchImpl;
  const now = deps.now ?? (() => Date.now());

  try {
    // Step 1: Read cache. If null → exit 0 silently.
    const initialCache = readCache(cachePath);
    if (initialCache === null) {
      return 0;
    }

    // Step 2: If authState is 'fatal' → exit 0 silently.
    if (initialCache.authState === 'fatal') {
      return 0;
    }

    // Step 3: Compare-and-swap dedup.
    // Re-read to get latest state for the in-flight check.
    const casCache = readCache(cachePath);
    if (casCache === null) {
      return 0;
    }

    if (isRefreshInFlight(casCache, now())) {
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
      return 0;
    }

    // Work with a mutable copy of the verified cache.
    let cache: Cache = verifyCache;

    // Step 4: Token refresh decision.
    const FIVE_MINUTES_MS = 5 * 60 * 1000;
    let tokenJustRotated = false;

    if (cache.credentials.expiresAt - now() < FIVE_MINUTES_MS) {
      // Token is near expiry or already expired — refresh it.
      const refreshArgs: Parameters<typeof refresh> = fetchImpl
        ? [cache.credentials.refreshToken, fetchImpl]
        : [cache.credentials.refreshToken];
      const result = await refresh(...refreshArgs);

      switch (result.kind) {
        case 'auth-fatal': {
          const msg = sanitizeErrorMessage(
            `Token refresh failed: ${result.reason}`,
            cache.credentials,
          );
          cache.authState = 'fatal';
          cache.lastErrorMessage = msg;
          await writeCache(cache, cachePath);
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
          return 0;
        }

        case 'rate-limited': {
          const msg = sanitizeErrorMessage(
            `Token refresh rate-limited. Retry-After: ${result.retryAfterSeconds}s.`,
            cache.credentials,
          );
          cache.lastErrorMessage = msg;
          await writeCache(cache, cachePath);
          return 0;
        }

        case 'transient': {
          const msg = sanitizeErrorMessage(result.message, cache.credentials);
          cache.lastErrorMessage = msg;
          await writeCache(cache, cachePath);
          return 0;
        }

        case 'success': {
          cache.credentials = result.data;
          tokenJustRotated = true;
          break;
        }
      }
    }

    // Step 5: Fetch usage.
    const usageArgs: Parameters<typeof fetchUsage> = fetchImpl
      ? [cache.credentials.accessToken, fetchImpl]
      : [cache.credentials.accessToken];
    const usageResult = await fetchUsage(...usageArgs);

    switch (usageResult.kind) {
      case 'auth-fatal': {
        const baseMsg = tokenJustRotated
          ? `Usage fetch failed after token rotation (server-side revocation?): ${usageResult.reason}`
          : `Usage fetch auth-fatal: ${usageResult.reason}`;
        const msg = sanitizeErrorMessage(baseMsg, cache.credentials);
        cache.authState = 'fatal';
        cache.lastErrorMessage = msg;
        await writeCache(cache, cachePath);
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
        return 0;
      }

      case 'rate-limited': {
        const msg = sanitizeErrorMessage(
          `Usage fetch rate-limited. Retry-After: ${usageResult.retryAfterSeconds}s.`,
          cache.credentials,
        );
        cache.lastErrorMessage = msg;
        await writeCache(cache, cachePath);
        return 0;
      }

      case 'transient': {
        const msg = sanitizeErrorMessage(usageResult.message, cache.credentials);
        cache.lastErrorMessage = msg;
        await writeCache(cache, cachePath);
        return 0;
      }

      case 'success': {
        cache.usage = usageResult.data;
        cache.lastUsageRefreshAt = now();
        cache.lastErrorMessage = null;
        cache.authState = 'ok';
        await writeCache(cache, cachePath);
        return 0;
      }
    }
  } catch (err: unknown) {
    // Catastrophic uncaught error — swallow and exit 0 to be spawn-friendly.
    // This path is a last resort; the code above should handle all known cases.
    void err;
    return 0;
  }

  return 0;
}
