import type { FetchUsageResult, RateLimitDiagnostics } from './types';
import { decodeUsageResponse } from './usage';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_AFTER_SECONDS = 60;

function parseRetryAfter(headers: Headers): { seconds: number; present: boolean } {
  const value = headers.get('Retry-After');
  if (value === null) return { seconds: DEFAULT_RETRY_AFTER_SECONDS, present: false };
  const parsed = parseInt(value, 10);
  if (!isFinite(parsed) || parsed <= 0) {
    return { seconds: DEFAULT_RETRY_AFTER_SECONDS, present: false };
  }
  return { seconds: parsed, present: true };
}

function parseXShouldRetry(headers: Headers): boolean | null {
  const value = headers.get('x-should-retry');
  if (value === null) return null;
  const lower = value.toLowerCase().trim();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  return null;
}

function buildRateLimitDiagnostics(headers: Headers): RateLimitDiagnostics {
  const { seconds, present } = parseRetryAfter(headers);
  return {
    retryAfterSeconds: seconds,
    retryAfterPresent: present,
    xShouldRetry: parseXShouldRetry(headers),
  };
}

export async function fetchUsage(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchUsageResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetchImpl(USAGE_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': BETA_HEADER,
        },
        signal: controller.signal,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'transient', status: 0, message };
    }

    const status = response.status;

    if (status === 200) {
      try {
        const data = decodeUsageResponse(await response.json());
        if (data === null) {
          return {
            kind: 'transient',
            status,
            message: 'Invalid response from usage endpoint',
          };
        }
        return { kind: 'success', data };
      } catch {
        return {
          kind: 'transient',
          status,
          message: 'Invalid response from usage endpoint',
        };
      }
    }

    if (status === 401) {
      return { kind: 'auth-fatal', reason: '401' };
    }

    if (status === 403) {
      return { kind: 'cloudflare-blocked', status: 403 };
    }

    if (status === 429) {
      return { kind: 'rate-limited', ...buildRateLimitDiagnostics(response.headers) };
    }

    if (status >= 500) {
      return { kind: 'transient', status, message: `${status} from usage endpoint` };
    }

    return { kind: 'transient', status, message: `${status} from usage endpoint` };
  } finally {
    clearTimeout(timer);
  }
}
