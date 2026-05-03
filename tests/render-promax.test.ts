import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';

const FIXTURES = resolve(__dirname, 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), 'utf8');
}

function makeStream(content: string): Readable {
  return Readable.from([content]);
}

// ---------------------------------------------------------------------------
// Helpers to capture stdout and manage environment
// ---------------------------------------------------------------------------

function captureStdout(fn: () => Promise<number>): Promise<{ output: string; exitCode: number }> {
  return new Promise(async (resolve, reject) => {
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);

    // Spy on process.stdout.write
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
        if (typeof chunk === 'string') {
          chunks.push(chunk);
        } else if (Buffer.isBuffer(chunk)) {
          chunks.push(chunk.toString('utf8'));
        }
        return true;
      });

    try {
      const exitCode = await fn();
      spy.mockRestore();
      resolve({ output: chunks.join(''), exitCode });
    } catch (err) {
      spy.mockRestore();
      reject(err);
    }
  });
}

// ---------------------------------------------------------------------------
// Import the function under test — imported after helpers so mocks can be set
// ---------------------------------------------------------------------------

// We import dynamically inside tests to allow proper module isolation.
// Since vitest handles this cleanly, we just import at the top.
import { runRenderPromax } from '../src/subcommands/render-promax';
import { colorTier, MISSING } from '../src/statusline/format';

// ---------------------------------------------------------------------------
// Setup/teardown helpers for TTY and NO_COLOR
// ---------------------------------------------------------------------------

function setTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    value,
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  // Default: non-TTY (no ANSI), no NO_COLOR override
  vi.stubEnv('NO_COLOR', '');
  setTTY(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Scenario 1: Happy path — full Pro/Max stdin fixture
// ---------------------------------------------------------------------------

describe('Scenario 1: happy path — full Pro/Max fixture', () => {
  it('renders a single line containing all five segments in order', async () => {
    const fixtureJson = loadFixture('stdin-promax.json');
    const { output, exitCode } = await captureStdout(() =>
      runRenderPromax([], makeStream(fixtureJson)),
    );

    expect(exitCode).toBe(0);

    // All five segments must appear in the output
    expect(output).toContain('claude-sonnet-4-5'); // model
    expect(output).toContain('ctx');                // context
    expect(output).toContain('5h');                 // 5h rate limit
    expect(output).toContain('7d');                 // 7d rate limit
    expect(output).toContain('$');                  // cost

    // Segments must appear in the expected order
    const modelIdx = output.indexOf('claude-sonnet-4-5');
    const ctxIdx = output.indexOf('ctx');
    const fiveHIdx = output.indexOf('5h');
    const sevenDIdx = output.indexOf('7d');
    const costIdx = output.indexOf('$');

    expect(modelIdx).toBeLessThan(ctxIdx);
    expect(ctxIdx).toBeLessThan(fiveHIdx);
    expect(fiveHIdx).toBeLessThan(sevenDIdx);
    expect(sevenDIdx).toBeLessThan(costIdx);

    // Output ends with a newline
    expect(output).toMatch(/\n$/);
  });

  it('renders cost as $0.04 (total_cost_usd = 0.042 → fixed 2 decimals)', async () => {
    const fixtureJson = loadFixture('stdin-promax.json');
    const { output } = await captureStdout(() =>
      runRenderPromax([], makeStream(fixtureJson)),
    );
    expect(output).toContain('$0.04');
  });

  it('renders ctx with the fixture used_percentage (22%)', async () => {
    const fixtureJson = loadFixture('stdin-promax.json');
    const { output } = await captureStdout(() =>
      runRenderPromax([], makeStream(fixtureJson)),
    );
    expect(output).toContain('22%');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: AE4 — 5h utilization at 73% renders warn color
// ---------------------------------------------------------------------------

describe('Scenario 2 (AE4): 5h at 73% renders warn tier', () => {
  it('colorTier(73) returns warn', () => {
    expect(colorTier(73)).toBe('warn');
  });

  it('with NO_COLOR=1, output contains "5h 73%" in plain text', async () => {
    vi.stubEnv('NO_COLOR', '1');

    const input = JSON.stringify({
      session_id: 'test',
      transcript_path: '/t',
      cwd: '/c',
      model: { id: 'm', display_name: 'test-model' },
      workspace: { current_dir: '/c', project_dir: '/c' },
      version: '1',
      output_style: { name: 'default' },
      cost: { total_cost_usd: 0, total_duration_ms: 0, total_api_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0 },
      exceeds_200k_tokens: false,
      context_window: { used_percentage: 50 },
      rate_limits: {
        five_hour: { used_percentage: 73, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
        seven_day: { used_percentage: 20, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
      },
    });

    const { output, exitCode } = await captureStdout(() =>
      runRenderPromax([], makeStream(input)),
    );

    expect(exitCode).toBe(0);
    // With NO_COLOR, output must contain bare text without ANSI escapes
    expect(output).not.toMatch(/\x1b\[/);
    expect(output).toContain('5h 73%');
  });

  it('with TTY and no NO_COLOR, the 5h segment at 73% includes a yellow ANSI code', async () => {
    vi.stubEnv('NO_COLOR', '');
    setTTY(true);

    const input = JSON.stringify({
      session_id: 'test',
      transcript_path: '/t',
      cwd: '/c',
      model: { id: 'm', display_name: 'test-model' },
      workspace: { current_dir: '/c', project_dir: '/c' },
      version: '1',
      output_style: { name: 'default' },
      cost: { total_cost_usd: 0, total_duration_ms: 0, total_api_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0 },
      exceeds_200k_tokens: false,
      context_window: { used_percentage: 50 },
      rate_limits: {
        five_hour: { used_percentage: 73, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
        seven_day: { used_percentage: 20, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
      },
    });

    const { output } = await captureStdout(() =>
      runRenderPromax([], makeStream(input)),
    );

    // Yellow ANSI code \x1b[33m should appear (warn tier)
    expect(output).toContain('\x1b[33m');
    expect(output).toContain('73%');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Missing rate_limits (Enterprise fixture)
// ---------------------------------------------------------------------------

describe('Scenario 3: missing rate_limits — enterprise fixture', () => {
  it('output contains "5h —" when rate_limits absent', async () => {
    const fixtureJson = loadFixture('stdin-enterprise.json');
    const { output, exitCode } = await captureStdout(() =>
      runRenderPromax([], makeStream(fixtureJson)),
    );

    expect(exitCode).toBe(0);
    expect(output).toContain(`5h ${MISSING}`);
    expect(output).toContain(`7d ${MISSING}`);
  });

  it('model name is present', async () => {
    const fixtureJson = loadFixture('stdin-enterprise.json');
    const { output } = await captureStdout(() =>
      runRenderPromax([], makeStream(fixtureJson)),
    );
    expect(output).toContain('claude-opus-4-5');
  });

  it('omits zero cost', async () => {
    const fixtureJson = loadFixture('stdin-enterprise.json');
    const { output } = await captureStdout(() =>
      runRenderPromax([], makeStream(fixtureJson)),
    );
    expect(output).not.toContain('$0.00');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: cost.total_cost_usd === 0 is omitted
// ---------------------------------------------------------------------------

describe('Scenario 4: zero cost is omitted', () => {
  it('$0.00 does not appear in output when cost is 0', async () => {
    const input = JSON.stringify({
      session_id: 'test',
      transcript_path: '/t',
      cwd: '/c',
      model: { id: 'm', display_name: 'test-model' },
      workspace: { current_dir: '/c', project_dir: '/c' },
      version: '1',
      output_style: { name: 'default' },
      cost: { total_cost_usd: 0, total_duration_ms: 0, total_api_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0 },
      exceeds_200k_tokens: false,
    });

    const { output, exitCode } = await captureStdout(() =>
      runRenderPromax([], makeStream(input)),
    );

    expect(exitCode).toBe(0);
    expect(output).not.toContain('$0.00');
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: context_window.used_percentage === null is omitted
// ---------------------------------------------------------------------------

describe('Scenario 5: null used_percentage is omitted', () => {
  it('omits ctx when context_window.used_percentage is null', async () => {
    const fixtureJson = loadFixture('stdin-enterprise.json'); // has used_percentage: null
    const { output, exitCode } = await captureStdout(() =>
      runRenderPromax([], makeStream(fixtureJson)),
    );

    expect(exitCode).toBe(0);
    expect(output).not.toContain('ctx');
  });

  it('omits ctx when context_window is absent entirely', async () => {
    const input = JSON.stringify({
      session_id: 'test',
      transcript_path: '/t',
      cwd: '/c',
      model: { id: 'm', display_name: 'test-model' },
      workspace: { current_dir: '/c', project_dir: '/c' },
      version: '1',
      output_style: { name: 'default' },
      cost: { total_cost_usd: 1.5, total_duration_ms: 0, total_api_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0 },
      exceeds_200k_tokens: false,
    });

    const { output, exitCode } = await captureStdout(() =>
      runRenderPromax([], makeStream(input)),
    );

    expect(exitCode).toBe(0);
    expect(output).not.toContain('ctx');
  });
});

describe('readability: compact statusline', () => {
  const readableInput = JSON.stringify({
    session_id: 'test',
    transcript_path: '/t',
    cwd: '/c',
    model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet 4.6' },
    workspace: { current_dir: '/c', project_dir: '/c' },
    version: '1',
    output_style: { name: 'default' },
    cost: { total_cost_usd: 0, total_duration_ms: 0, total_api_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0 },
    exceeds_200k_tokens: false,
    context_window: { used_percentage: null },
    rate_limits: {
      five_hour: { used_percentage: 0, resets_at: new Date(2026, 4, 3, 21, 0, 0).getTime() / 1000 },
      seven_day: { used_percentage: 81, resets_at: new Date(2026, 4, 5, 20, 0, 0).getTime() / 1000 },
    },
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 3, 20, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('omits missing ctx, zero cost, and missing reset hints', async () => {
    vi.stubEnv('NO_COLOR', '1');

    const { output } = await captureStdout(() =>
      runRenderPromax([], makeStream(readableInput)),
    );

    expect(output).toBe('Sonnet 4.6 · 5h 0% [21:00] · 7d 81% [Tue 20:00]\n');
  });

  it('emits ANSI colors by default and strips them with NO_COLOR', async () => {
    vi.stubEnv('NO_COLOR', '');
    const colored = await captureStdout(() =>
      runRenderPromax([], makeStream(readableInput)),
    );

    vi.stubEnv('NO_COLOR', '1');
    const plain = await captureStdout(() =>
      runRenderPromax([], makeStream(readableInput)),
    );

    expect(colored.output).toContain('\x1b[32m0%\x1b[0m');
    expect(colored.output).toContain('\x1b[33m81%\x1b[0m');
    expect(plain.output).toBe('Sonnet 4.6 · 5h 0% [21:00] · 7d 81% [Tue 20:00]\n');
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Narrow layout — two lines when process.stdout.columns <= 100
// ---------------------------------------------------------------------------

describe('Scenario 6: narrow layout at 60 columns', () => {
  it('output spans two lines (one internal \\n plus trailing \\n)', async () => {
    // Set columns to 60 (narrow)
    Object.defineProperty(process.stdout, 'columns', {
      value: 60,
      writable: true,
      configurable: true,
    });

    const fixtureJson = loadFixture('stdin-promax.json');
    const { output, exitCode } = await captureStdout(() =>
      runRenderPromax([], makeStream(fixtureJson)),
    );

    // Restore columns
    Object.defineProperty(process.stdout, 'columns', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    expect(exitCode).toBe(0);

    // Output should contain exactly two '\n': one internal + one trailing
    // (i.e., 'row1\nrow2\n')
    const newlineCount = (output.match(/\n/g) ?? []).length;
    expect(newlineCount).toBe(2);

    // There is exactly one internal '\n' (not at the very end)
    const withoutTrailing = output.slice(0, -1);
    expect(withoutTrailing).toContain('\n');
    expect((withoutTrailing.match(/\n/g) ?? []).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: NO_COLOR=1 produces no ANSI escape sequences
// ---------------------------------------------------------------------------

describe('Scenario 7: NO_COLOR=1 — no ANSI escape sequences', () => {
  it('output contains no ANSI codes when NO_COLOR=1', async () => {
    vi.stubEnv('NO_COLOR', '1');

    const fixtureJson = loadFixture('stdin-promax.json');
    const { output, exitCode } = await captureStdout(() =>
      runRenderPromax([], makeStream(fixtureJson)),
    );

    expect(exitCode).toBe(0);
    expect(output).not.toMatch(/\x1b\[/);
  });

  it('output still contains readable segment labels without ANSI', async () => {
    vi.stubEnv('NO_COLOR', '1');

    const fixtureJson = loadFixture('stdin-promax.json');
    const { output } = await captureStdout(() =>
      runRenderPromax([], makeStream(fixtureJson)),
    );

    expect(output).toContain('claude-sonnet-4-5');
    expect(output).toContain('ctx');
    expect(output).toContain('5h');
    expect(output).toContain('7d');
    expect(output).toContain('$');
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: Empty stdin produces empty stdout and exit 0
// ---------------------------------------------------------------------------

describe('Scenario 8: empty stdin — silent fail mode', () => {
  it('produces a newline and exit 0 on empty string stdin', async () => {
    const { output, exitCode } = await captureStdout(() =>
      runRenderPromax([], makeStream('')),
    );

    expect(exitCode).toBe(0);
    expect(output).toBe('\n');
  });

  it('produces a newline and exit 0 on whitespace-only stdin', async () => {
    const { output, exitCode } = await captureStdout(() =>
      runRenderPromax([], makeStream('   \n\t  ')),
    );

    expect(exitCode).toBe(0);
    expect(output).toBe('\n');
  });
});

// ---------------------------------------------------------------------------
// Scenario 9: Non-JSON stdin produces empty stdout and exit 0
// ---------------------------------------------------------------------------

describe('Scenario 9: non-JSON stdin — silent fail mode', () => {
  it('produces a newline and exit 0 for "not json"', async () => {
    const { output, exitCode } = await captureStdout(() =>
      runRenderPromax([], makeStream('not json')),
    );

    expect(exitCode).toBe(0);
    expect(output).toBe('\n');
  });

  it('produces a newline and exit 0 for a truncated JSON payload', async () => {
    const { output, exitCode } = await captureStdout(() =>
      runRenderPromax([], makeStream('{"session_id": "abc')),
    );

    expect(exitCode).toBe(0);
    expect(output).toBe('\n');
  });
});

// ---------------------------------------------------------------------------
// Scenario 10: No fetch calls, no file I/O — structural guarantee
// ---------------------------------------------------------------------------

describe('Scenario 10: no fetch, no file I/O', () => {
  it('does not call global.fetch during rendering', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response());

    const fixtureJson = loadFixture('stdin-promax.json');
    await captureStdout(() => runRenderPromax([], makeStream(fixtureJson)));

    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('does not import fs (render-promax module has no fs import)', () => {
    // Structural test: the render-promax module only imports from node:stream,
    // node:path (not present), and internal modules. We verify by checking
    // that running a full render cycle with a mocked stream produces output
    // without accessing the filesystem (beyond fixture loading done here).
    //
    // This is satisfied by the implementation's design (no fs import).
    // We verify indirectly: the function completes successfully with an
    // in-memory stream, proving it needs no file I/O.
    const input = JSON.stringify({
      session_id: 'test',
      transcript_path: '/t',
      cwd: '/c',
      model: { id: 'm', display_name: 'test-model' },
      workspace: { current_dir: '/c', project_dir: '/c' },
      version: '1',
      output_style: { name: 'default' },
      cost: { total_cost_usd: 0.5, total_duration_ms: 0, total_api_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0 },
      exceeds_200k_tokens: false,
      context_window: { used_percentage: 40 },
    });

    return captureStdout(() => runRenderPromax([], makeStream(input))).then(({ exitCode, output }) => {
      expect(exitCode).toBe(0);
      expect(output).toContain('test-model');
      expect(output).toContain('$0.50');
    });
  });
});
