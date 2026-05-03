import type { RefreshResult, FetchUsageResult, UsageResponse } from './types';

const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const BETA_HEADER = 'oauth-2025-04-20';
const REQUEST_TIMEOUT_MS = 10_000;

function parseRetryAfter(headers: Headers): number {
  const value = headers.get('Retry-After');
  if (value === null) return 60;
  const parsed = parseInt(value, 10);
  return isFinite(parsed) && parsed > 0 ? parsed : 60;
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
    const retryAfterSeconds = parseRetryAfter(response.headers);
    return { kind: 'rate-limited', retryAfterSeconds };
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
    const retryAfterSeconds = parseRetryAfter(response.headers);
    return { kind: 'rate-limited', retryAfterSeconds };
  }

  if (status >= 500) {
    return { kind: 'transient', status, message: `${status} from usage endpoint` };
  }

  return { kind: 'transient', status, message: `${status} from usage endpoint` };
}
