import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cache } from '../src/cache/store';
import type { UsageLimitRow } from '../src/oauth/types';
import {
  AUTH_FATAL_HINT,
  MISSING_CACHE_HINT,
} from '../src/statusline/usage-status';
import { MISSING, STALE_MARKER } from '../src/statusline/format';
import {
  GOLDEN_STDIN,
  makeCache,
  makeCacheWithUsage,
  runWithCache,
  setTTY,
} from './support/render';

let NOW: number;
let SEVEN_DAY_RESET: Date;

function subscriptionStdin(
  overrides: Record<string, unknown> = {},
): string {
  const nowSec = Math.floor(NOW / 1000);
  return JSON.stringify({
    ...JSON.parse(GOLDEN_STDIN),
    rate_limits: {
      five_hour: { used_percentage: 10, resets_at: nowSec + 2 * 3600 },
      seven_day: {
        used_percentage: 20,
        resets_at: Math.floor(SEVEN_DAY_RESET.getTime() / 1000),
      },
    },
    ...overrides,
  });
}

function fableRow(percent = 12): UsageLimitRow {
  return {
    kind: 'weekly_scoped',
    percent,
    resets_at: SEVEN_DAY_RESET.toISOString(),
    scope: { model: { display_name: 'Fable' } },
  };
}

function freshCache(
  usageOverrides: Parameters<typeof makeCacheWithUsage>[0] = {},
  cacheOverrides: Partial<Cache> = {},
): Cache {
  return makeCacheWithUsage(
    { limits: [fableRow()], ...usageOverrides },
    { lastUsageRefreshAt: NOW, ...cacheOverrides },
  );
}

