import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readCache,
  writeCache,
  updateCache,
  isRefreshInFlight,
  sanitizeErrorMessage,
  defaultCachePath,
  type Cache,
} from '../src/cache/store';
import type { OAuthCredentials } from '../src/credentials/envelope';

function makeMinimalCache(overrides: Partial<Cache> = {}): Cache {
  return {
    schemaVersion: 4,
    authState: 'ok',
    credentials: {
      accessToken: 'sk-ant-access',
      expiresAt: Date.now() + 3_600_000,
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

function readJsonCache(value: unknown): Cache | null {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-statusline-read-cache-'));
  const tmpFile = path.join(tmpDir, 'cache.json');
  fs.writeFileSync(tmpFile, JSON.stringify(value), 'utf8');
  try {
    return readCache(tmpFile);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('defaultCachePath', () => {
  it('uses CLAUDE_CONFIG_DIR env when set', () => {
    const original = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = path.join(os.tmpdir(), 'custom-claude');
    try {
      expect(defaultCachePath()).toBe(
        path.join(os.tmpdir(), 'custom-claude', 'cc-statusline', 'cache.json'),
      );
    } finally {
      if (original === undefined) {
        delete process.env['CLAUDE_CONFIG_DIR'];
      } else {
        process.env['CLAUDE_CONFIG_DIR'] = original;
      }
    }
  });

  it('falls back to ~/.claude/cc-statusline/cache.json', () => {
    const original = process.env['CLAUDE_CONFIG_DIR'];
    delete process.env['CLAUDE_CONFIG_DIR'];
    try {
      const expected = path.join(os.homedir(), '.claude', 'cc-statusline', 'cache.json');
      expect(defaultCachePath()).toBe(expected);
    } finally {
      if (original !== undefined) {
        process.env['CLAUDE_CONFIG_DIR'] = original;
      }
    }
  });
});

describe('readCache', () => {
  it('returns null for a non-existent path', () => {
    const result = readCache('/tmp/cc-statusline-nonexistent-xyz-123/cache.json');
    expect(result).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const tmpFile = path.join(os.tmpdir(), `cc-statusline-test-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, '{ this is not valid json !!!', 'utf8');
    try {
      const result = readCache(tmpFile);
      expect(result).toBeNull();
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('returns null when schemaVersion is unrecognized', () => {
    const tmpFile = path.join(os.tmpdir(), `cc-statusline-test-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ schemaVersion: 99, authState: 'ok' }), 'utf8');
    try {
      const result = readCache(tmpFile);
      expect(result).toBeNull();
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('returns a valid v4 cache with source provenance and access-only credentials', () => {
    const cache = {
      schemaVersion: 4,
      authState: 'ok',
      credentials: {
        accessToken: 'sk-ant-access',
        expiresAt: Date.now() + 3_600_000,
      },
      credentialSource: { kind: 'claude-code' },
      usage: null,
      lastUsageRefreshAt: 0,
      lastRefreshStartedAt: 0,
      lastErrorMessage: null,
      rateLimitedUntilMs: 0,
      nextRefreshAllowedAt: 0,
      consecutiveRateLimitCount: 0,
    };
    const tmpFile = path.join(os.tmpdir(), `cc-statusline-v4-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(cache, null, 2) + '\n', 'utf8');
    try {
      expect(readCache(tmpFile)).toEqual(cache);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('accepts each auth state and an explicit file source without filesystem validation', () => {
    const sourcePath = path.join(
      os.homedir(),
      'cc-statusline-source-does-not-need-to-exist.json',
    );

    for (const authState of ['ok', 'fatal', 'cloudflare-blocked'] as const) {
      const cache = makeMinimalCache({
        authState,
        credentialSource: { kind: 'file', path: sourcePath },
      });
      expect(readJsonCache(cache)).toEqual(cache);
    }
  });

  it.each([
    ['an array at the top level', []],
    ['missing required fields', { schemaVersion: 4 }],
    ['an invalid auth state', { ...makeMinimalCache(), authState: 'unknown' }],
    ['non-object credentials', { ...makeMinimalCache(), credentials: [] }],
    [
      'an empty access token',
      {
        ...makeMinimalCache(),
        credentials: { accessToken: '', expiresAt: Date.now() },
      },
    ],
    [
      'a non-numeric credential expiry',
      {
        ...makeMinimalCache(),
        credentials: { accessToken: 'access', expiresAt: 'later' },
      },
    ],
    [
      'a refresh token',
      {
        ...makeMinimalCache(),
        credentials: {
          accessToken: 'access',
          expiresAt: Date.now(),
          refreshToken: 'must-not-be-cached',
        },
      },
    ],
    [
      'an invalid credential source kind',
      { ...makeMinimalCache(), credentialSource: { kind: 'environment' } },
    ],
    [
      'an empty explicit credential path',
      { ...makeMinimalCache(), credentialSource: { kind: 'file', path: '' } },
    ],
    ['an array usage value', { ...makeMinimalCache(), usage: [] }],
    ['a primitive usage value', { ...makeMinimalCache(), usage: 'unknown' }],
    [
      'an invalid usage bucket',
      {
        ...makeMinimalCache(),
        usage: { five_hour: { utilization: 'unknown' } },
      },
    ],
    [
      'an invalid extra usage value',
      {
        ...makeMinimalCache(),
        usage: { extra_usage: { is_enabled: 'yes' } },
      },
    ],
    [
      'a non-numeric last usage refresh',
      { ...makeMinimalCache(), lastUsageRefreshAt: 'never' },
    ],
    [
      'a non-numeric last refresh start',
      { ...makeMinimalCache(), lastRefreshStartedAt: 'never' },
    ],
    [
      'a non-numeric rate-limit deadline',
      { ...makeMinimalCache(), rateLimitedUntilMs: 'never' },
    ],
    [
      'a non-numeric adaptive-backoff deadline',
      { ...makeMinimalCache(), nextRefreshAllowedAt: 'never' },
    ],
    [
      'a negative consecutive rate-limit count',
      { ...makeMinimalCache(), consecutiveRateLimitCount: -1 },
    ],
    [
      'a fractional consecutive rate-limit count',
      { ...makeMinimalCache(), consecutiveRateLimitCount: 1.5 },
    ],
    [
      'a non-string last error',
      { ...makeMinimalCache(), lastErrorMessage: { message: 'failed' } },
    ],
  ])('returns null for a v4 cache with %s', (_description, cache) => {
    expect(readJsonCache(cache)).toBeNull();
  });

  it('returns null for non-finite numeric fields parsed from valid JSON', () => {
    const cache = makeMinimalCache();
    const content = JSON.stringify(cache)
      .replace(
        `"expiresAt":${cache.credentials.expiresAt}`,
        '"expiresAt":1e400',
      )
      .replace('"lastUsageRefreshAt":0', '"lastUsageRefreshAt":1e400');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-statusline-read-cache-'));
    const tmpFile = path.join(tmpDir, 'cache.json');
    fs.writeFileSync(tmpFile, content, 'utf8');
    try {
      expect(readCache(tmpFile)).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns null for a v3 cache', () => {
    const cache = {
      ...makeMinimalCache(),
      schemaVersion: 3,
      credentials: {
        accessToken: 'sk-ant-access',
        refreshToken: 'rt-refresh',
        expiresAt: Date.now() + 3_600_000,
      },
    };
    const tmpFile = path.join(os.tmpdir(), `cc-statusline-test-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(cache, null, 2) + '\n', 'utf8');
    try {
      expect(readCache(tmpFile)).toBeNull();
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('returns null for a v1 cache', () => {
    const v1Cache = {
      schemaVersion: 1,
      authState: 'ok',
      credentials: {
        accessToken: 'v1-access',
        refreshToken: 'v1-refresh',
        expiresAt: Date.now() + 3_600_000,
      },
      usage: null,
      lastUsageRefreshAt: 12345,
      lastRefreshStartedAt: 0,
      lastErrorMessage: null,
    };
    const tmpFile = path.join(os.tmpdir(), `cc-statusline-v1-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(v1Cache, null, 2) + '\n', 'utf8');
    try {
      expect(readCache(tmpFile)).toBeNull();
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('returns null for a v2 cache', () => {
    const rateLimitedUntilMs = Date.now() + 90_000;
    const v2Cache = {
      schemaVersion: 2,
      authState: 'ok',
      credentials: {
        accessToken: 'v2-access',
        refreshToken: 'v2-refresh',
        expiresAt: Date.now() + 3_600_000,
      },
      usage: null,
      lastUsageRefreshAt: 12345,
      lastRefreshStartedAt: 0,
      lastErrorMessage: null,
      rateLimitedUntilMs,
    };
    const tmpFile = path.join(os.tmpdir(), `cc-statusline-v2-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(v2Cache, null, 2) + '\n', 'utf8');
    try {
      expect(readCache(tmpFile)).toBeNull();
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

describe('writeCache', () => {
  it('creates the dir and file when dir does not exist', async () => {
    const tmpBase = path.join(os.tmpdir(), `cc-statusline-write-${Date.now()}`);
    const filePath = path.join(tmpBase, 'nested', 'cache.json');
    const cache = makeMinimalCache();

    try {
      await writeCache(cache, filePath);
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(content);
      expect(parsed.schemaVersion).toBe(4);
      expect(content.endsWith('\n')).toBe(true);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('creates file with mode 0o600 and dir with mode 0o700 on POSIX', async () => {
    if (process.platform === 'win32') return;

    const tmpBase = path.join(os.tmpdir(), `cc-statusline-mode-${Date.now()}`);
    const filePath = path.join(tmpBase, 'cache.json');
    const cache = makeMinimalCache();

    try {
      await writeCache(cache, filePath);
      const fileMode = fs.statSync(filePath).mode & 0o777;
      expect(fileMode).toBe(0o600);

      const dirMode = fs.statSync(tmpBase).mode & 0o777;
      expect(dirMode).toBe(0o700);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('never persists a refresh token from candidate credentials', async () => {
    const tmpBase = path.join(os.tmpdir(), `cc-statusline-secrets-${Date.now()}`);
    const filePath = path.join(tmpBase, 'cache.json');
    const cache = makeMinimalCache();
    const credentialsWithRefreshToken = {
      ...cache.credentials,
      refreshToken: 'rt-must-not-be-cached',
    };

    try {
      await writeCache({ ...cache, credentials: credentialsWithRefreshToken }, filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      expect(JSON.parse(content).credentials).toEqual({
        accessToken: 'sk-ant-access',
        expiresAt: cache.credentials.expiresAt,
      });
      expect(content).not.toContain('rt-must-not-be-cached');
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

});

describe('updateCache', () => {
  it('serializes read-modify-write transactions without losing either update', async () => {
    const tmpBase = fs.mkdtempSync(
      path.join(os.tmpdir(), 'cc-statusline-update-cache-'),
    );
    const filePath = path.join(tmpBase, 'cache.json');
    await writeCache(makeMinimalCache(), filePath);

    try {
      await Promise.all([
        updateCache(filePath, (current) => {
          if (current === null) throw new Error('cache unexpectedly missing');
          return {
            kind: 'write',
            cache: {
              ...current,
              lastErrorMessage: 'first update',
            },
            value: undefined,
          };
        }),
        updateCache(filePath, (current) => {
          if (current === null) throw new Error('cache unexpectedly missing');
          return {
            kind: 'write',
            cache: {
              ...current,
              authState: 'fatal',
            },
            value: undefined,
          };
        }),
      ]);

      expect(readCache(filePath)).toMatchObject({
        authState: 'fatal',
        lastErrorMessage: 'first update',
      });
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('recovers a dead contender without deleting a live successor', async () => {
    const tmpBase = fs.mkdtempSync(
      path.join(os.tmpdir(), 'cc-statusline-stale-lock-'),
    );
    const filePath = path.join(tmpBase, 'cache.json');
    const lockDir = `${filePath}.locks`;
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, 'stale.ticket'),
      JSON.stringify({
        pid: 2_147_483_647,
        createdAt: Date.now() - 180_000,
        token: 'stale',
        ticket: 1,
      }),
      { mode: 0o600 },
    );
    await writeCache(makeMinimalCache(), filePath);

    try {
      await Promise.all([
        updateCache(filePath, (current) => {
          if (current === null) throw new Error('cache unexpectedly missing');
          return {
            kind: 'write',
            cache: { ...current, lastErrorMessage: 'first' },
            value: undefined,
          };
        }),
        updateCache(filePath, (current) => {
          if (current === null) throw new Error('cache unexpectedly missing');
          return {
            kind: 'write',
            cache: { ...current, authState: 'fatal' },
            value: undefined,
          };
        }),
      ]);

      expect(readCache(filePath)).toMatchObject({
        authState: 'fatal',
        lastErrorMessage: 'first',
      });
      expect(
        fs.existsSync(lockDir) ? fs.readdirSync(lockDir) : [],
      ).toEqual([]);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

describe('isRefreshInFlight', () => {
  it('returns true while a normal auth recovery can still be running', () => {
    const now = Date.now();
    const cache = makeMinimalCache({ lastRefreshStartedAt: now - 30_000 });
    expect(isRefreshInFlight(cache, now)).toBe(true);
  });

  it('returns false after the refresh lease expires', () => {
    const now = Date.now();
    const cache = makeMinimalCache({ lastRefreshStartedAt: now - 45_001 });
    expect(isRefreshInFlight(cache, now)).toBe(false);
  });

  it('returns false when lastRefreshStartedAt is 0 (never started)', () => {
    const cache = makeMinimalCache({ lastRefreshStartedAt: 0 });
    expect(isRefreshInFlight(cache, 0)).toBe(false);
  });
});

describe('sanitizeErrorMessage', () => {
  const credentials: OAuthCredentials = {
    accessToken: 'sk-ant-abc123',
    refreshToken: 'rt-xyz',
    expiresAt: 0,
  };

  it('replaces the access token with <redacted>', () => {
    const result = sanitizeErrorMessage(
      'Bearer sk-ant-abc123 returned 401',
      credentials,
    );
    expect(result).toBe('Bearer <redacted> returned 401');
    expect(result).not.toContain('sk-ant-abc123');
  });

  it('replaces both tokens when both appear', () => {
    const result = sanitizeErrorMessage(
      'access=sk-ant-abc123 refresh=rt-xyz',
      credentials,
    );
    expect(result).toBe('access=<redacted> refresh=<redacted>');
    expect(result).not.toContain('sk-ant-abc123');
    expect(result).not.toContain('rt-xyz');
  });

  it('redacts a cached access token and tokens from an optional full candidate', () => {
    const result = sanitizeErrorMessage(
      'cached=old-access candidate=new-access refresh=new-refresh',
      { accessToken: 'old-access', expiresAt: 0 },
      {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: 0,
      },
    );

    expect(result).toBe(
      'cached=<redacted> candidate=<redacted> refresh=<redacted>',
    );
  });

  it('does not mutate the message when token is empty string', () => {
    const emptyCredentials: OAuthCredentials = {
      accessToken: '',
      refreshToken: '',
      expiresAt: 0,
    };
    const msg = 'some error message';
    const result = sanitizeErrorMessage(msg, emptyCredentials);
    expect(result).toBe(msg);
  });

  it('replaces all occurrences (replace-all semantics)', () => {
    const result = sanitizeErrorMessage(
      'sk-ant-abc123 and sk-ant-abc123 again',
      credentials,
    );
    expect(result).toBe('<redacted> and <redacted> again');
    expect(result).not.toContain('sk-ant-abc123');
  });

  it('returns the message unchanged when no token appears in it', () => {
    const result = sanitizeErrorMessage('generic network error', credentials);
    expect(result).toBe('generic network error');
  });
});
