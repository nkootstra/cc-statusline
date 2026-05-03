import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readCache,
  writeCache,
  isRefreshInFlight,
  sanitizeErrorMessage,
  defaultCachePath,
  type Cache,
} from '../src/cache/store';
import type { OAuthCredentials } from '../src/oauth/types';

function makeMinimalCache(overrides: Partial<Cache> = {}): Cache {
  return {
    schemaVersion: 1,
    authState: 'ok',
    credentials: {
      accessToken: 'sk-ant-access',
      refreshToken: 'rt-refresh',
      expiresAt: Date.now() + 3_600_000,
    },
    usage: null,
    lastUsageRefreshAt: 0,
    lastRefreshStartedAt: 0,
    lastErrorMessage: null,
    ...overrides,
  };
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

  it('returns null when schemaVersion is not 1', () => {
    const tmpFile = path.join(os.tmpdir(), `cc-statusline-test-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ schemaVersion: 0, authState: 'ok' }), 'utf8');
    try {
      const result = readCache(tmpFile);
      expect(result).toBeNull();
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('returns a typed Cache object for valid cache JSON', () => {
    const cache = makeMinimalCache();
    const tmpFile = path.join(os.tmpdir(), `cc-statusline-test-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(cache, null, 2) + '\n', 'utf8');
    try {
      const result = readCache(tmpFile);
      expect(result).not.toBeNull();
      expect(result?.schemaVersion).toBe(1);
      expect(result?.authState).toBe('ok');
      expect(result?.credentials.accessToken).toBe('sk-ant-access');
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
      expect(parsed.schemaVersion).toBe(1);
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

});

describe('isRefreshInFlight', () => {
  it('returns true when lastRefreshStartedAt is 500ms ago', () => {
    const now = Date.now();
    const cache = makeMinimalCache({ lastRefreshStartedAt: now - 500 });
    expect(isRefreshInFlight(cache, now)).toBe(true);
  });

  it('returns false when lastRefreshStartedAt is 1500ms ago', () => {
    const now = Date.now();
    const cache = makeMinimalCache({ lastRefreshStartedAt: now - 1500 });
    expect(isRefreshInFlight(cache, now)).toBe(false);
  });

  it('returns false when lastRefreshStartedAt is 0 (never started)', () => {
    const now = Date.now();
    const cache = makeMinimalCache({ lastRefreshStartedAt: 0 });
    // 0 means never; now - 0 is a large number >> 1000
    expect(isRefreshInFlight(cache, now)).toBe(false);
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