beforeEach(() => {
  vi.stubEnv('NO_COLOR', '1');
  setTTY(false);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 4, 3, 16, 22, 0));
  NOW = Date.now();
  SEVEN_DAY_RESET = new Date(2026, 4, 5, 16, 22, 0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('render: subscription payload', () => {
  it('shows payload 5h/7d without a cache, with no init nag and no refresh', async () => {
    const { output, spawnCalls } = await runWithCache(null, subscriptionStdin(), {
      now: () => NOW,
    });

    expect(output).toBe('Opus 4.7\n5h 10% [18:22] · 7d 20% [Tue 16:22]\n');
    expect(output).not.toContain(MISSING_CACHE_HINT);
    expect(spawnCalls).toHaveLength(0);
  });

  it('adds per-model windows from a matching cache', async () => {
    const { output, spawnCalls } = await runWithCache(
      freshCache({ extra_usage: { is_enabled: false } }),
      subscriptionStdin(),
      { now: () => NOW },
    );

    expect(output).toBe(
      'Opus 4.7\n5h 10% [18:22] · 7d 20% [Tue 16:22] · Fable 12%\n',
    );
    expect(spawnCalls).toHaveLength(0);
  });

  it('keeps 5h/7d for Max with extra usage enabled and appends the extra spend', async () => {
    const { output } = await runWithCache(
      freshCache(),
      subscriptionStdin(),
      { now: () => NOW },
    );

    expect(output).toBe(
      'Opus 4.7\n5h 10% [18:22] · 7d 20% [Tue 16:22] · Fable 12% · extra $780.00 / $1000.00\n',
    );
    expect(output).not.toContain('credits');
  });

  it('omits the extra segment when extra usage carries no credit figures', async () => {
    const { output } = await runWithCache(
      freshCache({ extra_usage: { is_enabled: true } }),
      subscriptionStdin(),
      { now: () => NOW },
    );

    expect(output).not.toContain('extra');
    expect(output).not.toContain(`usage ${MISSING}`);
  });

  it('prefers the 5h/7d figures from the payload over the cached ones', async () => {
    const { output } = await runWithCache(
      freshCache({
        five_hour: { utilization: 99, resets_at: SEVEN_DAY_RESET.toISOString() },
      }),
      subscriptionStdin(),
      { now: () => NOW },
    );

    expect(output).toContain('5h 10%');
    expect(output).not.toContain('99%');
  });

  it('uses per-model windows from the payload when Claude Code forwards them', async () => {
    const { output } = await runWithCache(
      freshCache(),
      subscriptionStdin({
        rate_limits: {
          seven_day: {
            used_percentage: 20,
            resets_at: Math.floor(SEVEN_DAY_RESET.getTime() / 1000),
          },
          model_scoped: [
            {
              display_name: 'Fable',
              utilization: 44,
              resets_at: SEVEN_DAY_RESET.toISOString(),
            },
          ],
        },
      }),
      { now: () => NOW },
    );

    expect(output).toContain('Fable 44%');
    expect(output).not.toContain('Fable 12%');
  });

  it('dims stale cached windows and claims a refresh', async () => {
    const { output, spawnCalls } = await runWithCache(
      freshCache({ extra_usage: { is_enabled: false } }, {
        lastUsageRefreshAt: NOW - 10 * 60_000,
      }),
      subscriptionStdin(),
      { now: () => NOW },
    );

    expect(output).toBe(
      `Opus 4.7\n5h 10% [18:22] · 7d 20% [Tue 16:22] · Fable 12%${STALE_MARKER}\n`,
    );
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args).toContain('refresh');
  });

  it('appends the auth hint when cached windows can no longer refresh', async () => {
    const { output } = await runWithCache(
      freshCache({ extra_usage: { is_enabled: false } }, { authState: 'fatal' }),
      subscriptionStdin(),
      { now: () => NOW },
    );

    expect(output).toContain('5h 10%');
    expect(output).toContain(AUTH_FATAL_HINT);
  });

  it('ignores a credits-only cache from another account and refreshes early', async () => {
    const { output, spawnCalls } = await runWithCache(
      freshCache({ five_hour: null, seven_day: null }, { lastUsageRefreshAt: NOW - 70_000 }),
      subscriptionStdin(),
      { now: () => NOW },
    );

    expect(output).toBe('Opus 4.7\n5h 10% [18:22] · 7d 20% [Tue 16:22]\n');
    expect(spawnCalls).toHaveLength(1);
  });

  it('does not hammer the shared usage endpoint while a credits-only cache is under a minute old', async () => {
    const { spawnCalls } = await runWithCache(
      freshCache({ five_hour: null, seven_day: null }, { lastUsageRefreshAt: NOW - 30_000 }),
      subscriptionStdin(),
      { now: () => NOW },
    );

    expect(spawnCalls).toHaveLength(0);
  });

  it('keeps the live session cost as a payload segment', async () => {
    const stdin = JSON.parse(subscriptionStdin()) as Record<string, unknown>;
    stdin['cost'] = { total_cost_usd: 1.5 };
    const { output } = await runWithCache(null, JSON.stringify(stdin), {
      now: () => NOW,
    });

    expect(output).toContain('7d 20% [Tue 16:22] · $1.50');
  });

  it('puts context and prompt cache on the identity row above the usage row', async () => {
    const { output } = await runWithCache(
      freshCache({ extra_usage: { is_enabled: false } }),
      subscriptionStdin({
        context_window: { used_percentage: 42 },
        prompt_cache: { hit_ratio: 0.87, warm: true, caching_observed: true },
      }),
      { now: () => NOW },
    );

    expect(output).toBe(
      `Opus 4.7 · ctx 42% · cache 87%\n5h 10% [18:22] · 7d 20% [Tue 16:22] · Fable 12%\n`,
    );
  });
});

describe('render: no payload rate limits', () => {
  it('uses the credits layout for an Enterprise cache', async () => {
    const { output } = await runWithCache(freshCache(), GOLDEN_STDIN, {
      now: () => NOW,
    });

    expect(output).toContain('credits $780.00 / $1000.00 (78%)');
    expect(output).not.toContain('5h');
  });

  it('shows 5h/7d from the cache before the first API response', async () => {
    const { output } = await runWithCache(
      freshCache({ extra_usage: { is_enabled: false } }),
      GOLDEN_STDIN,
      { now: () => NOW },
    );

    expect(output).toContain('5h 42%');
    expect(output).toContain('7d 67%');
    expect(output).toContain('Fable 12%');
  });

  it('asks for init when there is no cache either', async () => {
    const { output, spawnCalls } = await runWithCache(null, GOLDEN_STDIN, {
      now: () => NOW,
    });

    expect(output).toBe(`Opus 4.7\nusage ${MISSING} · ${MISSING_CACHE_HINT}\n`);
    expect(spawnCalls).toHaveLength(0);
  });
});

describe('render: gateway mode', () => {
  it('renders only model and context and never refreshes', async () => {
    const { output, spawnCalls } = await runWithCache(
      makeCache({ lastUsageRefreshAt: 0 }),
      subscriptionStdin({ context_window: { used_percentage: 12 } }),
      {
        now: () => NOW,
        env: { ANTHROPIC_BASE_URL: 'https://gateway.example.com' },
      },
    );

    expect(output).toBe('Opus 4.7 · ctx 12%\n');
    expect(spawnCalls).toHaveLength(0);
  });
});
