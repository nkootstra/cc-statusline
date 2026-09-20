import { applyColor, colorTier, formatOptionalHint, formatResetHint } from './format';

// A per-model weekly usage window (e.g. Fable). The server owns the label and
// the set of windows, so a new model needs no client release.
export interface ModelScopedWindow {
  display_name: string;
  utilization: number | null;
  resets_at: string | null;
}

// Labels come from the server and are printed verbatim into a single terminal
// line, so escape sequences and line breaks must never pass through. Whole
// CSI/OSC sequences are removed first so a stripped ESC does not leave its
// parameter bytes (e.g. "[31m") behind as visible text.
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const MAX_LABEL_LENGTH = 32;

export function sanitizeDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(ANSI_SEQUENCES, '')
    .replace(CONTROL_CHARS, '')
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
  return cleaned === '' ? undefined : cleaned;
}

export interface ModelScopedSegmentOptions {
  now?: number | undefined;
  // The reset hint the 7d segment already shows. Per-model windows share the
  // weekly reset in practice, so a matching hint is not printed a second time.
  sharedResetHint?: string | undefined;
}

export function buildModelScopedSegments(
  windows: readonly ModelScopedWindow[] | undefined,
  options: ModelScopedSegmentOptions = {},
): string[] {
  if (windows === undefined) return [];

  const now = options.now ?? Date.now();
  const segments: string[] = [];
  for (const window of windows) {
    if (window.utilization === null) continue;
    const pct = Math.round(window.utilization);
    const hint = formatResetHint(window.resets_at, now);
    const hintSeg = hint === options.sharedResetHint ? '' : formatOptionalHint(hint);
    segments.push(
      [window.display_name, applyColor(`${pct}%`, colorTier(pct)), hintSeg]
        .filter(Boolean)
        .join(' '),
    );
  }
  return segments;
}
