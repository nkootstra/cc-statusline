/**
 * Tests for src/subcommands/uninstall.ts
 *
 * All file I/O uses temp dirs under os.tmpdir().
 * No real ~/.claude/ is touched.
 * Covers all 7 uninstall scenarios from U9.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runUninstall, type UninstallDeps } from '../src/subcommands/uninstall';
import { readSettings, writeSettings } from '../src/settings/mutator';
import { writeCache, type Cache } from '../src/cache/store';
import { createDiagnosticLogger, defaultDiagnosticLogDisabledPath } from '../src/diagnostics/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-uninstall-test-'));
}

function settingsPath(dir: string): string {
  return path.join(dir, 'settings.json');
}

function installDir(dir: string): string {
  return path.join(dir, '.claude', 'cc-statusline');
}

function rendererPath(dir: string): string {
  return path.join(installDir(dir), 'cc-statusline.js');
}

function cachePath(dir: string): string {
  return path.join(installDir(dir), 'cache.json');
}

function writeJson(filePath: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function baseDeps(dir: string, extra: Partial<UninstallDeps> = {}): UninstallDeps {
  return {
    homedirOverride: path.join(dir, 'home'),
    settingsPath: settingsPath(dir),
    ...extra,
  };
}

function getInstallDir(dir: string): string {
  return path.join(dir, 'home', '.claude', 'cc-statusline');
}

function getRendererPath(dir: string): string {
  return path.join(getInstallDir(dir), 'cc-statusline.js');
}

function getCachePath(dir: string): string {
  return path.join(getInstallDir(dir), 'cache.json');
}

function getDiagnosticLogPath(dir: string): string {
  return path.join(getInstallDir(dir), 'debug.log');
}

function writeRenderer(dir: string): void {
  const p = getRendererPath(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/usr/bin/env node\n// renderer\n', 'utf8');
}

async function writeTestCache(dir: string): Promise<void> {
  const cache: Cache = {
    schemaVersion: 3,
    authState: 'ok',
    credentials: {
      accessToken: 'sk-ant-test',
      refreshToken: 'rt-test',
      expiresAt: Date.now() + 3_600_000,
    },
    usage: {
      five_hour: { utilization: 0.1, resetsAt: '2026-05-03T12:00:00Z' },
      seven_day: { utilization: 0.2, resetsAt: '2026-05-10T00:00:00Z' },
    },
    lastUsageRefreshAt: Date.now(),
    lastRefreshStartedAt: 0,
    lastErrorMessage: null,
    rateLimitedUntilMs: 0,
    nextRefreshAllowedAt: 0,
    consecutiveRateLimitCount: 0,
  };
  await writeCache(cache, getCachePath(dir));
}

function writeDiagnosticLogs(dir: string): void {
  fs.writeFileSync(getDiagnosticLogPath(dir), '{"event":"test"}\n', { mode: 0o600 });
  fs.writeFileSync(`${getDiagnosticLogPath(dir)}.1`, '{"event":"old"}\n', { mode: 0o600 });
}

const COMMAND = '/home/user/.claude/cc-statusline/cc-statusline.js render-promax';

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

// ---------------------------------------------------------------------------
// T1: AE6 — clean install state
// ---------------------------------------------------------------------------

describe('T1: AE6 clean install state', () => {
  it('renderer, cache, installDir all exist + statusLine in settings; uninstall removes all 4 artifacts; preserves other keys; exits 0', async () => {
    const tmpDir = makeTmpDir();

    writeRenderer(tmpDir);
    await writeTestCache(tmpDir);
    writeDiagnosticLogs(tmpDir);

    // Write settings with statusLine and sibling keys
    writeJson(settingsPath(tmpDir), {
      model: 'claude-sonnet-4-5',
      theme: 'dark',
      statusLine: { type: 'command', command: COMMAND, padding: 2, refreshInterval: 10 },
    });

    const deps = baseDeps(tmpDir);

    const { code, output } = await captureStdout(() => runUninstall([], deps));
    expect(code).toBe(0);

    // Renderer removed
    expect(fs.existsSync(getRendererPath(tmpDir))).toBe(false);

    // Cache removed
    expect(fs.existsSync(getCachePath(tmpDir))).toBe(false);

    // Diagnostic logs removed
    expect(fs.existsSync(getDiagnosticLogPath(tmpDir))).toBe(false);
    expect(fs.existsSync(`${getDiagnosticLogPath(tmpDir)}.1`)).toBe(false);

    // Install dir removed (was empty after above)
    expect(fs.existsSync(getInstallDir(tmpDir))).toBe(false);

    // Settings: statusLine removed, siblings preserved
    const s = readSettings(settingsPath(tmpDir));
    expect('statusLine' in s).toBe(false);
    expect(s['model']).toBe('claude-sonnet-4-5');
    expect(s['theme']).toBe('dark');

    // Exit message
    expect(output).toContain('cc-statusline uninstalled');
  });
});

// ---------------------------------------------------------------------------
// T2: Idempotent partial state (Pro/Max install, no cache)
// ---------------------------------------------------------------------------

describe('T2: idempotent partial state Pro/Max (no cache)', () => {
  it('renderer exists but cache does not; uninstall succeeds without complaining; exits 0', async () => {
    const tmpDir = makeTmpDir();

    writeRenderer(tmpDir);
    // No cache file

    writeJson(settingsPath(tmpDir), {
      statusLine: { type: 'command', command: COMMAND },
    });

    const deps = baseDeps(tmpDir);
    const code = await runUninstall([], deps);
    expect(code).toBe(0);

    expect(fs.existsSync(getRendererPath(tmpDir))).toBe(false);
    const s = readSettings(settingsPath(tmpDir));
    expect('statusLine' in s).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T3: Idempotent no state
// ---------------------------------------------------------------------------

describe('T3: idempotent no state', () => {
  it('nothing exists; uninstall is a no-op; exits 0', async () => {
    const tmpDir = makeTmpDir();

    const deps = baseDeps(tmpDir);
    const code = await runUninstall([], deps);
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T4: No settings file
// ---------------------------------------------------------------------------

describe('T4: no settings file', () => {
  it('settings.json does not exist; uninstall does not create it; exits 0', async () => {
    const tmpDir = makeTmpDir();

    // Ensure settings.json does not exist
    const sPath = settingsPath(tmpDir);
    expect(fs.existsSync(sPath)).toBe(false);

    const deps = baseDeps(tmpDir);
    const code = await runUninstall([], deps);
    expect(code).toBe(0);

    // Settings file was NOT created
    expect(fs.existsSync(sPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T5: Other files in install dir — dir NOT removed
// ---------------------------------------------------------------------------

describe('T5: other files in install dir', () => {
  it('user has a custom file in installDir; directory is NOT removed; only cc-statusline-owned files are removed', async () => {
    const tmpDir = makeTmpDir();

    writeRenderer(tmpDir);

    // Add a custom user file
    const customFile = path.join(getInstallDir(tmpDir), 'my-custom-config.json');
    fs.writeFileSync(customFile, '{"custom": true}\n', 'utf8');

    writeJson(settingsPath(tmpDir), {
      statusLine: { type: 'command', command: COMMAND },
    });

    const deps = baseDeps(tmpDir);
    const code = await runUninstall([], deps);
    expect(code).toBe(0);

    // Renderer removed
    expect(fs.existsSync(getRendererPath(tmpDir))).toBe(false);

    // Custom file still exists
    expect(fs.existsSync(customFile)).toBe(true);

    // Install dir still exists (not empty)
    expect(fs.existsSync(getInstallDir(tmpDir))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T6: No token revocation — fetch is never called
// ---------------------------------------------------------------------------

describe('T6: no token revocation', () => {
  it('spy on global.fetch; assert zero calls during uninstall', async () => {
    const tmpDir = makeTmpDir();

    writeRenderer(tmpDir);
    await writeTestCache(tmpDir);

    writeJson(settingsPath(tmpDir), {
      statusLine: { type: 'command', command: COMMAND },
    });

    const fetchSpy = vi.spyOn(global, 'fetch');

    const deps = baseDeps(tmpDir);
    const code = await runUninstall([], deps);
    expect(code).toBe(0);

    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// T7: Re-running uninstall is idempotent
// ---------------------------------------------------------------------------

describe('T7: re-running uninstall is idempotent', () => {
  it('run uninstall twice; second run is a no-op + exit 0', async () => {
    const tmpDir = makeTmpDir();

    writeRenderer(tmpDir);
    await writeTestCache(tmpDir);

    writeJson(settingsPath(tmpDir), {
      statusLine: { type: 'command', command: COMMAND },
    });

    const deps = baseDeps(tmpDir);

    const code1 = await runUninstall([], deps);
    expect(code1).toBe(0);

    // Second run — everything is already gone
    const code2 = await runUninstall([], deps);
    expect(code2).toBe(0);
  });
});

describe('T8: uninstall disables active diagnostics replay', () => {
  it('keeps a diagnostics disable marker so no new debug.log can be recreated after uninstall', async () => {
    const tmpDir = makeTmpDir();

    writeRenderer(tmpDir);
    const customFile = path.join(getInstallDir(tmpDir), 'my-custom-config.json');
    fs.writeFileSync(customFile, '{"custom": true}\n', 'utf8');
    writeDiagnosticLogs(tmpDir);

    const deps = baseDeps(tmpDir);
    const code = await runUninstall([], deps);
    expect(code).toBe(0);

    const diagnosticPath = getDiagnosticLogPath(tmpDir);
    const disabledPath = defaultDiagnosticLogDisabledPath(diagnosticPath);
    expect(fs.existsSync(disabledPath)).toBe(true);
    expect(fs.existsSync(diagnosticPath)).toBe(false);
    expect(fs.existsSync(`${diagnosticPath}.1`)).toBe(false);
    expect(fs.existsSync(getInstallDir(tmpDir))).toBe(true);

    await createDiagnosticLogger(diagnosticPath).log({ event: 'refresh.skipped' });
    expect(fs.existsSync(diagnosticPath)).toBe(false);
  });
});
