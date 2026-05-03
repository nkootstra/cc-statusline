/**
 * Tests for src/subcommands/init.ts
 *
 * All file I/O uses temp dirs under os.tmpdir().
 * No real keychain access, no real ~/.claude/ is touched.
 * The test suite covers all 25 scenarios specified in U9.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { runInit, type InitDeps } from '../src/subcommands/init';
import { readCache, writeCache, type Cache } from '../src/cache/store';
import { readSettings } from '../src/settings/mutator';
import type { OAuthCredentials, UsageResponse } from '../src/oauth/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-init-test-'));
}

// All paths mirror production layout under <homedir>/.claude/. The init impl
// derives the install dir from homedirOverride; tests must look in the same
// place. settings/cache paths are also overridden via InitDeps to put them
// under .claude/ so re-reads via readSettings/readCache observe the same files.
function settingsPath(dir: string): string {
  return path.join(dir, '.claude', 'settings.json');
}

function cachePath(dir: string): string {
  return path.join(dir, '.claude', 'cc-statusline', 'cache.json');
}

function bundlePath(dir: string): string {
  return path.join(dir, '.claude', 'cc-statusline', 'cc-statusline.js');
}

function writeJson(filePath: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function fileHash(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

const MOCK_CREDENTIALS: OAuthCredentials = {
  accessToken: 'sk-ant-access-token',
  refreshToken: 'rt-refresh-token',
  expiresAt: Date.now() + 3_600_000, // 1 hour from now
};

const VALID_ENVELOPE = {
  claudeAiOauth: {
    accessToken: MOCK_CREDENTIALS.accessToken,
    refreshToken: MOCK_CREDENTIALS.refreshToken,
    expiresAt: MOCK_CREDENTIALS.expiresAt,
  },
};

const MOCK_USAGE: UsageResponse = {
  five_hour: { utilization: 0.1, resetsAt: '2026-05-03T12:00:00Z' },
  seven_day: { utilization: 0.2, resetsAt: '2026-05-10T00:00:00Z' },
};

function makeValidCache(overrides: Partial<Cache> = {}): Cache {
  return {
    schemaVersion: 1,
    authState: 'ok',
    credentials: MOCK_CREDENTIALS,
    usage: MOCK_USAGE,
    lastUsageRefreshAt: Date.now(),
    lastRefreshStartedAt: 0,
    lastErrorMessage: null,
    ...overrides,
  };
}

/**
 * Build a spawnRefresh mock that writes a cache with the given state after
 * being called. Returns the mock function.
 */
function makeSpawnRefresh(
  cacheDir: string,
  cacheOverrides: Partial<Cache> = {},
): InitDeps['spawnRefresh'] {
  return vi.fn((_args, _opts) => {
    const cFile = path.join(cacheDir, '.claude', 'cc-statusline', 'cache.json');
    const cache = makeValidCache(cacheOverrides);
    fs.mkdirSync(path.dirname(cFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cFile, JSON.stringify(cache, null, 2) + '\n', 'utf8');
    return { status: 0 };
  });
}

/**
 * Build default deps for testing without touching real ~/.claude/.
 */
function baseDeps(tmpDir: string, extra: Partial<InitDeps> = {}): InitDeps {
  return {
    homedirOverride: tmpDir,
    platformOverride: 'linux',
    bundlePathOverride: path.join(tmpDir, 'fake-bundle.js'),
    versionString: '1.2.3',
    settingsPath: settingsPath(tmpDir),
    cachePath: cachePath(tmpDir),
    isInteractive: false,
    ...extra,
  };
}

function makeFakeBundle(dir: string): string {
  const p = path.join(dir, 'fake-bundle.js');
  fs.writeFileSync(p, '#!/usr/bin/env node\n// fake bundle\n', 'utf8');
  return p;
}

// Capture stdout during a call
async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; output: string }> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return (originalWrite as (c: string | Uint8Array, ...a: unknown[]) => boolean)(chunk, ...rest);
  };
  try {
    const code = await fn();
    return { code, output: chunks.join('') };
  } finally {
    process.stdout.write = originalWrite;
  }
}

