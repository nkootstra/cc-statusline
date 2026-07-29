import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';
import { vi } from 'vitest';
import { writeCache, type Cache } from '../../src/cache/store';
import type { UsageResponse } from '../../src/oauth/types';
import { runRenderEnterprise } from '../../src/subcommands/render-enterprise';

const FIXTURES = resolve(__dirname, '..', 'fixtures');

export interface SpawnCall {
  command: string;
  args: string[];
  opts: SpawnOptions;
}

export const GOLDEN_STDIN = JSON.stringify({
  session_id: 'golden',
  transcript_path: '/t',
  cwd: '/c',
  model: { id: 'claude-opus-4-7', display_name: 'Opus 4.7' },
  workspace: { current_dir: '/c', project_dir: '/c' },
  version: '1',
  output_style: { name: 'default' },
  cost: {
    total_cost_usd: 0,
    total_duration_ms: 0,
    total_api_duration_ms: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  },
  exceeds_200k_tokens: false,
  context_window: { used_percentage: null },
});

export function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), 'utf8');
}

export function makeStream(content: string): Readable {
  return Readable.from([content]);
}

export function makeCache(overrides: Partial<Cache> = {}): Cache {
  return {
    schemaVersion: 4,
    authState: 'ok',
    credentials: {
      accessToken: 'tok',
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

export function makeCacheWithUsage(
  usageOverrides: Partial<UsageResponse> = {},
  cacheOverrides: Partial<Cache> = {},
): Cache {
  const baseUsage = JSON.parse(
    loadFixture('usage-response.json'),
  ) as UsageResponse;
  return makeCache({
    usage: { ...baseUsage, ...usageOverrides },
    ...cacheOverrides,
  });
}

export async function captureStdout(
  fn: () => Promise<number>,
): Promise<{ output: string; exitCode: number }> {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      void rest;
      if (typeof chunk === 'string') {
        chunks.push(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk.toString('utf8'));
      }
      return true;
    });

  try {
    const exitCode = await fn();
    return { output: chunks.join(''), exitCode };
  } finally {
    spy.mockRestore();
  }
}

export function setTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    value,
    writable: true,
    configurable: true,
  });
}

export async function runWithCache(
  cache: Cache | null,
  stdinContent: string,
  extra: {
    now?: () => number;
    bundlePath?: string;
    platformOverride?: NodeJS.Platform;
  } = {},
): Promise<{
  output: string;
  exitCode: number;
  spawnCalls: SpawnCall[];
}> {
  const calls: SpawnCall[] = [];
  const tempDir = mkdtempSync(join(tmpdir(), 'cc-statusline-render-'));
  const cachePath = join(tempDir, 'cache.json');
  if (cache !== null) {
    await writeCache(cache, cachePath);
  }

  try {
    const { output, exitCode } = await captureStdout(() =>
      runRenderEnterprise(
        [],
        makeStream(stdinContent),
        {
          cachePath,
          bundlePath: extra.bundlePath ?? '/bundle.js',
          now: extra.now ?? (() => Date.now()),
          platformOverride: extra.platformOverride,
          spawnRefresh: (command, args, opts) => {
            calls.push({ command, args, opts });
          },
        },
      ),
    );
    return { output, exitCode, spawnCalls: calls };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
