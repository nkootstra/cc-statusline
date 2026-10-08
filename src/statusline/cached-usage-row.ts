import {
  SEP,
  MISSING,
  STALE_MARKER,
  applyColor,
  applyDim,
  colorTier,
  formatResetHint,
  formatOptionalHint,
} from './format';
import type { Cache } from '../cache/store';
import type { ExtraUsage, UsageBucket, UsageResponse } from '../oauth/types';
import { modelScopedWindows } from '../oauth/usage';
import { buildModelScopedSegments } from './model-scoped';
import { MISSING_CACHE_HINT, buildAuthHint, isCacheStale } from './usage-status';

function bucketResetHint(bucket: UsageBucket | null | undefined, nowMs: number): string {
  if (bucket === null || bucket === undefined) return MISSING;
  return formatResetHint(bucket.resets_at ?? bucket.resetsAt, nowMs);
}

function buildUsageBucketSegment(
  label: string,
  bucket: UsageBucket | null | undefined,
  hint: string,
): string {
  if (bucket === null || bucket === undefined) {
    return `${label} ${MISSING}`;
  }

  const pct = Math.round(bucket.utilization);
  return [label, applyColor(`${pct}%`, colorTier(pct)), formatOptionalHint(hint)]
    .filter(Boolean)
    .join(' ');
}

export function hasCreditUsage(extra: ExtraUsage): extra is ExtraUsage & {
  used_credits: number;
  monthly_limit: number;
} {
  return extra.used_credits !== null &&
    extra.used_credits !== undefined &&
    extra.monthly_limit !== null &&
    extra.monthly_limit !== undefined;
}

function buildSessionCostSegment(sessionCostUsd: number): string {
  if (sessionCostUsd === 0) return '';
  return `session $${sessionCostUsd.toFixed(2)}`;
}

function buildCreditsSegment(extra: ExtraUsage): string {
  if (!hasCreditUsage(extra)) {
    return `usage ${MISSING}`;
  }

  const usedUsd = extra.used_credits / 100;
  const limitUsd = extra.monthly_limit / 100;
  const usedDisplay = usedUsd.toFixed(2);
  const limitDisplay = limitUsd.toFixed(2);
  const utilizationPct = Math.round(
    limitUsd > 0 ? (usedUsd / limitUsd) * 100 : 0,
  );

  return `credits $${usedDisplay} / $${limitDisplay} (${utilizationPct}%)`;
}

function buildCachedWindowsSegment(
  usage: UsageResponse,
  nowMs: number,
): { text: string; sevenDayHint: string } {
  const sevenDayHint = bucketResetHint(usage.seven_day, nowMs);
  return {
    text: [
      buildUsageBucketSegment('5h', usage.five_hour, bucketResetHint(usage.five_hour, nowMs)),
      buildUsageBucketSegment('7d', usage.seven_day, sevenDayHint),
    ].join(' · '),
    sevenDayHint,
  };
}

// Applies the staleness dim and marker; the fatal-auth dim is the caller's.
function buildUsageSegment(
  cache: Cache | null,
  isStale: boolean,
  nowMs: number,
  sessionCostUsd: number,
): { text: string; isFetching: boolean } {
  if (cache === null) {
    return {
      text: `usage ${MISSING}${SEP}${MISSING_CACHE_HINT}`,
      isFetching: false,
    };
  }

  if (cache.usage === null) {
    return { text: `usage ${MISSING}${SEP}fetching…`, isFetching: true };
  }

  const usage = cache.usage;
  const extra = usage.extra_usage;
  let mainSeg: string;
  let sharedResetHint: string | undefined;
  if (extra?.is_enabled === true) {
    mainSeg = buildCreditsSegment(extra);
  } else {
    const windows = buildCachedWindowsSegment(usage, nowMs);
    mainSeg = windows.text;
    sharedResetHint = windows.sevenDayHint;
  }
  let figureSeg = [
    mainSeg,
    ...buildModelScopedSegments(modelScopedWindows(usage), { now: nowMs, sharedResetHint }),
  ].join(SEP);

  if (isStale) {
    figureSeg = applyDim(figureSeg) + STALE_MARKER;
  }

  if (extra?.is_enabled === true) {
    figureSeg = [figureSeg, buildSessionCostSegment(sessionCostUsd)]
      .filter(Boolean)
      .join(SEP);
  }

  return { text: figureSeg, isFetching: false };
}

export function buildCachedUsageRow(
  cache: Cache | null,
  nowMs: number,
  staleThresholdMs: number,
  sessionCostUsd: number,
): string {
  const isStale = isCacheStale(cache, nowMs, staleThresholdMs);
  const { text: rawUsage, isFetching } = buildUsageSegment(cache, isStale, nowMs, sessionCostUsd);

  // Stale figures are already dimmed; a fatal state dims everything else,
  // including the fetching placeholder.
  const usageSeg = cache?.authState === 'fatal' && (isFetching || !isStale)
    ? applyDim(rawUsage)
    : rawUsage;
  return usageSeg + buildAuthHint(cache, nowMs);
}