// Capture stderr during a call
async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; output: string }> {
  const chunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return (originalWrite as (c: string | Uint8Array, ...a: unknown[]) => boolean)(chunk, ...rest);
  };
  try {
    const code = await fn();
    return { code, output: chunks.join('') };
  } finally {
    process.stderr.write = originalWrite;
  }
}

// ---------------------------------------------------------------------------
// Test 1: Happy path (Pro/Max, interactive) — user picks 1 (Pro)
// ---------------------------------------------------------------------------

describe('T1: happy path Pro interactive', () => {
  it('picks Pro at the prompt; copies bundle; sets render-promax command; no cache.json; no discover', async () => {
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);

    const discoverSpy = vi.fn();
    const spawnSpy = vi.fn();

    // stdinReader returns '1' for Pro
    const deps = baseDeps(tmpDir, {
      isInteractive: true,
      stdinReader: vi.fn().mockResolvedValue('1'),
      discoverImpl: discoverSpy as InitDeps['discoverImpl'],
      spawnRefresh: spawnSpy,
    });

    const code = await runInit([], deps);
    expect(code).toBe(0);

    // Bundle was copied
    expect(fs.existsSync(bundlePath(tmpDir))).toBe(true);

    // Settings has render-promax
    const s = readSettings(settingsPath(tmpDir));
    expect(s.statusLine?.command).toMatch(/render-promax/);

    // No cache.json (R3)
    expect(fs.existsSync(cachePath(tmpDir))).toBe(false);

    // No discover calls
    expect(discoverSpy).not.toHaveBeenCalled();

    // No spawn calls
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 2: Happy path (Pro/Max, non-interactive) — --plan=pro
// ---------------------------------------------------------------------------

describe('T2: happy path Pro non-interactive --plan=pro', () => {
  it('short-circuits the prompt; copies bundle; sets render-promax; no cache', async () => {
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);

    const deps = baseDeps(tmpDir, { isInteractive: false });

    const code = await runInit(['--plan=pro'], deps);
    expect(code).toBe(0);

    expect(fs.existsSync(bundlePath(tmpDir))).toBe(true);
    const s = readSettings(settingsPath(tmpDir));
    expect(s.statusLine?.command).toMatch(/render-promax/);
    expect(fs.existsSync(cachePath(tmpDir))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Happy path (Enterprise, interactive, macOS)
// ---------------------------------------------------------------------------

describe('T3: happy path Enterprise interactive macOS', () => {
  it('discovers via mock; writes initial cache; invokes refresh; settings updated; spawn called once', async () => {
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);

    const discoverSpy = vi.fn().mockResolvedValue(MOCK_CREDENTIALS);
    const spawnSpy = makeSpawnRefresh(tmpDir, { usage: MOCK_USAGE });

    const deps = baseDeps(tmpDir, {
      platformOverride: 'darwin',
      isInteractive: true,
      stdinReader: vi.fn().mockResolvedValue('3'),
      discoverImpl: discoverSpy as InitDeps['discoverImpl'],
      spawnRefresh: spawnSpy,
    });

    const { code, output } = await captureStdout(() => runInit([], deps));
    expect(code).toBe(0);

    // Discover was called
    expect(discoverSpy).toHaveBeenCalledOnce();
    // Spawn refresh was called once
    expect(spawnSpy).toHaveBeenCalledOnce();

    // Settings has render-enterprise
    const s = readSettings(settingsPath(tmpDir));
    expect(s.statusLine?.command).toMatch(/render-enterprise/);

    // Cache exists
    const cache = readCache(cachePath(tmpDir));
    expect(cache).not.toBeNull();
    expect(cache?.authState).toBe('ok');

    // Output includes success message
    expect(output).toContain('Enterprise statusline installed');

    // Always Allow banner printed on macOS
    expect(output).toContain('Always Allow');
  });
});

// ---------------------------------------------------------------------------
// Test 4: Happy path (Enterprise, non-interactive with --credentials-path)
// ---------------------------------------------------------------------------

describe('T4: happy path Enterprise non-interactive with --credentials-path', () => {
  it('reads from specified path; skips discover; completes install', async () => {
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);

    // Write a valid credentials file inside homedir
    const credFile = path.join(tmpDir, '.claude', 'test-creds.json');
    fs.mkdirSync(path.dirname(credFile), { recursive: true });
    fs.writeFileSync(credFile, JSON.stringify(VALID_ENVELOPE), 'utf8');

    const discoverSpy = vi.fn();
    const spawnSpy = makeSpawnRefresh(tmpDir, { usage: MOCK_USAGE });

    const deps = baseDeps(tmpDir, {
      discoverImpl: discoverSpy as InitDeps['discoverImpl'],
      spawnRefresh: spawnSpy,
    });

    const code = await runInit(
      [`--plan=enterprise`, `--credentials-path=${credFile}`],
      deps,
    );
    expect(code).toBe(0);

    // No discover called
    expect(discoverSpy).not.toHaveBeenCalled();

    // Cache written
    const cache = readCache(cachePath(tmpDir));
    expect(cache).not.toBeNull();
    expect(cache?.authState).toBe('ok');

    // Settings has render-enterprise
    const s = readSettings(settingsPath(tmpDir));
    expect(s.statusLine?.command).toMatch(/render-enterprise/);
  });
});

// ---------------------------------------------------------------------------
// Test 5: AE5 — settings conflict, interactive, user says 'n'
// ---------------------------------------------------------------------------

describe('T5: AE5 settings conflict interactive answer n', () => {
  it('existing statusLine.command differs; user says n; settings.json unchanged; no cache; exit 0', async () => {
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);

    // Write settings with an existing different command
    writeJson(settingsPath(tmpDir), {
      statusLine: { type: 'command', command: '/other/tool render-something' },
    });

    const deps = baseDeps(tmpDir, {
      isInteractive: true,
      stdinReader: vi.fn()
        .mockResolvedValueOnce('1')   // plan choice
        .mockResolvedValueOnce('n'),  // conflict prompt
    });

    const code = await runInit([], deps);
    expect(code).toBe(0);

    // Settings unchanged
    const s = readSettings(settingsPath(tmpDir));
    expect(s.statusLine?.command).toBe('/other/tool render-something');

    // No cache
    expect(fs.existsSync(cachePath(tmpDir))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Conflict, non-interactive, no --force
// ---------------------------------------------------------------------------

describe('T6: conflict non-interactive no --force', () => {
  it('exits with code 2; settings unchanged', async () => {
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);

    writeJson(settingsPath(tmpDir), {
      statusLine: { type: 'command', command: '/other/tool render-something' },
    });

    const deps = baseDeps(tmpDir, { isInteractive: false });

    const { code } = await captureStderr(() => runInit(['--plan=pro'], deps));
    expect(code).toBe(2);

    // Settings unchanged
    const s = readSettings(settingsPath(tmpDir));
    expect(s.statusLine?.command).toBe('/other/tool render-something');
  });
});

// ---------------------------------------------------------------------------
// Test 7: Conflict with --force
// ---------------------------------------------------------------------------

describe('T7: conflict with --force', () => {
  it('settings overwritten without prompt; exits 0', async () => {
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);

    writeJson(settingsPath(tmpDir), {
      statusLine: { type: 'command', command: '/other/tool render-something' },
    });

    const deps = baseDeps(tmpDir, { isInteractive: false });

    const code = await runInit(['--plan=pro', '--force'], deps);
    expect(code).toBe(0);

    // Settings now has our command
    const s = readSettings(settingsPath(tmpDir));
    expect(s.statusLine?.command).toMatch(/render-promax/);
  });
});

// ---------------------------------------------------------------------------
// Test 8: Idempotent re-run, Enterprise — cache exists with valid creds, no --force
// ---------------------------------------------------------------------------

describe('T8: idempotent re-run Enterprise with valid cache', () => {
  it('macOS spawn NOT invoked; settings re-asserted; exit 0', async () => {
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);

    // Pre-write a valid cache
    const validCache = makeValidCache();
    await writeCache(validCache, cachePath(tmpDir));

    const discoverSpy = vi.fn();
    const spawnSpy = vi.fn();

    const deps = baseDeps(tmpDir, {
      discoverImpl: discoverSpy as InitDeps['discoverImpl'],
      spawnRefresh: spawnSpy,
    });

    const code = await runInit(['--plan=enterprise'], deps);
    expect(code).toBe(0);

    // Discover NOT called
    expect(discoverSpy).not.toHaveBeenCalled();
    // Spawn NOT called
    expect(spawnSpy).not.toHaveBeenCalled();

    // Settings has render-enterprise
    const s = readSettings(settingsPath(tmpDir));
    expect(s.statusLine?.command).toMatch(/render-enterprise/);
  });
});

// ---------------------------------------------------------------------------
// Test 9: Enterprise validation auth-fatal
// ---------------------------------------------------------------------------

describe('T9: Enterprise validation auth-fatal', () => {
  it('mock refresh writes cache with authState=fatal; init prints remediation; exit code 3', async () => {
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);

    const discoverSpy = vi.fn().mockResolvedValue(MOCK_CREDENTIALS);
    const spawnSpy = makeSpawnRefresh(tmpDir, { authState: 'fatal', usage: null, lastErrorMessage: 'Token revoked' });

    const deps = baseDeps(tmpDir, {
      discoverImpl: discoverSpy as InitDeps['discoverImpl'],
      spawnRefresh: spawnSpy,
    });

    const { code, output } = await captureStderr(() => runInit(['--plan=enterprise'], deps));
    expect(code).toBe(3);
    expect(output).toMatch(/auth-fatal|expired|revoked/i);
  });
});

// ---------------------------------------------------------------------------
// Test 10: Enterprise validation cloudflare-blocked
// ---------------------------------------------------------------------------

describe('T10: Enterprise validation cloudflare-blocked', () => {
  it('mock refresh writes cache with authState=cloudflare-blocked; Cloudflare-specific message; exit code 3', async () => {
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);

    const discoverSpy = vi.fn().mockResolvedValue(MOCK_CREDENTIALS);
    const spawnSpy = makeSpawnRefresh(tmpDir, { authState: 'cloudflare-blocked', usage: null, lastErrorMessage: 'Cloudflare blocked' });

    const deps = baseDeps(tmpDir, {
      discoverImpl: discoverSpy as InitDeps['discoverImpl'],
      spawnRefresh: spawnSpy,
    });

    const { code, output } = await captureStderr(() => runInit(['--plan=enterprise'], deps));
    expect(code).toBe(3);
    expect(output).toMatch(/cloudflare|network|VPN/i);
  });
});

// ---------------------------------------------------------------------------
// Test 11: Enterprise validation transient — usage=null, lastErrorMessage set
// ---------------------------------------------------------------------------

describe('T11: Enterprise validation transient', () => {
  it('mock refresh leaves authState=ok but usage=null with lastErrorMessage; exit code 4', async () => {
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);

    const discoverSpy = vi.fn().mockResolvedValue(MOCK_CREDENTIALS);
    const spawnSpy = makeSpawnRefresh(tmpDir, {
      authState: 'ok',
      usage: null,
      lastErrorMessage: 'Transient network error',
    });

    const deps = baseDeps(tmpDir, {
      discoverImpl: discoverSpy as InitDeps['discoverImpl'],
      spawnRefresh: spawnSpy,
    });

    const { code, output } = await captureStdout(() => runInit(['--plan=enterprise'], deps));
    expect(code).toBe(4);
    expect(output).toContain('could not contact the usage API; retry later');
  });
});

// ---------------------------------------------------------------------------
// Test 12: CredentialNotFoundError, interactive — prompts for paste
// ---------------------------------------------------------------------------

import { CredentialNotFoundError } from '../src/credentials/discover';

describe('T12: CredentialNotFoundError interactive paste flow', () => {
  it('discover throws; user prompted for paste; valid paste proceeds; invalid re-prompts (max 3; 3rd failure exits non-zero)', async () => {
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);

    const discoverSpy = vi.fn().mockRejectedValue(
      new CredentialNotFoundError(['macOS keychain', '/fake/.credentials.json']),
    );

    // First paste is invalid JSON, second is invalid envelope, third is valid
    const validEnvelopeStr = JSON.stringify(VALID_ENVELOPE);
    const pasteReader = vi.fn()
      .mockResolvedValueOnce('not-json-at-all')
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: {} })) // missing fields
      .mockResolvedValueOnce(validEnvelopeStr);

    const spawnSpy = makeSpawnRefresh(tmpDir, { usage: MOCK_USAGE });

    const deps = baseDeps(tmpDir, {
      isInteractive: true,
      stdinReader: vi.fn().mockResolvedValue('3'), // choose enterprise
      discoverImpl: discoverSpy as InitDeps['discoverImpl'],
      pasteReader,
      spawnRefresh: spawnSpy,
    });

    const code = await runInit([], deps);
    // After 3rd attempt (valid), should succeed
    expect(code).toBe(0);
    expect(pasteReader).toHaveBeenCalledTimes(3);

    // 3-failure case: all invalid
    const tmpDir2 = makeTmpDir();
    makeFakeBundle(tmpDir2);
    const discoverSpy2 = vi.fn().mockRejectedValue(
      new CredentialNotFoundError(['macOS keychain', '/fake/.credentials.json']),
    );
    const pasteReader2 = vi.fn().mockResolvedValue('not-json-at-all');

    const { code: code2 } = await captureStderr(() =>
      runInit([], baseDeps(tmpDir2, {
        isInteractive: true,
        stdinReader: vi.fn().mockResolvedValue('3'),
        discoverImpl: discoverSpy2 as InitDeps['discoverImpl'],
        pasteReader: pasteReader2,
        spawnRefresh: vi.fn(),
      })),
    );
    expect(code2).toBe(2);
    expect(pasteReader2).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Test 13: CredentialNotFoundError, non-interactive
// ---------------------------------------------------------------------------

describe('T13: CredentialNotFoundError non-interactive', () => {
  it('discover throws; exits non-zero; message includes paths tried', async () => {
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);

    const pathsTried = ['macOS keychain', '/home/user/.claude/.credentials.json'];
    const discoverSpy = vi.fn().mockRejectedValue(new CredentialNotFoundError(pathsTried));

    const deps = baseDeps(tmpDir, {
      isInteractive: false,
      discoverImpl: discoverSpy as InitDeps['discoverImpl'],
    });

    const { code, output } = await captureStderr(() => runInit(['--plan=enterprise'], deps));
    expect(code).toBe(2);
    expect(output).toContain(pathsTried[0]);
    expect(output).toContain(pathsTried[1]);
  });
});

// ---------------------------------------------------------------------------
// Test 14: Windows path emission
// ---------------------------------------------------------------------------

describe('T14: Windows path emission', () => {
  it('on win32, command is node <absolute>\\cc-statusline.js render-promax; on POSIX, no node prefix', async () => {
    // Windows
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);
    const depsWin = baseDeps(tmpDir, { platformOverride: 'win32', isInteractive: false });
    await runInit(['--plan=pro'], depsWin);
    const sWin = readSettings(settingsPath(tmpDir));
    expect(sWin.statusLine?.command).toMatch(/^node /);
    expect(sWin.statusLine?.command).toMatch(/render-promax/);

    // POSIX (linux)
    const tmpDir2 = makeTmpDir();
    makeFakeBundle(tmpDir2);
    const depsLinux = baseDeps(tmpDir2, { platformOverride: 'linux', isInteractive: false });
    await runInit(['--plan=pro'], depsLinux);
    const sLinux = readSettings(settingsPath(tmpDir2));
    expect(sLinux.statusLine?.command).not.toMatch(/^node /);
    expect(sLinux.statusLine?.command).toMatch(/render-promax/);
  });
});

// ---------------------------------------------------------------------------
// Test 15: Absolute path — no ~ in emitted command
// ---------------------------------------------------------------------------

describe('T15: absolute path — no tilde', () => {
  it('emitted statusLine.command starts with resolved homedir, never contains ~', async () => {
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);
    const deps = baseDeps(tmpDir, { isInteractive: false });

    await runInit(['--plan=pro'], deps);

    const s = readSettings(settingsPath(tmpDir));
    const cmd = s.statusLine?.command ?? '';
    expect(cmd).not.toContain('~/');
    expect(cmd).not.toContain('~\\');
    // Should start with the install dir (which is inside tmpDir)
    expect(path.isAbsolute(cmd.replace(/^node /, ''))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 16: POSIX file mode — cc-statusline.js is mode 0o755 after copy
// ---------------------------------------------------------------------------

describe('T16: POSIX file mode', () => {
  it('on POSIX, cc-statusline.js has mode 0o755 after copy', async () => {
    if (process.platform === 'win32') return;

    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);
    const deps = baseDeps(tmpDir, { platformOverride: 'linux', isInteractive: false });

    await runInit(['--plan=pro'], deps);

    const mode = fs.statSync(bundlePath(tmpDir)).mode & 0o777;
    expect(mode).toBe(0o755);
  });
});

// ---------------------------------------------------------------------------
// Test 17: Always re-copy — two invocations; byte-identical after second
// ---------------------------------------------------------------------------

describe('T17: always re-copy', () => {
  it('invoke init twice; file at installDir is byte-identical to bundlePathOverride', async () => {
    const tmpDir = makeTmpDir();
    const fakeBundle = makeFakeBundle(tmpDir);
    const deps = baseDeps(tmpDir, { isInteractive: false });

    await runInit(['--plan=pro'], deps);

    // Modify the file at installDir to differ
    fs.writeFileSync(bundlePath(tmpDir), '// different content\n', 'utf8');

    // Second invocation should re-copy
    await runInit(['--plan=pro'], deps);

    // Should now be identical to the fake bundle
    expect(fileHash(bundlePath(tmpDir))).toBe(fileHash(fakeBundle));
  });
});

// ---------------------------------------------------------------------------
// Test 18: --credentials-path traversal rejection
// ---------------------------------------------------------------------------

describe('T18: --credentials-path traversal rejection', () => {
  it('an existing file outside homedir is rejected because it escapes homedir; exit code 2', async () => {
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);
    const deps = baseDeps(tmpDir);
    const outsideFile = path.join(os.tmpdir(), `cc-outside-creds-${Date.now()}.json`);
    fs.writeFileSync(outsideFile, JSON.stringify(VALID_ENVELOPE), 'utf8');

    try {
      const { code, output } = await captureStderr(() =>
        runInit(['--plan=enterprise', `--credentials-path=${outsideFile}`], deps),
      );
      expect(code).toBe(2);
      expect(output).toMatch(/outside home|escapes|homedir/i);
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test 19: --credentials-path symlink-out rejection
// ---------------------------------------------------------------------------

describe('T19: --credentials-path symlink-out rejection', () => {
  it('symlink in tmpDir pointing to /etc/passwd is rejected via realpath', async () => {
    if (process.platform === 'win32') return; // symlinks are tricky on Windows

    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);

    // Create symlink in tmpDir pointing outside
    const symlinkPath = path.join(tmpDir, 'evil-link.json');
    try {
      fs.symlinkSync('/etc/passwd', symlinkPath);
    } catch {
      // Skip if we can't create symlinks
      return;
    }

    const deps = baseDeps(tmpDir);

    const { code, output } = await captureStderr(() =>
      runInit(['--plan=enterprise', `--credentials-path=${symlinkPath}`], deps),
    );
    expect(code).toBe(2);
    expect(output).toMatch(/outside home|escapes|homedir/i);
  });
});

// ---------------------------------------------------------------------------
// Test 20: --credentials-path special-file rejection
// ---------------------------------------------------------------------------

describe('T20: --credentials-path special-file rejection', () => {
  it('/dev/zero is rejected (not a regular file); exit code 2', async () => {
    if (process.platform === 'win32') return; // no /dev/zero on Windows

    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);
    const deps = baseDeps(tmpDir);

    const { code, output } = await captureStderr(() =>
      runInit(['--plan=enterprise', '--credentials-path=/dev/zero'], deps),
    );
    expect(code).toBe(2);
    // Either "outside home" (realpath shows it's not under homedir) OR "not a regular file"
    expect(output).toMatch(/outside home|not a regular file|escapes|homedir/i);
  });
});

// ---------------------------------------------------------------------------
// Test 21: Paste no-echo — pasted bytes do NOT appear in stdout
// ---------------------------------------------------------------------------

describe('T21: paste no-echo', () => {
  it('captured stdout during paste prompt does not contain pasted bytes', async () => {
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);

    const SECRET = 'my-secret-paste-content-xyz';

    const discoverSpy = vi.fn().mockRejectedValue(
      new CredentialNotFoundError(['keychain']),
    );
    const pasteReader = vi.fn().mockResolvedValueOnce(JSON.stringify(VALID_ENVELOPE));

    const spawnSpy = makeSpawnRefresh(tmpDir, { usage: MOCK_USAGE });

    const deps = baseDeps(tmpDir, {
      isInteractive: true,
      stdinReader: vi.fn().mockResolvedValue('3'),
      discoverImpl: discoverSpy as InitDeps['discoverImpl'],
      pasteReader,
      spawnRefresh: spawnSpy,
    });

    const { output } = await captureStdout(() => runInit([], deps));

    // The secret paste string should not appear in stdout
    expect(output).not.toContain(SECRET);
    // The pasted JSON envelope string should not appear in stdout either
    expect(output).not.toContain(VALID_ENVELOPE.claudeAiOauth.accessToken);
  });
});

// ---------------------------------------------------------------------------
// Test 22: Initial cache shape — all 6 fields explicit
// ---------------------------------------------------------------------------

describe('T22: initial cache shape', () => {
  it('written initial cache has all six Cache fields; readCache returns fully-typed object', async () => {
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);

    const discoverSpy = vi.fn().mockResolvedValue(MOCK_CREDENTIALS);
    // Spawn writes a valid cache with usage
    const spawnSpy = makeSpawnRefresh(tmpDir, { usage: MOCK_USAGE });

    const deps = baseDeps(tmpDir, {
      discoverImpl: discoverSpy as InitDeps['discoverImpl'],
      spawnRefresh: spawnSpy,
    });

    // We need to read the cache BEFORE the spawn mock overwrites it, so we
    // intercept the spawnRefresh to capture the initial cache.
    let initialCacheSnapshot: Cache | null = null;
    const captureSpawn: InitDeps['spawnRefresh'] = vi.fn((_args, _opts) => {
      // Capture the cache written before spawn
      initialCacheSnapshot = readCache(cachePath(tmpDir));
      // Then do what makeSpawnRefresh would do
      const cFile = cachePath(tmpDir);
      const cache = makeValidCache({ usage: MOCK_USAGE });
      fs.mkdirSync(path.dirname(cFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(cFile, JSON.stringify(cache, null, 2) + '\n', 'utf8');
      return { status: 0 };
    });

    const code = await runInit(['--plan=enterprise'], {
      ...deps,
      spawnRefresh: captureSpawn,
    });
    expect(code).toBe(0);

    // Initial cache (before spawn) must have all six fields
    expect(initialCacheSnapshot).not.toBeNull();
    const c = initialCacheSnapshot!;
    expect(c.schemaVersion).toBe(1);
    expect(c.authState).toBe('ok');
    expect(c.credentials).toBeDefined();
    expect(c.usage).toBeNull();
    expect(c.lastUsageRefreshAt).toBe(0);
    expect(c.lastRefreshStartedAt).toBe(0);
    expect(c.lastErrorMessage).toBeNull();

    // None are undefined
    const fields: (keyof Cache)[] = [
      'schemaVersion', 'authState', 'credentials', 'usage',
      'lastUsageRefreshAt', 'lastRefreshStartedAt', 'lastErrorMessage',
    ];
    for (const field of fields) {
      expect(c[field]).not.toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 23: --force unified — bypasses both conflict prompt AND idempotent skip
// ---------------------------------------------------------------------------

describe('T23: --force unified', () => {
  it('with --force, settings conflict and idempotent-skip are both bypassed; destructive paths fire', async () => {
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);

    // Existing conflicting settings
    writeJson(settingsPath(tmpDir), {
      statusLine: { type: 'command', command: '/other/tool render-something' },
    });

    // Existing valid cache (would normally cause idempotent skip)
    const validCache = makeValidCache();
    await writeCache(validCache, cachePath(tmpDir));

    const discoverSpy = vi.fn().mockResolvedValue(MOCK_CREDENTIALS);
    const spawnSpy = makeSpawnRefresh(tmpDir, { usage: MOCK_USAGE });

    const deps = baseDeps(tmpDir, {
      discoverImpl: discoverSpy as InitDeps['discoverImpl'],
      spawnRefresh: spawnSpy,
    });

    const code = await runInit(['--plan=enterprise', '--force'], deps);
    expect(code).toBe(0);

    // Settings was overwritten
    const s = readSettings(settingsPath(tmpDir));
    expect(s.statusLine?.command).toMatch(/render-enterprise/);
    expect(s.statusLine?.command).not.toBe('/other/tool render-something');

    // Discover was called (idempotent skip was bypassed)
    expect(discoverSpy).toHaveBeenCalled();
    // Spawn was called (idempotent skip was bypassed)
    expect(spawnSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 24: Always Allow banner — macOS vs Linux/Windows
// ---------------------------------------------------------------------------

describe('T24: Always Allow banner macOS vs Linux', () => {
  it('on darwin Enterprise flow, banner is printed before discover; on linux, banner NOT printed', async () => {
    // macOS
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);

    const discoverSpy = vi.fn().mockResolvedValue(MOCK_CREDENTIALS);
    const spawnSpy = makeSpawnRefresh(tmpDir, { usage: MOCK_USAGE });
    const capturedMessages: string[] = [];
    const originalDiscoverSpy = vi.fn(async (..._args: unknown[]) => {
      // Record the stdout so far at the time discover is called
      capturedMessages.push(...stdoutSoFar);
      return MOCK_CREDENTIALS;
    });

    let stdoutSoFar: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
      stdoutSoFar.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return (origWrite as (c: string | Uint8Array, ...a: unknown[]) => boolean)(chunk, ...rest);
    };

    try {
      const deps = baseDeps(tmpDir, {
        platformOverride: 'darwin',
        discoverImpl: originalDiscoverSpy as InitDeps['discoverImpl'],
        spawnRefresh: spawnSpy,
      });
      const code = await runInit(['--plan=enterprise'], deps);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = origWrite;
    }

    const allOutput = stdoutSoFar.join('');
    expect(allOutput).toContain('Always Allow');

    // Linux — no banner
    const tmpDir2 = makeTmpDir();
    makeFakeBundle(tmpDir2);
    const discoverSpy2 = vi.fn().mockResolvedValue(MOCK_CREDENTIALS);
    const spawnSpy2 = makeSpawnRefresh(tmpDir2, { usage: MOCK_USAGE });

    const { output: linuxOutput } = await captureStdout(() =>
      runInit(
        ['--plan=enterprise'],
        baseDeps(tmpDir2, {
          platformOverride: 'linux',
          discoverImpl: discoverSpy2 as InitDeps['discoverImpl'],
          spawnRefresh: spawnSpy2,
        }),
      ),
    );
    expect(linuxOutput).not.toContain('Always Allow');
  });
});

// ---------------------------------------------------------------------------
// Test 25: Version log
// ---------------------------------------------------------------------------

describe('T25: version log', () => {
  it("init's stdout includes a line matching /^installed cc-statusline v\\d+\\.\\d+\\.\\d+/", async () => {
    const tmpDir = makeTmpDir();
    makeFakeBundle(tmpDir);
    const deps = baseDeps(tmpDir, {
      versionString: '1.2.3',
      isInteractive: false,
    });

    const { output } = await captureStdout(() => runInit(['--plan=pro'], deps));
    expect(output).toMatch(/installed cc-statusline v\d+\.\d+\.\d+/);
    expect(output).toContain('installed cc-statusline v1.2.3');
  });
});
