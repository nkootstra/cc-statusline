import { describe, expect, it } from 'vitest';
import {
  decideEnterpriseRefresh,
  refreshCooldownRemainingMs,
} from '../src/subcommands/enterprise-refresh-policy';
import { makeCache } from './support/render-enterprise';

const NOW = Date.parse('2026-07-28T12:00:00Z');
const STALE_AFTER_MS = 60_000;

describe('decideEnterpriseRefresh', () => {
  it('requires init when no cache exists', () => {
    expect(
      decideEnterpriseRefresh(null, NOW, STALE_AFTER_MS),
    ).toEqual({
      action: 'skip',
      reason: 'cache-missing',
      usageAgeMs: null,
      cooldownRemainingMs: 0,
    });
  });

  it('does nothing while normal credentials and usage are fresh', () => {
    const cache = makeCache({
      lastUsageRefreshAt: NOW - 30_000,
    });

    expect(
      decideEnterpriseRefresh(cache, NOW, STALE_AFTER_MS),
    ).toEqual({ action: 'none' });
  });

  it('spawns a refresh for stale usage', () => {
    const cache = makeCache({
      lastUsageRefreshAt: NOW - STALE_AFTER_MS,
    });

    expect(
      decideEnterpriseRefresh(cache, NOW, STALE_AFTER_MS),
    ).toEqual({
      action: 'spawn',
      reason: 'stale-cache',
      usageAgeMs: STALE_AFTER_MS,
      cooldownRemainingMs: 0,
    });
  });

  it('does not duplicate an in-flight refresh', () => {
    const cache = makeCache({
      lastUsageRefreshAt: NOW - STALE_AFTER_MS,
      lastRefreshStartedAt: NOW - 30_000,
    });

    expect(
      decideEnterpriseRefresh(cache, NOW, STALE_AFTER_MS),
    ).toMatchObject({
      action: 'skip',
      reason: 'in-flight',
    });
  });

  it('honors upstream and adaptive cooldowns', () => {
    const upstream = makeCache({
      lastUsageRefreshAt: NOW - STALE_AFTER_MS,
      rateLimitedUntilMs: NOW + 30_000,
    });
    const adaptive = makeCache({
      lastUsageRefreshAt: NOW - STALE_AFTER_MS,
      rateLimitedUntilMs: NOW - 1,
      nextRefreshAllowedAt: NOW + 90_000,
      consecutiveRateLimitCount: 1,
    });

    expect(
      decideEnterpriseRefresh(upstream, NOW, STALE_AFTER_MS),
    ).toMatchObject({
      action: 'skip',
      reason: 'rate-limit-cooldown',
      cooldownRemainingMs: 30_000,
    });
    expect(
      decideEnterpriseRefresh(adaptive, NOW, STALE_AFTER_MS),
    ).toMatchObject({
      action: 'skip',
      reason: 'adaptive-backoff',
      cooldownRemainingMs: 90_000,
    });
  });

  it('honors a bounded retry cooldown after a non-rate-limit failure', () => {
    const cache = makeCache({
      lastUsageRefreshAt: NOW - STALE_AFTER_MS,
      nextRefreshAllowedAt: NOW + 30_000,
      consecutiveRateLimitCount: 0,
    });

    expect(
      decideEnterpriseRefresh(cache, NOW, STALE_AFTER_MS),
    ).toMatchObject({
      action: 'skip',
      reason: 'retry-cooldown',
      cooldownRemainingMs: 30_000,
    });
  });

  it('retries fatal authentication immediately, then every five minutes', () => {
    const firstAttempt = makeCache({
      authState: 'fatal',
      lastUsageRefreshAt: NOW - 30_000,
      lastRefreshStartedAt: 0,
    });
    const throttled = makeCache({
      authState: 'fatal',
      lastUsageRefreshAt: NOW - 30_000,
      lastRefreshStartedAt: NOW - 2 * 60_000,
    });
    const retryEligible = makeCache({
      authState: 'fatal',
      lastUsageRefreshAt: NOW - 30_000,
      lastRefreshStartedAt: NOW - 5 * 60_000,
    });

    expect(
      decideEnterpriseRefresh(firstAttempt, NOW, STALE_AFTER_MS),
    ).toMatchObject({
      action: 'spawn',
      reason: 'auth-fatal-retry',
    });
    expect(
      decideEnterpriseRefresh(throttled, NOW, STALE_AFTER_MS),
    ).toMatchObject({
      action: 'skip',
      reason: 'auth-fatal-throttled',
    });
    expect(
      decideEnterpriseRefresh(retryEligible, NOW, STALE_AFTER_MS),
    ).toMatchObject({
      action: 'spawn',
      reason: 'auth-fatal-retry',
    });
  });
});

describe('refreshCooldownRemainingMs', () => {
  it('uses the stricter of upstream and adaptive deadlines', () => {
    const cache = makeCache({
      rateLimitedUntilMs: NOW + 30_000,
      nextRefreshAllowedAt: NOW + 90_000,
    });

    expect(refreshCooldownRemainingMs(cache, NOW)).toBe(90_000);
  });
});
