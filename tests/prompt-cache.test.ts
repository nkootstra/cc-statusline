import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildCacheSegment, cacheTier } from '../src/statusline/prompt-cache';

beforeEach(() => {
  vi.stubEnv('NO_COLOR', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('cacheTier', () => {
  it('rewards a high hit ratio, the inverse of usage tiers', () => {
    expect(cacheTier(95)).toBe('ok');
    expect(cacheTier(80)).toBe('ok');
    expect(cacheTier(79)).toBe('warn');
    expect(cacheTier(50)).toBe('warn');
    expect(cacheTier(49)).toBe('critical');
    expect(cacheTier(0)).toBe('critical');
  });
});

describe('buildCacheSegment', () => {
  it('is empty when Claude Code sent no prompt cache stats', () => {
    expect(buildCacheSegment(undefined)).toBe('');
  });

  it('is empty while the hit ratio is null', () => {
    expect(buildCacheSegment({ hit_ratio: null, warm: false })).toBe('');
  });

  it('is empty when no response reported cache tokens', () => {
    expect(buildCacheSegment({ hit_ratio: 0, caching_observed: false })).toBe('');
  });

  it('shows the rounded hit ratio colored by tier', () => {
    expect(buildCacheSegment({ hit_ratio: 0.874, warm: true, caching_observed: true }))
      .toBe('cache \x1b[32m87%\x1b[0m');
    expect(buildCacheSegment({ hit_ratio: 0.3, warm: true }))
      .toBe('cache \x1b[31m30%\x1b[0m');
  });

  it('dims the whole segment once the cache has gone cold', () => {
    expect(buildCacheSegment({ hit_ratio: 0.874, warm: false, caching_observed: true }))
      .toBe('\x1b[2mcache 87%\x1b[0m');
  });

  it('prints plain text under NO_COLOR', () => {
    vi.stubEnv('NO_COLOR', '1');
    expect(buildCacheSegment({ hit_ratio: 0.874, warm: false })).toBe('cache 87%');
  });
});
