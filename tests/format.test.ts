import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  colorTier,
  applyColor,
  applyDim,
  applyItalic,
  percentBar,
  chooseLayout,
  formatResetHint,
  formatOptionalHint,
  SEP,
  MISSING,
  STALE_MARKER,
} from '../src/statusline/format';

// ---------------------------------------------------------------------------
// Visual grammar constants
// ---------------------------------------------------------------------------

describe('visual grammar constants', () => {
  it('SEP is space + middle-dot + space', () => {
    expect(SEP).toBe(' · ');
    // Confirm the middle-dot codepoint specifically.
    expect(SEP.codePointAt(1)).toBe(0xb7); // U+00B7 MIDDLE DOT
  });

  it('MISSING is an em dash', () => {
    expect(MISSING).toBe('—');
    expect(MISSING.codePointAt(0)).toBe(0x2014); // U+2014 EM DASH
  });

  it('STALE_MARKER is space + tilde', () => {
    expect(STALE_MARKER).toBe(' ~');
  });
});

// ---------------------------------------------------------------------------
// colorTier
// ---------------------------------------------------------------------------

describe('colorTier', () => {
  it('0 → ok', () => expect(colorTier(0)).toBe('ok'));
  it('50 → ok', () => expect(colorTier(50)).toBe('ok'));
  it('69 → ok (just below warn boundary)', () => expect(colorTier(69)).toBe('ok'));
  it('70 → warn (boundary — inclusive)', () => expect(colorTier(70)).toBe('warn'));
  it('73 → warn (AE4)', () => expect(colorTier(73)).toBe('warn'));
  it('75 → warn', () => expect(colorTier(75)).toBe('warn'));
  it('89 → warn (just below critical boundary)', () => expect(colorTier(89)).toBe('warn'));
  it('90 → critical (boundary — inclusive)', () => expect(colorTier(90)).toBe('critical'));
  it('95 → critical', () => expect(colorTier(95)).toBe('critical'));
  it('100 → critical', () => expect(colorTier(100)).toBe('critical'));
  it('NaN → ok (no data, no alarm)', () => expect(colorTier(NaN)).toBe('ok'));
});

// ---------------------------------------------------------------------------
// applyColor / applyDim / applyItalic
// ---------------------------------------------------------------------------

