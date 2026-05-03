/**
 * Types and parser for the Claude Code statusline stdin JSON contract.
 * Reference: https://code.claude.com/docs/en/statusline
 *
 * Optional fields are `T | undefined`.
 * Nullable fields (documented as possibly null by Claude Code) are `T | null`.
 * `parseStdin` is defensive: it never throws and always returns a typed object or null.
 */

export interface Model {
  id: string;
  display_name: string;
}

export interface Workspace {
  current_dir: string;
  project_dir: string;
}

export interface OutputStyle {
  name: string;
}

export interface Cost {
  total_cost_usd: number;
  total_duration_ms: number;
  total_api_duration_ms: number;
  total_lines_added: number;
  total_lines_removed: number;
}

/** Per-window rate-limit bucket. `resetsAt` is epoch seconds. */
export interface RateLimitWindow {
  used_percentage: number;
  resetsAt: number;
}

/**
 * Rate limit data — present only after Claude Code has hit the rate-limit
 * endpoint at least once in the current session. Enterprise users receive
 * usage data via the OAuth API instead; this field is absent for them.
 */
export interface RateLimits {
  five_hour?: RateLimitWindow;
  seven_day?: RateLimitWindow;
  seven_day_opus?: RateLimitWindow;
}

/**
 * Context window utilization. `used_percentage` can be null per the Claude
 * Code docs (e.g. before any tokens are consumed, or for some model variants).
 */
export interface ContextWindow {
  used_percentage: number | null;
}

export interface StatuslineInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  model: Model;
  workspace: Workspace;
  version: string;
  output_style: OutputStyle;
  cost: Cost;
  exceeds_200k_tokens: boolean;
  /** Present once context window data is available. */
  context_window?: ContextWindow;
  /** Present only when Claude Code has rate-limit data for this session. */
  rate_limits?: RateLimits;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function normalizeModel(raw: unknown): Model {
  if (!isRecord(raw)) return { id: '', display_name: '' };
  return {
    id: str(raw['id'], ''),
    display_name: str(raw['display_name'], ''),
  };
}

function normalizeWorkspace(raw: unknown): Workspace {
  if (!isRecord(raw)) return { current_dir: '', project_dir: '' };
  return {
    current_dir: str(raw['current_dir'], ''),
    project_dir: str(raw['project_dir'], ''),
  };
}

function normalizeOutputStyle(raw: unknown): OutputStyle {
  if (!isRecord(raw)) return { name: '' };
  return { name: str(raw['name'], '') };
}

function normalizeCost(raw: unknown): Cost {
  if (!isRecord(raw)) {
    return {
      total_cost_usd: 0,
      total_duration_ms: 0,
      total_api_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
    };
  }
  return {
    total_cost_usd: num(raw['total_cost_usd'], 0),
    total_duration_ms: num(raw['total_duration_ms'], 0),
    total_api_duration_ms: num(raw['total_api_duration_ms'], 0),
    total_lines_added: num(raw['total_lines_added'], 0),
    total_lines_removed: num(raw['total_lines_removed'], 0),
  };
}

function normalizeRateLimitWindow(raw: unknown): RateLimitWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const used = raw['used_percentage'];
  const resetsAt = raw['resets_at'] ?? raw['resetsAt'];
  if (typeof used !== 'number' || typeof resetsAt !== 'number') return undefined;
  return { used_percentage: used, resetsAt };
}

function normalizeRateLimits(raw: unknown): RateLimits | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    five_hour: normalizeRateLimitWindow(raw['five_hour']),
    seven_day: normalizeRateLimitWindow(raw['seven_day']),
    seven_day_opus: normalizeRateLimitWindow(raw['seven_day_opus']),
  };
}

function normalizeContextWindow(raw: unknown): ContextWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const pct = raw['used_percentage'];
  // The field is explicitly nullable per the Claude Code docs.
  const used_percentage: number | null = typeof pct === 'number' ? pct : null;
  return { used_percentage };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a raw stdin string from Claude Code into a `StatuslineInput`.
 *
 * Returns `null` when the input is not valid JSON (blank line, empty string,
 * truncated payload, etc.). Never throws.
 *
 * Missing or malformed fields are normalized to safe defaults rather than
 * rejected — so callers can rely on the presence of every required field on
 * the returned object without additional null-guards.
 */
export function parseStdin(input: string): StatuslineInput | null {
  if (!input || !input.trim()) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    return null;
  }

  if (!isRecord(raw)) return null;

  return {
    session_id: str(raw['session_id'], ''),
    transcript_path: str(raw['transcript_path'], ''),
    cwd: str(raw['cwd'], ''),
    model: normalizeModel(raw['model']),
    workspace: normalizeWorkspace(raw['workspace']),
    version: str(raw['version'], ''),
    output_style: normalizeOutputStyle(raw['output_style']),
    cost: normalizeCost(raw['cost']),
    exceeds_200k_tokens: bool(raw['exceeds_200k_tokens'], false),
    context_window: normalizeContextWindow(raw['context_window']),
    rate_limits: normalizeRateLimits(raw['rate_limits']),
  };
}
