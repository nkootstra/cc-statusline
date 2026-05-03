/**
 * Tests for src/credentials/envelope.ts and src/credentials/discover.ts.
 *
 * All real I/O is replaced by injected overrides (spawnOverride,
 * readFileOverride). No real keychain access or file reads occur.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { decodeEnvelope, InvalidEnvelopeError } from '../src/credentials/envelope.js';
import { discover, CredentialNotFoundError } from '../src/credentials/discover.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal valid envelope JSON value. */
const VALID_ENVELOPE = {
  claudeAiOauth: {
    accessToken: 'at-abc',
    refreshToken: 'rt-xyz',
    expiresAt: 9_999_999_999_000,
  },
};

/** Minimal shape that `discover` uses from the returned ChildProcess. */
interface FakeProc extends EventEmitter {
  stdout: EventEmitter;
}

/**
 * Build a fake `spawn` that emits `data` on stdout then exits with `code`.
 * If `signal` in the SpawnOptions is already aborted before resolution,
 * the process emits an 'error' (AbortError) instead.
 */
function makeFakeSpawn(stdout: string, exitCode: number) {
  return vi.fn((_cmd: string, _args: string[], opts?: Record<string, unknown>) => {
    const stdoutEmitter = new EventEmitter();
    const proc: FakeProc = Object.assign(new EventEmitter(), { stdout: stdoutEmitter });

    // Use setImmediate so the caller can attach listeners before events fire.
    setImmediate(() => {
      // If the signal was already aborted (test simulation), emit error.
      const signal = opts?.['signal'] as AbortSignal | undefined;
      if (signal?.aborted) {
        const err = Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
        });
        proc.emit('error', err);
        return;
      }
      proc.stdout.emit('data', Buffer.from(stdout));
      proc.emit('close', exitCode, null);
    });

    return proc;
  });
}

/**
 * Build a fake `spawn` that emits an AbortError immediately, simulating a
 * process kill via AbortController (timeout).
 */
function makeTimeoutSpawn() {
  return vi.fn(() => {
    const stdoutEmitter = new EventEmitter();
    const proc: FakeProc = Object.assign(new EventEmitter(), { stdout: stdoutEmitter });

    setImmediate(() => {
      const err = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        code: 'ABORT_ERR',
      });
      proc.emit('error', err);
    });

    return proc;
  });
}

/**
 * Build a fake `readFile` that maps path → string result or Error.
 *
 * Unknown paths resolve to an ENOENT error by default.
 */
function makeFakeReadFile(mapping: Record<string, string | Error>) {
  return vi.fn(async (filePath: unknown) => {
    const p = String(filePath);
    const result = mapping[p];
    if (result === undefined) {
      const err = Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), {
        code: 'ENOENT',
      });
      throw err;
    }
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }) as unknown as typeof import('node:fs/promises').readFile;
}

/** Serialise an envelope to JSON string. */
const envelopeJson = (o: typeof VALID_ENVELOPE) => JSON.stringify(o);

// ---------------------------------------------------------------------------
// envelope.ts tests
// ---------------------------------------------------------------------------

