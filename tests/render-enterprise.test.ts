/**
 * Tests for the render-enterprise subcommand (U8).
 *
 * All 20 scenarios from the plan are covered.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import type { Cache } from '../src/cache/store';
import type { UsageResponse } from '../src/oauth/types';

// ---------------------------------------------------------------------------
// Import the function under test
// ---------------------------------------------------------------------------

import {
  runRenderEnterprise,
  AUTH_FATAL_HINT,
  MISSING_CACHE_HINT,
  CLOUDFLARE_HINT,
} from '../src/subcommands/render-enterprise';
import { STALE_MARKER, MISSING } from '../src/statusline/format';
import * as storeModule from '../src/cache/store';
import {
  captureStdout,
  GOLDEN_STDIN,
  loadFixture,
  makeCache,
  makeCacheWithUsage,
  makeStream,
  runWithCache,
  setTTY,
} from './support/render-enterprise';

// ---------------------------------------------------------------------------
// Global setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('NO_COLOR', '');
  setTTY(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('golden Enterprise output', () => {
  beforeEach(() => {
    vi.stubEnv('NO_COLOR', '1');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 3, 16, 22, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders exact extra-usage line', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage(
      {
        extra_usage: {
          is_enabled: true,
          utilization: 78,
          used_credits: 78000,
          monthly_limit: 100000,
        },
      },
      { lastUsageRefreshAt: NOW - 30 * 1000 },
    );

    const { output } = await runWithCache(cache, GOLDEN_STDIN, { now: () => NOW });

    expect(output).toBe('Opus 4.7 · credits $780.00 / $1000.00 (78%)\n');
  });

  it('renders exact fallback bucket line', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage(
      {
        extra_usage: { is_enabled: false },
        five_hour: {
          utilization: 42,
          resets_at: new Date(2026, 4, 3, 17, 22, 0).toISOString(),
        },
        seven_day: {
          utilization: 81,
          resets_at: new Date(2026, 4, 5, 16, 22, 0).toISOString(),
        },
      },
      { lastUsageRefreshAt: NOW - 30 * 1000 },
    );

    const { output } = await runWithCache(cache, GOLDEN_STDIN, { now: () => NOW });

    expect(output).toBe('Opus 4.7 · 5h 42% [17:22] · 7d 81% [Tue 16:22]\n');
  });

  it('renders exact missing-cache repair line', async () => {
    const { output, spawnCalls } = await runWithCache(null, GOLDEN_STDIN);

    expect(output).toBe('Opus 4.7 · usage — · run init\n');
    expect(spawnCalls).toHaveLength(0);
  });
});

// ============================================================================
// Scenario 1: Happy path — extra_usage.is_enabled=true, $780.00 / $1000.00 (78%)
// ============================================================================

describe('Scenario 1 (AE2): happy path — extra_usage enabled, recent cache', () => {
  it('renders $780.00 / $1000.00 (78%) from usage-response.json', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage({}, {
      lastUsageRefreshAt: NOW - 30 * 1000, // 30 s ago — recent
    });

    const { output, exitCode, spawnCalls } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(exitCode).toBe(0);
    expect(output).toContain('$780.00 / $1000.00 (78%)');
    // Recent — no spawn fired
    expect(spawnCalls).toHaveLength(0);
  });

  it('output includes model name from stdin fixture', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage({}, { lastUsageRefreshAt: NOW - 30 * 1000 });

    const { output } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(output).toContain('claude-opus-4-5');
  });

  it('treats API-provided extra_usage.utilization as a percentage', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage(
      {
        extra_usage: {
          is_enabled: true,
          utilization: 15.5,
          used_credits: 1550,
          monthly_limit: 10000,
        },
      },
      { lastUsageRefreshAt: NOW - 5 * 60 * 1000 },
    );

    const { output } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(output).toContain('$15.50 / $100.00 (16%)');
    expect(output).not.toContain('1550%');
  });
});

// ============================================================================
// Scenario 2: Recent cache (14 min) — no spawn, no dim, no STALE_MARKER
// ============================================================================

describe('Scenario 2: recent cache (30 s) — no spawn fired, no stale markers', () => {
  it('does not spawn and does not append STALE_MARKER', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage({}, {
      lastUsageRefreshAt: NOW - 30 * 1000, // 30 s ago — within window
    });

    const { output, spawnCalls } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(spawnCalls).toHaveLength(0);
    expect(output).not.toContain(STALE_MARKER);
    // Figures should appear un-dimmed (no ANSI dim codes — non-TTY anyway)
    expect(output).toContain('$780.00 / $1000.00 (78%)');
  });
});

// ============================================================================
// Scenario 3 (AE7): extra_usage.is_enabled=false — fallback to 5h/7d view
// ============================================================================

describe('Scenario 3 (AE7): extra_usage.is_enabled=false — 5h/7d fallback', () => {
  it('renders "5h" and "7d" segments with utilization and reset hints', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage(
      {
        extra_usage: {
          is_enabled: false,
          utilization: 0.42,
          used_credits: 42000,
          monthly_limit: 100000,
        },
      },
      { lastUsageRefreshAt: NOW - 5 * 60 * 1000 },
    );

    const { output } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(output).toContain('5h');
    expect(output).toContain('7d');
    // Should NOT contain the dollar-amount enterprise format
    expect(output).not.toMatch(/\$\d+\.\d+ \/ \$/);
  });

  it('includes reset hint from each bucket resetsAt', async () => {
    const NOW = Date.now();
    // Use a future resetsAt so formatResetHint returns non-MISSING.
    const futureResetsAt = new Date(NOW + 3 * 60 * 60 * 1000).toISOString(); // 3h from now
    const cache = makeCacheWithUsage(
      {
        extra_usage: { is_enabled: false },
        five_hour: { utilization: 0.42, resetsAt: futureResetsAt },
        seven_day: { utilization: 0.67, resetsAt: futureResetsAt },
      },
      { lastUsageRefreshAt: NOW - 5 * 60 * 1000 },
    );

    const { output } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(output).toContain('5h');
    expect(output).toContain('7d');
    // Some reset hint should appear (not MISSING for a future date).
    expect(output).toMatch(/\d{2}:\d{2}/);
  });

  it('treats fallback bucket utilization as percent and accepts resets_at', async () => {
    vi.stubEnv('NO_COLOR', '1');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 3, 12, 0, 0));
    const NOW = Date.now();
    const futureResetsAt = new Date(NOW + 3 * 60 * 60 * 1000).toISOString();
    const cache = makeCacheWithUsage(
      {
        extra_usage: { is_enabled: false },
        five_hour: { utilization: 42, resets_at: futureResetsAt },
        seven_day: { utilization: 67, resets_at: futureResetsAt },
      } as Partial<UsageResponse>,
      { lastUsageRefreshAt: NOW - 5 * 60 * 1000 },
    );

    const { output } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    vi.useRealTimers();

    expect(output).toMatch(/5h 42% \[\d{2}:\d{2}\]/);
    expect(output).toMatch(/7d 67% \[\d{2}:\d{2}\]/);
    expect(output).not.toContain('4200%');
    expect(output).not.toContain('6700%');
  });

  it('reset hint is computed from the injected `now`, not the wall clock', async () => {
    vi.stubEnv('NO_COLOR', '1');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 14, 23, 0, 0));

    const injectedNow = new Date(2026, 3, 15, 14, 0, 0).getTime();
    const resetsAt = new Date(2026, 3, 15, 15, 0, 0).toISOString();
    const cache = makeCacheWithUsage(
      {
        extra_usage: { is_enabled: false },
        five_hour: { utilization: 42, resets_at: resetsAt },
        seven_day: { utilization: 67, resets_at: resetsAt },
      } as Partial<UsageResponse>,
      { lastUsageRefreshAt: injectedNow - 5 * 60 * 1000 },
    );

    const { output } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => injectedNow },
    );

    vi.useRealTimers();

    expect(output).toContain('[15:00]');
    expect(output).not.toMatch(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/);
  });

  it('renders placeholders when fallback buckets are null', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage(
      {
        extra_usage: { is_enabled: false },
        five_hour: null,
        seven_day: null,
      } as Partial<UsageResponse>,
      { lastUsageRefreshAt: NOW - 5 * 60 * 1000 },
    );

    const { output, exitCode } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(exitCode).toBe(0);
    expect(output).toContain(`5h ${MISSING}`);
    expect(output).toContain(`7d ${MISSING}`);
  });
});

// ============================================================================
// Scenario 4 (AE3): authState='fatal' — figures dimmed + remediation hint
// ============================================================================

describe('Scenario 4 (AE3): authState=fatal — dimmed figures + remediation hint', () => {
  it('output contains the auth-fatal hint', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage({}, {
      authState: 'fatal',
      lastUsageRefreshAt: NOW - 5 * 60 * 1000,
    });

    const { output, exitCode } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(exitCode).toBe(0);
    expect(output).toContain(AUTH_FATAL_HINT.trim());
  });

  it('auth-fatal hint is at most 50 chars', () => {
    expect(AUTH_FATAL_HINT).toBe(' run init to repair auth');
    expect(AUTH_FATAL_HINT.trim().length).toBeLessThanOrEqual(50);
  });

  it('throttles fatal-auth recovery for five minutes', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage({}, {
      authState: 'fatal',
      lastUsageRefreshAt: NOW - 30_000,
      lastRefreshStartedAt: NOW - 2 * 60_000,
    });
    const { spawnCalls } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(spawnCalls).toHaveLength(0);
  });

  it('spawns background recovery immediately when fatal auth has never retried', async () => {
    const NOW = 100;
    const cache = makeCacheWithUsage({}, {
      authState: 'fatal',
      lastUsageRefreshAt: NOW - 30_000,
      lastRefreshStartedAt: 0,
    });
    const { spawnCalls } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      {
        now: () => NOW,
      },
    );

    expect(spawnCalls).toHaveLength(1);
  });

  it('spawns fatal-auth recovery again after five minutes', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage({}, {
      authState: 'fatal',
      lastUsageRefreshAt: NOW - 30_000,
      lastRefreshStartedAt: NOW - 5 * 60_000,
    });

    const { spawnCalls } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(spawnCalls).toHaveLength(1);
  });

  it('honors in-flight and rate-limit guards during fatal-auth recovery', async () => {
    const NOW = Date.now();
    const inFlight = makeCacheWithUsage({}, {
      authState: 'fatal',
      lastRefreshStartedAt: NOW - 500,
    });
    const coolingDown = makeCacheWithUsage({}, {
      authState: 'fatal',
      lastRefreshStartedAt: 0,
      rateLimitedUntilMs: NOW + 60_000,
    });

    const first = await runWithCache(
      inFlight,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );
    const second = await runWithCache(
      coolingDown,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(first.spawnCalls).toHaveLength(0);
    expect(second.spawnCalls).toHaveLength(0);
  });
});

// ============================================================================
// Scenario 5: Cache missing — output includes an actionable init hint
// ============================================================================

describe('Scenario 5: cache missing (null)', () => {
  it('renders "usage —" and the init hint without spawning refresh', async () => {
    const { output, exitCode, spawnCalls } = await runWithCache(
      null,
      loadFixture('stdin-enterprise.json'),
    );

    expect(exitCode).toBe(0);
    expect(output).toContain(`usage ${MISSING}`);
    expect(output).toContain(MISSING_CACHE_HINT);
    expect(output).not.toContain('fetching…');
    expect(spawnCalls).toHaveLength(0);
  });
});

// ============================================================================
// Scenario 6: Cache malformed (readCache returns null) — same as missing
// ============================================================================

describe('Scenario 6: cache malformed — readCache returns null', () => {
  it('renders the init hint without spawning refresh for malformed v4 JSON', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cc-statusline-render-malformed-'));
    const cachePath = join(tmpDir, 'cache.json');
    const spawnCalls: Array<{
      command: string;
      args: string[];
      opts: SpawnOptions;
    }> = [];
    writeFileSync(cachePath, JSON.stringify({ schemaVersion: 4 }), 'utf8');

    try {
      const { output, exitCode } = await captureStdout(() =>
        runRenderEnterprise(
          [],
          makeStream(loadFixture('stdin-enterprise.json')),
          {
            cachePath,
            bundlePath: '/bundle.js',
            spawnRefresh: (command, args, opts) => {
              spawnCalls.push({ command, args, opts });
            },
          },
        ),
      );

      expect(exitCode).toBe(0);
      expect(output).toContain(`usage ${MISSING}`);
      expect(output).toContain(MISSING_CACHE_HINT);
      expect(output).not.toContain('fetching…');
      expect(spawnCalls).toHaveLength(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Scenario 7: Stdin missing cost — omits zero cost
// ============================================================================

describe('Scenario 7: stdin missing cost — omits zero cost', () => {
  it('does not render $0.00 when cost field is absent', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage({}, { lastUsageRefreshAt: NOW - 1 * 60 * 1000 });

    const stdinNoCost = JSON.stringify({
      session_id: 'test',
      transcript_path: '/t',
      cwd: '/c',
      model: { id: 'm', display_name: 'test-model' },
      workspace: { current_dir: '/c', project_dir: '/c' },
      version: '1',
      output_style: { name: 'default' },
      // cost field intentionally omitted
      exceeds_200k_tokens: false,
    });

    const { output } = await runWithCache(cache, stdinNoCost, { now: () => NOW });

    expect(output).not.toContain('$0.00');
  });
});

// ============================================================================
// Scenario 8: Stdin missing entirely (empty/null) — renders empty + exit 0
// ============================================================================

describe('Scenario 8: stdin missing entirely — silent fail', () => {
  it('produces a newline and exit 0 on empty stdin', async () => {
    const readCacheSpy = vi.spyOn(storeModule, 'readCache').mockReturnValue(null);

    const { output, exitCode } = await captureStdout(() =>
      runRenderEnterprise(
        [],
        makeStream(''),
        { cachePath: '/mocked', bundlePath: '/bundle.js' },
      ),
    );

    readCacheSpy.mockRestore();
    expect(exitCode).toBe(0);
    expect(output).toBe('\n');
  });

  it('produces a newline and exit 0 on whitespace-only stdin', async () => {
    const readCacheSpy = vi.spyOn(storeModule, 'readCache').mockReturnValue(null);

    const { output, exitCode } = await captureStdout(() =>
      runRenderEnterprise(
        [],
        makeStream('   \n\t  '),
        { cachePath: '/mocked', bundlePath: '/bundle.js' },
      ),
    );

    readCacheSpy.mockRestore();
    expect(exitCode).toBe(0);
    expect(output).toBe('\n');
  });
});

// ============================================================================
// Scenario 12: extra_usage undefined — treat as AE7 fallback (5h/7d view)
// ============================================================================

describe('Scenario 12: extra_usage undefined — AE7 fallback', () => {
  it('renders 5h/7d view when extra_usage is absent', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage(
      { extra_usage: undefined },
      { lastUsageRefreshAt: NOW - 5 * 60 * 1000 },
    );

    const { output } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(output).toContain('5h');
    expect(output).toContain('7d');
    expect(output).not.toMatch(/\$\d+\.\d+ \/ \$/);
  });
});

// ============================================================================
// Scenario 13: extra_usage.used_credits null/undefined but is_enabled=true
//              → render "usage —" (not "$NaN")
// ============================================================================

describe('Scenario 13: is_enabled=true but used_credits missing — usage —', () => {
  it('renders "usage —" rather than $NaN when used_credits is undefined', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage(
      {
        extra_usage: {
          is_enabled: true,
          // used_credits intentionally absent
          monthly_limit: 100000,
        },
      },
      { lastUsageRefreshAt: NOW - 5 * 60 * 1000 },
    );

    const { output } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(output).toContain(`usage ${MISSING}`);
    expect(output).not.toContain('NaN');
  });

  it('renders "usage —" when monthly_limit is also missing', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage(
      {
        extra_usage: { is_enabled: true },
      },
      { lastUsageRefreshAt: NOW - 5 * 60 * 1000 },
    );

    const { output } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(output).toContain(`usage ${MISSING}`);
    expect(output).not.toContain('NaN');
  });
});

// ============================================================================
// Scenario 14: authState='cloudflare-blocked' — normal render + cloudflare hint
// ============================================================================

describe('Scenario 14: authState=cloudflare-blocked — normal figures + cloudflare hint', () => {
  it('appends the Cloudflare hint to output', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage({}, {
      authState: 'cloudflare-blocked',
      lastUsageRefreshAt: NOW - 5 * 60 * 1000, // recent
    });

    const { output, exitCode } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(exitCode).toBe(0);
    expect(output).toContain(CLOUDFLARE_HINT.trim());
  });

  it('Cloudflare hint is verbatim different from auth-fatal hint', () => {
    expect(CLOUDFLARE_HINT).not.toBe(AUTH_FATAL_HINT);
  });

  it('still renders usage figures normally when recent', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage({}, {
      authState: 'cloudflare-blocked',
      lastUsageRefreshAt: NOW - 5 * 60 * 1000,
    });

    const { output } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    // The dollar amounts should still appear.
    expect(output).toContain('$780.00 / $1000.00 (78%)');
  });
});

// ============================================================================
// Scenario 15: First-render UX then second render with populated cache
// ============================================================================

describe('Scenario 15: init-required UX → populated cache', () => {
  it('first render requests init; second render shows populated usage', async () => {
    const NOW = Date.now();

    // First render: no cache.
    const { output: firstOutput, spawnCalls: firstSpawns } = await runWithCache(
      null,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(firstOutput).toContain(MISSING_CACHE_HINT);
    expect(firstOutput).not.toContain('fetching…');
    expect(firstSpawns).toHaveLength(0);

    // Second render: cache now populated.
    const populatedCache = makeCacheWithUsage({}, {
      lastUsageRefreshAt: NOW, // just refreshed
    });

    const { output: secondOutput, spawnCalls: secondSpawns } = await runWithCache(
      populatedCache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(secondOutput).not.toContain('fetching…');
    expect(secondSpawns).toHaveLength(0); // recent — no spawn needed
  });
});

// ============================================================================
// Scenario 16: Stale + NO_COLOR=1 — output contains textual STALE_MARKER ' ~'
// ============================================================================

describe('Scenario 16 (R15): stale + NO_COLOR=1 — textual STALE_MARKER visible', () => {
  it('contains " ~" marker even when ANSI is suppressed', async () => {
    vi.stubEnv('NO_COLOR', '1');

    const NOW = Date.now();
    const cache = makeCacheWithUsage({}, {
      lastUsageRefreshAt: NOW - 20 * 60 * 1000, // 20 min ago — stale
    });

    const { output } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    // No ANSI codes
    expect(output).not.toMatch(/\x1b\[/);
    // But the textual stale marker is present
    expect(output).toContain(STALE_MARKER);
  });
});

// ============================================================================
// Scenario 17: No fetch ever called
// ============================================================================

describe('Scenario 17: global.fetch is never called', () => {
  it('does not call fetch in any scenario', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response());
    const NOW = Date.now();

    const scenarios: Array<Cache | null> = [
      null,
      makeCacheWithUsage({}, { lastUsageRefreshAt: NOW - 5 * 60 * 1000 }),
      makeCacheWithUsage({}, { lastUsageRefreshAt: NOW - 20 * 60 * 1000 }),
      makeCache({ authState: 'fatal', lastUsageRefreshAt: NOW - 5 * 60 * 1000 }),
    ];

    for (const cache of scenarios) {
      await runWithCache(cache, loadFixture('stdin-enterprise.json'), { now: () => NOW });
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

// ============================================================================
// Scenario 22: Enterprise credits and session cost stay source-separated
// ============================================================================

function makeStdinWithCost(totalCostUsd: number): string {
  return JSON.stringify({
    session_id: 'cost-test',
    transcript_path: '/t',
    cwd: '/c',
    model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet 4.6' },
    workspace: { current_dir: '/c', project_dir: '/c' },
    version: '1',
    output_style: { name: 'default' },
    cost: {
      total_cost_usd: totalCostUsd,
      total_duration_ms: 0,
      total_api_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
    },
    exceeds_200k_tokens: false,
    context_window: { used_percentage: null },
  });
}

describe('Scenario 22: Enterprise credits and session cost stay source-separated', () => {
  it('renders cached credits and live session estimate as separate segments', async () => {
    vi.stubEnv('NO_COLOR', '1');
    const NOW = Date.now();
    const cache = makeCacheWithUsage(
      {
        extra_usage: {
          is_enabled: true,
          utilization: 0,
          used_credits: 919, // $9.19 cached monthly credits
          monthly_limit: 100000, // $1000.00
        },
      },
      { lastUsageRefreshAt: NOW - 30 * 1000 },
    );

    const { output } = await runWithCache(
      cache,
      makeStdinWithCost(16), // $16.00 live session estimate
      { now: () => NOW },
    );

    expect(output).toContain('credits $9.19 / $1000.00 (1%)');
    expect(output).toContain('session $16.00');
    expect(output).not.toContain('$25.19 / $1000.00');
  });

  it('zero session cost renders cached amount unchanged', async () => {
    vi.stubEnv('NO_COLOR', '1');
    const NOW = Date.now();
    const cache = makeCacheWithUsage(
      {
        extra_usage: {
          is_enabled: true,
          utilization: 78,
          used_credits: 78000,
          monthly_limit: 100000,
        },
      },
      { lastUsageRefreshAt: NOW - 30 * 1000 },
    );

    const { output } = await runWithCache(
      cache,
      makeStdinWithCost(0),
      { now: () => NOW },
    );

    expect(output).toContain('$780.00 / $1000.00');
    expect(output).not.toContain('session $0.00');
  });

  it('utilisation percentage reflects cached credits only', async () => {
    vi.stubEnv('NO_COLOR', '1');
    const NOW = Date.now();
    const cache = makeCacheWithUsage(
      {
        extra_usage: {
          is_enabled: true,
          utilization: 10, // will be recalculated
          used_credits: 10000, // $100 cached, limit $1000 = 10%
          monthly_limit: 100000,
        },
      },
      { lastUsageRefreshAt: NOW - 30 * 1000 },
    );

    const { output } = await runWithCache(
      cache,
      makeStdinWithCost(50),
      { now: () => NOW },
    );

    expect(output).toContain('credits $100.00 / $1000.00 (10%)');
    expect(output).toContain('session $50.00');
    expect(output).not.toContain('(15%)');
  });

  it('renders session cost separately for enterprise', async () => {
    vi.stubEnv('NO_COLOR', '1');
    const NOW = Date.now();
    const cache = makeCacheWithUsage(
      {
        extra_usage: {
          is_enabled: true,
          utilization: 0,
          used_credits: 11,
          monthly_limit: 20000,
        },
      },
      { lastUsageRefreshAt: NOW - 30 * 1000 },
    );

    const { output } = await runWithCache(
      cache,
      makeStdinWithCost(0.08),
      { now: () => NOW },
    );

    expect(output).toContain('credits $0.11 / $200.00');
    expect(output).toMatch(/·\s+session \$0\.08/);
    expect(output).not.toContain('$0.19 / $200.00');
  });

  it('applies stale marker only to cached credits when session cost is present', async () => {
    vi.stubEnv('NO_COLOR', '1');
    const NOW = Date.now();
    const cache = makeCacheWithUsage(
      {
        extra_usage: {
          is_enabled: true,
          used_credits: 919,
          monthly_limit: 100000,
        },
      },
      { lastUsageRefreshAt: NOW - 61 * 1000 },
    );

    const { output } = await runWithCache(
      cache,
      makeStdinWithCost(16),
      { now: () => NOW },
    );

    expect(output).toContain('credits $9.19 / $1000.00 (1%) ~ · session $16.00');
    expect(output).not.toContain('session $16.00 ~');
  });
});
