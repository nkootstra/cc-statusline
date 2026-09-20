import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseStdin, type StatuslineInput } from '../src/statusline/stdin';

const FIXTURES = resolve(__dirname, 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), 'utf8');
}

// ---------------------------------------------------------------------------
// Happy path — Pro/Max fixture (includes rate_limits)
// ---------------------------------------------------------------------------

describe('parseStdin — Pro/Max fixture', () => {
  let result: StatuslineInput | null;

  it('parses without returning null', () => {
    result = parseStdin(loadFixture('stdin-promax.json'));
    expect(result).not.toBeNull();
  });

  it('preserves session_id', () => {
    result = parseStdin(loadFixture('stdin-promax.json'));
    expect(result?.session_id).toBe('sess_01ProMaxExampleSession12345');
  });

  it('preserves model fields', () => {
    result = parseStdin(loadFixture('stdin-promax.json'));
    expect(result?.model.id).toBe('claude-sonnet-4-5');
    expect(result?.model.display_name).toBe('claude-sonnet-4-5');
  });

  it('preserves cost.total_cost_usd', () => {
    result = parseStdin(loadFixture('stdin-promax.json'));
    expect(result?.cost.total_cost_usd).toBeCloseTo(0.042);
  });

  it('preserves context_window.used_percentage as a number', () => {
    result = parseStdin(loadFixture('stdin-promax.json'));
    expect(result?.context_window?.used_percentage).toBe(22);
  });

  it('populates rate_limits.five_hour', () => {
    result = parseStdin(loadFixture('stdin-promax.json'));
    expect(result?.rate_limits?.five_hour).toEqual({
      used_percentage: 45,
      resetsAt: 1714502400,
    });
  });

  it('populates rate_limits.seven_day', () => {
    result = parseStdin(loadFixture('stdin-promax.json'));
    expect(result?.rate_limits?.seven_day).toEqual({
      used_percentage: 31,
      resetsAt: 1714934400,
    });
  });

  it('populates rate_limits.seven_day_opus', () => {
    result = parseStdin(loadFixture('stdin-promax.json'));
    expect(result?.rate_limits?.seven_day_opus).toEqual({
      used_percentage: 10,
      resetsAt: 1714934400,
    });
  });

  it('populates rate_limits.model_scoped', () => {
    result = parseStdin(loadFixture('stdin-promax.json'));
    expect(result?.rate_limits?.model_scoped).toEqual([
      { display_name: 'Fable', utilization: 12, resets_at: '2024-05-05T18:40:00.000Z' },
    ]);
  });

  it('accepts Claude Code snake_case reset timestamps', () => {
    const result = parseStdin(JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 102, resets_at: 1777815000 },
        seven_day: { used_percentage: 81, resets_at: 1778004000 },
      },
    }));

    expect(result?.rate_limits?.five_hour).toEqual({
      used_percentage: 102,
      resetsAt: 1777815000,
    });
    expect(result?.rate_limits?.seven_day).toEqual({
      used_percentage: 81,
      resetsAt: 1778004000,
    });
  });
});

// ---------------------------------------------------------------------------
// Happy path — Enterprise fixture (no rate_limits)
// ---------------------------------------------------------------------------

