import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readCache,
  writeCache,
  type Cache,
} from '../src/cache/store';
import type { OAuthCredentials } from '../src/credentials/envelope';
import type { UsageResponse } from '../src/oauth/types';
import type { CredentialSource } from '../src/credentials/source';
import {
  runRefresh,
  type RefreshDeps,
} from '../src/subcommands/refresh';

const USAGE: UsageResponse = {
  five_hour: { utilization: 12, resets_at: '2026-07-28T12:00:00Z' },
  seven_day: { utilization: 34, resets_at: '2026-08-01T00:00:00Z' },
};

const CONCURRENT_USAGE: UsageResponse = {
  five_hour: { utilization: 91, resets_at: '2026-07-28T13:00:00Z' },
  seven_day: { utilization: 82, resets_at: '2026-08-02T00:00:00Z' },
};

type SourceLoader = (
  source: CredentialSource,
) => Promise<OAuthCredentials>;

function makeCache(now: number, overrides: Partial<Cache> = {}): Cache {
  return {
    schemaVersion: 4,
    authState: 'ok',
    credentials: {
      accessToken: 'cached-access',
      expiresAt: now + 60 * 60_000,
    },
    credentialSource: { kind: 'claude-code' },
    usage: null,
    lastUsageRefreshAt: 0,
    lastRefreshStartedAt: 0,
    lastErrorMessage: null,
    rateLimitedUntilMs: 0,
    nextRefreshAllowedAt: 0,
    consecutiveRateLimitCount: 0,
    ...overrides,
  };
}

function response(
  status: number,
  body: unknown = '',
  headers: Record<string, string> = {},
): Response {
  return new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers },
  );
}

function withSourceLoader(
  deps: RefreshDeps,
  loadCredentialSourceImpl: SourceLoader,
): RefreshDeps {
  return {
    ...deps,
    loadCredentialSourceImpl,
  } as RefreshDeps;
}

function spyOnStdout() {
  return vi.spyOn(process.stdout, 'write').mockReturnValue(true);
}

function spyOnStderr() {
  return vi.spyOn(process.stderr, 'write').mockReturnValue(true);
}

