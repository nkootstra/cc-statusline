import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { runRenderPromax } from '../src/subcommands/render-promax';
import { runRenderEnterprise } from '../src/subcommands/render-enterprise';
import { captureStdout } from './support/render-enterprise';

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
  it('render-promax prints a blank line and releases the stream', async () => {
    const stream = neverEndingStream();
    const pending = captureStdout(() => runRenderPromax([], stream));
    await vi.advanceTimersByTimeAsync(1_000);
    const { output } = await pending;

    expect(output).toBe('\n');
    expect(stream.destroyed).toBe(true);
  });

  it('render-enterprise prints a blank line and releases the stream', async () => {
    const stream = neverEndingStream();
    const pending = captureStdout(() =>
      runRenderEnterprise([], stream, { cachePath: '/nonexistent/cache.json', spawnRefresh: () => {} }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const { output } = await pending;

    expect(output).toBe('\n');
    expect(stream.destroyed).toBe(true);
  });
});
