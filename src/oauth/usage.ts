import type { ExtraUsage, UsageBucket, UsageResponse } from './types';

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

interface UsageResponseJson {
  five_hour?: unknown;
  seven_day?: unknown;
  seven_day_sonnet?: unknown;
  seven_day_opus?: unknown;
  extra_usage?: unknown;
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
  };
}
