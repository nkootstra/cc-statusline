import {
  updateCache,
  isRefreshInFlight,
  sanitizeErrorMessage,
  defaultCachePath,
  type Cache,
  type CachedCredentials,
} from '../cache/store';
import {
  loadCredentialSource,
  type CredentialSource,
} from '../credentials/source';
import { fetchUsage } from '../oauth/client';
import {
  createDiagnosticLogger,
  defaultDiagnosticLogPath,
  type DiagnosticLogger,
} from '../diagnostics/logger';
import type { OAuthCredentials } from '../credentials/envelope';
import type {
  FetchUsageResult,
  RateLimitDiagnostics,
} from '../oauth/types';
import { refreshCooldownRemainingMs } from './enterprise-refresh-policy';

const SOURCE_RELOAD_THRESHOLD_MS = 5 * 60 * 1000;
const FAILURE_RETRY_DELAY_MS = 60 * 1000;
const RATE_LIMIT_BACKOFF_MAX_MS = 5 * 60 * 1000;
const RATE_LIMIT_BACKOFF_CAP_EXPONENT = 6;

type SourceReloadReason = 'near-expiry' | 'auth-fatal' | 'usage-401';
type LoadCredentialSource = (
  source: CredentialSource,
) => Promise<OAuthCredentials>;

export interface RefreshDeps {
  cachePath?: string;
  logPath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  loadCredentialSourceImpl?: LoadCredentialSource;
}

function formatRateLimitMessage(
  prefix: string,
  diag: RateLimitDiagnostics,
): string {
  const headerNote = diag.retryAfterPresent
    ? 'header present'
    : 'header absent, default applied';
  const shouldRetryNote =
    diag.xShouldRetry === null
      ? ''
      : ` x-should-retry: ${diag.xShouldRetry ? 'true' : 'false'}.`;
  return `${prefix} Retry-After: ${diag.retryAfterSeconds}s (${headerNote}).${shouldRetryNote}`;
}

function nextRateLimitCooldownUntil(
  nowMs: number,
  retryAfterSeconds: number,
  consecutiveCount: number,
): number {
  const baseMs = retryAfterSeconds * 1000;
  const exponent = Math.min(
    consecutiveCount + 2,
    RATE_LIMIT_BACKOFF_CAP_EXPONENT,
  );
  const adaptiveMs = baseMs * (1 << exponent);
  return nowMs + Math.min(adaptiveMs, RATE_LIMIT_BACKOFF_MAX_MS);
}

function statusForResult(result: FetchUsageResult): number | undefined {
  if (result.kind === 'success') return 200;
  if (result.kind === 'rate-limited') return 429;
  if (result.kind === 'auth-fatal') return 401;
  return result.status;
}

async function logUsageResult(
  logger: DiagnosticLogger,
  result: FetchUsageResult,
  durationMs: number,
  credentials: CachedCredentials,
  candidate?: OAuthCredentials,
): Promise<void> {
  const details: Record<string, unknown> = {
    event: 'http.result',
    endpoint: 'usage',
    result: result.kind,
    status: statusForResult(result),
    durationMs,
  };

  if (result.kind === 'rate-limited') {
    details['retryAfterSeconds'] = result.retryAfterSeconds;
    details['retryAfterPresent'] = result.retryAfterPresent;
    details['xShouldRetry'] = result.xShouldRetry;
  } else if (result.kind === 'transient') {
    details['error'] = sanitizeErrorMessage(
      result.message,
      credentials,
      candidate,
    );
  } else if (result.kind === 'auth-fatal') {
    details['reason'] = sanitizeErrorMessage(
      result.reason,
      credentials,
      candidate,
    );
  }

  await logger.log(details);
}

async function requestUsage(
  accessToken: string,
  cachedCredentials: CachedCredentials,
  logger: DiagnosticLogger,
  fetchImpl?: typeof fetch,
  candidate?: OAuthCredentials,
): Promise<FetchUsageResult> {
  await logger.log({ event: 'http.request', endpoint: 'usage' });
  const startedAt = performance.now();
  const result = await fetchUsage(accessToken, fetchImpl);
  await logUsageResult(
    logger,
    result,
    Math.round(performance.now() - startedAt),
    cachedCredentials,
    candidate,
  );
  return result;
}

