import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runDoctor } from '../src/subcommands/doctor';
import { writeCache, type Cache } from '../src/cache/store';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-statusline-doctor-test-'));
}

function cachePathOf(dir: string): string {
  return path.join(dir, 'cache.json');
}

function makeCache(overrides: Partial<Cache> = {}): Cache {
  return {
    schemaVersion: 2,
    authState: 'ok',
    credentials: {
      accessToken: 'sk-ant-secret-do-not-leak',
      refreshToken: 'rt-secret-do-not-leak',
      expiresAt: Date.now() + 3_600_000,
    },
    usage: null,
    lastUsageRefreshAt: 0,
    lastRefreshStartedAt: 0,
    lastErrorMessage: null,
    rateLimitedUntilMs: 0,
    ...overrides,
  };
}

describe('runDoctor', () => {
  let tmpDir: string;
  let captured: string[];
  let restoreStdout: () => void;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    captured = [];
    const orig = process.stdout.write.bind(process.stdout);
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        if (typeof chunk === 'string') captured.push(chunk);
        else if (Buffer.isBuffer(chunk)) captured.push(chunk.toString('utf8'));
        return true;
      });
    restoreStdout = () => {
      spy.mockRestore();
      void orig;
    };
  });

  afterEach(() => {
    restoreStdout();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('cache absent: prints helpful message and exits 0', async () => {
    const exitCode = await runDoctor([], { cachePath: cachePathOf(tmpDir) });
    expect(exitCode).toBe(0);
    const output = captured.join('');
    expect(output).toContain('absent');
    expect(output).toContain('--plan');
  });

  it('cache present: surfaces authState, last usage, rate-limit status', async () => {
    const now = Date.now();
    const cache = makeCache({
      authState: 'ok',
      lastUsageRefreshAt: now - 30_000,
      rateLimitedUntilMs: 0,
    });
    await writeCache(cache, cachePathOf(tmpDir));

    const exitCode = await runDoctor([], {
      cachePath: cachePathOf(tmpDir),
      now: () => now,
    });

    expect(exitCode).toBe(0);
    const output = captured.join('');
    expect(output).toContain('authState:     ok');
    expect(output).toContain('last usage:    30s ago');
    expect(output).toContain('rate limit:    not rate-limited');
    expect(output).toContain('credential use: local cache (cache.json)');
    expect(output).toContain('credential origin: not recorded');
  });

  it('cooldown active: shows cooldown remaining', async () => {
    const now = Date.now();
    const cache = makeCache({
      rateLimitedUntilMs: now + 4 * 60 * 1000,
    });
    await writeCache(cache, cachePathOf(tmpDir));

    await runDoctor([], { cachePath: cachePathOf(tmpDir), now: () => now });
    const output = captured.join('');
    expect(output).toContain('cooling down');
    expect(output).toMatch(/in \d+m/);
  });

  it('does NOT leak access or refresh token in output', async () => {
    const now = Date.now();
    const cache = makeCache({
      lastErrorMessage: 'some error from earlier',
    });
    await writeCache(cache, cachePathOf(tmpDir));

    await runDoctor([], { cachePath: cachePathOf(tmpDir), now: () => now });
    const output = captured.join('');
    expect(output).not.toContain('sk-ant-secret-do-not-leak');
    expect(output).not.toContain('rt-secret-do-not-leak');
  });

  it('surfaces lastErrorMessage when set', async () => {
    const now = Date.now();
    const cache = makeCache({
      lastErrorMessage:
        'Usage fetch rate-limited. Retry-After: 120s (header present).',
    });
    await writeCache(cache, cachePathOf(tmpDir));

    await runDoctor([], { cachePath: cachePathOf(tmpDir), now: () => now });
    const output = captured.join('');
    expect(output).toContain('header present');
  });

  it('prints retained diagnostic events with --logs without exposing credentials', async () => {
    const now = Date.now();
    const cache = makeCache();
    const cachePath = cachePathOf(tmpDir);
    const logPath = path.join(tmpDir, 'debug.log');
    await writeCache(cache, cachePath);
    fs.writeFileSync(
      logPath,
      JSON.stringify({
        timestamp: '2026-07-22T10:00:00.000Z',
        pid: 123,
        event: 'usage.response',
        status: 429,
        retryAfterSeconds: 120,
      }) + '\n',
      { mode: 0o600 },
    );

    await runDoctor(['--logs'], {
      cachePath,
      logPath,
      now: () => now,
    });

    const output = captured.join('');
    expect(output).toContain('diagnostics:');
    expect(output).toContain('usage.response');
    expect(output).toContain('"status":429');
    expect(output).not.toContain('sk-ant-secret-do-not-leak');
    expect(output).not.toContain('rt-secret-do-not-leak');
  });
});
