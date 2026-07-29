import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RATE_LIMITED_HINT_PREFIX,
  runRenderEnterprise,
} from '../src/subcommands/render-enterprise';
import { STALE_MARKER } from '../src/statusline/format';
import { writeCache } from '../src/cache/store';
import {
  captureStdout,
  loadFixture,
  makeCacheWithUsage,
  makeStream,
  runWithCache,
  setTTY,
  type SpawnCall,
} from './support/render-enterprise';

beforeEach(() => {
  vi.stubEnv('NO_COLOR', '');
  setTTY(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('background refresh integration', () => {
  it('renders stale usage and spawns one refresh', async () => {
    const now = Date.now();
    const cache = makeCacheWithUsage({}, {
      lastUsageRefreshAt: now - 20 * 60_000,
    });

    const { output, spawnCalls } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => now },
    );

    expect(output).toContain(STALE_MARKER);
    expect(spawnCalls).toHaveLength(1);
  });

  it('does not spawn while another refresh is in flight', async () => {
    const now = Date.now();
    const cache = makeCacheWithUsage({}, {
      lastUsageRefreshAt: now - 20 * 60_000,
      lastRefreshStartedAt: now - 30_000,
    });

    const { spawnCalls } = await runWithCache(
      cache,
      loadFixture('stdin-enterprise.json'),
      { now: () => now },
    );

    expect(spawnCalls).toHaveLength(0);
  });

  it('keeps the refresh launch path under 100ms', async () => {
    const now = Date.now();
    const cache = makeCacheWithUsage({}, {
      lastUsageRefreshAt: now - 5 * 60_000,
    });
    const tempDir = mkdtempSync(join(tmpdir(), 'cc-statusline-render-perf-'));
    const cachePath = join(tempDir, 'cache.json');
    await writeCache(cache, cachePath);
    let spawned = false;
    const startedAt = performance.now();

    try {
      const { exitCode } = await captureStdout(() =>
        runRenderEnterprise(
          [],
          makeStream(loadFixture('stdin-enterprise.json')),
          {
            cachePath,
            bundlePath: '/bundle.js',
            now: () => now,
            spawnRefresh: () => {
              spawned = true;
            },
          },
        ),
      );

      expect(exitCode).toBe(0);
      expect(spawned).toBe(true);
      expect(performance.now() - startedAt).toBeLessThan(100);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('claims a stale cache before spawning so concurrent renderers spawn once', async () => {
    const now = Date.now();
    const cache = makeCacheWithUsage({}, {
      lastUsageRefreshAt: now - 5 * 60_000,
    });
    const tempDir = mkdtempSync(join(tmpdir(), 'cc-statusline-render-claim-'));
    const cachePath = join(tempDir, 'cache.json');
    await writeCache(cache, cachePath);
    const spawned: SpawnCall[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      const deps = {
        cachePath,
        bundlePath: '/bundle.js',
        now: () => now,
        spawnRefresh: (
          command: string,
          args: string[],
          opts: SpawnCall['opts'],
        ) => {
          spawned.push({ command, args, opts });
        },
      };

      await Promise.all([
        runRenderEnterprise(
          [],
          makeStream(loadFixture('stdin-enterprise.json')),
          deps,
        ),
        runRenderEnterprise(
          [],
          makeStream(loadFixture('stdin-enterprise.json')),
          deps,
        ),
      ]);

      expect(spawned).toHaveLength(1);
    } finally {
      stdout.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('releases the claim when spawning throws', async () => {
    const now = Date.now();
    const cache = makeCacheWithUsage({}, {
      lastUsageRefreshAt: now - 5 * 60_000,
    });
    const tempDir = mkdtempSync(join(tmpdir(), 'cc-statusline-render-spawn-'));
    const cachePath = join(tempDir, 'cache.json');
    await writeCache(cache, cachePath);
    let attempts = 0;
    const deps = {
      cachePath,
      bundlePath: '/bundle.js',
      now: () => now,
      spawnRefresh: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('spawn failed');
      },
    };

    try {
      await captureStdout(() =>
        runRenderEnterprise(
          [],
          makeStream(loadFixture('stdin-enterprise.json')),
          deps,
        ),
      );
      await captureStdout(() =>
        runRenderEnterprise(
          [],
          makeStream(loadFixture('stdin-enterprise.json')),
          deps,
        ),
      );

      expect(attempts).toBe(2);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('refresh process boundary', () => {
  async function captureRefreshSpawn(bundlePath: string): Promise<SpawnCall> {
    const now = Date.now();
    const { spawnCalls } = await runWithCache(
      makeCacheWithUsage({}, {
        lastUsageRefreshAt: now - 5 * 60_000,
      }),
      loadFixture('stdin-enterprise.json'),
      { now: () => now, bundlePath },
    );
    const call = spawnCalls[0];
    expect(call).toBeDefined();
    return call!;
  }

  it('uses detached Node directly', async () => {
    const call = await captureRefreshSpawn('/bundle.js');

    expect(call.command).toBe(process.execPath);
    expect(call.args).toEqual([
      '/bundle.js',
      'refresh',
      expect.stringMatching(/^--claimed-at=\d+$/),
    ]);
    expect(call.opts).toMatchObject({
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
  });

  it('uses detached Node without a shell for Windows paths containing metacharacters', async () => {
    const bundlePath = 'C:\\Users\\A&B\\cc statusline.js';
    const call = await captureRefreshSpawn(bundlePath);

    expect(call.command).toBe(process.execPath);
    expect(call.args).toEqual([
      bundlePath,
      'refresh',
      expect.stringMatching(/^--claimed-at=\d+$/),
    ]);
    expect(call.opts).toMatchObject({
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
  });

  it('passes only the required environment variables', async () => {
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'super-secret-key');
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/my/claude');
    const now = Date.now();

    const { spawnCalls } = await runWithCache(
      makeCacheWithUsage({}, {
        lastUsageRefreshAt: now - 5 * 60_000,
      }),
      loadFixture('stdin-enterprise.json'),
      { now: () => now },
    );

    const env = spawnCalls[0]?.opts.env;
    expect(env).toBeDefined();
    expect(env?.['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(env?.['CLAUDE_CONFIG_DIR']).toBe('/my/claude');
    expect(Object.keys(env ?? {}).every((key) =>
      ['PATH', 'HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR'].includes(key),
    )).toBe(true);
  });
});

describe('stale threshold configuration', () => {
  it.each([
    ['61 seconds old', undefined, 61_000, 1, true],
    ['59 seconds old', undefined, 59_000, 0, false],
    ['custom 30ms threshold', '30', 31_000, 1, true],
    ['minimum threshold clamp', '1000', 11_000, 1, true],
  ] as const)(
    '%s',
    async (_label, configuredThreshold, ageMs, spawnCount, stale) => {
      if (configuredThreshold !== undefined) {
        vi.stubEnv(
          'CC_STATUSLINE_ENTERPRISE_STALE_MS',
          configuredThreshold,
        );
      }
      vi.stubEnv('NO_COLOR', '1');
      const now = Date.now();

      const { output, spawnCalls } = await runWithCache(
        makeCacheWithUsage({}, {
          lastUsageRefreshAt: now - ageMs,
        }),
        loadFixture('stdin-enterprise.json'),
        { now: () => now },
      );

      expect(spawnCalls).toHaveLength(spawnCount);
      expect(output.includes(STALE_MARKER)).toBe(stale);
    },
  );
});

describe('rate-limit rendering', () => {
  it('does not spawn during cooldown and renders the remaining minutes', async () => {
    vi.stubEnv('NO_COLOR', '1');
    const now = Date.now();
    const { output, spawnCalls } = await runWithCache(
      makeCacheWithUsage({}, {
        lastUsageRefreshAt: now - 5 * 60_000,
        rateLimitedUntilMs: now + 4 * 60_000,
      }),
      loadFixture('stdin-enterprise.json'),
      { now: () => now },
    );

    expect(spawnCalls).toHaveLength(0);
    expect(output).toContain(RATE_LIMITED_HINT_PREFIX.trim());
    expect(output).toContain('retry in 4m');
  });

  it('renders cooldowns under one minute in seconds', async () => {
    vi.stubEnv('NO_COLOR', '1');
    const now = Date.now();
    const { output } = await runWithCache(
      makeCacheWithUsage({}, {
        lastUsageRefreshAt: now - 30_000,
        rateLimitedUntilMs: now + 30_000,
      }),
      loadFixture('stdin-enterprise.json'),
      { now: () => now },
    );

    expect(output).toContain('retry in 30s');
  });

  it('omits an elapsed cooldown', async () => {
    vi.stubEnv('NO_COLOR', '1');
    const now = Date.now();
    const { output, spawnCalls } = await runWithCache(
      makeCacheWithUsage({}, {
        lastUsageRefreshAt: now - 30_000,
        rateLimitedUntilMs: now - 1,
      }),
      loadFixture('stdin-enterprise.json'),
      { now: () => now },
    );

    expect(output).not.toContain(RATE_LIMITED_HINT_PREFIX.trim());
    expect(spawnCalls).toHaveLength(0);
  });

  it('uses adaptive backoff after the upstream cooldown expires', async () => {
    vi.stubEnv('NO_COLOR', '1');
    const now = Date.now();
    const { output, spawnCalls } = await runWithCache(
      makeCacheWithUsage({}, {
        lastUsageRefreshAt: now - 30_000,
        rateLimitedUntilMs: now - 1_000,
        nextRefreshAllowedAt: now + 2 * 60_000,
        consecutiveRateLimitCount: 1,
      }),
      loadFixture('stdin-enterprise.json'),
      { now: () => now },
    );

    expect(output).toContain('retry in 2m');
    expect(spawnCalls).toHaveLength(0);
  });

  it('keeps usage figures alongside the cooldown hint', async () => {
    vi.stubEnv('NO_COLOR', '1');
    const now = Date.now();
    const { output } = await runWithCache(
      makeCacheWithUsage({}, {
        lastUsageRefreshAt: now - 30_000,
        rateLimitedUntilMs: now + 2 * 60_000,
      }),
      loadFixture('stdin-enterprise.json'),
      { now: () => now },
    );

    expect(output).toContain('$780.00 / $1000.00 (78%)');
    expect(output).toContain('retry in 2m');
  });
});