async function reloadSource(
  cache: Cache,
  reason: SourceReloadReason,
  loadSource: LoadCredentialSource,
  logger: DiagnosticLogger,
): Promise<
  | { kind: 'success'; credentials: OAuthCredentials }
  | { kind: 'failure'; message: string }
> {
  await logger.log({
    event: 'credential-source.reload.decision',
    action: 'reload',
    reason,
    source: cache.credentialSource.kind,
  });

  try {
    const credentials = await loadSource(cache.credentialSource);
    await logger.log({
      event: 'credential-source.reload.result',
      result: 'success',
      accessTokenChanged:
        credentials.accessToken !== cache.credentials.accessToken,
      expiryAdvanced:
        credentials.expiresAt > cache.credentials.expiresAt,
    });
    return { kind: 'success', credentials };
  } catch (err: unknown) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = sanitizeErrorMessage(rawMessage, cache.credentials);
    await logger.log({
      event: 'credential-source.reload.result',
      result: 'failure',
      error: message,
    });
    return { kind: 'failure', message };
  }
}

function candidateCredentials(
  latest: CachedCredentials,
  candidate: OAuthCredentials,
): CachedCredentials {
  if (
    latest.accessToken === candidate.accessToken &&
    latest.expiresAt >= candidate.expiresAt
  ) {
    return latest;
  }
  return {
    accessToken: candidate.accessToken,
    expiresAt: candidate.expiresAt,
  };
}

function credentialsMatch(
  left: CachedCredentials,
  right: CachedCredentials,
): boolean {
  return (
    left.accessToken === right.accessToken &&
    left.expiresAt === right.expiresAt
  );
}

async function updateOwnedCache(
  cachePath: string,
  startingCredentials: CachedCredentials,
  startedAt: number,
  mutate: (current: Cache) => void,
): Promise<boolean> {
  return updateCache(cachePath, (current) => {
    if (
      current === null ||
      current.lastRefreshStartedAt !== startedAt ||
      !credentialsMatch(current.credentials, startingCredentials)
    ) {
      return { kind: 'skip', value: false };
    }
    mutate(current);
    return { kind: 'write', cache: current, value: true };
  });
}

async function persistSourceFailure(
  startingCredentials: CachedCredentials,
  startedAt: number,
  cachePath: string,
  message: string,
  now: () => number,
): Promise<boolean> {
  return updateOwnedCache(
    cachePath,
    startingCredentials,
    startedAt,
    (current) => {
      current.lastErrorMessage = sanitizeErrorMessage(
        message,
        current.credentials,
      );
      current.rateLimitedUntilMs = 0;
      current.nextRefreshAllowedAt = now() + FAILURE_RETRY_DELAY_MS;
      current.consecutiveRateLimitCount = 0;
    },
  );
}

async function persistFinal401(
  startingCredentials: CachedCredentials,
  startedAt: number,
  cachePath: string,
  reason: string,
  candidate?: OAuthCredentials,
): Promise<boolean> {
  return updateOwnedCache(
    cachePath,
    startingCredentials,
    startedAt,
    (current) => {
      current.authState = 'fatal';
      current.lastErrorMessage = sanitizeErrorMessage(
        `Usage fetch auth-fatal: ${reason}`,
        current.credentials,
        candidate,
      );
    },
  );
}