describe('parseStdin — Enterprise fixture', () => {
  it('parses without returning null', () => {
    const result = parseStdin(loadFixture('stdin-enterprise.json'));
    expect(result).not.toBeNull();
  });

  it('has rate_limits === undefined', () => {
    const result = parseStdin(loadFixture('stdin-enterprise.json'));
    expect(result?.rate_limits).toBeUndefined();
  });

  it('preserves session_id', () => {
    const result = parseStdin(loadFixture('stdin-enterprise.json'));
    expect(result?.session_id).toBe('sess_01EnterpriseExampleSession67890');
  });

  it('preserves exceeds_200k_tokens = false', () => {
    const result = parseStdin(loadFixture('stdin-enterprise.json'));
    expect(result?.exceeds_200k_tokens).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge case — context_window.used_percentage === null
// ---------------------------------------------------------------------------

describe('parseStdin — context_window.used_percentage null', () => {
  it('returns null (not undefined, not throw) for the field', () => {
    const input = JSON.stringify({
      session_id: 's1',
      transcript_path: '/t',
      cwd: '/c',
      model: { id: 'm', display_name: 'm' },
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
    const result = parseStdin(input);
    expect(result).not.toBeNull();
    expect(result?.context_window).toBeDefined();
    expect(result?.context_window?.used_percentage).toBeNull();
    // Explicitly not undefined
    expect(result?.context_window?.used_percentage).not.toBeUndefined();
  });

  it('matches the Enterprise fixture which has used_percentage: null', () => {
    const result = parseStdin(loadFixture('stdin-enterprise.json'));
    expect(result?.context_window?.used_percentage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Edge case — cost.total_cost_usd === 0
// ---------------------------------------------------------------------------

describe('parseStdin — cost.total_cost_usd zero', () => {
  it('returns 0 (not NaN, not undefined)', () => {
    const result = parseStdin(loadFixture('stdin-enterprise.json'));
    expect(result?.cost.total_cost_usd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases — invalid / empty input
// ---------------------------------------------------------------------------

describe('parseStdin — invalid input', () => {
  it('returns null for empty string', () => {
    expect(parseStdin('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseStdin('   \n\t  ')).toBeNull();
  });

  it('returns null for non-JSON string', () => {
    expect(parseStdin('not json')).toBeNull();
  });

  it('returns null for a bare number (valid JSON but not an object)', () => {
    expect(parseStdin('42')).toBeNull();
  });

  it('returns null for a JSON array (not an object)', () => {
    expect(parseStdin('[]')).toBeNull();
  });

  it('parses {} without throwing and returns a normalized (empty) object', () => {
    // An empty object is valid JSON and a record — the normalizer fills in
    // safe defaults for every required field rather than rejecting it.
    // Callers should check required fields are non-empty before rendering.
    const result = parseStdin('{}');
    expect(result).not.toBeNull();
    // Required string fields default to ''.
    expect(result?.session_id).toBe('');
    expect(result?.cwd).toBe('');
    // Required sub-objects default to empty structs.
    expect(result?.model.id).toBe('');
    expect(result?.cost.total_cost_usd).toBe(0);
    // Optional fields are absent.
    expect(result?.rate_limits).toBeUndefined();
    expect(result?.context_window).toBeUndefined();
    // exceeds_200k_tokens defaults to false.
    expect(result?.exceeds_200k_tokens).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rate_limits.model_scoped — per-model weekly windows (e.g. Fable)
// ---------------------------------------------------------------------------

describe('parseStdin — rate_limits.model_scoped', () => {
  function parseModelScoped(modelScoped: unknown) {
    return parseStdin(JSON.stringify({ rate_limits: { model_scoped: modelScoped } }))
      ?.rate_limits?.model_scoped;
  }

  it('is undefined when absent', () => {
    expect(parseStdin(JSON.stringify({ rate_limits: {} }))?.rate_limits?.model_scoped)
      .toBeUndefined();
  });

  it('is undefined when not an array', () => {
    expect(parseModelScoped('nope')).toBeUndefined();
    expect(parseModelScoped({ display_name: 'Fable', utilization: 1 })).toBeUndefined();
  });

  it('preserves an empty array (endpoint answered, no per-model windows)', () => {
    expect(parseModelScoped([])).toEqual([]);
  });

  it('keeps null utilization and resets_at as null', () => {
    expect(parseModelScoped([
      { display_name: 'Fable', utilization: null, resets_at: null },
    ])).toEqual([{ display_name: 'Fable', utilization: null, resets_at: null }]);
  });

  it('normalizes non-numeric utilization and non-string resets_at to null', () => {
    expect(parseModelScoped([
      { display_name: 'Fable', utilization: '12', resets_at: 1714934400 },
      { display_name: 'Opus', utilization: Number.NaN },
    ])).toEqual([
      { display_name: 'Fable', utilization: null, resets_at: null },
      { display_name: 'Opus', utilization: null, resets_at: null },
    ]);
  });

  it('accepts camelCase resetsAt', () => {
    expect(parseModelScoped([
      { display_name: 'Fable', utilization: 12, resetsAt: '2024-05-05T18:40:00.000Z' },
    ])).toEqual([
      { display_name: 'Fable', utilization: 12, resets_at: '2024-05-05T18:40:00.000Z' },
    ]);
  });

  it('drops entries without a display name and non-object entries', () => {
    expect(parseModelScoped([
      { utilization: 12, resets_at: null },
      { display_name: '', utilization: 12 },
      { display_name: 7, utilization: 12 },
      'Fable',
      null,
      { display_name: 'Fable', utilization: 12 },
    ])).toEqual([{ display_name: 'Fable', utilization: 12, resets_at: null }]);
  });

  it('strips control characters from the display name', () => {
    expect(parseModelScoped([
      { display_name: ' Fa\u001b[31mble\n ', utilization: 12 },
      { display_name: '\u0007\t', utilization: 12 },
    ])).toEqual([{ display_name: 'Fable', utilization: 12, resets_at: null }]);
  });
});
