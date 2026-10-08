import type { StatuslineInput } from './stdin';
import { SEP, MISSING, colorTier, applyColor } from './format';
import { buildCacheSegment } from './prompt-cache';

function buildCtxSegment(usedPercentage: number | null | undefined): string {
  if (usedPercentage === null || usedPercentage === undefined) {
    return '';
  }
  const pct = Math.round(usedPercentage);
  const tier = colorTier(pct);
  return `ctx ${applyColor(`${pct}%`, tier)}`;
}

export function buildIdentityRow(input: StatuslineInput): string {
  const modelSeg = input.model.display_name || MISSING;
  const ctxSeg = buildCtxSegment(input.context_window?.used_percentage);
  const cacheSeg = buildCacheSegment(input.prompt_cache);
  return [modelSeg, ctxSeg, cacheSeg].filter(Boolean).join(SEP);
}