async function persistNonSuccess(
  startingCredentials: CachedCredentials,
  startedAt: number,
  cachePath: string,
  result: Exclude<FetchUsageResult, { kind: 'success' | 'auth-fatal' }>,
  now: () => number,
  candidate?: OAuthCredentials,
): Promise<boolean> {
  return updateOwnedCache(
    cachePath,
    startingCredentials,
    startedAt,
    (current) => {
      switch (result.kind) {
        case 'cloudflare-blocked':
          current.authState = 'cloudflare-blocked';
          current.lastErrorMessage = sanitizeErrorMessage(
            `Usage fetch blocked by Cloudflare (status ${result.status}). ` +
              'Your network may be filtering traffic to api.anthropic.com.',
            current.credentials,
            candidate,
          );
          current.rateLimitedUntilMs = 0;
          current.nextRefreshAllowedAt = now() + FAILURE_RETRY_DELAY_MS;
          current.consecutiveRateLimitCount = 0;
          break;

        case 'rate-limited': {
          const observedAt = now();
          current.lastErrorMessage = sanitizeErrorMessage(
            formatRateLimitMessage('Usage fetch rate-limited.', result),
            current.credentials,
            candidate,
          );
          current.rateLimitedUntilMs =
            observedAt + result.retryAfterSeconds * 1000;
          current.nextRefreshAllowedAt = nextRateLimitCooldownUntil(
            observedAt,
            result.retryAfterSeconds,
            current.consecutiveRateLimitCount,
          );
          current.consecutiveRateLimitCount += 1;
          break;
        }

        case 'transient':
          current.lastErrorMessage = sanitizeErrorMessage(
            result.message,
            current.credentials,
            candidate,
          );
          current.rateLimitedUntilMs = 0;
          current.nextRefreshAllowedAt = now() + FAILURE_RETRY_DELAY_MS;
          current.consecutiveRateLimitCount = 0;
          break;
      }
    },
  );
}

async function persistSuccess(
  startingCredentials: CachedCredentials,
  startedAt: number,
  cachePath: string,
  result: Extract<FetchUsageResult, { kind: 'success' }>,
  now: () => number,
  candidate?: OAuthCredentials,
): Promise<boolean> {
  return updateOwnedCache(
    cachePath,
    startingCredentials,
    startedAt,
    (current) => {
      if (candidate !== undefined) {
        current.credentials = candidateCredentials(
          current.credentials,
          candidate,
        );
      }

      current.usage = result.data;
      current.lastUsageRefreshAt = now();
      current.lastErrorMessage = null;
      current.authState = 'ok';
      current.rateLimitedUntilMs = 0;
      current.nextRefreshAllowedAt = 0;
      current.consecutiveRateLimitCount = 0;
    },
  );
}

type RefreshClaim =
  | { kind: 'claimed'; cache: Cache; startedAt: number }
  | {
      kind: 'skipped';
      reason:
        | 'cache-missing'
        | 'rate-limit-cooldown'
        | 'in-flight'
        | 'claim-lost';
      cooldownRemainingMs?: number;
    };

function inheritedClaimFrom(args: string[]): number | null {
  const prefix = '--claimed-at=';
  const argument = args.find((value) => value.startsWith(prefix));
  if (argument === undefined) return null;

  const claimedAt = Number(argument.slice(prefix.length));
  return Number.isSafeInteger(claimedAt) && claimedAt > 0
    ? claimedAt
    : null;
}

