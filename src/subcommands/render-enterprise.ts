import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { parseStdin } from '../statusline/stdin';
import {
  SEP,
  MISSING,
  STALE_MARKER,
  applyColor,
  applyDim,
  colorTier,
  formatResetHint,
  formatOptionalHint,
  chooseLayout,
} from '../statusline/format';
import {
  readCache,
  updateCache,
  defaultCachePath,
} from '../cache/store';
import type { Cache } from '../cache/store';
import type { ExtraUsage, UsageBucket, UsageResponse } from '../oauth/types';
import {
  decideEnterpriseRefresh,
  rateLimitCooldownRemainingMs,
} from './enterprise-refresh-policy';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STALE_THRESHOLD_DEFAULT_MS = 60 * 1000; // 60 seconds
const STALE_THRESHOLD_MIN_MS = 10 * 1000; // 10 seconds
const STALE_THRESHOLD_MAX_MS = 300 * 1000; // 5 minutes
const STALE_THRESHOLD_ENV = 'CC_STATUSLINE_ENTERPRISE_STALE_MS';

/** Remediation hint appended when authState is 'fatal'. Must be ≤ 50 chars. */
export const AUTH_FATAL_HINT = ' run init to repair auth';

export const MISSING_CACHE_HINT = 'run init';

/** Hint appended when authState is 'cloudflare-blocked'. */
export const CLOUDFLARE_HINT = ' refresh blocked (cloudflare); see README#cloudflare';

/** Prefix for the rate-limit cooldown hint; followed by `Xm` / `Xs` until reset. */
export const RATE_LIMITED_HINT_PREFIX = ' rate-limited; retry in ';

function formatRateLimitedHint(msUntilReset: number): string {
  const secondsRemaining = Math.max(1, Math.ceil(msUntilReset / 1000));
  if (secondsRemaining < 60) {
    return `${RATE_LIMITED_HINT_PREFIX}${secondsRemaining}s`;
  }
  const minutesRemaining = Math.ceil(secondsRemaining / 60);
  return `${RATE_LIMITED_HINT_PREFIX}${minutesRemaining}m`;
}

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

/**
 * Low-level spawn abstraction: mirrors the child_process.spawn signature for
 * the pieces we care about, so tests can capture exactly what would be executed.
 */
type SafeSpawnOptions = SpawnOptions & { shell: false };

export type SpawnFn = (
  command: string,
  args: string[],
  opts: SafeSpawnOptions,
) => void;

export interface RenderEnterpriseDeps {
  cachePath?: string;
  bundlePath?: string;
  /** Override the spawn call for testing. Receives (command, args, opts). */
  spawnRefresh?: SpawnFn;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Stdin reader (mirrors render-promax.ts)
// ---------------------------------------------------------------------------

function readStream(source: NodeJS.ReadableStream): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
      }
    }, 1000);

    source.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    source.on('end', () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });

    source.on('error', () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Segment builders
// ---------------------------------------------------------------------------

function buildModelSegment(displayName: string): string {
  return displayName || MISSING;
}

function buildCtxSegment(usedPercentage: number | null | undefined): string {
  if (usedPercentage === null || usedPercentage === undefined) {
    return '';
  }
  const pct = Math.round(usedPercentage);
  const tier = colorTier(pct);
  return `ctx ${applyColor(`${pct}%`, tier)}`;
}


function buildUsageBucketSegment(
  label: string,
  bucket: UsageBucket | null | undefined,
  nowMs: number,
): string {
  if (bucket === null || bucket === undefined) {
    return `${label} ${MISSING}`;
  }

  const pct = Math.round(bucket.utilization);
  const hint = formatResetHint(bucket.resets_at ?? bucket.resetsAt, nowMs);
  return [label, applyColor(`${pct}%`, colorTier(pct)), formatOptionalHint(hint)]
    .filter(Boolean)
    .join(' ');
}

function hasCreditUsage(extra: ExtraUsage): extra is ExtraUsage & {
  used_credits: number;
  monthly_limit: number;
} {
  return extra.used_credits !== null &&
    extra.used_credits !== undefined &&
    extra.monthly_limit !== null &&
    extra.monthly_limit !== undefined;
}

function buildSessionCostSegment(sessionCostUsd: number): string {
  if (sessionCostUsd === 0) return '';
  return `session $${sessionCostUsd.toFixed(2)}`;
}

function getStaleThresholdMs(): number {
  const raw = process.env[STALE_THRESHOLD_ENV];
  if (raw === undefined) {
    return STALE_THRESHOLD_DEFAULT_MS;
  }

  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return STALE_THRESHOLD_DEFAULT_MS;
  }

  const rounded = Math.floor(parsed);
  return Math.max(STALE_THRESHOLD_MIN_MS, Math.min(STALE_THRESHOLD_MAX_MS, rounded));
}