describe('runRefresh', () => {
  let tmpDir: string;
  let cachePath: string;
  let now: number;
  let stdout: ReturnType<typeof spyOnStdout>;
  let stderr: ReturnType<typeof spyOnStderr>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-statusline-refresh-'));
    cachePath = path.join(tmpDir, 'cache.json');
    now = 1_800_000_000_000;
    stdout = spyOnStdout();
    stderr = spyOnStderr();
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fetches usage once for a fresh usable cache without loading its source', async () => {
    await writeCache(makeCache(now), cachePath);
    const fetchImpl = vi.fn().mockResolvedValue(response(200, USAGE));
    const loadSource = vi.fn<SourceLoader>();

    expect(await runRefresh([], withSourceLoader({
      cachePath,
      fetchImpl,
      now: () => now,
    }, loadSource))).toBe(0);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(loadSource).not.toHaveBeenCalled();
    expect(readCache(cachePath)?.usage).toEqual(USAGE);
  });

  it('honors a refresh claim inherited from the renderer', async () => {
    await writeCache(makeCache(now, {
      lastRefreshStartedAt: now,
    }), cachePath);
    const fetchImpl = vi.fn().mockResolvedValue(response(200, USAGE));

    expect(await runRefresh([`--claimed-at=${now}`], {
      cachePath,
      fetchImpl,
      now: () => now,
    })).toBe(0);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(readCache(cachePath)?.usage).toEqual(USAGE);
  });

  it('does not refresh after an inherited claim has been replaced', async () => {
    await writeCache(makeCache(now, {
      lastRefreshStartedAt: now,
    }), cachePath);
    const fetchImpl = vi.fn();

    expect(await runRefresh([`--claimed-at=${now - 1}`], {
      cachePath,
      fetchImpl,
      now: () => now,
    })).toBe(0);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readCache(cachePath)?.lastRefreshStartedAt).toBe(now);
  });

  it('loads the recorded source near expiry and never calls or sends data to a token endpoint', async () => {
    const cached = makeCache(now, {
      credentials: {
        accessToken: 'old-access',
        expiresAt: now + 2 * 60_000,
      },
    });
    await writeCache(cached, cachePath);
    const loadSource = vi.fn<SourceLoader>().mockResolvedValue({
      accessToken: 'new-access',
      refreshToken: 'source-refresh-secret',
      expiresAt: now + 60 * 60_000,
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return response(200, USAGE);
    };

    await runRefresh([], withSourceLoader({
      cachePath,
      fetchImpl,
      now: () => now,
    }, loadSource));

    expect(loadSource).toHaveBeenCalledWith(cached.credentialSource);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('/usage');
    expect(requests[0]?.url).not.toContain('/token');
    expect(JSON.stringify(requests[0]?.init)).not.toContain('source-refresh-secret');
    expect(readCache(cachePath)?.credentials).toEqual({
      accessToken: 'new-access',
      expiresAt: now + 60 * 60_000,
    });
  });

  it('adopts a near-expiry candidate only after its usage request succeeds', async () => {
    const cached = makeCache(now, {
      credentials: { accessToken: 'old-access', expiresAt: now + 60_000 },
      usage: USAGE,
    });
    await writeCache(cached, cachePath);
    const candidate: OAuthCredentials = {
      accessToken: 'candidate-access',
      refreshToken: 'candidate-refresh',
      expiresAt: now + 60 * 60_000,
    };

    await runRefresh([], withSourceLoader({
      cachePath,
      now: () => now,
      fetchImpl: vi.fn().mockResolvedValue(
        response(500, 'candidate-access candidate-refresh'),
      ),
    }, vi.fn<SourceLoader>().mockResolvedValue(candidate)));

    const result = readCache(cachePath);
    expect(result?.credentials).toEqual(cached.credentials);
    expect(result?.usage).toEqual(USAGE);
    expect(result?.lastErrorMessage).not.toContain('candidate-access');
    expect(result?.lastErrorMessage).not.toContain('candidate-refresh');
  });

  it('promotes an advanced expiry for an unchanged token after usage succeeds', async () => {
    await writeCache(makeCache(now, {
      credentials: { accessToken: 'same-access', expiresAt: now + 60_000 },
    }), cachePath);
    const advancedExpiry = now + 90 * 60_000;

    await runRefresh([], withSourceLoader({
      cachePath,
      now: () => now,
      fetchImpl: vi.fn().mockResolvedValue(response(200, USAGE)),
    }, vi.fn<SourceLoader>().mockResolvedValue({
      accessToken: 'same-access',
      refreshToken: 'unused-refresh',
      expiresAt: advancedExpiry,
    })));

    expect(readCache(cachePath)?.credentials).toEqual({
      accessToken: 'same-access',
      expiresAt: advancedExpiry,
    });
  });

  it('tries unchanged source only once and marks a final 401 fatal', async () => {
    await writeCache(makeCache(now), cachePath);
    const fetchImpl = vi.fn().mockResolvedValue(response(401));
    const loadSource = vi.fn<SourceLoader>().mockResolvedValue({
      accessToken: 'cached-access',
      refreshToken: 'unchanged-refresh',
      expiresAt: now + 60 * 60_000,
    });

    await runRefresh([], withSourceLoader({
      cachePath,
      fetchImpl,
      now: () => now,
    }, loadSource));

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(loadSource).toHaveBeenCalledOnce();
    expect(readCache(cachePath)?.authState).toBe('fatal');
  });

  it('reloads after a usage 401 and retries once with a different source token', async () => {
    await writeCache(makeCache(now), cachePath);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200, USAGE));

    await runRefresh([], withSourceLoader({
      cachePath,
      fetchImpl,
      now: () => now,
    }, vi.fn<SourceLoader>().mockResolvedValue({
      accessToken: 'recovered-access',
      refreshToken: 'recovered-refresh',
      expiresAt: now + 2 * 60 * 60_000,
    })));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer cached-access',
    });
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer recovered-access',
    });
    expect(readCache(cachePath)).toMatchObject({
      authState: 'ok',
      credentials: {
        accessToken: 'recovered-access',
        expiresAt: now + 2 * 60 * 60_000,
      },
      usage: USAGE,
    });
  });

  it('does not retry more than once when the replacement token also gets 401', async () => {
    await writeCache(makeCache(now), cachePath);
    const fetchImpl = vi.fn().mockResolvedValue(response(401));

    await runRefresh([], withSourceLoader({
      cachePath,
      fetchImpl,
      now: () => now,
    }, vi.fn<SourceLoader>().mockResolvedValue({
      accessToken: 'replacement-access',
      refreshToken: 'replacement-refresh',
      expiresAt: now + 60 * 60_000,
    })));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const result = readCache(cachePath);
    expect(result?.authState).toBe('fatal');
    expect(result?.credentials.accessToken).toBe('cached-access');
    expect(result?.lastErrorMessage).not.toContain('replacement-access');
    expect(result?.lastErrorMessage).not.toContain('replacement-refresh');
  });

  it('self-heals a fatal cache when its source contains a new usable token', async () => {
    await writeCache(makeCache(now, {
      authState: 'fatal',
      lastErrorMessage: 'old 401',
    }), cachePath);
    const fetchImpl = vi.fn().mockResolvedValue(response(200, USAGE));

    await runRefresh([], withSourceLoader({
      cachePath,
      fetchImpl,
      now: () => now,
    }, vi.fn<SourceLoader>().mockResolvedValue({
      accessToken: 'healed-access',
      refreshToken: 'healed-refresh',
      expiresAt: now + 60 * 60_000,
    })));

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(readCache(cachePath)).toMatchObject({
      authState: 'ok',
      credentials: { accessToken: 'healed-access' },
      usage: USAGE,
      lastErrorMessage: null,
    });
  });

  it('loads the source for expired credentials', async () => {
    await writeCache(makeCache(now, {
      credentials: { accessToken: 'expired-access', expiresAt: now - 1 },
    }), cachePath);
    const loadSource = vi.fn<SourceLoader>().mockResolvedValue({
      accessToken: 'current-access',
      refreshToken: 'current-refresh',
      expiresAt: now + 60 * 60_000,
    });

    await runRefresh([], withSourceLoader({
      cachePath,
      now: () => now,
      fetchImpl: vi.fn().mockResolvedValue(response(200, USAGE)),
    }, loadSource));

    expect(loadSource).toHaveBeenCalledOnce();
    expect(readCache(cachePath)?.credentials.accessToken).toBe('current-access');
  });

  it('preserves cached credentials and usage when source loading fails', async () => {
    const cached = makeCache(now, {
      credentials: { accessToken: 'preserved-access', expiresAt: now + 60_000 },
      usage: USAGE,
      lastUsageRefreshAt: now - 30_000,
    });
    await writeCache(cached, cachePath);
    const fetchImpl = vi.fn();

    await runRefresh([], withSourceLoader({
      cachePath,
      fetchImpl,
      now: () => now,
    }, vi.fn<SourceLoader>().mockRejectedValue(
      new Error('source validation failed'),
    )));

    const result = readCache(cachePath);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result?.credentials).toEqual(cached.credentials);
    expect(result?.usage).toEqual(USAGE);
    expect(result?.lastUsageRefreshAt).toBe(cached.lastUsageRefreshAt);
    expect(result?.nextRefreshAllowedAt).toBe(now + 60_000);
  });

  it('preserves cached credentials and usage if reload after a 401 fails', async () => {
    const cached = makeCache(now, { usage: USAGE });
    await writeCache(cached, cachePath);

    await runRefresh([], withSourceLoader({
      cachePath,
      fetchImpl: vi.fn().mockResolvedValue(response(401)),
      now: () => now,
    }, vi.fn<SourceLoader>().mockRejectedValue(
      new Error('cannot validate credential source'),
    )));

    const result = readCache(cachePath);
    expect(result?.credentials).toEqual(cached.credentials);
    expect(result?.usage).toEqual(USAGE);
    expect(result?.authState).toBe('fatal');
  });

  it('reloads exactly the recorded explicit file source', async () => {
    const source: CredentialSource = {
      kind: 'file',
      path: path.join(tmpDir, 'enterprise-credentials.json'),
    };
    await writeCache(makeCache(now, {
      authState: 'fatal',
      credentialSource: source,
    }), cachePath);
    const loadSource = vi.fn<SourceLoader>().mockResolvedValue({
      accessToken: 'file-access',
      refreshToken: 'file-refresh',
      expiresAt: now + 60 * 60_000,
    });

    await runRefresh([], withSourceLoader({
      cachePath,
      now: () => now,
      fetchImpl: vi.fn().mockResolvedValue(response(200, USAGE)),
    }, loadSource));

    expect(loadSource).toHaveBeenCalledOnce();
    expect(loadSource).toHaveBeenCalledWith(source);
  });

  it('does not overwrite credentials committed by init during a request', async () => {
    await writeCache(makeCache(now), cachePath);
    const initCredentials = {
      accessToken: 'reauthenticated-access',
      expiresAt: now + 2 * 60 * 60_000,
    };
    let initSnapshot: Cache | null = null;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await writeCache(makeCache(now, {
        credentials: initCredentials,
        usage: CONCURRENT_USAGE,
        lastUsageRefreshAt: now + 1,
        lastRefreshStartedAt: 0,
      }), cachePath);
      initSnapshot = readCache(cachePath);
      return response(200, USAGE);
    });

    await runRefresh([], {
      cachePath,
      fetchImpl,
      now: () => now,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(readCache(cachePath)).toEqual(initSnapshot);
  });

  it('discards candidate success when a concurrent cache has newer credentials and usage', async () => {
    const starting = makeCache(now, {
      credentials: { accessToken: 'starting-access', expiresAt: now + 60_000 },
    });
    await writeCache(starting, cachePath);
    const candidate: OAuthCredentials = {
      accessToken: 'candidate-access',
      refreshToken: 'candidate-refresh',
      expiresAt: now + 60 * 60_000,
    };
    const newer = {
      accessToken: 'concurrent-access',
      expiresAt: now + 2 * 60 * 60_000,
    };
    let concurrentSnapshot: Cache | undefined;
    const fetchImpl: typeof fetch = async () => {
      const concurrent = readCache(cachePath)!;
      concurrent.credentials = newer;
      concurrent.usage = CONCURRENT_USAGE;
      concurrent.lastUsageRefreshAt = now + 123;
      concurrent.lastErrorMessage = 'newer process result';
      concurrent.authState = 'ok';
      await writeCache(concurrent, cachePath);
      concurrentSnapshot = readCache(cachePath)!;
      return response(200, USAGE);
    };

    await runRefresh([], withSourceLoader({
      cachePath,
      fetchImpl,
      now: () => now,
    }, vi.fn<SourceLoader>().mockResolvedValue(candidate)));

    expect(readCache(cachePath)).toEqual(concurrentSnapshot);
  });

  it('discards a final 401 when a concurrent cache has newer credentials and usage', async () => {
    await writeCache(makeCache(now), cachePath);
    const candidate: OAuthCredentials = {
      accessToken: 'candidate-access',
      refreshToken: 'candidate-refresh',
      expiresAt: now + 60 * 60_000,
    };
    let concurrentSnapshot: Cache | undefined;
    let callCount = 0;
    const fetchImpl: typeof fetch = async () => {
      callCount += 1;
      if (callCount === 1) return response(401);

      const concurrent = readCache(cachePath)!;
      concurrent.credentials = {
        accessToken: 'concurrent-access',
        expiresAt: now + 2 * 60 * 60_000,
      };
      concurrent.usage = CONCURRENT_USAGE;
      concurrent.lastUsageRefreshAt = now + 456;
      concurrent.lastErrorMessage = null;
      concurrent.authState = 'ok';
      await writeCache(concurrent, cachePath);
      concurrentSnapshot = readCache(cachePath)!;
      return response(401);
    };

    await runRefresh([], withSourceLoader({
      cachePath,
      fetchImpl,
      now: () => now,
    }, vi.fn<SourceLoader>().mockResolvedValue(candidate)));

    expect(callCount).toBe(2);
    expect(readCache(cachePath)).toEqual(concurrentSnapshot);
  });

  it('discards a transient candidate result when a concurrent cache has newer credentials and usage', async () => {
    await writeCache(makeCache(now, {
      credentials: { accessToken: 'starting-access', expiresAt: now + 60_000 },
    }), cachePath);
    let concurrentSnapshot: Cache | undefined;
    const fetchImpl: typeof fetch = async () => {
      const concurrent = readCache(cachePath)!;
      concurrent.credentials = {
        accessToken: 'concurrent-access',
        expiresAt: now + 2 * 60 * 60_000,
      };
      concurrent.usage = CONCURRENT_USAGE;
      concurrent.lastUsageRefreshAt = now + 789;
      concurrent.lastErrorMessage = null;
      await writeCache(concurrent, cachePath);
      concurrentSnapshot = readCache(cachePath)!;
      return response(500, 'stale request failed');
    };

    await runRefresh([], withSourceLoader({
      cachePath,
      fetchImpl,
      now: () => now,
    }, vi.fn<SourceLoader>().mockResolvedValue({
      accessToken: 'candidate-access',
      refreshToken: 'candidate-refresh',
      expiresAt: now + 60 * 60_000,
    })));

    expect(readCache(cachePath)).toEqual(concurrentSnapshot);
  });

  it('discards a source failure when a concurrent cache has newer credentials and usage', async () => {
    await writeCache(makeCache(now, {
      credentials: { accessToken: 'starting-access', expiresAt: now + 60_000 },
    }), cachePath);
    let concurrentSnapshot: Cache | undefined;
    const loadSource: SourceLoader = async () => {
      const concurrent = readCache(cachePath)!;
      concurrent.credentials = {
        accessToken: 'concurrent-access',
        expiresAt: now + 2 * 60 * 60_000,
      };
      concurrent.usage = CONCURRENT_USAGE;
      concurrent.lastUsageRefreshAt = now + 987;
      concurrent.lastErrorMessage = null;
      await writeCache(concurrent, cachePath);
      concurrentSnapshot = readCache(cachePath)!;
      throw new Error('stale source failed');
    };

    await runRefresh([], withSourceLoader({
      cachePath,
      fetchImpl: vi.fn(),
      now: () => now,
    }, loadSource));

    expect(readCache(cachePath)).toEqual(concurrentSnapshot);
  });

  it('keeps missing, in-flight, and cooldown paths network-free', async () => {
    const fetchImpl = vi.fn();
    const loadSource = vi.fn<SourceLoader>();
    const deps = withSourceLoader({
      cachePath,
      fetchImpl,
      now: () => now,
    }, loadSource);

    await runRefresh([], deps);

    await writeCache(makeCache(now, {
      lastRefreshStartedAt: now - 500,
    }), cachePath);
    await runRefresh([], deps);

    await writeCache(makeCache(now, {
      rateLimitedUntilMs: now + 60_000,
      nextRefreshAllowedAt: now + 120_000,
    }), cachePath);
    await runRefresh([], deps);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(loadSource).not.toHaveBeenCalled();
  });

  it('treats malformed v4 JSON as a missing cache', async () => {
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ schemaVersion: 4 }),
      'utf8',
    );
    const fetchImpl = vi.fn();
    const loadSource = vi.fn<SourceLoader>();

    expect(await runRefresh([], withSourceLoader({
      cachePath,
      fetchImpl,
      now: () => now,
    }, loadSource))).toBe(0);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(loadSource).not.toHaveBeenCalled();
    expect(readCache(cachePath)).toBeNull();
  });

  it('persists explicit 429 cooldown diagnostics and clears them on success', async () => {
    await writeCache(makeCache(now), cachePath);
    await runRefresh([], {
      cachePath,
      now: () => now,
      fetchImpl: vi.fn().mockResolvedValue(response(429, '', {
        'Retry-After': '120',
        'x-should-retry': 'false',
      })),
    });

    expect(readCache(cachePath)).toMatchObject({
      authState: 'ok',
      rateLimitedUntilMs: now + 120_000,
      nextRefreshAllowedAt: now + 300_000,
      consecutiveRateLimitCount: 1,
    });
    expect(readCache(cachePath)?.lastErrorMessage).toContain(
      'x-should-retry: false',
    );

    now += 301_000;
    await runRefresh([], {
      cachePath,
      now: () => now,
      fetchImpl: vi.fn().mockResolvedValue(response(200, USAGE)),
    });
    expect(readCache(cachePath)).toMatchObject({
      rateLimitedUntilMs: 0,
      nextRefreshAllowedAt: 0,
      consecutiveRateLimitCount: 0,
    });
  });

  it('handles usage 403 explicitly without changing credentials or usage', async () => {
    const cached = makeCache(now, { usage: USAGE });
    await writeCache(cached, cachePath);

    await runRefresh([], {
      cachePath,
      now: () => now,
      fetchImpl: vi.fn().mockResolvedValue(response(403)),
    });

    expect(readCache(cachePath)).toMatchObject({
      authState: 'cloudflare-blocked',
      credentials: cached.credentials,
      usage: USAGE,
      nextRefreshAllowedAt: now + 60_000,
    });
  });

  it('handles transient usage errors explicitly and sanitizes diagnostics', async () => {
    const cached = makeCache(now, {
      credentials: {
        accessToken: 'sensitive-access',
        expiresAt: now + 60 * 60_000,
      },
      usage: USAGE,
    });
    await writeCache(cached, cachePath);

    await runRefresh([], {
      cachePath,
      now: () => now,
      fetchImpl: vi.fn().mockRejectedValue(
        new Error('network failed for sensitive-access'),
      ),
    });

    const result = readCache(cachePath);
    expect(result?.authState).toBe('ok');
    expect(result?.usage).toEqual(USAGE);
    expect(result?.lastErrorMessage).toBe('network failed for <redacted>');
    expect(result?.nextRefreshAllowedAt).toBe(now + 60_000);

    const retry = vi.fn();
    await runRefresh([], {
      cachePath,
      now: () => now + 30_000,
      fetchImpl: retry,
    });
    expect(retry).not.toHaveBeenCalled();
  });

  it('always exits zero and remains silent', async () => {
    await writeCache(makeCache(now), cachePath);

    expect(await runRefresh([], {
      cachePath,
      now: () => now,
      fetchImpl: vi.fn().mockResolvedValue(response(200, USAGE)),
    })).toBe(0);

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});