export async function runRefresh(
  args: string[],
  deps: RefreshDeps = {},
): Promise<number> {
  const cachePath = deps.cachePath ?? defaultCachePath();
  const logPath = deps.logPath ?? defaultDiagnosticLogPath(cachePath);
  const now = deps.now ?? (() => Date.now());
  const logger = createDiagnosticLogger(logPath, { now });
  const loadSource =
    deps.loadCredentialSourceImpl ??
    ((source: CredentialSource) => loadCredentialSource(source));
  const inheritedClaim = inheritedClaimFrom(args);

  try {
    const claim = await updateCache<RefreshClaim>(cachePath, (current) => {
      if (current === null) {
        return {
          kind: 'skip',
          value: { kind: 'skipped', reason: 'cache-missing' },
        };
      }

      if (inheritedClaim !== null) {
        if (current.lastRefreshStartedAt !== inheritedClaim) {
          return {
            kind: 'skip',
            value: { kind: 'skipped', reason: 'claim-lost' },
          };
        }
        return {
          kind: 'skip',
          value: {
            kind: 'claimed',
            cache: current,
            startedAt: inheritedClaim,
          },
        };
      }

      const observedAt = now();
      const cooldownRemainingMs = refreshCooldownRemainingMs(
        current,
        observedAt,
      );
      if (cooldownRemainingMs > 0) {
        return {
          kind: 'skip',
          value: {
            kind: 'skipped',
            reason: 'rate-limit-cooldown',
            cooldownRemainingMs,
          },
        };
      }
      if (isRefreshInFlight(current, observedAt)) {
        return {
          kind: 'skip',
          value: { kind: 'skipped', reason: 'in-flight' },
        };
      }

      const cache = {
        ...current,
        lastRefreshStartedAt: observedAt,
      };
      return {
        kind: 'write',
        cache,
        value: { kind: 'claimed', cache, startedAt: observedAt },
      };
    });

    if (claim.kind === 'skipped') {
      await logger.log({
        event: 'refresh.skipped',
        reason: claim.reason,
        ...(claim.cooldownRemainingMs === undefined
          ? {}
          : { cooldownRemainingMs: claim.cooldownRemainingMs }),
      });
      return 0;
    }

    const { cache, startedAt } = claim;
    const startingCredentials = { ...cache.credentials };
    await logger.log({ event: 'refresh.started' });

    let candidate: OAuthCredentials | undefined;
    const needsSourceReload =
      cache.authState === 'fatal' ||
      cache.credentials.expiresAt - now() < SOURCE_RELOAD_THRESHOLD_MS;

    if (needsSourceReload) {
      const reason: SourceReloadReason =
        cache.authState === 'fatal' ? 'auth-fatal' : 'near-expiry';
      const loaded = await reloadSource(
        cache,
        reason,
        loadSource,
        logger,
      );
      if (loaded.kind === 'failure') {
        const persisted = await persistSourceFailure(
          startingCredentials,
          startedAt,
          cachePath,
          loaded.message,
          now,
        );
        await logger.log({
          event: 'refresh.completed',
          outcome: persisted ? 'source-failure' : 'stale-discarded',
        });
        return 0;
      }
      candidate = loaded.credentials;
    } else {
      await logger.log({
        event: 'credential-source.reload.decision',
        action: 'skip',
        reason: 'credential-fresh',
      });
    }

    let usageResult = await requestUsage(
      candidate?.accessToken ?? cache.credentials.accessToken,
      cache.credentials,
      logger,
      deps.fetchImpl,
      candidate,
    );

    if (usageResult.kind === 'auth-fatal' && candidate === undefined) {
      const loaded = await reloadSource(
        cache,
        'usage-401',
        loadSource,
        logger,
      );
      if (loaded.kind === 'failure') {
        const persisted = await persistFinal401(
          startingCredentials,
          startedAt,
          cachePath,
          usageResult.reason,
        );
        await logger.log({
          event: 'refresh.completed',
          outcome: persisted ? 'auth-fatal' : 'stale-discarded',
        });
        return 0;
      }

      candidate = loaded.credentials;
      if (
        candidate.accessToken !== cache.credentials.accessToken
      ) {
        usageResult = await requestUsage(
          candidate.accessToken,
          cache.credentials,
          logger,
          deps.fetchImpl,
          candidate,
        );
      }
    }

    switch (usageResult.kind) {
      case 'auth-fatal': {
        const persisted = await persistFinal401(
          startingCredentials,
          startedAt,
          cachePath,
          usageResult.reason,
          candidate,
        );
        await logger.log({
          event: 'refresh.completed',
          outcome: persisted ? 'auth-fatal' : 'stale-discarded',
        });
        return 0;
      }

      case 'cloudflare-blocked':
      case 'rate-limited':
      case 'transient': {
        const persisted = await persistNonSuccess(
          startingCredentials,
          startedAt,
          cachePath,
          usageResult,
          now,
          candidate,
        );
        await logger.log({
          event: 'refresh.completed',
          outcome: persisted ? usageResult.kind : 'stale-discarded',
        });
        return 0;
      }

      case 'success': {
        const persisted = await persistSuccess(
          startingCredentials,
          startedAt,
          cachePath,
          usageResult,
          now,
          candidate,
        );
        await logger.log({
          event: 'refresh.completed',
          outcome: persisted ? 'success' : 'stale-discarded',
        });
        return 0;
      }
    }
  } catch {
    await logger.log({ event: 'refresh.crashed' });
    return 0;
  }
}
