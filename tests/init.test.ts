import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runInit,
  type InitDeps,
  type SpawnClaudeResult,
} from '../src/subcommands/init';
import { readCache, writeCache, type Cache } from '../src/cache/store';
import { CredentialNotFoundError } from '../src/credentials/discover';
import { readSettings } from '../src/settings/mutator';
import type { OAuthCredentials } from '../src/credentials/envelope';
import type { UsageResponse } from '../src/oauth/types';

const NOW = Date.parse('2026-07-28T12:00:00Z');

const MOCK_CREDENTIALS: OAuthCredentials = {
  accessToken: 'sk-ant-access-token',
  refreshToken: 'rt-refresh-token',
  expiresAt: NOW + 3_600_000,
};

const MOCK_USAGE: UsageResponse = {
  five_hour: { utilization: 10, resets_at: '2026-07-28T17:00:00Z' },
  seven_day: { utilization: 20, resets_at: '2026-08-04T00:00:00Z' },
};

const tmpDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-init-test-'));
  tmpDirs.push(dir);
  return dir;
}

function settingsPath(dir: string): string {
  return path.join(dir, '.claude', 'settings.json');
}

function cachePath(dir: string): string {
  return path.join(dir, '.claude', 'cc-statusline', 'cache.json');
}

function bundlePath(dir: string): string {
  return path.join(dir, '.claude', 'cc-statusline', 'cc-statusline.js');
}

