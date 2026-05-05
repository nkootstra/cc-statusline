import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { refresh, fetchUsage } from '../src/oauth/client';
import usageFixture from './fixtures/usage-response.json';

// AE7 deferred: the disabled-case shape (extra_usage.is_enabled === false) is unverified
// against a real Enterprise account. Per doc-review SG-06, real Enterprise verification
// of the disabled-case shape is deferred. The inline object below is a best-effort shape.
const usageFixtureDisabled = {
  ...usageFixture,
  extra_usage: { is_enabled: false },
};

function makeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const headersObj = new Headers(headers);
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(bodyStr, { status, headers: headersObj });
}

describe('refresh', () => {
  it('happy path: returns success with expiresAt in ms', async () => {
    const before = Date.now();
    const mockFetch = vi.fn().mockResolvedValue(
      makeResponse(200, {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    );

    const result = await refresh('old-refresh-token', mockFetch);

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.data.accessToken).toBe('new-access');
    expect(result.data.refreshToken).toBe('new-refresh');
    // expiresAt must be ~3,600,000 ms from now — NOT 3600 (seconds)
    const delta = result.data.expiresAt - before;
    expect(delta).toBeGreaterThanOrEqual(3_600_000 - 100);
    expect(delta).toBeLessThanOrEqual(3_600_000 + 100);
  });

  it('sends form-urlencoded body with correct Content-Type', async () => {
    let capturedInit: RequestInit | undefined;
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(
        makeResponse(200, {
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 3600,
        }),
      );
    });

    await refresh('my-refresh-token', mockFetch);

    expect(capturedInit).toBeDefined();
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(headers['Content-Type']).not.toContain('application/json');

    const body = capturedInit!.body as string;
    expect(typeof body).toBe('string');
    expect(body).toMatch(/grant_type=refresh_token&refresh_token=[^&]+&client_id=9d1c250a-/);
  });

  it('401 -> auth-fatal', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(401, ''));
    const result = await refresh('token', mockFetch);
    expect(result.kind).toBe('auth-fatal');
    if (result.kind !== 'auth-fatal') return;
    expect(result.reason).toBe('401');
  });

  it('400 with invalid_grant body -> auth-fatal', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeResponse(400, JSON.stringify({ error: 'invalid_grant' })),
    );
    const result = await refresh('token', mockFetch);
    expect(result.kind).toBe('auth-fatal');
    if (result.kind !== 'auth-fatal') return;
    expect(result.reason).toBe('invalid_grant');
  });

  it('403 -> cloudflare-blocked', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(403, ''));
    const result = await refresh('token', mockFetch);
    expect(result.kind).toBe('cloudflare-blocked');
    if (result.kind !== 'cloudflare-blocked') return;
    expect(result.status).toBe(403);
  });

  it('429 with Retry-After header -> rate-limited with that value, retryAfterPresent: true', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeResponse(429, '', { 'Retry-After': '60' }),
    );
    const result = await refresh('token', mockFetch);
    expect(result.kind).toBe('rate-limited');
    if (result.kind !== 'rate-limited') return;
    expect(result.retryAfterSeconds).toBe(60);
    expect(result.retryAfterPresent).toBe(true);
    expect(result.xShouldRetry).toBeNull();
  });

  it('429 without Retry-After header -> defaults to 60s, retryAfterPresent: false', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(429, ''));
    const result = await refresh('token', mockFetch);
    expect(result.kind).toBe('rate-limited');
    if (result.kind !== 'rate-limited') return;
    expect(result.retryAfterSeconds).toBe(60);
    expect(result.retryAfterPresent).toBe(false);
  });

  it('429 with garbage Retry-After -> defaults to 60s, retryAfterPresent: false', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeResponse(429, '', { 'Retry-After': 'not-a-number' }),
    );
    const result = await refresh('token', mockFetch);
    expect(result.kind).toBe('rate-limited');
    if (result.kind !== 'rate-limited') return;
    expect(result.retryAfterSeconds).toBe(60);
    expect(result.retryAfterPresent).toBe(false);
  });

  it('429 with x-should-retry: false -> xShouldRetry: false', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeResponse(429, '', { 'Retry-After': '30', 'x-should-retry': 'false' }),
    );
    const result = await refresh('token', mockFetch);
    expect(result.kind).toBe('rate-limited');
    if (result.kind !== 'rate-limited') return;
    expect(result.xShouldRetry).toBe(false);
  });

  it('500 -> transient with status 500', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(500, 'Internal Server Error'));
    const result = await refresh('token', mockFetch);
    expect(result.kind).toBe('transient');
    if (result.kind !== 'transient') return;
    expect(result.status).toBe(500);
  });

  it('network error (fetch throws) -> transient with status 0', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network failure'));
    const result = await refresh('token', mockFetch);
    expect(result.kind).toBe('transient');
    if (result.kind !== 'transient') return;
    expect(result.status).toBe(0);
    expect(result.message).toBe('Network failure');
  });

  it('timeout (AbortController fires) -> transient', async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal;
          if (signal) {
            signal.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            );
          }
        }),
    );

    const resultPromise = refresh('token', mockFetch);
    vi.advanceTimersByTime(10_001);
    const result = await resultPromise;

    vi.useRealTimers();

    expect(result.kind).toBe('transient');
    if (result.kind !== 'transient') return;
    expect(result.status).toBe(0);
  });
});

