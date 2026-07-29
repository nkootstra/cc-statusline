import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const uuidSequence = vi.hoisted(() => ({
  values: [] as string[],
}));

vi.mock('node:crypto', () => ({
  randomUUID: () => uuidSequence.values.shift(),
}));

import { withCacheLock } from '../src/cache/lock';

beforeEach(() => {
  uuidSequence.values = [
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    '00000000-0000-4000-8000-000000000000',
  ];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withCacheLock', () => {
  it('does not let a same-millisecond contender preempt the active owner', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const tempDir = mkdtempSync(join(tmpdir(), 'cc-statusline-lock-order-'));
    const cachePath = join(tempDir, 'cache.json');
    let releaseFirst: (() => void) | undefined;
    let secondEntered = false;

    const first = withCacheLock(cachePath, async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });

    while (releaseFirst === undefined) {
      await delay(1);
    }

    const second = withCacheLock(cachePath, async () => {
      secondEntered = true;
    });

    try {
      await delay(30);
      expect(secondEntered).toBe(false);
    } finally {
      releaseFirst();
      await Promise.allSettled([first, second]);
      rmSync(tempDir, { recursive: true, force: true });
    }

    expect(secondEntered).toBe(true);
  });
});
