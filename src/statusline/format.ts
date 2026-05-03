/**
 * Shared formatting helpers for the cc-statusline renderer.
 *
 * All exports are pure functions and exported constants — no I/O, no globals,
 * no side effects. Callers (U4, U8) compose these into the final output line.
 */

// ---------------------------------------------------------------------------
// Visual grammar constants
// ---------------------------------------------------------------------------

/** Segment separator: space + U+00B7 MIDDLE DOT + space. */
export const SEP = ' · ';

/** Placeholder for absent or unavailable data. */
export const MISSING = '—';

/** Appended after a stale segment (in addition to dim ANSI when available). */
export const STALE_MARKER = ' ~';

// ---------------------------------------------------------------------------
// Color tier
// ---------------------------------------------------------------------------

export type ColorTier = 'ok' | 'warn' | 'critical';

/**
 * Map a percentage value to a color tier.
 *
 * Thresholds (v1, refinable via visual iteration):
 *   < 70  → ok
 *   70–<90 → warn
 *   ≥ 90  → critical
 *
 * NaN is treated as `ok` (no data → no alarm).
 */
export function colorTier(percent: number): ColorTier {
  if (Number.isNaN(percent)) return 'ok';
  if (percent >= 90) return 'critical';
  if (percent >= 70) return 'warn';
  return 'ok';
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ANSI_GREEN = '\x1b[32m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_RED = '\x1b[31m';
const ANSI_DIM = '\x1b[2m';
const ANSI_ITALIC = '\x1b[3m';
const ANSI_RESET = '\x1b[0m';

const TIER_CODES: Record<ColorTier, string> = {
  ok: ANSI_GREEN,
  warn: ANSI_YELLOW,
  critical: ANSI_RED,
};

/**
 * Returns true when ANSI color output should be suppressed:
 * - `NO_COLOR` env var is set to any non-empty value (https://no-color.org)
 *
 * Claude Code captures statusline stdout, so `isTTY` is false even when ANSI
 * escapes will be rendered in the prompt area. Respect explicit opt-out only.
 */
function shouldSuppressAnsi(): boolean {
  const noColor = process.env['NO_COLOR'];
  if (typeof noColor === 'string' && noColor !== '') return true;
  return false;
}

/**
 * Wrap `text` with the ANSI color code for `tier`.
 * Returns bare `text` when color output is suppressed.
 */
export function applyColor(text: string, tier: ColorTier): string {
  if (shouldSuppressAnsi()) return text;
  return `${TIER_CODES[tier]}${text}${ANSI_RESET}`;
}

/**
 * Wrap `text` with ANSI dim (faint) codes.
 * Returns bare `text` when color output is suppressed.
 */
export function applyDim(text: string): string {
  if (shouldSuppressAnsi()) return text;
  return `${ANSI_DIM}${text}${ANSI_RESET}`;
}

/**
 * Wrap `text` with ANSI italic codes (used for hint/advisory text).
 * Returns bare `text` when color output is suppressed.
 */
export function applyItalic(text: string): string {
  if (shouldSuppressAnsi()) return text;
  return `${ANSI_ITALIC}${text}${ANSI_RESET}`;
}

export function formatOptionalHint(hint: string): string {
  return hint === MISSING ? '' : `[${hint}]`;
}

// ---------------------------------------------------------------------------
// Percent bar
// ---------------------------------------------------------------------------

// Unicode block elements from thinnest to fullest.
const BLOCKS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];
const BLOCK_STEPS = BLOCKS.length; // 8 sub-character steps per full cell

/**
 * Render a `width`-character progress bar for `percent` (0–100).
 *
 * Uses the Unicode block ladder (▏▎▍▌▋▊▉█) for sub-character precision.
 * The bar is always exactly `width` characters wide.
 * `percent` is clamped to [0, 100].
 */
export function percentBar(percent: number, width: number): string {
  const clampedPct = Math.max(0, Math.min(100, Number.isNaN(percent) ? 0 : percent));
  const filled = (clampedPct / 100) * width; // fractional fill amount
  const fullCells = Math.floor(filled);
  const remainder = filled - fullCells; // 0.0–<1.0

  let bar = BLOCKS[BLOCK_STEPS - 1]!.repeat(fullCells);

  const partialIndex = Math.floor(remainder * BLOCK_STEPS);
  if (fullCells < width) {
    if (partialIndex > 0) {
      bar += BLOCKS[partialIndex - 1]!;
    } else {
      bar += ' ';
    }
    // Fill remaining cells with spaces.
    bar += ' '.repeat(width - fullCells - 1);
  }

  return bar;
}

// ---------------------------------------------------------------------------
// Layout selection
// ---------------------------------------------------------------------------

export type Layout = 'wide' | 'narrow';

/**
 * Choose a rendering layout based on the available terminal column count.
 *
 * Breakpoint: ≤ 100 columns → narrow; > 100 columns → wide.
 * `undefined` (unknown width, e.g. non-TTY or piped) → wide (safe default
 * since the consumer won't actually render in a narrow terminal when width is
 * unknown).
 */
export function chooseLayout(stdoutColumns: number | undefined): Layout {
  if (stdoutColumns === undefined) return 'wide';
  return stdoutColumns <= 100 ? 'narrow' : 'wide';
}

// ---------------------------------------------------------------------------
// Reset hint formatter
// ---------------------------------------------------------------------------

/**
 * Format a rate-limit reset time as a human-readable relative string.
 *
 * Accepts BOTH:
 *   - epoch seconds (number) — as emitted by the Claude Code statusline stdin contract
 *   - ISO 8601 string — as returned by the OAuth usage API
 *
 * Returns `MISSING` (`'—'`) for null, undefined, NaN, empty string, or any
 * input that does not parse into a valid future date. Never throws.
 *
 * Relative phrasing:
 *   < 5 min ahead     → `<5m`
 *   same calendar day → `HH:MM`
 *   future day        → `<weekday> HH:MM` (e.g. `Mon 14:30`)
 *
 * Uses `Intl.DateTimeFormat` for locale-aware HH:MM and weekday formatting.
 */
export function formatResetHint(resetsAt: number | string | null | undefined): string {
  if (resetsAt === null || resetsAt === undefined) return MISSING;
  if (resetsAt === '') return MISSING;
  if (typeof resetsAt === 'number' && Number.isNaN(resetsAt)) return MISSING;

  let resetMs: number;

  if (typeof resetsAt === 'number') {
    // Epoch seconds → epoch milliseconds.
    resetMs = resetsAt * 1000;
  } else {
    // ISO 8601 string or any other string.
    const parsed = Date.parse(resetsAt);
    if (Number.isNaN(parsed)) return MISSING;
    resetMs = parsed;
  }

  const resetDate = new Date(resetMs);
  if (!isFinite(resetDate.getTime())) return MISSING;

  const now = Date.now();
  const diffMs = resetMs - now;

  // Treat dates in the past or at the current moment as missing.
  // (A reset that already fired is not a useful hint.)
  if (diffMs <= 0) return MISSING;

  const diffMin = diffMs / 60_000;

  if (diffMin < 5) {
    return '<5m';
  }

  // Format time as HH:MM using Intl for locale correctness.
  const timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const nowDate = new Date(now);
  const isSameDay =
    resetDate.getFullYear() === nowDate.getFullYear() &&
    resetDate.getMonth() === nowDate.getMonth() &&
    resetDate.getDate() === nowDate.getDate();

  const hhmm = timeFormatter.format(resetDate);

  if (isSameDay) {
    return hhmm;
  }

  const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
  const weekday = weekdayFormatter.format(resetDate);
  return `${weekday} ${hhmm}`;
}
