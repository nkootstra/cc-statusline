import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeUsageResponse, modelScopedWindows } from '../src/oauth/usage';

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures', 'usage-response.json'), 'utf8'),
) as Record<string, unknown>;

const FABLE_ROW = {
  kind: 'weekly_scoped',
  percent: 12,
  resets_at: '2026-05-10T00:00:00.000Z',
  scope: { model: { display_name: 'Fable' } },
};

describe('decodeUsageResponse — limits', () => {
  it('decodes the fixture limit rows, keeping only the fields the renderer needs', () => {
    const usage = decodeUsageResponse(fixture);

    expect(usage?.limits).toEqual([
      { kind: 'session', percent: 42, resets_at: '2026-05-03T18:00:00.000Z' },
      { kind: 'weekly_all', percent: 67, resets_at: '2026-05-10T00:00:00.000Z' },
      FABLE_ROW,
    ]);
  });

  it('omits limits when the field is absent', () => {
    const { limits: _ignored, ...withoutLimits } = fixture;
    const usage = decodeUsageResponse(withoutLimits);

    expect(usage).not.toBeNull();
    expect(usage).not.toHaveProperty('limits');
  });

  it('omits limits when the field is not an array', () => {
    const usage = decodeUsageResponse({ ...fixture, limits: 'nope' });

    expect(usage).not.toBeNull();
    expect(usage).not.toHaveProperty('limits');
    expect(usage?.five_hour?.utilization).toBe(42);
  });

  it('keeps an empty limits array', () => {
    expect(decodeUsageResponse({ limits: [] })?.limits).toEqual([]);
  });

  it('drops rows it cannot read instead of rejecting the response', () => {
    const usage = decodeUsageResponse({
      limits: [
        { kind: 'weekly_scoped', percent: '12' },
        'junk',
        null,
        { percent: 5 },
        { kind: 'weekly_scoped', percent: 9, resets_at: 123, scope: 'model' },
        FABLE_ROW,
      ],
    });

    expect(usage?.limits).toEqual([
      { kind: 'weekly_scoped', percent: 9, resets_at: null },
      FABLE_ROW,
    ]);
  });

  it('keeps a null percent as null', () => {
    const usage = decodeUsageResponse({
      limits: [{ ...FABLE_ROW, percent: null }],
    });

    expect(usage?.limits).toEqual([{ ...FABLE_ROW, percent: null }]);
  });

  it('strips control characters from the model display name', () => {
    const usage = decodeUsageResponse({
      limits: [
        { ...FABLE_ROW, scope: { model: { display_name: ' Fa\u001b[31mble\n ' } } },
        { ...FABLE_ROW, scope: { model: { display_name: '\u0007' } } },
      ],
    });

    expect(usage?.limits).toEqual([
      FABLE_ROW,
      { kind: 'weekly_scoped', percent: 12, resets_at: '2026-05-10T00:00:00.000Z', scope: {} },
    ]);
  });
});

describe('modelScopedWindows', () => {
  it('projects the fixture Fable row into a model-scoped window', () => {
    const usage = decodeUsageResponse(fixture);

    expect(modelScopedWindows(usage!)).toEqual([
      { display_name: 'Fable', utilization: 12, resets_at: '2026-05-10T00:00:00.000Z' },
    ]);
  });

  it('ignores session, weekly_all, and surface-only rows', () => {
    const usage = decodeUsageResponse({
      limits: [
        { kind: 'session', percent: 1, resets_at: null },
        { kind: 'weekly_all', percent: 2, resets_at: null },
        { kind: 'weekly_scoped', percent: 3, resets_at: null, scope: { surface: { display_name: 'Cowork' } } },
        { kind: 'weekly_scoped', percent: 4, resets_at: null },
        { kind: 'weekly_scoped', percent: 5, resets_at: null, scope: { model: { display_name: 'Fable' } } },
        { kind: 'weekly_scoped', percent: 6, resets_at: null, scope: { model: { display_name: 'Opus' } } },
      ],
    });

    expect(modelScopedWindows(usage!)).toEqual([
      { display_name: 'Fable', utilization: 5, resets_at: null },
      { display_name: 'Opus', utilization: 6, resets_at: null },
    ]);
  });

  it('is empty when limits are absent', () => {
    expect(modelScopedWindows({})).toEqual([]);
  });

  it('keeps a null percent as a null utilization', () => {
    const usage = decodeUsageResponse({ limits: [{ ...FABLE_ROW, percent: null }] });

    expect(modelScopedWindows(usage!)).toEqual([
      { display_name: 'Fable', utilization: null, resets_at: '2026-05-10T00:00:00.000Z' },
    ]);
  });
});
