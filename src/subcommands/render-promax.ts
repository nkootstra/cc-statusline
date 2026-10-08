import type { StatuslineInput } from '../statusline/stdin';
import {
  SEP,
  MISSING,
  colorTier,
  applyColor,
  formatResetHint,
  formatOptionalHint,
} from '../statusline/format';
import { buildModelScopedSegments } from '../statusline/model-scoped';
import { buildCacheSegment } from '../statusline/prompt-cache';

// ---------------------------------------------------------------------------
// Segment builders
// ---------------------------------------------------------------------------

export function buildModelSegment(displayName: string): string {
  return displayName || MISSING;
}

export function buildCtxSegment(usedPercentage: number | null | undefined): string {
  if (usedPercentage === null || usedPercentage === undefined) {
    return '';
  }
  const pct = Math.round(usedPercentage);
  const tier = colorTier(pct);
  return `ctx ${applyColor(`${pct}%`, tier)}`;
}

export function buildRateLimitSegment(
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

export function buildCostSegment(totalCostUsd: number): string {
  if (totalCostUsd === 0) return '';
  return `$${totalCostUsd.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export function buildIdentityRow(input: StatuslineInput): string {
  const modelSeg = buildModelSegment(input.model.display_name);
  const ctxSeg = buildCtxSegment(input.context_window?.used_percentage);
  const cacheSeg = buildCacheSegment(input.prompt_cache);
  return [modelSeg, ctxSeg, cacheSeg].filter(Boolean).join(SEP);
}

export interface PayloadWindowSegments {
  fiveHour: string;
  sevenDay: string;
  sevenDayHint: string;
  modelScoped: string[] | undefined;
}

export function buildPayloadWindowSegments(input: StatuslineInput): PayloadWindowSegments {
  const fiveHour = input.rate_limits?.five_hour;
  const sevenDay = input.rate_limits?.seven_day;
  const sevenDayHint = formatResetHint(sevenDay?.resetsAt ?? null);
  const modelScoped = input.rate_limits?.model_scoped;
  return {
    fiveHour: buildRateLimitSegment(
      '5h',
      fiveHour?.used_percentage,
      formatResetHint(fiveHour?.resetsAt ?? null),
    ),
    sevenDay: buildRateLimitSegment('7d', sevenDay?.used_percentage, sevenDayHint),
    sevenDayHint,
    modelScoped: modelScoped === undefined
      ? undefined
      : buildModelScopedSegments(modelScoped, { sharedResetHint: sevenDayHint }),
  };
}

export function buildPayloadUsageRow(input: StatuslineInput): string {
  const windows = buildPayloadWindowSegments(input);
  return [
    windows.fiveHour,
    windows.sevenDay,
    ...(windows.modelScoped ?? []),
    buildCostSegment(input.cost.total_cost_usd),
  ].filter(Boolean).join(SEP);
}
