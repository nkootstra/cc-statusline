import type { StatuslineInput } from './stdin';
import {
  SEP,
  MISSING,
  STALE_MARKER,
  colorTier,
  applyColor,
  applyDim,
  formatResetHint,
  formatOptionalHint,
} from './format';
import type { Cache } from '../cache/store';
import type { UsageResponse } from '../oauth/types';
import { modelScopedWindows } from '../oauth/usage';
import { buildModelScopedSegments } from './model-scoped';
import { hasCreditUsage } from './cached-usage-row';
import { buildAuthHint, isCacheStale } from './usage-status';

export function hasCachedWindows(usage: UsageResponse): boolean {
  return (usage.five_hour !== null && usage.five_hour !== undefined) ||
    (usage.seven_day !== null && usage.seven_day !== undefined);
}

function buildRateLimitSegment(
  label: string,
  usedPercentage: number | undefined,
  hint: string,
): string {
  if (usedPercentage === undefined) {
    return `${label} ${MISSING}`;
  }
  const pct = Math.round(usedPercentage);
  const tier = colorTier(pct);
  return [label, applyColor(`${pct}%`, tier), formatOptionalHint(hint)]
    .filter(Boolean)
    .join(' ');
}

function buildCostSegment(totalCostUsd: number): string {
  if (totalCostUsd === 0) return '';
  return `$${totalCostUsd.toFixed(2)}`;
}

function buildExtraSpendSegment(usage: UsageResponse): string {
  const extra = usage.extra_usage;
  if (extra?.is_enabled !== true || !hasCreditUsage(extra)) return '';
  const usedDisplay = (extra.used_credits / 100).toFixed(2);
  const limitDisplay = (extra.monthly_limit / 100).toFixed(2);
  return `extra $${usedDisplay} / $${limitDisplay}`;
}

// `usage` is the cached response to add per-model windows and extra spend
// from, or null when the cache has none or belongs to another account.
export function buildSubscriptionUsageRow(
  input: StatuslineInput,
  cache: Cache | null,
  usage: UsageResponse | null,
  nowMs: number,
  staleThresholdMs: number,
): string {
  const fiveHour = input.rate_limits?.five_hour;
  const sevenDay = input.rate_limits?.seven_day;
  const sevenDayHint = formatResetHint(sevenDay?.resetsAt ?? null);
  const payloadModelScoped = input.rate_limits?.model_scoped;
  const modelScoped = payloadModelScoped === undefined
    ? undefined
    : buildModelScopedSegments(payloadModelScoped, { sharedResetHint: sevenDayHint });

  let cachedSegs: string[] = [];
  if (usage !== null) {
    cachedSegs = [
      ...(modelScoped === undefined
        ? buildModelScopedSegments(modelScopedWindows(usage), {
          now: nowMs,
          sharedResetHint: sevenDayHint,
        })
        : []),
      buildExtraSpendSegment(usage),
    ].filter(Boolean);
  }

  let cachedText = cachedSegs.join(SEP);
  if (cachedText !== '') {
    if (isCacheStale(cache, nowMs, staleThresholdMs)) {
      cachedText = applyDim(cachedText) + STALE_MARKER;
    } else if (cache?.authState === 'fatal') {
      cachedText = applyDim(cachedText);
    }
  }

  return [
    buildRateLimitSegment(
      '5h',
      fiveHour?.used_percentage,
      formatResetHint(fiveHour?.resetsAt ?? null),
    ),
    buildRateLimitSegment('7d', sevenDay?.used_percentage, sevenDayHint),
    ...(modelScoped ?? []),
    cachedText,
    buildCostSegment(input.cost.total_cost_usd),
  ].filter(Boolean).join(SEP) + buildAuthHint(cache, nowMs);
}