function buildExtraUsageSegment(extra: ExtraUsage): string {
  if (!hasCreditUsage(extra)) {
    return `usage ${MISSING}`;
  }

  const usedUsd = extra.used_credits / 100;
  const limitUsd = extra.monthly_limit / 100;
  const usedDisplay = usedUsd.toFixed(2);
  const limitDisplay = limitUsd.toFixed(2);
  const utilizationPct = Math.round(
    limitUsd > 0 ? (usedUsd / limitUsd) * 100 : 0,
  );

  return `credits $${usedDisplay} / $${limitDisplay} (${utilizationPct}%)`;
}

function buildFallbackUsageSegment(usage: UsageResponse, nowMs: number): string {
  return [
    buildUsageBucketSegment('5h', usage.five_hour, nowMs),
    buildUsageBucketSegment('7d', usage.seven_day, nowMs),
  ].join(' · ');
}

/**
 * Build the usage segment for Enterprise users.
 *
 * When cache is null (missing / malformed), returns an actionable init hint.
 * Staleness dim and STALE_MARKER are applied here.
 * Auth-state dim (fatal) is applied by the caller.
 */
function buildUsageSegment(
  cache: Cache | null,
  isStale: boolean,
  nowMs: number,
  sessionCostUsd: number,
): { text: string; isFetching: boolean } {
  if (cache === null) {
    return {
      text: `usage ${MISSING}${SEP}${MISSING_CACHE_HINT}`,
      isFetching: false,
    };
  }

  if (cache.usage === null) {
    return { text: `usage ${MISSING}${SEP}fetching…`, isFetching: true };
  }

  const usage = cache.usage;
  const extra = usage.extra_usage;
  let figureSeg = extra?.is_enabled === true
    ? buildExtraUsageSegment(extra)
    : buildFallbackUsageSegment(usage, nowMs);

  // Apply staleness dim + marker if needed.
  if (isStale) {
    figureSeg = applyDim(figureSeg) + STALE_MARKER;
  }

  if (extra?.is_enabled === true) {
    figureSeg = [figureSeg, buildSessionCostSegment(sessionCostUsd)]
      .filter(Boolean)
      .join(SEP);
  }

  return { text: figureSeg, isFetching: false };
}

// ---------------------------------------------------------------------------
// Default spawn implementation
// ---------------------------------------------------------------------------

function buildMinimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (process.env['PATH'] !== undefined) env['PATH'] = process.env['PATH'];
  if (process.env['HOME'] !== undefined) env['HOME'] = process.env['HOME'];
  if (process.env['USERPROFILE'] !== undefined) env['USERPROFILE'] = process.env['USERPROFILE'];
  if (process.env['CLAUDE_CONFIG_DIR'] !== undefined) env['CLAUDE_CONFIG_DIR'] = process.env['CLAUDE_CONFIG_DIR'];
  return env;
}

function defaultSpawnFn(): SpawnFn {
  return (command: string, args: string[], opts: SafeSpawnOptions): void => {
    const child = spawn(command, args, {
      ...opts,
      env: buildMinimalEnv(),
      shell: false,
    });
    child.unref();
  };
}

async function claimRefresh(
  cachePath: string,
  nowMs: number,
  staleThresholdMs: number,
): Promise<number | null> {
  try {
    return await updateCache(cachePath, (current) => {
      const decision = decideEnterpriseRefresh(
        current,
        nowMs,
        staleThresholdMs,
      );
      if (decision.action !== 'spawn' || current === null) {
        return { kind: 'skip', value: null };
      }
      return {
        kind: 'write',
        cache: {
          ...current,
          lastRefreshStartedAt: nowMs,
        },
        value: nowMs,
      };
    });
  } catch {
    return null;
  }
}

async function releaseRefreshClaim(
  cachePath: string,
  claimedAt: number,
): Promise<void> {
  try {
    await updateCache(cachePath, (current) => {
      if (
        current === null ||
        current.lastRefreshStartedAt !== claimedAt
      ) {
        return { kind: 'skip', value: undefined };
      }
      return {
        kind: 'write',
        cache: {
          ...current,
          lastRefreshStartedAt: 0,
        },
        value: undefined,
      };
    });
  } catch {
    return;
  }
}

// ---------------------------------------------------------------------------
// Line renderer
// ---------------------------------------------------------------------------

