import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const BUNDLE = resolve(__dirname, '..', 'dist', 'cli.cjs');
const CLI_SOURCE = resolve(__dirname, '..', 'src', 'cli.ts');

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
    expect(result.stdout).toContain('One renderer picks the layout');
    expect(result.stdout).toContain('cc-statusline render ');
    expect(result.stdout).not.toContain('--plan');
    expect(result.stdout.match(/--non-interactive/g)).toHaveLength(2);
    expect(result.stdout).toContain('background credential + usage refresh');
    expect(result.stdout).not.toContain('background token + usage refresh');
  });

  it('source help documents non-interactive init and background credential refresh', () => {
    const source = readFileSync(CLI_SOURCE, 'utf8');
    const help = source.match(/const HELP = `([\s\S]*?)`;/)?.[1];

    expect(help).toBeDefined();
    expect(help?.match(/--non-interactive/g)).toHaveLength(2);
    expect(help).toContain('background credential + usage refresh');
    expect(help).not.toContain('background token + usage refresh');
  });

  it('prints the package version on --version', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    const result = spawnSync(process.execPath, [BUNDLE, '--version'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  // A foreign statusline makes init stop at the conflict check, before
  // credential discovery could reach the keychain or the network.
  it('runs init directly and ignores --plan with a notice', () => {
    const home = mkdtempSync(resolve(tmpdir(), 'cc-statusline-npx-'));
    const claudeDir = resolve(home, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      resolve(claudeDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: '/other/statusline' } }),
    );

    const result = spawnSync(
      process.execPath,
      [BUNDLE, '--plan', 'pro'],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeDir },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('init: --plan is no longer needed and is ignored');
    const settings = JSON.parse(readFileSync(resolve(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine.command).toBe('/other/statusline');
  });

  it('renders the same output for render and its legacy aliases', () => {
    const home = mkdtempSync(resolve(tmpdir(), 'cc-statusline-alias-'));
    const claudeDir = resolve(home, '.claude');
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      model: { id: 'claude-opus-4-7', display_name: 'Opus 4.7' },
      cost: { total_cost_usd: 0 },
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: nowSec + 3_600 },
        seven_day: { used_percentage: 20, resets_at: nowSec + 7_200 },
      },
    });
    const outputs = [
      ['render'],
      ['render-promax'],
      ['render-enterprise'],
      ['render', '--payload-only'],
    ].map((argv) => {
      const result = spawnSync(process.execPath, [BUNDLE, ...argv], {
        encoding: 'utf8',
        input: payload,
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeDir },
      });
      expect(result.status).toBe(0);
      return result.stdout;
    });

    expect(outputs[0]).toContain('Opus 4.7');
    expect(new Set(outputs).size).toBe(1);
  });

  it('exits non-zero on unknown subcommand', () => {
    const result = spawnSync(process.execPath, [BUNDLE, 'totally-not-a-command'], {
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unknown command');
  });

  it.each([
    [['render-promax']],
    [['render']],
  ])('cold-starts within the platform threshold on the render path (%j)', (argv) => {
    const home = mkdtempSync(resolve(tmpdir(), 'cc-statusline-render-'));
    const claudeDir = resolve(home, '.claude');
    const threshold = process.platform === 'win32' ? 250 : 150;
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      model: { id: 'claude-opus-4-7', display_name: 'Opus 4.7' },
      cost: { total_cost_usd: 0 },
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: nowSec + 3_600 },
        seven_day: { used_percentage: 20, resets_at: nowSec + 7_200 },
      },
    });
    const samples = Array.from({ length: 3 }, () => {
      const start = process.hrtime.bigint();
      const result = spawnSync(process.execPath, [BUNDLE, ...argv], {
        encoding: 'utf8',
        input: payload,
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeDir },
      });
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Opus 4.7');
      return elapsedMs;
    });
    const fastest = Math.min(...samples);
    const measurements = samples.map((sample) => `${sample.toFixed(0)}ms`).join(', ');

    expect(
      fastest,
      `cold-start samples [${measurements}] all exceeded ${threshold}ms on ${process.platform}`,
    ).toBeLessThanOrEqual(threshold);
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
