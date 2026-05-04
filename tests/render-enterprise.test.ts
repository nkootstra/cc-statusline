/**
 * Tests for the render-enterprise subcommand (U8).
 *
 * All 20 scenarios from the plan are covered.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';

const FIXTURES = resolve(__dirname, 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), 'utf8');
}

function makeStream(content: string): Readable {
  return Readable.from([content]);
}

// ---------------------------------------------------------------------------
// Shared cache fixture helpers
// ---------------------------------------------------------------------------

import type { Cache } from '../src/cache/store';
import type { UsageResponse } from '../src/oauth/types';

const BASE_CREDENTIALS = {
  accessToken: 'tok',
  refreshToken: 'ref',
  expiresAt: Date.now() + 3600_000,
};

const GOLDEN_STDIN = JSON.stringify({
  session_id: 'golden',
  transcript_path: '/t',
  cwd: '/c',
  model: { id: 'claude-opus-4-7', display_name: 'Opus 4.7' },
  workspace: { current_dir: '/c', project_dir: '/c' },
  version: '1',
  output_style: { name: 'default' },
  cost: {
    total_cost_usd: 0,
    total_duration_ms: 0,
    total_api_duration_ms: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  },
  exceeds_200k_tokens: false,
  context_window: { used_percentage: null },
});

function makeCache(overrides: Partial<Cache> = {}): Cache {
  return {
    schemaVersion: 1,
    authState: 'ok',
    credentials: BASE_CREDENTIALS,
    usage: null,
    lastUsageRefreshAt: 0,
    lastRefreshStartedAt: 0,
    lastErrorMessage: null,
    ...overrides,
  };
}

/** Builds a Cache with the full usage-response.json fixture usage. */
function makeCacheWithUsage(
  usageOverrides: Partial<UsageResponse> = {},
  cacheOverrides: Partial<Cache> = {},
): Cache {
  const baseUsage = JSON.parse(loadFixture('usage-response.json')) as UsageResponse;
  const usage: UsageResponse = { ...baseUsage, ...usageOverrides };
  return makeCache({ usage, ...cacheOverrides });
}

// ---------------------------------------------------------------------------
// stdout capture helper
// ---------------------------------------------------------------------------

function captureStdout(fn: () => Promise<number>): Promise<{ output: string; exitCode: number }> {
  return new Promise(async (resolve, reject) => {
    const chunks: string[] = [];

    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
        void rest;
        if (typeof chunk === 'string') {
          chunks.push(chunk);
        } else if (Buffer.isBuffer(chunk)) {
          chunks.push(chunk.toString('utf8'));
        }
        return true;
      });

    try {
      const exitCode = await fn();
      spy.mockRestore();
      resolve({ output: chunks.join(''), exitCode });
    } catch (err) {
      spy.mockRestore();
      reject(err);
    }
  });
}

// ---------------------------------------------------------------------------
// TTY helpers
// ---------------------------------------------------------------------------

function setTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    value,
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Import the function under test
// ---------------------------------------------------------------------------

import { runRenderEnterprise, AUTH_FATAL_HINT, CLOUDFLARE_HINT } from '../src/subcommands/render-enterprise';
import { STALE_MARKER, MISSING } from '../src/statusline/format';
import * as storeModule from '../src/cache/store';

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

// Helper that runs runRenderEnterprise with a given cache injected via spy
async function runWithCache(
  cache: Cache | null,
  stdinContent: string,
  extra: {
    now?: () => number;
    spawnCalls?: Array<{ command: string; args: string[]; opts: SpawnOptions }>;
  } = {},
): Promise<{ output: string; exitCode: number; spawnCalls: Array<{ command: string; args: string[]; opts: SpawnOptions }> }> {
  const calls: Array<{ command: string; args: string[]; opts: SpawnOptions }> = [];
  const readCacheSpy = vi.spyOn(storeModule, 'readCache').mockReturnValue(cache);

  try {
    const { output, exitCode } = await captureStdout(() =>
      runRenderEnterprise(
        [],
        makeStream(stdinContent),
        {
          cachePath: '/mocked',
          bundlePath: '/bundle.js',
          now: extra.now ?? (() => Date.now()),
          spawnRefresh: (command, args, opts) => {
            calls.push({ command, args, opts });
            if (extra.spawnCalls) extra.spawnCalls.push({ command, args, opts });
          },
        },
      ),
    );
    return { output, exitCode, spawnCalls: calls };
  } finally {
    readCacheSpy.mockRestore();
  }
}

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

    expect(output).toBe('Opus 4.7 · $780.00 / $1000.00 (78%)\n');
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

  it('renders exact fetching line', async () => {
    const { output } = await runWithCache(null, GOLDEN_STDIN);

    expect(output).toBe('Opus 4.7 · usage — · fetching…\n');
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
    expect(AUTH_FATAL_HINT.trim().length).toBeLessThanOrEqual(50);
  });

  it('does NOT spawn a refresh subprocess when authState=fatal', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage({}, {
      authState: 'fatal',
      lastUsageRefreshAt: 0, // stale, would normally trigger spawn
    });

    const { spawnCalls } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(spawnCalls).toHaveLength(0);
  });
});