function renderLine(
  input: NonNullable<ReturnType<typeof parseStdin>>,
  cache: Cache | null,
  nowMs: number,
  staleThresholdMs: number,
): string {
  const staleAge = cache !== null ? nowMs - cache.lastUsageRefreshAt : Infinity;
  const isStale = staleAge >= staleThresholdMs;

  const modelSeg = buildModelSegment(input.model.display_name);
  const ctxSeg = buildCtxSegment(input.context_window?.used_percentage);

  // Build usage segment, folding live session cost into the enterprise spend figure.
  const { text: rawUsage, isFetching } = buildUsageSegment(cache, isStale, nowMs, input.cost.total_cost_usd);

  // Auth state overrides.
  let usageSeg = rawUsage;
  let authHint = '';

  if (cache !== null) {
    if (cache.authState === 'fatal') {
      // Dim the figures (applies to everything in this segment).
      // Only apply dim if the segment isn't already stale-dimmed.
      if (!isFetching) {
        if (isStale) {
          // Already dimmed by staleness; just ensure stale marker is present.
          // usageSeg is already dim + STALE_MARKER
        } else {
          usageSeg = applyDim(usageSeg);
        }
      } else {
        // fetching… case: dim it too for consistency.
        usageSeg = applyDim(usageSeg);
      }
      authHint = AUTH_FATAL_HINT;
    } else if (cache.authState === 'cloudflare-blocked') {
      // Render normally; just append hint.
      authHint = CLOUDFLARE_HINT;
    } else {
      const cooldownRemainingMs = rateLimitCooldownRemainingMs(cache, nowMs);
      if (cooldownRemainingMs > 0) {
        // Currently rate-limited (cooldown not yet elapsed). Render figures
        // normally — they're still the most recent we know — but tell the user
        // when retries will resume.
        authHint = formatRateLimitedHint(cooldownRemainingMs);
      }
    }
  }

  const usageWithHint = authHint ? usageSeg + authHint : usageSeg;

  const layout = chooseLayout(process.stdout.columns);

  if (layout === 'wide') {
    return [modelSeg, ctxSeg, usageWithHint].filter(Boolean).join(SEP) + '\n';
  }

  // Narrow: two lines.
  const row1 = [modelSeg, ctxSeg].filter(Boolean).join(SEP);
  const row2 = usageWithHint;
  return row1 + '\n' + row2 + '\n';
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

/**
 * `render-enterprise` subcommand entrypoint.
 *
 * Reads stdin and the cache file synchronously, formats one line, fires a
 * detached refresh subprocess if the cache is stale, prints to stdout, exits.
 * Never makes a network call from the synchronous render path.
 *
 * @param _args       CLI args after the subcommand name (unused).
 * @param stdinSource Override stdin for testing.
 * @param deps        Dependency injection for testability.
 */
export async function runRenderEnterprise(
  _args: string[] = [],
  stdinSource: NodeJS.ReadableStream = process.stdin,
  deps: RenderEnterpriseDeps = {},
): Promise<number> {
  const cachePath = deps.cachePath ?? defaultCachePath();
  const bundlePath = deps.bundlePath ?? __filename;
  const now = deps.now ?? (() => Date.now());
  const staleThresholdMs = getStaleThresholdMs();
  const spawnFn = deps.spawnRefresh ?? defaultSpawnFn();

  // Step 1: Read stdin.
  const raw = await readStream(stdinSource);

  if (raw === null) {
    // Timeout — silent fail.
    process.stdout.write('\n');
    return 0;
  }

  const input = parseStdin(raw);

  if (!input) {
    // Non-JSON or empty stdin — silent fail.
    process.stdout.write('\n');
    return 0;
  }

  // Step 2: Read cache synchronously.
  const cache = readCache(cachePath);
  const nowMs = now();
  const refreshDecision = decideEnterpriseRefresh(
    cache,
    nowMs,
    staleThresholdMs,
  );

  if (refreshDecision.action === 'spawn') {
    const claimedAt = await claimRefresh(
      cachePath,
      nowMs,
      staleThresholdMs,
    );
    if (claimedAt !== null) {
      const minimalEnv = buildMinimalEnv();
      const claimArg = `--claimed-at=${claimedAt}`;
      try {
        spawnFn(process.execPath, [bundlePath, 'refresh', claimArg], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: minimalEnv,
          shell: false,
        });
      } catch {
        await releaseRefreshClaim(cachePath, claimedAt);
      }
    }
  }

  // Step 4: Render.
  const line = renderLine(input, cache, nowMs, staleThresholdMs);
  process.stdout.write(line);

  return 0;
}
