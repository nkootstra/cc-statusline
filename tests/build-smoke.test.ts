import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  it('exports the CLI binary from package.json', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'),
    ) as {
      bin: Record<string, string | undefined>;
    };
    const binary = pkg.bin['cc-statusline'];
    if (binary === undefined) {
      throw new Error('Expected package.json bin.cc-statusline to be defined.');
    }
    expect(binary).toBe('bin/cc-statusline.js');
    expect(existsSync(resolve(__dirname, '..', binary))).toBe(true);
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
    expect(result.stdout).toContain('Pro and Max use the same renderer');
  });

  it('prints the package version on --version', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    const result = spawnSync(process.execPath, [BUNDLE, '--version'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it('runs init directly with --plan pro --force', () => {
    const home = mkdtempSync(resolve(tmpdir(), 'cc-statusline-npx-'));
    const claudeDir = resolve(home, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const result = spawnSync(
      process.execPath,
      [BUNDLE, '--plan', 'pro', '--force'],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeDir },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Pro/Max statusline installed');

    const settings = JSON.parse(readFileSync(resolve(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine.command).toContain('render-promax');
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
