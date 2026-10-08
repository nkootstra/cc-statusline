import { applyColor, applyDim, type ColorTier } from './format';

export interface PromptCache {
  hit_ratio: number | null;
  warm?: boolean;
  caching_observed?: boolean;
}

// A hit ratio is good when high, so the tiers run the opposite way to usage.
export function cacheTier(percent: number): ColorTier {
  if (percent >= 80) return 'ok';
  if (percent >= 50) return 'warn';
  return 'critical';
}

export function buildCacheSegment(promptCache: PromptCache | undefined): string {
  if (promptCache === undefined || promptCache.hit_ratio === null) return '';
  if (promptCache.caching_observed === false) return '';

  const pct = Math.round(promptCache.hit_ratio * 100);
  if (promptCache.warm === false) return applyDim(`cache ${pct}%`);
  return `cache ${applyColor(`${pct}%`, cacheTier(pct))}`;
}
