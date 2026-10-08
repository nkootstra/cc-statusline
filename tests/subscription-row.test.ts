import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { colorTier } from '../src/statusline/format';
import { loadFixture, runWithCache, setTTY } from './support/render';

// No cache: the row shows only what Claude Code sends, which is what a
// subscriber sees before init or without credentials.
function renderPayload(
  stdin: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ output: string; exitCode: number }> {
  return runWithCache(null, stdin, { env });
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
// Scenario 1: Happy path — full subscription stdin fixture
// ---------------------------------------------------------------------------

describe('Scenario 1: happy path — full subscription fixture', () => {
  it('renders a single line containing all five segments in order', async () => {
    const fixtureJson = loadFixture('stdin-subscription.json');
    const { output, exitCode } = await renderPayload(fixtureJson);

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
    const fixtureJson = loadFixture('stdin-subscription.json');
    const { output } = await renderPayload(fixtureJson);
    expect(output).toContain('$0.04');
  });

  it('renders ctx with the fixture used_percentage (22%)', async () => {
    const fixtureJson = loadFixture('stdin-subscription.json');
    const { output } = await renderPayload(fixtureJson);
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

    const { output, exitCode } = await renderPayload(input);

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

    const { output } = await renderPayload(input);

    // Yellow ANSI code \x1b[33m should appear (warn tier)
    expect(output).toContain('\x1b[33m');
    expect(output).toContain('73%');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: cost.total_cost_usd === 0 is omitted
// ---------------------------------------------------------------------------

describe('Scenario 4: zero cost is omitted', () => {
  it('$0.00 does not appear in output when cost is 0', async () => {
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
      rate_limits: { five_hour: { used_percentage: 10, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
    });

    const { output, exitCode } = await renderPayload(input);

    expect(exitCode).toBe(0);
    expect(output).toContain('5h 10%');
    expect(output).not.toContain('$0.00');
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: context_window.used_percentage === null is omitted
// ---------------------------------------------------------------------------

describe('Scenario 5: null used_percentage is omitted', () => {
  it('omits ctx when context_window.used_percentage is null', async () => {
    const fixtureJson = loadFixture('stdin-no-rate-limits.json'); // has used_percentage: null
    const { output, exitCode } = await renderPayload(fixtureJson);

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

    const { output, exitCode } = await renderPayload(input);

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

    const { output } = await renderPayload(readableInput);

    expect(output).toBe('Sonnet 4.6\n5h 0% [21:00] · 7d 81% [Tue 20:00]\n');
  });

  it('emits ANSI colors by default and strips them with NO_COLOR', async () => {
    vi.stubEnv('NO_COLOR', '');
    const colored = await renderPayload(readableInput);

    vi.stubEnv('NO_COLOR', '1');
    const plain = await renderPayload(readableInput);

    expect(colored.output).toContain('\x1b[32m0%\x1b[0m');
    expect(colored.output).toContain('\x1b[33m81%\x1b[0m');
    expect(plain.output).toBe('Sonnet 4.6\n5h 0% [21:00] · 7d 81% [Tue 20:00]\n');
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

    const fixtureJson = loadFixture('stdin-subscription.json');
    const { output, exitCode } = await renderPayload(fixtureJson);

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

    const fixtureJson = loadFixture('stdin-subscription.json');
    const { output, exitCode } = await renderPayload(fixtureJson);

    expect(exitCode).toBe(0);
    expect(output).not.toMatch(/\x1b\[/);
  });

  it('output still contains readable segment labels without ANSI', async () => {
    vi.stubEnv('NO_COLOR', '1');

    const fixtureJson = loadFixture('stdin-subscription.json');
    const { output } = await renderPayload(fixtureJson);

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
    const { output, exitCode } = await renderPayload('');

    expect(exitCode).toBe(0);
    expect(output).toBe('\n');
  });

  it('produces a newline and exit 0 on whitespace-only stdin', async () => {
    const { output, exitCode } = await renderPayload('   \n\t  ');

    expect(exitCode).toBe(0);
    expect(output).toBe('\n');
  });
});

// ---------------------------------------------------------------------------
// Scenario 9: Non-JSON stdin produces empty stdout and exit 0
// ---------------------------------------------------------------------------

describe('Scenario 9: non-JSON stdin — silent fail mode', () => {
  it('produces a newline and exit 0 for "not json"', async () => {
    const { output, exitCode } = await renderPayload('not json');

    expect(exitCode).toBe(0);
    expect(output).toBe('\n');
  });

  it('produces a newline and exit 0 for a truncated JSON payload', async () => {
    const { output, exitCode } = await renderPayload('{"session_id": "abc');

    expect(exitCode).toBe(0);
    expect(output).toBe('\n');
  });
});

// ---------------------------------------------------------------------------
// Scenario 11: model-scoped weekly windows (e.g. Fable) from rate_limits.model_scoped
// ---------------------------------------------------------------------------

describe('Scenario 11: model-scoped weekly windows', () => {
  const RESET = new Date(2026, 4, 5, 20, 0, 0);
  const BASE_LINE = 'Sonnet 4.6\n5h 0% [21:00] · 7d 81% [Tue 20:00]';

  function makeInput(modelScoped?: unknown, totalCostUsd = 0): string {
    return JSON.stringify({
      session_id: 'test',
      transcript_path: '/t',
      cwd: '/c',
      model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet 4.6' },
      workspace: { current_dir: '/c', project_dir: '/c' },
      version: '1',
      output_style: { name: 'default' },
      cost: {
        total_cost_usd: totalCostUsd,
        total_duration_ms: 0,
        total_api_duration_ms: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      exceeds_200k_tokens: false,
      context_window: { used_percentage: null },
      rate_limits: {
        five_hour: { used_percentage: 0, resets_at: new Date(2026, 4, 3, 21, 0, 0).getTime() / 1000 },
        seven_day: { used_percentage: 81, resets_at: RESET.getTime() / 1000 },
        ...(modelScoped === undefined ? {} : { model_scoped: modelScoped }),
      },
    });
  }

  beforeEach(() => {
    vi.stubEnv('NO_COLOR', '1');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 3, 20, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('renders the server-labelled window after 7d and before cost', async () => {
    const { output } = await renderPayload(makeInput(
        [{ display_name: 'Fable', utilization: 12, resets_at: RESET.toISOString() }],
        0.5,
      ));

    expect(output).toBe(`${BASE_LINE} · Fable 12% · $0.50\n`);
  });

  it('renders the fixture Fable window', async () => {
    const { output } = await renderPayload(loadFixture('stdin-subscription.json'));

    expect(output).toContain('Fable 12%');
    expect(output.indexOf('7d')).toBeLessThan(output.indexOf('Fable'));
    expect(output.indexOf('Fable')).toBeLessThan(output.indexOf('$'));
  });

  it('keeps the server order for multiple windows', async () => {
    const { output } = await renderPayload(makeInput([
        { display_name: 'Fable', utilization: 12, resets_at: RESET.toISOString() },
        { display_name: 'Opus', utilization: 40, resets_at: null },
      ]));

    expect(output).toBe(`${BASE_LINE} · Fable 12% · Opus 40%\n`);
  });

  it('keeps the reset hint when it differs from the 7d reset', async () => {
    const { output } = await renderPayload(makeInput([
        { display_name: 'Fable', utilization: 12, resets_at: new Date(2026, 4, 6, 20, 0, 0).toISOString() },
      ]));

    expect(output).toBe(`${BASE_LINE} · Fable 12% [Wed 20:00]\n`);
  });

  // Observed live: the server puts the 7d reset one second before the hour
  // and the per-model reset on the hour, so the two must compare as shown.
  it('shows the shared reset once when the 7d reset sits a second before the hour', async () => {
    const input = JSON.parse(makeInput([
      { display_name: 'Fable', utilization: 12, resets_at: new Date(RESET.getTime() + 412).toISOString() },
    ])) as { rate_limits: { seven_day: { resets_at: number } } };
    input.rate_limits.seven_day.resets_at = (RESET.getTime() - 589) / 1000;

    const { output } = await renderPayload(JSON.stringify(input));

    expect(output).toBe(`${BASE_LINE} · Fable 12%\n`);
  });

  it('keeps the reset hint when the 7d window shows none', async () => {
    const input = JSON.parse(makeInput([
      { display_name: 'Fable', utilization: 12, resets_at: RESET.toISOString() },
    ])) as { rate_limits: { seven_day: { resets_at: number } } };
    input.rate_limits.seven_day.resets_at = new Date(2026, 4, 3, 19, 0, 0).getTime() / 1000;

    const { output } = await renderPayload(JSON.stringify(input));

    expect(output).toBe('Sonnet 4.6\n5h 0% [21:00] · 7d 81% · Fable 12% [Tue 20:00]\n');
  });

  it('omits windows without a utilization figure', async () => {
    const { output } = await renderPayload(makeInput([
        { display_name: 'Fable', utilization: null, resets_at: RESET.toISOString() },
      ]));

    expect(output).toBe(`${BASE_LINE}\n`);
  });

  it('renders nothing extra for an empty model_scoped array', async () => {
    const { output } = await renderPayload(makeInput([]));

    expect(output).toBe(`${BASE_LINE}\n`);
  });

  it('places model-scoped windows on the second row in the narrow layout', async () => {
    Object.defineProperty(process.stdout, 'columns', {
      value: 60,
      writable: true,
      configurable: true,
    });

    try {
      const { output } = await renderPayload(makeInput([
          { display_name: 'Fable', utilization: 12, resets_at: RESET.toISOString() },
        ]));

      expect(output).toBe('Sonnet 4.6\n5h 0% [21:00] · 7d 81% [Tue 20:00] · Fable 12%\n');
    } finally {
      Object.defineProperty(process.stdout, 'columns', {
        value: undefined,
        writable: true,
        configurable: true,
      });
    }
  });

  it('colors the model-scoped figure by tier', async () => {
    vi.stubEnv('NO_COLOR', '');

    const { output } = await renderPayload(makeInput([
        { display_name: 'Fable', utilization: 95, resets_at: null },
      ]));

    expect(output).toContain('Fable \x1b[31m95%\x1b[0m');
  });
});

describe('gateway mode', () => {
  beforeEach(() => {
    vi.stubEnv('NO_COLOR', '1');
  });

  it('renders only model and context when a custom base URL is set', async () => {
    const { output, exitCode } = await renderPayload(
      loadFixture('stdin-subscription.json'),
      { ANTHROPIC_BASE_URL: 'https://gateway.example.com' },
    );
    expect(exitCode).toBe(0);
    expect(output).toBe('claude-sonnet-4-5 · ctx 22%\n');
  });

  it('renders usage when the base URL points at Anthropic', async () => {
    const { output } = await renderPayload(
      loadFixture('stdin-subscription.json'),
      { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
    );
    expect(output).toContain('5h');
  });
});

describe('prompt cache segment', () => {
  const stdinWithCache = JSON.stringify({
    ...JSON.parse(loadFixture('stdin-subscription.json')),
    prompt_cache: { hit_ratio: 0.874, warm: true, caching_observed: true },
  });

  beforeEach(() => {
    vi.stubEnv('NO_COLOR', '1');
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'columns', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  it('follows ctx on the first row, with usage on the second, however wide the terminal', async () => {
    Object.defineProperty(process.stdout, 'columns', {
      value: 200,
      writable: true,
      configurable: true,
    });
    const { output } = await renderPayload(stdinWithCache);
    const [row1, row2] = output.split('\n');
    expect(row1).toBe('claude-sonnet-4-5 · ctx 22% · cache 87%');
    expect(row2).toMatch(/^5h 45%/);
  });

  it('is shown behind an LLM gateway', async () => {
    const { output } = await renderPayload(
      stdinWithCache,
      { ANTHROPIC_BASE_URL: 'https://gateway.example.com' },
    );
    expect(output).toBe('claude-sonnet-4-5 · ctx 22% · cache 87%\n');
  });

  it('is omitted when Claude Code sends no prompt cache stats', async () => {
    const { output } = await renderPayload(loadFixture('stdin-subscription.json'));
    expect(output).not.toContain('cache');
  });
});