describe('fetchUsage', () => {
  it('happy path: returns success with parsed usage data', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeResponse(200, usageFixture),
    );

    const result = await fetchUsage('access-token-abc', mockFetch);

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.data.five_hour?.utilization).toBe(42);
    expect(result.data.seven_day?.utilization).toBe(67);
    expect(result.data.extra_usage?.is_enabled).toBe(true);
    expect(result.data.extra_usage?.used_credits).toBe(78000);
    expect(result.data.extra_usage?.monthly_limit).toBe(100000);
  });

  it('sends Authorization and anthropic-beta headers', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return Promise.resolve(makeResponse(200, usageFixture));
    });

    await fetchUsage('sk-ant-token-xyz', mockFetch);

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!['Authorization']).toBe('Bearer sk-ant-token-xyz');
    expect(capturedHeaders!['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('extra_usage.is_enabled === false shape (AE7 deferred case)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeResponse(200, usageFixtureDisabled),
    );
    const result = await fetchUsage('token', mockFetch);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.data.extra_usage?.is_enabled).toBe(false);
  });

  it('401 -> auth-fatal', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(401, ''));
    const result = await fetchUsage('token', mockFetch);
    expect(result.kind).toBe('auth-fatal');
    if (result.kind !== 'auth-fatal') return;
    expect(result.reason).toBe('401');
  });

  it('403 -> cloudflare-blocked', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(403, ''));
    const result = await fetchUsage('token', mockFetch);
    expect(result.kind).toBe('cloudflare-blocked');
    if (result.kind !== 'cloudflare-blocked') return;
    expect(result.status).toBe(403);
  });

  it('429 with Retry-After header -> rate-limited with diagnostics', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeResponse(429, '', { 'Retry-After': '120' }),
    );
    const result = await fetchUsage('token', mockFetch);
    expect(result.kind).toBe('rate-limited');
    if (result.kind !== 'rate-limited') return;
    expect(result.retryAfterSeconds).toBe(120);
    expect(result.retryAfterPresent).toBe(true);
    expect(result.xShouldRetry).toBeNull();
  });

  it('429 without Retry-After -> defaults to 60s, retryAfterPresent: false', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(429, ''));
    const result = await fetchUsage('token', mockFetch);
    expect(result.kind).toBe('rate-limited');
    if (result.kind !== 'rate-limited') return;
    expect(result.retryAfterSeconds).toBe(60);
    expect(result.retryAfterPresent).toBe(false);
  });

  it('429 with x-should-retry: false -> xShouldRetry: false', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeResponse(429, '', { 'Retry-After': '120', 'x-should-retry': 'false' }),
    );
    const result = await fetchUsage('token', mockFetch);
    expect(result.kind).toBe('rate-limited');
    if (result.kind !== 'rate-limited') return;
    expect(result.xShouldRetry).toBe(false);
  });

  it('500 -> transient with status 500', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(500, 'Server error'));
    const result = await fetchUsage('token', mockFetch);
    expect(result.kind).toBe('transient');
    if (result.kind !== 'transient') return;
    expect(result.status).toBe(500);
  });

  it('network error -> transient with status 0', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const result = await fetchUsage('token', mockFetch);
    expect(result.kind).toBe('transient');
    if (result.kind !== 'transient') return;
    expect(result.status).toBe(0);
    expect(result.message).toBe('ECONNRESET');
  });

  it('timeout -> transient', async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal;
          if (signal) {
            signal.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            );
          }
        }),
    );

    const resultPromise = fetchUsage('token', mockFetch);
    vi.advanceTimersByTime(10_001);
    const result = await resultPromise;

    vi.useRealTimers();

    expect(result.kind).toBe('transient');
    if (result.kind !== 'transient') return;
    expect(result.status).toBe(0);
  });
});
