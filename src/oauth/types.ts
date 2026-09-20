export interface UsageBucket {
  utilization: number; // 0 .. 100
  resets_at?: string;  // ISO 8601 from the OAuth API
  resetsAt?: string;   // Legacy cache/test compatibility
}

export interface ExtraUsage {
  is_enabled: boolean;
  utilization?: number;       // 0 .. 100
  used_credits?: number;      // CENTS
  monthly_limit?: number;     // CENTS
}

export interface UsageLimitScope {
  model?: { display_name: string };
}

// One server-defined meter row. `kind` is the only classifier: 'session',
// 'weekly_all', 'weekly_scoped', or a future kind this client does not know.
export interface UsageLimitRow {
  kind: string;
  percent: number | null;  // 0 .. 100
  resets_at: string | null; // ISO 8601
  scope?: UsageLimitScope;
}

export interface UsageResponse {
  five_hour?: UsageBucket | null;
  seven_day?: UsageBucket | null;
  seven_day_sonnet?: UsageBucket | null;
  seven_day_opus?: UsageBucket | null;
  extra_usage?: ExtraUsage;
  limits?: UsageLimitRow[];
}

export interface RateLimitDiagnostics {
  retryAfterSeconds: number;
  retryAfterPresent: boolean;
  xShouldRetry: boolean | null;
}

export type FetchUsageResult =
  | { kind: 'success'; data: UsageResponse }
  | { kind: 'auth-fatal'; reason: string }
  | { kind: 'cloudflare-blocked'; status: number }
  | ({ kind: 'rate-limited' } & RateLimitDiagnostics)
  | { kind: 'transient'; status: number; message: string };
