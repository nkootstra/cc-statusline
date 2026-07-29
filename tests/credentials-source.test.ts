import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  canonicalizeFileCredentialSource,
  loadCredentialSource,
} from '../src/credentials/source';

function envelope(accessToken: string, refreshToken: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt: 9_999_999_999_000,
    },
  });
}

describe('loadCredentialSource', () => {
  it('rediscovers Claude Code credentials on every load', async () => {
    const values = [
      envelope('access-one', 'refresh-one'),
      envelope('access-two', 'refresh-two'),
    ];
    const readFileOverride = vi.fn(async () => values.shift()!);
    const options = {
      platformOverride: 'linux' as const,
      homedirOverride: '/fake/home',
      claudeConfigDirOverride: '/fake/config',
      readFileOverride:
        readFileOverride as unknown as typeof import('node:fs/promises').readFile,
    };

    const first = await loadCredentialSource({ kind: 'claude-code' }, options);
    const second = await loadCredentialSource({ kind: 'claude-code' }, options);

    expect(first.accessToken).toBe('access-one');
    expect(second.accessToken).toBe('access-two');
    expect(readFileOverride).toHaveBeenCalledTimes(2);
  });

  it('canonicalizes an in-home regular file and loads its credentials', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-statusline-source-'));
    const home = path.join(tmpDir, 'home');
    const credentialsPath = path.join(home, 'credentials.json');
    fs.mkdirSync(home);
    fs.writeFileSync(credentialsPath, envelope('file-access', 'file-refresh'));

    try {
      const source = await canonicalizeFileCredentialSource(credentialsPath, {
        homedirOverride: home,
      });
      const credentials = await loadCredentialSource(source, {
        homedirOverride: home,
      });

      expect(source).toEqual({
        kind: 'file',
        path: fs.realpathSync(credentialsPath),
      });
      expect(credentials).toEqual({
        accessToken: 'file-access',
        refreshToken: 'file-refresh',
        expiresAt: 9_999_999_999_000,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects a file source that resolves outside home on a later load', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-statusline-source-'));
    const home = path.join(tmpDir, 'home');
    const credentialsPath = path.join(home, 'credentials.json');
    const outsidePath = path.join(tmpDir, 'outside.json');
    fs.mkdirSync(home);
    fs.writeFileSync(credentialsPath, envelope('initial-access', 'initial-refresh'));
    fs.writeFileSync(outsidePath, envelope('outside-access', 'outside-refresh'));

    try {
      const source = await canonicalizeFileCredentialSource(credentialsPath, {
        homedirOverride: home,
      });
      fs.unlinkSync(credentialsPath);
      fs.symlinkSync(outsidePath, credentialsPath);

      await expect(
        loadCredentialSource(source, { homedirOverride: home }),
      ).rejects.toThrow(/outside home directory/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects a file source that is no longer a regular file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-statusline-source-'));
    const home = path.join(tmpDir, 'home');
    const credentialsPath = path.join(home, 'credentials.json');
    fs.mkdirSync(home);
    fs.writeFileSync(credentialsPath, envelope('initial-access', 'initial-refresh'));

    try {
      const source = await canonicalizeFileCredentialSource(credentialsPath, {
        homedirOverride: home,
      });
      fs.unlinkSync(credentialsPath);
      fs.mkdirSync(credentialsPath);

      await expect(
        loadCredentialSource(source, { homedirOverride: home }),
      ).rejects.toThrow(/not a regular file/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