describe('decodeEnvelope', () => {
  it('happy path: returns typed OAuthCredentials', () => {
    const result = decodeEnvelope(VALID_ENVELOPE);
    expect(result).toEqual({
      accessToken: 'at-abc',
      refreshToken: 'rt-xyz',
      expiresAt: 9_999_999_999_000,
    });
  });

  it('throws InvalidEnvelopeError when top-level is not an object (null)', () => {
    expect(() => decodeEnvelope(null)).toThrow(InvalidEnvelopeError);
    expect(() => decodeEnvelope(null)).toThrow('claudeAiOauth');
  });

  it('throws InvalidEnvelopeError when top-level is not an object (string)', () => {
    expect(() => decodeEnvelope('{"claudeAiOauth":{}}')).toThrow(InvalidEnvelopeError);
  });

  it('throws InvalidEnvelopeError when top-level is an array', () => {
    expect(() => decodeEnvelope([])).toThrow(InvalidEnvelopeError);
    expect(() => decodeEnvelope([])).toThrow('claudeAiOauth');
  });

  it('throws InvalidEnvelopeError(claudeAiOauth) when claudeAiOauth is missing', () => {
    const err = (() => {
      try {
        decodeEnvelope({});
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InvalidEnvelopeError);
    expect((err as InvalidEnvelopeError).missingField).toBe('claudeAiOauth');
  });

  it('throws InvalidEnvelopeError(claudeAiOauth) when claudeAiOauth is not an object', () => {
    const err = (() => {
      try {
        decodeEnvelope({ claudeAiOauth: 'oops' });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InvalidEnvelopeError);
    expect((err as InvalidEnvelopeError).missingField).toBe('claudeAiOauth');
  });

  it('throws InvalidEnvelopeError(accessToken) when accessToken is missing', () => {
    const input = { claudeAiOauth: { refreshToken: 'r', expiresAt: 1 } };
    const err = (() => {
      try {
        decodeEnvelope(input);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InvalidEnvelopeError);
    expect((err as InvalidEnvelopeError).missingField).toBe('accessToken');
  });

  it('throws InvalidEnvelopeError(refreshToken) when refreshToken is missing', () => {
    const input = { claudeAiOauth: { accessToken: 'a', expiresAt: 1 } };
    const err = (() => {
      try {
        decodeEnvelope(input);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InvalidEnvelopeError);
    expect((err as InvalidEnvelopeError).missingField).toBe('refreshToken');
  });

  it('throws InvalidEnvelopeError(expiresAt) when expiresAt is missing', () => {
    const input = { claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } };
    const err = (() => {
      try {
        decodeEnvelope(input);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InvalidEnvelopeError);
    expect((err as InvalidEnvelopeError).missingField).toBe('expiresAt');
  });

  it('throws InvalidEnvelopeError(accessToken) when accessToken is an empty string', () => {
    const input = { claudeAiOauth: { accessToken: '', refreshToken: 'r', expiresAt: 1 } };
    const err = (() => {
      try {
        decodeEnvelope(input);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InvalidEnvelopeError);
    expect((err as InvalidEnvelopeError).missingField).toBe('accessToken');
  });

  it('throws InvalidEnvelopeError(refreshToken) when refreshToken is an empty string', () => {
    const input = { claudeAiOauth: { accessToken: 'a', refreshToken: '', expiresAt: 1 } };
    const err = (() => {
      try {
        decodeEnvelope(input);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InvalidEnvelopeError);
    expect((err as InvalidEnvelopeError).missingField).toBe('refreshToken');
  });

  it('throws InvalidEnvelopeError(expiresAt) when expiresAt is a string', () => {
    const input = { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 'soon' } };
    const err = (() => {
      try {
        decodeEnvelope(input);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InvalidEnvelopeError);
    expect((err as InvalidEnvelopeError).missingField).toBe('expiresAt');
  });

  it('throws InvalidEnvelopeError(expiresAt) when expiresAt is Infinity', () => {
    const input = { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Infinity } };
    const err = (() => {
      try {
        decodeEnvelope(input);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InvalidEnvelopeError);
    expect((err as InvalidEnvelopeError).missingField).toBe('expiresAt');
  });

  it('hygiene: error message does NOT contain token values (ADV-003)', () => {
    const secretToken = 'sk-ant-very-secret-token';
    const input = {
      claudeAiOauth: {
        accessToken: secretToken,
        // refreshToken absent → triggers error on next field after accessToken validates
        expiresAt: 12345,
      },
    };
    let errorMessage = '';
    try {
      decodeEnvelope(input);
    } catch (e) {
      errorMessage = (e as Error).message;
    }
    expect(errorMessage).not.toContain(secretToken);
    expect(errorMessage).toContain('refreshToken');
  });

  it('hygiene: error message for claudeAiOauth does not contain any object contents', () => {
    const secretAccessToken = 'sk-ant-very-secret-token';
    // claudeAiOauth present but set to a string (not object) — error on claudeAiOauth field
    const input = { claudeAiOauth: secretAccessToken };
    let errorMessage = '';
    try {
      decodeEnvelope(input);
    } catch (e) {
      errorMessage = (e as Error).message;
    }
    expect(errorMessage).not.toContain(secretAccessToken);
    expect(errorMessage).toContain('claudeAiOauth');
  });
});

// ---------------------------------------------------------------------------
// discover.ts tests
// ---------------------------------------------------------------------------

describe('discover', () => {
  const HOME = join('fake', 'home');
  const dotCredPath = join(HOME, '.claude', '.credentials.json');
  const credPath = join(HOME, '.claude', 'credentials.json');

  // ── Happy paths ────────────────────────────────────────────────────────

  it('happy macOS keychain: returns decoded credentials from spawn stdout', async () => {
    const spawnFn = makeFakeSpawn(envelopeJson(VALID_ENVELOPE), 0);
    const readFileFn = makeFakeReadFile({});

    const result = await discover({
      platformOverride: 'darwin',
      homedirOverride: HOME,
      spawnOverride: spawnFn as unknown as typeof import('node:child_process').spawn,
      readFileOverride: readFileFn,
    });

    expect(result).toEqual(VALID_ENVELOPE.claudeAiOauth);
    expect(spawnFn).toHaveBeenCalledOnce();
  });

  it('happy Linux file: returns credentials from .credentials.json without calling spawn', async () => {
    const spawnFn = makeFakeSpawn('', 0);
    const readFileFn = makeFakeReadFile({
      [dotCredPath]: envelopeJson(VALID_ENVELOPE),
    });

    const result = await discover({
      platformOverride: 'linux',
      homedirOverride: HOME,
      spawnOverride: spawnFn as unknown as typeof import('node:child_process').spawn,
      readFileOverride: readFileFn,
    });

    expect(result).toEqual(VALID_ENVELOPE.claudeAiOauth);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('happy Windows file: returns credentials from .credentials.json without calling spawn', async () => {
    const spawnFn = makeFakeSpawn('', 0);
    const readFileFn = makeFakeReadFile({
      [dotCredPath]: envelopeJson(VALID_ENVELOPE),
    });

    const result = await discover({
      platformOverride: 'win32',
      homedirOverride: HOME,
      spawnOverride: spawnFn as unknown as typeof import('node:child_process').spawn,
      readFileOverride: readFileFn,
    });

    expect(result).toEqual(VALID_ENVELOPE.claudeAiOauth);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('fallback: .credentials.json ENOENT → tries credentials.json and succeeds', async () => {
    const spawnFn = makeFakeSpawn('', 0);
    const readFileFn = makeFakeReadFile({
      // dotCredPath: not listed → ENOENT
      [credPath]: envelopeJson(VALID_ENVELOPE),
    });

    const result = await discover({
      platformOverride: 'linux',
      homedirOverride: HOME,
      spawnOverride: spawnFn as unknown as typeof import('node:child_process').spawn,
      readFileOverride: readFileFn,
    });

    expect(result).toEqual(VALID_ENVELOPE.claudeAiOauth);
  });

  // ── Fallback macOS keychain miss ────────────────────────────────────────

  it('macOS keychain non-zero exit falls through to file path', async () => {
    const spawnFn = makeFakeSpawn('', 44); // exit 44 = item not found
    const readFileFn = makeFakeReadFile({
      [dotCredPath]: envelopeJson(VALID_ENVELOPE),
    });

    const result = await discover({
      platformOverride: 'darwin',
      homedirOverride: HOME,
      spawnOverride: spawnFn as unknown as typeof import('node:child_process').spawn,
      readFileOverride: readFileFn,
    });

    expect(result).toEqual(VALID_ENVELOPE.claudeAiOauth);
  });

  it('macOS keychain miss + both files ENOENT → throws CredentialNotFoundError', async () => {
    const spawnFn = makeFakeSpawn('', 44);
    const readFileFn = makeFakeReadFile({}); // all ENOENT

    await expect(
      discover({
        platformOverride: 'darwin',
        homedirOverride: HOME,
        spawnOverride: spawnFn as unknown as typeof import('node:child_process').spawn,
        readFileOverride: readFileFn,
      }),
    ).rejects.toThrow(CredentialNotFoundError);
  });

  it('CredentialNotFoundError message includes keychain and both file paths', async () => {
    const spawnFn = makeFakeSpawn('', 44);
    const readFileFn = makeFakeReadFile({});

    let err: CredentialNotFoundError | undefined;
    try {
      await discover({
        platformOverride: 'darwin',
        homedirOverride: HOME,
        spawnOverride: spawnFn as unknown as typeof import('node:child_process').spawn,
        readFileOverride: readFileFn,
      });
    } catch (e) {
      err = e as CredentialNotFoundError;
    }

    expect(err).toBeInstanceOf(CredentialNotFoundError);
    expect(err!.message).toContain(dotCredPath);
    expect(err!.message).toContain(credPath);
    expect(err!.message).toContain('keychain');
    expect(err!.pathsTried).toHaveLength(3);
  });

  // ── Timeout ─────────────────────────────────────────────────────────────

  it('keychain timeout: spawn emits AbortError → falls through to file path', async () => {
    const spawnFn = makeTimeoutSpawn();
    const readFileFn = makeFakeReadFile({
      [dotCredPath]: envelopeJson(VALID_ENVELOPE),
    });

    const result = await discover({
      platformOverride: 'darwin',
      homedirOverride: HOME,
      spawnOverride: spawnFn as unknown as typeof import('node:child_process').spawn,
      readFileOverride: readFileFn,
    });

    expect(result).toEqual(VALID_ENVELOPE.claudeAiOauth);
  });

  // ── Malformed file errors (must NOT silently fall through) ──────────────

  it('malformed envelope in file throws (no silent fallthrough)', async () => {
    const spawnFn = makeFakeSpawn('', 44);
    const readFileFn = makeFakeReadFile({
      [dotCredPath]: JSON.stringify({ claudeAiOauth: {} }), // missing all fields
    });

    await expect(
      discover({
        platformOverride: 'darwin',
        homedirOverride: HOME,
        spawnOverride: spawnFn as unknown as typeof import('node:child_process').spawn,
        readFileOverride: readFileFn,
      }),
    ).rejects.toThrow(/invalid envelope/i);
  });

  it('file with missing refreshToken throws InvalidEnvelopeError (no silent fallthrough)', async () => {
    const badEnvelope = {
      claudeAiOauth: { accessToken: 'a', expiresAt: 1 }, // refreshToken absent
    };
    const spawnFn = makeFakeSpawn('', 44);
    const readFileFn = makeFakeReadFile({
      [dotCredPath]: JSON.stringify(badEnvelope),
    });

    const rejection = discover({
      platformOverride: 'darwin',
      homedirOverride: HOME,
      spawnOverride: spawnFn as unknown as typeof import('node:child_process').spawn,
      readFileOverride: readFileFn,
    });

    await expect(rejection).rejects.toThrow(/refreshToken/);
    await expect(rejection).rejects.not.toBeInstanceOf(CredentialNotFoundError);
  });

  it('file with invalid JSON throws (no silent fallthrough)', async () => {
    const spawnFn = makeFakeSpawn('', 44);
    const readFileFn = makeFakeReadFile({
      [dotCredPath]: '{ not json',
    });

    await expect(
      discover({
        platformOverride: 'darwin',
        homedirOverride: HOME,
        spawnOverride: spawnFn as unknown as typeof import('node:child_process').spawn,
        readFileOverride: readFileFn,
      }),
    ).rejects.toThrow(/invalid JSON/i);
  });

  // ── EACCES ─────────────────────────────────────────────────────────────

  it('EACCES on file surfaces typed error naming the path', async () => {
    const spawnFn = makeFakeSpawn('', 44);
    const eacces = Object.assign(new Error(`EACCES: permission denied, open '${dotCredPath}'`), {
      code: 'EACCES',
    });
    const readFileFn = makeFakeReadFile({
      [dotCredPath]: eacces,
    });

    const rejection = discover({
      platformOverride: 'linux',
      homedirOverride: HOME,
      spawnOverride: spawnFn as unknown as typeof import('node:child_process').spawn,
      readFileOverride: readFileFn,
    });

    await expect(rejection).rejects.toThrow(/permission denied/i);
    await expect(rejection).rejects.toThrow(dotCredPath);
  });

  // ── No shell expansion ──────────────────────────────────────────────────

  it('spawn is called without shell:true and with correct argv', async () => {
    const spawnFn = makeFakeSpawn(envelopeJson(VALID_ENVELOPE), 0);
    const readFileFn = makeFakeReadFile({});

    await discover({
      platformOverride: 'darwin',
      homedirOverride: HOME,
      spawnOverride: spawnFn as unknown as typeof import('node:child_process').spawn,
      readFileOverride: readFileFn,
    });

    expect(spawnFn).toHaveBeenCalledOnce();
    const [cmd, args, opts] = spawnFn.mock.calls[0]!;
    expect(cmd).toBe('security');
    expect(args[0]).toBe('find-generic-password');
    expect(args[1]).toBe('-s');
    expect(args[2]).toBe('Claude Code-credentials');
    expect(args[3]).toBe('-w');
    // shell must be absent, false, or undefined — never true.
    expect((opts as Record<string, unknown>)?.['shell']).not.toBe(true);
  });

  // ── Hygiene: CredentialNotFoundError message ────────────────────────────

  it('CredentialNotFoundError contains paths but no token-shaped data', async () => {
    const spawnFn = makeFakeSpawn('', 44);
    const readFileFn = makeFakeReadFile({});

    let err: CredentialNotFoundError | undefined;
    try {
      await discover({
        platformOverride: 'darwin',
        homedirOverride: HOME,
        spawnOverride: spawnFn as unknown as typeof import('node:child_process').spawn,
        readFileOverride: readFileFn,
      });
    } catch (e) {
      err = e as CredentialNotFoundError;
    }

    expect(err).toBeInstanceOf(CredentialNotFoundError);
    // Message must NOT contain anything that looks like a token value.
    expect(err!.message).not.toMatch(/claudeAiOauth\s*:/);
    // Must contain path indicators.
    expect(err!.message).toContain('.claude');
  });

  // ── Cross-platform round-trip ───────────────────────────────────────────

  it('same envelope JSON round-trips through macOS spawn path and Linux file path', async () => {
    const jsonStr = envelopeJson(VALID_ENVELOPE);

    // macOS via spawn.
    const darwinResult = await discover({
      platformOverride: 'darwin',
      homedirOverride: HOME,
      spawnOverride: makeFakeSpawn(jsonStr, 0) as unknown as typeof import('node:child_process').spawn,
      readFileOverride: makeFakeReadFile({}),
    });

    // Linux via file.
    const linuxResult = await discover({
      platformOverride: 'linux',
      homedirOverride: HOME,
      spawnOverride: makeFakeSpawn('', 0) as unknown as typeof import('node:child_process').spawn,
      readFileOverride: makeFakeReadFile({ [dotCredPath]: jsonStr }),
    });

    expect(darwinResult).toEqual(linuxResult);
    expect(darwinResult).toEqual(VALID_ENVELOPE.claudeAiOauth);
  });
});
