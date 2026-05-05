import type { RefreshResult, FetchUsageResult, UsageResponse, RateLimitDiagnostics } from './types';

const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
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

export async function refresh(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString();

    response = await fetchImpl(REFRESH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'transient', status: 0, message };
  }

  clearTimeout(timer);

  const status = response.status;

  if (status === 200) {
    const json = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    const expiresAt = Date.now() + json.expires_in * 1000;
    return {
      kind: 'success',
      data: {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt,
      },
    };
  }

  if (status === 400) {
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      // ignore
    }
    if (bodyText.includes('invalid_grant')) {
      return { kind: 'auth-fatal', reason: 'invalid_grant' };
    }
    return { kind: 'transient', status, message: `${status} from token endpoint` };
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
    return { kind: 'transient', status, message: `${status} from token endpoint` };
  }

  return { kind: 'transient', status, message: `${status} from token endpoint` };
}

export async function fetchUsage(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchUsageResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'transient', status: 0, message };
  }

  clearTimeout(timer);

  const status = response.status;

  if (status === 200) {
    const data = (await response.json()) as UsageResponse;
    return { kind: 'success', data };
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
}
