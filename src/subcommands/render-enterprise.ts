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
  isRefreshInFlight,
  defaultCachePath,
} from '../cache/store';
import type { Cache } from '../cache/store';
import type { ExtraUsage, UsageBucket, UsageResponse } from '../oauth/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

/** Remediation hint appended when authState is 'fatal'. Must be ≤ 50 chars. */
export const AUTH_FATAL_HINT = ' re-run init to re-auth';

/** Hint appended when authState is 'cloudflare-blocked'. */
export const CLOUDFLARE_HINT = ' refresh blocked (cloudflare); see README#cloudflare';

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

/**
 * Low-level spawn abstraction: mirrors the child_process.spawn signature for
 * the pieces we care about, so tests can capture exactly what would be executed.
 */
export type SpawnFn = (command: string, args: string[], opts: SpawnOptions) => void;

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

function buildCostSegment(totalCostUsd: number): string {
  if (totalCostUsd === 0) return '';
  return `$${totalCostUsd.toFixed(2)}`;
}

function buildUsageBucketSegment(label: string, bucket: UsageBucket | null | undefined): string {
  if (bucket === null || bucket === undefined) {
    return `${label} ${MISSING}`;
  }

  const pct = Math.round(bucket.utilization);
  const hint = formatResetHint(bucket.resets_at ?? bucket.resetsAt);
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

function buildExtraUsageSegment(extra: ExtraUsage): string {
  if (!hasCreditUsage(extra)) {
    return `usage ${MISSING}`;
  }

  const usedDollars = (extra.used_credits / 100).toFixed(2);
  const limitDollars = (extra.monthly_limit / 100).toFixed(2);
  const utilizationPct = Math.round(
    extra.utilization ?? ((extra.used_credits / extra.monthly_limit) * 100),
  );

  return `$${usedDollars} / $${limitDollars} (${utilizationPct}%)`;
}

function buildFallbackUsageSegment(usage: UsageResponse): string {
  return [
    buildUsageBucketSegment('5h', usage.five_hour),
    buildUsageBucketSegment('7d', usage.seven_day),
  ].join(' · ');
}

/**
 * Build the usage segment for Enterprise users.
 *
 * When cache is null (missing / malformed), returns `usage — · fetching…`.
 * Staleness dim and STALE_MARKER are applied here.
 * Auth-state dim (fatal) is applied by the caller.
 */
function buildUsageSegment(cache: Cache | null, isStale: boolean): { text: string; isFetching: boolean } {
  if (cache === null || cache.usage === null) {
    return { text: `usage ${MISSING}${SEP}fetching…`, isFetching: true };
  }

  const usage = cache.usage;
  const extra = usage.extra_usage;
  let figureSeg = extra?.is_enabled === true
    ? buildExtraUsageSegment(extra)
    : buildFallbackUsageSegment(usage);

  // Apply staleness dim + marker if needed.
  if (isStale) {
    figureSeg = applyDim(figureSeg) + STALE_MARKER;
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
  return (command: string, args: string[], opts: SpawnOptions): void => {
    const child = spawn(command, args, { ...opts, env: buildMinimalEnv() });
    if (process.platform !== 'win32') {
      child.unref();
    }
  };
}

// ---------------------------------------------------------------------------
// Line renderer
// ---------------------------------------------------------------------------

function renderLine(
  input: NonNullable<ReturnType<typeof parseStdin>>,
  cache: Cache | null,
  nowMs: number,
): string {
  const staleAge = cache !== null ? nowMs - cache.lastUsageRefreshAt : Infinity;
  const isStale = staleAge >= STALE_THRESHOLD_MS;

  const modelSeg = buildModelSegment(input.model.display_name);
  const ctxSeg = buildCtxSegment(input.context_window?.used_percentage);
  const costSeg = buildCostSegment(input.cost.total_cost_usd);

  // Build usage segment.
  const { text: rawUsage, isFetching } = buildUsageSegment(cache, isStale);

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
    }
  }

  const usageWithHint = authHint ? usageSeg + authHint : usageSeg;

  const layout = chooseLayout(process.stdout.columns);

  if (layout === 'wide') {
    return [modelSeg, ctxSeg, usageWithHint, costSeg].filter(Boolean).join(SEP) + '\n';
  }

  // Narrow: two lines.
  const row1 = [modelSeg, ctxSeg].filter(Boolean).join(SEP);
  const row2 = [usageWithHint, costSeg].filter(Boolean).join(SEP);
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

  // Step 3: Decide whether to fire a refresh subprocess.
  const staleAge = cache !== null ? nowMs - cache.lastUsageRefreshAt : Infinity;
  const isStale = staleAge >= STALE_THRESHOLD_MS;
  const cacheIsMissing = cache === null;

  // Don't fire if authState is 'fatal' (init must rerun).
  const authFatal = cache?.authState === 'fatal';

  // Don't fire if another refresh is already in flight.
  const inFlight = cache !== null && isRefreshInFlight(cache, nowMs);

  const shouldFire = (cacheIsMissing || isStale) && !authFatal && !inFlight;

  if (shouldFire) {
    const minimalEnv = buildMinimalEnv();
    if (process.platform === 'win32') {
      spawnFn('cmd.exe', ['/c', 'start', '/b', '/min', process.execPath, bundlePath, 'refresh'], {
        stdio: 'ignore',
        env: minimalEnv,
      });
    } else {
      spawnFn(process.execPath, [bundlePath, 'refresh'], {
        detached: true,
        stdio: 'ignore',
        env: minimalEnv,
      });
    }
  }

  // Step 4: Render.
  const line = renderLine(input, cache, nowMs);
  process.stdout.write(line);

  return 0;
}