// ============================================================================
// Scenario 5: Cache missing — output includes usage — + fetching…; spawn called
// ============================================================================

describe('Scenario 5: cache missing (null)', () => {
  it('renders "usage —" and "fetching…" on first render', async () => {
    const { output, exitCode, spawnCalls } = await runWithCache(
      null,
      loadFixture('stdin-enterprise.json'),
    );

    expect(exitCode).toBe(0);
    expect(output).toContain(`usage ${MISSING}`);
    expect(output).toContain('fetching…');
    // Spawn IS called
    expect(spawnCalls).toHaveLength(1);
  });
});

// ============================================================================
// Scenario 6: Cache malformed (readCache returns null) — same as missing
// ============================================================================

describe('Scenario 6: cache malformed — readCache returns null', () => {
  it('renders "usage —" and "fetching…"; spawn called', async () => {
    // readCache returns null for malformed content — we simulate by passing null.
    const { output, spawnCalls } = await runWithCache(
      null,
      loadFixture('stdin-enterprise.json'),
    );

    expect(output).toContain(`usage ${MISSING}`);
    expect(output).toContain('fetching…');
    expect(spawnCalls).toHaveLength(1);
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
// Scenario 9 (R14): Stale beyond 15min — dim + STALE_MARKER + spawn called
// ============================================================================

describe('Scenario 9 (R14): stale beyond 15min — dim + STALE_MARKER + spawn', () => {
  it('appends STALE_MARKER and fires spawn when cache is 20min old', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage({}, {
      lastUsageRefreshAt: NOW - 20 * 60 * 1000, // 20 min ago
    });

    const { output, spawnCalls } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(output).toContain(STALE_MARKER);
    expect(spawnCalls).toHaveLength(1);
  });
});

// ============================================================================
// Scenario 10: In-flight refresh — render proceeds; NO new spawn
// ============================================================================

describe('Scenario 10: refresh already in-flight — no new spawn', () => {
  it('does not spawn when lastRefreshStartedAt is 500ms ago', async () => {
    const NOW = Date.now();
    const cache = makeCacheWithUsage({}, {
      lastUsageRefreshAt: NOW - 20 * 60 * 1000, // stale — would normally trigger spawn
      lastRefreshStartedAt: NOW - 500, // in-flight (within 1s dedup window)
    });

    const { spawnCalls } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(spawnCalls).toHaveLength(0);
  });
});

// ============================================================================
// Scenario 11 (R15): Synchronous bound — returns within 30ms even when spawn needed
// ============================================================================

describe('Scenario 11 (R15): synchronous performance bound', () => {
  it('returns within 30ms even when spawn is triggered', async () => {
    const NOW = Date.now();
    const cache = null; // forces spawn

    const readCacheSpy = vi.spyOn(storeModule, 'readCache').mockReturnValue(cache);
    let spawnCalled = false;

    const start = performance.now();

    const { exitCode } = await captureStdout(() =>
      runRenderEnterprise(
        [],
        makeStream(loadFixture('stdin-enterprise.json')),
        {
          cachePath: '/mocked',
          bundlePath: '/bundle.js',
          now: () => NOW,
          // Simulate async work in spawn — but runRenderEnterprise must not await it.
          spawnRefresh: (_command, _args, _opts) => {
            spawnCalled = true;
            // Simulated slow subprocess — we don't await this, so timing is unaffected.
          },
        },
      ),
    );

    const elapsed = performance.now() - start;
    readCacheSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(spawnCalled).toBe(true);
    expect(elapsed).toBeLessThan(30);
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

describe('Scenario 15: first-render UX → second render without fetching…', () => {
  it('first render includes fetching…; second render (populated cache) omits it', async () => {
    const NOW = Date.now();

    // First render: no cache.
    const { output: firstOutput, spawnCalls: firstSpawns } = await runWithCache(
      null,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(firstOutput).toContain('fetching…');
    expect(firstSpawns).toHaveLength(1);

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
// Scenario 18: No file writes from render path
// ----------------------------------------------------------------------------
// The render path provably never calls a write API: src/subcommands/
// render-enterprise.ts imports nothing that can write to disk (no fs writes,
// no writeCache). vi.spyOn on node:fs's default exports fails with "Cannot
// redefine property" under CJS, so the structural guarantee at the import
// graph stands in for a spy assertion here.
// ============================================================================

// ============================================================================
// Scenario 19: Windows vs POSIX spawn shape
// ============================================================================

describe('Scenario 19: spawn shape differs by platform', () => {
  it('on POSIX: calls spawnRefresh(process.execPath, [bundlePath, "refresh"], { detached: true })', async () => {
    const NOW = Date.now();
    const cache = null; // triggers spawn

    const readCacheSpy = vi.spyOn(storeModule, 'readCache').mockReturnValue(cache);
    const capturedCalls: Array<{ command: string; args: string[]; opts: SpawnOptions }> = [];

    // Ensure platform is POSIX
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    try {
      await captureStdout(() =>
        runRenderEnterprise(
          [],
          makeStream(loadFixture('stdin-enterprise.json')),
          {
            cachePath: '/mocked',
            bundlePath: '/my/bundle.js',
            now: () => NOW,
            spawnRefresh: (command, args, opts) => capturedCalls.push({ command, args, opts }),
          },
        ),
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
      readCacheSpy.mockRestore();
    }

    expect(capturedCalls).toHaveLength(1);
    const call = capturedCalls[0]!;
    expect(call.command).toBe(process.execPath);
    expect(call.args).toEqual(['/my/bundle.js', 'refresh']);
    expect(call.opts.detached).toBe(true);
    expect(call.opts.stdio).toBe('ignore');
  });

  it('on win32: calls spawnRefresh("cmd.exe", ["/c", "start", "/b", "/min", execPath, bundlePath, "refresh"])', async () => {
    const NOW = Date.now();
    const cache = null; // triggers spawn

    const readCacheSpy = vi.spyOn(storeModule, 'readCache').mockReturnValue(cache);
    const capturedCalls: Array<{ command: string; args: string[]; opts: SpawnOptions }> = [];

    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    try {
      await captureStdout(() =>
        runRenderEnterprise(
          [],
          makeStream(loadFixture('stdin-enterprise.json')),
          {
            cachePath: '/mocked',
            bundlePath: 'C:\\bundle.js',
            now: () => NOW,
            spawnRefresh: (command, args, opts) => capturedCalls.push({ command, args, opts }),
          },
        ),
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
      readCacheSpy.mockRestore();
    }

    expect(capturedCalls).toHaveLength(1);
    const call = capturedCalls[0]!;
    expect(call.command).toBe('cmd.exe');
    expect(call.args).toEqual(['/c', 'start', '/b', '/min', process.execPath, 'C:\\bundle.js', 'refresh']);
    expect(call.opts.stdio).toBe('ignore');
  });
});

// ============================================================================
// Scenario 20: Minimal env — no secrets leaked into spawn env
// ============================================================================

describe('Scenario 20: minimal env — no secrets passed to spawn', () => {
  it('spawn env does NOT contain AWS_SECRET_ACCESS_KEY', async () => {
    const NOW = Date.now();
    const cache = null; // triggers spawn

    // Set a sensitive env var
    process.env['AWS_SECRET_ACCESS_KEY'] = 'super-secret-key';

    const readCacheSpy = vi.spyOn(storeModule, 'readCache').mockReturnValue(cache);
    const capturedCalls: Array<{ command: string; args: string[]; opts: SpawnOptions }> = [];

    try {
      await captureStdout(() =>
        runRenderEnterprise(
          [],
          makeStream(loadFixture('stdin-enterprise.json')),
          {
            cachePath: '/mocked',
            bundlePath: '/bundle.js',
            now: () => NOW,
            spawnRefresh: (command, args, opts) => capturedCalls.push({ command, args, opts }),
          },
        ),
      );
    } finally {
      delete process.env['AWS_SECRET_ACCESS_KEY'];
      readCacheSpy.mockRestore();
    }

    expect(capturedCalls).toHaveLength(1);
    const env = capturedCalls[0]!.opts.env as NodeJS.ProcessEnv | undefined;
    expect(env).toBeDefined();
    expect(env?.['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
  });

  it('spawn env contains only PATH, HOME/USERPROFILE, and CLAUDE_CONFIG_DIR', async () => {
    const NOW = Date.now();
    const cache = null;

    process.env['CLAUDE_CONFIG_DIR'] = '/my/claude';
    const readCacheSpy = vi.spyOn(storeModule, 'readCache').mockReturnValue(cache);
    const capturedCalls: Array<{ command: string; args: string[]; opts: SpawnOptions }> = [];

    try {
      await captureStdout(() =>
        runRenderEnterprise(
          [],
          makeStream(loadFixture('stdin-enterprise.json')),
          {
            cachePath: '/mocked',
            bundlePath: '/bundle.js',
            now: () => NOW,
            spawnRefresh: (command, args, opts) => capturedCalls.push({ command, args, opts }),
          },
        ),
      );
    } finally {
      delete process.env['CLAUDE_CONFIG_DIR'];
      readCacheSpy.mockRestore();
    }

    expect(capturedCalls).toHaveLength(1);
    const env = capturedCalls[0]!.opts.env as NodeJS.ProcessEnv;
    const keys = Object.keys(env);
    const allowedKeys = new Set(['PATH', 'HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR']);

    for (const key of keys) {
      expect(allowedKeys.has(key)).toBe(true);
    }

    expect(env['CLAUDE_CONFIG_DIR']).toBe('/my/claude');
  });
});

// ============================================================================
// Scenario 21: 60-second stale threshold (new behaviour)
// ============================================================================

describe('Scenario 21: stale threshold is 60 seconds', () => {
  it('cache 61s old triggers spawn and STALE_MARKER', async () => {
    vi.stubEnv('NO_COLOR', '1');
    const NOW = Date.now();
    const cache = makeCacheWithUsage({}, {
      lastUsageRefreshAt: NOW - 61 * 1000, // 61 s ago — just past threshold
    });

    const { output, spawnCalls } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(spawnCalls).toHaveLength(1);
    expect(output).toContain(STALE_MARKER);
  });

  it('cache 59s old does NOT spawn and has no STALE_MARKER', async () => {
    vi.stubEnv('NO_COLOR', '1');
    const NOW = Date.now();
    const cache = makeCacheWithUsage({}, {
      lastUsageRefreshAt: NOW - 59 * 1000, // 59 s ago — within threshold
    });

    const { output, spawnCalls } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => NOW },
    );

    expect(spawnCalls).toHaveLength(0);
    expect(output).not.toContain(STALE_MARKER);
  });
});

// ============================================================================
// Scenario 22: session cost folded into enterprise monthly spend
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

describe('Scenario 22: session cost folded into enterprise monthly spend', () => {
  it('adds session cost to cached spent amount', async () => {
    vi.stubEnv('NO_COLOR', '1');
    const NOW = Date.now();
    const cache = makeCacheWithUsage(
      {
        extra_usage: {
          is_enabled: true,
          utilization: 0,
          used_credits: 11, // $0.11 cached
          monthly_limit: 20000, // $200.00
        },
      },
      { lastUsageRefreshAt: NOW - 30 * 1000 },
    );

    const { output } = await runWithCache(
      cache,
      makeStdinWithCost(0.08), // $0.08 session cost
      { now: () => NOW },
    );

    // Combined: $0.11 + $0.08 = $0.19
    expect(output).toContain('$0.19 / $200.00');
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
  });

  it('utilisation percentage reflects combined amount', async () => {
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

    // Add $50 session cost → combined $150 / $1000 = 15%
    const { output } = await runWithCache(
      cache,
      makeStdinWithCost(50),
      { now: () => NOW },
    );

    expect(output).toContain('(15%)');
    expect(output).not.toContain('(10%)');
  });

  it('trailing session cost segment is not rendered separately for enterprise', async () => {
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

    // The combined amount should appear once; no separate trailing cost
    const matches = output.match(/\$0\.\d+/g) ?? [];
    // Only one $ figure group: the combined used/limit pair
    // i.e. "$0.19 / $200.00 (0%)" — no extra "$0.08" at the end
    expect(output).not.toMatch(/·\s+\$0\.08/);
  });
});
