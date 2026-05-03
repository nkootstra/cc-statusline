import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BUNDLE = resolve(__dirname, '..', 'dist', 'cli.cjs');

describe('build smoke', () => {
  beforeAll(() => {
    if (!existsSync(BUNDLE)) {
      throw new Error(
        `Bundle not found at ${BUNDLE}. Run \`npm run build\` before \`npm test\`, or expect this single test to fail in dev.`,
      );
    }
  });

  it('starts with the shebang', () => {
    const firstLine = readFileSync(BUNDLE, 'utf8').split('\n', 1)[0];
    expect(firstLine).toBe('#!/usr/bin/env node');
  });

  it('exits 0 with no args (prints help)', () => {
    const result = spawnSync(process.execPath, [BUNDLE], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('cc-statusline');
    expect(result.stdout).toContain('init');
  });

  it('exits 0 on --help', () => {
    const result = spawnSync(process.execPath, [BUNDLE, '--help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });

  it('exits non-zero on unknown subcommand', () => {
    const result = spawnSync(process.execPath, [BUNDLE, 'totally-not-a-command'], {
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unknown command');
  });

  it('cold-starts within the platform threshold', () => {
    const threshold = process.platform === 'win32' ? 250 : 150;
    const start = process.hrtime.bigint();
    const result = spawnSync(process.execPath, [BUNDLE], { encoding: 'utf8' });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    expect(result.status).toBe(0);
    expect(elapsedMs, `cold start ${elapsedMs.toFixed(0)}ms exceeded ${threshold}ms on ${process.platform}`).toBeLessThanOrEqual(threshold);
  });

  it('bundles without external dependency requires (single-file CJS)', () => {
    const source = readFileSync(BUNDLE, 'utf8');
    const requireMatches = source.match(/require\(["']([^"']+)["']\)/g) ?? [];
    const builtins = new Set([
      ...builtinModules,
      ...builtinModules.map((mod) => `node:${mod}`),
    ]);
    const externalRequires = requireMatches.filter((m) => {
      const mod = m.slice(9, -2);
      return !builtins.has(mod);
    });
    expect(externalRequires).toEqual([]);
  });
});
