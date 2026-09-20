import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readCache, writeCache, type Cache } from '../src/cache/store';
import type { OAuthCredentials } from '../src/credentials/envelope';
import type { UsageResponse } from '../src/oauth/types';
import { runRefresh, type RefreshDeps } from '../src/subcommands/refresh';
import { runInit, type InitDeps } from '../src/subcommands/init';
import { captureStdout } from './support/render-enterprise';

const NOW = Date.parse('2026-07-28T12:00:00Z');

const USAGE: UsageResponse = {
  five_hour: { utilization: 12, resets_at: '2026-07-28T17:00:00Z' },
  seven_day: { utilization: 34, resets_at: '2026-08-04T00:00:00Z' },
};

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-statusline-reinit-'));
  tmpDirs.push(dir);
  return dir;
}

function makeCache(overrides: Partial<Cache> = {}): Cache {
  return {
    schemaVersion: 4,
    authState: 'ok',
    credentials: { accessToken: 'cached-access', expiresAt: NOW + 3_600_000 },
    credentialSource: { kind: 'claude-code' },
    usage: USAGE,
    lastUsageRefreshAt: NOW - 120_000,
    lastRefreshStartedAt: 0,
    lastErrorMessage: null,
    rateLimitedUntilMs: 0,
    nextRefreshAllowedAt: 0,
    consecutiveRateLimitCount: 0,
    ...overrides,
  };
}

function response(status: number, body: unknown = '', headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

function sourceLoader(credentials: OAuthCredentials): NonNullable<RefreshDeps['loadCredentialSourceImpl']> {
  return vi.fn().mockResolvedValue(credentials);
}

function initDeps(dir: string, overrides: Partial<InitDeps> = {}): InitDeps {
  const bundle = path.join(dir, 'bundle.js');
  fs.writeFileSync(bundle, '#!/usr/bin/env node\n');
  return {
    homedirOverride: dir,
    platformOverride: 'linux',
    bundlePathOverride: bundle,
    versionString: '1.2.3',
    settingsPath: path.join(dir, 'settings.json'),
    cachePath: path.join(dir, 'cache.json'),
    isInteractive: false,
    now: () => NOW,
    fetchImpl: vi.fn().mockResolvedValue(response(200, USAGE)) as unknown as typeof fetch,
    discoverImpl: vi.fn().mockResolvedValue({
      accessToken: 'cached-access',
      refreshToken: 'rt',
      expiresAt: NOW + 3_600_000,
    }),
    spawnClaude: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('refresh: expired token that Claude Code has not renewed yet', () => {
  it('waits for renewal instead of marking auth fatal', async () => {
    const cachePath = path.join(makeTmpDir(), 'cache.json');
    await writeCache(makeCache({
      credentials: { accessToken: 'cached-access', expiresAt: NOW - 1 },
    }), cachePath);
    const fetchImpl = vi.fn().mockResolvedValue(response(401));

    await runRefresh([], {
      cachePath,
      fetchImpl,
      now: () => NOW,
      loadCredentialSourceImpl: sourceLoader({
        accessToken: 'cached-access',
        refreshToken: 'rt',
        expiresAt: NOW - 1,
      }),
    });

    const result = readCache(cachePath);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result?.authState).toBe('ok');
    expect(result?.usage).toEqual(USAGE);
    expect(result?.nextRefreshAllowedAt).toBe(NOW + 60_000);
    expect(result?.lastErrorMessage).toMatch(/expired/i);
  });

  it('keeps the existing fatal verdict for an unexpired token the API rejects', async () => {
    const cachePath = path.join(makeTmpDir(), 'cache.json');
    await writeCache(makeCache(), cachePath);

    await runRefresh([], {
      cachePath,
      fetchImpl: vi.fn().mockResolvedValue(response(401)),
      now: () => NOW,
      loadCredentialSourceImpl: sourceLoader({
        accessToken: 'cached-access',
        refreshToken: 'rt',
        expiresAt: NOW + 3_600_000,
      }),
    });

    expect(readCache(cachePath)?.authState).toBe('fatal');
  });
});

describe('refresh: Retry-After is bounded', () => {
  it('caps a day-long Retry-After at the fifteen minute backoff ceiling', async () => {
    const cachePath = path.join(makeTmpDir(), 'cache.json');
    await writeCache(makeCache(), cachePath);

    await runRefresh([], {
      cachePath,
      fetchImpl: vi.fn().mockResolvedValue(response(429, '', { 'Retry-After': '86400' })),
      now: () => NOW,
    });

    const result = readCache(cachePath);
    expect(result?.rateLimitedUntilMs).toBe(NOW + 15 * 60_000);
    expect(result?.nextRefreshAllowedAt).toBe(NOW + 15 * 60_000);
  });
});

describe('init: cache reuse requires a healthy refresh loop', () => {
  it('revalidates when the last background refresh recorded an error', async () => {
    const dir = makeTmpDir();
    const deps = initDeps(dir);
    await writeCache(makeCache({
      lastErrorMessage: 'unable to verify the first certificate',
      nextRefreshAllowedAt: NOW + 30_000,
    }), deps.cachePath!);

    const { output } = await captureStdout(() => runInit(['--plan=enterprise'], deps));

    expect(deps.fetchImpl).toHaveBeenCalledOnce();
    expect(output).not.toContain('already installed');
    expect(readCache(deps.cachePath!)?.lastErrorMessage).toBeNull();
  });

  it('revalidates when a rate-limit cooldown is still blocking refreshes', async () => {
    const dir = makeTmpDir();
    const deps = initDeps(dir);
    await writeCache(makeCache({ rateLimitedUntilMs: NOW + 86_400_000 }), deps.cachePath!);

    const { output } = await captureStdout(() => runInit(['--plan=enterprise'], deps));

    expect(deps.fetchImpl).toHaveBeenCalledOnce();
    expect(output).not.toContain('already installed');
    expect(readCache(deps.cachePath!)?.rateLimitedUntilMs).toBe(0);
  });

  it('still reuses a healthy cache without touching the network', async () => {
    const dir = makeTmpDir();
    const deps = initDeps(dir);
    await writeCache(makeCache(), deps.cachePath!);

    const { output } = await captureStdout(() => runInit(['--plan=enterprise'], deps));

    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(output).toContain('already installed');
  });
});