describe('applyColor', () => {
  const ORIGINAL_IS_TTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  function setTTY(value: boolean | undefined) {
    Object.defineProperty(process.stdout, 'isTTY', {
      value,
      writable: true,
      configurable: true,
    });
  }

  beforeEach(() => {
    // Default each test to a TTY with no NO_COLOR.
    vi.stubEnv('NO_COLOR', '');
    setTTY(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // Restore original isTTY descriptor.
    if (ORIGINAL_IS_TTY) {
      Object.defineProperty(process.stdout, 'isTTY', ORIGINAL_IS_TTY);
    }
  });

  it('wraps text with green ANSI for ok tier when colors are on', () => {
    const result = applyColor('hello', 'ok');
    expect(result).toBe('\x1b[32mhello\x1b[0m');
  });

  it('wraps text with yellow ANSI for warn tier', () => {
    const result = applyColor('hello', 'warn');
    expect(result).toBe('\x1b[33mhello\x1b[0m');
  });

  it('wraps text with red ANSI for critical tier', () => {
    const result = applyColor('hello', 'critical');
    expect(result).toBe('\x1b[31mhello\x1b[0m');
  });

  it('returns bare text when NO_COLOR=1', () => {
    vi.stubEnv('NO_COLOR', '1');
    expect(applyColor('hello', 'ok')).toBe('hello');
  });

  it('returns bare text when NO_COLOR is any non-empty value', () => {
    vi.stubEnv('NO_COLOR', 'true');
    expect(applyColor('hello', 'warn')).toBe('hello');
  });

  it('keeps ANSI colors when process.stdout.isTTY === false', () => {
    setTTY(false);
    expect(applyColor('hello', 'ok')).toBe('\x1b[32mhello\x1b[0m');
  });

  it('keeps ANSI colors when process.stdout.isTTY is undefined', () => {
    setTTY(undefined);
    expect(applyColor('hello', 'critical')).toBe('\x1b[31mhello\x1b[0m');
  });
});

describe('applyDim', () => {
  beforeEach(() => {
    vi.stubEnv('NO_COLOR', '');
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('wraps text with dim ANSI codes when colors are on', () => {
    expect(applyDim('stale')).toBe('\x1b[2mstale\x1b[0m');
  });

  it('returns bare text when NO_COLOR=1', () => {
    vi.stubEnv('NO_COLOR', '1');
    expect(applyDim('stale')).toBe('stale');
  });
});

describe('applyItalic', () => {
  beforeEach(() => {
    vi.stubEnv('NO_COLOR', '');
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('wraps text with italic ANSI codes when colors are on', () => {
    expect(applyItalic('hint')).toBe('\x1b[3mhint\x1b[0m');
  });

  it('returns bare text when NO_COLOR=1', () => {
    vi.stubEnv('NO_COLOR', '1');
    expect(applyItalic('hint')).toBe('hint');
  });
});

// ---------------------------------------------------------------------------
// percentBar
// ---------------------------------------------------------------------------

describe('percentBar', () => {
  it('returns a string of exactly `width` characters', () => {
    for (const w of [5, 10, 20]) {
      expect([...percentBar(50, w)].length).toBe(w);
    }
  });

  it('0% → all spaces (width 8)', () => {
    const bar = percentBar(0, 8);
    expect([...bar].length).toBe(8);
    expect(bar).toBe('        ');
  });

  it('100% → all full-block characters (width 4)', () => {
    const bar = percentBar(100, 4);
    expect(bar).toBe('████');
  });

  it('clamps values below 0 to 0', () => {
    const bar = percentBar(-10, 5);
    expect([...bar].length).toBe(5);
    expect(bar).toBe('     ');
  });

  it('clamps values above 100 to 100', () => {
    const bar = percentBar(150, 4);
    expect(bar).toBe('████');
  });

  it('NaN is treated as 0', () => {
    const bar = percentBar(NaN, 4);
    expect(bar).toBe('    ');
  });

  it('50% fills approximately half the bar', () => {
    const bar = percentBar(50, 10);
    expect([...bar].length).toBe(10);
    // At 50%, the first 5 cells should be filled.
    const filled = [...bar].filter((c) => c !== ' ').length;
    expect(filled).toBeGreaterThanOrEqual(4);
    expect(filled).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// chooseLayout
// ---------------------------------------------------------------------------

describe('chooseLayout', () => {
  it('80 → narrow', () => expect(chooseLayout(80)).toBe('narrow'));
  it('100 → narrow (boundary inclusive)', () => expect(chooseLayout(100)).toBe('narrow'));
  it('101 → wide', () => expect(chooseLayout(101)).toBe('wide'));
  it('120 → wide', () => expect(chooseLayout(120)).toBe('wide'));
  it('undefined → wide (unknown terminal width defaults to wide)', () => {
    expect(chooseLayout(undefined)).toBe('wide');
  });
});

// ---------------------------------------------------------------------------
// formatResetHint
// ---------------------------------------------------------------------------

describe('formatResetHint — null/invalid inputs', () => {
  it('returns MISSING for null', () => {
    expect(formatResetHint(null)).toBe(MISSING);
  });

  it('returns MISSING for undefined', () => {
    expect(formatResetHint(undefined)).toBe(MISSING);
  });

  it('returns MISSING for NaN', () => {
    expect(formatResetHint(NaN)).toBe(MISSING);
  });

  it('returns MISSING for empty string', () => {
    expect(formatResetHint('')).toBe(MISSING);
  });

  it('returns MISSING for a non-date string', () => {
    expect(formatResetHint('not-a-date')).toBe(MISSING);
  });

  it('never throws for any of these inputs', () => {
    // Belt-and-suspenders — covered individually above but verify no throw.
    expect(() => formatResetHint(null)).not.toThrow();
    expect(() => formatResetHint(undefined)).not.toThrow();
    expect(() => formatResetHint(NaN)).not.toThrow();
    expect(() => formatResetHint('')).not.toThrow();
    expect(() => formatResetHint('not-a-date')).not.toThrow();
  });
});

describe('formatResetHint — relative phrasing', () => {
  it('4 minutes in the future (epoch seconds) → <5m', () => {
    const futureEpochSec = Math.floor(Date.now() / 1000) + 4 * 60;
    expect(formatResetHint(futureEpochSec)).toBe('<5m');
  });

  it('2 minutes in the future (ISO string) → <5m', () => {
    const futureMs = Date.now() + 2 * 60 * 1000;
    expect(formatResetHint(new Date(futureMs).toISOString())).toBe('<5m');
  });

  it('epoch seconds and equivalent ISO string produce the same output', () => {
    // Use a reset time 4 minutes in the future — both forms should map to <5m.
    const futureMs = Date.now() + 4 * 60 * 1000;
    const epochSec = Math.floor(futureMs / 1000);
    const isoStr = new Date(futureMs).toISOString();
    expect(formatResetHint(epochSec)).toBe(formatResetHint(isoStr));
  });

  it('same calendar day → shows only the reset time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 3, 20, 0, 0));

    const resetMs = new Date(2026, 4, 3, 21, 0, 0).getTime();
    const result = formatResetHint(Math.floor(resetMs / 1000));

    vi.useRealTimers();

    expect(result).toBe('21:00');
  });

  it('future day → includes a weekday abbreviation (not "today")', () => {
    // 3 days ahead is always a different calendar day.
    const futureMs = Date.now() + 3 * 24 * 60 * 60 * 1000;
    const result = formatResetHint(Math.floor(futureMs / 1000));
    expect(result).not.toBe(MISSING);
    expect(result).not.toMatch(/^today /);
    // Result should include a time component (HH:MM shaped substring).
    expect(result).toMatch(/\d{2}:\d{2}/);
  });

  it('past date → returns MISSING (reset already fired)', () => {
    const pastEpochSec = Math.floor(Date.now() / 1000) - 60;
    expect(formatResetHint(pastEpochSec)).toBe(MISSING);
  });

  it('uses the injected `now` for same-day comparison, not the wall clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 14, 23, 0, 0));

    const injectedNow = new Date(2026, 3, 15, 14, 0, 0).getTime();
    const resetMs = new Date(2026, 3, 15, 15, 0, 0).getTime();
    const resetEpochSec = Math.floor(resetMs / 1000);

    const result = formatResetHint(resetEpochSec, injectedNow);

    vi.useRealTimers();

    expect(result).toBe('15:00');
  });
});

describe('formatOptionalHint', () => {
  it('wraps present hints in brackets', () => {
    expect(formatOptionalHint('21:00')).toBe('[21:00]');
  });

  it('omits missing hints', () => {
    expect(formatOptionalHint(MISSING)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Forbidden separator check — helpers must not emit , | or ' - '
// ---------------------------------------------------------------------------

describe('visual grammar — no forbidden separators in formatted output', () => {
  it('applyColor output contains no forbidden separators', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });
    vi.stubEnv('NO_COLOR', '');
    const text = 'test · value · 45%';
    const result = applyColor(text, 'ok');
    // The content (SEP) is passed in by the caller, not generated by applyColor.
    // Verify the wrapper itself doesn't add forbidden chars.
    expect(result).not.toMatch(/,/);
    vi.unstubAllEnvs();
  });

  it('SEP does not contain comma, pipe, or " - "', () => {
    expect(SEP).not.toContain(',');
    expect(SEP).not.toContain('|');
    expect(SEP).not.toContain(' - ');
  });
});