function makeFakeBundle(dir: string, content = '#!/usr/bin/env node\n'): string {
  const filePath = path.join(dir, 'fake-bundle.js');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fileHash(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeFetch(status = 200): typeof fetch {
  return vi.fn(async () => {
    const body = status === 200 ? JSON.stringify(MOCK_USAGE) : undefined;
    const headers = status === 429 ? { 'Retry-After': '12' } : undefined;
    return new Response(body, { status, headers });
  }) as unknown as typeof fetch;
}

function makeThrowingFetch(message = 'timed out'): typeof fetch {
  return vi.fn(async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

function makeCache(overrides: Partial<Cache> = {}): Cache {
  return {
    schemaVersion: 4,
    authState: 'ok',
    credentials: {
      accessToken: MOCK_CREDENTIALS.accessToken,
      expiresAt: MOCK_CREDENTIALS.expiresAt,
    },
    credentialSource: { kind: 'claude-code' },
    usage: MOCK_USAGE,
    lastUsageRefreshAt: NOW,
    lastRefreshStartedAt: 0,
    lastErrorMessage: null,
    rateLimitedUntilMs: 0,
    nextRefreshAllowedAt: 0,
    consecutiveRateLimitCount: 0,
    ...overrides,
  };
}

function baseDeps(tmpDir: string, overrides: Partial<InitDeps> = {}): InitDeps {
  return {
    homedirOverride: tmpDir,
    platformOverride: 'linux',
    bundlePathOverride: makeFakeBundle(tmpDir),
    versionString: '1.2.3',
    settingsPath: settingsPath(tmpDir),
    cachePath: cachePath(tmpDir),
    isInteractive: false,
    now: () => NOW,
    fetchImpl: makeFetch(),
    discoverImpl: vi.fn().mockResolvedValue(MOCK_CREDENTIALS),
    spawnClaude: vi.fn(),
    ...overrides,
  };
}

function captureStream(
  stream: NodeJS.WriteStream,
  fn: () => Promise<number>,
): Promise<{ code: number; output: string }> {
  const chunks: string[] = [];
  const writeSpy = vi.spyOn(stream, 'write').mockImplementation(
    ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof stream.write,
  );
  return fn()
    .then((code) => ({ code, output: chunks.join('') }))
    .finally(() => writeSpy.mockRestore());
}

function captureStdout(fn: () => Promise<number>): Promise<{ code: number; output: string }> {
  return captureStream(process.stdout, fn);
}

function captureStderr(fn: () => Promise<number>): Promise<{ code: number; output: string }> {
  return captureStream(process.stderr, fn);
}

function authRecoveryDeps(
  tmpDir: string,
  statusResult: SpawnClaudeResult,
  loginResult: SpawnClaudeResult = { status: 0, signal: null },
) {
  const discoverImpl = vi.fn()
    .mockRejectedValueOnce(new CredentialNotFoundError(['/mock/credentials.json']))
    .mockResolvedValueOnce(MOCK_CREDENTIALS);
  const spawnClaude = vi.fn((
    _command: string,
    argv: readonly string[],
    _options: Parameters<NonNullable<InitDeps['spawnClaude']>>[2],
  ) => {
    return argv[1] === 'status' ? statusResult : loginResult;
  });
  const deps = baseDeps(tmpDir, {
    isInteractive: true,
    discoverImpl: discoverImpl as InitDeps['discoverImpl'],
    spawnClaude,
  });
  return {
    deps,
    spawnClaude,
    discoverImpl,
  };
}

describe('plan selection and Pro/Max installation', () => {
  it.each([
    [['--plan=pro'], 'pro'],
    [['--plan', 'max'], 'max'],
  ])('accepts %j without reading stdin', async (args) => {
    const tmpDir = makeTmpDir();
    const stdinReader = vi.fn();
    const deps = baseDeps(tmpDir, { stdinReader, isInteractive: true });

    expect(await runInit(args, deps)).toBe(0);
    expect(stdinReader).not.toHaveBeenCalled();
    expect(readSettings(settingsPath(tmpDir)).statusLine?.command).toContain('render-promax');
    expect(fs.existsSync(cachePath(tmpDir))).toBe(false);
  });

  it('prompts for a plan only when interaction is available', async () => {
    const tmpDir = makeTmpDir();
    const stdinReader = vi.fn().mockResolvedValue('1');

    expect(await runInit([], baseDeps(tmpDir, { isInteractive: true, stdinReader }))).toBe(0);
    expect(stdinReader).toHaveBeenCalledOnce();
  });

  it('requires --plan in non-interactive mode without reading stdin', async () => {
    const tmpDir = makeTmpDir();
    const stdinReader = vi.fn();
    const { code, output } = await captureStderr(() =>
      runInit(['--non-interactive'], baseDeps(tmpDir, { isInteractive: true, stdinReader })),
    );

    expect(code).toBe(1);
    expect(output).toContain('--plan');
    expect(stdinReader).not.toHaveBeenCalled();
    expect(fs.existsSync(bundlePath(tmpDir))).toBe(false);
  });
});

describe('guided Claude Code authentication recovery', () => {
  it('--plan skips only plan selection and still launches login with an injected TTY', async () => {
    const tmpDir = makeTmpDir();
    const { deps, spawnClaude } = authRecoveryDeps(
      tmpDir,
      { status: 0, signal: null, stdout: '{"loggedIn":false}' },
    );

    expect(await runInit(['--plan=enterprise'], deps)).toBe(0);
    expect(spawnClaude).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['logged out with documented exit 1', { status: 1, signal: null, stdout: '{"loggedIn":false}' }],
    ['logged in', { status: 0, signal: null, stdout: '{"loggedIn":true}' }],
    ['malformed output', { status: 0, signal: null, stdout: 'not json' }],
    ['missing CLI', { status: null, signal: null, error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }],
  ] satisfies Array<[string, SpawnClaudeResult]>)(
    'treats status result %s as explanatory and invokes exactly one login',
    async (_label, statusResult) => {
      const tmpDir = makeTmpDir();
      const { deps, spawnClaude, discoverImpl } = authRecoveryDeps(tmpDir, statusResult);

      expect(await runInit(['--plan=enterprise'], deps)).toBe(0);
      expect(spawnClaude).toHaveBeenCalledTimes(2);
      expect(spawnClaude.mock.calls.map((call) => call[1])).toEqual([
        ['auth', 'status'],
        ['auth', 'login'],
      ]);
      expect(discoverImpl).toHaveBeenCalledTimes(2);
    },
  );

  it('uses exact safe status and login subprocess options', async () => {
    const tmpDir = makeTmpDir();
    const { deps, spawnClaude } = authRecoveryDeps(
      tmpDir,
      { status: 0, signal: null, stdout: '{"loggedIn":true}' },
    );

    expect(await runInit(['--plan', 'enterprise'], deps)).toBe(0);

    const statusCall = spawnClaude.mock.calls[0];
    const loginCall = spawnClaude.mock.calls[1];
    expect(statusCall?.[0]).toBe('claude');
    expect(statusCall?.[1]).toEqual(['auth', 'status']);
    expect(statusCall?.[2]).toMatchObject({
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      encoding: 'utf8',
    });
    expect(loginCall?.[0]).toBe('claude');
    expect(loginCall?.[1]).toEqual(['auth', 'login']);
    expect(loginCall?.[2]).toMatchObject({
      shell: false,
      stdio: 'inherit',
    });
    expect(loginCall?.[2]).not.toHaveProperty('timeout');
    expect(Object.keys(statusCall?.[2].env ?? {}).sort()).toEqual(['HOME', 'PATH']);
  });

  it('rediscovers once and validates once after login, without looping', async () => {
    const tmpDir = makeTmpDir();
    const fetchImpl = makeFetch();
    const { deps, spawnClaude, discoverImpl } = authRecoveryDeps(
      tmpDir,
      { status: 1, signal: null, stdout: '' },
    );
    deps.fetchImpl = fetchImpl;

    expect(await runInit(['--plan=enterprise'], deps)).toBe(0);
    expect(discoverImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(spawnClaude).toHaveBeenCalledTimes(2);
  });

  it('treats an automatic usage 401 as auth failure and recovers once', async () => {
    const tmpDir = makeTmpDir();
    const discoverImpl = vi.fn().mockResolvedValue(MOCK_CREDENTIALS);
    const spawnClaude = vi.fn((
      _command: string,
      argv: readonly string[],
      _options: Parameters<NonNullable<InitDeps['spawnClaude']>>[2],
    ) => argv[1] === 'status'
      ? { status: 0, signal: null, stdout: '{"loggedIn":true}' }
      : { status: 0, signal: null });
    const fetchImpl = (vi.fn()
      .mockResolvedValueOnce(new Response(undefined, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(MOCK_USAGE), { status: 200 }))
    ) as unknown as typeof fetch;

    expect(await runInit(['--plan=enterprise'], baseDeps(tmpDir, {
      isInteractive: true,
      discoverImpl: discoverImpl as InitDeps['discoverImpl'],
      spawnClaude,
      fetchImpl,
    }))).toBe(0);
    expect(discoverImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(spawnClaude).toHaveBeenCalledTimes(2);
  });

  it('recovers expired automatic credentials and samples time through persistence', async () => {
    const tmpDir = makeTmpDir();
    const postLoginCredentials = {
      ...MOCK_CREDENTIALS,
      accessToken: 'sk-ant-post-login',
      expiresAt: NOW + 1_500,
    };
    const discoverImpl = vi.fn()
      .mockResolvedValueOnce({ ...MOCK_CREDENTIALS, expiresAt: NOW })
      .mockResolvedValueOnce(postLoginCredentials);
    const spawnClaude = vi.fn((
      _command: string,
      argv: readonly string[],
      _options: Parameters<NonNullable<InitDeps['spawnClaude']>>[2],
    ) => argv[1] === 'status'
      ? { status: 0, signal: null, stdout: '{"loggedIn":true}' }
      : { status: 0, signal: null });
    const now = vi.fn()
      .mockReturnValueOnce(NOW)
      .mockReturnValueOnce(NOW + 1_000)
      .mockReturnValueOnce(NOW + 2_000);
    const fetchImpl = makeFetch();

    expect(await runInit(['--plan=enterprise'], baseDeps(tmpDir, {
      isInteractive: true,
      discoverImpl: discoverImpl as InitDeps['discoverImpl'],
      spawnClaude,
      now,
      fetchImpl,
    }))).toBe(0);

    expect(discoverImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(spawnClaude.mock.calls.map((call) => call[1])).toEqual([
      ['auth', 'status'],
      ['auth', 'login'],
    ]);
    expect(now).toHaveBeenCalledTimes(3);
    expect(readCache(cachePath(tmpDir))).toMatchObject({
      credentials: {
        accessToken: postLoginCredentials.accessToken,
        expiresAt: postLoginCredentials.expiresAt,
      },
      credentialSource: { kind: 'claude-code' },
      usage: MOCK_USAGE,
      lastUsageRefreshAt: NOW + 2_000,
    });
    expect(fs.readFileSync(cachePath(tmpDir), 'utf8')).not.toContain('refreshToken');
  });

  it('does not launch login when initial discovery fails for a reason other than missing credentials', async () => {
    const tmpDir = makeTmpDir();
    await writeCache(makeCache(), cachePath(tmpDir));
    const before = fileHash(cachePath(tmpDir));
    const rawError = `malformed credential ${MOCK_CREDENTIALS.accessToken}`;
    const discoverImpl = vi.fn().mockRejectedValue(new Error(rawError));
    const spawnClaude = vi.fn();
    const { code, output } = await captureStderr(() =>
      runInit(['--plan=enterprise', '--force'], baseDeps(tmpDir, {
        isInteractive: true,
        discoverImpl: discoverImpl as InitDeps['discoverImpl'],
        spawnClaude,
      })),
    );

    expect(code).toBe(3);
    expect(output).toBe('init: could not read Claude Code credentials.\n');
    expect(output).not.toContain(rawError);
    expect(spawnClaude).not.toHaveBeenCalled();
    expect(fileHash(cachePath(tmpDir))).toBe(before);
  });

  it.each([
    ['explicit non-interactive mode', ['--plan=enterprise', '--non-interactive'], true],
    ['no TTY', ['--plan=enterprise'], false],
  ])('prints manual commands and runs no Claude commands for %s', async (_label, args, interactive) => {
    const tmpDir = makeTmpDir();
    const discoverImpl = vi.fn().mockRejectedValue(
      new CredentialNotFoundError(['/mock/credentials.json']),
    );
    const spawnClaude = vi.fn();
    const { code, output } = await captureStderr(() =>
      runInit(args, baseDeps(tmpDir, {
        isInteractive: interactive,
        discoverImpl: discoverImpl as InitDeps['discoverImpl'],
        spawnClaude,
      })),
    );

    expect(code).toBe(2);
    expect(output.split('\n')).toContain('claude auth login');
    expect(output.split('\n')).toContain('npx @nkootstra/cc-statusline --plan enterprise');
    expect(spawnClaude).not.toHaveBeenCalled();
  });

  it('returns 130 when login is interrupted by SIGINT', async () => {
    const tmpDir = makeTmpDir();
    const previous = makeCache();
    await writeCache(previous, cachePath(tmpDir));
    const before = fileHash(cachePath(tmpDir));
    const { deps, spawnClaude, discoverImpl } = authRecoveryDeps(
      tmpDir,
      { status: 0, signal: null, stdout: '{"loggedIn":false}' },
      { status: null, signal: 'SIGINT' },
    );

    expect(await runInit(['--plan=enterprise', '--force'], deps)).toBe(130);
    expect(spawnClaude).toHaveBeenCalledTimes(2);
    expect(discoverImpl).toHaveBeenCalledOnce();
    expect(fileHash(cachePath(tmpDir))).toBe(before);
  });

  it.each([
    ['nonzero exit', { status: 1, signal: null }],
    ['missing executable', { status: null, signal: null, error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }],
    ['other signal', { status: null, signal: 'SIGTERM' }],
  ] satisfies Array<[string, SpawnClaudeResult]>)(
    'returns auth error for login %s',
    async (_label, loginResult) => {
      const tmpDir = makeTmpDir();
      await writeCache(makeCache(), cachePath(tmpDir));
      const before = fileHash(cachePath(tmpDir));
      const { deps, spawnClaude, discoverImpl } = authRecoveryDeps(
        tmpDir,
        { status: 0, signal: null, stdout: '{"loggedIn":false}' },
        loginResult,
      );

      expect(await runInit(['--plan=enterprise', '--force'], deps)).toBe(3);
      expect(spawnClaude).toHaveBeenCalledTimes(2);
      expect(discoverImpl).toHaveBeenCalledOnce();
      expect(fileHash(cachePath(tmpDir))).toBe(before);
    },
  );

  it('preserves the previous cache when post-login validation still fails', async () => {
    const tmpDir = makeTmpDir();
    await writeCache(makeCache(), cachePath(tmpDir));
    const before = fileHash(cachePath(tmpDir));
    const { deps, spawnClaude } = authRecoveryDeps(
      tmpDir,
      { status: 0, signal: null, stdout: '{"loggedIn":true}' },
    );
    deps.fetchImpl = makeFetch(401);

    expect(await runInit(['--plan=enterprise', '--force'], deps)).toBe(3);
    expect(spawnClaude).toHaveBeenCalledTimes(2);
    expect(fileHash(cachePath(tmpDir))).toBe(before);
  });

  it.each([
    [
      'credentials remain missing',
      new CredentialNotFoundError(['/mock/credentials.json']),
    ],
    [
      'credential source cannot be read',
      new Error(`malformed credential ${MOCK_CREDENTIALS.accessToken}`),
    ],
  ])(
    'returns a stable error and preserves the previous cache when post-login %s',
    async (_label, rediscoveryError) => {
      const tmpDir = makeTmpDir();
      await writeCache(makeCache(), cachePath(tmpDir));
      const before = fileHash(cachePath(tmpDir));
      const discoverImpl = vi.fn()
        .mockRejectedValueOnce(new CredentialNotFoundError(['/mock/credentials.json']))
        .mockRejectedValueOnce(rediscoveryError);
      const spawnClaude = vi.fn((
        _command: string,
        argv: readonly string[],
        _options: Parameters<NonNullable<InitDeps['spawnClaude']>>[2],
      ) => argv[1] === 'status'
        ? { status: 1, signal: null, stdout: '{"loggedIn":false}' }
        : { status: 0, signal: null });
      const { code, output } = await captureStderr(() =>
        runInit(['--plan=enterprise', '--force'], baseDeps(tmpDir, {
          isInteractive: true,
          discoverImpl: discoverImpl as InitDeps['discoverImpl'],
          spawnClaude,
        })),
      );

      expect(code).toBe(3);
      expect(output).toBe(
        'init: Claude Code credentials were not available after login.\n',
      );
      expect(output).not.toContain(MOCK_CREDENTIALS.accessToken);
      expect(spawnClaude).toHaveBeenCalledTimes(2);
      expect(discoverImpl).toHaveBeenCalledTimes(2);
      expect(fileHash(cachePath(tmpDir))).toBe(before);
    },
  );
});

describe('credential validation and cache persistence', () => {
  it('uses a valid unexpired v4 cache without discovery, auth commands, or network', async () => {
    const tmpDir = makeTmpDir();
    await writeCache(makeCache(), cachePath(tmpDir));
    const discoverImpl = vi.fn();
    const spawnClaude = vi.fn();
    const fetchImpl = makeFetch();

    expect(await runInit(['--plan=enterprise'], baseDeps(tmpDir, {
      discoverImpl: discoverImpl as InitDeps['discoverImpl'],
      spawnClaude,
      fetchImpl,
    }))).toBe(0);
    expect(discoverImpl).not.toHaveBeenCalled();
    expect(spawnClaude).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('validates a direct automatic candidate without auth commands', async () => {
    const tmpDir = makeTmpDir();
    const discoverImpl = vi.fn().mockResolvedValue(MOCK_CREDENTIALS);
    const spawnClaude = vi.fn();
    const fetchImpl = makeFetch();

    expect(await runInit(['--plan=enterprise'], baseDeps(tmpDir, {
      discoverImpl: discoverImpl as InitDeps['discoverImpl'],
      spawnClaude,
      fetchImpl,
    }))).toBe(0);
    expect(discoverImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(spawnClaude).not.toHaveBeenCalled();

    const cache = readCache(cachePath(tmpDir));
    expect(cache).toMatchObject({
      schemaVersion: 4,
      authState: 'ok',
      credentials: {
        accessToken: MOCK_CREDENTIALS.accessToken,
        expiresAt: MOCK_CREDENTIALS.expiresAt,
      },
      credentialSource: { kind: 'claude-code' },
      usage: MOCK_USAGE,
      lastUsageRefreshAt: NOW,
      lastRefreshStartedAt: 0,
      lastErrorMessage: null,
      rateLimitedUntilMs: 0,
      nextRefreshAllowedAt: 0,
      consecutiveRateLimitCount: 0,
    });
    expect(fs.readFileSync(cachePath(tmpDir), 'utf8')).not.toContain('refreshToken');
  });

  it('an explicit path bypasses a valid cache, stores its canonical source, and never runs auth commands', async () => {
    const tmpDir = makeTmpDir();
    await writeCache(makeCache(), cachePath(tmpDir));
    const credentialsFile = path.join(tmpDir, '.claude', 'credentials.json');
    writeJson(credentialsFile, { claudeAiOauth: MOCK_CREDENTIALS });
    const discoverImpl = vi.fn();
    const spawnClaude = vi.fn();
    const fetchImpl = makeFetch();

    expect(await runInit([
      '--plan=enterprise',
      `--credentials-path=${credentialsFile}`,
    ], baseDeps(tmpDir, {
      discoverImpl: discoverImpl as InitDeps['discoverImpl'],
      spawnClaude,
      fetchImpl,
    }))).toBe(0);
    expect(discoverImpl).not.toHaveBeenCalled();
    expect(spawnClaude).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(readCache(cachePath(tmpDir))?.credentialSource).toEqual({
      kind: 'file',
      path: await fs.promises.realpath(credentialsFile),
    });
  });

  it.each([
    ['expired credentials', 'expired', 3],
    ['usage 401', 401, 3],
    ['usage 403', 403, 4],
    ['usage 429', 429, 4],
    ['usage 500', 500, 4],
    ['network timeout', 'timeout', 4],
  ])('classifies explicit-path %s and preserves the previous cache', async (_label, outcome, expectedCode) => {
    const tmpDir = makeTmpDir();
    await writeCache(makeCache(), cachePath(tmpDir));
    const before = fileHash(cachePath(tmpDir));
    const credentialsFile = path.join(tmpDir, '.claude', 'credentials.json');
    const credentials = outcome === 'expired'
      ? { ...MOCK_CREDENTIALS, expiresAt: NOW }
      : MOCK_CREDENTIALS;
    writeJson(credentialsFile, { claudeAiOauth: credentials });
    const spawnClaude = vi.fn();
    const fetchImpl = outcome === 'timeout'
      ? makeThrowingFetch()
      : makeFetch(typeof outcome === 'number' ? outcome : 200);

    expect(await runInit([
      '--plan=enterprise',
      `--credentials-path=${credentialsFile}`,
    ], baseDeps(tmpDir, { spawnClaude, fetchImpl }))).toBe(expectedCode);
    expect(spawnClaude).not.toHaveBeenCalled();
    expect(fileHash(cachePath(tmpDir))).toBe(before);
  });

  it.each([403, 429, 500])(
    'treats automatic usage %i as network failure without launching login',
    async (status) => {
      const tmpDir = makeTmpDir();
      await writeCache(makeCache(), cachePath(tmpDir));
      const before = fileHash(cachePath(tmpDir));
      const spawnClaude = vi.fn();

      expect(await runInit(['--plan=enterprise', '--force'], baseDeps(tmpDir, {
        fetchImpl: makeFetch(status),
        spawnClaude,
      }))).toBe(4);
      expect(spawnClaude).not.toHaveBeenCalled();
      expect(fileHash(cachePath(tmpDir))).toBe(before);
    },
  );

  it('treats malformed automatic usage JSON as a retryable network failure', async () => {
    const tmpDir = makeTmpDir();
    await writeCache(makeCache(), cachePath(tmpDir));
    const before = fileHash(cachePath(tmpDir));
    const spawnClaude = vi.fn();
    const fetchImpl = vi.fn(async () =>
      new Response('not-json', { status: 200 }),
    ) as unknown as typeof fetch;

    const { code, output } = await captureStderr(() =>
      runInit(['--plan=enterprise', '--force'], baseDeps(tmpDir, {
        fetchImpl,
        spawnClaude,
      })),
    );

    expect(code).toBe(4);
    expect(output).toBe('init: could not contact the usage API; retry later.\n');
    expect(spawnClaude).not.toHaveBeenCalled();
    expect(fileHash(cachePath(tmpDir))).toBe(before);
  });
});

describe('settings, platform, and installer regressions', () => {
  it('leaves a conflicting setting unchanged when the interactive user declines', async () => {
    const tmpDir = makeTmpDir();
    writeJson(settingsPath(tmpDir), {
      statusLine: { type: 'command', command: '/other/statusline' },
    });
    const before = fileHash(settingsPath(tmpDir));

    expect(await runInit([], baseDeps(tmpDir, {
      isInteractive: true,
      stdinReader: vi.fn()
        .mockResolvedValueOnce('1')
        .mockResolvedValueOnce('n'),
    }))).toBe(0);
    expect(fileHash(settingsPath(tmpDir))).toBe(before);
    expect(fs.existsSync(bundlePath(tmpDir))).toBe(false);
  });

  it('does not activate Enterprise installation when authentication fails', async () => {
    const tmpDir = makeTmpDir();
    writeJson(settingsPath(tmpDir), {
      statusLine: { type: 'command', command: '/other/statusline' },
    });
    fs.mkdirSync(path.dirname(bundlePath(tmpDir)), { recursive: true });
    fs.writeFileSync(bundlePath(tmpDir), 'previous bundle\n', 'utf8');
    const settingsBefore = fileHash(settingsPath(tmpDir));
    const bundleBefore = fileHash(bundlePath(tmpDir));
    const { deps } = authRecoveryDeps(
      tmpDir,
      { status: 0, signal: null, stdout: '{"loggedIn":false}' },
      { status: 1, signal: null },
    );

    expect(await runInit(['--plan=enterprise', '--force'], deps)).toBe(3);
    expect(fileHash(settingsPath(tmpDir))).toBe(settingsBefore);
    expect(fileHash(bundlePath(tmpDir))).toBe(bundleBefore);
    expect(fs.existsSync(cachePath(tmpDir))).toBe(false);
  });

  it('rejects a settings conflict without interaction and lets --force overwrite it', async () => {
    const tmpDir = makeTmpDir();
    writeJson(settingsPath(tmpDir), {
      statusLine: { type: 'command', command: '/other/statusline' },
    });

    expect(await runInit(['--plan=pro'], baseDeps(tmpDir))).toBe(2);
    expect(readSettings(settingsPath(tmpDir)).statusLine?.command).toBe('/other/statusline');
    expect(await runInit(['--plan=pro', '--force'], baseDeps(tmpDir))).toBe(0);
    expect(readSettings(settingsPath(tmpDir)).statusLine?.command).toContain('render-promax');
  });

  it('emits an absolute node command on Windows', async () => {
    const windowsDir = makeTmpDir();
    expect(await runInit(['--plan=pro'], baseDeps(windowsDir, {
      platformOverride: 'win32',
    }))).toBe(0);
    const windowsCommand = readSettings(settingsPath(windowsDir)).statusLine?.command;
    const windowsBundlePath = bundlePath(windowsDir);
    expect(path.isAbsolute(windowsBundlePath)).toBe(true);
    expect(windowsCommand).toBe(`node ${windowsBundlePath} render-promax`);
  });

  it.runIf(process.platform !== 'win32')('makes POSIX bundles executable', async () => {
    const posixDir = makeTmpDir();
    expect(await runInit(['--plan=pro'], baseDeps(posixDir))).toBe(0);
    expect(readSettings(settingsPath(posixDir)).statusLine?.command)
      .toBe(`${bundlePath(posixDir)} render-promax`);
    expect(fs.statSync(bundlePath(posixDir)).mode & 0o777).toBe(0o755);
  });

  it('always recopies the bundle and logs the installed version', async () => {
    const tmpDir = makeTmpDir();
    const source = makeFakeBundle(tmpDir, 'first\n');
    const deps = baseDeps(tmpDir, { bundlePathOverride: source });

    expect(await runInit(['--plan=pro'], deps)).toBe(0);
    fs.writeFileSync(source, 'second\n', 'utf8');
    const { code, output } = await captureStdout(() => runInit(['--plan=pro'], deps));
    expect(code).toBe(0);
    expect(fs.readFileSync(bundlePath(tmpDir), 'utf8')).toBe('second\n');
    expect(output).toMatch(/installed cc-statusline v1\.2\.3/);
  });

  it('prints the macOS keychain note only for automatic Enterprise discovery', async () => {
    const macDir = makeTmpDir();
    const { output: macOutput } = await captureStdout(() =>
      runInit(['--plan=enterprise'], baseDeps(macDir, { platformOverride: 'darwin' })),
    );
    expect(macOutput).toContain('Always Allow');

    const linuxDir = makeTmpDir();
    const { output: linuxOutput } = await captureStdout(() =>
      runInit(['--plan=enterprise'], baseDeps(linuxDir)),
    );
    expect(linuxOutput).not.toContain('Always Allow');
  });
});

describe('explicit credential path security', () => {
  it('does not print malformed credential contents', async () => {
    const home = makeTmpDir();
    const credentialsFile = path.join(home, 'credentials.json');
    const leakedToken = 'sk-ant-must-not-appear';
    fs.writeFileSync(
      credentialsFile,
      `{"claudeAiOauth":{"accessToken":"${leakedToken}"`,
      'utf8',
    );

    const { code, output } = await captureStderr(() =>
      runInit([
        '--plan=enterprise',
        `--credentials-path=${credentialsFile}`,
      ], baseDeps(home)),
    );

    expect(code).toBe(2);
    expect(output).toContain('could not read credentials from --credentials-path');
    expect(output).not.toContain(leakedToken);
  });

  it('rejects a path outside the home directory', async () => {
    const home = makeTmpDir();
    const outside = makeTmpDir();
    const credentialsFile = path.join(outside, 'credentials.json');
    writeJson(credentialsFile, { claudeAiOauth: MOCK_CREDENTIALS });

    const { code, output } = await captureStderr(() =>
      runInit([
        '--plan=enterprise',
        `--credentials-path=${credentialsFile}`,
      ], baseDeps(home)),
    );
    expect(code).toBe(2);
    expect(output).toContain('outside home directory');
  });

  it('rejects a symlink that resolves outside the home directory', async () => {
    const home = makeTmpDir();
    const outside = makeTmpDir();
    const target = path.join(outside, 'credentials.json');
    const symlink = path.join(home, 'credentials.json');
    writeJson(target, { claudeAiOauth: MOCK_CREDENTIALS });
    fs.symlinkSync(target, symlink);

    const { code } = await captureStderr(() =>
      runInit([
        '--plan=enterprise',
        `--credentials-path=${symlink}`,
      ], baseDeps(home)),
    );
    expect(code).toBe(2);
  });

  it.runIf(process.platform !== 'win32')('rejects a non-regular file', async () => {
    const home = makeTmpDir();
    const directory = path.join(home, 'credentials');
    fs.mkdirSync(directory);

    const { code, output } = await captureStderr(() =>
      runInit([
        '--plan=enterprise',
        `--credentials-path=${directory}`,
      ], baseDeps(home)),
    );
    expect(code).toBe(2);
    expect(output).toContain('not a regular file');
  });
});
