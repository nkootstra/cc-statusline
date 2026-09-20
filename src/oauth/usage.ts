import type {
  ExtraUsage,
  UsageBucket,
  UsageLimitRow,
  UsageLimitScope,
  UsageResponse,
} from './types';
import {
  sanitizeDisplayName,
  type ModelScopedWindow,
} from '../statusline/model-scoped';

const INVALID_USAGE_FIELD = Symbol('invalid-usage-field');

interface UsageBucketJson {
  utilization?: unknown;
  resets_at?: unknown;
  resetsAt?: unknown;
}

interface ExtraUsageJson {
  is_enabled?: unknown;
  utilization?: unknown;
  used_credits?: unknown;
  monthly_limit?: unknown;
}

interface UsageLimitRowJson {
  kind?: unknown;
  percent?: unknown;
  resets_at?: unknown;
  scope?: unknown;
}

interface UsageResponseJson {
  five_hour?: unknown;
  seven_day?: unknown;
  seven_day_sonnet?: unknown;
  seven_day_opus?: unknown;
  extra_usage?: unknown;
  limits?: unknown;
}

function optionalFiniteNumber(
  value: unknown,
): number | undefined | typeof INVALID_USAGE_FIELD {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : INVALID_USAGE_FIELD;
}

function optionalString(
  value: unknown,
): string | undefined | typeof INVALID_USAGE_FIELD {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : INVALID_USAGE_FIELD;
}

function decodeUsageBucket(
  value: unknown,
): UsageBucket | null | undefined | typeof INVALID_USAGE_FIELD {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return INVALID_USAGE_FIELD;
  }

  const candidate = value as UsageBucketJson;
  const utilization = optionalFiniteNumber(candidate.utilization);
  const resetsAtSnake = optionalString(candidate.resets_at);
  const resetsAtCamel = optionalString(candidate.resetsAt);
  if (
    utilization === undefined ||
    utilization === INVALID_USAGE_FIELD ||
    resetsAtSnake === INVALID_USAGE_FIELD ||
    resetsAtCamel === INVALID_USAGE_FIELD
  ) {
    return INVALID_USAGE_FIELD;
  }

  return {
    utilization,
    ...(resetsAtSnake === undefined ? {} : { resets_at: resetsAtSnake }),
    ...(resetsAtCamel === undefined ? {} : { resetsAt: resetsAtCamel }),
  };
}

function decodeExtraUsage(
  value: unknown,
): ExtraUsage | undefined | typeof INVALID_USAGE_FIELD {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return INVALID_USAGE_FIELD;
  }

  const candidate = value as ExtraUsageJson;
  const utilization = optionalFiniteNumber(candidate.utilization);
  const usedCredits = optionalFiniteNumber(candidate.used_credits);
  const monthlyLimit = optionalFiniteNumber(candidate.monthly_limit);
  if (
    typeof candidate.is_enabled !== 'boolean' ||
    utilization === INVALID_USAGE_FIELD ||
    usedCredits === INVALID_USAGE_FIELD ||
    monthlyLimit === INVALID_USAGE_FIELD
  ) {
    return INVALID_USAGE_FIELD;
  }

  return {
    is_enabled: candidate.is_enabled,
    ...(utilization === undefined ? {} : { utilization }),
    ...(usedCredits === undefined ? {} : { used_credits: usedCredits }),
    ...(monthlyLimit === undefined ? {} : { monthly_limit: monthlyLimit }),
  };
}

function decodeLimitScope(value: unknown): UsageLimitScope | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const model = (value as { model?: unknown }).model;
  const displayName =
    typeof model === 'object' && model !== null && !Array.isArray(model)
      ? sanitizeDisplayName((model as { display_name?: unknown }).display_name)
      : undefined;
  return displayName === undefined ? {} : { model: { display_name: displayName } };
}

function decodeUsageLimitRow(value: unknown): UsageLimitRow | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as UsageLimitRowJson;
  if (typeof candidate.kind !== 'string') return undefined;
  const percent = candidate.percent;
  if (percent !== null && (typeof percent !== 'number' || !Number.isFinite(percent))) {
    return undefined;
  }
  const scope = decodeLimitScope(candidate.scope);
  return {
    kind: candidate.kind,
    percent: percent ?? null,
    resets_at: typeof candidate.resets_at === 'string' ? candidate.resets_at : null,
    ...(scope === undefined ? {} : { scope }),
  };
}

// The server defines the meter rows and may add new ones without a client
// release, so an unreadable row is dropped rather than invalidating the
// whole response (which would blank the statusline until the next init).
function decodeUsageLimits(value: unknown): UsageLimitRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: UsageLimitRow[] = [];
  for (const entry of value) {
    const row = decodeUsageLimitRow(entry);
    if (row !== undefined) rows.push(row);
  }
  return rows;
}

export function modelScopedWindows(usage: UsageResponse): ModelScopedWindow[] {
  const windows: ModelScopedWindow[] = [];
  for (const row of usage.limits ?? []) {
    if (row.kind !== 'weekly_scoped') continue;
    const displayName = row.scope?.model?.display_name;
    if (displayName === undefined) continue;
    windows.push({
      display_name: displayName,
      utilization: row.percent,
      resets_at: row.resets_at,
    });
  }
  return windows;
}

export function decodeUsageResponse(value: unknown): UsageResponse | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const candidate = value as UsageResponseJson;
  const fiveHour = decodeUsageBucket(candidate.five_hour);
  const sevenDay = decodeUsageBucket(candidate.seven_day);
  const sevenDaySonnet = decodeUsageBucket(candidate.seven_day_sonnet);
  const sevenDayOpus = decodeUsageBucket(candidate.seven_day_opus);
  const extraUsage = decodeExtraUsage(candidate.extra_usage);
  const limits = decodeUsageLimits(candidate.limits);
  if (
    fiveHour === INVALID_USAGE_FIELD ||
    sevenDay === INVALID_USAGE_FIELD ||
    sevenDaySonnet === INVALID_USAGE_FIELD ||
    sevenDayOpus === INVALID_USAGE_FIELD ||
    extraUsage === INVALID_USAGE_FIELD
  ) {
    return null;
  }

  return {
    ...(fiveHour === undefined ? {} : { five_hour: fiveHour }),
    ...(sevenDay === undefined ? {} : { seven_day: sevenDay }),
    ...(sevenDaySonnet === undefined
      ? {}
      : { seven_day_sonnet: sevenDaySonnet }),
    ...(sevenDayOpus === undefined ? {} : { seven_day_opus: sevenDayOpus }),
    ...(extraUsage === undefined ? {} : { extra_usage: extraUsage }),
    ...(limits === undefined ? {} : { limits }),
  };
}
