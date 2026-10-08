import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { runRender } from '../src/subcommands/render';
import { captureStdout } from './support/render';

function neverEndingStream(): Readable {
  return new Readable({ read() {} });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('stdin that never closes', () => {
  it('render prints a blank line and releases the stream', async () => {
    const stream = neverEndingStream();
    const pending = captureStdout(() =>
      runRender(stream, { cachePath: '/nonexistent/cache.json', spawnRefresh: () => {} }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const { output } = await pending;

    expect(output).toBe('\n');
    expect(stream.destroyed).toBe(true);
  });
});
